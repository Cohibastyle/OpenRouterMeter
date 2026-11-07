//! Phase 1 in-memory state. Phase 2 replaces the settings and log fields with
//! the on-disk store; the accessors keep their signatures.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};

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
        json!({
            "app": env!("CARGO_PKG_VERSION"),
            "electron": Value::Null,
            "tauri": tauri::VERSION,
            "node": Value::Null,
            "sqlite": Value::Null,
            "schema": 1,
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
