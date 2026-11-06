export type WindowKey = '10m' | '1h' | '3h' | '6h' | '24h';

export type Coverage = 'full' | 'partial' | 'unavailable';

export type PartialReason =
  | 'source_granularity'
  | 'collection_started_later'
  | 'gap'
  | 'retention'
  | 'no_data';

export type Metric = 'spend' | 'tokens';

export type TabId = 'spending' | 'requests' | 'models' | 'api' | 'settings';

export type Severity = 'error' | 'warn' | 'info' | 'debug';

export type LogSource =
  | 'collector'
  | 'source'
  | 'db'
  | 'window'
  | 'ipc'
  | 'credential'
  | 'update'
  | 'app';

export type Scope = { kind: 'all' } | { kind: 'key'; id: string; name: string };

export interface PeriodTotals {
  start: string;
  end: string;
  spend_micro: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  request_count: number | null;
}

export interface WindowCell {
  key: WindowKey;
  label: string;
  window_start: string;
  window_end: string;
  spend_micro: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  request_count: number | null;
  coverage: Coverage;
  partial_reason: PartialReason | null;
  as_of: string;
}

export interface RequestRecord {
  id: string;
  event_time: string;
  received_time: string;
  key_id: string | null;
  key_name: string | null;
  model: string | null;
  status: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost_micro: number | null;
  source: string;
}

export interface KeyRecord {
  id: string;
  name: string;
  removed: boolean;
  last4: string | null;
}

export interface CollectionStatus {
  last_success: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_error_at: string | null;
  retry_at: string | null;
  backoff_ms: number;
  stale: boolean;
  expected_delay_sec: number;
}

export interface CoverageInfo {
  earliest_reliable: string | null;
  /** Newest date the source has reported. Older than today means the source lags. */
  latest_source_date: string | null;
  spend: Coverage;
  tokens: Coverage;
  requests: Coverage;
  request_source: 'full_account' | 'selected_apps' | 'unavailable';
  warnings: string[];
}

export interface AccountInfo {
  connected: boolean;
  state: 'not_connected' | 'connected' | 'invalid' | 'encryption_unavailable' | 'unreadable';
  /** Stored credential exists but could not be decrypted. */
  credential_unreadable?: boolean;
  label: string | null;
  last4: string | null;
  saved_at: string | null;
  total_credits_micro: number | null;
  total_usage_micro: number | null;
}

/**
 * Totals reported directly by the source for a calendar period. These are
 * authoritative for spend and are used when the request records do not cover
 * the period, because the activity endpoint lags by up to a day.
 */
export interface SourceTotals {
  spend_micro: number | null;
  as_of: string;
  /** Which endpoint supplied the value. */
  origin: 'key.usage_daily' | 'key.usage_monthly' | 'activity';
}

/**
 * Spend derived from the cumulative account counter, which updates live even
 * while the daily activity feed lags. `exact` is false when the widget has no
 * reading from before the period start, in which case `baseline_at` names the
 * earliest reading available and the value covers only that shorter interval.
 */
export interface CounterSpendInfo {
  spend_micro: number | null;
  exact: boolean;
  baseline_at: string | null;
  as_of: string | null;
  reason: 'ok' | 'partial_baseline' | 'no_samples';
}

export interface Snapshot {
  schema_version: number;
  snapshot_version: number;
  server_time: string;
  fetched_at: string;
  currency: 'USD';
  time_zone: string;
  scope: Scope;
  today: PeriodTotals;
  month: PeriodTotals;
  /** Source-reported spend for the current day, when available. */
  today_source: SourceTotals | null;
  /** Source-reported spend for the current month, when available. */
  month_source: SourceTotals | null;
  /** Live spend for the current day, from the cumulative account counter. */
  counter_today: CounterSpendInfo | null;
  /** Live spend for the current month, from the cumulative account counter. */
  counter_month: CounterSpendInfo | null;
  latest_request: RequestRecord | null;
  coverage: CoverageInfo;
  collection_status: CollectionStatus;
  windows: WindowCell[];
  sample: boolean;
  account: AccountInfo;
}

export interface LogEntry {
  seq: number;
  timestamp: string;
  severity: Severity;
  source: LogSource;
  code: string | null;
  message: string;
  correlation_id: string | null;
  redacted: boolean;
}

export interface LogQuery {
  severities: Severity[];
  sources: LogSource[];
  text: string;
  range: '15m' | '1h' | '24h' | 'all';
  limit: number;
}

export interface ChartBin {
  start: string;
  end: string;
  spend_micro: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  partial: boolean;
  missing: boolean;
}

export interface ChartData {
  metric: Metric;
  scale: WindowKey;
  period_start: string;
  period_end: string;
  bins: ChartBin[];
  total_spend_micro: number;
  total_input_tokens: number;
  total_output_tokens: number;
  axis: 'log' | 'linear';
  sample: boolean;
}

export interface WindowState {
  bounds: { x: number; y: number; width: number; height: number };
  display_id: number | null;
  always_on_top: 'normal' | 'stronger' | 'off';
  opacity: number;
  ghost: boolean;
  locked: boolean;
  visible: boolean;
}

export interface DiagnosticBundle {
  captured_at: string;
  trigger: string;
  schema_version: number;
  connection: Record<string, unknown>;
  source: Record<string, unknown>;
  coverage: Record<string, unknown>;
  collection: Record<string, unknown>;
  storage: Record<string, unknown>;
  performance: Record<string, unknown>;
  window: Record<string, unknown>;
  environment: Record<string, unknown>;
}

export interface VersionInfo {
  widget: string;
  build: string;
  commit: string;
  electron: string;
  chromium: string;
  node: string;
  sqlite: string;
  channel: 'stable' | 'beta';
  schema_version: number;
  last_migration: string | null;
  update_state: 'up_to_date' | 'checking' | 'available' | 'downloading' | 'ready' | 'failed' | 'idle';
  last_check: string | null;
  release_notes_url: string;
}
