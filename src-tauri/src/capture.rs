//! Window capture for the comparison harness.
//!
//! `screencapture -R` records whatever is on screen in a rectangle, so a
//! transparent window with `backdrop-filter` composites against the desktop and
//! the result is blurred. This asks the window's own content view to draw itself
//! into a bitmap instead, which is what the Electron `capturePage` call does.

#[cfg(target_os = "macos")]
pub fn capture_window(window: &tauri::WebviewWindow, path: &std::path::Path) -> bool {
    use objc2::rc::Retained;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSView};
    use objc2_foundation::{NSDictionary, NSString};

    let Ok(ptr) = window.ns_window() else { return false };
    // SAFETY: `ns_window` returns the live NSWindow for this webview, and the
    // call happens on the main thread while the window is alive.
    let ns_window: &objc2_app_kit::NSWindow = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
    let Some(view) = ns_window.contentView() else { return false };

    let bounds = view.bounds();
    let Some(rep) = view.bitmapImageRepForCachingDisplayInRect(bounds) else {
        return false;
    };
    view.cacheDisplayInRect_toBitmapImageRep(bounds, &rep);

    let props: Retained<NSDictionary<NSString, objc2::runtime::AnyObject>> = NSDictionary::new();
    // SAFETY: `rep` was just created for this view's bounds and is still alive.
    let encoded =
        unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) };
    let Some(data) = encoded else {
        return false;
    };

    let bytes = data.to_vec();
    std::fs::write(path, bytes).is_ok()
}

#[cfg(not(target_os = "macos"))]
pub fn capture_window(_window: &tauri::WebviewWindow, _path: &std::path::Path) -> bool {
    false
}
