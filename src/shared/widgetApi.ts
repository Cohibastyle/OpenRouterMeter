/**
 * The bridge contract between the renderer and the host process.
 *
 * The renderer only ever touches `window.widget`, and this interface is the
 * whole of that surface: 38 request/response methods and 5 push subscriptions.
 * It lives in `shared/` rather than in the preload so that a second host
 * implementation can type-check against the same declaration. The Electron
 * preload implements it over `ipcRenderer`; a Tauri build implements it over
 * `invoke` and `listen`.
 *
 * There is deliberately no generic `invoke(channel, payload)` passthrough, per
 * FSD section 5.3. Every method is named, typed, and bounded.
 */
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
} from './types.js';
import type { Settings } from './settings.js';
import type { LayoutInfo } from './layout.js';
import type { BreakdownResult } from './breakdown.js';
import type { ChartScale } from './chart.js';

/** A push subscription. Calling the returned function unsubscribes. */
export type Unsubscribe = () => void;

export interface CredentialState {
  state: string;
  encryption_available: boolean;
  has_credential: boolean;
  label: string | null;
  last4: string | null;
  saved_at: string | null;
}

export interface CredentialSaveResult {
  ok: boolean;
  persisted?: boolean;
  encryption_available?: boolean;
  label?: string | null;
  last4?: string | null;
  error?: string;
  message?: string;
}

export interface CredentialTestResult {
  ok: boolean;
  latency_ms?: number;
  label?: string | null;
  scope?: string;
  error?: string;
}

export interface SettingsSetResult {
  settings: Settings;
  rejected: Array<{ group: string; key: string; reason: string }>;
}

export interface KeySummary extends KeyRecord {
  spend_24h_micro: number;
  tokens_24h: number;
  requests_24h: number;
}

export interface SummaryResult {
  windows: Snapshot['windows'];
  metric: Metric;
  as_of: string;
}

export interface ChartParams {
  metric: Metric;
  scale: ChartScale;
  anchor: number;
  keyId: string | null;
}

export interface BreakdownParams {
  groupBy: 'model' | 'key';
  scale: ChartScale;
  /**
   * Instant the window ends at. The renderer passes the snapshot's own
   * instant, so the table sums the same trailing window the interval buttons
   * show; a fresh clock read here would slide the window between the two.
   */
  anchor: number;
  keyId: string | null;
}

export interface WindowStateResult extends WindowState {
  layout: LayoutInfo;
}

export interface WidgetApi {
  account: {
    status(): Promise<Snapshot['account']>;
  };
  snapshot: {
    get(): Promise<Snapshot>;
    onUpdate(cb: (snapshot: Snapshot) => void): Unsubscribe;
  };
  summary: {
    get(metric: Metric): Promise<SummaryResult>;
  };
  charts: {
    get(params: ChartParams): Promise<ChartData>;
    onInvalidate(cb: () => void): Unsubscribe;
  };
  requests: {
    list(limit: number, keyId: string | null): Promise<RequestRecord[]>;
    breakdown(params: BreakdownParams): Promise<BreakdownResult>;
  };
  keys: {
    list(): Promise<KeySummary[]>;
  };
  window: {
    getState(): Promise<WindowStateResult>;
    setState(patch: Partial<WindowState>): Promise<WindowStateResult>;
    minimize(): Promise<void>;
    /** Move the window by a screen-space delta; used by the drag handle. */
    moveBy(delta: { dx: number; dy: number }): Promise<WindowState['bounds'] | null>;
    hide(): Promise<void>;
    close(): Promise<void>;
    resetSize(): Promise<WindowState['bounds'] | null>;
    onLayout(cb: (layout: LayoutInfo) => void): Unsubscribe;
  };
  settings: {
    get(): Promise<Settings>;
    set(patch: unknown): Promise<SettingsSetResult>;
    reset(group: 'parameters' | 'display' | 'view' | 'all'): Promise<Settings>;
  };
  logs: {
    query(query: LogQuery): Promise<LogEntry[]>;
    tail(): Promise<{ subscribed: boolean; latest_seq: number }>;
    unsubscribe(): Promise<{ subscribed: boolean }>;
    clearView(): Promise<{ cleared: boolean }>;
    openFolder(): Promise<{ opened: string }>;
    errorCount(sinceSeq: number): Promise<{ count: number; latest_seq: number }>;
    onEntry(cb: (entry: LogEntry) => void): Unsubscribe;
  };
  diagnostics: {
    get(): Promise<DiagnosticBundle>;
    copy(): Promise<{ copied: boolean; bytes: number }>;
    save(): Promise<{ saved: boolean; path?: string }>;
  };
  app: {
    version(): Promise<VersionInfo>;
    checkForUpdates(): Promise<{ state: string; checked_at: string }>;
    openExternal(url: string): Promise<{ opened: boolean }>;
    refreshNow(): Promise<Snapshot>;
    quit(): Promise<void>;
  };
  credential: {
    state(): Promise<CredentialState>;
    save(secret: string): Promise<CredentialSaveResult>;
    test(): Promise<CredentialTestResult>;
    disconnect(deleteHistory: boolean): Promise<{ ok: boolean; history_deleted: boolean }>;
  };
  data: {
    export(): Promise<{ exported: boolean; path?: string }>;
    clear(confirmed: boolean): Promise<{ cleared: boolean }>;
    vacuum(): Promise<{ vacuumed: boolean; stats: unknown }>;
    openDbFolder(): Promise<{ opened: string }>;
  };
  view: {
    onTab(cb: (tab: TabId) => void): Unsubscribe;
  };
}
