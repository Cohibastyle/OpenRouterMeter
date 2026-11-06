/**
 * The analytics query endpoint.
 *
 * This is the endpoint the OpenRouter dashboard itself uses, and it is the only
 * one that reports the current day. The older `/activity` endpoint returns a
 * fixed set of daily rows that can stop several days behind today and ignores
 * every date filter, so it cannot answer "what did I spend today".
 *
 * Verified capabilities:
 *   - granularity: minute, hour, day, week, month
 *   - dimensions: model, api_key_id, provider, origin, country, workspace, app,
 *     user, and others listed by `/analytics/meta`
 *   - metrics: total_usage, tokens_total, tokens_prompt, tokens_completion,
 *     request_count, cached_tokens, reasoning_tokens, latency percentiles
 *   - time_range: at most 367 days
 *   - rows come back newest first, and `metadata.truncated` says whether the
 *     limit cut the result short
 *
 * Timestamps in the response are UTC and carry no zone suffix, matching the
 * activity endpoint, so they are parsed as UTC.
 */

export type AnalyticsGranularity = 'minute' | 'hour' | 'day' | 'week' | 'month';

export type AnalyticsMetric =
  | 'total_usage'
  | 'tokens_total'
  | 'tokens_prompt'
  | 'tokens_completion'
  | 'request_count'
  | 'cached_tokens'
  | 'reasoning_tokens';

export type AnalyticsDimension =
  | 'model'
  | 'api_key_id'
  | 'provider'
  | 'origin'
  | 'country'
  | 'workspace'
  | 'app'
  | 'user';

export interface AnalyticsFilter {
  field: string;
  operator: 'eq' | 'neq' | 'in' | 'not_in' | 'gt' | 'gte' | 'lt' | 'lte';
  value: string | number | Array<string | number>;
}

export interface AnalyticsQuery {
  metrics: AnalyticsMetric[];
  dimensions?: AnalyticsDimension[];
  granularity: AnalyticsGranularity;
  /** Inclusive start, ISO 8601. */
  start: string;
  /** Exclusive end, ISO 8601. */
  end: string;
  filters?: AnalyticsFilter[];
  limit?: number;
}

/** One row of the response, keyed by `date__<granularity>` plus any dimensions. */
export interface AnalyticsRow {
  /** Bucket start, parsed as UTC. */
  bucket: string;
  total_usage_micro: number | null;
  tokens_total: number | null;
  tokens_prompt: number | null;
  tokens_completion: number | null;
  request_count: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  /** Dimension values, e.g. `{ api_key_id: 'Ace VS Code' }`. */
  dimensions: Record<string, string>;
}

export interface AnalyticsResult {
  rows: AnalyticsRow[];
  /** True when the server cut the result short at the row limit. */
  truncated: boolean;
  granularity: AnalyticsGranularity;
}

/** The maximum span the endpoint accepts. */
export const ANALYTICS_MAX_RANGE_DAYS = 367;

/** Build the JSON body for a query. Kept separate so it can be tested. */
export function buildAnalyticsBody(query: AnalyticsQuery): Record<string, unknown> {
  const body: Record<string, unknown> = {
    metrics: query.metrics,
    granularity: query.granularity,
    time_range: { start: query.start, end: query.end },
  };
  if (query.dimensions && query.dimensions.length > 0) body.dimensions = query.dimensions;
  if (query.filters && query.filters.length > 0) body.filters = query.filters;
  if (query.limit !== undefined) body.limit = query.limit;
  return body;
}

/**
 * Parse a bucket timestamp. The API returns `YYYY-MM-DD HH:mm:ss` with no zone,
 * which `new Date()` would read as local time and shift across day boundaries.
 */
export function parseAnalyticsDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const ms = new Date(withZone).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Map one raw row. Returns null when the bucket timestamp is unusable. */
export function parseAnalyticsRow(
  raw: Record<string, unknown>,
  granularity: AnalyticsGranularity,
  dimensions: ReadonlyArray<string>,
): AnalyticsRow | null {
  const dateKey = `date__${granularity}`;
  const rawDate = raw[dateKey];
  if (typeof rawDate !== 'string') return null;
  const bucket = parseAnalyticsDate(rawDate);
  if (!bucket) return null;

  const dims: Record<string, string> = {};
  for (const name of dimensions) {
    const value = raw[name];
    if (value !== null && value !== undefined) dims[name] = String(value);
  }

  return {
    bucket,
    total_usage_micro: toNumber(raw.total_usage),
    tokens_total: toNumber(raw.tokens_total),
    tokens_prompt: toNumber(raw.tokens_prompt),
    tokens_completion: toNumber(raw.tokens_completion),
    request_count: toNumber(raw.request_count),
    cached_tokens: toNumber(raw.cached_tokens),
    reasoning_tokens: toNumber(raw.reasoning_tokens),
    dimensions: dims,
  };
}

/** Parse a full response envelope. */
export function parseAnalyticsResponse(
  payload: unknown,
  granularity: AnalyticsGranularity,
  dimensions: ReadonlyArray<string> = [],
): AnalyticsResult {
  const envelope = payload as { data?: { data?: unknown; metadata?: { truncated?: unknown } } } | null;
  const rawRows = envelope?.data?.data;
  const rows: AnalyticsRow[] = [];
  if (Array.isArray(rawRows)) {
    for (const raw of rawRows) {
      if (!raw || typeof raw !== 'object') continue;
      const row = parseAnalyticsRow(raw as Record<string, unknown>, granularity, dimensions);
      if (row) rows.push(row);
    }
  }
  return {
    rows,
    truncated: envelope?.data?.metadata?.truncated === true,
    granularity,
  };
}

/**
 * The granularity that keeps a range under the row limit. The endpoint returns
 * newest first, so an over-large request silently drops the oldest buckets.
 */
export function granularityForRange(rangeMs: number, maxRows = 1000): AnalyticsGranularity {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (rangeMs / minute <= maxRows) return 'minute';
  if (rangeMs / hour <= maxRows) return 'hour';
  if (rangeMs / day <= maxRows) return 'day';
  if (rangeMs / (7 * day) <= maxRows) return 'week';
  return 'month';
}
