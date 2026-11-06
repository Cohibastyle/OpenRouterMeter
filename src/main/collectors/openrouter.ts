import {
  OPENROUTER_ACTIVITY_URL,
  OPENROUTER_ANALYTICS_META_URL,
  OPENROUTER_ANALYTICS_QUERY_URL,
  OPENROUTER_CREDITS_URL,
  OPENROUTER_KEY_URL,
  OPENROUTER_KEYS_URL_API,
} from '../../shared/constants.js';
import {
  buildAnalyticsBody,
  parseAnalyticsResponse,
  type AnalyticsGranularity,
  type AnalyticsQuery,
  type AnalyticsResult,
  type AnalyticsRow,
} from '../../shared/analytics.js';
import { microFromNumber } from '../../shared/money.js';
import { looksLikeCredential } from '../../shared/redact.js';
import type { KeyRecord, RequestRecord } from '../../shared/types.js';

export type CollectorErrorCode =
  | 'invalid_credential'
  | 'source_auth_failure'
  | 'rate_limit'
  | 'source_outage'
  | 'network_offline'
  | 'incomplete_history'
  | 'unknown';

export class CollectorError extends Error {
  readonly code: CollectorErrorCode;
  readonly retryAfterMs: number | null;
  readonly status: number | null;

  constructor(code: CollectorErrorCode, message: string, status: number | null = null, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'CollectorError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface CreditsResult {
  total_credits_micro: number | null;
  total_usage_micro: number | null;
}

export interface KeyInfoResult {
  label: string | null;
  last4: string | null;
  limit_micro: number | null;
  usage_micro: number | null;
  /** Usage for the current UTC day, as reported by the key endpoint. */
  usage_daily_micro: number | null;
  /** Usage for the trailing week. */
  usage_weekly_micro: number | null;
  /** Usage for the current month. */
  usage_monthly_micro: number | null;
  is_free_tier: boolean | null;
  /** True when this key can see account-wide data rather than only its own. */
  is_management_key: boolean;
}

export interface ActivityRow {
  date: string;
  model: string | null;
  endpoint_id: string | null;
  provider_name: string | null;
  key_id: string | null;
  key_name: string | null;
  requests: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost_micro: number | null;
}

export interface CollectorCapabilities {
  credits: boolean;
  key_info: boolean;
  activity: boolean;
  /** True when the analytics query endpoint answers, which is the live source. */
  analytics: boolean;
  /** True when the key list is readable, which enables per-key breakdowns. */
  keys: boolean;
  request_feed: boolean;
  granularity_ms: number;
  reporting_delay_sec: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

async function requestJson(
  url: string,
  apiKey: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        'HTTP-Referer': 'https://github.com/openrouter-desktop-widget',
        'X-Title': 'OpenRouter Desktop Widget',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const message = (error as Error).message;
    if (message.includes('aborted')) {
      throw new CollectorError('source_outage', 'Request timed out', null);
    }
    throw new CollectorError('network_offline', `Network unreachable: ${message}`, null);
  }
  clearTimeout(timer);

  if (response.status === 401 || response.status === 403) {
    throw new CollectorError('invalid_credential', 'The credential was rejected by OpenRouter', response.status);
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after') ?? '0');
    throw new CollectorError(
      'rate_limit',
      'OpenRouter rate limit reached',
      response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000,
    );
  }
  if (response.status >= 500) {
    throw new CollectorError('source_outage', `OpenRouter returned ${response.status}`, response.status);
  }
  if (!response.ok) {
    throw new CollectorError('unknown', `OpenRouter returned ${response.status}`, response.status);
  }

  try {
    return await response.json();
  } catch {
    throw new CollectorError('source_outage', 'OpenRouter returned a non-JSON response', response.status);
  }
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * OpenRouter returns activity dates as "YYYY-MM-DD HH:mm:ss" with no zone.
 * `new Date()` would parse that as local time, shifting the day boundary and
 * misattributing spend. Treat it as UTC, which is what the source means.
 */
export function parseSourceDate(value: string | null): string {
  if (!value) return new Date().toISOString();
  const trimmed = value.trim();
  // Already ISO with an explicit zone.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  // "YYYY-MM-DD HH:mm:ss" or "YYYY-MM-DD".
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(trimmed);
  if (m) {
    const [, y, mo, d, h = '00', mi = '00', sec = '00'] = m;
    const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
    return new Date(utc).toISOString();
  }
  const fallback = new Date(trimmed);
  return Number.isNaN(fallback.getTime()) ? new Date().toISOString() : fallback.toISOString();
}

/**
 * Live collector against confirmed OpenRouter endpoints.
 *
 * Only endpoints verified to exist are used. Anything that cannot be confirmed
 * is reported as a capability gap rather than invented, per FSD section 4.2.
 */
export class OpenRouterCollector {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async fetchCredits(): Promise<CreditsResult> {
    const json = (await requestJson(OPENROUTER_CREDITS_URL, this.apiKey)) as {
      data?: { total_credits?: unknown; total_usage?: unknown };
    };
    const data = json?.data ?? {};
    return {
      total_credits_micro: num(data.total_credits) !== null ? microFromNumber(num(data.total_credits)!) : null,
      total_usage_micro: num(data.total_usage) !== null ? microFromNumber(num(data.total_usage)!) : null,
    };
  }

  async fetchKeyInfo(): Promise<KeyInfoResult> {
    const json = (await requestJson(OPENROUTER_KEY_URL, this.apiKey)) as {
      data?: {
        label?: unknown;
        limit?: unknown;
        usage?: unknown;
        usage_daily?: unknown;
        usage_weekly?: unknown;
        usage_monthly?: unknown;
        is_free_tier?: unknown;
        is_management_key?: unknown;
        name?: unknown;
      };
    };
    const data = json?.data ?? {};
    const rawLabel = str(data.label) ?? str(data.name);
    // Defensive: a label must never be the credential itself. If the source
    // echoes something key-shaped, discard it rather than persist a secret.
    const label = rawLabel && !looksLikeCredential(rawLabel) ? rawLabel : null;
    return {
      label,
      last4: this.apiKey.length >= 8 ? this.apiKey.slice(-4) : null,
      limit_micro: num(data.limit) !== null ? microFromNumber(num(data.limit)!) : null,
      usage_micro: num(data.usage) !== null ? microFromNumber(num(data.usage)!) : null,
      usage_daily_micro: num(data.usage_daily) !== null ? microFromNumber(num(data.usage_daily)!) : null,
      usage_weekly_micro: num(data.usage_weekly) !== null ? microFromNumber(num(data.usage_weekly)!) : null,
      usage_monthly_micro: num(data.usage_monthly) !== null ? microFromNumber(num(data.usage_monthly)!) : null,
      is_free_tier: typeof data.is_free_tier === 'boolean' ? data.is_free_tier : null,
      is_management_key: data.is_management_key === true,
    };
  }

  /**
   * Activity rows. OpenRouter's activity endpoint returns per-day, per-model
   * aggregates. That means the finest granularity is one day, so the 10m, 1h,
   * 3h, and 6h windows are honestly unavailable with reason source_granularity.
   */
  async fetchActivity(): Promise<ActivityRow[]> {
    const json = (await requestJson(OPENROUTER_ACTIVITY_URL, this.apiKey)) as {
      data?: unknown;
    };
    const rows = Array.isArray(json?.data) ? json.data : [];
    return rows.map((raw) => {
      const r = raw as Record<string, unknown>;
      const input = num(r.prompt_tokens) ?? num(r.input_tokens);
      const output = num(r.completion_tokens) ?? num(r.output_tokens);
      const total = num(r.total_tokens) ?? (input !== null || output !== null ? (input ?? 0) + (output ?? 0) : null);
      return {
        date: parseSourceDate(str(r.date) ?? str(r.created_at)),
        model: str(r.model) ?? str(r.model_permaslug),
        endpoint_id: str(r.endpoint_id),
        provider_name: str(r.provider_name),
        // The activity endpoint does not report key identity. Leaving these
        // null is honest; guessing from model or timing would be wrong.
        key_id: str(r.key_id) ?? str(r.api_key_id),
        key_name: str(r.key_name) ?? str(r.label),
        requests: num(r.requests) ?? num(r.request_count),
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        cost_micro: num(r.usage) !== null ? microFromNumber(num(r.usage)!) : num(r.cost) !== null ? microFromNumber(num(r.cost)!) : null,
      };
    });
  }

  /**
   * Query the analytics endpoint, which is what the OpenRouter dashboard uses.
   * Unlike `/activity`, this reports the current day and supports sub-daily
   * granularity, so it is the primary source for every window.
   */
  async queryAnalytics(query: AnalyticsQuery): Promise<AnalyticsResult> {
    const json = await requestJson(OPENROUTER_ANALYTICS_QUERY_URL, this.apiKey, DEFAULT_TIMEOUT_MS, {
      method: 'POST',
      body: buildAnalyticsBody(query),
    });
    return parseAnalyticsResponse(json, query.granularity, query.dimensions ?? []);
  }

  /** Available metrics, dimensions, and granularities. */
  async fetchAnalyticsMeta(): Promise<{
    metrics: string[];
    dimensions: string[];
    granularities: string[];
  }> {
    const json = (await requestJson(OPENROUTER_ANALYTICS_META_URL, this.apiKey)) as {
      data?: { metrics?: Array<{ name?: unknown }>; dimensions?: Array<{ name?: unknown }>; granularities?: Array<{ name?: unknown }> };
    };
    const names = (list: unknown): string[] =>
      Array.isArray(list)
        ? list.map((item) => (item as { name?: unknown })?.name).filter((n): n is string => typeof n === 'string')
        : [];
    return {
      metrics: names(json.data?.metrics),
      dimensions: names(json.data?.dimensions),
      granularities: names(json.data?.granularities),
    };
  }

  /** The account's API keys, including the hash used as the analytics key id. */
  async fetchKeys(): Promise<Array<{ hash: string; name: string; label: string | null }>> {
    const json = (await requestJson(OPENROUTER_KEYS_URL_API, this.apiKey)) as {
      data?: Array<{ hash?: unknown; name?: unknown; label?: unknown }>;
    };
    if (!Array.isArray(json.data)) return [];
    return json.data
      .map((row) => ({
        hash: typeof row.hash === 'string' ? row.hash : '',
        name: typeof row.name === 'string' ? row.name : '',
        label: typeof row.label === 'string' ? row.label : null,
      }))
      .filter((row) => row.hash !== '');
  }

  async probeCapabilities(): Promise<CollectorCapabilities> {
    const capabilities: CollectorCapabilities = {
      credits: false,
      key_info: false,
      activity: false,
      analytics: false,
      keys: false,
      request_feed: false,
      granularity_ms: 24 * 60 * 60 * 1000,
      reporting_delay_sec: 60,
    };

    try {
      await this.fetchCredits();
      capabilities.credits = true;
    } catch (error) {
      if (error instanceof CollectorError && error.code === 'invalid_credential') throw error;
    }

    try {
      await this.fetchKeyInfo();
      capabilities.key_info = true;
    } catch (error) {
      if (error instanceof CollectorError && error.code === 'invalid_credential') throw error;
    }

    try {
      await this.fetchActivity();
      capabilities.activity = true;
    } catch (error) {
      if (error instanceof CollectorError && error.code === 'invalid_credential') throw error;
    }

    // The analytics endpoint is the live source. When it answers, the widget can
    // report the current day and sub-daily windows, so the granularity floor
    // drops from a day to a minute.
    try {
      const now = Date.now();
      await this.queryAnalytics({
        metrics: ['total_usage'],
        granularity: 'hour',
        start: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
        end: new Date(now).toISOString(),
        limit: 5,
      });
      capabilities.analytics = true;
      capabilities.request_feed = true;
      capabilities.granularity_ms = 60 * 1000;
      capabilities.reporting_delay_sec = 120;
    } catch (error) {
      if (error instanceof CollectorError && error.code === 'invalid_credential') throw error;
    }

    try {
      await this.fetchKeys();
      capabilities.keys = true;
    } catch (error) {
      if (error instanceof CollectorError && error.code === 'invalid_credential') throw error;
    }

    return capabilities;
  }

  /** Convert activity rows into normalized request records for local storage. */
  static activityToRequests(rows: ReadonlyArray<ActivityRow>): RequestRecord[] {
    const now = new Date().toISOString();
    return rows.map((row) => ({
      // The natural key of an activity row is its date, model, endpoint, and
      // provider. A positional index would change whenever the source reorders
      // rows, which created a duplicate record on every fetch.
      id: [
        'activity',
        row.date,
        row.model ?? 'unknown',
        row.endpoint_id ?? 'default',
        row.provider_name ?? 'unknown',
      ].join(':'),
      event_time: row.date,
      received_time: now,
      key_id: row.key_id,
      key_name: row.key_name,
      model: row.model,
      status: 'aggregate',
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      total_tokens: row.total_tokens,
      cost_micro: row.cost_micro,
      source: 'openrouter.activity',
    }));
  }

  /**
   * Map analytics rows to request records.
   *
   * The natural key is the bucket plus every dimension value, so re-running the
   * same query updates rows in place instead of duplicating them. `api_key_id`
   * is the key hash from `/keys`, which is what makes a per-key breakdown
   * possible; the display name is resolved separately.
   */
  static analyticsToRequests(
    rows: ReadonlyArray<AnalyticsRow>,
    granularity: AnalyticsGranularity,
    keyNames: ReadonlyMap<string, string> = new Map(),
  ): RequestRecord[] {
    const now = new Date().toISOString();
    return rows.map((row) => {
      // The api_key_id dimension comes back enriched as the key's display name,
      // not the hash. `keyNames` maps that name to the hash so the row shares an
      // identifier with the api_key table; without the map the raw value is used.
      const rawKey = row.dimensions.api_key_id ?? null;
      const keyHash = rawKey ? (keyNames.get(rawKey) ?? rawKey) : null;
      const keyName = rawKey;
      const dims = Object.keys(row.dimensions)
        .sort()
        .map((name) => `${name}=${row.dimensions[name]}`)
        .join('|');
      return {
        id: ['analytics', granularity, row.bucket, dims].join(':'),
        event_time: row.bucket,
        received_time: now,
        key_id: keyHash,
        key_name: keyName,
        model: row.dimensions.model ?? null,
        status: 'aggregate',
        input_tokens: row.tokens_prompt,
        output_tokens: row.tokens_completion,
        total_tokens: row.tokens_total,
        // total_usage is in dollars, not micro-dollars.
        cost_micro: row.total_usage_micro === null ? null : microFromNumber(row.total_usage_micro),
        source: `openrouter.analytics.${granularity}`,
      };
    });
  }

  static activityToKeys(rows: ReadonlyArray<ActivityRow>): KeyRecord[] {
    const seen = new Map<string, KeyRecord>();
    for (const row of rows) {
      if (!row.key_id) continue;
      if (seen.has(row.key_id)) continue;
      seen.set(row.key_id, {
        id: row.key_id,
        name: row.key_name ?? 'Unknown key',
        removed: false,
        last4: null,
      });
    }
    return [...seen.values()];
  }
}
