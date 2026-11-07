import type { Metric, TabId } from './types.js';

export interface Settings {
  parameters: {
    refresh_sec: 5 | 10 | 30 | 60;
    chart_refresh_sec: 30 | 60 | 300;
    pause_when_hidden: boolean;
    raw_retention_days: 30 | 90 | 180 | 365;
    agg_retention_months: 12 | 24;
    time_zone: string;
    week_start: 'monday' | 'sunday';
    hour_format: '12' | '24';
    stale_threshold_sec: number;
  };
  display: {
    theme: 'dark' | 'light' | 'system';
    density: 'comfortable' | 'compact';
    opacity: number;
    always_on_top: 'normal' | 'stronger' | 'off';
    ghost: boolean;
    locked: boolean;
    keep_in_work_area: boolean;
    snap_to_edges: boolean;
    launch_at_login: boolean;
    default_tab: TabId;
    metric_spending: Metric;
    metric_requests: Metric;
    metric_models: Metric;
    metric_api: Metric;
    animations: 'on' | 'reduced' | 'off';
  };
  view: {
    tab: TabId;
    scope: { kind: 'all' } | { kind: 'key'; id: string; name: string };
  };
}

export const DEFAULT_SETTINGS: Settings = {
  parameters: {
    refresh_sec: 10,
    chart_refresh_sec: 60,
    pause_when_hidden: true,
    raw_retention_days: 90,
    agg_retention_months: 24,
    time_zone: 'system',
    week_start: 'monday',
    hour_format: '24',
    stale_threshold_sec: 60,
  },
  display: {
    theme: 'dark',
    density: 'comfortable',
    opacity: 100,
    always_on_top: 'normal',
    ghost: false,
    locked: false,
    keep_in_work_area: true,
    snap_to_edges: true,
    launch_at_login: false,
    default_tab: 'spending',
    metric_spending: 'spend',
    metric_requests: 'tokens',
    metric_models: 'tokens',
    metric_api: 'spend',
    animations: 'on',
  },
  view: {
    tab: 'spending',
    scope: { kind: 'all' },
  },
};

type Validator = (value: unknown) => boolean;

const oneOf = (...allowed: ReadonlyArray<unknown>): Validator => (value) =>
  allowed.some((a) => a === value);

const bool: Validator = (v) => typeof v === 'boolean';
const intIn = (min: number, max: number): Validator => (v) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

const SCHEMA: Record<string, Record<string, Validator>> = {
  parameters: {
    refresh_sec: oneOf(5, 10, 30, 60),
    chart_refresh_sec: oneOf(30, 60, 300),
    pause_when_hidden: bool,
    raw_retention_days: oneOf(30, 90, 180, 365),
    agg_retention_months: oneOf(12, 24),
    time_zone: (v) => typeof v === 'string' && v.length > 0 && v.length <= 64,
    week_start: oneOf('monday', 'sunday'),
    hour_format: oneOf('12', '24'),
    stale_threshold_sec: intIn(30, 3600),
  },
  display: {
    theme: oneOf('dark', 'light', 'system'),
    density: oneOf('comfortable', 'compact'),
    opacity: intIn(40, 100),
    always_on_top: oneOf('normal', 'stronger', 'off'),
    ghost: bool,
    locked: bool,
    keep_in_work_area: bool,
    snap_to_edges: bool,
    launch_at_login: bool,
    default_tab: oneOf('spending', 'requests', 'models', 'api', 'settings'),
    metric_spending: oneOf('spend', 'tokens'),
    metric_requests: oneOf('spend', 'tokens'),
    metric_models: oneOf('spend', 'tokens'),
    metric_api: oneOf('spend', 'tokens'),
    animations: oneOf('on', 'reduced', 'off'),
  },
};

export interface SettingsPatchResult {
  settings: Settings;
  rejected: Array<{ group: string; key: string; reason: string }>;
}

/**
 * Validate and apply a partial settings patch. Unknown fields are rejected
 * rather than ignored, per FSD section 11.2.
 */
export function applySettingsPatch(current: Settings, patch: unknown): SettingsPatchResult {
  const rejected: SettingsPatchResult['rejected'] = [];
  const next: Settings = structuredClone(current);

  if (typeof patch !== 'object' || patch === null) {
    return { settings: next, rejected: [{ group: '*', key: '*', reason: 'not_an_object' }] };
  }

  for (const [group, groupPatch] of Object.entries(patch as Record<string, unknown>)) {
    if (group === 'view') {
      if (typeof groupPatch !== 'object' || groupPatch === null) {
        rejected.push({ group, key: '*', reason: 'not_an_object' });
        continue;
      }
      const viewPatch = groupPatch as Record<string, unknown>;
      for (const [key, value] of Object.entries(viewPatch)) {
        if (key === 'tab') {
          if (oneOf('spending', 'requests', 'models', 'api', 'settings')(value)) {
            next.view.tab = value as TabId;
          } else {
            rejected.push({ group, key, reason: 'invalid_value' });
          }
        } else if (key === 'scope') {
          const scope = value as { kind?: string; id?: string; name?: string };
          if (scope && scope.kind === 'all') {
            next.view.scope = { kind: 'all' };
          } else if (scope && scope.kind === 'key' && typeof scope.id === 'string') {
            next.view.scope = {
              kind: 'key',
              id: scope.id,
              name: typeof scope.name === 'string' ? scope.name : scope.id,
            };
          } else {
            rejected.push({ group, key, reason: 'invalid_value' });
          }
        } else {
          rejected.push({ group, key, reason: 'unknown_field' });
        }
      }
      continue;
    }

    const groupSchema = SCHEMA[group];
    if (!groupSchema) {
      rejected.push({ group, key: '*', reason: 'unknown_group' });
      continue;
    }
    if (typeof groupPatch !== 'object' || groupPatch === null) {
      rejected.push({ group, key: '*', reason: 'not_an_object' });
      continue;
    }

    for (const [key, value] of Object.entries(groupPatch as Record<string, unknown>)) {
      const validator = groupSchema[key];
      if (!validator) {
        rejected.push({ group, key, reason: 'unknown_field' });
        continue;
      }
      if (!validator(value)) {
        rejected.push({ group, key, reason: 'invalid_value' });
        continue;
      }
      (next as unknown as Record<string, Record<string, unknown>>)[group]![key] = value;
    }
  }

  return { settings: next, rejected };
}

export function resetGroup(current: Settings, group: 'parameters' | 'display' | 'view' | 'all'): Settings {
  if (group === 'all') return structuredClone(DEFAULT_SETTINGS);
  const next = structuredClone(current);
  if (group === 'view') {
    next.view = structuredClone(DEFAULT_SETTINGS.view);
  } else if (group === 'parameters') {
    next.parameters = structuredClone(DEFAULT_SETTINGS.parameters);
  } else {
    next.display = structuredClone(DEFAULT_SETTINGS.display);
  }
  return next;
}

export function metricForTab(settings: Settings, tab: TabId): Metric {
  if (tab === 'requests') return settings.display.metric_requests;
  if (tab === 'models') return settings.display.metric_models;
  if (tab === 'api') return settings.display.metric_api;
  return settings.display.metric_spending;
}
