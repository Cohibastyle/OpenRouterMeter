# OpenRouter Meter

A frameless, always-on-top desktop widget that shows OpenRouter spending and token
usage. It is a Tauri app: the OpenRouter credential lives in the OS credential
store, collection happens in the Rust process, and history is kept in a local
SQLite database. The UI is bundled into the binary and runs in the system
WebKit view, so there is no browser runtime to ship — the DMG is under 3 MB.

This is the macOS build. The same source targets Windows and Linux; see
[Platform notes](#platform-notes).

![Spending tab at 480 x 360](docs/images/spending-standard.png)

## Screenshots

| | |
|---|---|
| ![Expanded dashboard](docs/images/spending-expanded.png) | ![Compact](docs/images/spending-compact.png) |
| ![Micro badge](docs/images/spending-micro.png) | ![Tokens](docs/images/tokens.png) |
| ![Keys](docs/images/keys.png) | ![Models](docs/images/models.png) |
| ![Settings](docs/images/settings.png) | ![Settings display group](docs/images/settings-display.png) |
| ![Log group](docs/images/log.png) | ![Chart](docs/images/charts.png) |

Every screenshot is rendered by `npm run capture` from the running app, so they
always match the shipped build. They are captured against a live account, which
is why the figures are real; the sample data the app starts with is clearly
labelled `Sample data` in the title bar.

## Download the macOS app

Prebuilt DMGs are published on the
[Releases](https://github.com/Cohibastyle/OpenRouterMeter/releases) page: one for
Apple silicon (`arm64`) and one for Intel (`x64`). Open the DMG and drag
**OpenRouter Meter** to Applications.

The builds are unsigned and not notarized. On first launch, macOS Gatekeeper
blocks the app; allow it in **System Settings → Privacy & Security → Open Anyway**,
or clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine "/Applications/OpenRouter Meter.app"
```

## Requirements

- macOS 12 or later (Apple silicon or Intel)
- Node.js 22 or later
- No OpenRouter account is required to explore the widget: it starts with clearly
  labeled sample data.

## Install and run

```bash
npm install
npm run build
npm start
```

`npm start` builds and launches the widget. On first launch it appears in the
top-right of the primary display at 320 x 240, above normal windows, with a menu
bar item and no Dock icon.

### Headline/chip animation test page

The renderer build also includes a standalone animation lab at:

- `dist/renderer/delta-lab.html`

It shows three side-by-side roll variants (all non-bouncy), each with the same
event stream:

- upward deltas from new usage
- downward deltas from interval recalculation/corrections
- chip flash on arrival, then fade over 5 seconds

Use **Next event**, **Random event**, or **Autoplay** to compare variants and pick
the one you prefer.

## Connect an OpenRouter account

1. Open the widget and select the **Settings** tab.
2. Expand **API key**.
3. Follow the six inline steps. The key is created on the
   [OpenRouter API keys page](https://openrouter.ai/settings/keys).
4. Paste the key and choose **Connect**. The widget verifies it with a single
   read-only call before saving.

The key is encrypted through the macOS Keychain via `security-framework`. It is never written to the database, a settings file, a log, or the
renderer. If OS encryption is unavailable, the widget refuses to persist the key
and keeps it in memory for the session only.

A **management key** is required for the live source. Analytics queries and the
key list both need one; with a non-management key the widget falls back to the
older activity feed and says so in the UI.

## Using the widget

Five tabs, always in this order:

| Tab | Accent | What it shows |
|---|---|---|
| Spending | green | Rolling window strip, spend for the selected interval, spend chart |
| Tokens | orange | Rolling window strip, token total for the selected interval, token chart |
| Keys | purple | Rolling window strip, then spend and tokens per API key |
| Models | blue | Rolling window strip, then spend and tokens per model |
| Settings | slate | Parameters, display, API key, version, support, diagnostics, scope, log |

The **Log** is not a tab. It is the last group in Settings, next to the other
diagnostic material.

Charts are inline on the Spending and Tokens tabs. Clicking the headline value
opens a full-size chart subview; `Escape` or **Back** returns to the tab.

### Rolling window summary

The strip reports five trailing windows: `10m`, `1h`, `3h`, `6h`, `24h`. They are
trailing and overlapping, never additive. `24h` is a trailing 24 hours, not the
calendar day.

The cells double as range buttons. Selecting one highlights it and redraws the
headline and chart for that interval. Switching interval repaints the headline
rather than rolling it: a different interval is a different measurement, not a
change in the same one, so the odometer only animates when the same interval's
total moves.

When the selected interval's total rises, the headline's digits roll to the new
value and a chip appears beneath it reading `↑ $0.004000` with the requests that
arrived with the change. A fall reads `↓ … Recalculated`, because a headline that
drops is a correction to a figure already shown rather than new usage. Both the
chip's lifetime and the roll's duration scale with `parameters.refresh_sec` so the
chip covers a whole refresh cycle at any interval, and the roll always finishes
before the next change lands.

Headline spend is stated to three decimals below \$1,000 (`$4.835`) rather than the
two the strip uses, so a rise of a tenth of a cent is visible. Strip cells keep the
tighter form to fit their width.

A window is shown only when it can be computed honestly. If the finest source
granularity is coarser than a quarter of the window, the cell reads `–` with
reason `source_granularity` rather than an interpolated guess. Missing is never
rendered as zero. A cell marked `~` has partial coverage, for example because
collection started inside the window.

### Keys and Models

Both tabs are a breakdown of the same aggregates the charts use, grouped by API
key or by model. They are not a request log: OpenRouter reports aggregates, so a
row is a bucket, and the row's subtitle says how many buckets it covers.

Each breakdown picks exactly one granularity for the selected interval, the same
one the chart uses, so the totals agree. Coverage is proved from the recorded
fetch ranges rather than from the rows, because an idle hour produces no row —
which means zero spend, not missing data. The Keys tab lists every configured key,
including those with no usage in the interval, which read `no usage in this
interval` rather than `$0.00`.

### Time axis

Every graph uses a linear time axis: each bucket gets a width in proportion to the
time it covers, and the vertical grid lines follow it.

```
x(t) = (t - t_start) / (t_end - t_start)
```

The axis is a rendering choice only; it does not change period selection, bin
boundaries, or totals.

### Live panning

A live chart does not sit still between refreshes. `t_end` is the clock, not the
moment the data was fetched, and the plot is repainted every animation frame:

```
t_end   = max(period_end, now)
t_start = t_end - (period_end - period_start)
```

So the window advances exactly one screen-span per span of wall clock — a 10-minute
chart moves one minute of axis every minute, and a 24-hour chart moves one hour
every hour. Because `t_end` tracks `now`, the movement is continuous rather than
one step per refresh, and the period label above the plot is computed from the same
two instants so it never names a window that has already scrolled away.

Two consequences are deliberate:

* The axis does not clamp. A bucket that slides past the left edge leaves the plot
  instead of pinning to it and reading as the newest value. Bars are clipped to the
  plot rectangle so they cannot paint over the value gutter, and hit-testing uses
  that same rectangle, so the tooltip names the bar actually under the pointer.
* Paging back stops the pan. The previous-period button pins the chart to the
  fetched window; paging forward to the live edge resumes following the clock.

The pan is a redraw loop, so an idle live chart still repaints about sixty times a
second. It stops the moment the chart is pinned, hidden, or destroyed.

### Resizing

Drag the handle in the bottom-right corner. The layout reflows continuously from a
180 x 120 badge to a full dashboard with no clipping and no horizontal scrolling.

| Width | Class | Height | Class |
|---|---|---|---|
| below 240 | XS | below 200 | Short |
| 240–359 | S | 200–399 | Regular |
| 360–519 | M | 400+ | Tall |
| 520–799 | L | | |
| 800+ | XL | | |

Derived modes: **Micro** (XS width or Short height), **Compact** (S + Regular),
**Standard** (M, or L/XL + Regular), **Expanded** (L/XL + Tall).

The chart appears whenever there is room for a legible plot: always in Expanded,
and in Standard only above 280 px of height. Below that the chart is hidden rather
than squeezed under its legibility floor.

The strip cells degrade the same way. Each cell needs 58 px of content width to
show its value and 132 px to also show the request count, so at 320 px wide the
five cells are label-only and the headline carries the number instead. Nothing is
truncated to fit.

### Moving the window

Drag anywhere on the status bar. The bar carries `-webkit-app-region: drag`, but a
frameless window does not reliably honour the native drag hit test, so the
renderer also drives the move from script: on `pointerdown` it waits 90 ms for the
platform to take the press, and if the window origin has not changed it takes over
and sends one `window:moveBy` delta per `pointermove`. A press the platform *is*
handling ends the script, so the window never moves twice.

### Appearance

The window is opaque: `transparent: false` in `tauri.conf.json`, and every surface
in `app.css` is a solid colour rather than a translucent tint over a
`backdrop-filter`. The chart area pans continuously while it is live — see
[The chart](#the-chart) — which would read as a shimmer through a blurred
backdrop, and a solid panel is what the macOS widget idiom expects anyway.

Set `display.theme` in Settings to switch between the light and dark palettes; both
are fully opaque.

## Keyboard

| Key | Action |
|---|---|
| `1`–`5` | Select a tab |
| `Escape` | Close a subview |
| `Tab` / `Shift+Tab` | Move focus |
| `Cmd+Shift+O` | Show or hide the widget |
| `Cmd+Shift+G` | Toggle ghost mode (click-through) |

## Menu bar item

Show or hide, always-on-top toggle, ghost mode, refresh now, open settings, quit.

## Development

```bash
npm run build      # bundle the UI into dist/renderer
npm run typecheck  # tsc --noEmit
npm test           # 142 unit tests for accounting, time, axis, layout, redaction
npm run dev        # build the UI and launch the app
npm run capture    # render the README screenshots into docs/images
npm run dist:mac   # build a distributable DMG
```

Rust needs to be on `PATH` for the app targets; the frontend build alone only
needs Node. The Tauri CLI is a devDependency, so `npm install` provides it — no
global `cargo install tauri-cli` is needed.

The Rust side has its own suite:

```bash
cargo test --manifest-path src-tauri/Cargo.toml   # 39 tests
```

`npm run capture` builds the release app and runs it with `--capture`, which
drives the UI through every tab and writes the eleven PNGs the README embeds
straight into `docs/images/`. It reads the window's own buffer
(`cacheDisplayInRect_toBitmapImageRep`) rather than taking a screen grab, so it
works whether or not the window is frontmost and never pulls in whatever happens
to be behind it. Re-run it after any UI change so the screenshots cannot drift
from the build.

### Bundle size

The DMG is **2.9 MB**. Nothing is pruned to get there: the UI bundle is under
300 KB and the Rust binary 6.1 MB unpacked, and there is no browser runtime
because the app renders in the system WebKit view. That is the whole reason the
Tauri port exists — the same app was 80 MB with Electron, 27× larger, almost
entirely Chromium.

`Cargo.toml` sets the release profile to `lto = true`, `opt-level = "s"`,
`panic = "abort"` and `strip = true`, which accounts for most of the difference
between a debug and a release build.

### Project layout

```
src-tauri/src/       window, tray, shortcuts, bridge, state, database
src-tauri/src/       collector (reqwest), accounting, chart, snapshot
src-tauri/frontend/  the Tauri bridge that installs window.widget
src/renderer/        views, components, responsive styles
src/renderer/charts/ time scale, tick generator, bar renderer, hit testing
src/shared/          types, schemas, money, formatting, time axis, layout
tests/               unit tests
docs/                platform, API, security, data model, operations notes
sample-data/         safe fixtures with no real secrets
```

### Security model

- The UI runs in the system WebKit view with no Node access at all.
- `tauri.conf.json` sets a strict CSP: `default-src 'none'`, scripts and styles
  only from the bundle, `connect-src 'none'`, and no remote origins.
- `tauriBridge.ts` exposes a fixed set of named `WidgetApi` methods. There is no
  generic invoke passthrough to the Rust side.
- Every command validates and bounds its arguments.
- Logs are redacted at write time, not at display time.
- No telemetry, no analytics, no crash upload. The only outbound traffic is to
  OpenRouter.

## Data locations

| What | Where |
|---|---|
| Database | `~/Library/Application Support/OpenRouter Meter/widget.db` |
| Logs | `~/Library/Application Support/OpenRouter Meter/logs/widget.log` |
| Credential | `~/Library/Application Support/OpenRouter Meter/credentials/openrouter.bin` (encrypted) |
| Window state | `~/Library/Application Support/OpenRouter Meter/window-state.json` |

Settings → Diagnostics can open these folders, export data, vacuum the database,
and clear all local data.

## Platform notes

- **macOS**: floating window level, visible across Spaces, no Dock icon, menu bar
  item. The stronger always-on-top level also covers full-screen apps.
- **Windows**: reasserts topmost after focus changes; hidden from the taskbar.
- **Linux X11**: sets the always-on-top hint and reapplies it after a workspace
  switch.
- **Linux Wayland**: most compositors do not let a client force always-on-top.
  The widget detects the session type and shows a one-time notice explaining that
  the rule must be set in the compositor, or the X11 session used.

## Known limitations

These are properties of the OpenRouter API, verified against a live account, not
defects in the widget. Each one is stated in the UI rather than hidden.

- **The live source is `/analytics/query`, not `/activity`.** The older activity
  endpoint returns a fixed set of daily rows that can stop several days behind
  today and ignores every date filter. The analytics endpoint is what the
  OpenRouter dashboard itself uses: it reports the current day, supports minute,
  hour, and day granularity, and can break spend down by key. The widget uses it
  as the primary source and keeps `/activity` only as a fallback.
- **A management key is required for the live source.** Analytics and the key
  list both need one. With a non-management key the widget falls back to the
  activity feed, where the short windows cannot be computed and per-key data is
  unavailable.
- **Individual generations are not exposed.** Analytics returns aggregates, so
  the widget shows spend and tokens per bucket, not one row per request. The
  per-generation list on openrouter.ai is not part of the public API. The Keys
  and Models tabs therefore present a breakdown of the same aggregates the charts
  use, and say so rather than labelling minute buckets as individual requests.
- **Today is exact only if the widget was running at midnight.** The credits
  counter supplies a live cross-check, but its derivation needs a reading from
  before the day started. Without one the figure is partial and the UI says
  `live since HH:MM` rather than implying a full day.
- **A management key reports its own usage as zero.** `usage_daily` and friends
  are `0` for a management key because the usage belongs to the account. The
  widget ignores those fields in that case.
- **The key label is the masked key.** OpenRouter returns the masked credential
  as `label` for a management key. The widget shows `Management key` instead and
  never persists a key-shaped label.
- **No account-wide request feed is confirmed**, so request coverage is reported
  as `Selected apps` rather than `Full account`.
- **Update checks are a stub.** Settings → Version reports `up_to_date` without
  contacting a server.
- Currency is USD only in this release.

## Troubleshooting

**Sample data still shows after entering a key.** Sample rows are purged the
moment a real credential is verified, and the sample flag is derived from the
connection state. If you upgraded from an earlier build, the stale rows are
removed on the next launch and the removal is logged as
`removed N sample request records`.

**The banner says the saved key could not be read.** The credential file exists
but the OS would not decrypt it, typically because the Keychain entry was reset.
Re-enter the key in Settings → API key.

**Today shows `$0.00` but the month is not zero.** Expected. OpenRouter has not
published today's activity yet. The lag line under the metrics names the newest
reported date.

**The five window cells are all dashes.** Expected with a non-management key.
The activity fallback only publishes daily totals, so a 10 minute window cannot be
computed honestly. The widget refuses to interpolate one.

**The Keys tab says per-key data is unavailable.** Expected on the activity
fallback. The analytics source carries key identity; the activity feed does not.

## License

MIT
