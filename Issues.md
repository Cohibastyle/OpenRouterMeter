# Issues

Keep a list of issues here and their status.

## Open Issues

These rules should always be adhered to:
1. Totals:  There are multiple totals:  Big number, Totals in the interval buttons,  These should always equal the totals for the dislayed graph bars.  This data should always be live and recent.
2. Rolling: Big number Rolling up or down depends on the total value changes.  No rolling when change time interval buttons, the values should appear instantly.  Rolling shouls never overshoot and bounce.  Rolling speed ramps up and then ramps down.  Total Rolling Time should be about 2000ms
3. A Chip for the delta should appear first, and then the rolling will start 100ms after.  
4. The chart should be live and immediately show data as it comes in.  keeping the totals all true.  
5. The code for implementing this should be reusable across Spend and Tokens and as much as possible on the Keys and Models tabs.  Rewrite the code to make it simple and easy to troubleshoot.  
6. If possible, try to reduce the amount of typecript code and replace it with RUST. 

### Compliance check (2026-11-08)

Checked the app against all six rules; three violations found and fixed:

1. **Rule 1 — totals could disagree.** The chart was anchored to a fresh
   `Date.now()` at fetch time while the snapshot windows were computed at emit
   time, so the trailing window slid between the two payloads and the bars
   summed to a different figure than the range buttons. Worse, the headline
   preferred the async chart payload over the snapshot cell, so the big number,
   the buttons, and the delta chip could each read a different instant. The
   chart is now anchored to the snapshot's own `server_time` (`snapshotNow()`),
   and the headline always reads the snapshot window cell — the same payload
   the buttons show. The windows are computed from the same bins the chart
   draws, so all three totals are one figure by construction; a test now locks
   that invariant for all five ranges (`tests/chart.test.ts`).
2. **Rule 1 (Rust port) — the granularity gate diverged.** The Rust
   `compute_windows` gated on a *quarter* of the window width while the
   TypeScript spec gates on the window width itself, so an hourly source
   answered the 1h window in the renderer but not in the port — the buttons
   showed "–" while the chart drew bars. The gate now matches
   `src/shared/windows.ts`, with a regression test.
3. **Rule 2 — roll was shorter than specified.** `HEADLINE_ROLL_SHARE` was
   0.18, so the default ten-second refresh rolled for 1.8 s and a five-second
   refresh for only 900 ms. The share is now 0.4, so every refresh interval the
   settings allow (5 s and up) gets the full ~2000 ms roll; only a hand-edited
   interval below five seconds shortens it.

Rules 3 (chip first, roll after 100 ms), 4 (chart re-fetched on every snapshot,
live panning), 5 (shared headline/strip/chip machinery across Spend, Tokens,
Keys, Models), and 6 (snapshot/windows/chart/breakdown already in Rust) were
verified compliant. All 154 TypeScript tests, 44 Rust tests, typecheck, and
the frontend build pass.

### Keys tab interval buttons (2026-11-08, later)

**The Keys tab ignored interval clicks.** `buildStrip`'s `onCellClick` only
re-fetched the breakdown for the Models tab; the Keys tab fell into the
chart-load branch, so clicking a range button left the table showing the
previous interval's per-key tokens and spend. The Keys tab now reloads the
breakdown exactly like Models, and both tabs also reload it on every snapshot
so the rows stay live between clicks rather than only when the range changes.

### Keys/Models tables disagreed with the interval buttons (2026-11-08, later)

**The breakdown summed one granularity for the whole window; the buttons sum
one granularity per bin.** With minute rows covering the last two hours and
hour rows covering the day, the table used hour rows everywhere while the
buttons used minute rows for the recent bins — so the table's total drifted
from the button's total. The buttons are correct (they sum the same bins the
chart draws, which is the invariant the headline also follows). Both
`buildBreakdown` (TS) and `build_breakdown` (Rust) now select rows exactly the
way the chart selects them: per bin, clipped to the trailing window, one
granularity per bin. `granularity_ms` on the result is now always null because
a table can mix granularities across bins. Regression tests in both languages
assert the table's rows add up to the 24h button's spend and tokens.

**The breakdown was also anchored to a fresh clock read.** Even with per-bin
selection, the table was computed at the moment `breakdown()` was called while
the buttons were computed at the snapshot's emit instant; with a snapshot a few
minutes old, the table's trailing window ended later and counted rows the
buttons did not (visible as the 3h table summing 18.83M against an 18.3M
button). `BreakdownParams` now carries an `anchor`, the renderer passes the
snapshot's `server_time` (`snapshotNow()`), and the Rust side windows the table
at that instant — the same anchor the chart already uses.

**The 6h window totalled less than 3h (non-monotonic windows).** Two causes.
First, the per-bin coverage rule demanded coverage from the bin's start, so a
bin straddling the minute range's trailing edge was dropped entirely even
though it held real minute rows. `selectGranularity`/`select_granularity` now
take an `overlapOk` mode for chart bins: a granularity qualifies when it has
rows inside the bin, or when its recorded range fully covers the bin and no
granularity has rows there (an empty bin is zero usage, but a coarser row
proves the fine fetch missed data). Second and deeper: the 3h (15-min) and 6h
(30-min) bins are finer than an hour row, and an hour row cannot be split
across bins, so anything older than the two-hour minute range was
*uncountable* at those scales — the 6h window had only ever summed the last
two hours. The 3h and 6h ranges now use hour bins; their recent bins still
read the finer minute rows. Verified against the live database:
10m ≤ 1h ≤ 3h ≤ 6h ≤ 24h, with button = chart = table at every scale, and a
regression test locks the monotonicity.

**Keys/Models tables verified against the live database; orphaned TypeScript
removed (2026-11-08, later).** A new Rust test
(`the_live_database_is_consistent_across_every_scale`) reads the real
widget.db and asserts the interval buttons equal both table totals at every
scale and that the scales are monotonic — it passes, so the mismatches seen
earlier were stale app instances running pre-fix binaries (nine old copies in
/Applications share the same widget.db). With correctness locked in Rust, the
Electron-era data layer was deleted as orphaned: `openrouter.ts`,
`analytics.ts`, `sourceDate.ts`, `counterSpend.ts`, and `redact.ts` (1,112
lines with their tests) — the app collects, parses, and redacts entirely in
Rust (`collector.rs`, `logging.rs`). The computational core
(`chart/windows/breakdown/granularity/money/snapshot/sample`) stays in
TypeScript deliberately: it is the oracle the Rust crosscheck test validates
the port against, and `chart.ts`/`breakdown.ts` supply the types the renderer
imports.

**Same anchor is not enough; the row set must also be the same.** Aggregate
rows are overwritten in place as they accumulate (`ON CONFLICT(id) DO UPDATE`
— an hour row grows until the hour closes), so a breakdown computed minutes
after the snapshot read *larger* values for the same rows even at the same
anchor — the table totalled ~5–10% more than every button (10m 3.85M vs
3.117M, 1h 12M vs 11.27M, 3h 21.6M vs 20.86M). `AppState` now caches the row
set of each recent snapshot (`snapshot_rows`, a short history keyed by
instant), and `breakdown()`/`live_chart()` answer any call anchored to a known
snapshot from that snapshot's own rows via `requests_for()`. Every figure the
user sees — buttons, headline, bars, table — comes from one row set at one
instant. The history (8 emits) covers a renderer anchored to a snapshot an
emit or two old, which is exactly what happens when the refresh loop was
paused while hidden and a manual action refreshed the cache in between — the
case that kept producing mismatched tables.

**Why the numbers kept diverging, and the storage answer.** The root cause is
that aggregate rows mutate in place, so "the same rows" read at two times
yield different totals.

**Implemented: the append-only observation log (schema migration 5).** Every
collection now appends one immutable row per bucket to `request_obs` instead of
only overwriting `request` in place; the `request` table remains as the
latest-per-bucket view, and `list_requests_as_of(as_of)` reads the latest
observation per bucket at-or-before an instant — a deterministic query. The
snapshot reads `requests_as_of(now)`, and the chart and Models/Keys tables read
`requests_as_of(anchor)` at the snapshot's `server_time`, so every figure the
user sees comes from one frozen view of the data with no cache convention to
drift. Verified against the live database: the as-of read at a fixed instant
returned identical totals across 12 seconds of incoming collections while the
live view moved (775 buckets / 1.755B tokens both times), and the consistency
test passed four times over ~50 seconds of streaming. The in-memory
`snapshot_rows` cache was removed — the log makes it redundant.

**Real-time chart.** The chart pans continuously (its x axis is a function of
the clock, repainted per frame), re-fetches on every snapshot, and grows the
current bar via `barGrowth` the moment new data lands. That is as real-time as
the source allows: OpenRouter reports per-minute buckets and the collector
fetches every `refresh_sec`.

**Blank 10m chart after showing the window, and first-click table mismatch
(2026-11-08, later).** Two symptoms of one staleness race. When the window was
hidden, `pause_when_hidden` rebased the refresh timers on every tick, so
showing the window again waited a full `refresh_sec` before the first refresh —
the chart stayed anchored to a snapshot old enough that its bars had scrolled
off the panned axis (the blank 10m chart). The loop now refreshes and
invalidates the chart on the first tick after the window becomes visible.
Separately, `loadBreakdown`/`loadChart` captured the snapshot anchor and then
awaited the bridge; a newer snapshot landing mid-fetch left the table/chart
summing a different instant than the buttons showed. Both now discard a
response whose anchor, scale, or metric no longer matches the displayed state
when the fetch returns.




## Closed Issues

1. **The requests count summary was wrong; the 24-hour count could be lower than the 1-hour count.**
   `request_count` was the number of *rows* in the window, not the number of
   requests. A row is an aggregate — one minute bucket for one model on one key
   can hold dozens of requests — so counting rows undercounted. Worse, the
   collector stores the same period at minute, hour, and day granularity, and
   `selectGranularity` picks a different one per window, so the row count changed
   with the granularity: a 1-hour window read minute rows while a 24-hour window
   read hour rows, and the two were not comparable. The analytics endpoint's own
   `request_count` is now carried on the record (schema migration 4), summed by
   `computeWindows` and `periodTotals`, and never inferred from rows. A window
   whose source reported no count stays null rather than guessing. Measured on a
   live account the five windows now read 7 / 348 / 575 / 591 / 2519 requests,
   which is monotonic as it must be.

2. **The chart did not live-pan across the x axis.**
   The anchor was frozen at whatever instant the view opened, so the window never
   moved. The chart now follows the clock: `loadChart` re-anchors to now on every
   load while `chartPinned` is false, and the renderer re-fetches on every
   snapshot rather than only on the slower chart timer. Paging back with the
   previous-period button pins the chart, because a period the user deliberately
   moved to must not drift; paging forward to the live edge unpins it.

3. **The increase chip behaved differently from one refresh to the next.**
   Two causes. First, the Tauri port had dropped the periodic refresh timers
   entirely, so snapshots only arrived when the refresh button was pressed — the
   chip had almost nothing to report. `src-tauri/src/refresh.rs` restores both
   timers (`refresh_sec` and `chart_refresh_sec`, honouring `pause_when_hidden`).
   Second, the invert flash was anchored to the moment the change was recorded,
   so a change that arrived while another tab was showing had used up its flash
   before the chip was ever on screen. It is now anchored to the chip's first
   render. The roll had the same problem in reverse: the view is rebuilt on every
   snapshot, so a refresh landing mid-roll restarted the animation from the
   previous total and the number appeared not to roll. The roll is now stored as
   a time window in `state.rolls` and a rebuilt headline resumes it.

4. **A decrementing headline showed no chip.**
   Only rises were recorded, so a fall was silent. `src/shared/delta.ts` now
   reports both directions, and a fall renders `↓ $0.02 Recalculated` in the
   muted text colour rather than the tab accent: a drop is a correction to a
   figure already on screen, not new usage.

5. **The window could not be moved on macOS.**
   The status bar carried `-webkit-app-region: drag`, but the frameless
   `transparent: true` window with a `backdrop-filter` on the shell breaks the
   native drag hit test, so no press ever started a move. The bar now also drives
   the window from script: on `pointerdown` it waits `DRAG_ARM_MS` (90 ms) for the
   platform to take the press, and if the window origin has not changed it takes
   over and moves the window with `window:moveBy`, one delta per `pointermove`.
   A press the platform *is* handling ends the script instead, so the window never
   moves twice. Verified: a synthetic six-step drag moved the window 168x84 px.

6. **The interval buttons did not show the period's value at every size.**
   `SummaryStrip` now renders two rows everywhere: an interval label on top and
   the period's value underneath. At `full` detail the request count joins the
   label on the top row, right-aligned, so it appears only when the cell is wide
   enough that neither it nor the label truncates. Micro centres the label row
   because there is no value to show. Implemented with a `.cell-top` wrapper in
   `src/renderer/components/strip.ts` plus the matching CSS.

7. **The chart value axis had the wrong precision and could clip its labels.**
   Two separate budgets now exist in `src/shared/format.ts`. The *axis* budget
   (`formatAxisValue` -> `formatSpendAxis`/`formatTokensAxis`) allows four
   significant digits, never resolves spend below $0.001, and switches to K/M/B
   so a large value stays short. The *display* budget (`formatMetricValue`) is
   richer and is what the strip, headline, increase chip and breakdown rows use,
   which is why a headline can read `$0.06480` while its axis reads `$0.065`.
   `generateValueTicks` takes a `minStep` so a step is snapped up to the next
   1-2-5 value instead of going finer than $0.001, and `ChartRenderer` measures
   the widest tick label with `ctx.measureText` to size the left gutter, so the
   leftmost digits are never cut off.

8. **The Tokens axis did not auto-scale.**
   It already did; the axis looked wrong because of issue 3. Routing tokens
   through `formatTokensAxis` and the measured gutter fixed the appearance, and
   the axis now scales cleanly at every range and size (`1.500M`, `60.00M`).

9. **The log graph and its setting.**
   The logarithmic time axis is gone. `ChartRequest`, `ChartData` and
   `ChartOptions` no longer carry an `axis`, `settings.chart_axis` is removed from
   the interface, the defaults and the schema, the Log/Linear control next to the
   chart and its warning are removed, and `src/shared/logAxis.ts` is now a linear
   `TimeAxis` module (`createTimeAxis`, linear `generateTicks`, `hitTest`,
   `barGeometry`). The "Linear axis" on-canvas badge and the now-dead decade
   tick tables went with it.

10. **Expanding a settings section jumped the view to the top.**
   Re-rendering settings replaced the scroll container. `renderSettings` now
   records `.view.scroll`'s `scrollTop` into `state.settingsScroll` through a
   passive scroll listener, and restores it after the new content is attached,
   clamped to the new `scrollHeight`. Expanding a group keeps its header in place.

11. **The Keys tab used a padlock instead of a key.**
   `ICONS.api` in `src/renderer/components/dom.ts` is now a key: a ringed bow
   drawn as two opposing circles so the nonzero fill leaves a hole, plus a shaft
   and two teeth.

12. **The Keys tab showed no data.**
   The database holds twelve configured keys but only one had usage in the
   selected interval, and the breakdown was built from usage rows alone, so the
   other eleven silently vanished. `mergeKeysIntoRows()` now appends a row for
   every known key with no usage, sorted by label, and those rows read
   `no usage in this interval` with dimmed styling rather than `$0.00`, which   would have been a lie.

13. **The Models tab showed no data.**
   The models table was fine; the tab was reporting on data that issue 3's
   formatting made unreadable. Models now uses the unified display budget, and the
   capture shows the model row with its tokens and spend.

14. **The Tokens tab used different precision from Spending.**
    Strip cells, the headline, the increase chip, the chart subtitle and the
    breakdown rows all route through `formatMetricValue`, so tokens and spend are
    formatted by the same rules (`376.1M`, `$5.00`).

15. **The odometer roll and the increase chip.**
    Both are implemented in `src/renderer/components/odometer.ts` and verified
    live. `planRoll` walks each changed column forward by at most nine digits,
    least significant first, one `BEAT_MS` apart, compressed only if the cascade
    would overrun its window; a fall or a change of string shape is repainted
    instead of rolled. The chip appears on a rise and flashes once. Verified with
    a live snapshot: the columns stepped `406 -> 506 -> 507 -> 508` across frames
    and the chip rendered `↑ $0.008000` with its flash class applied.

    *Amended:* this entry originally closed with "an increase too small to change
    the formatted text starts no roll at all, because there is nothing to travel."
    That was true but it was the bug, not the behaviour: on a live account the
    headline's two decimals rounded away real increases, so the roll legitimately
    had nothing to animate while the number was in fact rising. See issue 16.

16. **The headline never rolled and the increase chip had stopped appearing.**
    Three separate faults, all of which had to be fixed for the roll to be visible.

    *The headline was rounded too coarsely.* `formatMetricValue('spend', …)` prints
    two decimals above a dollar, so a live 24-hour total of `$4.5162` rendered as
    `$4.52` and an increase of up to half a cent left the string identical. Since
    `planRoll` and `animateHeadline` both bail when `fromText === toText`, a rising
    counter sat perfectly still. Spend in the headline now goes through
    `formatSpendHeadline`, which keeps three decimals below $1,000 — a $0.001 step
    — and four significant digits below a dollar. Strip cells and tooltips keep the
    old, tighter form, because a cell has a fixed width to fit.

    *The first increase after launch was never diffed.* `boot()` painted the first
    frame before `state.headline` had any value, and `trackDelta` only records a
    change when a previous snapshot for the same interval exists. The first pushed
    snapshot therefore became the baseline instead of a change, so the chip was
    absent exactly once — which is why it looked intermittent rather than broken.
    `boot()` now seeds the baseline with `trackDelta(snapshot)` before painting.

    *The chip's life was shorter than a refresh.* `INCREASE_TTL_MS` was a fixed
    5 s against a default 10 s refresh, so the chip was on screen for only half of
    every cycle. Both the chip's lifetime and the roll's duration are now derived
    from `parameters.refresh_sec`: the chip lasts 1.2 cycles clamped to 5–20 s, and
    the roll takes at most 18 % of a cycle (1.8 s at the default) so it always
    finishes before the next change arrives.

    Verified in a browser harness with a mock `window.widget`: a single snapshot
    push immediately after boot now yields `metric-increase is-new` reading
    `↑ $0.08000` and `.odo` columns in the headline, and the headline text changes
    on every push that moves spend by a cent or more.

17. **The window background was translucent.**
    `tauri.conf.json` had `transparent: true` and `shadow: false`, and every surface
    in `app.css` was a translucent tint under a `backdrop-filter: blur(18px)`
    shell. A widget reads as a solid panel, and a blurred backdrop would smear the
    panned chart underneath it. The window is now `transparent: false` with
    `shadow: true`; `--panel`, `--panel-raised` and the page background are opaque
    in both themes, the `backdrop-filter` is gone, and the status bar and tab bar
    use a `color-mix` shade of the panel instead of a wash of translucent black,
    each with an opaque fallback declared first for engines without `color-mix`.

18. **The chart did not pan smoothly; it jumped once per refresh.**
    Issue 2 made the chart follow the clock, but only by re-anchoring on each load,
    so the window advanced in steps — once per snapshot, and by however much time
    had passed since the last one. Two changes make it continuous:

    `t_end` is now the clock rather than the fetch time, and `t_start` is
    `t_end - (period_end - period_start)`, so the window keeps the period's full
    width and advances exactly one screen-span per span of wall clock — a 10-minute
    chart moves one minute of axis every minute. A `requestAnimationFrame` loop in
    `ChartRenderer` repaints every frame while `live` is set, and stops when the
    chart is pinned, hidden, or destroyed.

    The axis no longer clamps (`createTimeAxis` takes `{ clamp: false }`), so a
    bucket that slides past the left edge leaves the plot instead of pinning to it
    and reading as the newest value; bars are clipped to the plot rectangle so they
    cannot paint over the value gutter. Hit-testing was measuring the canvas rather
    than the plot, which put the pointer up to a gutter's width away — about 26 px
    at the left edge — from the bar under it; it now uses the geometry the bars were
    drawn with. A motionless pointer re-reads its bucket each frame, so the tooltip
    follows what slides under it instead of freezing on the bucket that was there
    when the pointer last moved. The period label is computed from the same two
    instants, so it names the window actually on screen rather than the fetch time.

    Measured in the browser harness against aperiodic mock data: the plot and the
    axis strip both change every frame, and the frame-to-frame shift realigns at
    the expected 1.41 px/s for a 10-minute chart.

19. **Display opacity changed in Settings but did nothing.**
    The slider patched `settings.display.opacity`, but no runtime path ever applied
    it to the rendered widget. The value was saved and reported by
    `window:getState`, yet the on-screen opacity stayed at 100%.

    Fixed in `src-tauri/src/shell.rs`, `src-tauri/src/bridge.rs`, and
    `src/renderer/index.ts`:
    `settings_set` now applies `display` runtime fields immediately, and the shell
    replays display runtime fields on startup (`always_on_top`, `ghost`) instead of
    forcing `always_on_top` to `normal`. Opacity is now applied natively on macOS
    through `NSWindow.setAlphaValue` (40–100% clamped), and `window_state` exposes
    `native_opacity` so the renderer can skip double-applying opacity when the host
    already handles it; the DOM fallback remains for browser harnesses.

    This makes the setting persistent and live: changing the slider updates the
    window right away, and relaunch keeps the selected opacity.

20. **The most recent chart bar did not appear live.**
    `render()` destroyed `ChartRenderer` on every snapshot, so each payload was a
    first paint with no previous height to grow from. The payload also clamped
    `bin.end` to the fetch instant, which froze the current bar's width until the
    range was changed. The renderer is now reused via `reattach`, the payload keeps
    the nominal bucket end, and a live chart grows the current bar to `now`
    between fetches.

21. **New data did not grow from the existing bar and turn solid after four seconds.**
    Height animation is planned in `src/shared/barGrowth.ts`: the previous value
    stays put, the increment rises in 480 ms, and the whole bar turns solid after
    4 s. A DOM rebuild keeps an in-flight plan so `setData` twice cannot restart
    the solidify. Spend draws the increment in amber (`#fbbf24`); tokens keep the
    stack and cap the rise the same way.

22. **Confirm the increase chip when new data arrives.**
    The chip was already driven by `trackDelta` on every snapshot, using the same
    window cell as the headline. That path is unchanged: `handleSnapshot` records
    the delta before `render()`, so a rise still produces `↑` with the interval
    change and a fall still produces `↓ Recalculated`. Chart reuse no longer
    rebuilds the renderer in a way that would hide it.

23. **The interval buttons and the headline did not add up with the chart.**
    Windows used one granularity for the whole trailing range while the chart
    chose per bin, so a 24-hour total dropped the current hour of minute rows
    whenever hour rows "covered" the range. Bins are now clipped to the trailing
    window (half-open on the bucket start), and `computeWindows` sums the same
    bins `buildChart` draws. The selected interval, the headline, and the bar sum
    are one number. The five buttons overlap and are never summed together.
    `live_snapshot` / `live_chart` now pass collection ranges and honour `keyId`.

24. **The first click on an unfocused window only activated it.**
    macOS swallows the first click on an inactive window to activate it, so a
    press on the drag region highlighted the widget and only the second press
    moved it. The window now sets `acceptFirstMouse: true` in
    `src-tauri/tauri.conf.json`, which makes the activation click also reach the
    webview. A press on the status bar starts the drag on the first click, and a
    press on a control acts on the first click too. Verified by launching the
    rebuilt app and dragging from an unfocused state.
