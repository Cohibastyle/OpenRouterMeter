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

/// Sizes the Electron `--capture` mode renders, so the two sets can be diffed.
pub const CAPTURE_SIZES: &[(&str, f64, f64)] = &[
    ("01-spending-micro-180x120", 180.0, 120.0),
    ("02-spending-compact-320x240", 320.0, 240.0),
    ("03-spending-standard-480x360", 480.0, 360.0),
    ("04-spending-expanded-900x560", 900.0, 560.0),
];

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
        watch_resize(&window);
    }

    // Record the startup entries the Electron build logged, so the Log section
    // has content from the first launch rather than reading empty.
    let state = app.state::<AppState>();
    let version = env!("CARGO_PKG_VERSION");
    state.log("info", "app", &format!("starting OpenRouter Meter {version} on {}", std::env::consts::OS));
    let size = app
        .get_webview_window("main")
        .and_then(|w| w.inner_size().ok())
        .map(|s| format!("{}x{}", s.width, s.height))
        .unwrap_or_else(|| "unknown".to_string());
    state.log("info", "window", &format!("window shown at {size}"));

    Ok(())
}

/// Push `window:layout` on every resize, the way the Electron main process does.
///
/// The renderer reflows from this event. Without it the layout is whatever it
/// was at first paint, so a window dragged wider keeps the icon rail it had when
/// it was narrow.
fn watch_resize(window: &WebviewWindow) {
    let handle = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Resized(size) = event {
            let scale = handle.scale_factor().unwrap_or(1.0);
            let width = size.width as f64 / scale;
            let height = size.height as f64 / scale;
            let _ = handle.emit("window:layout", layout_for(width, height));
        }
    });
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

/// Render each size class to a PNG, mirroring the Electron `--capture` mode.
///
/// Tauri has no webview snapshot API, so this uses `screencapture -R` against the
/// window's own rectangle. The renderer paints an opaque background, so the
/// capture is the widget and not the desktop behind it.
pub fn run_capture(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2500));

        let out_dir = std::env::temp_dir().join("ormeter-tauri-captures");
        let _ = std::fs::create_dir_all(&out_dir);

        for (name, w, h) in CAPTURE_SIZES {
            let Some(window) = app.get_webview_window("main") else { return };
            let _ = window.set_size(tauri::LogicalSize::new(*w, *h));
            // Raise the window before capturing: `screencapture -R` records
            // whatever is on screen in that rectangle, so an occluding window
            // would be captured instead of the widget.
            let _ = window.show();
            let _ = window.set_focus();
            let _ = window.set_always_on_top(true);
            std::thread::sleep(std::time::Duration::from_millis(1200));

            let scale = window.scale_factor().unwrap_or(1.0);
            let pos = window.outer_position().unwrap_or_default();
            let size = window.inner_size().unwrap_or_default();

            // screencapture -R takes points, so divide the physical pixels back
            // down by the display scale factor.
            let x = pos.x as f64 / scale;
            let y = pos.y as f64 / scale;
            let cw = size.width as f64 / scale;
            let ch = size.height as f64 / scale;

            let path = out_dir.join(format!("{name}.png"));

            // Prefer the window's own buffer: a transparent window with
            // backdrop-filter composites against the desktop, so a screen grab
            // comes out blurred. The first size class is captured before the
            // webview has painted, so retry while the buffer is still flat.
            let mut painted = false;
            for attempt in 0..6 {
                match crate::capture::capture_window(&window, &path) {
                    crate::capture::Capture::Painted => {
                        painted = true;
                        break;
                    }
                    crate::capture::Capture::Blank => {
                        std::thread::sleep(std::time::Duration::from_millis(400));
                        if attempt == 5 {
                            println!("warning {name} still blank after 6 attempts");
                        }
                    }
                    crate::capture::Capture::Failed => break,
                }
            }
            if painted {
                println!("captured {name} {cw}x{ch}");
                continue;
            }

            let rect = format!("{x},{y},{cw},{ch}");
            let status = std::process::Command::new("screencapture")
                .args(["-x", "-o", "-R", &rect, &path.to_string_lossy()])
                .status();

            match status {
                Ok(s) if s.success() => println!("captured {name} {cw}x{ch} (screen)"),
                _ => println!("failed {name}"),
            }
        }

        // Settings, with a mid-list group expanded, so the scroll-retention and
        // header-expansion behaviour can be reviewed without a human clicking.
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_size(tauri::LogicalSize::new(520.0, 640.0));
            let _ = window.show();
            let _ = window.set_focus();
            std::thread::sleep(std::time::Duration::from_millis(900));
            let _ = window.eval(
                "(() => {
                   const tab = [...document.querySelectorAll('#tabbar button')]
                     .find((b) => /Settings/i.test(b.textContent || ''));
                   tab?.click();
                 })()",
            );
            std::thread::sleep(std::time::Duration::from_millis(900));
            let _ = window.eval(
                "(() => {
                   const heads = [...document.querySelectorAll('.group-header')];
                   const target = heads.find((h) => /Version/i.test(h.textContent || ''));
                   target?.click();
                 })()",
            );
            std::thread::sleep(std::time::Duration::from_millis(900));
            // The Log group, to prove the logger writes entries the panel reads.
            // Collapse the groups above it first so it is on screen: the capture
            // is a bitmap of the window, so an off-screen panel cannot be seen.
            let _ = window.eval(
                "(() => {
                   const heads = () => [...document.querySelectorAll('.group-header')];
                   for (const h of heads()) {
                     const t = (h.textContent || '').trim();
                     if ((t.startsWith('API key') || t.startsWith('Version')) &&
                         h.getAttribute('aria-expanded') === 'true') {
                       h.click();
                     }
                   }
                 })()",
            );
            std::thread::sleep(std::time::Duration::from_millis(900));
            let _ = window.eval(
                "(() => {
                   const target = [...document.querySelectorAll('.group-header')]
                     .find((h) => (h.textContent || '').trim().startsWith('Log'));
                   if (target && target.getAttribute('aria-expanded') === 'false') target.click();
                 })()",
            );
            std::thread::sleep(std::time::Duration::from_millis(1400));
            let log_path = out_dir.join("06-settings-log.png");
            for _ in 0..6 {
                if let crate::capture::Capture::Painted = crate::capture::capture_window(&window, &log_path) {
                    println!("captured 06-settings-log");
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(400));
            }
            let path = out_dir.join("05-settings-version-expanded.png");
            let mut done = false;
            for attempt in 0..8 {
                match crate::capture::capture_window(&window, &path) {
                    crate::capture::Capture::Painted => {
                        println!("captured 05-settings-version-expanded");
                        done = true;
                        break;
                    }
                    crate::capture::Capture::Blank => {
                        std::thread::sleep(std::time::Duration::from_millis(400));
                    }
                    crate::capture::Capture::Failed => {
                        println!("failed 05-settings-version-expanded (capture failed, attempt {attempt})");
                        break;
                    }
                }
            }
            if !done {
                println!("warning 05-settings-version-expanded not painted");
            }
        }

        println!("captures written to {}", out_dir.display());
        app.exit(0);
    });
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
        "stripDetail": strip_detail(width),
        "iconRail": width_class == "xs" || width_class == "s",
        "collapsedFilters": width_class == "xs" || width_class == "s",
        "stackedHeaders": width_class == "xs",
        "showChart": mode == "expanded" || (mode == "standard" && height >= 280.0),
    })
}

/// Mirrors `stripDetailFor` in src/shared/layout.ts.
///
/// The interval label is always drawn because it is the cell's identity and the
/// range button. The value and then the request count are added as the cell
/// grows, so a narrow window degrades to a row of range buttons instead of a row
/// of truncated numbers.
fn strip_detail(width: f64) -> &'static str {
    const VIEW_PAD_X: f64 = 10.0;
    const STRIP_GAP: f64 = 3.0;
    const CELL_PAD_X: f64 = 12.0;
    const COLUMNS: f64 = 5.0;
    const MIN_VALUE: f64 = 58.0;
    const MIN_FULL: f64 = 132.0;

    let usable = width - VIEW_PAD_X * 2.0 - STRIP_GAP * (COLUMNS - 1.0);
    let content = usable / COLUMNS - CELL_PAD_X;
    if content >= MIN_FULL {
        "full"
    } else if content >= MIN_VALUE {
        "value"
    } else {
        "label"
    }
}
