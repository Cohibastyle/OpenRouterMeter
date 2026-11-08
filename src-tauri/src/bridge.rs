//! Phase 1 bridge: every method the renderer calls, answered from fixtures.
//!
//! The signatures mirror `src/shared/widgetApi.ts` exactly. Phase 2 replaces the
//! storage-backed methods, Phase 3 the collection-backed ones, and Phase 4 the
//! credential ones; the shape of this file does not change.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::AppState;

#[tauri::command]
pub fn account_status(state: State<'_, AppState>) -> Value {
    state.live_snapshot()["account"].clone()
}

#[tauri::command]
pub fn snapshot_get(state: State<'_, AppState>) -> Value {
    state.live_snapshot()
}

#[tauri::command]
pub fn summary_get(state: State<'_, AppState>, metric: String) -> Value {
    let snapshot = state.live_snapshot();
    json!({
        "windows": snapshot["windows"],
        "metric": metric,
        "as_of": snapshot["server_time"],
    })
}

#[tauri::command]
pub fn charts_get(state: State<'_, AppState>, params: Value) -> Value {
    state.live_chart(&params)
}

#[tauri::command]
pub fn requests_list(state: State<'_, AppState>, limit: usize, key_id: Option<String>) -> Value {
    state.requests(limit, key_id.as_deref())
}

#[tauri::command]
pub fn requests_breakdown(state: State<'_, AppState>, params: Value) -> Value {
    state.breakdown(&params)
}

#[tauri::command]
pub fn keys_list(state: State<'_, AppState>) -> Value {
    state.keys()
}

#[tauri::command]
pub fn window_get_state(app: AppHandle, state: State<'_, AppState>) -> Value {
    crate::shell::window_state(&app, &state)
}

#[tauri::command]
pub fn window_set_state(app: AppHandle, state: State<'_, AppState>, patch: Value) -> Value {
    crate::shell::apply_window_patch(&app, &state, patch);
    crate::shell::window_state(&app, &state)
}

#[tauri::command]
pub fn window_minimize(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.minimize();
    }
}

#[tauri::command]
pub fn window_hide(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

#[tauri::command]
pub fn window_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

#[tauri::command]
pub fn window_reset_size(app: AppHandle) -> Value {
    crate::shell::reset_size(&app)
}

/// Move the window by a screen-space delta.
///
/// The status bar drives the drag from script because a frameless, transparent
/// window with a `backdrop-filter` shell does not start a native move. The
/// renderer sends one delta per pointer move, so this must be cheap and must not
/// re-apply the whole press.
#[tauri::command]
pub fn window_move_by(app: AppHandle, delta: Value) -> Value {
    let dx = delta["dx"].as_f64().unwrap_or(0.0);
    let dy = delta["dy"].as_f64().unwrap_or(0.0);
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(pos) = w.outer_position() {
            let scale = w.scale_factor().unwrap_or(1.0);
            let x = pos.x as f64 + dx * scale;
            let y = pos.y as f64 + dy * scale;
            let _ = w.set_position(tauri::LogicalPosition::new(x / scale, y / scale));
        }
    }
    crate::shell::window_state(&app, &app.state::<AppState>())["bounds"].clone()
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Value {
    state.settings()
}

#[tauri::command]
pub fn settings_set(app: AppHandle, state: State<'_, AppState>, patch: Value) -> Value {
    let display = patch.get("display").cloned();
    let result = state.apply_settings_patch(patch);
    if let Some(display_patch) = display {
        crate::shell::apply_window_display_patch(&app, &display_patch);
    }
    result
}

#[tauri::command]
pub fn settings_reset(state: State<'_, AppState>, group: String) -> Value {
    state.reset_settings(&group)
}

#[tauri::command]
pub fn logs_query(state: State<'_, AppState>, query: Value) -> Value {
    // The ring is authoritative for the live view: it is populated from startup,
    // whereas the database only holds what has been written since. The database
    // is still the fallback so a quiet restart shows the previous run.
    let live = state.log_query(&query);
    if live.as_array().map(|a| a.is_empty()).unwrap_or(true) {
        let limit = query["limit"].as_u64().unwrap_or(200) as usize;
        let stored = state.stored_logs(limit);
        if stored.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            return stored;
        }
    }
    live
}

#[tauri::command]
pub fn logs_tail(state: State<'_, AppState>) -> Value {
    state.set_tailing(true);
    json!({ "subscribed": true, "latest_seq": state.latest_seq() })
}

#[tauri::command]
pub fn logs_unsubscribe(state: State<'_, AppState>) -> Value {
    state.set_tailing(false);
    json!({ "subscribed": false })
}

#[tauri::command]
pub fn logs_clear_view(state: State<'_, AppState>) -> Value {
    state.clear_log_view();
    json!({ "cleared": true })
}

#[tauri::command]
pub fn logs_open_folder(state: State<'_, AppState>) -> Value {
    json!({ "opened": state.log_dir() })
}

#[tauri::command]
pub fn logs_error_count(state: State<'_, AppState>, since_seq: i64) -> Value {
    json!({ "count": state.error_count(since_seq), "latest_seq": state.latest_seq() })
}

#[tauri::command]
pub fn diagnostics_get(state: State<'_, AppState>) -> Value {
    state.diagnostics()
}

#[tauri::command]
pub fn diagnostics_copy(app: AppHandle, state: State<'_, AppState>) -> Value {
    let text = state.diagnostics_text();
    let bytes = text.len();
    crate::shell::copy_to_clipboard(&app, &text);
    json!({ "copied": true, "bytes": bytes })
}

#[tauri::command]
pub fn diagnostics_save(state: State<'_, AppState>) -> Value {
    json!({ "saved": false, "path": state.log_dir() })
}

#[tauri::command]
pub fn app_version(state: State<'_, AppState>) -> Value {
    state.version_info()
}

#[tauri::command]
pub fn app_check_for_updates(state: State<'_, AppState>) -> Value {
    let result = crate::update::check();
    match result["state"].as_str() {
        Some("available") => state.log(
            "info",
            "update",
            &format!(
                "update available: {} (running {})",
                result["latest"].as_str().unwrap_or("?"),
                result["current"].as_str().unwrap_or("?")
            ),
        ),
        Some("failed") => state.log(
            "warn",
            "update",
            &format!("update check failed: {}", result["error"].as_str().unwrap_or("unknown")),
        ),
        _ => state.log("debug", "update", "update check: up to date"),
    };
    result
}

#[tauri::command]
pub fn app_open_external(app: AppHandle, url: String) -> Value {
    crate::shell::open_external(&app, &url);
    json!({ "opened": true })
}

#[tauri::command]
pub fn app_refresh_now(state: State<'_, AppState>, app: AppHandle) -> Value {
    // Collect first when a credential is present, then build the snapshot from
    // whatever is now stored. A collection failure must not blank the UI: the
    // previous rows stay and the snapshot reports the stale state.
    let _ = state.collect();
    emit_new_logs(&app, &state);
    state.live_snapshot()
}

/// Push any entries the view has not seen yet, so the Log panel tails live.
///
/// The renderer subscribes to `logs:entry`; without this the buffer fills but
/// nothing ever reaches the panel until it is reopened.
pub(crate) fn emit_new_logs(app: &AppHandle, state: &AppState) {
    let entries = state.logs();
    let Some(list) = entries.as_array() else { return };
    let latest = state.latest_seq();
    for entry in list.iter().rev().take(8) {
        if entry["seq"].as_i64().unwrap_or(0) > latest - 8 {
            let _ = app.emit("logs:entry", entry.clone());
        }
    }
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    crate::shell::stop_refresh(&app);
    app.exit(0);
}

#[tauri::command]
pub fn credential_state(state: State<'_, AppState>) -> Value {
    state.credential_state()
}

#[tauri::command]
pub fn credential_save(state: State<'_, AppState>, secret: String) -> Value {
    state.save_credential(&secret)
}

#[tauri::command]
pub fn credential_test(state: State<'_, AppState>) -> Value {
    state.test_credential()
}

/// Probe the source with the stored credential and report which endpoints
/// answered. Used by Settings to explain what the key can see.
#[tauri::command]
pub fn credential_probe(state: State<'_, AppState>) -> Value {
    match state.collect() {
        Ok(result) => json!({ "ok": true, "capabilities": result["capabilities"] }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn credential_disconnect(state: State<'_, AppState>, delete_history: bool) -> Value {
    state.disconnect_credential(delete_history)
}

#[tauri::command]
pub fn data_export(state: State<'_, AppState>) -> Value {
    json!({ "exported": false, "path": state.log_dir() })
}

#[tauri::command]
pub fn data_clear(state: State<'_, AppState>, confirmed: bool) -> Value {
    if !confirmed {
        return json!({ "cleared": false });
    }
    json!({ "cleared": state.clear_data() })
}

#[tauri::command]
pub fn data_vacuum(state: State<'_, AppState>) -> Value {
    json!({ "vacuumed": state.vacuum(), "stats": {} })
}

#[tauri::command]
pub fn data_open_db_folder(state: State<'_, AppState>) -> Value {
    json!({ "opened": state.db_path() })
}

fn chrono_now() -> String {
    // Avoid a chrono dependency in Phase 1; the renderer only displays this.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}
