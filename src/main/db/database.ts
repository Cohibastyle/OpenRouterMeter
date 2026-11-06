import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SCHEMA_VERSION } from '../../shared/constants.js';
import type { RequestRecord, KeyRecord, LogEntry, WindowCell } from '../../shared/types.js';

export interface DbOptions {
  file: string;
  logger?: { info: (s: 'db', m: string) => void; error: (s: 'db', m: string, c?: string) => void };
}

const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS account (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        label TEXT,
        last4 TEXT,
        saved_at TEXT,
        state TEXT NOT NULL DEFAULT 'not_connected',
        capabilities TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_key (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        historical_name TEXT,
        last4 TEXT,
        removed INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS request (
        id TEXT PRIMARY KEY,
        event_time TEXT NOT NULL,
        received_time TEXT NOT NULL,
        key_id TEXT,
        key_name TEXT,
        model TEXT,
        status TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        cost_micro INTEGER,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_request_event_time ON request(event_time DESC);
      CREATE INDEX IF NOT EXISTS idx_request_key ON request(key_id, event_time DESC);

      CREATE TABLE IF NOT EXISTS aggregate_bin (
        source TEXT NOT NULL,
        scope TEXT NOT NULL,
        metric TEXT NOT NULL,
        interval TEXT NOT NULL,
        bin_start TEXT NOT NULL,
        bin_end TEXT NOT NULL,
        value INTEGER,
        completeness TEXT NOT NULL,
        revision_time TEXT NOT NULL,
        PRIMARY KEY (source, scope, metric, interval, bin_start)
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS window_cache (
        scope TEXT NOT NULL,
        metric TEXT NOT NULL,
        window_key TEXT NOT NULL,
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        value INTEGER,
        coverage TEXT NOT NULL,
        computed_at TEXT NOT NULL,
        PRIMARY KEY (scope, metric, window_key)
      );

      CREATE TABLE IF NOT EXISTS app_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        severity TEXT NOT NULL,
        source TEXT NOT NULL,
        code TEXT,
        message TEXT NOT NULL,
        correlation_id TEXT,
        redacted INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS diagnostic_snapshot (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        captured_at TEXT NOT NULL,
        trigger TEXT NOT NULL,
        payload TEXT NOT NULL,
        schema_version INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS collector_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cursor TEXT,
        last_success TEXT,
        retry_at TEXT,
        error_code TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS known_gap (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gap_start TEXT NOT NULL,
        gap_end TEXT NOT NULL,
        reason TEXT NOT NULL
      );
    `,
  },
  {
    // Records the range each granularity was actually fetched for. Coverage
    // cannot be inferred from the rows themselves: an hour with no activity
    // produces no row, which means zero spend, not missing data.
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS collection_range (
        granularity_ms INTEGER PRIMARY KEY,
        range_start TEXT NOT NULL,
        range_end TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
    `,
  },
  {
    // The credits endpoint exposes a live cumulative usage counter. Sampling it
    // lets the widget report exact spend for the current day even while the
    // daily activity feed lags by several days.
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS usage_sample (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sampled_at TEXT NOT NULL,
        total_usage_micro INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_sample_at ON usage_sample(sampled_at);
    `,
  },
];

export class Database {
  private db: DatabaseSync;
  readonly file: string;

  constructor(options: DbOptions) {
    this.file = options.file;
    mkdirSync(dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate(options.logger);
  }

  private migrate(logger?: DbOptions['logger']): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined;
    const current = row ? Number(row.value) : 0;

    if (current >= SCHEMA_VERSION) return;

    if (current > 0 && existsSync(this.file)) {
      const backup = `${this.file}.backup-v${current}`;
      try {
        copyFileSync(this.file, backup);
        logger?.info('db', `backed up database to ${backup} before migration`);
      } catch {
        logger?.error('db', 'database backup before migration failed', 'db_backup_failed');
      }
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.db.exec('BEGIN');
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run('schema_version', String(migration.version));
        this.db
          .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run('last_migration', new Date().toISOString());
        this.db.exec('COMMIT');
        logger?.info('db', `applied schema migration v${migration.version}`);
      } catch (error) {
        this.db.exec('ROLLBACK');
        logger?.error('db', `migration v${migration.version} failed: ${(error as Error).message}`, 'db_migration_failed');
        throw error;
      }
    }
  }

  schemaVersion(): number {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : 0;
  }

  lastMigration(): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('last_migration') as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  upsertRequest(record: RequestRecord): void {
    this.db
      .prepare(
        `INSERT INTO request (id, event_time, received_time, key_id, key_name, model, status,
           input_tokens, output_tokens, total_tokens, cost_micro, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           event_time = excluded.event_time,
           key_name = excluded.key_name,
           model = excluded.model,
           status = excluded.status,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           total_tokens = excluded.total_tokens,
           cost_micro = excluded.cost_micro,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.event_time,
        record.received_time,
        record.key_id,
        record.key_name,
        record.model,
        record.status,
        record.input_tokens,
        record.output_tokens,
        record.total_tokens,
        record.cost_micro,
        record.source,
        new Date().toISOString(),
      );
  }

  listRequests(limit: number, keyId?: string | null): RequestRecord[] {
    const rows = keyId
      ? this.db
          .prepare('SELECT * FROM request WHERE key_id = ? ORDER BY event_time DESC LIMIT ?')
          .all(keyId, limit)
      : this.db.prepare('SELECT * FROM request ORDER BY event_time DESC LIMIT ?').all(limit);
    return (rows as unknown as RequestRecord[]).map(normalizeRequest);
  }

  requestsSince(sinceIso: string, keyId?: string | null): RequestRecord[] {
    const rows = keyId
      ? this.db
          .prepare('SELECT * FROM request WHERE event_time > ? AND key_id = ? ORDER BY event_time DESC')
          .all(sinceIso, keyId)
      : this.db.prepare('SELECT * FROM request WHERE event_time > ? ORDER BY event_time DESC').all(sinceIso);
    return (rows as unknown as RequestRecord[]).map(normalizeRequest);
  }

  latestRequest(keyId?: string | null): RequestRecord | null {
    const rows = this.listRequests(1, keyId);
    return rows[0] ?? null;
  }

  countRequests(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM request').get() as { n: number };
    return row.n;
  }

  /** True when any generated example row is stored. */
  hasSampleRows(): boolean {
    const row = this.db
      .prepare("SELECT 1 AS present FROM request WHERE source = 'sample' LIMIT 1")
      .get() as { present?: number } | undefined;
    return row?.present === 1;
  }

  latestRequestTime(): string | null {
    const row = this.db.prepare('SELECT MAX(event_time) AS t FROM request').get() as { t: string | null };
    return row.t;
  }

  oldestRequestTime(): string | null {
    const row = this.db.prepare('SELECT MIN(event_time) AS t FROM request').get() as { t: string | null };
    return row.t;
  }

  upsertKey(key: KeyRecord): void {
    this.db
      .prepare(
        `INSERT INTO api_key (id, name, historical_name, last4, removed, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           historical_name = COALESCE(api_key.historical_name, excluded.historical_name),
           last4 = excluded.last4,
           removed = excluded.removed,
           updated_at = excluded.updated_at`,
      )
      .run(key.id, key.name, key.name, key.last4, key.removed ? 1 : 0, new Date().toISOString());
  }

  listKeys(): KeyRecord[] {
    const rows = this.db.prepare('SELECT * FROM api_key ORDER BY name').all() as unknown as Array<{
      id: string;
      name: string;
      last4: string | null;
      removed: number;
    }>;
    return rows.map((r) => ({ id: r.id, name: r.name, last4: r.last4, removed: r.removed === 1 }));
  }

  saveSettings(json: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run('app', json, new Date().toISOString());
  }

  loadSettings(): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('app') as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  saveWindowCache(scope: string, metric: string, cells: ReadonlyArray<WindowCell>): void {
    const stmt = this.db.prepare(
      `INSERT INTO window_cache (scope, metric, window_key, window_start, window_end, value, coverage, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, metric, window_key) DO UPDATE SET
         window_start = excluded.window_start,
         window_end = excluded.window_end,
         value = excluded.value,
         coverage = excluded.coverage,
         computed_at = excluded.computed_at`,
    );
    for (const cell of cells) {
      const value = metric === 'spend' ? cell.spend_micro : cell.total_tokens;
      stmt.run(scope, metric, cell.key, cell.window_start, cell.window_end, value, cell.coverage, cell.as_of);
    }
  }

  saveLogEntry(entry: LogEntry): void {
    this.db
      .prepare(
        `INSERT INTO app_log (timestamp, severity, source, code, message, correlation_id, redacted)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.timestamp,
        entry.severity,
        entry.source,
        entry.code,
        entry.message,
        entry.correlation_id,
        entry.redacted ? 1 : 0,
      );
  }

  saveDiagnostic(trigger: string, payload: string, schemaVersion: number): void {
    this.db
      .prepare('INSERT INTO diagnostic_snapshot (captured_at, trigger, payload, schema_version) VALUES (?, ?, ?, ?)')
      .run(new Date().toISOString(), trigger, payload, schemaVersion);
  }

  saveCollectorState(state: {
    cursor: string | null;
    last_success: string | null;
    retry_at: string | null;
    error_code: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO collector_state (id, cursor, last_success, retry_at, error_code, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           cursor = excluded.cursor,
           last_success = excluded.last_success,
           retry_at = excluded.retry_at,
           error_code = excluded.error_code,
           updated_at = excluded.updated_at`,
      )
      .run(state.cursor, state.last_success, state.retry_at, state.error_code, new Date().toISOString());
  }

  loadCollectorState(): {
    cursor: string | null;
    last_success: string | null;
    retry_at: string | null;
    error_code: string | null;
  } {
    const row = this.db.prepare('SELECT * FROM collector_state WHERE id = 1').get() as
      | { cursor: string | null; last_success: string | null; retry_at: string | null; error_code: string | null }
      | undefined;
    return row ?? { cursor: null, last_success: null, retry_at: null, error_code: null };
  }

  saveAccount(account: {
    label: string | null;
    last4: string | null;
    saved_at: string | null;
    state: string;
    capabilities: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO account (id, label, last4, saved_at, state, capabilities, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           last4 = excluded.last4,
           saved_at = excluded.saved_at,
           state = excluded.state,
           capabilities = excluded.capabilities,
           updated_at = excluded.updated_at`,
      )
      .run(account.label, account.last4, account.saved_at, account.state, account.capabilities, new Date().toISOString());
  }

  loadAccount(): {
    label: string | null;
    last4: string | null;
    saved_at: string | null;
    state: string;
  } | null {
    const row = this.db.prepare('SELECT * FROM account WHERE id = 1').get() as
      | { label: string | null; last4: string | null; saved_at: string | null; state: string }
      | undefined;
    return row ?? null;
  }

  /**
   * Record a cumulative account-usage reading. The credits endpoint returns a
   * live counter, so the difference between two readings is exact spend for the
   * interval between them, even while the daily activity feed lags.
   */
  recordUsageSample(totalUsageMicro: number): void {
    this.db
      .prepare('INSERT INTO usage_sample (sampled_at, total_usage_micro) VALUES (?, ?)')
      .run(new Date().toISOString(), totalUsageMicro);
  }

  /** Samples at or after the given instant, oldest first. */
  listUsageSamples(sinceIso: string): Array<{ sampled_at: string; total_usage_micro: number }> {
    return this.db
      .prepare(
        'SELECT sampled_at, total_usage_micro FROM usage_sample WHERE sampled_at >= ? ORDER BY sampled_at ASC',
      )
      .all(sinceIso) as Array<{ sampled_at: string; total_usage_micro: number }>;
  }

  /** Earliest sample at or after the given instant, or null. */
  firstUsageSampleSince(sinceIso: string): { sampled_at: string; total_usage_micro: number } | null {
    const row = this.db
      .prepare(
        'SELECT sampled_at, total_usage_micro FROM usage_sample WHERE sampled_at >= ? ORDER BY sampled_at ASC LIMIT 1',
      )
      .get(sinceIso) as { sampled_at: string; total_usage_micro: number } | undefined;
    return row ?? null;
  }

  /** Latest sample overall, or null. */
  latestUsageSample(): { sampled_at: string; total_usage_micro: number } | null {
    const row = this.db
      .prepare('SELECT sampled_at, total_usage_micro FROM usage_sample ORDER BY sampled_at DESC LIMIT 1')
      .get() as { sampled_at: string; total_usage_micro: number } | undefined;
    return row ?? null;
  }

  /** True when a sample exists at or before the given instant. */
  hasUsageSampleBefore(instantIso: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS x FROM usage_sample WHERE sampled_at <= ? LIMIT 1')
      .get(instantIso) as { x: number } | undefined;
    return row !== undefined;
  }

  pruneUsageSamples(olderThanIso: string): number {
    return Number(
      this.db.prepare('DELETE FROM usage_sample WHERE sampled_at < ?').run(olderThanIso).changes ?? 0,
    );
  }

  addGap(startIso: string, endIso: string, reason: string): void {
    this.db
      .prepare('INSERT INTO known_gap (gap_start, gap_end, reason) VALUES (?, ?, ?)')
      .run(startIso, endIso, reason);
  }

  listGaps(): Array<[number, number]> {
    const rows = this.db.prepare('SELECT gap_start, gap_end FROM known_gap').all() as unknown as Array<{
      gap_start: string;
      gap_end: string;
    }>;
    return rows.map((r) => [new Date(r.gap_start).getTime(), new Date(r.gap_end).getTime()]);
  }

  storageStats(): {
    path: string;
    size_bytes: number;
    request_rows: number;
    aggregate_rows: number;
    oldest_record: string | null;
  } {
    const requestRows = (this.db.prepare('SELECT COUNT(*) AS n FROM request').get() as { n: number }).n;
    const aggregateRows = (this.db.prepare('SELECT COUNT(*) AS n FROM aggregate_bin').get() as { n: number }).n;
    const oldest = (this.db.prepare('SELECT MIN(event_time) AS t FROM request').get() as { t: string | null }).t;
    let size = 0;
    try {
      size = existsSync(this.file) ? statSync(this.file).size : 0;
    } catch {
      size = 0;
    }
    return {
      path: this.file,
      size_bytes: size,
      request_rows: requestRows,
      aggregate_rows: aggregateRows,
      oldest_record: oldest,
    };
  }

  vacuum(): void {
    this.db.exec('VACUUM;');
  }

  clearAll(): void {
    this.db.exec('BEGIN');
    try {
      for (const table of [
        'request',
        'aggregate_bin',
        'window_cache',
        'app_log',
        'diagnostic_snapshot',
        'known_gap',
        'usage_sample',
        'api_key',
        'collector_state',
        'account',
      ]) {
        this.db.exec(`DELETE FROM ${table};`);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Remove every sample row. Called when a real account connects, so sample
   * data can never be summed with real data.
   */
  purgeSampleData(): { requests: number; keys: number } {
    const requests = Number(
      this.db.prepare("DELETE FROM request WHERE source = 'sample'").run().changes ?? 0,
    );
    const keys = Number(
      this.db.prepare("DELETE FROM api_key WHERE id LIKE 'key_%'").run().changes ?? 0,
    );
    this.db.prepare("DELETE FROM window_cache").run();
    return { requests, keys };
  }

  /** Record the range a granularity was fetched for. */
  recordCollectionRange(granularityMs: number, startIso: string, endIso: string): void {
    this.db
      .prepare(
        `INSERT INTO collection_range (granularity_ms, range_start, range_end, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(granularity_ms) DO UPDATE SET
           range_start = excluded.range_start,
           range_end = excluded.range_end,
           fetched_at = excluded.fetched_at`,
      )
      .run(granularityMs, startIso, endIso, new Date().toISOString());
  }

  /** Every recorded collection range, keyed by granularity. */
  listCollectionRanges(): Array<{ granularity_ms: number; range_start: string; range_end: string }> {
    return this.db
      .prepare('SELECT granularity_ms, range_start, range_end FROM collection_range')
      .all() as unknown as Array<{ granularity_ms: number; range_start: string; range_end: string }>;
  }

  /**
   * Remove rows written by a superseded collector. The activity feed stopped
   * several days behind and carried no key identity, so its rows would
   * otherwise sit alongside the live analytics rows and double-count.
   */
  purgeSource(source: string): number {
    const removed = Number(
      this.db.prepare('DELETE FROM request WHERE source = ?').run(source).changes ?? 0,
    );
    if (removed > 0) this.db.prepare('DELETE FROM window_cache').run();
    return removed;
  }

  countBySource(): Array<{ source: string; count: number }> {
    return this.db
      .prepare('SELECT source, COUNT(*) AS count FROM request GROUP BY source ORDER BY count DESC')
      .all() as unknown as Array<{ source: string; count: number }>;
  }

  pruneRequests(olderThanIso: string): number {
    const result = this.db.prepare('DELETE FROM request WHERE event_time < ?').run(olderThanIso);
    return Number(result.changes ?? 0);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed.
    }
  }
}

function normalizeRequest(row: unknown): RequestRecord {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    event_time: String(r.event_time),
    received_time: String(r.received_time),
    key_id: (r.key_id as string | null) ?? null,
    key_name: (r.key_name as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    status: (r.status as string | null) ?? null,
    input_tokens: (r.input_tokens as number | null) ?? null,
    output_tokens: (r.output_tokens as number | null) ?? null,
    total_tokens: (r.total_tokens as number | null) ?? null,
    cost_micro: (r.cost_micro as number | null) ?? null,
    source: String(r.source ?? 'unknown'),
  };
}

export function defaultDbPath(userData: string): string {
  return join(userData, 'widget.db');
}
