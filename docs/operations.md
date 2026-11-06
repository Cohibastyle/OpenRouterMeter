# Operations

## Build

```bash
npm install
npm run build
```

`scripts/build.mjs` bundles three entry points with esbuild:

| Entry | Output | Format |
|---|---|---|
| `src/main/index.ts` | `dist/main/index.js` | CJS, node22, `electron` external |
| `src/preload/index.ts` | `dist/preload/index.js` | CJS, node22, `electron` external |
| `src/renderer/index.ts` | `dist/renderer/index.js` | IIFE, chrome130 |

It also copies `index.html` and `styles/` into `dist/renderer/`, and writes a
minimal `dist/package.json` so Electron resolves `main/index.js`.

## Run

```bash
npm start          # build then launch
npm run dev        # same, for iteration
npm run selftest   # launch, run 11 runtime checks, exit with a status code
npm run capture    # render each size class to PNG
```

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
| `tests/logAxis.test.ts` | Log mapping, monotonic bar widths, decade ticks, label spacing, hit testing, degenerate ranges |
| `tests/windows.test.ts` | Five trailing windows, overlap, granularity gate, partial reasons, money precision, formatting |
| `tests/layout.test.ts` | Size classes, layout modes, strip columns, settings validation, redaction |

## Package

```bash
npm run dist:mac
```

Uses electron-builder with the `mac` target (dmg) and `LSUIElement: 1` so the
packaged app has no Dock icon. Code signing and notarization require a Developer
ID certificate in the keychain; without one the build is unsigned and Gatekeeper
will warn on first launch.

## Electron binary

If `npm install` did not download the Electron binary (the postinstall script can
be skipped by npm policy), run:

```bash
npm run setup:electron
```

This downloads the official release archive for the current platform and
architecture, extracts it into `node_modules/electron/dist`, and writes
`path.txt`.

## Database

- Location: `~/Library/Application Support/OpenRouter Widget/widget.db`
- Journal mode: WAL
- Migrations run on startup inside a transaction
- A destructive migration copies the database to `widget.db.backup-v<n>` first
- Settings → Diagnostics can vacuum, export, and clear

## Logs

- Location: `~/Library/Application Support/OpenRouter Widget/logs/widget.log`
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
3. `npm run selftest` reports 11/11.
4. `npm run capture` and review every size class.
5. Verify the log file contains no credential after a full run.
6. Verify the database file contains no credential.
7. Confirm the widget floats above normal windows after a restart.
8. Confirm bounds and size restore onto the correct display.
9. Update `docs/platform.md` with the verification results.
10. Bump the version and write release notes.
