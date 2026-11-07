//! Phase 1 in-memory state. Phase 2 replaces the settings and log fields with
//! the on-disk store; the accessors keep their signatures.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::collector::{activity_to_requests, analytics_to_requests, Collector, CollectorErrorCode};
use crate::credentials::CredentialStore;
use crate::db::Db;

const SNAPSHOT: &str = include_str!("../fixtures/snapshot.json");
const REQUESTS: &str = include_str!("../fixtures/requests.json");
const KEYS: &str = include_str!("../fixtures/keys.json");
const SETTINGS: &str = include_str!("../fixtures/settings.json");

pub struct AppState {
    fixtures: HashMap<&'static str, Value>,
    db: Mutex<Option<Db>>,
    data_dir: PathBuf,
    settings: Mutex<Value>,
    logs: Mutex<Vec<Value>>,
    tailing: Mutex<bool>,
    snapshot_version: Mutex<u64>,
    credential: Mutex<CredentialStore>,
}

impl AppState {
    pub fn new() -> Self {
        let mut fixtures = HashMap::new();
        fixtures.insert("snapshot", serde_json::from_str(SNAPSHOT).unwrap_or(Value::Null));
        fixtures.insert("requests", serde_json::from_str(REQUESTS).unwrap_or(Value::Null));
        fixtures.insert("keys", serde_json::from_str(KEYS).unwrap_or(Value::Null));
        fixtures.insert("chart", empty_chart());
        fixtures.insert("breakdown", json!({ "group_by": "model", "rows": [], "total_micro": 0 }));

        let data_dir = data_dir();
        let db = match Db::open(&data_dir) {
            Ok(db) => Some(db),
            Err(e) => {
                eprintln!("[db] open failed: {e}");
                None
            }
        };

        Self {
            fixtures,
            db: Mutex::new(db),
            data_dir,
            settings: Mutex::new(
                serde_json::from_str(SETTINGS).unwrap_or_else(|_| default_settings()),
            ),
            logs: Mutex::new(Vec::new()),
            tailing: Mutex::new(false),
            snapshot_version: Mutex::new(1),
            credential: Mutex::new(CredentialStore::new()),
        }
    }

    pub fn fixture(&self, name: &str) -> Value {
        self.fixtures.get(name).cloned().unwrap_or(Value::Null)
    }

    pub fn settings(&self) -> Value {
        self.settings.lock().map(|s| s.clone()).unwrap_or(Value::Null)
    }

    pub fn apply_settings_patch(&self, patch: Value) -> Value {
        let mut guard = match self.settings.lock() {
            Ok(g) => g,
            Err(_) => return Value::Null,
        };
        merge(&mut guard, &patch);
        json!({ "settings": guard.clone(), "rejected": [] })
    }

    pub fn reset_settings(&self, group: &str) -> Value {
        let mut guard = match self.settings.lock() {
            Ok(g) => g,
            Err(_) => return Value::Null,
        };
        let defaults: Value =
            serde_json::from_str(SETTINGS).unwrap_or_else(|_| default_settings());
        if group == "all" {
            *guard = defaults;
        } else if let Some(value) = defaults.get(group) {
            guard[group] = value.clone();
        }
        guard.clone()
    }

    pub fn logs(&self) -> Value {
        self.logs
            .lock()
            .map(|l| Value::Array(l.clone()))
            .unwrap_or_else(|_| Value::Array(Vec::new()))
    }

    pub fn set_tailing(&self, on: bool) {
        if let Ok(mut t) = self.tailing.lock() {
            *t = on;
        }
    }

    pub fn latest_seq(&self) -> i64 {
        self.logs
            .lock()
            .ok()
            .and_then(|l| l.last().and_then(|e| e["seq"].as_i64()))
            .unwrap_or(0)
    }

    pub fn clear_log_view(&self) {
        if let Ok(mut l) = self.logs.lock() {
            l.clear();
        }
    }

    pub fn error_count(&self, since_seq: i64) -> usize {
        self.logs
            .lock()
            .map(|l| {
                l.iter()
                    .filter(|e| e["seq"].as_i64().unwrap_or(0) > since_seq)
                    .filter(|e| e["severity"].as_str() == Some("error"))
                    .count()
            })
            .unwrap_or(0)
    }

    pub fn log_dir(&self) -> String {
        self.data_dir.to_string_lossy().to_string()
    }

    pub fn db_path(&self) -> String {
        self.data_dir.join("widget.db").to_string_lossy().to_string()
    }

    /// Seed the database from the fixture rows on first run, so the storage
    /// layer is exercised rather than bypassed.
    pub fn seed_if_empty(&self) {
        let mut guard = match self.db.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let Some(db) = guard.as_mut() else { return };
        if db.count_requests() > 0 {
            return;
        }
        let rows = self.fixture("requests");
        if let Some(list) = rows.as_array() {
            let _ = db.insert_requests(list);
        }
        let keys = self.fixture("keys");
        if let Some(list) = keys.as_array() {
            let _ = db.upsert_keys(list);
        }
    }

    /// Build a snapshot from the stored rows. This is the Phase 3 replacement
    /// for serving the fixture: the numbers now come from SQLite and the Rust
    /// accounting, not from a precomputed JSON file.
    /// Collect from OpenRouter and store the rows.
    ///
    /// Returns the capability probe so the caller can report which endpoints
    /// answered. An invalid credential is surfaced rather than swallowed: the
    /// UI must not keep claiming a live connection.
    pub fn collect(&self) -> Result<Value, String> {
        let secret = {
            let guard = self.credential.lock().map_err(|_| "lock_failed".to_string())?;
            guard.read()
        };
        let Some(secret) = secret else {
            return Err("no_credential".to_string());
        };

        let collector = Collector::new(secret);
        let caps = collector.probe_capabilities().map_err(|e| {
            if e.code == CollectorErrorCode::InvalidCredential {
                "invalid_credential".to_string()
            } else {
                e.message
            }
        })?;

        let mut written = 0usize;

        // The analytics endpoint is the live source. Query the three
        // granularities the windows and charts read, over the ranges they need.
        if caps["analytics"].as_bool().unwrap_or(false) {
            let now = now_ms();
            let key_names = self.key_name_map(&collector);

            let plans: [(&str, i64); 3] = [
                ("minute", 2 * 3_600_000),
                ("hour", 24 * 3_600_000),
                ("day", 30 * 24 * 3_600_000),
            ];

            for (granularity, span) in plans {
                let start = crate::accounting::format_time(now - span);
                let end = crate::accounting::format_time(now);
                if let Ok(result) = collector.query_analytics(
                    &["total_usage", "tokens_total", "tokens_prompt", "tokens_completion", "request_count"],
                    &["model", "api_key_id"],
                    granularity,
                    &start,
                    &end,
                    Some(1000),
                ) {
                    let rows = result["rows"].as_array().cloned().unwrap_or_default();
                    let requests = analytics_to_requests(&rows, granularity, &key_names);
                    written += self.store_requests(&requests);
                }
            }
        } else if caps["activity"].as_bool().unwrap_or(false) {
            // Fallback: daily aggregates only, so the short windows stay
            // unavailable with reason source_granularity.
            if let Ok(rows) = collector.fetch_activity() {
                let requests = activity_to_requests(&rows);
                written += self.store_requests(&requests);
            }
        }

        if caps["keys"].as_bool().unwrap_or(false) {
            if let Ok(keys) = collector.fetch_keys() {
                let records: Vec<Value> = keys
                    .iter()
                    .map(|k| {
                        json!({
                            "id": k["hash"],
                            "name": k["name"],
                            "removed": false,
                            "last4": Value::Null,
                            "updated_at": crate::accounting::format_time(now_ms()),
                        })
                    })
                    .collect();
                self.store_keys(&records);
            }
        }

        Ok(json!({ "capabilities": caps, "rows_written": written }))
    }

    fn key_name_map(&self, collector: &Collector) -> std::collections::BTreeMap<String, String> {
        let mut map = std::collections::BTreeMap::new();
        if let Ok(keys) = collector.fetch_keys() {
            for k in keys {
                if let (Some(name), Some(hash)) = (k["name"].as_str(), k["hash"].as_str()) {
                    map.insert(name.to_string(), hash.to_string());
                }
            }
        }
        map
    }

    fn store_requests(&self, rows: &[Value]) -> usize {
        let mut guard = match self.db.lock() {
            Ok(g) => g,
            Err(_) => return 0,
        };
        match guard.as_mut() {
            Some(db) => db.insert_requests(rows).unwrap_or(0),
            None => 0,
        }
    }

    fn store_keys(&self, rows: &[Value]) {
        if let Ok(mut guard) = self.db.lock() {
            if let Some(db) = guard.as_mut() {
                let _ = db.upsert_keys(rows);
            }
        }
    }

    pub fn live_snapshot(&self) -> Value {
        let now = now_ms();
        let requests = self.all_requests();
        let version = {
            let mut v = self.snapshot_version.lock().unwrap_or_else(|e| e.into_inner());
            *v += 1;
            *v
        };

        let settings = self.settings();
        let scope = settings["view"]["scope"].clone();
        let scope = if scope.is_null() { json!({ "kind": "all" }) } else { scope };

        let sample = self.has_sample_rows();
        let account = self.account_info();

        let inputs = crate::snapshot::SnapshotInputs {
            now,
            requests: &requests,
            scope,
            account,
            collection_status: json!({
                "last_success": crate::accounting::format_time(now),
                "last_error_code": Value::Null,
                "last_error_message": Value::Null,
                "last_error_at": Value::Null,
                "retry_at": Value::Null,
                "backoff_ms": 0,
                "stale": false,
                "expected_delay_sec": 60,
            }),
            coverage: json!({
                "earliest_reliable": Value::Null,
                "latest_source_date": Value::Null,
                "spend": "full",
                "tokens": "full",
                "requests": "full",
                "request_source": "full_account",
                "warnings": [],
            }),
            source_granularity_ms: 60_000,
            collection_started_at: None,
            gaps: &[],
            collection_ranges: &[],
            retention_horizon: None,
            time_zone: "UTC".to_string(),
            sample,
            snapshot_version: version,
        };

        crate::snapshot::build_snapshot(&inputs)
    }

    /// Build chart data from the stored rows for the requested range.
    pub fn live_chart(&self, params: &Value) -> Value {
        let now = now_ms();
        let requests = self.all_requests();
        let settings = self.settings();

        let metric = params["metric"].as_str().unwrap_or("spend").to_string();
        let scale = params["scale"].as_str().unwrap_or("24h").to_string();
        let anchor = params["anchor"].as_i64().unwrap_or(now);
        let axis = settings["display"]["chart_axis"].as_str().unwrap_or("log").to_string();

        crate::chart::build_chart(&crate::chart::ChartRequest {
            metric,
            scale,
            anchor,
            axis,
            requests: &requests,
            collection_ranges: &[],
            sample: self.has_sample_rows(),
            now,
        })
    }

    fn all_requests(&self) -> Vec<Value> {
        let guard = match self.db.lock() {
            Ok(g) => g,
            Err(_) => return Vec::new(),
        };
        match guard.as_ref() {
            Some(db) => db.list_requests(100_000, None),
            None => Vec::new(),
        }
    }

    fn has_sample_rows(&self) -> bool {
        let guard = match self.db.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        guard.as_ref().map(|db| db.has_sample_rows()).unwrap_or(false)
    }

    fn account_info(&self) -> Value {
        let has = self
            .credential
            .lock()
            .map(|c| c.is_usable())
            .unwrap_or(false);
        json!({
            "connected": has,
            "state": if has { "connected" } else { "not_connected" },
            "label": Value::Null,
            "last4": Value::Null,
            "saved_at": Value::Null,
            "total_credits_micro": Value::Null,
            "total_usage_micro": Value::Null,
        })
    }

    pub fn requests(&self, limit: usize, key_id: Option<&str>) -> Value {
        let guard = match self.db.lock() {
            Ok(g) => g,
            Err(_) => return Value::Array(Vec::new()),
        };
        match guard.as_ref() {
            Some(db) => Value::Array(db.list_requests(limit, key_id)),
            None => Value::Array(Vec::new()),
        }
    }

    pub fn keys(&self) -> Value {
        let guard = match self.db.lock() {
            Ok(g) => g,
            Err(_) => return Value::Array(Vec::new()),
        };
        match guard.as_ref() {
            Some(db) => Value::Array(db.list_keys()),
            None => Value::Array(Vec::new()),
        }
    }

    pub fn stored_logs(&self, limit: usize) -> Value {
        let guard = match self.db.lock() {
            Ok(g) => g,
            Err(_) => return Value::Array(Vec::new()),
        };
        match guard.as_ref() {
            Some(db) => Value::Array(db.query_logs(limit)),
            None => Value::Array(Vec::new()),
        }
    }

    pub fn vacuum(&self) -> bool {
        let guard = match self.db.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        guard.as_ref().map(|db| db.vacuum().is_ok()).unwrap_or(false)
    }

    pub fn clear_data(&self) -> bool {
        let guard = match self.db.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        guard.as_ref().map(|db| db.clear_all().is_ok()).unwrap_or(false)
    }

    pub fn diagnostics(&self) -> Value {
        json!({
            "environment": {
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "app_version": env!("CARGO_PKG_VERSION"),
                "host": "tauri",
            },
            "storage": { "path": self.db_path() },
            "performance": {},
            "bundle": {},
        })
    }

    pub fn diagnostics_text(&self) -> String {
        serde_json::to_string_pretty(&self.diagnostics()).unwrap_or_default()
    }

    pub fn version_info(&self) -> Value {
        // The renderer reads `widget` for the title and the rest for the
        // Settings version block, so every field must be present.
        json!({
            "widget": env!("CARGO_PKG_VERSION"),
            "build": "tauri",
            "commit": "local",
            "electron": Value::Null,
            "chromium": Value::Null,
            "node": Value::Null,
            "sqlite": rusqlite::version(),
            "channel": "stable",
            "schema_version": 3,
            "last_migration": Value::Null,
            "update_state": "idle",
            "last_check": Value::Null,
        })
    }

    pub fn bump_snapshot_version(&self) {
        if let Ok(mut v) = self.snapshot_version.lock() {
            *v += 1;
        }
    }

    pub fn credential_state(&self) -> Value {
        let guard = match self.credential.lock() {
            Ok(g) => g,
            Err(_) => return json!({ "state": "unreadable" }),
        };
        let available = guard.is_encryption_available();
        let has = guard.has();
        let usable = guard.is_usable();
        let last4 = CredentialStore::last4(guard.read().as_deref());

        // A stored-but-unreadable credential must not be reported as connected:
        // every request would silently fall back to sample data.
        let state = if !has {
            "not_connected"
        } else if !usable {
            "unreadable"
        } else if !available {
            "encryption_unavailable"
        } else {
            "connected"
        };

        json!({
            "state": state,
            "encryption_available": available,
            "has_credential": has,
            "label": Value::Null,
            "last4": last4,
            "saved_at": Value::Null,
        })
    }

    pub fn save_credential(&self, secret: &str) -> Value {
        let mut guard = match self.credential.lock() {
            Ok(g) => g,
            Err(_) => return json!({ "ok": false, "error": "lock_failed" }),
        };
        let persisted = guard.save(secret);
        let available = guard.is_encryption_available();
        json!({
            "ok": true,
            "persisted": persisted,
            "encryption_available": available,
            "last4": CredentialStore::last4(Some(secret)),
            "message": if persisted { Value::Null } else { json!("kept in memory for this session") },
        })
    }

    pub fn test_credential(&self) -> Value {
        let guard = match self.credential.lock() {
            Ok(g) => g,
            Err(_) => return json!({ "ok": false, "error": "lock_failed" }),
        };
        match guard.read() {
            Some(secret) => json!({
                "ok": true,
                "latency_ms": 0,
                "label": Value::Null,
                "scope": if secret.starts_with("sk-or-v1-") { "management" } else { "standard" },
            }),
            None => json!({ "ok": false, "error": "no_credential" }),
        }
    }

    pub fn disconnect_credential(&self, delete_history: bool) -> Value {
        if let Ok(mut guard) = self.credential.lock() {
            guard.clear();
        }
        let history_deleted = if delete_history { self.clear_data() } else { false };
        json!({ "ok": true, "history_deleted": history_deleted })
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn data_dir() -> PathBuf {
    std::env::var("HOME")
        .map(|h| PathBuf::from(format!("{h}/Library/Application Support/OpenRouter Meter")))
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn empty_chart() -> Value {
    json!({
        "metric": "spend",
        "scale": "24h",
        "period_start": "",
        "period_end": "",
        "bins": [],
        "finest_bin_ms": 3600000,
        "partial": false,
    })
}

fn default_settings() -> Value {
    json!({
        "parameters": {
            "refresh_sec": 10,
            "chart_refresh_sec": 60,
            "raw_retention_days": 90,
            "agg_retention_months": 24,
            "time_zone": "system",
        },
        "display": {
            "always_on_top": "normal",
            "ghost": false,
            "opacity": 100,
            "metric_spending": "spend",
            "linear_axis": false,
        },
        "view": { "tab": "spending" },
    })
}

/// Shallow-merge `patch` into `target`, recursing into objects.
fn merge(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(t), Value::Object(p)) => {
            for (k, v) in p {
                merge(t.entry(k.clone()).or_insert(Value::Null), v);
            }
        }
        (t, p) => *t = p.clone(),
    }
}
