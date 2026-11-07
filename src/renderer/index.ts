import type { WidgetApi } from '../shared/widgetApi.js';
import type { LayoutInfo } from '../shared/layout.js';
import type { Settings } from '../shared/settings.js';
import type { BreakdownResult, BreakdownRow } from '../shared/breakdown.js';
import { CHART_RANGE_MS, type ChartScale } from '../shared/chart.js';
import type {
  ChartData,
  KeyRecord,
  LogEntry,
  LogQuery,
  Metric,
  RequestRecord,
  Scope,
  Severity,
  Snapshot,
  TabId,
  VersionInfo,
  WindowCell,
} from '../shared/types.js';
import {
  DASH,
  formatAgeSince,
  formatMetricValue,
  formatClock,
  formatCount,
  formatDateTime,
  formatSpend,
  formatTokensCompact,
  formatTokensExact,
} from '../shared/format.js';
import { TAB_LABELS, TABS, WINDOWS } from '../shared/constants.js';
import { clear, debounce, el, ICONS, icon } from './components/dom.js';
import { helpFor } from './settingsHelp.js';
import { SummaryStrip } from './components/strip.js';
import { animateHeadline, fitHeadline, motionAllowed } from './components/odometer.js';
import { ChartRenderer } from './charts/renderer.js';

declare global {
  interface Window {
    widget: WidgetApi;
  }
}

const api = window.widget;

/** How long the headline takes to roll from one value to the next. */
const HEADLINE_ANIM_MS = 2000;
/** How long the "last increase" chip stays at full opacity. */
const INCREASE_TTL_MS = 5000;
/** How long a fresh increase holds its inverse (filled) look. */
const INCREASE_FLASH_MS = 900;
/** How long the chip takes to fade once its time is up. */
const INCREASE_FADE_MS = 400;
/** Space between a stacked headline and the chip under it; matches app.css. */
const STACKED_CHIP_GAP = 2;

/** The most recent rise in a headline value, and the interval it belongs to. */
interface Increase {
  amount: number;
  requests: number | null;
  at: number;
  key: ChartScale;
}

interface HeadlineValues {
  key: ChartScale;
  spend: number | null;
  tokens: number | null;
  requests: number | null;
}

interface AppState {
  snapshot: Snapshot | null;
  settings: Settings | null;
  layout: LayoutInfo;
  tab: TabId;
  subview: 'none' | 'charts';
  chartMetric: Metric;
  chartScale: ChartScale;
  chartAnchor: number;
  chartData: ChartData | null;
  requests: RequestRecord[];
  keys: Array<KeyRecord & { spend_24h_micro: number; tokens_24h: number; requests_24h: number }>;
  logs: LogEntry[];
  logQuery: LogQuery;
  logExpanded: number | null;
  logLiveTail: boolean;
  logErrorSeq: number;
  version: VersionInfo | null;
  credential: {
    state: string;
    encryption_available: boolean;
    has_credential: boolean;
    label: string | null;
    last4: string | null;
    saved_at: string | null;
  } | null;
  expandedGroups: Set<string>;
  breakdown: BreakdownResult | null;
  breakdownByKey: BreakdownResult | null;
  chartOptionsOpen: boolean;
  busy: boolean;
  notice: { kind: 'ok' | 'error' | 'warn'; text: string } | null;
  /** Last headline values, so a refresh can roll from them instead of jumping. */
  headline: HeadlineValues | null;
  /** Value currently painted in each headline, used as the roll's start point. */
  displayed: Record<Metric, number | null>;
  /** Most recent rise per metric, shown beside the headline. */
  increases: Record<Metric, Increase | null>;
  /** Scroll offset of the Settings pane, restored after it is rebuilt. */
  settingsScroll: number;
}

const state: AppState = {
  snapshot: null,
  settings: null,
  layout: {
    width: 320,
    height: 240,
    widthClass: 'm',
    heightClass: 'regular',
    mode: 'standard',
    stripColumns: 5,
    stripOverflow: false,
    stripDetail: 'value',
    iconRail: false,
    collapsedFilters: false,
    stackedHeaders: false,
    showChart: false,
  },
  tab: 'spending',
  subview: 'none',
  chartMetric: 'spend',
  chartScale: '24h',
  chartAnchor: Date.now(),
  chartData: null,
  requests: [],
  keys: [],
  logs: [],
  logQuery: { severities: ['error', 'warn'], sources: [], text: '', range: 'all', limit: 500 },
  logExpanded: null,
  logLiveTail: true,
  logErrorSeq: 0,
  version: null,
  credential: null,
  expandedGroups: new Set(['api-key']),
  breakdown: null,
  breakdownByKey: null,
  chartOptionsOpen: false,
  busy: false,
  notice: null,
  headline: null,
  displayed: { spend: null, tokens: null },
  increases: { spend: null, tokens: null },
  settingsScroll: 0,
};

let chartRenderer: ChartRenderer | null = null;
let strip: SummaryStrip | null = null;
let snapshotUnsubscribe: (() => void) | null = null;
let layoutUnsubscribe: (() => void) | null = null;
let tabUnsubscribe: (() => void) | null = null;
let chartInvalidateUnsubscribe: (() => void) | null = null;
let logEntryUnsubscribe: (() => void) | null = null;
let logTailActive = false;

const root = document.getElementById('root')!;
const content = document.getElementById('content')!;
const tabbar = document.getElementById('tabbar')!;
const statusDot = document.getElementById('status-dot')!;
const statusText = document.getElementById('status-text')!;
const appTitle = document.getElementById('app-title')!;
const statusAge = document.getElementById('status-age')!;
const sampleBadge = document.getElementById('sample-badge')!;
const banner = document.getElementById('banner')!;
const bannerText = document.getElementById('banner-text')!;
const bannerAction = document.getElementById('banner-action')!;
const sizeReadout = document.getElementById('size-readout')!;

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

async function boot(): Promise<void> {
  const [settings, snapshot, layoutState, version, credential] = await Promise.all([
    api.settings.get(),
    api.snapshot.get(),
    api.window.getState(),
    api.app.version(),
    api.credential.state(),
  ]);

  state.settings = settings;
  state.snapshot = snapshot;
  state.layout = layoutState.layout;
  state.version = version;
  state.credential = credential;
  state.tab = settings.view.tab;
  state.chartMetric = settings.display.metric_spending;
  state.chartScale = defaultChartScale(snapshot);

  // The header names the product and its version, so a screenshot always says
  // which build produced it.
  appTitle.textContent = `OpenRouter Meter (${version.widget})`;

  applyTheme();
  applyLayout();
  renderTabs();
  render();
  wireChrome();

  snapshotUnsubscribe = api.snapshot.onUpdate((next) => {
    handleSnapshot(next);
  });

  layoutUnsubscribe = api.window.onLayout((layout) => {
    state.layout = layout;
    applyLayout();
    // The tab bar drops its labels in the icon-rail widths, and the label spans
    // are only created when the rail is off, so the bar has to be rebuilt when
    // the width class changes rather than only when the tab does.
    renderTabs();
    render();
  });

  tabUnsubscribe = api.view.onTab((tab) => activateTab(tab));

  chartInvalidateUnsubscribe = api.charts.onInvalidate(() => {
    if (state.subview === 'charts') void loadChart();
  });

  logEntryUnsubscribe = api.logs.onEntry((entry) => {
    if (!matchesLogQuery(entry, state.logQuery)) return;
    state.logs = [entry, ...state.logs].slice(0, 2000);
    if (logTailActive && state.logLiveTail) render();
  });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', debounce(() => void refreshLayout(), 60));

  await Promise.all([loadBreakdown(), loadKeys(), loadLogs()]);
  render();
}

function applyTheme(): void {
  const theme = state.settings?.display.theme ?? 'dark';
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.density = state.settings?.display.density ?? 'comfortable';
  document.documentElement.dataset.animations = state.settings?.display.animations ?? 'on';
}

function applyLayout(): void {
  const layout = state.layout;
  root.dataset.mode = layout.mode;
  root.dataset.widthClass = layout.widthClass;
  root.dataset.heightClass = layout.heightClass;
  root.dataset.iconRail = String(layout.iconRail);
  root.dataset.stackedHeaders = String(layout.stackedHeaders);
  root.dataset.showChart = String(layout.showChart);
  // The status bar is the drag handle, so the lock setting suppresses it here
  // rather than only in the scripted drag handler.
  root.dataset.locked = String(state.settings?.display.locked ?? false);
}

async function refreshLayout(): Promise<void> {
  const stateInfo = await api.window.getState();
  state.layout = stateInfo.layout;
  applyLayout();
  renderTabs();
  render();
}

/* ------------------------------------------------------------------ */
/* chrome                                                              */
/* ------------------------------------------------------------------ */

function wireChrome(): void {
  document.getElementById('btn-refresh')?.addEventListener('click', async () => {
    state.busy = true;
    render();
    try {
      const snapshot = await api.app.refreshNow();
      handleSnapshot(snapshot);
    } finally {
      state.busy = false;
      render();
    }
  });

  document.getElementById('btn-minimize')?.addEventListener('click', () => void api.window.minimize());
  document.getElementById('btn-close')?.addEventListener('click', () => void api.window.hide());

  bannerAction.addEventListener('click', () => {
    state.expandedGroups.add('api-key');
    activateTab('settings');
  });

  const handle = document.getElementById('resize-handle')!;
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const startX = event.screenX;
    const startY = event.screenY;
    const startW = window.innerWidth;
    const startH = window.innerHeight;
    sizeReadout.hidden = false;

    const onMove = (moveEvent: PointerEvent) => {
      const width = Math.max(180, startW + (moveEvent.screenX - startX));
      const height = Math.max(120, startH + (moveEvent.screenY - startY));
      sizeReadout.textContent = `${Math.round(width)} \u00d7 ${Math.round(height)}`;
      void api.window.setState({ bounds: { x: window.screenX, y: window.screenY, width, height } });
    };

    const onUp = () => {
      sizeReadout.hidden = true;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      void refreshLayout();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });

  wireDrag();
}

/**
 * Move the window from the status bar.
 *
 * The CSS `-webkit-app-region: drag` declaration stays in place as the
 * platform-correct way to do this, but it does not start a move on a
 * non-opaque window whose shell paints a `backdrop-filter`: the region is
 * present and hit-testable, and a press on it still does nothing. So the drag
 * is also driven from script, applying the pointer delta to the window through
 * the main process.
 *
 * The two must not both run. If the native region works the window follows the
 * press on its own and the script would move it a second time by the same
 * delta, so the handler only starts once the press has been held for a moment
 * without the window moving. A working native drag moves the window on the
 * first pointer moves, which cancels the scripted drag before it begins.
 */
const DRAG_ARM_MS = 90;

function wireDrag(): void {
  const bar = document.getElementById('statusbar');
  const region = document.getElementById('drag-region');
  if (!bar || !region) return;

  /** Origin the window had when the press began. */
  let startWindowX = 0;
  let startWindowY = 0;
  /** Where the pointer was on the previous move. */
  let lastX = 0;
  let lastY = 0;
  /**
   * Whether the script has taken over the press. Until it has, a change in the
   * window origin means the platform is moving the window natively.
   */
  let scripted = false;
  let armTimer = 0;

  const end = () => {
    if (armTimer) window.clearTimeout(armTimer);
    armTimer = 0;
    scripted = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    bar.classList.remove('is-dragging');
  };

  const onMove = (event: PointerEvent) => {
    if (!scripted) {
      // The native region moved the window, so this press is already handled.
      if (window.screenX !== startWindowX || window.screenY !== startWindowY) end();
      return;
    }
    const dx = Math.round(event.screenX - lastX);
    const dy = Math.round(event.screenY - lastY);
    if (dx === 0 && dy === 0) return;
    lastX = event.screenX;
    lastY = event.screenY;
    void api.window.moveBy({ dx, dy });
  };

  region.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (state.settings?.display.locked) return;
    const target = event.target as HTMLElement | null;
    // Controls inside the bar keep their own clicks.
    if (target?.closest('.window-controls')) return;

    lastX = event.screenX;
    lastY = event.screenY;
    startWindowX = window.screenX;
    startWindowY = window.screenY;

    // Capture so the move events keep arriving once the script starts moving the
    // window out from under the pointer.
    try {
      region.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best-effort; window-level listeners still work without it.
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);

    // Give a working native region the first chance: if the window has not
    // moved once the press has had time to register, drive it from script.
    if (armTimer) window.clearTimeout(armTimer);
    armTimer = window.setTimeout(() => {
      armTimer = 0;
      if (window.screenX !== startWindowX || window.screenY !== startWindowY) {
        end();
        return;
      }
      // The script owns the press from here, so later origin changes are its
      // own doing and must not be read as a native drag.
      scripted = true;
      bar.classList.add('is-dragging');
    }, DRAG_ARM_MS);
  });
}

function onKeyDown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  const typing =
    target &&
    (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA');

  if (event.key === 'Escape') {
    if (state.subview !== 'none') {
      state.subview = 'none';
      state.chartOptionsOpen = false;
      render();
      event.preventDefault();
    }
    return;
  }

  if (typing) return;

  if (event.key >= '1' && event.key <= '5') {
    const index = Number(event.key) - 1;
    const tab = TABS[index];
    if (tab) {
      activateTab(tab);
      event.preventDefault();
    }
  }
}

/* ------------------------------------------------------------------ */
/* data loading                                                        */
/* ------------------------------------------------------------------ */

function handleSnapshot(next: Snapshot): void {
  trackIncrease(next);
  state.snapshot = next;

  if (state.tab === 'requests') void loadBreakdown();
  if (state.tab === 'api') void loadKeys();
  render();
}

/**
 * Record how much the headline rose since the previous snapshot.
 *
 * The chip describes a refresh-to-refresh delta, so it is only meaningful while
 * the same interval stays selected: switching ranges rebases the baseline
 * instead of reporting the difference between two different periods.
 */
function trackIncrease(next: Snapshot): void {
  const key = state.chartScale;
  const cell = next.windows.find((w) => w.key === key) ?? null;
  const current: HeadlineValues = {
    key,
    spend: cell?.spend_micro ?? null,
    tokens: cell?.total_tokens ?? null,
    requests: cell?.request_count ?? null,
  };
  const previous = state.headline;

  if (previous && previous.key !== key) {
    // A different interval is a different measurement, so the headline is
    // repainted rather than rolled from the old range's total.
    state.displayed.spend = null;
    state.displayed.tokens = null;
  }

  if (previous && previous.key === key) {
    const at = Date.now();
    // The chip reports the requests that arrived with this rise, not the
    // interval total, which the sub-line under the headline already states.
    const requests =
      previous.requests === null || current.requests === null
        ? null
        : Math.max(0, current.requests - previous.requests);
    const spendRise = rise(previous.spend, current.spend);
    if (spendRise !== null) {
      state.increases.spend = { amount: spendRise, requests, at, key };
    }
    const tokenRise = rise(previous.tokens, current.tokens);
    if (tokenRise !== null) {
      state.increases.tokens = { amount: tokenRise, requests, at, key };
    }
  }

  state.headline = current;
}

/** The increase between two readings, or null when the value did not rise. */
function rise(previous: number | null, current: number | null): number | null {
  if (previous === null || current === null) return null;
  const delta = current - previous;
  return delta > 0 ? delta : null;
}

/**
 * Drop an increase once it has faded, so a stale chip cannot reappear.
 *
 * `at` identifies the rise the timer was started for: a newer rise replaces the
 * state entry, and its own timer must not be cancelled by the older one. The
 * chip is removed from the DOM directly rather than by re-rendering, because a
 * fade should not rebuild the chart underneath it.
 */
function expireIncrease(metric: Metric, at: number, chip: HTMLElement): void {
  const increase = state.increases[metric];
  if (!increase || increase.at !== at) return;
  if (Date.now() - increase.at < INCREASE_TTL_MS) return;
  state.increases[metric] = null;
  // The chip's slot stays in the row and keeps its height, so the headline is
  // not re-fitted and the number does not move when the chip expires.
  chip.remove();
}

async function loadBreakdown(): Promise<void> {
  const keyId = state.settings?.view.scope.kind === 'key' ? state.settings.view.scope.id : null;
  const windowMs = CHART_RANGE_MS[state.chartScale];
  // The Keys tab is the same table grouped the other way, for the same
  // interval, so both are fetched together and stay in step.
  const [byModel, byKey] = await Promise.all([
    api.requests.breakdown({ groupBy: 'model', windowMs, keyId }),
    // A key-scoped view must still list every key, otherwise the table would
    // collapse to the one key already selected.
    api.requests.breakdown({ groupBy: 'key', windowMs, keyId: null }),
  ]);
  state.breakdown = byModel;
  state.breakdownByKey = byKey;
}

async function loadKeys(): Promise<void> {
  state.keys = await api.keys.list();
}

async function loadLogs(): Promise<void> {
  state.logs = await api.logs.query(state.logQuery);
}

async function loadChart(): Promise<void> {
  const keyId = state.settings?.view.scope.kind === 'key' ? state.settings.view.scope.id : null;
  state.chartData = await api.charts.get({
    metric: state.chartMetric,
    scale: state.chartScale,
    anchor: state.chartAnchor,
    keyId,
  });
  chartRenderer?.setData(state.chartData);
}

function matchesLogQuery(entry: LogEntry, query: LogQuery): boolean {
  if (query.severities.length > 0 && !query.severities.includes(entry.severity)) return false;
  if (query.sources.length > 0 && !query.sources.includes(entry.source)) return false;
  if (query.text && !entry.message.toLowerCase().includes(query.text.toLowerCase())) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* tabs                                                                */
/* ------------------------------------------------------------------ */

function renderTabs(): void {
  clear(tabbar);
  const layout = state.layout;

  for (const tab of TABS) {
    const selected = state.tab === tab;
    const button = el('button', {
      class: 'tab',
      type: 'button',
      role: 'tab',
      'aria-selected': String(selected),
      'aria-label': TAB_LABELS[tab] ?? tab,
      title: TAB_LABELS[tab] ?? tab,
      'data-tab': tab,
      'data-tab-theme': tab,
    });
    button.appendChild(icon(ICONS[tab as keyof typeof ICONS] ?? ICONS.spending));
    if (!layout.iconRail) {
      button.appendChild(el('span', { class: 'tab-label', text: TAB_LABELS[tab] ?? tab }));
    }
    button.addEventListener('click', () => activateTab(tab));
    tabbar.appendChild(button);
  }
}

/**
 * Activate a tab. The log tail is subscribed only while the Log tab is visible
 * and released on every other tab, per FSD section 13.
 */
function activateTab(tab: TabId): void {
  state.tab = tab;
  state.subview = 'none';

  // The log lives inside Settings now. Keep the tail subscribed only while that
  // group is open, so the widget is not streaming entries it will never show.
  syncLogTail();

  // Keys and Models share one interval, and Settings shows the scope picker, so
  // all three need the same data loaded.
  if (tab === 'requests' || tab === 'models' || tab === 'api' || tab === 'settings') {
    void loadBreakdown();
  }
  if (tab === 'api' || tab === 'settings') void loadKeys();

  renderTabs();
  render();
}

/**
 * The log is a Settings group, so the live tail is tied to whether that group is
 * expanded rather than to a tab being visible.
 */
function syncLogTail(): void {
  const visible = state.tab === 'settings' && state.expandedGroups.has('log');
  if (visible === logTailActive) return;
  logTailActive = visible;
  if (visible) {
    void api.logs.tail().then((result) => {
      state.logErrorSeq = result.latest_seq;
    });
    void loadLogs();
  } else {
    void api.logs.unsubscribe();
  }
}

/* ------------------------------------------------------------------ */
/* render                                                              */
/* ------------------------------------------------------------------ */

function render(): void {
  renderStatus();
  renderBanner();
  // Every tab body inherits its own accent, so the selected interval and the
  // value colours agree with the highlighted tab.
  content.dataset.tabTheme = state.tab;

  if (chartRenderer) {
    chartRenderer.destroy();
    chartRenderer = null;
  }
  strip = null;

  // Help popups live on the body, so clearing the view does not remove them.
  for (const stale of document.querySelectorAll('.help-popup')) stale.remove();

  clear(content);

  if (state.subview === 'charts') {
    renderCharts();
    return;
  }

  switch (state.tab) {
    case 'spending':
      renderSpending();
      break;
    case 'requests':
      renderRequests();
      break;
    case 'models':
      renderModels();
      break;
    case 'api':
      renderApi();
      break;
    case 'settings':
      renderSettings();
      break;
  }
}

function renderStatus(): void {
  const snapshot = state.snapshot;
  const account = snapshot?.account;
  const status = snapshot?.collection_status;

  let dotState = 'ok';
  let text = 'Live';

  if (account?.state === 'unreadable') {
    dotState = 'error';
    text = 'Key unreadable';
  } else if (!account?.connected) {
    // Stored history may be real even with no usable credential, so only call
    // it sample data when the rows actually are samples.
    dotState = 'sample';
    text = snapshot?.sample ? 'Sample data' : 'Offline';
  } else if (account.state === 'invalid') {
    dotState = 'error';
    text = 'Credential invalid';
  } else if (status?.last_error_code) {
    dotState = 'error';
    text = status.last_error_code.replace(/_/g, ' ');
  } else if (status?.stale) {
    dotState = 'stale';
    text = 'Stale';
  }

  statusDot.dataset.state = dotState;
  statusText.textContent = text;
  statusAge.textContent = status?.last_success ? formatAgeSince(status.last_success) : '';
  sampleBadge.hidden = !snapshot?.sample;

  const scope = snapshot?.scope;
  if (scope && scope.kind === 'key') {
    statusText.textContent = `${text} \u00b7 ${scope.name}`;
  }
}

function renderBanner(): void {
  const account = state.snapshot?.account;
  if (account?.state === 'invalid') {
    banner.hidden = false;
    bannerText.textContent = 'The OpenRouter credential was rejected.';
    bannerAction.textContent = 'Fix in Settings';
    return;
  }
  if (account?.state === 'unreadable') {
    // The file is there but the OS would not decrypt it, typically because the
    // keychain entry was reset. Saying "encryption unavailable" here sent the
    // user looking for the wrong problem, and collection stayed stalled.
    banner.hidden = false;
    bannerText.textContent =
      'The saved key could not be read. Re-enter it to resume live updates.';
    bannerAction.textContent = 'Fix in Settings';
    return;
  }
  if (account?.state === 'encryption_unavailable') {
    banner.hidden = false;
    bannerText.textContent = 'OS encryption unavailable; the key is kept for this session only.';
    bannerAction.textContent = 'Details';
    return;
  }
  banner.hidden = true;
}

function currentMetric(): Metric {
  if (!state.settings) return 'spend';
  if (state.tab === 'requests') return state.settings.display.metric_requests;
  if (state.tab === 'models') return state.settings.display.metric_models;
  if (state.tab === 'api') return state.settings.display.metric_api;
  return state.settings.display.metric_spending;
}

function buildStrip(metric: Metric): SummaryStrip {
  const layout = state.layout;
  const instance = new SummaryStrip({
    metric,
    detail: layout.stripDetail,
    selectedKey: state.chartScale,
    onCellClick: (cell) => {
      // A range button selects that range and shows its chart inline, rather
      // than opening a separate chart view.
      state.chartMetric = metric;
      state.chartScale = cell.key;
      state.chartAnchor = Date.now();
      if (state.tab === 'models') {
        void loadBreakdown().then(() => render());
      } else {
        void loadChart().then(() => render());
      }
      render();
    },
  });
  if (state.snapshot) instance.update(state.snapshot.windows);
  return instance;
}

/* ---------------------------- spending ---------------------------- */

/**
 * The chart shown under the range buttons on the Spending and Tokens tabs.
 *
 * It carries its own axis toggle, so the log/linear choice is next to the chart
 * it affects rather than buried in Settings.
 */
function renderInlineChart(metric: Metric): HTMLElement {
  const wrap = el('div', { class: 'inline-chart' });

  const header = el('div', { class: 'inline-chart-header' });
  header.appendChild(
    el('span', {
      class: 'inline-chart-range',
      text: WINDOWS.find((w) => w.key === state.chartScale)?.label ?? state.chartScale,
    }),
  );

  wrap.appendChild(header);

  const chartWrap = el('div', { class: 'chart-wrap' });
  wrap.appendChild(chartWrap);

  chartRenderer = new ChartRenderer(chartWrap, { metric });
  if (state.chartData && state.chartData.metric === metric && state.chartData.scale === state.chartScale) {
    chartRenderer.setData(state.chartData);
  } else {
    void loadChart().then(() => {
      if (state.chartData) chartRenderer?.setData(state.chartData);
    });
  }
  return wrap;
}

function renderSpending(): void {
  const snapshot = state.snapshot;
  const view = el('div', { class: 'view' });

  if (!snapshot) {
    view.appendChild(el('div', { class: 'empty', text: 'Loading\u2026' }));
    content.appendChild(view);
    return;
  }

  // Sample data stays explorable; the connect prompt is a compact strip, not a
  // full-view blocker, so the layout can be reviewed before connecting.
  if (!snapshot.account.connected) {
    const prompt = el('div', { class: 'connect-prompt' });
    // The stored history may be real even when the credential is not usable, so
    // the prompt must not claim these numbers are examples.
    const unreadable = snapshot.account.state === 'unreadable';
    prompt.appendChild(
      el('span', {
        text: unreadable
          ? 'Saved key unreadable \u00b7 re-enter it for live values'
          : snapshot.account.connected
            ? 'Offline \u00b7 showing stored history'
            : 'Sample data \u00b7 connect for live values',
      }),
    );
    const connect = el(
      'button',
      { class: 'btn primary', type: 'button', text: unreadable ? 'Re-enter key' : 'Connect' },
    );
    connect.addEventListener('click', () => {
      state.expandedGroups.add('api-key');
      activateTab('settings');
    });
    prompt.appendChild(connect);
    view.appendChild(prompt);
  }

  const metric = currentMetric();
  strip = buildStrip(metric);
  view.appendChild(strip.root);

  const sourceNote = sourceCoverageNote(snapshot);
  if (sourceNote) view.appendChild(sourceNote);

  const body = el('div', { class: 'spend-body' });
  const metrics = el('div', { class: 'metrics' });

  // The headline is the selected interval, not the calendar day, so it agrees
  // with the highlighted range button and with the chart underneath it.
  const interval = selectedInterval(snapshot);
  const spendBlock = el('div', { class: 'metric' });

  // A non-exact counter that has not moved yet means the widget has not been
  // running long enough to measure anything. Showing $0.00 there would claim
  // the interval is free, so show a dash until it actually moves.
  const unmeasured = interval.counter?.exact === false && !interval.counter.spend_micro;
  const spendValue = el('div', {
    class: `metric-value spend${unmeasured ? ' pending' : ''}`,
    title: interval.title,
  });
  spendValue.addEventListener('click', () => openCharts('spend', state.chartScale));
  spendBlock.appendChild(renderHeadlineRow(spendValue, 'spend', interval.spend_micro, unmeasured));
  if (interval.warning) {
    spendBlock.appendChild(el('div', { class: 'metric-sub', text: interval.warning }));
  }
  metrics.appendChild(spendBlock);

  body.appendChild(metrics);

  if (state.layout.showChart) {
    body.appendChild(renderInlineChart('spend'));
  }

  view.appendChild(body);
  content.appendChild(view);
}

/**
 * Describe the interval the tab is currently showing.
 *
 * The headline on Spending and Tokens is the selected range button, so it always
 * matches the highlighted interval and the chart. Values come from the computed
 * window, which already respects the one-granularity rule, so they cannot
 * double-count the way summing raw rows would.
 */
function selectedInterval(snapshot: Snapshot): {
  cell: WindowCell | null;
  spend_micro: number | null;
  total_tokens: number | null;
  /** A coverage problem worth stating under the headline, or null when it is sound. */
  warning: string | null;
  title: string;
  counter: Snapshot['counter_today'] | null;
} {
  const cell = snapshot.windows.find((w) => w.key === state.chartScale) ?? null;
  const spend = cell?.spend_micro ?? null;
  const tokens = cell?.total_tokens ?? null;

  // The live counter only describes the calendar day, so it can refine the
  // 24h figure and nothing else. Using it for a shorter interval would report a
  // day's spend as if it belonged to the last ten minutes.
  const counter = state.chartScale === '24h' ? snapshot.counter_today : null;

  // Only a coverage problem is stated. The request count and the live-counter
  // note were removed from the headline, but a partial or unavailable figure
  // must still say so, or the number reads as exact when it is not.
  let warning: string | null = null;
  if (cell?.coverage === 'unavailable') {
    warning = 'not available for this interval';
  } else if (cell?.coverage === 'partial') {
    warning = 'partial coverage';
  }

  const title = counter
    ? todaySpendTitle(snapshot)
    : cell
      ? `${cell.label} interval, ${new Date(cell.window_start).toLocaleString()} to ${new Date(cell.window_end).toLocaleString()}${
          tokens !== null ? ` \u00b7 ${formatTokensExact(tokens)} tokens` : ''
        }`
      : 'No interval selected.';

  return { cell, spend_micro: spend, total_tokens: tokens, warning, title, counter };
}

/**
 * The headline number with the "last increase" chip.
 *
 * The chip carries the request count of the refresh that produced the rise, so
 * a jump in spend can be read as "one expensive request" or "a burst of cheap
 * ones" without leaving the tab. It sits to the right of the value at Standard
 * and above, and on its own row under the value in Micro and Compact, where the
 * value is sized to fill the window and the chip would otherwise take width
 * from it.
 */
function renderHeadlineRow(
  value: HTMLElement,
  metric: Metric,
  target: number | null,
  pending: boolean,
): HTMLElement {
  const row = el('div', { class: 'metric-headline' });
  row.appendChild(value);

  const chip = renderIncreaseChip(metric);
  // In the fitted modes the number is the whole point of the view, so the chip
  // goes under it instead of taking width from it. The slot that holds the chip
  // is always present, even with no rise to show: the value is centred as part
  // of that fixed-height group, so a slot that appeared and disappeared would
  // lift the number while the chip was visible and drop it again on expiry.
  if (state.layout.mode === 'micro' || state.layout.mode === 'compact') {
    row.classList.add('is-stacked');
    const slot = el('div', { class: 'metric-increase-slot' });
    if (chip) slot.appendChild(chip);
    row.appendChild(slot);
  } else if (chip) {
    row.appendChild(chip);
  }

  paintHeadline(value, metric, target, pending);
  fitHeadlineToLayout(value, row);
  return row;
}

/**
 * Size the headline to the space it has, in the modes where it is the point of
 * the view.
 *
 * Only Micro and Compact scale: at Standard and above the headline sits above a
 * chart and a fixed display size keeps the tab readable.
 *
 * The fit is re-run whenever the row changes size, not just once at render. The
 * box shrinks and grows for reasons the render does not see, such as a coverage
 * note appearing or the connect prompt being dismissed, and a one-shot fit
 * would leave the number at a size that no longer matches its space.
 */
function fitHeadlineToLayout(value: HTMLElement, row: HTMLElement): void {
  const mode = state.layout.mode;
  if (mode !== 'micro' && mode !== 'compact') {
    value.style.removeProperty('font-size');
    return;
  }

  // The ceiling is generous because the fit is bounded by the box anyway; it
  // only exists so a very tall window does not render the number at a size that
  // stops reading as a value and starts reading as a graphic.
  const limits =
    mode === 'micro'
      ? { min: 14, max: 120, fill: 0.94 }
      : { min: 18, max: 120, fill: 0.92 };

  const apply = () => {
    if (!row.isConnected) return;
    // A stacked chip sits inside the row, so the number must leave its
    // measured height plus the gap, or the fit would size the number over the
    // chip. The reserved height comes from the slot, which is always present,
    // so the number does not resize when a chip expires.
    const chip = row.querySelector<HTMLElement>('.metric-increase-slot');
    const reserveHeight = chip ? chip.offsetHeight + STACKED_CHIP_GAP : 0;
    fitHeadline(value, row, { ...limits, reserveHeight });
  };

  // The row is not laid out until it is attached, so defer one frame.
  requestAnimationFrame(apply);

  const observer = new ResizeObserver(apply);
  observer.observe(row);
  // The observer outlives the row once the view is rebuilt, so drop it then.
  const disconnect = () => {
    if (row.isConnected) return;
    observer.disconnect();
    window.clearInterval(timer);
  };
  const timer = window.setInterval(disconnect, 2000);
}

/**
 * Paint the headline, rolling from the value it last showed.
 *
 * A refresh that lands mid-roll retargets the animation from the value it was
 * already heading to, so the digits keep moving forward instead of snapping
 * back to the previous snapshot's total.
 */
function paintHeadline(
  value: HTMLElement,
  metric: Metric,
  target: number | null,
  pending: boolean,
): void {
  // The headline uses the display budget, matching the interval cells above it.
  const format = (v: number) => formatMetricValue(metric, v);
  const previous = state.displayed[metric];

  if (pending || target === null) {
    value.textContent = DASH;
    state.displayed[metric] = null;
    return;
  }

  state.displayed[metric] = target;
  if (previous === null || previous === target) {
    value.textContent = format(target);
    return;
  }
  animateHeadline(value, previous, target, format, HEADLINE_ANIM_MS);
}

/**
 * The `↑ $0.08` chip, or null when nothing has risen recently.
 *
 * A rise fades out after a few seconds rather than disappearing, so the eye can
 * finish reading it, and it is removed from state once faded so a later render
 * cannot bring a stale number back.
 */
function renderIncreaseChip(metric: Metric): HTMLElement | null {
  const increase = state.increases[metric];
  if (!increase) return null;

  const age = Date.now() - increase.at;
  if (age >= INCREASE_TTL_MS) {
    state.increases[metric] = null;
    return null;
  }

  const amount = formatMetricValue(metric, increase.amount);
  // A rise with no new requests means the rolling window slid rather than new
  // usage arriving, so there is no count worth stating.
  const requests =
    increase.requests === null || increase.requests === 0
      ? null
      : `${formatCount(increase.requests)} request${increase.requests === 1 ? '' : 's'}`;

  const chip = el('div', {
    class: 'metric-increase',
    'aria-label': `Last increase ${amount}${requests ? `, ${requests}` : ''}`,
    title: `Rose ${amount} since the previous refresh${requests ? `, ${requests} in this interval` : ''}`,
  });
  chip.appendChild(el('span', { class: 'metric-increase-value', text: `\u2191 ${amount}` }));
  if (requests) chip.appendChild(el('span', { class: 'metric-increase-sub', text: requests }));

  // A new rise inverts the chip for a moment so a delta the eye has not seen
  // before announces itself. It is a flash on the chip only: the digits roll,
  // the annotation inverts, and the number never recolours mid-roll.
  if (age < INCREASE_FLASH_MS && motionAllowed()) {
    chip.classList.add('is-new');
    window.setTimeout(() => chip.classList.remove('is-new'), INCREASE_FLASH_MS - age);
  }

  // A render that lands mid-fade rebuilds the chip, so it resumes at the
  // opacity the old one had reached instead of flashing back to full.
  const fadeAt = INCREASE_TTL_MS - INCREASE_FADE_MS;
  const fade = () => {
    chip.style.opacity = '0';
  };
  if (age > fadeAt) {
    chip.style.opacity = String(Math.max(0, 1 - (age - fadeAt) / INCREASE_FADE_MS));
    requestAnimationFrame(fade);
  } else {
    window.setTimeout(fade, fadeAt - age);
  }
  window.setTimeout(() => expireIncrease(metric, increase.at, chip), INCREASE_TTL_MS - age);

  return chip;
}

/** The range a chart opens on. 24h is the most useful default. */
function defaultChartScale(_snapshot: Snapshot | null): ChartScale {
  return '24h';
}

/** Explain where the Today figure came from, so a live number is not mistaken for a reported one. */
function todaySpendTitle(snapshot: Snapshot): string {
  const counter = snapshot.counter_today;
  if (counter?.spend_micro !== null && counter?.spend_micro !== undefined) {
    if (counter.exact) {
      return `Live from the account usage counter, measured since midnight (${formatAgeSince(counter.as_of ?? '')}).`;
    }
    if (!counter.spend_micro) {
      return `The account usage counter has not moved since ${formatClock(counter.baseline_at ?? '')}. Spend will appear here as soon as it does.`;
    }
    return `Live from the account usage counter, measured since ${formatClock(counter.baseline_at ?? '')} because the widget was not running at midnight.`;
  }
  if (snapshot.today_source) {
    return `Reported by OpenRouter for the current day (${formatAgeSince(snapshot.today_source.as_of)})`;
  }
  return formatSpend(snapshot.today.spend_micro);
}

/**
 * One note explaining what the source can and cannot report. Two separate notes
 * said the same thing and cost the chart its height in Standard mode.
 */
function sourceCoverageNote(snapshot: Snapshot): HTMLElement | null {
  const cells = snapshot.windows;
  const dailyOnly =
    cells.length > 0 &&
    cells.every((c) => c.coverage === 'unavailable') &&
    cells[0]?.partial_reason === 'source_granularity';

  const latest = snapshot.coverage.latest_source_date;
  let lagDays = 0;
  let latestLabel = '';
  if (latest) {
    const latestDay = new Date(latest);
    const today = new Date();
    const sameDay =
      latestDay.getFullYear() === today.getFullYear() &&
      latestDay.getMonth() === today.getMonth() &&
      latestDay.getDate() === today.getDate();
    if (!sameDay) {
      lagDays = Math.max(
        1,
        Math.round((today.getTime() - latestDay.getTime()) / (24 * 60 * 60 * 1000)),
      );
      latestLabel = latestDay.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  }

  if (!dailyOnly && lagDays === 0) return null;

  const parts: string[] = [];
  if (dailyOnly) parts.push('OpenRouter reports daily totals only, so the short windows cannot be computed.');
  if (lagDays > 0) {
    parts.push(`Daily report stops at ${latestLabel}, ${lagDays} day${lagDays === 1 ? '' : 's'} ago.`);
  }
  if (snapshot.counter_today?.spend_micro) {
    parts.push('Today is live from the account counter; charts cover reported days only.');
  }

  const note = el('div', { class: 'lag-note' });
  note.appendChild(el('span', { text: parts.join(' ') }));
  return note;
}

/* ---------------------------- requests ---------------------------- */

/**
 * The Requests tab shows a breakdown of the same aggregates the charts use.
 *
 * The public API exposes no individual generations: `/analytics/query` returns
 * per-bucket aggregates, and the per-generation list on openrouter.ai is served
 * by an internal endpoint. Rather than label minute buckets as "requests", this
 * view groups the aggregates by model or key and says so.
 */
function renderRequests(): void {
  const snapshot = state.snapshot;
  const view = el('div', { class: 'view' });

  if (!snapshot) {
    view.appendChild(el('div', { class: 'empty', text: 'Loading\u2026' }));
    content.appendChild(view);
    return;
  }

  strip = buildStrip('tokens');
  view.appendChild(strip.root);

  const sourceNote = sourceCoverageNote(snapshot);
  if (sourceNote) view.appendChild(sourceNote);

  // The headline is the selected interval, exactly as on the Spending tab, so
  // the highlighted button, the number, and the chart all describe one period.
  const interval = selectedInterval(snapshot);
  const metrics = el('div', { class: 'metrics' });
  const block = el('div', { class: 'metric' });
  const tokenValue = el('div', {
    class: `metric-value tokens${interval.cell?.coverage === 'unavailable' ? ' pending' : ''}`,
    title:
      interval.total_tokens === null
        ? 'Not available for this interval'
        : formatTokensExact(interval.total_tokens),
  });
  block.appendChild(
    renderHeadlineRow(
      tokenValue,
      'tokens',
      interval.total_tokens,
      interval.cell?.coverage === 'unavailable',
    ),
  );
  if (interval.warning) {
    block.appendChild(el('div', { class: 'metric-sub', text: interval.warning }));
  }
  metrics.appendChild(block);
  view.appendChild(metrics);

  // The same inline chart as the Spending tab, in token units.
  if (state.layout.showChart) {
    view.appendChild(renderInlineChart('tokens'));
  }

  content.appendChild(view);
}

/**
 * The Models tab: the same aggregates the charts use, grouped by model. The
 * public API exposes no individual generations, so this is the finest
 * breakdown available.
 */
function renderModels(): void {
  const snapshot = state.snapshot;
  const view = el('div', { class: 'view' });

  if (!snapshot) {
    view.appendChild(el('div', { class: 'empty', text: 'Loading\u2026' }));
    content.appendChild(view);
    return;
  }

  strip = buildStrip('tokens');
  view.appendChild(strip.root);

  const sourceNote = sourceCoverageNote(snapshot);
  if (sourceNote) view.appendChild(sourceNote);

  const breakdown = state.breakdown;
  if (!breakdown || breakdown.rows.length === 0) {
    const empty = el('div', { class: 'empty' });
    empty.appendChild(el('div', { class: 'empty-title', text: 'No usage in this window' }));
    empty.appendChild(
      el('div', {
        text: breakdown?.incomplete
          ? 'No single reporting granularity covers this window yet. Usage appears once the collector has fetched a full range.'
          : 'Nothing was reported for the selected window and scope.',
      }),
    );
    view.appendChild(empty);
    content.appendChild(view);
    return;
  }

  const list = renderBreakdownList(breakdown.rows, 'model');
  view.appendChild(list);

  const note = el('div', { class: 'lag-note' });
  note.appendChild(
    el('span', {
      text: 'OpenRouter reports aggregates, not individual generations, so these rows group the same buckets the charts use.',
    }),
  );
  view.appendChild(note);

  content.appendChild(view);
}

/**
 * Rows for the Models and Keys tabs.
 *
 * Both tabs use one layout so they read as the same kind of table: a label, a
 * secondary detail line, then the token and spend totals for the interval. The
 * column header states the interval, because the numbers are meaningless
 * without it.
 */
function renderBreakdownList(rows: BreakdownRow[], kind: 'model' | 'key'): HTMLElement {
  const wrap = el('div', { class: 'breakdown' });

  const header = el('div', { class: 'breakdown-head' });
  header.appendChild(
    el('span', { class: 'bh-label', text: kind === 'model' ? 'Model' : 'Key' }),
  );
  header.appendChild(el('span', { class: 'bh-tokens', text: 'Tokens' }));
  header.appendChild(el('span', { class: 'bh-cost', text: 'Spend' }));
  wrap.appendChild(header);

  const list = el('div', { class: 'list', role: 'list' });

  if (rows.length === 0) {
    const empty = el('div', { class: 'empty' });
    empty.appendChild(el('div', { class: 'empty-title', text: 'No usage in this interval' }));
    empty.appendChild(
      el('div', {
        text: 'Nothing was reported for the selected interval and scope. Pick a longer interval, or wait for the collector to fetch a full range.',
      }),
    );
    list.appendChild(empty);
  }

  for (const row of rows) {
    // A row with no buckets is a known key that reported nothing in the
    // interval, which reads differently from a key that spent zero.
    const detail =
      row.bucket_count === 0
        ? 'no usage in this interval'
        : `${formatCount(row.bucket_count)} bucket${row.bucket_count === 1 ? '' : 's'}`;
    const item = el('div', {
      class: 'row row-breakdown',
      role: 'listitem',
      title: `${row.label} \u00b7 ${detail}`,
      'data-idle': String(row.bucket_count === 0),
    });
    const main = el('div', { class: 'r-main' });
    main.appendChild(el('span', { class: 'r-model', text: row.label }));
    main.appendChild(el('span', { class: 'r-key', text: detail }));
    item.appendChild(main);
    item.appendChild(
      el('span', {
        class: 'r-tokens',
        text: row.total_tokens === null ? DASH : formatMetricValue('tokens', row.total_tokens),
      }),
    );
    item.appendChild(
      el('span', {
        class: 'r-cost',
        text: row.spend_micro === null ? DASH : formatSpend(row.spend_micro),
      }),
    );
    list.appendChild(item);
  }

  wrap.appendChild(list);
  return wrap;
}

/* ------------------------------- log ------------------------------ */

function renderLogPanel(): HTMLElement {
  const view = el('div', { class: 'log-panel' });
  const layout = state.layout;

  const filters = el('div', { class: 'log-filters' });

  if (layout.collapsedFilters) {
    const button = el('button', {
      class: 'filter-btn',
      type: 'button',
      text: `Filters (${state.logQuery.severities.join(', ') || 'all'})`,
    });
    button.addEventListener('click', () => {
      state.logQuery = { ...state.logQuery, severities: ['error', 'warn', 'info', 'debug'] };
      void loadLogs().then(() => render());
    });
    filters.appendChild(button);
  } else {
    for (const severity of ['error', 'warn', 'info', 'debug'] as Severity[]) {
      const active = state.logQuery.severities.includes(severity);
      const button = el('button', {
        class: 'filter-btn',
        type: 'button',
        'aria-pressed': String(active),
        text: severity,
      });
      button.addEventListener('click', () => {
        const set = new Set(state.logQuery.severities);
        if (set.has(severity)) set.delete(severity);
        else set.add(severity);
        state.logQuery = { ...state.logQuery, severities: [...set] };
        void loadLogs().then(() => render());
      });
      filters.appendChild(button);
    }

    const search = el('input', {
      class: 'search-input',
      type: 'text',
      placeholder: 'Search\u2026',
      'aria-label': 'Search log messages',
      value: state.logQuery.text,
    });
    search.addEventListener(
      'input',
      debounce(() => {
        state.logQuery = { ...state.logQuery, text: search.value };
        void loadLogs().then(() => render());
      }, 200),
    );
    filters.appendChild(search);
  }

  const tail = el('button', {
    class: 'filter-btn',
    type: 'button',
    'aria-pressed': String(state.logLiveTail),
    text: state.logLiveTail ? 'Live' : 'Paused',
    title: 'Toggle live tail',
  });
  tail.addEventListener('click', () => {
    state.logLiveTail = !state.logLiveTail;
    render();
  });
  filters.appendChild(tail);

  view.appendChild(filters);

  const list = el('div', { class: 'list', role: 'log' });
  if (state.logs.length === 0) {
    const empty = el('div', { class: 'empty' });
    empty.appendChild(el('div', { text: 'No events match the current filter' }));
    const reset = el('button', { class: 'btn', type: 'button', text: 'Reset filter' });
    reset.addEventListener('click', () => {
      state.logQuery = { severities: ['error', 'warn'], sources: [], text: '', range: 'all', limit: 500 };
      void loadLogs().then(() => render());
    });
    empty.appendChild(reset);
    list.appendChild(empty);
  }

  for (const entry of state.logs) {
    const expanded = state.logExpanded === entry.seq;
    const row = el('div', {
      class: 'log-row',
      role: 'listitem',
      tabindex: '0',
      'data-severity': entry.severity,
      'aria-expanded': String(expanded),
    });
    row.appendChild(el('span', { class: 'log-time', text: formatClock(entry.timestamp, { seconds: true }) }));
    row.appendChild(el('span', { class: 'log-sev', 'data-severity': entry.severity, text: entry.severity }));
    row.appendChild(el('span', { class: 'log-source', text: entry.source }));
    row.appendChild(el('span', { class: 'log-msg', text: entry.message, title: entry.message }));

    if (expanded) {
      const detail = el('div', { class: 'log-detail' });
      detail.appendChild(el('div', { text: entry.message }));
      if (entry.code) {
        const codeLine = el('div');
        codeLine.append('Code: ');
        codeLine.appendChild(el('code', { text: entry.code }));
        detail.appendChild(codeLine);
      }
      if (entry.correlation_id) {
        const corr = el('div');
        corr.append('Correlation: ');
        corr.appendChild(el('code', { text: entry.correlation_id }));
        detail.appendChild(corr);
      }
      detail.appendChild(el('div', { text: `Timestamp: ${entry.timestamp}` }));
      if (entry.redacted) detail.appendChild(el('div', { text: 'Contains redacted content' }));
      row.appendChild(detail);
    }

    row.addEventListener('click', () => {
      state.logExpanded = expanded ? null : entry.seq;
      render();
    });
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        state.logExpanded = expanded ? null : entry.seq;
        render();
      }
    });
    list.appendChild(row);
  }

  view.appendChild(list);

  const actions = el('div', { class: 'btn-row' });
  const openFolder = el('button', { class: 'btn', type: 'button', text: 'Open log folder' });
  openFolder.addEventListener('click', () => void api.logs.openFolder());
  const clearView = el('button', { class: 'btn', type: 'button', text: 'Clear view' });
  clearView.addEventListener('click', async () => {
    await api.logs.clearView();
    state.logs = [];
    render();
  });
  actions.append(openFolder, clearView);
  view.appendChild(actions);

  return view;
}

/* ------------------------------- api ------------------------------ */

/**
 * Keys are a known set, so the table lists every key rather than only the ones
 * that happened to report usage in the interval.
 *
 * The breakdown is built from usage rows, which means a key that spent nothing
 * in the window has no row and would silently disappear from a table that is
 * meant to describe the account. Known keys with no row are added with a null
 * spend, rendered as a dash so "no usage" is never confused with "zero spend".
 */
function mergeKeysIntoRows(
  rows: BreakdownRow[],
  keys: ReadonlyArray<{ id: string; name: string; removed: boolean }>,
): BreakdownRow[] {
  const seen = new Set(rows.map((row) => row.id));
  const extra: BreakdownRow[] = [];
  for (const key of keys) {
    const id = `key:${key.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    extra.push({
      id,
      label: key.removed ? `${key.name} (removed)` : key.name,
      spend_micro: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      bucket_count: 0,
      latest: null,
    });
  }
  // Rows with usage stay in spend order; the no-usage keys follow, by name.
  extra.sort((a, b) => a.label.localeCompare(b.label));
  return [...rows, ...extra];
}

/**
 * The Keys tab: the same table as Models, grouped by API key.
 *
 * It is a report, not a picker. The scope control that used to live here moved
 * to Settings, so reading per-key usage and changing scope are separate jobs.
 */
function renderApi(): void {
  const view = el('div', { class: 'view' });
  const snapshot = state.snapshot;

  if (!snapshot) {
    view.appendChild(el('div', { class: 'empty', text: 'Loading\u2026' }));
    content.appendChild(view);
    return;
  }

  strip = buildStrip('spend');
  view.appendChild(strip.root);

  const sourceNote = sourceCoverageNote(snapshot);
  if (sourceNote) view.appendChild(sourceNote);

  const breakdown = state.breakdownByKey;
  if (!breakdown) {
    view.appendChild(el('div', { class: 'empty', text: 'Loading\u2026' }));
    content.appendChild(view);
    return;
  }

  view.appendChild(renderBreakdownList(mergeKeysIntoRows(breakdown.rows, state.keys), 'key'));

  const note = el('div', { class: 'lag-note' });
  note.appendChild(
    el('span', {
      text: 'Grouped from the same reporting buckets as the charts. To restrict every tab to one key, change the scope in Settings.',
    }),
  );
  view.appendChild(note);

  content.appendChild(view);
}

function renderScopeRow(
  scope: Scope,
  name: string,
  spend: string,
  selected: boolean,
  key: (KeyRecord & { tokens_24h: number }) | null,
): HTMLElement {
  const row = el('div', {
    class: 'scope-row',
    role: 'radio',
    tabindex: '0',
    'aria-selected': String(selected),
    'aria-checked': String(selected),
  });
  row.appendChild(el('span', { class: 'scope-radio', 'aria-hidden': 'true' }));

  const nameEl = el('span', { class: 'scope-name', text: name });
  if (key?.removed) {
    nameEl.appendChild(el('span', { class: 'removed-tag', text: 'removed' }));
  }
  row.appendChild(nameEl);
  row.appendChild(el('span', { class: 'scope-tokens', text: key ? `${formatTokensCompact(key.tokens_24h)}` : '' }));
  row.appendChild(el('span', { class: 'scope-spend', text: spend }));

  const select = async () => {
    const result = await api.settings.set({ view: { scope } });
    state.settings = result.settings;
    await Promise.all([loadBreakdown(), loadKeys()]);
    const snapshot = await api.snapshot.get();
    state.snapshot = snapshot;
    render();
  };

  row.addEventListener('click', () => void select());
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void select();
    }
  });

  return row;
}

/** One-line summary of the active scope, for the collapsed Settings group. */
function scopeSummary(): string {
  const scope = state.settings?.view.scope ?? { kind: 'all' };
  return scope.kind === 'all' ? 'All keys' : scope.name;
}

/**
 * The scope control, now that the Keys tab is a report rather than a picker.
 * Selecting a key restricts every tab; selecting All keys clears it.
 */
function renderScopeGroup(): HTMLElement {
  const wrap = el('div');
  wrap.appendChild(
    el('div', {
      class: 'field-hint',
      text: 'Restrict every tab to one API key, or show the whole account.',
    }),
  );

  const list = el('div', { class: 'scope-list', role: 'radiogroup', 'aria-label': 'API key scope' });
  const current = state.settings?.view.scope ?? { kind: 'all' };

  list.appendChild(
    renderScopeRow({ kind: 'all' }, 'All keys', '', current.kind === 'all', null),
  );
  for (const key of state.keys) {
    list.appendChild(
      renderScopeRow(
        { kind: 'key', id: key.id, name: key.name },
        key.name,
        '',
        current.kind === 'key' && current.id === key.id,
        key,
      ),
    );
  }

  wrap.appendChild(list);
  return wrap;
}

/* ----------------------------- settings --------------------------- */

function renderSettings(): void {
  const view = el('div', { class: 'view scroll' });
  const settings = state.settings;
  if (!settings) {
    view.appendChild(el('div', { class: 'empty', text: 'Loading\u2026' }));
    content.appendChild(view);
    return;
  }

  if (state.notice) {
    const note = el('div', {
      class: state.notice.kind === 'error' ? 'error-note' : 'warn-note',
      text: state.notice.text,
    });
    view.appendChild(note);
  }

  view.appendChild(
    settingsGroup('parameters', 'Parameters', `${settings.parameters.refresh_sec}s refresh`, () =>
      renderParameters(settings),
    ),
  );
  view.appendChild(
    settingsGroup('display', 'Display', `${settings.display.theme} \u00b7 ${settings.display.opacity}%`, () =>
      renderDisplay(settings),
    ),
  );
  view.appendChild(
    settingsGroup('api-key', 'API key', state.credential?.state ?? 'unknown', () => renderApiKey()),
  );
  view.appendChild(
    settingsGroup('version', 'Version', state.version ? `v${state.version.widget}` : '\u2013', () =>
      renderVersion(),
    ),
  );
  view.appendChild(settingsGroup('support', 'Support', 'Diagnostics and links', () => renderSupport()));
  view.appendChild(
    settingsGroup('diagnostics', 'Diagnostics', 'Health and storage', () => renderDiagnostics()),
  );
  view.appendChild(
    settingsGroup('scope', 'Scope', scopeSummary(), () => renderScopeGroup()),
  );
  view.appendChild(
    settingsGroup('log', 'Log', `${state.logs.length} entries`, () => renderLogPanel()),
  );

  content.appendChild(view);

  // Track the offset as it changes, so a rebuild triggered from anywhere (a
  // settings patch, the log tail arriving) resumes at the reader's position and
  // not at whatever the last group-header click happened to record.
  view.addEventListener('scroll', () => {
    if (state.tab === 'settings') state.settingsScroll = view.scrollTop;
  }, { passive: true });

  // The pane is rebuilt from scratch on every settings change, which resets its
  // scroll offset. Put it back where it was so expanding a group does not throw
  // the reader to the top of a long list.
  restoreSettingsScroll(view);
}

/**
 * Remember where the Settings pane is scrolled to.
 *
 * Called before a rebuild, because the element that holds the offset is
 * replaced by the render.
 */
function rememberSettingsScroll(): void {
  if (state.tab !== 'settings') return;
  const pane = content.querySelector<HTMLElement>('.view.scroll');
  if (pane) state.settingsScroll = pane.scrollTop;
}

/** Apply the remembered offset once the rebuilt pane is in the document. */
function restoreSettingsScroll(view: HTMLElement): void {
  const target = Math.max(0, state.settingsScroll);
  if (target === 0) return;
  const apply = () => {
    if (!view.isConnected) return;
    view.scrollTop = Math.min(target, view.scrollHeight - view.clientHeight);
  };
  // The scroll height is only known after layout, so defer one frame.
  requestAnimationFrame(apply);
}

function settingsGroup(
  id: string,
  title: string,
  summary: string,
  bodyFactory: () => HTMLElement,
): HTMLElement {
  const expanded = state.expandedGroups.has(id);
  const group = el('div', { class: 'settings-group' });

  const header = el('button', {
    class: 'group-header',
    type: 'button',
    'aria-expanded': String(expanded),
    'aria-controls': `group-${id}`,
  });
  header.appendChild(icon(ICONS.chevron, '0 0 16 16'));
  header.querySelector('svg')?.classList.add('group-chevron');
  header.appendChild(el('span', { class: 'group-title', text: title }));
  header.appendChild(el('span', { class: 'group-summary', text: summary, title: summary }));

  header.addEventListener('click', () => {
    if (state.expandedGroups.has(id)) state.expandedGroups.delete(id);
    else state.expandedGroups.add(id);
    // The click may come from a re-render that replaced the element, so the
    // scroll position of the settings pane is captured now rather than after
    // the rebuild, when the old element is already gone.
    rememberSettingsScroll();
    render();
  });

  group.appendChild(header);

  if (expanded) {
    const body = el('div', { class: 'group-body', id: `group-${id}` });
    body.appendChild(bodyFactory());
    group.appendChild(body);
  }

  return group;
}

/**
 * One settings row: label on the left, control on the right.
 *
 * The label carries a hover popup with a verbose explanation. A native `title`
 * tooltip truncates long text and cannot wrap, so the popup is a real element
 * positioned inside the widget window.
 */
function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = el('div', { class: 'field' });
  const left = el('div', { class: 'field-label', text: label });
  // A label may carry a live value (Opacity 100%), so help is looked up by the
  // words before the number rather than by the rendered string.
  const help = hint ?? helpFor(label) ?? helpFor(label.replace(/\s+\d+%?$/, ''));
  if (help) {
    left.classList.add('has-help');
    left.tabIndex = 0;
    left.setAttribute('aria-describedby', `help-${label.replace(/\W+/g, '-').toLowerCase()}`);
  }
  wrap.appendChild(left);
  const right = el('div', { class: 'field-control' });
  right.appendChild(control);
  wrap.appendChild(right);
  // The popup hangs off the row, not the label: the label clips its overflow
  // to keep long names on one line, which would cut the popup off.
  if (help) attachHelpPopup(wrap, left, help);
  return wrap;
}

/**
 * Show a wrapped explanation next to an element on hover or keyboard focus.
 *
 * The popup is appended to the field so it scrolls with the settings list, and
 * it flips above the label when there is not enough room below.
 */
function attachHelpPopup(row: HTMLElement, anchor: HTMLElement, text: string): void {
  const popup = el('div', { class: 'help-popup', role: 'tooltip', text });
  popup.hidden = true;
  // The settings list scrolls and clips its children, so the popup lives on the
  // body and is positioned against the viewport instead of the row.
  document.body.appendChild(popup);

  const show = () => {
    popup.hidden = false;
    const rowRect = row.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    const margin = 8;
    const fitsBelow = rowRect.bottom + 4 + popupRect.height < window.innerHeight - margin;
    const top = fitsBelow ? rowRect.bottom + 4 : rowRect.top - popupRect.height - 4;
    popup.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - popupRect.height - margin))}px`;
    popup.style.left = `${Math.max(margin, Math.min(rowRect.left, window.innerWidth - popupRect.width - margin))}px`;
  };
  const hide = () => {
    popup.hidden = true;
  };

  anchor.addEventListener('mouseenter', show);
  anchor.addEventListener('mouseleave', hide);
  anchor.addEventListener('focus', show);
  anchor.addEventListener('blur', hide);
}

function selectControl<T extends string | number>(
  value: T,
  options: ReadonlyArray<{ value: T; label: string }>,
  onChange: (value: T) => void,
): HTMLSelectElement {
  const select = el('select', { 'aria-label': 'Setting value' });
  for (const option of options) {
    const opt = el('option', { value: String(option.value), text: option.label });
    if (String(option.value) === String(value)) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    const raw = select.value;
    const match = options.find((o) => String(o.value) === raw);
    if (match) onChange(match.value);
  });
  return select;
}

function toggleControl(checked: boolean, onChange: (value: boolean) => void): HTMLButtonElement {
  const button = el('button', {
    class: 'toggle',
    type: 'button',
    role: 'switch',
    'aria-checked': String(checked),
    'aria-label': 'Toggle',
  });
  button.addEventListener('click', () => {
    const next = button.getAttribute('aria-checked') !== 'true';
    button.setAttribute('aria-checked', String(next));
    onChange(next);
  });
  return button;
}

async function patchSettings(patch: unknown): Promise<void> {
  const result = await api.settings.set(patch);
  state.settings = result.settings;
  if (result.rejected.length > 0) {
    state.notice = {
      kind: 'warn',
      text: `Rejected: ${result.rejected.map((r) => `${r.group}.${r.key} (${r.reason})`).join(', ')}`,
    };
  } else {
    state.notice = null;
  }
  applyTheme();
  applyLayout();
  render();
}

function renderParameters(settings: Settings): HTMLElement {
  const wrap = el('div');
  wrap.appendChild(
    field(
      'Refresh interval',
      selectControl(
        settings.parameters.refresh_sec,
        [
          { value: 5, label: '5 s' },
          { value: 10, label: '10 s' },
          { value: 30, label: '30 s' },
          { value: 60, label: '60 s' },
        ],
        (value) => void patchSettings({ parameters: { refresh_sec: value } }),
      ),
    ),
  );
  wrap.appendChild(
    field(
      'Chart refresh',
      selectControl(
        settings.parameters.chart_refresh_sec,
        [
          { value: 30, label: '30 s' },
          { value: 60, label: '60 s' },
          { value: 300, label: '300 s' },
        ],
        (value) => void patchSettings({ parameters: { chart_refresh_sec: value } }),
      ),
    ),
  );
  wrap.appendChild(
    field(
      'Pause when hidden',
      toggleControl(settings.parameters.pause_when_hidden, (value) =>
        void patchSettings({ parameters: { pause_when_hidden: value } }),
      ),
    ),
  );
  wrap.appendChild(
    field(
      'Raw retention',
      selectControl(
        settings.parameters.raw_retention_days,
        [
          { value: 30, label: '30 days' },
          { value: 90, label: '90 days' },
          { value: 180, label: '180 days' },
          { value: 365, label: '365 days' },
        ],
        (value) => void patchSettings({ parameters: { raw_retention_days: value } }),
      ),
    ),
  );
  wrap.appendChild(
    field(
      'Aggregate retention',
      selectControl(
        settings.parameters.agg_retention_months,
        [
          { value: 12, label: '12 months' },
          { value: 24, label: '24 months' },
        ],
        (value) => void patchSettings({ parameters: { agg_retention_months: value } }),
      ),
    ),
  );
  wrap.appendChild(
    field(
      'Week start',
      selectControl(
        settings.parameters.week_start,
        [
          { value: 'monday', label: 'Monday' },
          { value: 'sunday', label: 'Sunday' },
        ],
        (value) => void patchSettings({ parameters: { week_start: value } }),
      ),
    ),
  );
  wrap.appendChild(
    field(
      'Hour format',
      selectControl(
        settings.parameters.hour_format,
        [
          { value: '24', label: '24 hour' },
          { value: '12', label: '12 hour' },
        ],
        (value) => void patchSettings({ parameters: { hour_format: value } }),
      ),
    ),
  );
  wrap.appendChild(field('Currency', el('span', { class: 'dim', text: 'USD (read-only)' })));

  const reset = el('button', { class: 'btn danger', type: 'button', text: 'Reset parameters' });
  reset.addEventListener('click', async () => {
    if (!confirm('Reset all parameters to defaults? This affects only the Parameters group.')) return;
    state.settings = await api.settings.reset('parameters');
    render();
  });
  wrap.appendChild(reset);

  return wrap;
}

function renderDisplay(settings: Settings): HTMLElement {
  const wrap = el('div');
  wrap.appendChild(
    field(
      'Theme',
      selectControl(
        settings.display.theme,
        [
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
          { value: 'system', label: 'Follow system' },
        ],
        (value) => void patchSettings({ display: { theme: value } }),
      ),
    ),
  );
  wrap.appendChild(
    field(
      'Density',
      selectControl(
        settings.display.density,
        [
          { value: 'comfortable', label: 'Comfortable' },
          { value: 'compact', label: 'Compact' },
        ],
        (value) => void patchSettings({ display: { density: value } }),
      ),
    ),
  );

  const opacity = el('input', {
    type: 'range',
    min: '40',
    max: '100',
    step: '5',
    value: String(settings.display.opacity),
    'aria-label': 'Opacity',
  });
  opacity.addEventListener('change', () =>
    void patchSettings({ display: { opacity: Number(opacity.value) } }),
  );
  wrap.appendChild(field(`Opacity ${settings.display.opacity}%`, opacity));

  wrap.appendChild(
    field(
      'Always on top',
      selectControl(
        settings.display.always_on_top,
        [
          { value: 'normal', label: 'Normal' },
          { value: 'stronger', label: 'Stronger' },
          { value: 'off', label: 'Off' },
        ],
        (value) => void patchSettings({ display: { always_on_top: value } }),
      ),
    ),
  );
  if (settings.display.always_on_top === 'stronger') {
    wrap.appendChild(
      el('div', {
        class: 'warn-note',
        text: 'The stronger level can cover full-screen apps and presentations.',
      }),
    );
  }

  wrap.appendChild(
    field(
      'Ghost mode',
      toggleControl(settings.display.ghost, (value) => void patchSettings({ display: { ghost: value } })),
    ),
  );
  wrap.appendChild(
    field(
      'Locked mode',
      toggleControl(settings.display.locked, (value) => void patchSettings({ display: { locked: value } })),
    ),
  );
  wrap.appendChild(
    field(
      'Keep inside work area',
      toggleControl(settings.display.keep_in_work_area, (value) =>
        void patchSettings({ display: { keep_in_work_area: value } }),
      ),
    ),
  );
  wrap.appendChild(
    field(
      'Snap to edges',
      toggleControl(settings.display.snap_to_edges, (value) =>
        void patchSettings({ display: { snap_to_edges: value } }),
      ),
    ),
  );
  wrap.appendChild(
    field(
      'Launch at login',
      toggleControl(settings.display.launch_at_login, (value) =>
        void patchSettings({ display: { launch_at_login: value } }),
      ),
    ),
  );
  wrap.appendChild(
    field(
      'Default tab',
      selectControl(
        settings.display.default_tab,
        TABS.map((t) => ({ value: t, label: TAB_LABELS[t] ?? t })),
        (value) => void patchSettings({ display: { default_tab: value } }),
      ),
    ),
  );
  wrap.appendChild(
    field(
      'Animations',
      selectControl(
        settings.display.animations,
        [
          { value: 'on', label: 'On' },
          { value: 'reduced', label: 'Reduced' },
          { value: 'off', label: 'Off' },
        ],
        (value) => void patchSettings({ display: { animations: value } }),
      ),
    ),
  );
  const preview = el('div', { class: 'kv' });
  // The preview shows the same formatter the strip and headline use, so it
  // cannot drift from what the widget actually displays.
  preview.appendChild(el('dt', { text: 'Spend preview' }));
  preview.appendChild(
    el('dd', {
      text: `${formatMetricValue('spend', 64800)} \u00b7 ${formatMetricValue('spend', 1234567)}`,
    }),
  );
  preview.appendChild(el('dt', { text: 'Token preview' }));
  preview.appendChild(
    el('dd', {
      text: `${formatMetricValue('tokens', 148200)} \u00b7 ${formatMetricValue('tokens', 1240000)}`,
    }),
  );
  wrap.appendChild(preview);

  const resetSize = el('button', { class: 'btn', type: 'button', text: 'Reset size to 320 \u00d7 240' });
  resetSize.addEventListener('click', async () => {
    await api.window.resetSize();
    await refreshLayout();
  });
  wrap.appendChild(resetSize);

  return wrap;
}

function renderApiKey(): HTMLElement {
  const wrap = el('div');
  const credential = state.credential;
  const connected = credential?.has_credential ?? false;

  const pill = el('span', {
    class: 'state-pill',
    'data-state': credential?.state ?? 'not_connected',
    text: (credential?.state ?? 'not_connected').replace(/_/g, ' '),
  });
  wrap.appendChild(field('State', pill));

  if (connected) {
    const dl = el('dl', { class: 'kv' });
    dl.appendChild(el('dt', { text: 'Label' }));
    // OpenRouter returns the masked key itself as the label for a management
    // key. Show a readable name instead of echoing something key-shaped.
    const label = credential?.label;
    const friendly = label && /^sk-/i.test(label) ? 'Management key' : (label ?? 'Unknown');
    dl.appendChild(el('dd', { text: friendly }));
    dl.appendChild(el('dt', { text: 'Identifier' }));
    dl.appendChild(el('dd', { text: credential?.last4 ? `\u2026${credential.last4}` : '\u2013' }));
    dl.appendChild(el('dt', { text: 'Saved' }));
    dl.appendChild(el('dd', { text: formatDateTime(credential?.saved_at) }));
    wrap.appendChild(dl);
  }

  if (!connected) {
    const instructions = el('ol', { class: 'instructions' });
    const steps = [
      'Sign in to the OpenRouter dashboard in a browser.',
      'Open the API keys page and create a key. A read-only or provisioning key is preferred where the account supports it.',
      'Copy the key once. OpenRouter does not show it again.',
      'Paste it into the field below and choose Connect.',
      'The widget stores the key in the operating system credential store, never in a file, and never sends it anywhere except to OpenRouter.',
      'If the connection test fails, check that the key is active, that it has not been revoked, and that the account has credit.',
    ];
    for (const step of steps) instructions.appendChild(el('li', { text: step }));
    wrap.appendChild(instructions);

    const link = el('button', { class: 'link-btn', type: 'button', text: 'Open the OpenRouter API keys page' });
    link.addEventListener('click', () => void api.app.openExternal('https://openrouter.ai/settings/keys'));
    wrap.appendChild(link);
  }

  const input = el('input', {
    type: 'password',
    class: 'key-input',
    placeholder: connected ? 'Enter a new key to replace' : 'Paste your OpenRouter key',
    'aria-label': 'OpenRouter API key',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  wrap.appendChild(input);

  const actions = el('div', { class: 'btn-row' });

  const connect = el('button', {
    class: 'btn primary',
    type: 'button',
    text: connected ? 'Replace' : 'Connect',
  });
  connect.addEventListener('click', async () => {
    const value = input.value.trim();
    if (!value) return;
    connect.disabled = true;
    connect.textContent = 'Verifying\u2026';
    const result = await api.credential.save(value);
    input.value = '';
    connect.disabled = false;
    connect.textContent = connected ? 'Replace' : 'Connect';

    if (result.ok) {
      state.credential = await api.credential.state();
      state.snapshot = await api.snapshot.get();
      state.notice = {
        kind: 'ok',
        text: result.persisted === false
          ? 'Connected for this session only: OS encryption is unavailable.'
          : 'Connected and verified.',
      };
      await Promise.all([loadBreakdown(), loadKeys()]);
    } else {
      state.notice = { kind: 'error', text: result.message ?? 'Connection failed.' };
    }
    render();
  });
  actions.appendChild(connect);

  if (connected) {
    const test = el('button', { class: 'btn', type: 'button', text: 'Test connection' });
    test.addEventListener('click', async () => {
      test.disabled = true;
      test.textContent = 'Testing\u2026';
      const result = await api.credential.test();
      test.disabled = false;
      test.textContent = 'Test connection';
      state.notice = result.ok
        ? { kind: 'ok', text: `Connection OK in ${result.latency_ms} ms.` }
        : { kind: 'error', text: `Test failed: ${result.error ?? 'unknown'}` };
      render();
    });
    actions.appendChild(test);

    const disconnect = el('button', { class: 'btn danger', type: 'button', text: 'Disconnect' });
    disconnect.addEventListener('click', async () => {
      const deleteHistory = confirm(
        'Disconnect the credential?\n\nOK keeps local history.\nCancel aborts.',
      );
      if (!deleteHistory) return;
      await api.credential.disconnect(false);
      state.credential = await api.credential.state();
      state.snapshot = await api.snapshot.get();
      state.notice = { kind: 'ok', text: 'Disconnected. Local history was kept.' };
      render();
    });
    actions.appendChild(disconnect);
  }

  wrap.appendChild(actions);

  if (credential && !credential.encryption_available) {
    wrap.appendChild(
      el('div', {
        class: 'warn-note',
        text: 'OS credential encryption is unavailable. The key is kept in memory for this session only and must be re-entered after a restart.',
      }),
    );
  }

  return wrap;
}

function renderVersion(): HTMLElement {
  const wrap = el('div');
  const version = state.version;
  if (!version) return el('div', { text: 'Unavailable' });

  const dl = el('dl', { class: 'kv' });
  const add = (label: string, value: string) => {
    dl.appendChild(el('dt', { text: label }));
    dl.appendChild(el('dd', { text: value }));
  };
  add('Widget', version.widget);
  add('Build', version.build);
  add('Commit', version.commit);
  add('Runtime', version.runtime);
  add('Engine', version.engine);
  add('SQLite', version.sqlite);
  add('Channel', version.channel);
  add('Schema', String(version.schema_version));
  add('Last migration', formatDateTime(version.last_migration));
  add('Update state', version.update_state);
  wrap.appendChild(dl);

  const actions = el('div', { class: 'btn-row' });
  const check = el('button', { class: 'btn', type: 'button', text: 'Check for updates' });
  check.addEventListener('click', async () => {
    check.disabled = true;
    const result = await api.app.checkForUpdates();
    check.disabled = false;
    state.notice = { kind: 'ok', text: `Update check: ${result.state}` };
    render();
  });
  actions.appendChild(check);
  wrap.appendChild(actions);

  return wrap;
}

function renderSupport(): HTMLElement {
  const wrap = el('div');
  const checklist = el('ul', { class: 'instructions' });
  for (const item of [
    'Confirm the account is connected in the API key group.',
    'Confirm the network is reachable.',
    'Check the Log tab for error entries.',
    'Confirm the system clock is correct.',
  ]) {
    checklist.appendChild(el('li', { text: item }));
  }
  wrap.appendChild(checklist);

  const actions = el('div', { class: 'btn-row' });
  const copy = el('button', { class: 'btn', type: 'button', text: 'Copy diagnostic summary' });
  copy.addEventListener('click', async () => {
    const result = await api.diagnostics.copy();
    state.notice = { kind: 'ok', text: `Copied ${result.bytes} bytes to the clipboard.` };
    render();
  });
  const save = el('button', { class: 'btn', type: 'button', text: 'Save bundle' });
  save.addEventListener('click', async () => {
    const result = await api.diagnostics.save();
    state.notice = result.saved
      ? { kind: 'ok', text: `Saved to ${result.path}` }
      : { kind: 'warn', text: 'Save cancelled.' };
    render();
  });
  actions.append(copy, save);
  wrap.appendChild(actions);

  wrap.appendChild(
    el('div', {
      class: 'field-hint',
      text: 'The bundle contains no credential and no request content. Support is best effort with no service level guarantee.',
    }),
  );

  return wrap;
}

function renderDiagnostics(): HTMLElement {
  const wrap = el('div');
  const snapshot = state.snapshot;
  const dl = el('dl', { class: 'kv' });
  const add = (label: string, value: string) => {
    dl.appendChild(el('dt', { text: label }));
    dl.appendChild(el('dd', { text: value, title: value }));
  };

  add('Account state', snapshot?.account.state ?? '\u2013');
  add('Last success', formatDateTime(snapshot?.collection_status.last_success));
  add('Last error', snapshot?.collection_status.last_error_code ?? 'none');
  add('Backoff', `${snapshot?.collection_status.backoff_ms ?? 0} ms`);
  add('Next retry', formatDateTime(snapshot?.collection_status.retry_at));
  add('Earliest record', formatDateTime(snapshot?.coverage.earliest_reliable));
  add('Request coverage', snapshot?.coverage.request_source ?? '\u2013');
  add('Window', `${state.layout.width} \u00d7 ${state.layout.height}`);
  add('Size class', `${state.layout.widthClass} / ${state.layout.heightClass}`);
  add('Layout mode', state.layout.mode);
  wrap.appendChild(dl);

  if (snapshot?.coverage.warnings.length) {
    for (const warning of snapshot.coverage.warnings) {
      wrap.appendChild(el('div', { class: 'warn-note', text: warning }));
    }
  }

  const actions = el('div', { class: 'btn-row' });

  const openLogs = el('button', { class: 'btn', type: 'button', text: 'Open log folder' });
  openLogs.addEventListener('click', () => void api.logs.openFolder());
  actions.appendChild(openLogs);

  const openDb = el('button', { class: 'btn', type: 'button', text: 'Open data folder' });
  openDb.addEventListener('click', () => void api.data.openDbFolder());
  actions.appendChild(openDb);

  const exportBtn = el('button', { class: 'btn', type: 'button', text: 'Export data' });
  exportBtn.addEventListener('click', async () => {
    const result = await api.data.export();
    state.notice = result.exported
      ? { kind: 'ok', text: `Exported to ${result.path}` }
      : { kind: 'warn', text: 'Export cancelled.' };
    render();
  });
  actions.appendChild(exportBtn);

  const vacuum = el('button', { class: 'btn', type: 'button', text: 'Vacuum database' });
  vacuum.addEventListener('click', async () => {
    await api.data.vacuum();
    state.notice = { kind: 'ok', text: 'Database vacuumed.' };
    render();
  });
  actions.appendChild(vacuum);

  const clearAll = el('button', { class: 'btn danger', type: 'button', text: 'Clear all local data' });
  clearAll.addEventListener('click', async () => {
    if (!confirm('Delete all local history and settings? The credential is removed separately.')) return;
    await api.data.clear(true);
    state.snapshot = await api.snapshot.get();
    state.notice = { kind: 'ok', text: 'Local data cleared.' };
    render();
  });
  actions.appendChild(clearAll);

  wrap.appendChild(actions);
  return wrap;
}

/* ------------------------------ charts ---------------------------- */

function openCharts(metric: Metric, scale: ChartScale): void {
  state.subview = 'charts';
  state.chartMetric = metric;
  state.chartScale = scale;
  state.chartAnchor = Date.now();
  void loadChart().then(() => render());
  render();
}

function renderCharts(): void {
  const view = el('div', { class: 'view' });

  const header = el('div', { class: 'subview-header' });
  const back = el('button', { class: 'back-btn', type: 'button' });
  back.appendChild(icon(ICONS.back));
  back.appendChild(document.createTextNode('Back'));
  back.addEventListener('click', () => {
    state.subview = 'none';
    render();
  });
  header.appendChild(back);

  const title = el('div', { class: 'subview-title' });
  const total =
    state.chartMetric === 'spend'
      ? formatSpend(state.chartData?.total_spend_micro ?? null)
      : formatMetricValue(
          'tokens',
          (state.chartData?.total_input_tokens ?? 0) + (state.chartData?.total_output_tokens ?? 0),
        );
  title.textContent = `${state.chartMetric === 'spend' ? 'Spend' : 'Tokens'} \u00b7 ${total}`;
  header.appendChild(title);

  const options = el('button', {
    class: 'icon-btn',
    type: 'button',
    'aria-label': 'Chart options',
    title: 'Chart options',
  });
  options.appendChild(icon(ICONS.settings));
  options.addEventListener('click', () => {
    state.chartOptionsOpen = !state.chartOptionsOpen;
    render();
  });
  header.appendChild(options);
  view.appendChild(header);

  const nav = el('div', { class: 'period-nav' });
  const prev = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous period' });
  prev.appendChild(icon(ICONS.prev));
  prev.addEventListener('click', () => {
    state.chartAnchor = shiftPeriod(state.chartAnchor, state.chartScale, -1);
    void loadChart().then(() => render());
  });
  const label = el('span', {
    class: 'period-label',
    text: state.chartData ? periodLabel(state.chartData) : '\u2013',
  });
  const next = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next period' });
  next.appendChild(icon(ICONS.next));
  next.addEventListener('click', () => {
    const shifted = shiftPeriod(state.chartAnchor, state.chartScale, 1);
    if (shifted > Date.now()) return;
    state.chartAnchor = shifted;
    void loadChart().then(() => render());
  });
  nav.append(prev, label, next);
  view.appendChild(nav);

  const chartWrap = el('div', { class: 'chart-wrap' });
  view.appendChild(chartWrap);

  chartRenderer = new ChartRenderer(chartWrap, { metric: state.chartMetric });
  if (state.chartData) chartRenderer.setData(state.chartData);

  if (state.chartOptionsOpen) {
    view.appendChild(renderChartOptions());
  }

  content.appendChild(view);
}

function renderChartOptions(): HTMLElement {
  const popover = el('div', { class: 'popover' });
  popover.appendChild(el('div', { class: 'popover-title', text: 'Metric' }));

  const metricSeg = el('div', { class: 'segmented' });
  for (const metric of ['spend', 'tokens'] as Metric[]) {
    const button = el('button', {
      type: 'button',
      'aria-pressed': String(state.chartMetric === metric),
      text: metric === 'spend' ? 'Spend' : 'Tokens',
    });
    button.addEventListener('click', () => {
      state.chartMetric = metric;
      void loadChart().then(() => render());
    });
    metricSeg.appendChild(button);
  }
  popover.appendChild(metricSeg);

  popover.appendChild(el('div', { class: 'popover-title', text: 'Range' }));
  const scaleSeg = el('div', { class: 'segmented' });
  for (const window of WINDOWS) {
    const button = el('button', {
      type: 'button',
      'aria-pressed': String(state.chartScale === window.key),
      text: window.label,
    });
    button.addEventListener('click', () => {
      state.chartScale = window.key;
      state.chartAnchor = Date.now();
      void loadChart().then(() => render());
    });
    scaleSeg.appendChild(button);
  }
  popover.appendChild(scaleSeg);

  const close = el('button', { class: 'btn', type: 'button', text: 'Close' });
  close.addEventListener('click', () => {
    state.chartOptionsOpen = false;
    render();
  });
  popover.appendChild(close);

  return popover;
}

/** Shift the anchor by one range, so the chart can page backwards. */
function shiftPeriod(anchor: number, scale: ChartScale, delta: number): number {
  return anchor + delta * CHART_RANGE_MS[scale];
}

/** Human label for the range the chart covers. */
function periodLabel(data: ChartData): string {
  const start = new Date(data.period_start);
  const end = new Date(new Date(data.period_end).getTime() - 1);
  const day = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = (d: Date) =>
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

  // Intraday ranges read as clock times; only a 24-hour span can cross midnight.
  if (data.scale === '24h') return `${day(start)} ${time(start)} \u2013 ${day(end)} ${time(end)}`;
  return `${time(start)} \u2013 ${time(end)}`;
}

/* ------------------------------------------------------------------ */

void boot().catch((error) => {
  console.error('boot failed', error);
  content.textContent = `Failed to start: ${(error as Error).message}`;
});

window.addEventListener('beforeunload', () => {
  snapshotUnsubscribe?.();
  layoutUnsubscribe?.();
  tabUnsubscribe?.();
  chartInvalidateUnsubscribe?.();
  logEntryUnsubscribe?.();
  if (logTailActive) void api.logs.unsubscribe();
  chartRenderer?.destroy();
});
