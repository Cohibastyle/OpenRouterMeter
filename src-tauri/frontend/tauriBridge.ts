/**
 * Tauri implementation of the shared `WidgetApi` contract.
 *
 * The renderer is unchanged: it still reads `window.widget`. This module builds
 * that object over Tauri's `invoke` and `listen`, so the 38 request/response
 * methods and 5 push subscriptions map one-to-one onto the Electron preload.
 *
 * Command names are the IPC channel names with `:` replaced by `_`, so the two
 * implementations stay easy to diff.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { WidgetApi, Unsubscribe } from '../../src/shared/widgetApi.js';
import type { Snapshot, TabId } from '../../src/shared/types.js';
import type { LayoutInfo } from '../../src/shared/layout.js';

/** Subscribe to a Tauri event, returning the unsubscribe function the API expects. */
function subscribe<T>(event: string, cb: (payload: T) => void): Unsubscribe {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;

  void listen<T>(event, (e) => cb(e.payload)).then((fn) => {
    if (cancelled) fn();
    else unlisten = fn;
  });

  return () => {
    cancelled = true;
    unlisten?.();
  };
}

export const api: WidgetApi = {
  account: {
    status: () => invoke('account_status'),
  },
  snapshot: {
    get: () => invoke('snapshot_get'),
    onUpdate: (cb: (snapshot: Snapshot) => void) => subscribe<Snapshot>('snapshot:update', cb),
  },
  summary: {
    get: (metric) => invoke('summary_get', { metric }),
  },
  charts: {
    get: (params) => invoke('charts_get', { params }),
    onInvalidate: (cb: () => void) => subscribe<void>('charts:invalidate', cb),
  },
  requests: {
    list: (limit, keyId) => invoke('requests_list', { limit, keyId }),
    breakdown: (params) => invoke('requests_breakdown', { params }),
  },
  keys: {
    list: () => invoke('keys_list'),
  },
  window: {
    getState: () => invoke('window_get_state'),
    setState: (patch) => invoke('window_set_state', { patch }),
    minimize: () => invoke('window_minimize'),
    hide: () => invoke('window_hide'),
    close: () => invoke('window_close'),
    resetSize: () => invoke('window_reset_size'),
    onLayout: (cb: (layout: LayoutInfo) => void) => subscribe<LayoutInfo>('window:layout', cb),
  },
  settings: {
    get: () => invoke('settings_get'),
    set: (patch) => invoke('settings_set', { patch }),
    reset: (group) => invoke('settings_reset', { group }),
  },
  logs: {
    query: (query) => invoke('logs_query', { query }),
    tail: () => invoke('logs_tail'),
    unsubscribe: () => invoke('logs_unsubscribe'),
    clearView: () => invoke('logs_clear_view'),
    openFolder: () => invoke('logs_open_folder'),
    errorCount: (sinceSeq) => invoke('logs_error_count', { sinceSeq }),
    onEntry: (cb) => subscribe('logs:entry', cb),
  },
  diagnostics: {
    get: () => invoke('diagnostics_get'),
    copy: () => invoke('diagnostics_copy'),
    save: () => invoke('diagnostics_save'),
  },
  app: {
    version: () => invoke('app_version'),
    checkForUpdates: () => invoke('app_check_for_updates'),
    openExternal: (url) => invoke('app_open_external', { url }),
    refreshNow: () => invoke('app_refresh_now'),
    quit: () => invoke('app_quit'),
  },
  credential: {
    state: () => invoke('credential_state'),
    save: (secret) => invoke('credential_save', { secret }),
    test: () => invoke('credential_test'),
    disconnect: (deleteHistory) => invoke('credential_disconnect', { deleteHistory }),
  },
  data: {
    export: () => invoke('data_export'),
    clear: (confirmed) => invoke('data_clear', { confirmed }),
    vacuum: () => invoke('data_vacuum'),
    openDbFolder: () => invoke('data_open_db_folder'),
  },
  view: {
    onTab: (cb: (tab: TabId) => void) => subscribe<TabId>('view:tab', cb),
  },
};

/** Install the bridge before the renderer bundle runs. */
export function installBridge(): void {
  (window as unknown as { widget: WidgetApi }).widget = api;
}

// The page CSP is `script-src 'self'`, so an inline install call is blocked.
// Self-install instead: this bundle is loaded before the renderer.
installBridge();
