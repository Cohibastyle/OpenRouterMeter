# Issues

Keep a list of issues here and their status.

## Open Issues

None outstanding. This batch is closed; see below.

## Closed Issues

1. **The window could not be moved on macOS.**
   The status bar carried `-webkit-app-region: drag`, but the frameless
   `transparent: true` window with a `backdrop-filter` on the shell breaks the
   native drag hit test, so no press ever started a move. The bar now also drives
   the window from script: on `pointerdown` it waits `DRAG_ARM_MS` (90 ms) for the
   platform to take the press, and if the window origin has not changed it takes
   over and moves the window with `window:moveBy`, one delta per `pointermove`.
   A press the platform *is* handling ends the script instead, so the window never
   moves twice. Verified: a synthetic six-step drag moved the window 168x84 px.

2. **The interval buttons did not show the period's value at every size.**
   `SummaryStrip` now renders two rows everywhere: an interval label on top and
   the period's value underneath. At `full` detail the request count joins the
   label on the top row, right-aligned, so it appears only when the cell is wide
   enough that neither it nor the label truncates. Micro centres the label row
   because there is no value to show. Implemented with a `.cell-top` wrapper in
   `src/renderer/components/strip.ts` plus the matching CSS.

3. **The chart value axis had the wrong precision and could clip its labels.**
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

4. **The Tokens axis did not auto-scale.**
   It already did; the axis looked wrong because of issue 3. Routing tokens
   through `formatTokensAxis` and the measured gutter fixed the appearance, and
   the axis now scales cleanly at every range and size (`1.500M`, `60.00M`).

5. **The log graph and its setting.**
   The logarithmic time axis is gone. `ChartRequest`, `ChartData` and
   `ChartOptions` no longer carry an `axis`, `settings.chart_axis` is removed from
   the interface, the defaults and the schema, the Log/Linear control next to the
   chart and its warning are removed, and `src/shared/logAxis.ts` is now a linear
   `TimeAxis` module (`createTimeAxis`, linear `generateTicks`, `hitTest`,
   `barGeometry`). The "Linear axis" on-canvas badge and the now-dead decade
   tick tables went with it.

6. **Expanding a settings section jumped the view to the top.**
   Re-rendering settings replaced the scroll container. `renderSettings` now
   records `.view.scroll`'s `scrollTop` into `state.settingsScroll` through a
   passive scroll listener, and restores it after the new content is attached,
   clamped to the new `scrollHeight`. Expanding a group keeps its header in place.

7. **The Keys tab used a padlock instead of a key.**
   `ICONS.api` in `src/renderer/components/dom.ts` is now a key: a ringed bow
   drawn as two opposing circles so the nonzero fill leaves a hole, plus a shaft
   and two teeth.

8. **The Keys tab showed no data.**
   The database holds twelve configured keys but only one had usage in the
   selected interval, and the breakdown was built from usage rows alone, so the
   other eleven silently vanished. `mergeKeysIntoRows()` now appends a row for
   every known key with no usage, sorted by label, and those rows read
   `no usage in this interval` with dimmed styling rather than `$0.00`, which
   would have been a lie.

9. **The Models tab showed no data.**
   The models table was fine; the tab was reporting on data that issue 3's
   formatting made unreadable. Models now uses the unified display budget, and the
   capture shows the model row with its tokens and spend.

10. **The Tokens tab used different precision from Spending.**
    Strip cells, the headline, the increase chip, the chart subtitle and the
    breakdown rows all route through `formatMetricValue`, so tokens and spend are
    formatted by the same rules (`376.1M`, `$5.00`).

11. **The odometer roll and the increase chip.**
    Both are implemented in `src/renderer/components/odometer.ts` and verified
    live. `planRoll` walks each changed column forward by at most nine digits,
    least significant first, one `BEAT_MS` apart, compressed only if the cascade
    would overrun its window; a fall or a change of string shape is repainted
    instead of rolled. The chip appears on a rise and flashes once. Verified with
    a live snapshot: the columns stepped `406 -> 506 -> 507 -> 508` across frames
    and the chip rendered `↑ $0.008000` with its flash class applied. An increase
    too small to change the formatted text starts no roll at all, because there is
    nothing to travel.
