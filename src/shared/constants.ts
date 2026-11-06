import type { WindowKey } from './types.js';

export const SCHEMA_VERSION = 3;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * The five rolling windows, shortest first. The summary strip shows all five at
 * full width and the range buttons map one-to-one onto them.
 *
 * The set stops at 24 hours because that is the finest granularity the source
 * keeps for a full day: minute buckets are retained for 2 hours and hour
 * buckets for 24, so anything beyond a day would have to fall back to day
 * buckets and would disagree with the shorter ranges.
 */
export const WINDOWS: ReadonlyArray<{ key: WindowKey; label: string; ms: number }> = [
  { key: '10m', label: '10m', ms: 10 * MINUTE_MS },
  { key: '1h', label: '1h', ms: 60 * MINUTE_MS },
  { key: '3h', label: '3h', ms: 3 * HOUR_MS },
  { key: '6h', label: '6h', ms: 6 * HOUR_MS },
  { key: '24h', label: '24h', ms: 24 * HOUR_MS },
];

export const TABS = ['spending', 'requests', 'api', 'models', 'settings'] as const;

export const TAB_LABELS: Record<string, string> = {
  spending: 'Spending',
  requests: 'Tokens',
  api: 'Keys',
  models: 'Models',
  settings: 'Settings',
};

export const MIN_WIDTH = 180;
export const MIN_HEIGHT = 120;
export const DEFAULT_WIDTH = 320;
export const DEFAULT_HEIGHT = 240;

export const SIZE_CLASS = {
  xs: 240,
  s: 360,
  m: 520,
  l: 800,
} as const;

export const HEIGHT_CLASS = {
  short: 200,
  regular: 400,
} as const;

/**
 * Shortest window that still fits a legible chart in Standard mode.
 *
 * The chart shares the view with the range strip, the headline, and any source
 * note, so below this height the plot would be squeezed under its legibility
 * floor and its X-axis labels would be clipped by the tab bar. Standard hides
 * the chart at that point instead of truncating it, per the "hide, do not
 * shrink below legibility" rule.
 */
export const CHART_MIN_HEIGHT = 220;

export const LOG_RING_CAPACITY = 2000;
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
export const LOG_ROTATE_FILES = 3;

export const DEFAULT_REFRESH_SEC = 10;
export const DEFAULT_CHART_REFRESH_SEC = 60;
export const DEFAULT_RAW_RETENTION_DAYS = 90;
export const DEFAULT_AGG_RETENTION_MONTHS = 24;

export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/settings/keys';
export const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
export const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';
export const OPENROUTER_ACTIVITY_URL = 'https://openrouter.ai/api/v1/activity';
export const OPENROUTER_ANALYTICS_QUERY_URL = 'https://openrouter.ai/api/v1/analytics/query';
export const OPENROUTER_ANALYTICS_META_URL = 'https://openrouter.ai/api/v1/analytics/meta';
export const OPENROUTER_KEYS_URL_API = 'https://openrouter.ai/api/v1/keys';

export const CREDENTIAL_SERVICE = 'openrouter-desktop-widget';
export const CREDENTIAL_ACCOUNT = 'openrouter-management-key';
