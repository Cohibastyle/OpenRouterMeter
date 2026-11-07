# Electron vs Tauri

Measured on the same machine (Apple silicon, macOS 27.0.0) from the same source
tree. The renderer, the shared logic, and the 113 unit tests are identical in
both builds; only the host process differs.

## Size

| Build | Artifact | Size |
|---|---|---|
| Electron | DMG | 80.0 MB |
| Electron | app (unpacked) | 194.8 MB |
| Tauri | DMG | **2.3 MB** |
| Tauri | binary | 4.8 MB |

The Tauri DMG is **35× smaller**. Almost all of the Electron bundle is the
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
| `tests/` | 1,398 | unchanged, 113/113 pass |
| `src/preload/` | 156 | replaced by `src-tauri/frontend/tauriBridge.ts` |

The renderer still reads `window.widget`. The bridge implements the same
`WidgetApi` interface from `src/shared/widgetApi.ts`, so the compiler catches
drift between the two hosts.

## What was rewritten

| Area | Lines | Replacement |
|---|---|---|
| `src/main/index.ts` | 1,728 | `src-tauri/src/{shell,bridge}.rs` |
| `src/main/db/database.ts` | 656 | `src-tauri/src/db.rs` (rusqlite) |
| `src/main/collectors/openrouter.ts` | 471 | `src-tauri/src/collector.rs` (reqwest) |
| `src/main/logging/logger.ts` | 184 | not yet ported |
| `src/main/snapshot.ts` | 126 | `src-tauri/src/snapshot.rs` |
| `src/main/credentials.ts` | 90 | `src-tauri/src/credentials.rs` (Keychain) |
| `src/shared/{money,granularity,windows,chart}` | 470 | `src-tauri/src/{accounting,chart}.rs` |

## Correctness

The Rust accounting is checked against the TypeScript implementation rather than
against expectations. `scripts/gen-crosscheck.mjs` runs the real `buildSnapshot`
at a fixed clock and writes the result to `src-tauri/fixtures/`; the Rust port
must reproduce it exactly. That test caught a genuine bug: the local day and
month boundaries assumed UTC, which shifted the today total by 800k
micro-dollars in a non-UTC zone.

12 Rust tests pass, including exact parity on all five windows, today, month,
and the latest request.

## Rendering

Both builds render the same four size classes at identical pixel dimensions
(2× retina). The Tauri captures are in `captures-tauri/`; the Electron ones come
from `npm run capture`.

Two rendering differences were found and fixed during the port:

- **Layout never reflowed.** The renderer reflows from a `window:layout` push
  event that the Electron main process sends on resize. Tauri did not send it,
  so a window dragged wider kept the icon rail it had when it was narrow.
- **The chart was empty.** `charts:get` was still returning a stub. Porting
  `buildChart` fixed it, including the granularity gate that makes the `10m`
  cell read `–` rather than an interpolated guess.

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

- The structured logger and log rotation are not ported; `logs:*` reads from the
  database but nothing writes to it yet.
- Diagnostics reports a reduced bundle.
- No code signing or notarization on either build.
- The Tauri build has no update check; `app:checkForUpdates` returns `idle`.
