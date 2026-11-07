//! Window capture for the comparison harness.
//!
//! `screencapture -R` records whatever is on screen in a rectangle, so a
//! transparent window with `backdrop-filter` composites against the desktop and
//! the result is blurred. This asks the window's own content view to draw itself
//! into a bitmap instead, which is what the Electron `capturePage` call does.

/// What a capture attempt produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Capture {
    /// A PNG was written and it has more than one colour in it.
    Painted,
    /// A PNG was written but the buffer was a single flat colour, which means
    /// the webview had not painted yet. The caller should wait and retry.
    Blank,
    /// The window could not be captured at all.
    Failed,
}

#[cfg(target_os = "macos")]
pub fn capture_window(window: &tauri::WebviewWindow, path: &std::path::Path) -> Capture {
    use objc2::rc::Retained;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSView};
    use objc2_foundation::{NSDictionary, NSString};

    let Ok(ptr) = window.ns_window() else {
        return Capture::Failed;
    };
    // SAFETY: `ns_window` returns the live NSWindow for this webview, and the
    // call happens on the main thread while the window is alive.
    let ns_window: &objc2_app_kit::NSWindow = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
    let Some(view) = ns_window.contentView() else {
        return Capture::Failed;
    };

    let bounds = view.bounds();
    let Some(rep) = view.bitmapImageRepForCachingDisplayInRect(bounds) else {
        return Capture::Failed;
    };
    view.cacheDisplayInRect_toBitmapImageRep(bounds, &rep);

    let painted = is_painted(&rep);

    let props: Retained<NSDictionary<NSString, objc2::runtime::AnyObject>> = NSDictionary::new();
    // SAFETY: `rep` was just created for this view's bounds and is still alive.
    let encoded =
        unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) };
    let Some(data) = encoded else {
        return Capture::Failed;
    };

    if std::fs::write(path, data.to_vec()).is_err() {
        return Capture::Failed;
    }
    if painted {
        Capture::Painted
    } else {
        Capture::Blank
    }
}

/// Whether the bitmap holds more than one colour.
///
/// A webview that has not painted yet hands back a flat buffer, so sampling a
/// grid of pixels and looking for any difference is enough to tell the two
/// apart. This only decides whether to retry; it never judges the render.
#[cfg(target_os = "macos")]
fn is_painted(rep: &objc2_app_kit::NSBitmapImageRep) -> bool {
    let data = rep.bitmapData();
    if data.is_null() {
        return false;
    }
    let width = rep.pixelsWide();
    let height = rep.pixelsHigh();
    let stride = rep.bytesPerRow();
    let samples = rep.samplesPerPixel();
    if width <= 0 || height <= 0 || stride <= 0 || samples <= 0 {
        return false;
    }

    // SAFETY: `bitmapData` points at the rep's own buffer, which is
    // `stride * height` bytes, and every coordinate below is inside the bitmap.
    unsafe {
        let first = pixel_at(data, stride, samples, 0, 0);
        for gy in 0..8 {
            for gx in 0..8 {
                let x = (width - 1) * gx / 7;
                let y = (height - 1) * gy / 7;
                if pixel_at(data, stride, samples, x, y) != first {
                    return true;
                }
            }
        }
    }
    false
}

/// Read one pixel as a packed integer.
///
/// # Safety
/// `data` must point at a buffer of at least `stride * height` bytes, and the
/// coordinates must be inside the bitmap.
#[cfg(target_os = "macos")]
unsafe fn pixel_at(data: *const u8, stride: isize, samples: isize, x: isize, y: isize) -> u32 {
    let offset = y * stride + x * samples;
    let mut out = 0u32;
    for i in 0..samples.min(4) {
        out = (out << 8) | unsafe { *data.offset(offset + i) } as u32;
    }
    out
}

#[cfg(not(target_os = "macos"))]
pub fn capture_window(_window: &tauri::WebviewWindow, _path: &std::path::Path) -> Capture {
    Capture::Failed
}
