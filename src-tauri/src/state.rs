//! Phase 1 in-memory state. Phase 2 replaces the settings and log fields with
//! the on-disk store; the accessors keep their signatures.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{json, Value};

const SNAPSHOT: &str = include_str!("../fixtures/snapshot.json");
const REQUESTS: &str = include_str!("../fixtures/requests.json");
const KEYS: &str = include_str!("../fixtures/keys.json");
const SETTINGS: &str = include_str!("../fixtures/settings.json");

pub struct AppState {
    fixtures: HashMap<&'static str, Value>,
    settings: Mutex<Value>,
    logs: Mutex<Vec<Value>>,
    tailing: Mutex<bool>,
    snapshot_version: Mutex<u64>,
    credential: Mutex<Option<String>>,
}

impl AppState {
    pub fn new() -> Self {
        let mut fixtures = HashMap::new();
        fixtures.insert("snapshot", serde_json::from_str(SNAPSHOT).unwrap_or(Value::Null));
        fixtures.insert("requests", serde_json::from_str(REQUESTS).unwrap_or(Value::Null));
        fixtures.insert("keys", serde_json::from_str(KEYS).unwrap_or(Value::Null));
        fixtures.insert("chart", empty_chart());
        fixtures.insert("breakdown", json!({ "group_by": "model", "rows": [], "total_micro": 0 }));

        Self {
            fixtures,
            settings: Mutex::new(
                serde_json::from_str(SETTINGS).unwrap_or_else(|_| default_settings()),
            ),
            logs: Mutex::new(Vec::new()),
            tailing: Mutex::new(false),
            snapshot_version: Mutex::new(1),
            credential: Mutex::new(None),
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
        dirs_log_dir()
    }

    pub fn diagnostics(&self) -> Value {
        json!({
            "environment": {
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "app_version": env!("CARGO_PKG_VERSION"),
                "host": "tauri",
            },
            "storage": { "path": self.log_dir() },
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
        let has = self.credential.lock().map(|c| c.is_some()).unwrap_or(false);
        json!({
            "state": if has { "connected" } else { "not_connected" },
            "encryption_available": true,
            "has_credential": has,
            "label": Value::Null,
            "last4": Value::Null,
            "saved_at": Value::Null,
        })
    }

    pub fn save_credential(&self, secret: &str) -> Value {
        if let Ok(mut c) = self.credential.lock() {
            *c = Some(secret.to_string());
        }
        json!({ "ok": true, "persisted": false, "encryption_available": true })
    }

    pub fn test_credential(&self) -> Value {
        json!({ "ok": false, "error": "not_implemented_phase_1" })
    }

    pub fn disconnect_credential(&self, delete_history: bool) -> Value {
        if let Ok(mut c) = self.credential.lock() {
            *c = None;
        }
        json!({ "ok": true, "history_deleted": delete_history })
    }
}

fn dirs_log_dir() -> String {
    std::env::var("HOME")
        .map(|h| format!("{h}/Library/Application Support/OpenRouter Meter"))
        .unwrap_or_else(|_| ".".to_string())
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
