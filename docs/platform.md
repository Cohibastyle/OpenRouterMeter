# Platform notes

Verified window behavior per platform. Update this file when a platform check is
run on real hardware.

## macOS

| Behavior | Result | Notes |
|---|---|---|
| Frameless opaque window | Works | `frame: false`, `transparent: false`, `hasShadow: true`; a transparent window with a `backdrop-filter` shell made the native drag hit test unreliable |
| Always on top, normal level | Works | `setAlwaysOnTop(true, 'floating')` |
| Always on top, stronger level | Works | `setAlwaysOnTop(true, 'screen-saver')`; covers full-screen apps |
| Visible across Spaces | Works | `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen })` |
| No Dock icon | Works | `app.dock.hide()` plus `LSUIElement` in the packaged Info.plist |
| Menu bar item | Works | `Tray` with a template image |
| Edge and corner resize | Works | Custom resize handle inside the window; native resize also works |
| Minimum size 180 x 120 | Works | Enforced by `minWidth` / `minHeight` |
| Multi-monitor restore | Works | Bounds clamped into the target display's work area |
| Display disconnect | Works | `display-removed` clamps bounds back into the primary work area |
| Opacity 40–100% | Works | `setOpacity` |
| Ghost mode | Works | `setIgnoreMouseEvents(true, { forward: true })` |
| Global shortcuts | Works | `Cmd+Shift+O` show/hide, `Cmd+Shift+G` ghost mode |

### macOS caveats

- The stronger always-on-top level can obscure video playback and presentations.
  It is off by default and carries an inline warning in Settings.
- The widget never covers system security prompts, screen-sharing indicators, or
  the lock screen; the OS enforces this above any window level.
- `safeStorage` maps to the Keychain. If the Keychain is locked or unavailable,
  `isEncryptionAvailable()` returns false and the widget refuses to persist the
  credential.

## Windows

Not yet verified on hardware. Expected behavior:

- `setAlwaysOnTop(true, 'floating')` for the normal level; reassert after focus
  changes and after a display change.
- `skipTaskbar: true` hides the window from the taskbar and the window switcher.
- `safeStorage` maps to DPAPI.
- Display scaling at 100, 125, 150, and 200 percent must be checked, because the
  layout is driven by CSS pixels while the window bounds are in DIPs.

## Linux X11

Not yet verified on hardware. Expected behavior:

- Set the always-on-top hint and reapply it after a workspace switch.
- Some window managers ignore the skip-taskbar hint.
- `safeStorage` maps to libsecret or KWallet. If neither is available, the widget
  reports `encryption_unavailable`.
- Transparent frameless windows can render a black background on some compositor
  and GPU combinations. The documented fallback is an opaque background that
  keeps the same layout.

## Linux Wayland

Most compositors do not let a client force always-on-top. The widget detects the
session type from `XDG_SESSION_TYPE` and shows a one-time notice explaining that
the rule must be set in the compositor, or the X11 session used.

## Verification checklist

Run on each platform before a release:

1. Launch and confirm the widget floats above normal windows.
2. Focus another app, then confirm the widget is still on top.
3. Maximize a window, then confirm the widget is still on top.
4. Enable the stronger level and confirm it covers a full-screen app.
5. Switch virtual desktops and confirm the expected visibility.
6. Resize from 180 x 120 to the display work area with no clipping.
7. Disconnect a display and confirm the widget is not lost.
8. Restart and confirm bounds, size, and display are restored.
9. Toggle ghost mode and confirm clicks pass through.
10. Confirm the widget never covers a system security prompt.
