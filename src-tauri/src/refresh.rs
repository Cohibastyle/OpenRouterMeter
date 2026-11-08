//! The periodic refresh loop.
//!
//! The Electron build ran two timers in the main process: one collected and
//! pushed a snapshot every `refresh_sec`, the other told the renderer to
//! re-fetch the chart every `chart_refresh_sec`. The Tauri port dropped both, so
//! the widget only ever updated when the refresh button was pressed. That is
//! what made the increase chip look erratic: with no periodic snapshot there is
//! no rise to report, and the one rise that did arrive came from a manual
//! refresh at an arbitrary moment.
//!
//! Both timers live here, on one thread, because they share the same
//! `pause_when_hidden` gate and the same settings read.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

/// How often the loop wakes to re-read the settings. The timers themselves are
/// driven by elapsed time, so a settings change takes effect within this window
/// without restarting the thread.
const TICK: Duration = Duration::from_millis(500);

/// The two cadences, in seconds, read from settings.
struct Cadence {
    refresh_sec: u64,
    chart_refresh_sec: u64,
    pause_when_hidden: bool,
}

impl Cadence {
    fn from_settings(settings: &serde_json::Value) -> Self {
        let params = &settings["parameters"];
        // The settings schema only allows 5/10/30/60 and 30/60/300, but a
        // hand-edited file could hold anything, so a zero or missing value
        // falls back to the default rather than spinning the loop.
        let secs = |key: &str, default: u64| -> u64 {
            params[key].as_u64().filter(|v| *v > 0).unwrap_or(default)
        };
        Self {
            refresh_sec: secs("refresh_sec", 10),
            chart_refresh_sec: secs("chart_refresh_sec", 60),
            pause_when_hidden: params["pause_when_hidden"].as_bool().unwrap_or(true),
        }
    }
}

/// Start the refresh loop. Returns immediately; the thread runs until the app
/// exits.
pub fn start(app: AppHandle, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut last_refresh = Instant::now();
        let mut last_chart = Instant::now();
        {
            let state = app.state::<AppState>();
            let cadence = Cadence::from_settings(&state.settings());
            state.log(
                "info",
                "app",
                &format!(
                    "refresh loop started: every {}s, chart every {}s, pause when hidden {}",
                    cadence.refresh_sec, cadence.chart_refresh_sec, cadence.pause_when_hidden
                ),
            );
        }

        let mut was_visible = true;
        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(TICK);

            let state = app.state::<AppState>();
            let cadence = Cadence::from_settings(&state.settings());

            // A hidden widget does no work when the user asked it to pause. The
            // timers are rebased rather than left to accumulate, so showing the
            // window again does not fire a burst of catch-up refreshes.
            let visible = is_visible(&app);
            if cadence.pause_when_hidden && !visible {
                last_refresh = Instant::now();
                last_chart = Instant::now();
                was_visible = false;
                continue;
            }

            // On the first tick after the window is shown again, refresh at
            // once: the displayed snapshot is as stale as the time the window
            // spent hidden, and waiting a full interval would leave the chart
            // anchored to a window that has already scrolled off its axis.
            if !was_visible {
                was_visible = true;
                last_refresh = Instant::now();
                last_chart = Instant::now();
                refresh_once(&app, &state);
                let _ = app.emit("charts:invalidate", ());
                continue;
            }

            if last_refresh.elapsed() >= Duration::from_secs(cadence.refresh_sec) {
                last_refresh = Instant::now();
                refresh_once(&app, &state);
            }

            if last_chart.elapsed() >= Duration::from_secs(cadence.chart_refresh_sec) {
                last_chart = Instant::now();
                let _ = app.emit("charts:invalidate", ());
            }
        }
    });
}

/// Collect, then push the new snapshot to the renderer.
///
/// This is the same sequence the refresh button runs, so a timer refresh and a
/// manual one produce identical state.
fn refresh_once(app: &AppHandle, state: &tauri::State<'_, AppState>) {
    let _ = state.collect();
    let snapshot = state.live_snapshot();
    let _ = app.emit("snapshot:update", snapshot);
    crate::bridge::emit_new_logs(app, state);
}

fn is_visible(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cadence_reads_the_settings() {
        let c = Cadence::from_settings(&json!({
            "parameters": { "refresh_sec": 5, "chart_refresh_sec": 30, "pause_when_hidden": false }
        }));
        assert_eq!(c.refresh_sec, 5);
        assert_eq!(c.chart_refresh_sec, 30);
        assert!(!c.pause_when_hidden);
    }

    #[test]
    fn cadence_falls_back_on_missing_or_zero_values() {
        // A zero would make the loop refresh on every tick, so it is rejected.
        let c = Cadence::from_settings(&json!({
            "parameters": { "refresh_sec": 0, "chart_refresh_sec": null }
        }));
        assert_eq!(c.refresh_sec, 10);
        assert_eq!(c.chart_refresh_sec, 60);
        // Pausing is the default, matching shared/settings.ts.
        assert!(c.pause_when_hidden);
    }

    #[test]
    fn cadence_survives_a_missing_parameters_block() {
        let c = Cadence::from_settings(&json!({}));
        assert_eq!(c.refresh_sec, 10);
        assert_eq!(c.chart_refresh_sec, 60);
    }
}
