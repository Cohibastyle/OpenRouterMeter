# Operations

## Build

```bash
npm install
npm run build
```

`scripts/build-tauri.mjs` bundles two entry points with esbuild:

| Entry | Output | Format |
|---|---|---|
| `src-tauri/frontend/tauriBridge.ts` | `dist/renderer/bridge.js` | IIFE, safari15 |
| `src/renderer/index.ts` | `dist/renderer/index.js` | IIFE, safari15 |

It also copies `index.html` and `styles/` into `dist/renderer/`. The Rust host
embeds that directory into the binary, so there is no runtime asset directory to
ship alongside the app.

The bridge is a separate bundle because the page CSP is `script-src 'self'` with
no `unsafe-inline`, so it cannot install itself from an inline script. It is
loaded first and assigns `window.widget` before the renderer runs.

## Run

```bash
npm start          # build then launch
npm run dev        # same, for iteration
npm run capture    # render each size class to PNG
```

`npm start` and `npm run dev` are the same command: `tauri dev` rebuilds the Rust
side on change, so there is no separate watch mode.

`npm run capture` builds the app bundle and runs it with `--capture`, which
renders each size class to a bitmap in the temp directory. It is the only
reliable way to screenshot the widget: the window is transparent with a
`backdrop-filter`, so a screen grab composites against the desktop and comes out
blurred.

## Toolchain

The Tauri CLI is a pinned devDependency (`@tauri-apps/cli`), so `npm ci` provides
it and `npx tauri` resolves the same version locally and in CI. Do not rely on a
global `cargo-tauri` install: a fresh CI runner does not have one, and
`cargo install tauri-cli` compiles the CLI from source on every run.

Cargo must be on `PATH`. If `npm run dist:mac` fails with
`failed to run 'cargo metadata'`, the shell has not picked up `~/.cargo/bin`:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
```

### A stale binary trap

`cargo build --release` does **not** relink `target/release/OpenRouter Meter` in
this project. Only `tauri build` does. Running a bare `cargo build` and then
launching the binary silently runs the previous build, which looks like a fix
that did not take. Always use `npm run dist:mac` or `npx tauri build`.

## Test

```bash
npm test           # bundles tests with esbuild, then runs node --test
npm run typecheck  # tsc --noEmit
```

The test bundler exists because the sources use `.js` specifiers that resolve to
`.ts` files. esbuild rewrites them, so no separate compile step is needed.

Coverage:

| Suite | What it proves |
|---|---|
| `tests/timeAxis.test.ts` | Linear axis, equal widths for equal durations, tick spacing, label collision, hit testing, degenerate ranges |
| `tests/windows.test.ts` | Five trailing windows, overlap, granularity gate, partial reasons, request counts, money precision, formatting |
| `tests/granularity.test.ts` | One granularity per period, coverage from recorded fetch ranges |
| `tests/delta.test.ts` | Headline changes in both directions, unknown values, request deltas |
| `tests/odometer.test.ts` | Single-pass roll planning, unchanged digits, cascade timing |
| `tests/layout.test.ts` | Size classes, layout modes, strip columns, settings validation, redaction |

The Rust side has its own suite:

```bash
npm run build      # required first, see below
cargo test --manifest-path src-tauri/Cargo.toml
```

`npm run build` must run first. `tauri::generate_context!()` reads
`frontendDist` (`../dist/renderer`) at compile time and panics when the directory
is missing, so a clean checkout cannot compile the crate before the frontend is
built. A local build usually has `dist/` left over from a previous run, which
hides the problem; CI hit it on the first real run.

`src-tauri/src/snapshot.rs` cross-checks the Rust accounting against the
TypeScript implementation. `scripts/gen-crosscheck.mjs` runs the real
`buildSnapshot` at a fixed clock and writes the result to `src-tauri/fixtures/`;
the Rust port must reproduce it exactly. That test caught a real UTC
day-boundary bug, so it is the check that matters most — do not delete it.

## Package

```bash
npm run dist:mac
```

Runs `tauri build --bundles dmg`. The DMG is about 3 MB: the frontend is embedded
in the binary and the WebKit view is borrowed from the system, so there is no
browser runtime to ship.

The app has no Dock icon because `shell.rs` sets
`ActivationPolicy::Accessory`.

### Signing and notarization

The build is **ad-hoc signed only** — the linker's automatic signature, with no
Team ID. Gatekeeper therefore blocks first launch, and because an ad-hoc identity
changes on every rebuild, macOS treats each build as a different app and prompts
for Keychain access again.

To sign properly, add a *Developer ID Application* certificate (Apple Developer
Program, $99/yr) and set these repository secrets:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the exported `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | password for that `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID` | Apple account email |
| `APPLE_PASSWORD` | app-specific password |
| `APPLE_TEAM_ID` | ten-character team ID |

Tauri reads those variables natively and signs and notarizes without any change
to `tauri.conf.json`. Hardened runtime is enabled automatically when signing is
active. No entitlements file is needed: the app is a network client with Keychain
access, both of which work under the default hardened runtime.

Until then, the workaround is documented in the README:

```bash
xattr -dr com.apple.quarantine "/Applications/OpenRouter Meter.app"
```

### Releasing

All three version fields must be bumped together, because the update check
compares against `CARGO_PKG_VERSION`:

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

Then push a `v*` tag. `.github/workflows/release-mac.yml` builds `aarch64` and
`x86_64` on `macos-latest`, runs both test suites, and attaches the DMGs to the
release. It can also be run by hand with `workflow_dispatch`, which is the right
way to test a workflow change before tagging.

## Database

- Location: `~/Library/Application Support/OpenRouter Meter/widget.db`
- Journal mode: WAL
- Migrations run on startup inside a transaction
- A destructive migration copies the database to `widget.db.backup-v<n>` first
- Settings → Diagnostics can vacuum, export, and clear

## Logs

- Location: `~/Library/Application Support/OpenRouter Meter/logs/widget.log`
- One JSON object per line
- Rotates at 5 MB, 3 files kept
- Redaction runs at write time

## Error handling

| Condition | Behavior |
|---|---|
| Credential rejected | Persistent banner, `Fix in Settings`, one log entry per attempt |
| Rate limited | Keep last values, dim, show retry time from `Retry-After` |
| Source outage | Keep last values, dim, show in status strip |
| Network offline | Keep last values, dim |
| System suspend | Pause timers |
| System resume | Restart timers, refresh immediately, mark possibly stale until first success |
| Display removed | Clamp bounds into the primary work area |
| Migration failure | Roll back, log `db_migration_failed`, keep the backup |

Backoff is exponential with jitter, a 5 second floor, and a 5 minute ceiling.

## Release checklist

1. `npm run typecheck` passes.
2. `npm test` passes.
3. `cargo test --manifest-path src-tauri/Cargo.toml` passes, including the
   cross-check against the TypeScript snapshot.
4. `npm run capture` and review every size class.
5. Verify the log file contains no credential after a full run.
6. Verify the database file contains no credential.
7. Confirm the widget floats above normal windows after a restart.
8. Confirm bounds and size restore onto the correct display.
9. Confirm the refresh loop is running: the log should show
   `refresh loop started` and a `collected N analytics rows` line every
   `refresh_sec`.
10. Bump the version in all three files and write release notes.
