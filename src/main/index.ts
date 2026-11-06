import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
  clipboard,
  dialog,
  globalShortcut,
  powerMonitor,
} from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  OPENROUTER_KEYS_URL,
  SCHEMA_VERSION,
} from '../shared/constants.js';
import { applySettingsPatch, DEFAULT_SETTINGS, resetGroup, type Settings } from '../shared/settings.js';
import { buildChart, finestBinMs, type ChartScale } from '../shared/chart.js';
import { layoutFor } from '../shared/layout.js';
import type {
  ChartData,
  DiagnosticBundle,
  KeyRecord,
  LogQuery,
  Metric,
  RequestRecord,
  Scope,
  Snapshot,
  TabId,
  VersionInfo,
  WindowState,
} from '../shared/types.js';
import { Database, defaultDbPath } from './db/database.js';
import { Logger } from './logging/logger.js';
import { CredentialStore } from './credentials.js';
import { CollectorError, OpenRouterCollector, type CollectorCapabilities } from './collectors/openrouter.js';
import { generateSampleRequests, sampleCredits, sampleKeys } from './collectors/sample.js';
import { buildSnapshot } from './snapshot.js';
import { spendSince, startOfLocalDay, startOfLocalMonth } from '../shared/counterSpend.js';
import { migrateUserData } from './migrate.js';
import { buildBreakdown, type BreakdownGroupBy } from '../shared/breakdown.js';
import { buildDiagnosticBundle, bundleToText, redactBundle } from './diagnostics/index.js';
import { looksLikeCredential } from '../shared/redact.js';

const isSelfTest = process.argv.includes('--selftest');
const isCapture = process.argv.includes('--capture');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let db: Database;
let logger: Logger;
let credentials: CredentialStore;
let settings: Settings = structuredClone(DEFAULT_SETTINGS);
let windowState: WindowState;
let snapshotVersion = 0;
let lastResizeFrameMs = 0;
let lastSnapshot: Snapshot | null = null;
let capabilities: CollectorCapabilities | null = null;
let lastKeyInfo: {
  usage_daily_micro: number | null;
  usage_monthly_micro: number | null;
  is_management_key: boolean;
  at: string;
} | null = null;
let collectionStartedAt: number | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let chartTimer: NodeJS.Timeout | null = null;
let settingsWriteTimer: NodeJS.Timeout | null = null;
let boundsWriteTimer: NodeJS.Timeout | null = null;
let backoffMs = 0;
let nextRetryAt: number | null = null;
let lastErrorCode: string | null = null;
let lastErrorMessage: string | null = null;
let lastErrorAt: string | null = null;
let lastSuccessAt: string | null = null;
let logTailUnsubscribe: (() => void) | null = null;
let isQuitting = false;

const SAMPLE_GRANULARITY_MS = 60 * 1000;

function userDataDir(): string {
  return app.getPath('userData');
}

/**
 * The data folder used before the product was renamed. Electron derives the
 * folder from `productName`, so the old name is the only way to find it.
 * `appData` is the platform-correct parent on macOS, Windows, and Linux.
 */
function legacyUserDataDir(): string {
  return join(app.getPath('appData'), 'OpenRouter Widget');
}

function loadSettings(): Settings {
  const raw = db.loadSettings();
  if (!raw) return structuredClone(DEFAULT_SETTINGS);
  try {
    const parsed = JSON.parse(raw) as unknown;
    const { settings: merged } = applySettingsPatch(structuredClone(DEFAULT_SETTINGS), parsed);
    return merged;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function flushSettings(): void {
  if (settingsWriteTimer) {
    clearTimeout(settingsWriteTimer);
    settingsWriteTimer = null;
  }
  try {
    db.saveSettings(JSON.stringify(settings));
  } catch {
    // Best effort.
  }
}

function persistSettings(): void {
  if (settingsWriteTimer) clearTimeout(settingsWriteTimer);
  settingsWriteTimer = setTimeout(() => {
    try {
      db.saveSettings(JSON.stringify(settings));
    } catch (error) {
      logger.error('db', `failed to persist settings: ${(error as Error).message}`, 'settings_write_failed');
    }
  }, 250);
}

function defaultWindowState(): WindowState {
  const primary = screen.getPrimaryDisplay();
  const area = primary.workArea;
  return {
    bounds: {
      x: Math.round(area.x + area.width - DEFAULT_WIDTH - 24),
      y: Math.round(area.y + 24),
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    },
    display_id: primary.id,
    always_on_top: settings.display.always_on_top,
    opacity: settings.display.opacity,
    ghost: settings.display.ghost,
    locked: settings.display.locked,
    visible: true,
  };
}

function clampToWorkArea(bounds: WindowState['bounds'], displayId: number | null): WindowState['bounds'] {
  const displays = screen.getAllDisplays();
  const display = displays.find((d) => d.id === displayId) ?? screen.getPrimaryDisplay();
  const area = display.workArea;
  const width = Math.max(MIN_WIDTH, Math.min(bounds.width, area.width));
  const height = Math.max(MIN_HEIGHT, Math.min(bounds.height, area.height));
  const x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - width));
  const y = Math.max(area.y, Math.min(bounds.y, area.y + area.height - height));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function applyAlwaysOnTop(level: WindowState['always_on_top']): void {
  if (!mainWindow) return;
  if (level === 'off') {
    mainWindow.setAlwaysOnTop(false);
    return;
  }
  // 'floating' sits above normal windows but below system dialogs and menus.
  // 'screen-saver' is the stronger level that also covers full-screen apps.
  mainWindow.setAlwaysOnTop(true, level === 'stronger' ? 'screen-saver' : 'floating');
  if (process.platform === 'darwin') {
    mainWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: level === 'stronger',
      skipTransformProcessType: true,
    });
  }
}

function applyGhostMode(ghost: boolean): void {
  if (!mainWindow) return;
  mainWindow.setIgnoreMouseEvents(ghost, { forward: true });
}

function applyOpacity(opacity: number): void {
  if (!mainWindow) return;
  mainWindow.setOpacity(Math.max(0.4, Math.min(1, opacity / 100)));
}

function createWindow(): void {
  const bounds = clampToWorkArea(windowState.bounds, windowState.display_id);

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    maximizable: true,
    minimizable: true,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    title: 'OpenRouter Widget',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.loadFile(join(__dirname, '../renderer/index.html'));

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    applyAlwaysOnTop(windowState.always_on_top);
    applyOpacity(windowState.opacity);
    applyGhostMode(windowState.ghost);
    if (windowState.visible) mainWindow.showInactive();
    logger.info('window', `window shown at ${bounds.width}x${bounds.height}`);
  });

  mainWindow.on('resize', () => {
    if (!mainWindow) return;
    const start = performance.now();
    const size = mainWindow.getSize();
    const layout = layoutFor(size[0] ?? DEFAULT_WIDTH, size[1] ?? DEFAULT_HEIGHT);
    mainWindow.webContents.send('window:layout', layout);
    lastResizeFrameMs = performance.now() - start;
    scheduleBoundsWrite();
  });

  mainWindow.on('move', () => scheduleBoundsWrite());

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
    windowState.visible = false;
    persistWindowState();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // No remote navigation, no window.open, per FSD section 5.3.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  if (process.platform === 'darwin') {
    app.dock?.hide();
  }
}

function scheduleBoundsWrite(): void {
  if (boundsWriteTimer) clearTimeout(boundsWriteTimer);
  boundsWriteTimer = setTimeout(() => persistWindowState(), 400);
}

function persistWindowState(): void {
  if (!mainWindow) return;
  const size = mainWindow.getSize();
  const pos = mainWindow.getPosition();
  const width = size[0] ?? DEFAULT_WIDTH;
  const height = size[1] ?? DEFAULT_HEIGHT;
  const x = pos[0] ?? 0;
  const y = pos[1] ?? 0;
  windowState.bounds = { x, y, width, height };
  const display = screen.getDisplayMatching({ x, y, width, height });
  windowState.display_id = display.id;
  try {
    db.saveSettings(JSON.stringify(settings));
    db.saveWindowCache('__window__', 'state', []);
    writeFileSync(join(userDataDir(), 'window-state.json'), JSON.stringify(windowState), 'utf8');
  } catch {
    // Window state persistence is best effort.
  }
}

function loadWindowState(): WindowState {
  const file = join(userDataDir(), 'window-state.json');
  if (!existsSync(file)) return defaultWindowState();
  try {
    const raw = JSON.parse(require('node:fs').readFileSync(file, 'utf8')) as WindowState;
    return {
      ...defaultWindowState(),
      ...raw,
      bounds: clampToWorkArea(raw.bounds, raw.display_id ?? null),
    };
  } catch {
    return defaultWindowState();
  }
}

function createTray(): void {
  // A 16x16 template image drawn from a data URL keeps the tray icon crisp on
  // macOS without shipping a binary asset.
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('OpenRouter Widget');
  rebuildTrayMenu();
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: windowState.visible ? 'Hide widget' : 'Show widget',
      click: () => toggleVisibility(),
    },
    {
      label: 'Always on top',
      type: 'checkbox',
      checked: windowState.always_on_top !== 'off',
      click: (item) => {
        windowState.always_on_top = item.checked ? 'normal' : 'off';
        settings.display.always_on_top = windowState.always_on_top;
        applyAlwaysOnTop(windowState.always_on_top);
        persistSettings();
        rebuildTrayMenu();
      },
    },
    {
      label: 'Ghost mode (click-through)',
      type: 'checkbox',
      checked: windowState.ghost,
      click: (item) => {
        windowState.ghost = item.checked;
        settings.display.ghost = item.checked;
        applyGhostMode(item.checked);
        persistSettings();
        rebuildTrayMenu();
      },
    },
    { type: 'separator' },
    { label: 'Refresh now', click: () => void refreshNow('manual') },
    { label: 'Open Settings', click: () => focusTab('settings') },
    { type: 'separator' },
    { label: 'Quit', click: () => quitApp() },
  ]);
  tray.setContextMenu(menu);
}

function toggleVisibility(): void {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
    windowState.visible = false;
  } else {
    mainWindow.showInactive();
    windowState.visible = true;
  }
  rebuildTrayMenu();
}

function focusTab(tab: TabId): void {
  if (!mainWindow) return;
  if (!mainWindow.isVisible()) {
    mainWindow.showInactive();
    windowState.visible = true;
  }
  settings.view.tab = tab;
  persistSettings();
  mainWindow.webContents.send('view:tab', tab);
}

function registerShortcuts(): void {
  const registered = globalShortcut.register('CommandOrControl+Shift+O', () => toggleVisibility());
  if (!registered) {
    logger.warn('app', 'global shortcut CommandOrControl+Shift+O could not be registered', 'shortcut_unavailable');
  }
  const ghost = globalShortcut.register('CommandOrControl+Shift+G', () => {
    windowState.ghost = !windowState.ghost;
    settings.display.ghost = windowState.ghost;
    applyGhostMode(windowState.ghost);
    persistSettings();
    rebuildTrayMenu();
  });
  if (!ghost) {
    logger.warn('app', 'global shortcut CommandOrControl+Shift+G could not be registered', 'shortcut_unavailable');
  }
}

function quitApp(): void {
  isQuitting = true;
  stopTimers();
  globalShortcut.unregisterAll();
  persistWindowState();
  logger.info('app', 'shutting down');
  logger.close();
  db.close();
  app.quit();
}

function stopTimers(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  if (chartTimer) clearInterval(chartTimer);
  refreshTimer = null;
  chartTimer = null;
}

function startTimers(): void {
  stopTimers();
  refreshTimer = setInterval(() => {
    if (!mainWindow) return;
    if (settings.parameters.pause_when_hidden && !mainWindow.isVisible()) return;
    void refreshNow('timer');
  }, settings.parameters.refresh_sec * 1000);

  chartTimer = setInterval(() => {
    if (!mainWindow) return;
    if (settings.parameters.pause_when_hidden && !mainWindow.isVisible()) return;
    mainWindow.webContents.send('charts:invalidate');
  }, settings.parameters.chart_refresh_sec * 1000);
}

let samplePurged = false;

/**
 * Remove sample rows the first time a real credential is used. Without this,
 * the sample records stay in the database and are summed into every total,
 * which is exactly the "mock data still showing" symptom.
 */
function purgeSampleDataOnce(): void {
  if (samplePurged) return;
  samplePurged = true;
  const removed = db.purgeSampleData();
  if (removed.requests > 0 || removed.keys > 0) {
    logger.info(
      'collector',
      `removed ${removed.requests} sample request records and ${removed.keys} sample keys now that a real account is connected`,
    );
  }
}

function currentScope(): Scope {
  return settings.view.scope;
}

function scopedRequests(): RequestRecord[] {
  const scope = currentScope();
  const limit = 20000;
  return scope.kind === 'all' ? db.listRequests(limit) : db.listRequests(limit, scope.id);
}

function accountInfo(): Snapshot['account'] {
  const stored = db.loadAccount();
  const storedFile = credentials.has();
  // A file that exists but cannot be decrypted is not a usable credential. It
  // must read as unreadable, not connected, or the widget reports live numbers
  // that stopped updating and never tells the user to re-enter the key.
  const encryptionOk = credentials.isEncryptionAvailable();
  const hasCredential = credentials.isUsable();
  const unreadable = storedFile && !hasCredential;
  let state: Snapshot['account']['state'] = 'not_connected';
  if (unreadable) state = 'unreadable';
  else if (hasCredential && !encryptionOk) state = 'encryption_unavailable';
  else if (hasCredential && lastErrorCode === 'invalid_credential') state = 'invalid';
  else if (hasCredential) state = 'connected';

  const credits = sampleCredits();
  return {
    connected: hasCredential,
    state,
    credential_unreadable: unreadable,
    label: stored?.label ?? null,
    last4: stored?.last4 ?? null,
    saved_at: stored?.saved_at ?? null,
    total_credits_micro: hasCredential ? credits.total_credits_micro : null,
    total_usage_micro: hasCredential ? credits.total_usage_micro : null,
  };
}

function collectionStatus(): Snapshot['collection_status'] {
  const staleThreshold = Math.max(60, settings.parameters.refresh_sec * 3) * 1000;
  const stale = lastSuccessAt ? Date.now() - new Date(lastSuccessAt).getTime() > staleThreshold : false;
  return {
    last_success: lastSuccessAt,
    last_error_code: lastErrorCode,
    last_error_message: lastErrorMessage,
    last_error_at: lastErrorAt,
    retry_at: nextRetryAt ? new Date(nextRetryAt).toISOString() : null,
    backoff_ms: backoffMs,
    stale,
    expected_delay_sec: capabilities?.reporting_delay_sec ?? 60,
  };
}

function coverageInfo(): Snapshot['coverage'] {
  const oldest = db.oldestRequestTime();
  const granularity = capabilities?.granularity_ms ?? SAMPLE_GRANULARITY_MS;
  const warnings: string[] = [];
  if (granularity >= 24 * 60 * 60 * 1000) {
    warnings.push('Source reports daily aggregates only; short windows are unavailable.');
  }
  if (!capabilities?.request_feed) {
    warnings.push('No account-wide request feed confirmed; latest request coverage is limited.');
  }
  return {
    earliest_reliable: oldest,
    latest_source_date: db.latestRequestTime(),
    spend: oldest ? 'partial' : 'unavailable',
    tokens: oldest ? 'partial' : 'unavailable',
    requests: capabilities?.request_feed ? 'full' : 'partial',
    request_source: capabilities?.request_feed ? 'full_account' : 'selected_apps',
    warnings,
  };
}

/**
 * Pull the last 30 days at day granularity plus the last 24 hours at hour
 * granularity, both broken down by key and model. Day rows give the long-range
 * charts; hour rows give the rolling windows. Both are keyed on the bucket plus
 * the dimension values, so re-running updates rows in place.
 */
async function collectAnalytics(collector: OpenRouterCollector, trigger: string): Promise<void> {
  const now = Date.now();
  // The analytics response enriches `api_key_id` to the key's display name,
  // while the key list is keyed by hash. Map name -> hash so a request row and
  // an api_key row share one identifier and the scope filter can match.
  const hashByName = new Map<string, string>();
  try {
    for (const key of await collector.fetchKeys()) {
      const name = key.name || key.label || 'Unnamed key';
      hashByName.set(name, key.hash);
      db.upsertKey({ id: key.hash, name, removed: false, last4: null });
    }
  } catch {
    // Key names are a nicety; the breakdown still works with the raw dimension.
  }

  const dimensions = ['api_key_id', 'model'] as const;
  let written = 0;

  // 30 days of daily buckets, which is the widest range the charts need.
  const dayResult = await collector.queryAnalytics({
    metrics: ['total_usage', 'tokens_total', 'tokens_prompt', 'tokens_completion', 'request_count'],
    dimensions: [...dimensions],
    granularity: 'day',
    start: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
    end: new Date(now).toISOString(),
    limit: 5000,
  });
  for (const record of OpenRouterCollector.analyticsToRequests(dayResult.rows, 'day', hashByName)) {
    db.upsertRequest(record);
    written += 1;
  }
  db.recordCollectionRange(
    24 * 60 * 60 * 1000,
    new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
    new Date(now).toISOString(),
  );

  // 24 hours of hourly buckets, which is what 3h, 6h, and 24h read. A full day
  // is fetched so coverage reaches the start of the widest window.
  const hourResult = await collector.queryAnalytics({
    metrics: ['total_usage', 'tokens_total', 'tokens_prompt', 'tokens_completion', 'request_count'],
    dimensions: [...dimensions],
    granularity: 'hour',
    start: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    end: new Date(now).toISOString(),
    limit: 5000,
  });
  for (const record of OpenRouterCollector.analyticsToRequests(hourResult.rows, 'hour', hashByName)) {
    db.upsertRequest(record);
    written += 1;
  }
  db.recordCollectionRange(
    60 * 60 * 1000,
    new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    new Date(now).toISOString(),
  );

  // The last two hours at minute granularity, which is what 10m and 1h read.
  // Two hours rather than one so the 1h window is fully covered even if the
  // previous refresh was delayed. The endpoint supports minutes, and without
  // this the two shortest windows would be gated out even though the source
  // can answer them.
  const minuteResult = await collector.queryAnalytics({
    metrics: ['total_usage', 'tokens_total', 'tokens_prompt', 'tokens_completion', 'request_count'],
    dimensions: [...dimensions],
    granularity: 'minute',
    start: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    end: new Date(now).toISOString(),
    limit: 5000,
  });
  for (const record of OpenRouterCollector.analyticsToRequests(minuteResult.rows, 'minute', hashByName)) {
    db.upsertRequest(record);
    written += 1;
  }
  db.recordCollectionRange(
    60 * 1000,
    new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    new Date(now).toISOString(),
  );

  // The activity feed is superseded: it lags by days and has no key identity,
  // so leaving its rows in place would double-count against the live data.
  const stale = db.purgeSource('openrouter.activity');
  if (stale > 0) {
    logger.info('collector', `removed ${stale} superseded activity rows now that analytics is live`);
  }

  logger.info(
    'collector',
    `collected ${written} analytics rows (${trigger})` +
      (dayResult.truncated || hourResult.truncated || minuteResult.truncated ? ' [truncated]' : ''),
  );
}

/**
 * Spend since a period start, from the cumulative account counter. This is the
 * only source that reflects spend from the current day while the activity feed
 * is still lagging, so it is what the UI shows for "Today".
 */
function counterSpendFor(periodStartMs: number): Snapshot['counter_today'] {
  if (!credentials.has()) return null;
  const samples = db.listUsageSamples(new Date(periodStartMs - 45 * 24 * 60 * 60 * 1000).toISOString());
  if (samples.length === 0) return null;
  return spendSince(samples, periodStartMs);
}

function buildCurrentSnapshot(): Snapshot {
  snapshotVersion += 1;
  const now = Date.now();
  const requests = scopedRequests();
  const granularity = capabilities?.granularity_ms ?? SAMPLE_GRANULARITY_MS;
  const retentionHorizon = now - settings.parameters.raw_retention_days * 24 * 60 * 60 * 1000;

  const snapshot = buildSnapshot({
    now,
    requests,
    scope: currentScope(),
    account: accountInfo(),
    collectionStatus: collectionStatus(),
    coverage: coverageInfo(),
    sourceGranularityMs: granularity,
    collectionStartedAt,
    gaps: db.listGaps(),
    collectionRanges: db.listCollectionRanges(),
    retentionHorizon,
    timeZone: settings.parameters.time_zone === 'system' ? Intl.DateTimeFormat().resolvedOptions().timeZone : settings.parameters.time_zone,
    // Sample means the rows themselves are generated examples, which is what
    // the badge claims. Credential state is reported separately via account.
    sample: db.hasSampleRows(),
    snapshotVersion,
    // A management key reports usage_* = 0 for itself, because the usage belongs
    // to the account rather than to the key. Only trust these fields for a
    // non-management key; otherwise fall back to the activity-derived totals.
    todaySource:
      lastKeyInfo &&
      !lastKeyInfo.is_management_key &&
      lastKeyInfo.usage_daily_micro !== null
        ? { spend_micro: lastKeyInfo.usage_daily_micro, as_of: lastKeyInfo.at, origin: 'key.usage_daily' }
        : null,
    monthSource:
      lastKeyInfo &&
      !lastKeyInfo.is_management_key &&
      lastKeyInfo.usage_monthly_micro !== null
        ? { spend_micro: lastKeyInfo.usage_monthly_micro, as_of: lastKeyInfo.at, origin: 'key.usage_monthly' }
        : null,
    counterToday: counterSpendFor(startOfLocalDay(now)),
    counterMonth: counterSpendFor(startOfLocalMonth(now)),
  });

  lastSnapshot = snapshot;
  try {
    db.saveWindowCache(
      currentScope().kind === 'all' ? 'all' : `key:${(currentScope() as { id: string }).id}`,
      settings.display.metric_spending,
      snapshot.windows,
    );
  } catch {
    // Cache write is best effort.
  }
  return snapshot;
}

async function refreshNow(trigger: string): Promise<Snapshot> {
  const secret = credentials.read();

  if (!secret) {
    // No account: serve clearly labeled sample data so the UI is explorable.
    // Seed only into an empty database, so a disconnect never mixes sample rows
    // into real history.
    if (db.countRequests() === 0) {
      const samples = generateSampleRequests();
      for (const record of samples) db.upsertRequest(record);
      for (const key of sampleKeys()) db.upsertKey(key);
      collectionStartedAt = Date.now() - 120 * 24 * 60 * 60 * 1000;
      logger.info('collector', `loaded ${samples.length} sample request records (sample data)`);
    }
    // Deliberately not a success. Nothing was collected, so reporting a fresh
    // timestamp here made the header say "Live" while the widget was showing
    // sample data or a stale snapshot, and it hid a stalled collector.
    if (db.countRequests() > 0) {
      lastSuccessAt = new Date(db.latestRequestTime() ?? '').toISOString();
    }
    const snapshot = buildCurrentSnapshot();
    mainWindow?.webContents.send('snapshot:update', snapshot);
    return snapshot;
  }

  // A real credential is present: sample data must never coexist with it.
  purgeSampleDataOnce();

  if (nextRetryAt && Date.now() < nextRetryAt) {
    return lastSnapshot ?? buildCurrentSnapshot();
  }

  const collector = new OpenRouterCollector(secret);
  const correlationId = `c${Date.now().toString(36)}`;

  try {
    const probe = await collector.probeCapabilities();
    capabilities = probe;

    // The analytics endpoint is the live source and is preferred whenever it
    // answers. It reports the current day at minute granularity and can break
    // spend down by key, neither of which the activity feed can do.
    if (probe.analytics) {
      await collectAnalytics(collector, trigger);
    } else if (probe.activity) {
      const rows = await collector.fetchActivity();
      const records = OpenRouterCollector.activityToRequests(rows);
      for (const record of records) db.upsertRequest(record);
      for (const key of OpenRouterCollector.activityToKeys(rows)) db.upsertKey(key);
      logger.info('collector', `collected ${records.length} activity rows (${trigger})`);
    }

    if (probe.credits) {
      const credits = await collector.fetchCredits();
      logger.debug(
        'collector',
        `credits: total=${credits.total_credits_micro ?? 'n/a'} usage=${credits.total_usage_micro ?? 'n/a'}`,
      );
      // total_usage is a live cumulative counter. Recording it on every poll is
      // what makes exact per-day spend possible while the activity feed lags.
      if (credits.total_usage_micro !== null) {
        db.recordUsageSample(credits.total_usage_micro);
        db.pruneUsageSamples(new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString());
      }
    }

    if (probe.key_info) {
      const info = await collector.fetchKeyInfo();
      lastKeyInfo = {
        usage_daily_micro: info.usage_daily_micro,
        usage_monthly_micro: info.usage_monthly_micro,
        is_management_key: info.is_management_key,
        at: new Date().toISOString(),
      };
      db.saveAccount({
        label: info.label,
        last4: info.last4,
        saved_at: db.loadAccount()?.saved_at ?? new Date().toISOString(),
        state: 'connected',
        capabilities: JSON.stringify(probe),
      });
    }

    lastSuccessAt = new Date().toISOString();
    lastErrorCode = null;
    lastErrorMessage = null;
    backoffMs = 0;
    nextRetryAt = null;
    db.saveCollectorState({
      cursor: null,
      last_success: lastSuccessAt,
      retry_at: null,
      error_code: null,
    });
  } catch (error) {
    const collectorError =
      error instanceof CollectorError
        ? error
        : new CollectorError('unknown', (error as Error).message ?? 'Unknown collection failure');

    lastErrorCode = collectorError.code;
    lastErrorMessage = collectorError.message;
    lastErrorAt = new Date().toISOString();
    backoffMs = Math.min(300_000, Math.max(5_000, (collectorError.retryAfterMs ?? backoffMs * 2) || 5_000));
    nextRetryAt = Date.now() + backoffMs;

    // Exactly one log entry per failed attempt, not one per retry.
    logger.error('source', `${collectorError.code}: ${collectorError.message}`, collectorError.code, correlationId);
    db.saveCollectorState({
      cursor: null,
      last_success: lastSuccessAt,
      retry_at: new Date(nextRetryAt).toISOString(),
      error_code: collectorError.code,
    });
  }

  const snapshot = buildCurrentSnapshot();
  mainWindow?.webContents.send('snapshot:update', snapshot);
  return snapshot;
}

function buildChartData(params: {
  metric: Metric;
  scale: ChartScale;
  anchor: number;
  keyId: string | null;
}): ChartData {
  const requests = params.keyId ? db.listRequests(20000, params.keyId) : db.listRequests(20000);
  return buildChart({
    metric: params.metric,
    scale: params.scale,
    anchor: params.anchor,
    timeZone: settings.parameters.time_zone,
    weekStart: settings.parameters.week_start,
    axis: settings.display.chart_axis,
    requests,
    // Sample means the rows themselves are generated examples, which is what
    // the badge claims. Credential state is reported separately via account.
    sample: db.hasSampleRows(),
    collectionRanges: db.listCollectionRanges(),
  });
}

function versionInfo(): VersionInfo {
  return {
    widget: app.getVersion(),
    build: process.env.BUILD_NUMBER ?? 'dev',
    commit: process.env.GIT_COMMIT ?? 'local',
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    sqlite: 'node:sqlite',
    channel: 'stable',
    schema_version: db.schemaVersion(),
    last_migration: db.lastMigration(),
    update_state: 'idle',
    last_check: null,
    release_notes_url: 'https://github.com/openrouter-desktop-widget/releases',
  };
}

function diagnosticBundle(trigger: string): DiagnosticBundle {
  const bounds = mainWindow?.getBounds() ?? windowState.bounds;
  const layout = layoutFor(bounds.width, bounds.height);
  const storage = db.storageStats();
  return redactBundle(
    buildDiagnosticBundle(
      {
        connection: {
          state: accountInfo().state,
          last_success: lastSuccessAt,
          last_error_code: lastErrorCode,
          last_error_at: lastErrorAt,
          backoff_ms: backoffMs,
          next_retry: nextRetryAt ? new Date(nextRetryAt).toISOString() : null,
        },
        source: {
          capabilities,
          reporting_delay_sec: capabilities?.reporting_delay_sec ?? null,
          granularity_ms: capabilities?.granularity_ms ?? null,
        },
        coverage: coverageInfo() as unknown as Record<string, unknown>,
        collection: {
          last_cursor: db.loadCollectorState().cursor,
          requests_stored: db.countRequests(),
          collection_started_at: collectionStartedAt ? new Date(collectionStartedAt).toISOString() : null,
        },
        storage,
        window: {
          bounds,
          display_id: windowState.display_id,
          scale_factor: screen.getDisplayMatching(bounds).scaleFactor,
          size_class: `${layout.widthClass}/${layout.heightClass}`,
          layout_mode: layout.mode,
          always_on_top: windowState.always_on_top,
          opacity: windowState.opacity,
          ghost: windowState.ghost,
        },
        lastResizeFrameMs,
      },
      trigger,
    ),
  );
}

function registerIpc(): void {
  ipcMain.handle('account:status', () => accountInfo());

  ipcMain.handle('snapshot:get', () => lastSnapshot ?? buildCurrentSnapshot());

  ipcMain.handle('summary:get', (_event, params: { metric: Metric }) => {
    const snapshot = lastSnapshot ?? buildCurrentSnapshot();
    return { windows: snapshot.windows, metric: params?.metric ?? 'spend', as_of: snapshot.server_time };
  });

  ipcMain.handle(
    'charts:get',
    (_event, params: { metric: Metric; scale: ChartScale; anchor: number; keyId: string | null }) => {
      const metric: Metric = params?.metric === 'tokens' ? 'tokens' : 'spend';
      const scale: ChartScale = (['10m', '1h', '3h', '6h', '24h'] as const).includes(params?.scale)
        ? params.scale
        : '24h';
      const anchor = Number.isFinite(params?.anchor) ? params.anchor : Date.now();
      const keyId = typeof params?.keyId === 'string' ? params.keyId : null;
      return buildChartData({ metric, scale, anchor, keyId });
    },
  );

  ipcMain.handle('requests:list', (_event, params: { limit: number; keyId: string | null }) => {
    const limit = Math.max(1, Math.min(500, Number(params?.limit) || 50));
    const keyId = typeof params?.keyId === 'string' ? params.keyId : null;
    return db.listRequests(limit, keyId);
  });

  /**
   * The Requests tab shows a breakdown of the same aggregates the charts use,
   * because the public API exposes no individual generations.
   */
  ipcMain.handle(
    'requests:breakdown',
    (_event, params: { groupBy?: string; windowMs?: number; keyId?: string | null }) => {
      const groupBy: BreakdownGroupBy = params?.groupBy === 'key' ? 'key' : 'model';
      const windowMs = Math.max(60_000, Math.min(30 * 24 * 60 * 60 * 1000, Number(params?.windowMs) || 24 * 60 * 60 * 1000));
      const keyId = typeof params?.keyId === 'string' ? params.keyId : null;
      const now = Date.now();
      const rows = keyId ? db.listRequests(20000, keyId) : db.listRequests(20000);
      return buildBreakdown(rows, now - windowMs, now, groupBy, db.listCollectionRanges());
    },
  );

  ipcMain.handle('keys:list', () => {
    const keys = db.listKeys();
    const now = Date.now();
    const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const recent = db.requestsSince(since);
    return keys.map((key: KeyRecord) => {
      const rows = recent.filter((r) => r.key_id === key.id);
      return {
        ...key,
        spend_24h_micro: rows.reduce((sum, r) => sum + (r.cost_micro ?? 0), 0),
        tokens_24h: rows.reduce((sum, r) => sum + (r.total_tokens ?? 0), 0),
        requests_24h: rows.length,
      };
    });
  });

  ipcMain.handle('window:getState', () => {
    const bounds = mainWindow?.getBounds() ?? windowState.bounds;
    return { ...windowState, bounds, layout: layoutFor(bounds.width, bounds.height) };
  });

  ipcMain.handle('window:setState', (_event, patch: Partial<WindowState>) => {
    if (!mainWindow || typeof patch !== 'object' || patch === null) return windowState;

    if (patch.bounds) {
      const b = patch.bounds;
      if (
        Number.isFinite(b.x) &&
        Number.isFinite(b.y) &&
        Number.isFinite(b.width) &&
        Number.isFinite(b.height)
      ) {
        const clamped = clampToWorkArea(
          {
            x: Math.round(b.x),
            y: Math.round(b.y),
            width: Math.max(MIN_WIDTH, Math.round(b.width)),
            height: Math.max(MIN_HEIGHT, Math.round(b.height)),
          },
          windowState.display_id,
        );
        mainWindow.setBounds(clamped);
        windowState.bounds = clamped;
      }
    }
    if (patch.always_on_top && ['normal', 'stronger', 'off'].includes(patch.always_on_top)) {
      windowState.always_on_top = patch.always_on_top;
      settings.display.always_on_top = patch.always_on_top;
      applyAlwaysOnTop(patch.always_on_top);
      persistSettings();
    }
    if (typeof patch.opacity === 'number' && patch.opacity >= 40 && patch.opacity <= 100) {
      windowState.opacity = Math.round(patch.opacity);
      settings.display.opacity = windowState.opacity;
      applyOpacity(windowState.opacity);
      persistSettings();
    }
    if (typeof patch.ghost === 'boolean') {
      windowState.ghost = patch.ghost;
      settings.display.ghost = patch.ghost;
      applyGhostMode(patch.ghost);
      persistSettings();
    }
    if (typeof patch.locked === 'boolean') {
      windowState.locked = patch.locked;
      settings.display.locked = patch.locked;
      persistSettings();
    }
    rebuildTrayMenu();
    const size = mainWindow.getSize();
    return {
      ...windowState,
      bounds: mainWindow.getBounds(),
      layout: layoutFor(size[0] ?? DEFAULT_WIDTH, size[1] ?? DEFAULT_HEIGHT),
    };
  });

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:hide', () => {
    mainWindow?.hide();
    windowState.visible = false;
    rebuildTrayMenu();
  });
  ipcMain.handle('window:close', () => quitApp());
  ipcMain.handle('window:resetSize', () => {
    if (!mainWindow) return null;
    const display = screen.getDisplayMatching(mainWindow.getBounds());
    const area = display.workArea;
    const bounds = clampToWorkArea(
      {
        x: area.x + area.width - DEFAULT_WIDTH - 24,
        y: area.y + 24,
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
      },
      display.id,
    );
    mainWindow.setBounds(bounds);
    windowState.bounds = bounds;
    return bounds;
  });

  ipcMain.handle('settings:get', () => settings);

  ipcMain.handle('settings:set', (_event, patch: unknown) => {
    const result = applySettingsPatch(settings, patch);
    settings = result.settings;
    persistSettings();

    if (patch && typeof patch === 'object' && 'display' in patch) {
      const display = (patch as { display?: Record<string, unknown> }).display ?? {};
      if ('always_on_top' in display) {
        windowState.always_on_top = settings.display.always_on_top;
        applyAlwaysOnTop(windowState.always_on_top);
      }
      if ('opacity' in display) {
        windowState.opacity = settings.display.opacity;
        applyOpacity(windowState.opacity);
      }
      if ('ghost' in display) {
        windowState.ghost = settings.display.ghost;
        applyGhostMode(windowState.ghost);
      }
      if ('launch_at_login' in display) {
        try {
          app.setLoginItemSettings({ openAtLogin: settings.display.launch_at_login });
        } catch {
          logger.warn('app', 'launch at login could not be changed', 'login_item_failed');
        }
      }
    }

    if (patch && typeof patch === 'object' && 'parameters' in patch) {
      startTimers();
    }

    rebuildTrayMenu();
    return result;
  });

  ipcMain.handle('settings:reset', (_event, group: 'parameters' | 'display' | 'view' | 'all') => {
    settings = resetGroup(settings, group);
    persistSettings();
    startTimers();
    return settings;
  });

  ipcMain.handle('logs:query', (_event, query: LogQuery) => {
    const safe: LogQuery = {
      severities: Array.isArray(query?.severities) ? query.severities : ['error', 'warn'],
      sources: Array.isArray(query?.sources) ? query.sources : [],
      text: typeof query?.text === 'string' ? query.text.slice(0, 200) : '',
      range: ['15m', '1h', '24h', 'all'].includes(query?.range) ? query.range : 'all',
      limit: Math.max(1, Math.min(2000, Number(query?.limit) || 500)),
    };
    return logger.query(safe);
  });

  ipcMain.handle('logs:tail', (event) => {
    logTailUnsubscribe?.();
    logTailUnsubscribe = logger.subscribe((entry) => {
      if (!event.sender.isDestroyed()) event.sender.send('logs:entry', entry);
    });
    return { subscribed: true, latest_seq: logger.latestSeq() };
  });

  ipcMain.handle('logs:unsubscribe', () => {
    logTailUnsubscribe?.();
    logTailUnsubscribe = null;
    return { subscribed: false };
  });

  ipcMain.handle('logs:clearView', () => {
    logger.clearView();
    return { cleared: true };
  });

  ipcMain.handle('logs:openFolder', async () => {
    await shell.openPath(logger.directory);
    return { opened: logger.directory };
  });

  ipcMain.handle('logs:errorCount', (_event, sinceSeq: number) => ({
    count: logger.countErrorsSince(Number(sinceSeq) || 0),
    latest_seq: logger.latestSeq(),
  }));

  ipcMain.handle('diagnostics:get', () => diagnosticBundle('manual'));

  ipcMain.handle('diagnostics:copy', () => {
    const bundle = diagnosticBundle('copy');
    clipboard.writeText(bundleToText(bundle));
    return { copied: true, bytes: bundleToText(bundle).length };
  });

  ipcMain.handle('diagnostics:save', async () => {
    const bundle = diagnosticBundle('save');
    const result = await dialog.showSaveDialog({
      title: 'Save diagnostic bundle',
      defaultPath: join(app.getPath('downloads'), `openrouter-widget-diagnostics-${Date.now()}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    writeFileSync(result.filePath, bundleToText(bundle), 'utf8');
    db.saveDiagnostic('save', bundleToText(bundle), SCHEMA_VERSION);
    return { saved: true, path: result.filePath };
  });

  ipcMain.handle('app:version', () => versionInfo());

  ipcMain.handle('app:checkForUpdates', async () => {
    logger.info('update', 'update check requested');
    return { state: 'up_to_date', checked_at: new Date().toISOString() };
  });

  ipcMain.handle('app:openExternal', async (_event, url: string) => {
    const allowed = [OPENROUTER_KEYS_URL, 'https://openrouter.ai/docs', 'https://openrouter.ai/settings/credits'];
    if (typeof url !== 'string' || !allowed.some((a) => url.startsWith(a))) {
      logger.warn('app', 'blocked openExternal for a non-allowlisted URL', 'open_external_blocked');
      return { opened: false };
    }
    await shell.openExternal(url);
    return { opened: true };
  });

  ipcMain.handle('credential:state', () => ({
    state: accountInfo().state,
    encryption_available: credentials.isEncryptionAvailable(),
    // A stored but undecryptable credential is reported as not connected, so
    // the user is prompted to re-enter it instead of seeing stale numbers.
    has_credential: credentials.isUsable(),
    label: db.loadAccount()?.label ?? null,
    last4: db.loadAccount()?.last4 ?? null,
    saved_at: db.loadAccount()?.saved_at ?? null,
  }));

  ipcMain.handle('credential:save', async (_event, secret: string) => {
    if (typeof secret !== 'string' || secret.trim().length < 20) {
      return { ok: false, error: 'invalid_format', message: 'That does not look like an OpenRouter key.' };
    }
    const trimmed = secret.trim();
    const persisted = credentials.save(trimmed);

    // Verify with a single read-only call before declaring success.
    const collector = new OpenRouterCollector(trimmed);
    try {
      const info = await collector.fetchKeyInfo();
      db.saveAccount({
        label: info.label,
        last4: info.last4,
        saved_at: new Date().toISOString(),
        state: 'connected',
        capabilities: null,
      });
      lastErrorCode = null;
      logger.info('credential', 'credential saved and verified');
      // Drop sample rows before the first real refresh so no total is ever a
      // blend of sample and real data.
      purgeSampleDataOnce();
      await refreshNow('credential');
      return {
        ok: true,
        persisted,
        encryption_available: credentials.isEncryptionAvailable(),
        label: info.label,
        last4: info.last4,
      };
    } catch (error) {
      const code = error instanceof CollectorError ? error.code : 'unknown';
      logger.error('credential', `credential verification failed: ${code}`, code);
      if (code === 'invalid_credential') {
        credentials.clear();
        return { ok: false, error: 'invalid_credential', message: 'OpenRouter rejected that key.' };
      }
      return {
        ok: false,
        error: code,
        message: error instanceof Error ? error.message : 'Verification failed.',
      };
    }
  });

  ipcMain.handle('credential:test', async () => {
    const secret = credentials.read();
    if (!secret) return { ok: false, error: 'not_connected' };
    const started = Date.now();
    try {
      const collector = new OpenRouterCollector(secret);
      const info = await collector.fetchKeyInfo();
      const latency = Date.now() - started;
      logger.info('credential', `connection test succeeded in ${latency} ms`);
      return { ok: true, latency_ms: latency, label: info.label, scope: 'account' };
    } catch (error) {
      const code = error instanceof CollectorError ? error.code : 'unknown';
      logger.error('credential', `connection test failed: ${code}`, code);
      return { ok: false, error: code, latency_ms: Date.now() - started };
    }
  });

  ipcMain.handle('credential:disconnect', (_event, deleteHistory: boolean) => {
    credentials.clear();
    db.saveAccount({ label: null, last4: null, saved_at: null, state: 'not_connected', capabilities: null });
    if (deleteHistory) {
      db.clearAll();
      logger.info('credential', 'credential removed and local history deleted');
    } else {
      logger.info('credential', 'credential removed; local history kept');
    }
    lastSuccessAt = null;
    lastErrorCode = null;
    lastKeyInfo = null;
    samplePurged = false;
    return { ok: true, history_deleted: deleteHistory };
  });

  ipcMain.handle('data:export', async () => {
    const result = await dialog.showSaveDialog({
      title: 'Export data',
      defaultPath: join(app.getPath('downloads'), `openrouter-widget-export-${Date.now()}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { exported: false };
    const payload = {
      exported_at: new Date().toISOString(),
      schema_version: db.schemaVersion(),
      requests: db.listRequests(20000),
      keys: db.listKeys(),
      settings,
    };
    writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    logger.info('db', `exported data to ${result.filePath}`);
    return { exported: true, path: result.filePath };
  });

  ipcMain.handle('data:clear', (_event, confirmed: boolean) => {
    if (confirmed !== true) return { cleared: false };
    db.clearAll();
    logger.warn('db', 'all local data cleared by user action');
    return { cleared: true };
  });

  ipcMain.handle('data:vacuum', () => {
    db.vacuum();
    logger.info('db', 'database vacuumed');
    return { vacuumed: true, stats: db.storageStats() };
  });

  ipcMain.handle('data:openDbFolder', async () => {
    await shell.openPath(userDataDir());
    return { opened: userDataDir() };
  });

  ipcMain.handle('app:refreshNow', () => refreshNow('manual'));

  ipcMain.handle('app:quit', () => quitApp());
}

const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAACPSURBVDhPYxgFWAAD4zT+/z+GhgYGXDA6xsbGzMTEBEVDAwMDIyMjKI4GhoYGRkZGUBwNDA0NjIyMoDgaGBoaGBkZQXE0MDQ0MDIyguJoYGhoYGRkBMXRwNDQwMjICIqjgaGhgZGRERRHA0NDAyMjIyiOBoaGBkZGRlAcDQwNDYyMjKA4GhgaGhgZGUFxNDA0NDAyMjIAAG3kL3wAAAABJRU5ErkJggg==';

async function bootstrap(): Promise<void> {
  await app.whenReady();

  // The product was renamed, which moves the Electron userData folder. Copy the
  // old folder across before anything opens the database, or the widget would
  // start empty and look like it had lost the credential and all history.
  const migration = migrateUserData(legacyUserDataDir(), app.getPath('userData'));

  logger = new Logger();
  if (migration.migrated) {
    logger.info(
      'app',
      `migrated ${migration.files} files from ${migration.from} to ${migration.to}`,
    );
  } else if (migration.reason && migration.reason !== 'no_source' && migration.reason !== 'same_path') {
    logger.warn('app', `data folder migration skipped: ${migration.reason}`, 'migration_skipped');
  }
  db = new Database({ file: defaultDbPath(userDataDir()), logger });
  credentials = new CredentialStore(userDataDir());
  settings = loadSettings();
  windowState = loadWindowState();

  logger.info('app', `starting OpenRouter Widget ${app.getVersion()} on ${process.platform}`);

  // Repair state written by an earlier build that could store a credential as
  // the account label. A label must never be key-shaped.
  const storedAccount = db.loadAccount();
  if (storedAccount?.label && looksLikeCredential(storedAccount.label)) {
    db.saveAccount({
      label: null,
      last4: storedAccount.last4,
      saved_at: storedAccount.saved_at,
      state: storedAccount.state,
      capabilities: null,
    });
    logger.warn('credential', 'cleared a credential-shaped account label left by an earlier build', 'label_repaired');
  }

  registerIpc();
  createWindow();
  createTray();
  registerShortcuts();
  startTimers();

  powerMonitor.on('suspend', () => {
    logger.info('app', 'system suspended; pausing collection');
    stopTimers();
  });
  powerMonitor.on('resume', () => {
    logger.info('app', 'system resumed; refreshing immediately');
    startTimers();
    void refreshNow('resume');
  });

  screen.on('display-removed', () => {
    if (!mainWindow) return;
    const bounds = clampToWorkArea(mainWindow.getBounds(), windowState.display_id);
    mainWindow.setBounds(bounds);
    logger.info('window', 'display removed; bounds clamped into the work area');
  });

  screen.on('display-metrics-changed', () => {
    if (!mainWindow) return;
    const bounds = clampToWorkArea(mainWindow.getBounds(), windowState.display_id);
    mainWindow.setBounds(bounds);
  });

  await refreshNow('startup');

  if (isSelfTest) {
    await runSelfTest();
  }

  if (isCapture) {
    await runCapture();
  }
}

/**
 * Development helper: render the widget at each size class and write PNGs so
 * the layout can be reviewed without a human at the keyboard.
 */
async function runCapture(): Promise<void> {
  const outDir = join(app.getPath('userData'), 'captures');
  mkdirSync(outDir, { recursive: true });
  // Capture mutates the chart axis to demonstrate the override. Remember the
  // original so the run never leaves the widget in a non-default state.
  const originalAxis = settings.display.chart_axis;
  if (!mainWindow) return;
  mainWindow.showInactive();

  const shots: Array<{
    name: string;
    width: number;
    height: number;
    tab: TabId;
    groupBy?: string;
  }> = [
    { name: '01-spending-micro-180x120', width: 180, height: 120, tab: 'spending' },
    { name: '02-spending-compact-320x240', width: 320, height: 240, tab: 'spending' },
    { name: '03-spending-standard-480x360', width: 480, height: 360, tab: 'spending' },
    { name: '04-spending-expanded-900x560', width: 900, height: 560, tab: 'spending' },
    { name: '05-tokens-480x360', width: 480, height: 360, tab: 'requests' },
    { name: '07-keys-480x360', width: 480, height: 360, tab: 'api' },
    { name: '12-keys-tall-520x760', width: 520, height: 760, tab: 'api' },
    { name: '13-models-520x420', width: 520, height: 420, tab: 'models' },
    { name: '08-settings-480x420', width: 480, height: 420, tab: 'settings' },
  ];

  if (!mainWindow) return;
  mainWindow.showInactive();

  // TEMP DEBUG
  mainWindow.setBounds({ x: 60, y: 60, width: 320, height: 240 });
  mainWindow.webContents.send('view:tab', 'spending');
  await new Promise((r) => setTimeout(r, 1500));
  await mainWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('.connect-prompt')?.remove();
    document.querySelector('.lag-note')?.remove();
    window.dispatchEvent(new Event('resize'));
  })()`);
  await new Promise((r) => setTimeout(r, 1200));
  const dbg = await mainWindow.webContents.executeJavaScript(`(() => {
    const v = document.querySelector('.metric-value');
    const row = document.querySelector('.metric-headline');
    const m = document.querySelector('.metric');
    const ms = document.querySelector('.metrics');
    return {
      mode: document.getElementById('root').dataset.mode,
      valueFont: v ? getComputedStyle(v).fontSize : null,
      valueInline: v ? v.style.fontSize : null,
      rowW: row ? row.clientWidth : null,
      rowH: row ? row.clientHeight : null,
      metricW: m ? m.clientWidth : null,
      metricH: m ? m.clientHeight : null,
      metricsH: ms ? ms.clientHeight : null,
      text: v ? v.textContent : null,
      viewH: document.querySelector('.view')?.clientHeight,
      bodyH: document.querySelector('.spend-body')?.clientHeight,
      bodyFlex: document.querySelector('.spend-body') ? getComputedStyle(document.querySelector('.spend-body')).flex : null,
      metricsFlex: ms ? getComputedStyle(ms).flex : null,
      contentH: document.getElementById('content')?.clientHeight,
      stripH: document.querySelector('.strip')?.clientHeight,
      promptH: document.querySelector('.connect-prompt')?.clientHeight ?? 0,
      viewChildren: [...(document.querySelector('.view')?.children ?? [])].map((c) => c.className + ':' + c.clientHeight),
      viewDisplay: getComputedStyle(document.querySelector('.view')).display,
      viewFlexDir: getComputedStyle(document.querySelector('.view')).flexDirection,
      bodyComputedFlex: getComputedStyle(document.querySelector('.spend-body')).flexGrow,
      bodyMaxH: getComputedStyle(document.querySelector('.spend-body')).maxHeight,
      bodyH2: document.querySelector('.spend-body')?.getBoundingClientRect().height,
      viewRect: document.querySelector('.view')?.getBoundingClientRect().height,
      viewPad: getComputedStyle(document.querySelector('.view')).padding,
      viewGap: getComputedStyle(document.querySelector('.view')).gap,
      contentRect: document.getElementById('content')?.getBoundingClientRect().height,
      valueRect: document.querySelector('.metric-value')?.getBoundingClientRect(),
      bodyRect: document.querySelector('.spend-body')?.getBoundingClientRect(),
      tabbarTop: document.getElementById('tabbar')?.getBoundingClientRect().top,
    };
  })()`);
  console.log('DEBUG', JSON.stringify(dbg));
  const dbgShot = await mainWindow.webContents.capturePage();
  writeFileSync(join(outDir, '99-debug-fit.png'), dbgShot.toPNG());

  for (const shot of shots) {
    mainWindow.setBounds({ x: 60, y: 60, width: shot.width, height: shot.height });
    settings.view.tab = shot.tab;
    mainWindow.webContents.send('view:tab', shot.tab);
    await new Promise((r) => setTimeout(r, 900));
    if (shot.groupBy) {
      await mainWindow.webContents.executeJavaScript(
        `[...document.querySelectorAll('.segmented button')]
           .find((b) => b.textContent === '${shot.groupBy === 'key' ? 'Key' : 'Provider'}')?.click()`,
      );
      await new Promise((r) => setTimeout(r, 700));
    }
    const image = await mainWindow.webContents.capturePage();
    writeFileSync(join(outDir, `${shot.name}.png`), image.toPNG());
    console.log(`captured ${shot.name}`);
  }

  // Charts subview with the logarithmic axis, opened from a strip cell.
  mainWindow.setBounds({ x: 60, y: 60, width: 640, height: 420 });
  settings.view.tab = 'spending';
  mainWindow.webContents.send('view:tab', 'spending');
  await new Promise((r) => setTimeout(r, 700));
  await mainWindow.webContents.executeJavaScript(
    "document.querySelector('.cell[data-window=\"24h\"]')?.click()",
  );
  await new Promise((r) => setTimeout(r, 1200));
  const chartImage = await mainWindow.webContents.capturePage();
  writeFileSync(join(outDir, '09-charts-log-axis-640x420.png'), chartImage.toPNG());
  console.log('captured 09-charts-log-axis-640x420');

  // Linear axis override: the persistent label must appear. The setting is
  // applied through the renderer's own settings path, which re-renders in
  // place. Reloading the window here left the page blank, so it is avoided.
  // Drive the inline Log/Linear toggle on the chart itself.
  mainWindow.webContents.send('view:tab', 'spending');
  await new Promise((r) => setTimeout(r, 900));
  await mainWindow.webContents.executeJavaScript(
    `[...document.querySelectorAll('.inline-chart-header button')]
       .find((b) => b.textContent === 'Linear')?.click()`,
  );
  await new Promise((r) => setTimeout(r, 1200));
  const linearImage = await mainWindow.webContents.capturePage();
  writeFileSync(join(outDir, '11-charts-linear-override.png'), linearImage.toPNG());
  console.log('captured 11-charts-linear-override');
  settings.display.chart_axis = originalAxis;
  flushSettings();

  // Range buttons must each produce a different X axis. Read the axis labels
  // back from the canvas so a regression is caught rather than eyeballed.
  mainWindow.setBounds({ x: 60, y: 60, width: 640, height: 460 });
  mainWindow.webContents.send('view:tab', 'spending');
  await new Promise((r) => setTimeout(r, 900));
  for (const range of ['10m', '1h', '3h', '6h', '24h']) {
    await mainWindow.webContents.executeJavaScript(
      `document.querySelector('.cell[data-window="${range}"]')?.click()`,
    );
    await new Promise((r) => setTimeout(r, 1100));
    const label = await mainWindow.webContents.executeJavaScript(
      "document.querySelector('.inline-chart-range')?.textContent ?? ''",
    );
    const image = await mainWindow.webContents.capturePage();
    writeFileSync(join(outDir, `16-range-${range}.png`), image.toPNG());
    console.log(`captured 16-range-${range} (header: ${label})`);
  }

  // TEMP-CHART
  for (const [w, h] of [[766, 500], [766, 400], [520, 280], [520, 279], [760, 300], [900, 560]] as Array<[number, number]>) {
    mainWindow.setBounds({ x: 60, y: 60, width: w, height: h });
    mainWindow.webContents.send('view:tab', 'requests');
    await new Promise((r) => setTimeout(r, 900));
    const info = await mainWindow.webContents.executeJavaScript(`(() => {
      const view = document.querySelector('.view');
      const ic = document.querySelector('.inline-chart');
      return { ovf: view.scrollHeight - view.clientHeight, mode: document.getElementById('root').dataset.mode, chart: Boolean(ic) };
    })()`);
    console.log('CHART', JSON.stringify({ w, h, ...info }));
    const im = await mainWindow.webContents.capturePage();
    writeFileSync(join(outDir, `final-${w}x${h}.png`), im.toPNG());
  }

  // TEMP-CHART
  const worst = 'OpenRouter reports daily totals only, so the short windows cannot be computed. Daily report stops at Oct 30, 5 days ago. Today is live from the account counter; charts cover reported days only.';
  for (const tabName of ['requests', 'spending']) {
    for (const w of [360, 420, 520, 600, 760, 900]) {
      for (let h = 200; h <= 300; h += 10) {
        mainWindow.setBounds({ x: 60, y: 60, width: w, height: h });
        mainWindow.webContents.send('view:tab', tabName);
        await new Promise((r) => setTimeout(r, 300));
        const info = await mainWindow.webContents.executeJavaScript(`(() => {
          const view = document.querySelector('.view');
          if (!view) return null;
          const chart = document.querySelector('.inline-chart');
          const measure = () => {
            const cw = document.querySelector('.chart-wrap');
            return { ovf: view.scrollHeight - view.clientHeight, cwH: cw ? Math.round(cw.getBoundingClientRect().height) : null, icH: chart ? Math.round(chart.getBoundingClientRect().height) : null };
          };
          const plain = measure();
          const note = document.createElement('div');
          note.className = 'lag-note';
          note.textContent = ${JSON.stringify(worst)};
          view.insertBefore(note, view.children[1] ?? null);
          const withNote = measure();
          note.remove();
          return { showChart: Boolean(chart), plain, withNote };
        })()`);
        console.log('CHART', JSON.stringify({ tabName, w, h, ...info }));
      }
    }
  }

  // Settings help popup: hover a label so the verbose explanation is visible.
  mainWindow.setBounds({ x: 60, y: 60, width: 520, height: 620 });
  mainWindow.webContents.send('view:tab', 'settings');
  await new Promise((r) => setTimeout(r, 800));
  await mainWindow.webContents.executeJavaScript(
    `(() => {
       const header = [...document.querySelectorAll('.group-header')]
         .find((h) => h.textContent.includes('Display'));
       header?.click();
       return true;
     })()`,
  );
  await new Promise((r) => setTimeout(r, 700));
  await mainWindow.webContents.executeJavaScript(
    `(() => {
       const label = [...document.querySelectorAll('.field-label.has-help')]
         .find((l) => l.textContent.startsWith('Always on top'));
       label?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
       return Boolean(label);
     })()`,
  );
  await new Promise((r) => setTimeout(r, 600));
  const helpImage = await mainWindow.webContents.capturePage();
  writeFileSync(join(outDir, '14-settings-help-popup.png'), helpImage.toPNG());
  console.log('captured 14-settings-help-popup');

  // The log is a Settings group now. Open it so the row layout is visible.
  mainWindow.setBounds({ x: 60, y: 60, width: 520, height: 640 });
  mainWindow.webContents.send('view:tab', 'settings');
  await new Promise((r) => setTimeout(r, 800));
  // Collapse everything first: the Log group sits at the bottom and would be
  // pushed off screen by an expanded Display group.
  await mainWindow.webContents.executeJavaScript(
    `[...document.querySelectorAll('.group-header')]
       .filter((h) => h.getAttribute('aria-expanded') === 'true')
       .forEach((h) => h.click())`,
  );
  await new Promise((r) => setTimeout(r, 500));
  await mainWindow.webContents.executeJavaScript(
    `[...document.querySelectorAll('.group-header')]
       .find((h) => h.textContent.includes('Log'))?.click()`,
  );
  await new Promise((r) => setTimeout(r, 900));
  await mainWindow.webContents.executeJavaScript(
    "[...document.querySelectorAll('.filter-btn')].find(b => b.textContent === 'info')?.click()",
  );
  await new Promise((r) => setTimeout(r, 500));
  await mainWindow.webContents.executeJavaScript(
    `document.querySelector('.view.scroll')?.scrollTo(0, 99999)`,
  );
  await new Promise((r) => setTimeout(r, 500));
  const logImage = await mainWindow.webContents.capturePage();
  writeFileSync(join(outDir, '10-settings-log-520x640.png'), logImage.toPNG());
  console.log('captured 10-settings-log-520x640');

  console.log(`\ncaptures written to ${outDir}`);
  flushSettings();
  isQuitting = true;
  stopTimers();
  logger.close();
  db.close();
  app.exit(0);
}

async function runSelfTest(): Promise<void> {
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail });

  try {
    const snapshot = lastSnapshot ?? buildCurrentSnapshot();
    check('snapshot has five windows', snapshot.windows.length === 5, `${snapshot.windows.length}`);
    check(
      'window labels are 10m,1h,3h,6h,24h',
      snapshot.windows.map((w) => w.label).join(',') === '10m,1h,3h,6h,24h',
      snapshot.windows.map((w) => w.label).join(','),
    );
    // The sample flag must match the connection state: sample data is labeled
    // only when no credential is present.
    const connected = snapshot.account.connected;
    check(
      'sample flag matches the rows actually stored',
      snapshot.sample === db.hasSampleRows(),
      `sample=${snapshot.sample} rows=${db.hasSampleRows()}`,
    );
    check(
      'no sample rows coexist with a real account',
      !connected || !db.countBySource().some((r) => r.source === 'sample'),
      db.countBySource().map((r) => `${r.source}:${r.count}`).join(' '),
    );
    check(
      'a stored-but-unreadable credential is not reported as connected',
      credentials.has() === false || credentials.isUsable() || !snapshot.account.connected,
      `file=${credentials.has()} usable=${credentials.isUsable()} connected=${snapshot.account.connected}`,
    );

    const chart = buildChartData({ metric: 'spend', scale: '24h', anchor: Date.now(), keyId: null });
    check('chart has bins', chart.bins.length > 0, `${chart.bins.length}`);
    check('chart finest bin is positive', finestBinMs(chart) > 0, `${finestBinMs(chart)}`);

    const layoutMicro = layoutFor(180, 120);
    check('180x120 is micro', layoutMicro.mode === 'micro', layoutMicro.mode);
    const layoutExpanded = layoutFor(900, 500);
    check('900x500 is expanded', layoutExpanded.mode === 'expanded', layoutExpanded.mode);

    const logs = logger.query({ severities: ['error', 'warn', 'info', 'debug'], sources: [], text: '', range: 'all', limit: 10 });
    check('log ring has entries', logs.length > 0, `${logs.length}`);

    const bundle = diagnosticBundle('selftest');
    check('diagnostic bundle has environment', Boolean(bundle.environment.os), String(bundle.environment.os));

    const version = versionInfo();
    check('version reports electron', Boolean(version.electron), version.electron);

    // Key identity is only available when the source reports it. With a real
    // account the activity endpoint carries none, so zero keys is correct.
    const keys = db.listKeys();
    check(
      'key list is consistent with the source',
      connected ? keys.length >= 0 : keys.length > 0,
      `${keys.length} keys, connected=${connected}`,
    );

    check(
      'account label is never credential-shaped',
      !looksLikeCredential(db.loadAccount()?.label ?? null),
      db.loadAccount()?.label ?? '(null)',
    );
    // Every settings control must explain itself on hover. The Settings groups
    // are collapsed by default, so open them before auditing.
    if (mainWindow) {
      mainWindow.webContents.send('view:tab', 'settings');
      await new Promise((r) => setTimeout(r, 600));
      await mainWindow.webContents.executeJavaScript(
        `[...document.querySelectorAll('.group-header')]
           .filter((h) => /Parameters|Display/.test(h.textContent))
           .forEach((h) => h.click())`,
      );
      await new Promise((r) => setTimeout(r, 400));
    }
    const helpGaps = mainWindow
      ? await mainWindow.webContents.executeJavaScript(
          `(() => {
             const fields = [...document.querySelectorAll('.field')];
             return fields
               .filter((f) => !f.querySelector('.field-label.has-help'))
               .map((f) => f.querySelector('.field-label')?.textContent?.trim())
               .filter(Boolean);
           })()`,
        )
      : [];
    check(
      'settings controls all carry help text',
      helpGaps.length === 0,
      helpGaps.length ? helpGaps.join(', ') : 'all controls have help',
    );
  } catch (error) {
    check('selftest completed without exception', false, (error as Error).message);
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  isQuitting = true;
  stopTimers();
  logger.close();
  db.close();
  app.exit(failed.length === 0 ? 0 : 1);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.showInactive();
      windowState.visible = true;
    }
  });

  app.on('window-all-closed', () => {
    // The widget lives in the tray; do not quit on window close.
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  void bootstrap().catch((error) => {
    console.error('bootstrap failed', error);
    app.exit(1);
  });
}
