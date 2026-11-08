mod accounting;
mod bridge;
mod capture;
mod chart;
mod collector;
mod credentials;
mod db;
mod logging;
mod refresh;
mod shell;
mod snapshot;
mod state;
mod update;

pub fn run() {
    let capture = std::env::args().any(|a| a == "--capture");

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            shell::setup(app)?;
            if capture {
                shell::run_capture(app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bridge::account_status,
            bridge::snapshot_get,
            bridge::summary_get,
            bridge::charts_get,
            bridge::requests_list,
            bridge::requests_breakdown,
            bridge::keys_list,
            bridge::window_get_state,
            bridge::window_set_state,
            bridge::window_minimize,
            bridge::window_hide,
            bridge::window_close,
            bridge::window_reset_size,
            bridge::window_move_by,
            bridge::settings_get,
            bridge::settings_set,
            bridge::settings_reset,
            bridge::logs_query,
            bridge::logs_tail,
            bridge::logs_unsubscribe,
            bridge::logs_clear_view,
            bridge::logs_open_folder,
            bridge::logs_error_count,
            bridge::diagnostics_get,
            bridge::diagnostics_copy,
            bridge::diagnostics_save,
            bridge::app_version,
            bridge::app_check_for_updates,
            bridge::app_open_external,
            bridge::app_refresh_now,
            bridge::app_quit,
            bridge::credential_state,
            bridge::credential_save,
            bridge::credential_test,
            bridge::credential_probe,
            bridge::credential_disconnect,
            bridge::data_export,
            bridge::data_clear,
            bridge::data_vacuum,
            bridge::data_open_db_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

