//! Window, tray, and shortcut behaviour, matching the Electron shell.
//!
//! macOS specifics that Electron gave for free and Tauri needs explicitly:
//! - `set_visible_on_all_workspaces` for Spaces and full-screen apps
//! - `NSWindow` level for always-on-top above normal windows
//! - `set_ignore_cursor_events` for ghost mode
//! - `set_activation_policy(Accessory)` to hide the Dock icon

use serde_json::{json, Value};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Emitter, Manager, WebviewWindow};

use crate::state::AppState;

const DEFAULT_WIDTH: f64 = 320.0;
const DEFAULT_HEIGHT: f64 = 240.0;

pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let state = AppState::new();
    state.seed_if_empty();
    app.manage(state);
    app.manage(GhostFlag(std::sync::atomic::AtomicBool::new(false)));

    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);

    build_tray(app.handle())?;
    register_shortcuts(app.handle());

    if let Some(window) = app.get_webview_window("main") {
        apply_always_on_top(&window, "normal");
        let _ = window.show();
    }

    Ok(())
}

fn build_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "toggle", "Hide widget", true, None::<&str>)?;
    let on_top = CheckMenuItem::with_id(app, "on_top", "Always on top", true, true, None::<&str>)?;
    let ghost = CheckMenuItem::with_id(app, "ghost", "Ghost mode (click-through)", true, false, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh now", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Open Settings", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[&show, &on_top, &ghost, &sep1, &refresh, &settings, &sep2, &quit],
    )?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("OpenRouter Widget")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => toggle_visibility(app),
            "on_top" => {
                if let Some(w) = app.get_webview_window("main") {
                    let next = if w.is_always_on_top().unwrap_or(true) { "off" } else { "normal" };
                    apply_always_on_top(&w, next);
                }
            }
            "ghost" => {
                let next = !ghost_enabled(app);
                set_ghost(app, next);
            }
            "refresh" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.emit("widget:refresh", ());
                }
            }
            "settings" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.emit("view:tab", "settings");
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

/// Ghost mode is click-through. Tauri has no getter, so the flag is tracked here
/// and mirrored into the window.
fn ghost_enabled(app: &AppHandle) -> bool {
    app.try_state::<GhostFlag>()
        .map(|f| f.0.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false)
}

fn set_ghost(app: &AppHandle, on: bool) {
    if let Some(flag) = app.try_state::<GhostFlag>() {
        flag.0.store(on, std::sync::atomic::Ordering::Relaxed);
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_ignore_cursor_events(on);
    }
}

pub struct GhostFlag(pub std::sync::atomic::AtomicBool);

fn toggle_visibility(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

fn register_shortcuts(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

    let toggle = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyO);
    let ghost = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyG);

    let handle = app.clone();
    let _ = app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |_app, shortcut, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                if shortcut == &toggle {
                    toggle_visibility(&handle);
                } else if shortcut == &ghost {
                    let next = !ghost_enabled(&handle);
                    set_ghost(&handle, next);
                }
            })
            .build(),
    );
}

pub fn apply_always_on_top(window: &WebviewWindow, level: &str) {
    let on = level != "off";
    let _ = window.set_always_on_top(on);

    #[cfg(target_os = "macos")]
    {
        let _ = window.set_visible_on_all_workspaces(on);
    }
}

pub fn window_state(app: &AppHandle, state: &AppState) -> Value {
    let (width, height, x, y) = match app.get_webview_window("main") {
        Some(w) => {
            let size = w.inner_size().unwrap_or_default();
            let pos = w.outer_position().unwrap_or_default();
            let scale = w.scale_factor().unwrap_or(1.0);
            (
                (size.width as f64 / scale).round(),
                (size.height as f64 / scale).round(),
                (pos.x as f64 / scale).round(),
                (pos.y as f64 / scale).round(),
            )
        }
        None => (DEFAULT_WIDTH, DEFAULT_HEIGHT, 0.0, 0.0),
    };

    let settings = state.settings();
    json!({
        "bounds": { "x": x, "y": y, "width": width, "height": height },
        "display_id": Value::Null,
        "always_on_top": settings["display"]["always_on_top"],
        "ghost": settings["display"]["ghost"],
        "opacity": settings["display"]["opacity"],
        "visible": true,
        "layout": layout_for(width, height),
    })
}

pub fn apply_window_patch(app: &AppHandle, state: &AppState, patch: Value) {
    if let Some(bounds) = patch.get("bounds") {
        if let Some(w) = app.get_webview_window("main") {
            let width = bounds["width"].as_f64().unwrap_or(DEFAULT_WIDTH);
            let height = bounds["height"].as_f64().unwrap_or(DEFAULT_HEIGHT);
            let _ = w.set_size(tauri::LogicalSize::new(width, height));
            if let (Some(x), Some(y)) = (bounds["x"].as_f64(), bounds["y"].as_f64()) {
                let _ = w.set_position(tauri::LogicalPosition::new(x, y));
            }
        }
    }
    if let Some(level) = patch.get("always_on_top").and_then(|v| v.as_str()) {
        if let Some(w) = app.get_webview_window("main") {
            apply_always_on_top(&w, level);
        }
    }
    if let Some(ghost) = patch.get("ghost").and_then(|v| v.as_bool()) {
        set_ghost(app, ghost);
    }
    let _ = state.apply_settings_patch(json!({ "display": patch }));
}

pub fn reset_size(app: &AppHandle) -> Value {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_size(tauri::LogicalSize::new(DEFAULT_WIDTH, DEFAULT_HEIGHT));
    }
    json!({ "x": 0, "y": 0, "width": DEFAULT_WIDTH, "height": DEFAULT_HEIGHT })
}

pub fn copy_to_clipboard(app: &AppHandle, text: &str) {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let _ = app.clipboard().write_text(text.to_string());
}

pub fn open_external(app: &AppHandle, url: &str) {
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_url(url, None::<&str>);
}

/// Mirrors `layoutFor` in src/shared/layout.ts. Phase 1 only needs the fields the
/// renderer reads on first paint; Phase 2 replaces this with the shared module.
fn layout_for(width: f64, height: f64) -> Value {
    let width_class = if width < 240.0 {
        "xs"
    } else if width < 360.0 {
        "s"
    } else if width < 520.0 {
        "m"
    } else if width < 800.0 {
        "l"
    } else {
        "xl"
    };
    let height_class = if height < 200.0 {
        "short"
    } else if height < 400.0 {
        "regular"
    } else {
        "tall"
    };
    let mode = if width_class == "xs" || height_class == "short" {
        "micro"
    } else if width_class == "s" {
        if height_class == "tall" { "standard" } else { "compact" }
    } else if width_class == "m" {
        "standard"
    } else if height_class == "tall" {
        "expanded"
    } else {
        "standard"
    };

    json!({
        "width": width,
        "height": height,
        "widthClass": width_class,
        "heightClass": height_class,
        "mode": mode,
        "stripColumns": 5,
        "stripOverflow": false,
        "stripDetail": "full",
        "iconRail": width_class == "xs" || width_class == "s",
        "collapsedFilters": width_class == "xs" || width_class == "s",
        "stackedHeaders": width_class == "xs",
        "showChart": mode == "expanded" || (mode == "standard" && height >= 280.0),
    })
}
