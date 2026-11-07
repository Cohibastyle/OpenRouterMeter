//! SQLite storage, ported from src/main/db/database.ts.
//!
//! The schema is identical, including the migration versions, so a database
//! written by the Electron build opens here without conversion. `node:sqlite`
//! returns plain objects; `rusqlite` needs explicit row mapping, which is why
//! this file is longer than the TypeScript it replaces.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

const MIGRATIONS: &[(i64, &str)] = &[
    (
        1,
        r#"
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS account (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          label TEXT, last4 TEXT, saved_at TEXT,
          state TEXT NOT NULL DEFAULT 'not_connected',
          capabilities TEXT, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS api_key (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, historical_name TEXT, last4 TEXT,
          removed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS request (
          id TEXT PRIMARY KEY, event_time TEXT NOT NULL, received_time TEXT NOT NULL,
          key_id TEXT, key_name TEXT, model TEXT, status TEXT,
          input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
          cost_micro INTEGER, source TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_request_event_time ON request(event_time DESC);
        CREATE INDEX IF NOT EXISTS idx_request_key ON request(key_id, event_time DESC);
        CREATE TABLE IF NOT EXISTS aggregate_bin (
          source TEXT NOT NULL, scope TEXT NOT NULL, metric TEXT NOT NULL,
          interval TEXT NOT NULL, bin_start TEXT NOT NULL, bin_end TEXT NOT NULL,
          value INTEGER, completeness TEXT NOT NULL, revision_time TEXT NOT NULL,
          PRIMARY KEY (source, scope, metric, interval, bin_start)
        );
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS window_cache (
          scope TEXT NOT NULL, metric TEXT NOT NULL, window_key TEXT NOT NULL,
          window_start TEXT NOT NULL, window_end TEXT NOT NULL, value INTEGER,
          coverage TEXT NOT NULL, computed_at TEXT NOT NULL,
          PRIMARY KEY (scope, metric, window_key)
        );
        CREATE TABLE IF NOT EXISTS app_log (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
          severity TEXT NOT NULL, source TEXT NOT NULL, code TEXT,
          message TEXT NOT NULL, correlation_id TEXT,
          redacted INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS diagnostic_snapshot (
          id INTEGER PRIMARY KEY AUTOINCREMENT, captured_at TEXT NOT NULL,
          trigger TEXT NOT NULL, payload TEXT NOT NULL, schema_version INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS collector_state (
          id INTEGER PRIMARY KEY CHECK (id = 1), cursor TEXT, last_success TEXT,
          retry_at TEXT, error_code TEXT, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS known_gap (
          id INTEGER PRIMARY KEY AUTOINCREMENT, gap_start TEXT NOT NULL,
          gap_end TEXT NOT NULL, reason TEXT NOT NULL
        );
        "#,
    ),
    (
        2,
        r#"
        CREATE TABLE IF NOT EXISTS usage_sample (
          id INTEGER PRIMARY KEY AUTOINCREMENT, sampled_at TEXT NOT NULL,
          total_usage_micro INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_usage_sample_at ON usage_sample(sampled_at);
        "#,
    ),
    (
        3,
        r#"
        CREATE TABLE IF NOT EXISTS collection_range (
          granularity_ms INTEGER PRIMARY KEY, range_start TEXT NOT NULL,
          range_end TEXT NOT NULL, fetched_at TEXT NOT NULL
        );
        "#,
    ),
    (
        4,
        r#"
        ALTER TABLE request ADD COLUMN request_count INTEGER;
        "#,
    ),
];

pub struct Db {
    conn: Connection,
    path: PathBuf,
}

impl Db {
    pub fn open(dir: &Path) -> rusqlite::Result<Self> {
        std::fs::create_dir_all(dir).ok();
        let path = dir.join("widget.db");
        let conn = Connection::open(&path)?;
        // `journal_mode` returns the resulting mode, so it must be read as a row;
        // `pragma_update` treats a returned row as an error.
        let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db = Self { conn, path };
        db.migrate()?;
        Ok(db)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn migrate(&self) -> rusqlite::Result<()> {
        // `meta` holds the schema version, so it must exist before it is read.
        self.conn
            .execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);")?;

        let current: i64 = self
            .conn
            .query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| {
                r.get::<_, String>(0)
            })
            .optional()?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

        for (version, sql) in MIGRATIONS {
            if *version <= current {
                continue;
            }
            self.conn.execute_batch(sql)?;
            self.conn.execute(
                "INSERT INTO meta (key, value) VALUES ('schema_version', ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![version.to_string()],
            )?;
        }
        Ok(())
    }

    pub fn count_requests(&self) -> i64 {
        self.conn
            .query_row("SELECT COUNT(*) FROM request", [], |r| r.get(0))
            .unwrap_or(0)
    }

    pub fn has_sample_rows(&self) -> bool {
        self.conn
            .query_row("SELECT COUNT(*) FROM request WHERE source = 'sample'", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap_or(0)
            > 0
    }

    /// Insert request rows in one transaction. Returns the number written.
    pub fn insert_requests(&mut self, rows: &[Value]) -> rusqlite::Result<usize> {
        let tx = self.conn.transaction()?;
        let mut written = 0;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO request (
                   id, event_time, received_time, key_id, key_name, model, status,
                   input_tokens, output_tokens, total_tokens, cost_micro, request_count,
                   source, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                   event_time = excluded.event_time,
                   received_time = excluded.received_time,
                   key_id = excluded.key_id,
                   key_name = excluded.key_name,
                   model = excluded.model,
                   status = excluded.status,
                   input_tokens = excluded.input_tokens,
                   output_tokens = excluded.output_tokens,
                   total_tokens = excluded.total_tokens,
                   cost_micro = excluded.cost_micro,
                   request_count = excluded.request_count,
                   source = excluded.source,
                   updated_at = excluded.updated_at",
            )?;
            for row in rows {
                stmt.execute(params![
                    row["id"].as_str(),
                    row["event_time"].as_str(),
                    row["received_time"].as_str(),
                    row["key_id"].as_str(),
                    row["key_name"].as_str(),
                    row["model"].as_str(),
                    row["status"].as_str(),
                    row["input_tokens"].as_i64(),
                    row["output_tokens"].as_i64(),
                    row["total_tokens"].as_i64(),
                    row["cost_micro"].as_i64(),
                    row["request_count"].as_i64(),
                    row["source"].as_str().unwrap_or("sample"),
                    row["received_time"].as_str(),
                ])?;
                written += 1;
            }
        }
        tx.commit()?;
        Ok(written)
    }

    pub fn list_requests(&self, limit: usize, key_id: Option<&str>) -> Vec<Value> {
        let sql = match key_id {
            Some(_) => {
                "SELECT id, event_time, received_time, key_id, key_name, model, status,
                        input_tokens, output_tokens, total_tokens, cost_micro, request_count, source
                 FROM request WHERE key_id = ?1 ORDER BY event_time DESC LIMIT ?2"
            }
            None => {
                "SELECT id, event_time, received_time, key_id, key_name, model, status,
                        input_tokens, output_tokens, total_tokens, cost_micro, request_count, source
                 FROM request ORDER BY event_time DESC LIMIT ?1"
            }
        };

        let map = |r: &rusqlite::Row<'_>| -> rusqlite::Result<Value> {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "event_time": r.get::<_, String>(1)?,
                "received_time": r.get::<_, String>(2)?,
                "key_id": r.get::<_, Option<String>>(3)?,
                "key_name": r.get::<_, Option<String>>(4)?,
                "model": r.get::<_, Option<String>>(5)?,
                "status": r.get::<_, Option<String>>(6)?,
                "input_tokens": r.get::<_, Option<i64>>(7)?,
                "output_tokens": r.get::<_, Option<i64>>(8)?,
                "total_tokens": r.get::<_, Option<i64>>(9)?,
                "cost_micro": r.get::<_, Option<i64>>(10)?,
                "request_count": r.get::<_, Option<i64>>(11)?,
                "source": r.get::<_, String>(12)?,
            }))
        };

        let mut out = Vec::new();
        let result = match key_id {
            Some(id) => {
                let mut stmt = match self.conn.prepare(sql) {
                    Ok(s) => s,
                    Err(_) => return out,
                };
                let rows = stmt.query_map(params![id, limit as i64], map);
                rows.map(|r| r.filter_map(|v| v.ok()).collect())
            }
            None => {
                let mut stmt = match self.conn.prepare(sql) {
                    Ok(s) => s,
                    Err(_) => return out,
                };
                let rows = stmt.query_map(params![limit as i64], map);
                rows.map(|r| r.filter_map(|v| v.ok()).collect())
            }
        };
        if let Ok(rows) = result {
            out = rows;
        }
        out
    }

    pub fn list_keys(&self) -> Vec<Value> {
        let mut stmt = match self.conn.prepare(
            "SELECT id, name, removed, last4 FROM api_key ORDER BY name",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "removed": r.get::<_, i64>(2)? != 0,
                "last4": r.get::<_, Option<String>>(3)?,
            }))
        });
        rows.map(|r| r.filter_map(|v| v.ok()).collect()).unwrap_or_default()
    }

    pub fn upsert_keys(&mut self, keys: &[Value]) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO api_key (id, name, last4, removed, updated_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                   name = excluded.name, last4 = excluded.last4,
                   removed = excluded.removed, updated_at = excluded.updated_at",
            )?;
            for k in keys {
                stmt.execute(params![
                    k["id"].as_str(),
                    k["name"].as_str(),
                    k["last4"].as_str(),
                    if k["removed"].as_bool().unwrap_or(false) { 1 } else { 0 },
                    k["updated_at"].as_str().unwrap_or(""),
                ])?;
            }
        }
        tx.commit()
    }

    pub fn append_log(&self, entry: &Value) -> rusqlite::Result<i64> {
        self.conn.execute(
            "INSERT INTO app_log (timestamp, severity, source, code, message, correlation_id, redacted)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                entry["timestamp"].as_str(),
                entry["severity"].as_str().unwrap_or("info"),
                entry["source"].as_str().unwrap_or("app"),
                entry["code"].as_str(),
                entry["message"].as_str().unwrap_or(""),
                entry["correlation_id"].as_str(),
                if entry["redacted"].as_bool().unwrap_or(false) { 1 } else { 0 },
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn query_logs(&self, limit: usize) -> Vec<Value> {
        let mut stmt = match self.conn.prepare(
            "SELECT seq, timestamp, severity, source, code, message, correlation_id, redacted
             FROM app_log ORDER BY seq DESC LIMIT ?1",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![limit as i64], |r| {
            Ok(json!({
                "seq": r.get::<_, i64>(0)?,
                "timestamp": r.get::<_, String>(1)?,
                "severity": r.get::<_, String>(2)?,
                "source": r.get::<_, String>(3)?,
                "code": r.get::<_, Option<String>>(4)?,
                "message": r.get::<_, String>(5)?,
                "correlation_id": r.get::<_, Option<String>>(6)?,
                "redacted": r.get::<_, i64>(7)? != 0,
            }))
        });
        rows.map(|r| r.filter_map(|v| v.ok()).collect()).unwrap_or_default()
    }

    pub fn vacuum(&self) -> rusqlite::Result<()> {
        self.conn.execute_batch("VACUUM")
    }

    pub fn clear_all(&self) -> rusqlite::Result<()> {
        self.conn.execute_batch(
            "DELETE FROM request; DELETE FROM api_key; DELETE FROM app_log;
             DELETE FROM usage_sample; DELETE FROM collection_range;
             DELETE FROM known_gap; DELETE FROM window_cache;",
        )
    }
}
