# Electron vs Tauri

Measured on the same machine (Apple silicon, macOS 27.0.0) from the same source
tree. The renderer, the shared logic, and the 128 unit tests are identical in
both builds; only the host process differs.

## Size

| Build | Artifact | Size |
|---|---|---|
| Electron | DMG | 80.0 MB |
| Electron | app (unpacked) | 194.8 MB |
| Tauri | DMG | **2.9 MB** |
| Tauri | app (unpacked) | 6.0 MB |
| Tauri | binary | 6.0 MB |

The Tauri DMG is **27× smaller**. Almost all of the Electron bundle is the
Chromium binary inside `Electron Framework.framework` (164 MB unpacked); Tauri
uses the system WKWebView instead, so there is no browser to ship.

## Runtime

| Build | Startup | Memory (RSS, whole process tree) |
|---|---|---|
| Electron | 934 ms | 425 MB |
| Tauri | **70 ms** | **96 MB** |

Startup is measured from spawn to the first sample where the process tree has a
resident set above a small floor. Memory is the sum over the process tree,
because both builds spawn helpers.

## What carried over unchanged

| Area | Lines | Status |
|---|---|---|
| `src/renderer/` | 5,992 | unchanged |
| `src/shared/` | 2,155 | unchanged |
| `tests/` | 1,398 | unchanged, 128/128 pass |
| `src/preload/` | 156 | replaced by `src-tauri/frontend/tauriBridge.ts` |

The renderer still reads `window.widget`. The bridge implements the same
`WidgetApi` interface from `src/shared/widgetApi.ts`, so the compiler catches
drift between the two hosts.

## What was rewritten

| Area | Lines | Replacement |
|---|---|---|
| `src/main/index.ts` | 1,728 | `src-tauri/src/{shell,bridge}.rs` |
| `src/main/db/database.ts` | 656 | `src-tauri/src/db.rs` (rusqlite) |
| `src/main/collectors/openrouter.ts` | 471 | `src-tauri/src/collector.rs` (reqwest); parsers kept in `src/shared/` |
| `src/main/logging/logger.ts` | 184 | `src-tauri/src/logging.rs` |
| `src/main/snapshot.ts` | 126 | `src-tauri/src/snapshot.rs`, kept in `src/shared/` as the cross-check oracle |
| `src/main/credentials.ts` | 90 | `src-tauri/src/credentials.rs` (Keychain) |
| `src/shared/{money,granularity,windows,chart}` | 470 | `src-tauri/src/{accounting,chart}.rs` |

## Correctness

The Rust accounting is checked against the TypeScript implementation rather than
against expectations. `scripts/gen-crosscheck.mjs` runs the real `buildSnapshot`
at a fixed clock and writes the result to `src-tauri/fixtures/`; the Rust port
must reproduce it exactly. That test caught a genuine bug: the local day and
month boundaries assumed UTC, which shifted the today total by 800k
micro-dollars in a non-UTC zone.

28 Rust tests pass, including exact parity on all five windows, today, month,
and the latest request, plus the logger's redaction and rotation and the update
check's version comparison.

## Rendering

Both builds render the same four size classes at identical pixel dimensions
(2× retina). The Tauri captures are in `captures-tauri/`; the Electron ones come
from `npm run capture`.

Four rendering differences were found and fixed during the port:

- **Layout never reflowed.** The renderer reflows from a `window:layout` push
  event that the Electron main process sends on resize. Tauri did not send it,
  so a window dragged wider kept the icon rail it had when it was narrow.
- **The chart was empty.** `charts:get` was still returning a stub. Porting
  `buildChart` fixed it, including the granularity gate that makes the `10m`
  cell read `–` rather than an interpolated guess.
- **The strip never degraded.** `layout_for` hardcoded `stripDetail: "full"`, so
  at 180px the five cells drew their values and request counts on top of each
  other instead of dropping to labels. Porting `stripDetailFor` fixed it.
- **The tab bar kept its icon rail.** `renderTabs` only ran at startup and on a
  tab change, so the label spans were never created when the window started
  narrow and was then widened. It now also runs on `window:layout`. This is a
  latent bug in the Electron build too, which the saved window size hides.

The capture harness also needed a fix: `screencapture -R` records the screen, so
a transparent window with `backdrop-filter` came out blurred against the
desktop. `src-tauri/src/capture.rs` asks the content view to draw itself into a
bitmap instead, the same thing Electron's `capturePage` does, and retries while
the buffer is still a flat colour because the first size class is captured
before the webview has painted.

## Collector

`src-tauri/src/collector.rs` ports the OpenRouter client to `reqwest`. It keeps
the same endpoint set and the same capability probe, so the UI reports which
sources answered rather than assuming:

- `/analytics/query` is the primary source. It reports the current day and
  supports minute, hour, and day granularity, so the short windows are
  computable.
- `/activity` is the fallback. It returns daily aggregates only, so the short
  windows stay unavailable with reason `source_granularity`.
- `/keys` enables the per-key breakdown; `/credits` and `/key` supply the
  account totals and the live counter.

Verified against the live API: a rejected credential is classified as
`invalid_credential` with status 401 rather than surfacing as a generic network
error.

## Not yet done

- Diagnostics reports a reduced bundle.
- No code signing or notarization.

## The Electron host is gone

Electron was removed once the port was complete. The comparison above is kept as
the record of why the port was worth doing: the same app went from an 80 MB DMG
to 2.9 MB, and from 934 ms and 425 MB at startup to 70 ms and 96 MB.

What made the removal safe, in the order it was done:

1. **The logger and the update check were ported.** Until then the Log section
   read zero entries and `app:checkForUpdates` returned `idle`, so deleting the
   host would have removed working features rather than duplicated ones.
2. **`parseSourceDate` moved to `src/shared/`.** It is pure date parsing, so it
   never belonged in the host.
3. **The cross-check oracle moved rather than died.** `buildSnapshot`,
   `generateSampleRequests` and the OpenRouter response parsers import nothing
   but `src/shared/`, so they now live there. `scripts/gen-crosscheck.mjs` still
   runs the TypeScript `buildSnapshot` to produce the fixtures the Rust
   accounting must reproduce exactly, which keeps the port checked against
   something other than itself.
4. **The release workflow was replaced**, not deleted: it now builds with
   `cargo tauri build` for both `aarch64-apple-darwin` and `x86_64-apple-darwin`.

`src/renderer/` and `src/shared/` were never Electron code. They are the UI and
the shared logic, roughly 8,100 lines that both hosts compiled, and they are
unchanged by the removal.
