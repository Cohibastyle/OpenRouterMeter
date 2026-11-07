import { contextBridge, ipcRenderer } from 'electron';
import type {
  ChartData,
  DiagnosticBundle,
  KeyRecord,
  LogEntry,
  LogQuery,
  Metric,
  RequestRecord,
  Snapshot,
  TabId,
  VersionInfo,
  WindowState,
} from '../shared/types.js';
import type { Settings } from '../shared/settings.js';
import type { LayoutInfo } from '../shared/layout.js';
import type { BreakdownResult } from '../shared/breakdown.js';
import type { ChartScale } from '../shared/chart.js';
import type { WidgetApi } from '../shared/widgetApi.js';

/**
 * A fixed, named IPC surface. There is deliberately no generic
 * invoke(channel, payload) passthrough, per FSD section 5.3.
 */
const api: WidgetApi = {
  account: {
    status: (): Promise<Snapshot['account']> => ipcRenderer.invoke('account:status'),
  },
  snapshot: {
    get: (): Promise<Snapshot> => ipcRenderer.invoke('snapshot:get'),
    onUpdate: (cb: (snapshot: Snapshot) => void): (() => void) => {
      const handler = (_e: unknown, snapshot: Snapshot) => cb(snapshot);
      ipcRenderer.on('snapshot:update', handler);
      return () => ipcRenderer.removeListener('snapshot:update', handler);
    },
  },
  summary: {
    get: (metric: Metric): Promise<{ windows: Snapshot['windows']; metric: Metric; as_of: string }> =>
      ipcRenderer.invoke('summary:get', { metric }),
  },
  charts: {
    get: (params: {
      metric: Metric;
      scale: ChartScale;
      anchor: number;
      keyId: string | null;
    }): Promise<ChartData> => ipcRenderer.invoke('charts:get', params),
    onInvalidate: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on('charts:invalidate', handler);
      return () => ipcRenderer.removeListener('charts:invalidate', handler);
    },
  },
  requests: {
    list: (limit: number, keyId: string | null): Promise<RequestRecord[]> =>
      ipcRenderer.invoke('requests:list', { limit, keyId }),
    breakdown: (params: {
      groupBy: 'model' | 'key';
      windowMs: number;
      keyId: string | null;
    }): Promise<BreakdownResult> => ipcRenderer.invoke('requests:breakdown', params),
  },
  keys: {
    list: (): Promise<
      Array<KeyRecord & { spend_24h_micro: number; tokens_24h: number; requests_24h: number }>
    > => ipcRenderer.invoke('keys:list'),
  },
  window: {
    getState: (): Promise<WindowState & { layout: LayoutInfo }> => ipcRenderer.invoke('window:getState'),
    setState: (patch: Partial<WindowState>): Promise<WindowState & { layout: LayoutInfo }> =>
      ipcRenderer.invoke('window:setState', patch),
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    hide: (): Promise<void> => ipcRenderer.invoke('window:hide'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
    resetSize: (): Promise<WindowState['bounds'] | null> => ipcRenderer.invoke('window:resetSize'),
    onLayout: (cb: (layout: LayoutInfo) => void): (() => void) => {
      const handler = (_e: unknown, layout: LayoutInfo) => cb(layout);
      ipcRenderer.on('window:layout', handler);
      return () => ipcRenderer.removeListener('window:layout', handler);
    },
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    set: (patch: unknown): Promise<{ settings: Settings; rejected: Array<{ group: string; key: string; reason: string }> }> =>
      ipcRenderer.invoke('settings:set', patch),
    reset: (group: 'parameters' | 'display' | 'view' | 'all'): Promise<Settings> =>
      ipcRenderer.invoke('settings:reset', group),
  },
  logs: {
    query: (query: LogQuery): Promise<LogEntry[]> => ipcRenderer.invoke('logs:query', query),
    tail: (): Promise<{ subscribed: boolean; latest_seq: number }> => ipcRenderer.invoke('logs:tail'),
    unsubscribe: (): Promise<{ subscribed: boolean }> => ipcRenderer.invoke('logs:unsubscribe'),
    clearView: (): Promise<{ cleared: boolean }> => ipcRenderer.invoke('logs:clearView'),
    openFolder: (): Promise<{ opened: string }> => ipcRenderer.invoke('logs:openFolder'),
    errorCount: (sinceSeq: number): Promise<{ count: number; latest_seq: number }> =>
      ipcRenderer.invoke('logs:errorCount', sinceSeq),
    onEntry: (cb: (entry: LogEntry) => void): (() => void) => {
      const handler = (_e: unknown, entry: LogEntry) => cb(entry);
      ipcRenderer.on('logs:entry', handler);
      return () => ipcRenderer.removeListener('logs:entry', handler);
    },
  },
  diagnostics: {
    get: (): Promise<DiagnosticBundle> => ipcRenderer.invoke('diagnostics:get'),
    copy: (): Promise<{ copied: boolean; bytes: number }> => ipcRenderer.invoke('diagnostics:copy'),
    save: (): Promise<{ saved: boolean; path?: string }> => ipcRenderer.invoke('diagnostics:save'),
  },
  app: {
    version: (): Promise<VersionInfo> => ipcRenderer.invoke('app:version'),
    checkForUpdates: (): Promise<{ state: string; checked_at: string }> => ipcRenderer.invoke('app:checkForUpdates'),
    openExternal: (url: string): Promise<{ opened: boolean }> => ipcRenderer.invoke('app:openExternal', url),
    refreshNow: (): Promise<Snapshot> => ipcRenderer.invoke('app:refreshNow'),
    quit: (): Promise<void> => ipcRenderer.invoke('app:quit'),
  },
  credential: {
    state: (): Promise<{
      state: string;
      encryption_available: boolean;
      has_credential: boolean;
      label: string | null;
      last4: string | null;
      saved_at: string | null;
    }> => ipcRenderer.invoke('credential:state'),
    save: (
      secret: string,
    ): Promise<{
      ok: boolean;
      persisted?: boolean;
      encryption_available?: boolean;
      label?: string | null;
      last4?: string | null;
      error?: string;
      message?: string;
    }> => ipcRenderer.invoke('credential:save', secret),
    test: (): Promise<{ ok: boolean; latency_ms?: number; label?: string | null; scope?: string; error?: string }> =>
      ipcRenderer.invoke('credential:test'),
    disconnect: (deleteHistory: boolean): Promise<{ ok: boolean; history_deleted: boolean }> =>
      ipcRenderer.invoke('credential:disconnect', deleteHistory),
  },
  data: {
    export: (): Promise<{ exported: boolean; path?: string }> => ipcRenderer.invoke('data:export'),
    clear: (confirmed: boolean): Promise<{ cleared: boolean }> => ipcRenderer.invoke('data:clear', confirmed),
    vacuum: (): Promise<{ vacuumed: boolean; stats: unknown }> => ipcRenderer.invoke('data:vacuum'),
    openDbFolder: (): Promise<{ opened: string }> => ipcRenderer.invoke('data:openDbFolder'),
  },
  view: {
    onTab: (cb: (tab: TabId) => void): (() => void) => {
      const handler = (_e: unknown, tab: TabId) => cb(tab);
      ipcRenderer.on('view:tab', handler);
      return () => ipcRenderer.removeListener('view:tab', handler);
    },
  },
};

contextBridge.exposeInMainWorld('widget', api);

export type { WidgetApi } from '../shared/widgetApi.js';
