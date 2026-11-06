# Functional Specification Document

## 1. Project

Name: OpenRouter Desktop Widget
Document status: Build specification, pending API checks
Target: Windows 10/11, macOS 12+, and Linux (X11, plus Wayland where the compositor allows)
Form factor: A frameless, always-on-top desktop widget that the user can resize responsively from a small badge to a full dashboard

Build a desktop widget that shows spending, token usage, charts, and the latest request across an OpenRouter account. The widget is a self-contained desktop application: it stores the OpenRouter credential in the operating system credential store, collects usage itself, keeps local history, and renders a compact dashboard that floats above other windows.

All values shown during development must be marked as sample data until a real account is connected.

## 2. Goals

- Float above normal application windows on every supported platform, and stay visible across virtual desktops and full-screen spaces where the platform permits.
- Resize responsively: the same content reflows continuously from a 180 x 120 badge to a large dashboard, with no clipped text, no horizontal scrolling, and no layout breakage at any intermediate size.
- Show account wide spending and input, output, and total tokens.
- Show hourly, daily, weekly, and monthly charts.
- Show the latest request, its API key name, model, timestamp, tokens, and cost.
- Animate only when a different request arrives.
- Keep the OpenRouter management credential in the OS credential store, never in plain files or renderer memory longer than needed.
- Preserve history and window state through application restarts.
- Clearly report delayed, incomplete, missing, and stale data.
- Stay lightweight: low idle CPU, bounded memory, no background work when the widget is hidden.

## 3. Out of scope for first release

- Sending model requests from the widget.
- Editing or deleting OpenRouter API keys.
- Showing request prompts or response content.
- A hosted companion service, multi-device sync, or remote access.
- Automatic collection through website scraping or private browser endpoints.
- Treating missing historical data as zero usage.
- Guaranteed full account request coverage until a supported collection method is proven.
- Mobile, tablet, or web builds.

## 4. Required checks before integration

Do not treat previous screen concepts or endpoint examples as verified API contracts.

### 4.1 Platform checks

Verify on real hardware for each target platform before finalizing window behavior. Record results in docs/platform.md.

- Windows 10 and 11: always-on-top above normal windows, above maximized windows, and above full-screen apps; behavior with the taskbar, virtual desktops, and display scaling at 100, 125, 150, and 200 percent.
- macOS 12 and later: floating window level, visibility across Spaces, behavior over full-screen apps, behavior when the app is not active, and menu bar and Dock presentation for an accessory-style app.
- Linux X11: always-on-top hint honored by GNOME, KDE, and one tiling window manager.
- Linux Wayland: confirm what the compositor actually allows. Most compositors do not let a client force always-on-top. Document the limitation and the fallback in section 6.6.
- Frameless window resizing: confirm edge and corner resize works on each platform, including when the window is transparent and when it is at the 180 x 120 minimum.
- Multi-monitor: confirm restore onto the correct display, and correct behavior when a display is disconnected while the widget is open.

### 4.2 OpenRouter checks

Use current official documentation and a test account to confirm:

- Supported account spending and token endpoints.
- Required credential type and permissions.
- Current time grouping options, history limits, pagination, rate limits, and reporting delay.
- Whether account scope includes all workspaces or requires combining them.
- Whether totals include inactive and deleted keys.
- Whether request records include generation ID, key identifier, time, cost, and tokens.
- Whether a supported account wide request feed or export exists.
- Whether a supported trace delivery feature can supply the required records.
- How reasoning tokens, cached tokens, retries, refunds, and external provider usage are reported.

Account credits, analytics, activity, generation lookup, key listing, and trace delivery are candidate capabilities, not a promise that one endpoint supplies every field. Record confirmed contracts and sample redacted responses in docs/openrouter-api.md. Do not implement unverified analytics paths from conversation examples.

Gate: if latest requests cannot be collected account wide, explain the gap and require an approved collection option before calling the feature complete.

## 5. System design

### 5.1 Parts

1. Main process: window lifecycle, always-on-top policy, tray, global shortcuts, credential access, collection scheduler, database, and IPC handlers.
2. Renderer: the widget UI. Sandboxed, no Node.js access, no network access of its own.
3. Preload bridge: a narrow, typed, allowlisted IPC surface exposed through the context bridge.
4. Local store: SQLite database for history and settings, plus the OS credential store for the OpenRouter key.

Suggested first implementation:

- Shell: Electron with a frameless, transparent, always-on-top `BrowserWindow`.
- Renderer: plain HTML, CSS, and TypeScript with no UI framework required; add one only if the chart and list code justifies it.
- Charts: a small canvas or SVG renderer sized from a resize observer, not a fixed pixel canvas.
- Storage: SQLite through a maintained binding, with migrations applied on startup.
- Packaging: electron-builder for Windows, macOS, and Linux, with code signing and notarization where available.

These are project choices. Keep collection, storage, and rendering separate so any one can change.

### 5.2 Data path

OpenRouter sources -> collectors in the main process -> normalized SQLite database -> period totals and chart bins -> IPC -> renderer views.

The renderer never holds the OpenRouter credential and never calls OpenRouter directly. All network access happens in the main process.

### 5.3 Process and security model

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`.
- The renderer loads only local files. No remote content, no in-app navigation, no `window.open`.
- A strict Content Security Policy with no `unsafe-eval` and no remote script or style origins.
- The preload exposes a fixed set of named methods. No generic `invoke(channel, payload)` passthrough.
- Every IPC handler validates its arguments and returns data only for the requested view.
- A single instance lock prevents two widgets from running against one database.

## 6. Window and desktop integration

This section is the core of the product. The widget is only useful if it is reliably visible and reliably resizable.

### 6.1 Window configuration

- Frameless (`frame: false`), transparent background, no native title bar, no system shadow.
- Resizable, maximizable, and minimizable, with a custom drag region and custom window controls.
- Always on top by default, with a user toggle.
- Hidden from the taskbar and from the window switcher where the platform supports it, so it behaves like a widget rather than a document window.
- Not shown in the Dock on macOS; presented through the menu bar item instead.
- Restored on launch to the last saved bounds, always-on-top state, opacity, and display.

### 6.2 Always-on-top policy

- Default state: on top of normal windows.
- Use the platform's floating window level rather than a plain topmost flag, so the widget sits above normal windows but below system dialogs, menus, and permission prompts.
- Provide a second, stronger level that also stays above full-screen applications, off by default, because it can obscure video playback and presentations.
- Never place the widget above system security prompts, screen sharing indicators, or the lock screen.
- On macOS, keep the widget visible across Spaces and over full-screen apps only when the user enables the stronger level.
- On Windows, reassert the topmost state after display changes, session unlock, and resume from sleep, because some drivers and shell events drop it.
- On Linux X11, set the always-on-top hint and reapply it after a workspace switch.
- Provide a "temporarily hide" action bound to a global shortcut, so the widget can be dismissed without closing it.

### 6.3 Placement, snapping, and multi-monitor

- Snap to screen edges and corners within a small threshold, with a visible snap preview.
- Remember bounds per display identity, and clamp restored bounds into the visible work area so a widget cannot be restored off-screen.
- When the saved display is missing, restore to the primary display at the default size.
- Respect the work area, not the full display bounds, so the widget does not sit under the taskbar, Dock, or menu bar.
- Support a "keep inside work area" option that prevents dragging the widget fully off-screen.
- Handle display scale changes and resolution changes without losing the widget or its size class.

### 6.4 Interaction modes

- Normal mode: the widget accepts clicks and drags.
- Ghost mode: the widget ignores mouse events and passes them to the window underneath, with a global shortcut and a tray item to exit. Use a forwarded mouse-move so hover affordances still work while ignoring clicks.
- Locked mode: prevents accidental dragging and resizing while still allowing scrolling and taps inside the content.
- Opacity control from 40 to 100 percent, with a floor that keeps text legible.
- Optional click-through only over the background, not over controls.

### 6.5 Persistence and lifecycle

- Persist window bounds, display, always-on-top level, opacity, interaction mode, size class overrides, and the last selected view.
- Debounce bounds writes; do not write to disk on every resize frame.
- Optional launch at login, off by default.
- Tray or menu bar item with show or hide, always-on-top toggle, ghost mode, refresh now, open settings, and quit.
- Quit must stop collection cleanly and close the database without losing pending writes.
- On suspend, pause polling. On resume, refresh immediately and mark data as possibly stale until the first success.

### 6.6 Platform limitations to document

- Wayland compositors generally do not allow a client to force always-on-top. Detect the session type and show a one-time notice explaining that the user must set the rule in the compositor, or run the X11 session.
- Some Linux window managers ignore the skip-taskbar hint.
- Transparent frameless windows can show a black background on certain Linux compositor and GPU combinations. Provide a documented opaque fallback that keeps the same layout.
- macOS may move the widget behind full-screen apps unless the stronger level is enabled.

## 7. Responsive layout system

The widget must remain correct at every size between the minimum and a large dashboard. Layout is driven by the container size, not by device pixel width, so it behaves identically on any display scale.

### 7.1 Size constraints

- Minimum window size: 180 x 120 logical pixels.
- Default window size: 320 x 240 logical pixels.
- Maximum size: bounded only by the display work area.
- Minimum content size must still show one metric, its label, and a status indicator.

### 7.2 Size classes

Width classes:

- XS: below 240
- S: 240 to 359
- M: 360 to 519
- L: 520 to 799
- XL: 800 and above

Height classes:

- Short: below 200
- Regular: 200 to 399
- Tall: 400 and above

Derived layout modes:

- Micro: XS width or Short height. The range strip, one headline value, a status dot, and the tab bar as an icon rail.
- Compact: S or M width with Regular height. The range strip, the headline value, and the chart. Tabs use an icon rail at S width.
- Standard: M or L width with Regular or Tall height. The range strip, the headline value, and, once the window is at least 280px tall, the chart.
- Expanded: L or XL width with Tall height. The same content with a taller chart.

### 7.3 Responsive rules

- Use CSS container queries and flex or grid layout. Do not use fixed pixel positions or absolute coordinates for content.
- No horizontal scrolling at any size. No element may overflow its container.
- Text truncates with an ellipsis and exposes the full value through a tooltip or a detail view. Values never wrap mid-number.
- Numeric values use tabular figures so they do not jitter while resizing or updating.
- Charts re-render from a resize observer with debouncing, and reduce axis label count as width shrinks. Below the S width class, show a sparkline with no axis labels. The sparkline still uses the logarithmic time mapping from section 10.12.1.
- The tab bar shows labels at M width and above and becomes an icon rail below M width, at every size down to the minimum. It never collapses to a pager: all five tabs stay reachable at every size.
- Cards reflow from a row to a column as width decreases, and hide secondary metrics before primary ones.
- Hide, do not shrink below legibility: when space runs out, drop the least important element rather than rendering 8 pixel text. The chart is the first casualty in Standard mode: below 280px of window height it is dropped rather than compressed, because the strip, the headline, and any source note have already taken the room and a shorter plot would clip its own X-axis labels against the tab bar. The chart's value axis sheds grid lines as the plot shortens, so a small chart keeps readable labels instead of overlapping ones.
- Respect the OS text scale setting and the platform minimum font size. Test at 100, 125, 150, and 200 percent scaling.
- Support a user-selected density: Comfortable or Compact, which changes padding and font size but not the layout mode thresholds.
- Resizing must not reset the selected view, period, or scroll position.
- Resizing must not trigger a network fetch. Only a size class change may request additional data, and only if the new mode needs it.

### 7.4 Resize behavior

- Provide visible resize affordances on all edges and corners, drawn inside the window so they work with a transparent frameless shell.
- Show a size readout while resizing, and snap to the defined size class boundaries when the user is close to one.
- Double-clicking the drag region toggles between the last compact size and the last expanded size.
- A "reset size" action restores the default 320 x 240.
- Resizing must stay smooth: no layout thrash, no synchronous database reads, and no full re-render of the chart on every frame.

## 8. Account scope and accounting rules

Default scope: entire connected account, not just the key used for authentication.

Where several sources are needed, avoid counting the same request twice. Sum unrounded decimal monetary values and round only for display. Store money as decimal strings or fixed precision database values, never binary floating point for accounting totals.

Default money measure: charges against OpenRouter credits in USD. External provider costs, if supported, must be a separate optional measure with a clear label. Do not combine them silently.

Keep two data classes separate:

- Provider reported aggregates, used for account totals when supported.
- Collected usage records, used for the latest bucket and group detail.

Never label a partial request sum as an authoritative account total. Track coverage independently for spending, tokens, and requests.

Token rules:

- Show input, output, and total separately.
- Preserve source reported total when supplied.
- Derive total as input plus output only when source definitions permit it.
- Keep cached input and reasoning details as optional subsets according to the source schema.
- Never add subset counts twice.
- Missing counts remain null, not zero.

## 9. Time and history

Default display zone: the operating system zone, with an explicit override. Store timestamps in UTC and group using the selected display zone.

- Hour view: current local day, one bin per hour.
- Day view: current local month, one bin per calendar day.
- Week view: last 12 calendar weeks, default Monday start.
- Month view: last 12 calendar months.
- Allow previous and next period controls; disable forward movement beyond the current period.
- Show the selected interval and its totals together.
- Current bins are partial and must be marked as such.
- Use real calendar boundaries, not fixed 24 hour assumptions in zones with clock changes.
- If source data is daily UTC only, do not claim exact local hourly or local daily totals from it.
- Report the earliest reliable history date and gaps.
- Period selection is independent of the chart axis. The logarithmic axis in section 10.12.1 changes only where a bin is drawn, never which bins exist or what they total.

Persist data in the local database. Raw request retention defaults to 90 days and is configurable. Keep aggregate history for at least 24 months when available. Label partial coverage if retention or missing imports limit a chart.

## 10. Display

### 10.1 Tab model

The widget has five primary tabs, always in this order.

| Tab | Purpose | Summary strip | Accent |
|---|---|---|---|
| Spending | Spend for the selected interval, with a spend chart | Yes | green `#34d399` |
| Tokens | Token total for the selected interval, with a token chart | Yes | orange `#fb923c` |
| Keys | Per-key breakdown of the selected interval | Yes | purple `#a78bfa` |
| Models | Per-model breakdown of the selected interval | Yes | blue `#60a5fa` |
| Settings | Parameters, display, credential, scope, version, support, diagnostics, log | No | slate `#94a3b8` |

The Log is not a tab. It is the last group in Settings, so the app log sits with the other diagnostic material rather than competing for a tab slot.

Each tab has its own accent colour. The accent is applied the same way on every tab, and Spending is the reference implementation:

1. the tab label and its underline when active
2. every interval figure in the summary strip
3. the selected interval's border, fill, and label
4. a headline value, if the tab has one
5. the token column of a breakdown table
6. the chart, where the tab has one

Rules the accent application must follow:

- There is exactly one source of truth for interval figure colour, the tab accent variable. A tab may not hardcode a colour for its interval values; doing so made Keys and Models show green money beside a purple or blue selected cell, so one interval looked like two different measures.
- Money in a table body stays primary text rather than taking the accent. The accent is a mid-tone, so a spent dollar amount in it reads as a label instead of a figure.
- The accent is a light tint with strong contrast against the panel in both themes. No accent and no value text is black, because black on the widget background is unreadable.
- The Tokens chart uses the same orange as the Tokens accent, with output tokens as a lighter tint of that hue so the stack still reads as one bar.

Charts is not a tab. It is a subview opened from the Spending tab, from a summary strip cell, or from a total, and it returns to the view that opened it.

- The tab bar is always visible and always shows all five tabs. Below M width it renders as an icon rail rather than a labelled bar.
- The selected tab persists across restarts and is restored before the first paint.
- Switching tabs must not refetch data that is already cached and younger than the snapshot interval.
- Keyboard: `1` through `5` select tabs, `Tab` and `Shift+Tab` move focus within the summary strip, and `Escape` closes a subview.
- The scope control lives in Settings and is a global filter. It applies to the Spending, Tokens, Keys, and Models tabs and to the Charts view. The active scope is always visible in the status strip, for example `All keys` or `prod-key`.
- The Log and Settings tabs are utility tabs. They never show the rolling window strip, and they never trigger a source fetch.
- Tab labels shorten to icons below the M width class. Each icon keeps an accessible name and a tooltip.

### 10.2 Shared layout

Use a dark background with a subtle translucent panel, clear text, and consistent colors: cyan for input, violet for output, green for spending. Labels and values must remain useful without color.

Layout regions, which appear or collapse by size class:

- Drag and status strip: window drag region, connection state, data age, and window controls.
- Primary metrics: today spending and today total tokens.
- Secondary metrics: current month spending, input and output split.
- Trend: compact current day sparkline or full chart.
- Latest request: key name, model, time, tokens, and cost.
- Navigation: the five tabs from section 10.1.

Use pointer targets of at least 24 x 24 logical pixels, and 32 x 32 where space allows. Keep the selected tab, metric, period, and scope visible. Use consistent Back controls on subviews.

### 10.3 Rolling window summary strip

The Spending, Tokens, Models, and Keys tabs show the same range strip at the top of their content area. The Log and Settings tabs do not. The strip reports five trailing ranges, shortest first.

| Range | Label | Range | Source granularity |
|---|---|---|---|
| 10 minutes | `10m` | [T - 10 min, T] | minute |
| 1 hour | `1h` | [T - 1 h, T] | minute |
| 3 hours | `3h` | [T - 3 h, T] | hour |
| 6 hours | `6h` | [T - 6 h, T] | hour |
| 24 hours | `24h` | [T - 24 h, T] | hour |

The set stops at 24 hours deliberately. Minute buckets are retained for 2 hours and hour buckets for 24, so a longer window would have to fall back to day buckets. That would put a visibly coarser bar width next to the shorter ranges and make the totals disagree with them. A month-long view lives in the Charts subview, which is allowed to use day buckets.

Each range is a button that shows its own value and, when clicked, renders that range's chart inline below the strip. The chart carries a `Log` / `Linear` toggle for its X axis, and its Y axis always shows value labels.

`T` is the evaluation instant, set to the current time at the last successful collection tick.

Rules:

- Windows are trailing and overlapping. They are not additive and must never be summed or compared as if they were disjoint.
- The one day window is a trailing 24 hours, not the calendar day. Label it `24h` in the UI so it cannot be confused with the calendar today total in section 10.6.
- Each cell shows the window label, the metric value, and the request count, and carries a coverage marker. How many of those three are drawn depends on the width available to the cell, per section 10.3.1.
- The strip recomputes on every snapshot tick, default 10 seconds, and on tab change. It does not recompute on resize.
- Values update in place. Only the new request transition in section 10.13 animates.

#### 10.3.1 Responsive cell detail

The strip is the range selector, so it must stay usable from the minimum window size upward. Rather than truncating a fixed layout, each cell drops detail as it narrows. Three levels exist:

| Level | Shows | Cell content width |
| --- | --- | --- |
| `label` | The interval alone, centred | below 58px |
| `value` | Interval above the figure, stacked | 58px and above |
| `full` | Interval, figure, and request count on one line | 132px and above |

- The interval label is always drawn. It is the cell's identity and the range button, so it is the last thing to go.
- The strip is always five columns, so the level is a function of window width alone. It is computed rather than expressed as a media query, so the thresholds stay in one place and are covered by tests.
- Content width is the window width minus the view padding and the gaps between cells, divided by five, minus the cell's own padding.
- At the 180 x 120 minimum and at 320 x 240 the cells are label-only. A value first appears at 480px, and the request count at 900px.
- `full` is a genuinely different layout, not the stacked one with an extra row: all three parts share a line, with the count pushed to the right edge.
- The level only ever increases as the window widens. A cell never shows less detail at a larger size.
- The tooltip and the accessible name always carry the full value, the request count, and the coverage reason, so nothing is lost when the cell is too narrow to draw it.

### 10.4 Metric selection

- Each tab has a metric selector for the strip: Spend or Tokens.
- Defaults: the Spending tab uses Spend, the Tokens and Models tabs use Tokens, and the Keys tab uses Spend.
- The choice is persisted per tab.
- Every tab uses the same three-level cell detail from section 10.3.1. The request count is not a per-tab option: it appears in every cell once the cell is wide enough, and is dropped when it is not.

### 10.5 Computability and coverage

A window value is shown only when it can be computed honestly.

- A window is computable from request records, or from aggregate bins whose width is at most one quarter of the window.
- If the finest available source is hourly aggregates, the `1h` window is `Unavailable` with reason `source_granularity`. Never interpolate a short window from a coarse bin.
- If collection started after the window start, the cell is partial with reason `collection_started_later`.
- If a known gap overlaps the window, the cell is partial with reason `gap`.
- If the window extends before the retention horizon, the cell is partial with reason `retention`.
- If the last successful collection is older than the stale threshold, the whole strip is marked stale and keeps its last values.
- Missing is never rendered as zero. A confirmed zero renders as `0` with no marker.

Each cell carries `value`, `unit`, `window_start`, `window_end`, `coverage` (`full`, `partial`, or `unavailable`), `partial_reason`, and `as_of`.

### 10.6 Spending tab

- Rolling window summary strip from section 10.3, whose cells double as the range buttons. The selected interval is highlighted with the tab accent.
- Below the strip: an inline chart for the selected interval, with a Log/Linear axis toggle and Y axis value labels.
- The headline is the spend for the selected interval. It is never a calendar day unless `24h` is selected. The headline carries no interval label: the highlighted range button above it already names the interval, so a `3h spend` caption would repeat it.
- Beside the headline, a `Last` chip shows the most recent increase: an up arrow and the amount the figure rose since the previous refresh, with the number of requests that arrived with it underneath. It describes a refresh-to-refresh delta, so it is only computed while the same interval stays selected; changing the range rebases the baseline instead of reporting the difference between two different periods. A rise fades out after five seconds and is then removed, and a refresh that does not raise the figure leaves the chip alone rather than showing a decrease. A freshly recorded rise inverts the chip for under a second — the chip fills with the tab accent and its text takes the panel colour — so a delta the eye has not seen before announces itself. The fill is grown with a spread shadow rather than with padding, because the headline is fitted to its box and a wider chip would resize the number. With animations off or reduced, the chip does not invert. In Micro and Compact, where the headline is sized to fill the window, the chip sits on its own row under the number instead of beside it: beside it, the chip would take width from the number and force the fit to shrink it. The fit reserves the chip's height through a slot that stays in the row even when no rise is being shown, so the number keeps one size and one position as chips appear and expire; the chip itself is removed once faded.
- The headline rolls to a new value with single-pass digits, so a refresh reads as a counter moving rather than a number being replaced. The roll starts from the value already on screen, so a refresh that lands mid-roll continues forward.
- Every column makes one pass and stops. A digit travels the shortest forward distance from its old value to its new one, so at most nine steps, and a digit that does not change does not move at all. `$4.123` to `$6.456` is eleven digit steps in total; a carry-chain counter would instead drag the last column through the whole numeric delta, 2333 steps, which reads as a spin rather than as a count.
- Columns run least significant first, and each starts one beat after the column to its right, so the carry reads as a cascade rather than every digit moving at once. An odometer's true ratio of ten would make the leftmost digit of a large increase take hundreds of turns, so the beat is a fixed fraction of a digit's travel instead.
- The cascade runs at a fixed pace: a digit takes 105 ms to move and columns start 170 ms apart. The pace does not stretch to fill the window, because a settle time that swings with the size of the increase makes the counter feel inconsistent between refreshes; a roll that finishes early simply rests on its new value. The window is a ceiling, and a roll wide enough to overrun it is compressed uniformly so the beats and the travel stay in proportion.
- A digit decelerates into place and stops dead. Overshoot was measured and rejected: a bounce kicks past the target by a fraction of each column's own travel, so a two-digit increase reverses through a whole digit while a one-cent increase moves imperceptibly, and a number that travels backwards reads as a counting error.
- A value that falls is painted directly rather than rolled, because a backwards roll reads as a second event rather than as the same number decreasing.
- The same engine serves the Spending and Tokens headlines. With animations off or reduced, the value is set directly.
- In Micro and Compact the headline is sized to fill the space it is given, per section 10.6.1. At Standard and above it keeps a fixed display size, because it shares the tab with a chart.
- The only line under the headline is a coverage warning, shown when the selected interval is partial or unavailable. A sound interval shows nothing there: the request count, the live-counter note, the month total, and the latest usage bucket were all removed so the tab is the headline and the chart.
- Clicking a range button re-scopes the headline, the strip highlight, and the inline chart to that trailing interval. The X axis always matches the selected button: `10m` spans the last ten minutes, `1h` the last hour, `3h` the last three hours, `6h` the last six hours, and `24h` the last day.
- Show connection, data age, and coverage warnings.

Use compact account values such as 148.2K, but exact counts in group detail. Show small spend values with enough precision to avoid displaying a real charge as zero.

#### 10.6.1 Headline sizing

In a small window the headline is the whole point of the view, so it is sized to the space rather than set at a fixed step. A fixed size either wastes most of the window or clips the number.

- The size is computed from the measured box: the text is measured at a reference size on a detached probe, and the font size is scaled by the ratio of the box to the text. Text width is linear in font size, so one step converges.
- The probe is detached because the headline clips its overflow, so its own `scrollWidth` reports the clipped box rather than the width the text wants.
- Both width and height bound the result, so a short wide window and a tall narrow one both fill correctly.
- The result is clamped to a floor and a ceiling. The floor keeps the number legible; the ceiling stops a very tall window from rendering it at a size that reads as a graphic rather than a value.
- The fit re-runs whenever the box changes size, not only at render. The box shrinks and grows for reasons the render does not see, such as a coverage note appearing or the connect prompt being dismissed.
- Micro and Compact scale. Standard and Expanded keep the fixed display size, because the headline shares the tab with a chart and a scaling number would fight it for attention.

### 10.7 Tokens tab

The Tokens tab mirrors the Spending tab exactly, in token units rather than dollars.

- The same five range buttons: `10m`, `1h`, `3h`, `6h`, `24h`, with the selected interval highlighted.
- The headline is the token total for the selected interval, with no interval label, for the same reason as the Spending tab.
- The same `Last` increase chip, the same single-pass rolling digits, and the same fill-the-window headline sizing as the Spending tab, in token units.
- The same coverage-warning-only line under the headline. The request count is not shown.
- The same inline chart, with the same Log/Linear axis toggle and the same Y axis value labels.
- The same summary strip, showing token totals with request counts as a secondary line.
- Clicking a range button re-scopes the headline, the strip highlight, and the chart to that trailing interval, so the X axis always matches the selected button.

The Tokens chart uses the tab's orange accent for input tokens and a lighter tint of the
same hue for output, so the chart, the selected interval, and the interval figures all read
as one measure. A dark or black fill was rejected because it is not visible against the
widget background.

### 10.8 Models tab

The public OpenRouter API does not expose individual generations. `/analytics/query`
returns aggregates per time bucket, and the per-generation list on openrouter.ai is
served by an internal endpoint that a third-party client cannot reach. This tab
therefore presents a breakdown of the same aggregates the charts use, and says so
rather than labelling minute buckets as individual requests.

- Summary strip with token totals and request counts per interval, with the selected interval highlighted.
- Below the strip: a table with a `Model` / `Tokens` / `Spend` column header, then one row per model, largest spend first.
- Each row shows the model slug, the number of contributing reporting buckets, and the token and spend totals for the selected interval.
- Both the token and spend figures are for the selected interval, so they agree with the headline on the Spending and Tokens tabs and with the chart.
- The breakdown window follows the selected range button, so the Models tab agrees with the chart on the Spending and Tokens tabs.
- Token and spend values use the tab accent colour, never black or a low-contrast grey.
- A note states that the rows group reporting buckets, not individual generations.
- When no single granularity covers the window, the tab explains that usage appears once a full range has been fetched, instead of showing a misleading zero.

Grouping rules:

- Group by the model slug. Provider is not a grouping dimension: the model identifies the workload, and splitting by provider fragments the same model across rows.
- A group with no value is labelled `Unknown` rather than dropped.
- Only one reporting granularity is summed, per section 10.5.1, so a breakdown never double-counts.

#### 10.8.1 Group detail

- Selecting a row shows the model slug, the window, the granularity used, total tokens split into input and output, cost, and the number of contributing buckets.
- Show a stable fallback name for an unknown group; do not expose secret material.
- Missing fields show Unavailable.

The newest bucket time is the newest supported reporting bucket, not the last network response received.

### 10.9 Log (inside Settings)

The log is the last group in the Settings tab. It is the widget's own application event log, not OpenRouter usage data, which lives on the Spending, Tokens, Keys, and Models tabs. Folding it into Settings keeps diagnostic material together and frees a tab slot for usage data.

- Reverse chronological list, newest first, with a fixed row height so scrolling is stable.
- Each row shows local time with seconds, severity, source, and message.
- Severity levels: `error`, `warn`, `info`, `debug`. Default filter shows `warn` and above.
- Sources: `collector`, `source`, `db`, `window`, `ipc`, `credential`, `update`, `app`.
- Filter controls: severity multi-select, source multi-select, and a free text search over the message.
- A time range control: last 15 minutes, last hour, last 24 hours, all retained.
- Row expansion shows the full message, the stable error code, and a correlation ID that also appears in the diagnostic bundle.
- Actions: copy row, copy filtered view, open the log file location, clear the in-app view.
- Clearing the in-app view does not delete the on-disk log file. Deleting log files is a separate confirmed action in Settings.
- Live tail toggle, on by default, which pauses automatically when the user scrolls away from the top.
- The panel scrolls inside the Settings list with a capped height, so it cannot push the groups below it out of reach.
- The live tail is subscribed only while the Log group is expanded, so the widget never streams entries it will not show. The group's summary line shows the number of entries currently loaded.
- Retention: the in-app view keeps the most recent 2,000 entries in memory. The on-disk log rotates at 5 MB with 3 files kept.
- The log never contains the OpenRouter credential, authorization headers, request bodies, or prompts. Redaction happens at write time, not at display time.
- Empty state: `No events match the current filter` with a reset action.

### 10.10 Keys tab

The Keys tab is a report, not a picker. Changing scope is a Settings concern; reading per-key usage is an analysis concern, and mixing the two in one place made the tab ambiguous.

- Summary strip with the selected interval highlighted.
- Below the strip: the same table format as the Models tab, with a `Key` / `Tokens` / `Spend` column header, then one row per key, largest spend first.
- Each row shows the key name, the number of contributing reporting buckets, and the token and spend totals for the selected interval.
- There is no radio control and no selection box. The tab reports usage; it does not choose a scope.
- A note points at Settings for restricting every tab to one key.
- The per-key breakdown is always fetched unscoped, so a key-scoped view still lists every key rather than collapsing to the one already selected.
- Deleted or renamed keys keep their historical name and are labeled `removed`.
- The secret key value is never shown, only the friendly name and, if the source provides one, the last four characters of the identifier.
- If historical key level data is unavailable, show that limitation instead of estimating it.
- Preserve names linked to historical records when keys are renamed or removed.

### 10.11 Settings tab

The Settings tab is a scrollable list of collapsible groups. Each group header shows its current value as a summary line, so the user can read the configuration without expanding anything.

Groups, in order:

1. Parameters
2. Display
3. API key
4. Version
5. Support
6. Diagnostics
7. Scope
8. Log

Every change applies immediately and is written to the settings store with a debounce. There is no global Save button. Destructive actions require an inline confirmation that names the exact consequence.

Every control label carries a hover explanation. A small accent dot marks a label as having help text, and hovering or focusing the label opens a popup with a verbose description of what the option does, what the alternatives mean, and what the trade-off is. The popup is a real element rather than a native `title` tooltip, because the text is long enough that an OS tooltip truncates it and cannot wrap inside a narrow widget window. The popup is positioned against the viewport so the scrolling settings list cannot clip it, and it flips above the label when there is not enough room below.

#### 10.11.1 Parameters

Collection and accounting parameters.

- Refresh interval: 5, 10, 30, or 60 seconds. Default 10.
- Chart refresh interval: 30, 60, or 300 seconds. Default 60.
- Pause collection when the widget is hidden: on by default.
- Raw request retention: 30, 90, 180, or 365 days. Default 90.
- Aggregate retention: 12 or 24 months. Default 24.
- Time zone: system default or an explicit zone. Default system.
- Week start: Monday or Sunday. Default Monday.
- Hour format: 12 or 24 hour. Default from the OS locale.
- Currency display: USD only in the first release, shown as a read-only row.
- Stale threshold: the age at which data is marked stale. Default 3 times the refresh interval, minimum 60 seconds.
- Reset all parameters to defaults, with confirmation.

#### 10.11.2 Display options

- Theme: Dark, Light, or Follow system. Default Dark.
- Density: Comfortable or Compact. Default Comfortable.
- Opacity: 40 to 100 percent. Default 100.
- Always-on-top level: Normal, Stronger, or Off. Default Normal. The stronger level carries an inline warning that it can cover full-screen apps.
- Ghost mode: on or off, with the global shortcut shown next to it.
- Locked mode: on or off.
- Keep inside work area: on by default.
- Snap to screen edges: on by default.
- Launch at login: off by default.
- Default tab: any of the five tabs. Default Spending.
- Default metric per tab: Spend or Tokens for Spending, Requests, and API.
- Micro mode window: which rolling window the single Micro cell shows. Default `1h`.
- Animations: on, reduced, or off. Default follows the OS reduced-motion setting.
- Chart time axis: Logarithmic (default) or Linear. Linear is an accessibility override and shows a persistent `Linear axis` label on every chart.
- Number format preview: a live sample row showing how spend and token values will render.
- Reset size to the default 320 x 240.

#### 10.11.3 API key

This group is the only place in the widget where the credential is entered.

- Current state: `Not connected`, `Connected`, `Invalid`, or `Encryption unavailable`.
- When connected: the credential type, the last four characters of the identifier if the source provides them, the time it was saved, and the last successful and last failed request times.
- Actions: Connect, Replace, Test connection, Disconnect.
- The credential is never displayed again after saving, not even masked. Only the last four characters of the identifier are shown.
- Test connection performs a single read-only call, reports latency and the resolved account scope, and never logs the credential.
- Disconnect requires confirmation and states that local history is kept unless the user also chooses to delete it.

Inline instructions, shown expanded when not connected and collapsed when connected:

1. Sign in to the OpenRouter dashboard in a browser.
2. Open the API keys page and create a key. A read-only or provisioning key is preferred where the account supports it.
3. Copy the key once. It is not shown again by OpenRouter.
4. Paste it into the field below and choose Connect.
5. The widget stores the key in the operating system credential store, never in a file, and never sends it anywhere except to OpenRouter.
6. If the connection test fails, check that the key is active, that it has not been revoked, and that the account has credit.

The instructions include a copyable link to the OpenRouter API keys page and a note that the widget requests only the permissions needed to read usage.

#### 10.11.4 Version

- Widget version, build number, and commit hash.
- Electron, Chromium, Node.js, and SQLite versions.
- Installer channel: stable or beta.
- Update state: up to date, checking, available, downloading, ready to install, or failed, with the last check time.
- Actions: Check for updates, and Restart to install when an update is ready.
- Release notes link for the running version.
- Database schema version and the time of the last migration.

#### 10.11.5 Support

- A short troubleshooting checklist: confirm the account is connected, confirm the network is reachable, check the Log group in Settings for `error` entries, and confirm the system clock is correct.
- Links: documentation, FAQ, known issues, and the issue tracker.
- Copy diagnostic summary, which copies the redacted bundle described in section 10.10.6 to the clipboard.
- Save diagnostic bundle to a file, with the redaction notice shown before saving.
- A note that the bundle contains no credential and no request content.
- Contact and response expectations, stated as best effort with no service level guarantee.

#### 10.11.6 Diagnostics

Read-only health and environment information, plus explicit maintenance actions.

- Connection: account state, last successful fetch, last error code and time, current backoff, and next retry time.
- Source: resolved endpoints, confirmed capabilities, reporting delay, and rate limit headroom if reported.
- Coverage: earliest reliable record, per metric completeness, and known gaps.
- Collection: last cursor, records collected in the last hour, and duplicate deliveries suppressed.
- Storage: database file path, size, row counts for requests and aggregate bins, and the oldest retained record.
- Performance: current renderer memory, main process memory, idle CPU, and the last resize frame time.
- Window: current bounds, display identity, scale factor, size class, and layout mode.
- Environment: OS version, architecture, session type (X11 or Wayland), GPU vendor, and locale.
- Actions: open the log folder, open the database folder, export data, vacuum the database, and clear all local data. Each action requires confirmation, and clearing local data states that the credential is removed separately.

### 10.12 Charts

Charts is a subview, not a tab. It opens from a summary strip cell or from a total on the Spending tab, and it returns to the view that opened it. `Escape` and the Back control both close it.

Avoid putting every control on one crowded view. Use a chart view plus a small options popover.

Chart view:

- Selected metric and total.
- Chart with sparse axis labels on the logarithmic time axis from section 10.12.1.
- Current period label and previous/next controls.
- Options button.

Options popover:

- Metric: Spend or Tokens.
- Time scale: Hour, Day, Week, Month.
- Scope: All keys or selected key, where supported.
- Apply and Back.

Spend uses bars. Tokens use stacked input and output bars. A click on a bar shows the bin label, exact values, and partial or missing status. Provide previous/next bin controls if narrow bars are difficult to select.

Use a visible gap for missing data. Only draw zero when the source confirms zero usage. Mark a current incomplete bin distinctly.

#### 10.12.1 Logarithmic time axis

Every graph in the widget uses a logarithmic X axis. This includes the full Charts view, the compact trend on the Spending tab, and the Micro mode sparkline. The Y axis stays linear. Only the time axis is logarithmic.

The purpose is that recent data occupies most of the width and older data compresses toward the left, so a single view can show the last ten minutes and the last year without the recent detail collapsing into one pixel.

The axis is a rendering choice only. It does not change the period selection in section 9, the bin boundaries, or the totals. The same bins are drawn, at different horizontal positions.

**Mapping**

Let `t_end` be the right edge of the chart, `t_start` the left edge, and `a(t) = t_end - t` the age of a point relative to the right edge.

- `t_end` is the current time for the current period, and the period end for a past period. It is never in the future.
- `a_min` is the finest bin width in the view, floored at one second.
- `a_max = t_end - t_start`.
- Horizontal position: `x(t) = 1 - (log(a) - log(a_min)) / (log(a_max) - log(a_min))`, clamped to `[0, 1]`.
- The newest point sits at the right edge. The oldest sits at the left edge.
- Use `log10`. The base only changes the tick labels, not the shape.

**Bins and bars**

- Each bin is drawn across its own log extent, from `x(bin_end)` to `x(bin_start)`. Bar widths therefore shrink toward the left, which is the intended compression.
- Enforce a minimum rendered bar width of 1 device pixel so a bin never vanishes entirely.
- Enforce a minimum hit target of 8 logical pixels per bin. Hit testing uses the log mapping, and when several bins fall inside the hit target, the nearest bin by log distance wins.
- Bins are never reordered, merged, or dropped to fit the axis. The axis adapts to the bins.
- A gap in data keeps its true log width. Do not collapse a gap to zero width.
- The current partial bin is drawn at the right edge with its partial marker, and its width reflects only the elapsed part of the bin.

**Grid lines and ticks**

- Vertical grid lines are placed at log positions, so their spacing compresses toward the left exactly as the data does.
- Major grid lines at decade boundaries of age: 1 s, 10 s, 1 min, 10 min, 1 h, 10 h, 1 d, 10 d, 100 d.
- Minor grid lines at the 2x and 5x positions inside each decade: 2 s, 5 s, 20 s, 50 s, 2 min, 5 min, and so on.
- Where the range is dominated by calendar units, prefer calendar-natural ticks over strict decades: 1 m, 5 m, 15 m, 30 m, 1 h, 3 h, 6 h, 12 h, 1 d, 2 d, 1 w, 2 w, 1 mo, 3 mo, 6 mo, 1 y.
- Choose the tick set whose smallest log spacing still leaves at least 48 logical pixels between labels. Drop minor ticks before major ticks as width shrinks.
- Major grid lines are one step brighter than minor lines. Both stay below the data in contrast.
- Axis labels are relative ages, such as `5m`, `3h`, `2d`, `6mo`, because absolute clock times are hard to read on a compressed axis. The exact absolute time appears in the tooltip and in the bin detail.
- The rightmost label is always `now` for the current period, or the period end label for a past period.

**Interaction**

- Hover and click resolve to a bin through the log mapping, never through a linear approximation.
- The crosshair follows the pointer and snaps to the nearest bin center.
- The previous and next bin controls step through bins in time order, which is the reliable way to reach a sliver at the left edge.
- Zooming, if added later, must zoom in log space so the visual compression is preserved.

**Edge cases**

- A range shorter than one decade still uses the log mapping. Do not silently fall back to linear.
- A single bin, or a range where `a_max` equals `a_min`, renders as one full-width bar with the axis label `now`.
- A range that would place `a_min` at zero is clamped to one second.
- If the source granularity is coarser than the bin width, the affected bins are marked unavailable per section 10.5 and are not drawn as zero.
- A linear axis is available only as an accessibility override in Settings, Display options, and it is off by default. When enabled, the chart shows a persistent `Linear axis` label so a screenshot can never be mistaken for the default view.

### 10.13 New request animation

Compare the normalized generation ID with the displayed generation ID.

On a genuinely new request:

1. Move the old card upward and fade it out over about 150 ms.
2. Bring the new card in from below over about 200 ms.
3. Highlight the card border for one second.
4. Show NEW for three seconds.

Keep graph and totals still during this animation. Update all fields as one unit. Refreshing age, updating token details for the same ID, or retrying a poll must not replay the animation.

If several requests arrive, show the newest and a small count such as 5 new. Do not queue one animation per event. An older late arriving event must not replace a newer displayed event. On startup, show existing data without a new event animation. Provide Reduced motion and Animation off options, and honor the OS reduced-motion setting by default.

### 10.14 Responsive behavior

- The strip is always one row of all five intervals, at every size from the 180 x 120 minimum upward. It never wraps to a second row, never hides an interval behind an overflow control, and never scrolls horizontally.
- What changes with size is how much each cell draws, per section 10.3.1: the interval alone when the cells are narrow, the interval and the value when they are wider, and the interval, value, and request count when they are widest.
- Cell labels never truncate. Values may shorten to compact notation but never to a placeholder.
- The strip must not scroll horizontally at any size.
- The Log group collapses its filter row into a single filter button below the M width class.
- The Settings tab renders as a single column at every size. Below the S width class, group headers stack their label above their summary value.

### 10.15 Number formatting

- Spend uses at least four significant digits below one dollar, so a real charge never renders as `$0.00`.
- Spend at or above one dollar uses two decimals.
- Tokens use compact notation in the strip, such as `148.2K` or `1.24M`, and exact counts in detail views.
- All numbers use tabular figures.
- A value that changes from `999.9K` to `1.00M` must not change the cell width enough to reflow the row. Reserve width for the widest expected form.

### 10.16 Empty, stale, and error states

- No account connected: the strip shows a single `Connect account` action that opens Settings, API key.
- Connected but no data yet: cells show a dash with reason `no_data`.
- Collection started recently: affected cells show the partial marker and a tooltip with the coverage start time.
- Source error: the strip keeps the last values, dims them, and shows the error state in the status strip.
- Rate limited: same as source error, with the retry time.
- Scope selected but the key has no data in a window: `0` if confirmed, a dash if unknown.
- Credential invalid: every data tab shows a persistent banner with a `Fix in Settings` action, and the Log group records one `error` entry per failed attempt, not one per retry.
- Credential unreadable: a file exists but the OS refuses to decrypt it, typically because the keychain entry was reset. The status strip reads `Key unreadable` and the banner asks the user to re-enter the key. The widget must never report this as connected: a stored file only proves the file exists, so connection state is derived from whether the key can actually be read. Reporting it as connected left collection silently stalled while the header claimed the numbers were live.
- Sample data is identified by the stored rows, not by the credential state. History collected earlier stays real after a key becomes unreadable, so the widget labels it `Offline` and keeps showing it rather than calling it sample data.

### 10.17 Accessibility

- Every control is reachable by keyboard, with a visible focus ring that meets a 3:1 contrast ratio against its background.
- Every icon-only control has an accessible name and a tooltip.
- Color is never the only carrier of meaning. Input, output, and spend each carry a label or a shape in addition to their color.
- Text meets a 4.5:1 contrast ratio against its background at the default opacity, and the opacity floor in section 10.10.2 keeps that ratio.
- The OS reduced-motion setting disables the new request transition by default.
- The OS text scale setting is respected up to 200 percent without clipping.
- Screen reader announcements are limited to the latest request change and to error state changes, so the widget does not chatter.
- The linear axis override in section 10.12.1 exists for users who cannot read a compressed axis.

## 11. Credentials and security

### 11.1 Credential storage

- Store the OpenRouter credential with the OS credential store through Electron `safeStorage`: Keychain on macOS, DPAPI on Windows, and libsecret or KWallet on Linux.
- If `safeStorage` reports that encryption is unavailable, refuse to persist the key and require the user to re-enter it each session, with a clear explanation.
- Distinguish "nothing stored" from "stored but unreadable" from "stored and encryption unavailable". The three need different messages and different actions, and only the last two can follow a keychain reset.
- Connection state is decided by whether the credential can be read, not by whether a file exists. Expose the difference in diagnostics so a stalled collector is attributable.
- Never write the credential to the SQLite database, a settings JSON file, a log, a crash report, or the renderer.
- Keep the decrypted value in main-process memory only for the duration of a request.
- Never send the credential back to the renderer, not even masked, after saving. Show only a fixed placeholder and the last four characters of the identifier if the source provides them.
- The credential entry field is write-only. It is cleared from renderer memory as soon as the save completes, and it is never placed in a form that the browser or Electron could autofill or restore.

### 11.2 Application security

- No remote code, no remote navigation, no `shell.openExternal` on untrusted input.
- Validate and bound every IPC payload. Reject unknown fields.
- Redact authorization headers, credentials, and request bodies from logs.
- Do not store prompts or generated content.
- Sign and notarize release builds. Document the update channel and its verification.

## 12. Collection methods and coverage

Choose only after the API checks in section 4.

Preferred: supported account request feed or supported trace delivery with sufficient metadata and account coverage.

Fallback: apps send response metadata to the widget, or apps route requests through a local recorder. These options require changes to those apps and cannot claim coverage of unmodified apps.

A generation lookup can enrich a known ID but must not be treated as a way to find unknown latest requests.

Match request key identifiers to names through a confirmed supported source. If a source does not carry key identity, display Unknown key rather than guessing from model or timing.

The widget must state whether latest request coverage is Full account, Selected apps, or Unavailable. Full account requires evidence that every relevant app or account source is covered.

## 13. Local data API

These are internal IPC channels between the renderer and the main process, not OpenRouter routes. All are request and response typed, and all return data already scoped to the caller's view.

- `account:status`: credential state, connection health, last error code.
- `snapshot:get`: compact current totals, latest event, status, version.
- `summary:get`: rolling window cells for the five windows in section 10.3, for a given scope and metric.
- `charts:get`: metric, scale, period, time zone, and optional key filter.
- `requests:list`: paged recent metadata, no prompts or response content.
- `keys:list`: friendly names and available period totals.
- `window:getState` and `window:setState`: bounds, always-on-top level, opacity, interaction mode.
- `settings:get` and `settings:set`: validated settings with a schema.
- `settings:reset`: restore defaults for a named group or all groups.
- `logs:query`: filtered, paged application log entries with severity, source, text, and time range.
- `logs:tail`: subscribe to new entries while the Log group is expanded; unsubscribes when it collapses or the tab changes.
- `logs:clearView`: clear the in-app view only, leaving on-disk files intact.
- `logs:openFolder`: reveal the log directory in the OS file manager.
- `diagnostics:get`: the read-only health, storage, performance, window, and environment bundle.
- `diagnostics:copy` and `diagnostics:save`: produce the redacted bundle for support.
- `app:version`: widget, runtime, schema, and update state.
- `app:checkForUpdates`: trigger an update check and return the result.
- `data:export` and `data:clear`: explicit, confirmed maintenance actions.

Snapshot fields:

- schema_version, snapshot_version, server_time, fetched_at.
- currency, time_zone, scope.
- today: start, end, spend_usd, input_tokens, output_tokens, total_tokens.
- month: equivalent totals.
- latest_request: ID, event time, key ID, key name, model, status, token fields, cost.
- coverage: per metric and request source, earliest time, completeness, warnings.
- collection_status: last success, expected delay, stale flag.
- windows: one entry per window in section 10.3, each with window_start, window_end, spend_usd, input_tokens, output_tokens, total_tokens, request_count, coverage, partial_reason, and as_of.

Use decimal strings for money, integers for token counts, ISO 8601 UTC timestamps, and null for unavailable values. Include period boundaries and partial flags in chart bins. Use a cursor for recent requests. Set bounded page sizes and maximum bin counts.

Errors use a stable code and safe message. Distinguish invalid credential, source auth failure, rate limit, source outage, and incomplete history.

## 14. Database

Minimum records:

- Account connection: encrypted credential reference, source capabilities, status.
- Key identity: source ID, current name, historical name data as available.
- Request: unique account and generation ID, event time, received time, key ID, name snapshot, model, status, token counts, cost, source.
- Aggregate bin: source, scope, metric, interval, boundaries, value, completeness, revision time.
- Settings: zone, week start, retention, collection options, window state, view preferences.
- Rolling window cache: scope, metric, window key, window start and end, value, coverage, computed at.
- Application log entry: timestamp, severity, source, stable code, message, correlation ID, redaction flag.
- Diagnostic snapshot: captured at, trigger, redacted payload, schema version.
- Collector state: cursor, last success, retry time, error code.

Use unique constraints and upserts for duplicate deliveries. Late updates may revise tokens and cost without creating a second request. Keep provenance so aggregates and request sums are never accidentally added together. Apply schema migrations on startup inside a transaction, and back up the database before a destructive migration.

## 15. Refresh and failure handling

Proposed defaults, subject to confirmed source limits:

- Snapshot fetch: every 10 seconds while the widget is visible and the window is not minimized.
- Chart fetch: when the view changes and every 60 seconds while visible.
- Aggregate refresh: every 60 seconds.
- Request updates: supported event delivery if available; otherwise a supported polling interval.
- No polling while the widget is hidden, in ghost mode with no visible content, or while the system is suspended.

Fetching faster does not make OpenRouter data fresher. Display source data age separately from the last successful fetch.

Use retry backoff with jitter and respect source retry instructions. Cache results so a restart does not blank the widget. Show old values with a stale label instead of replacing them with zero. Distinguish network offline, source auth failure, rate limit, and source reporting delayed.

On application start, show cached data immediately with its saved age, then refresh. Write settings and small cached state infrequently to limit disk churn.

## 16. Performance and usability targets

- Interaction feedback within 100 ms during normal operation.
- View changes within 250 ms with cached data.
- Resize stays at or above 55 frames per second on a 2020-era laptop at the default size, with no visible reflow jank.
- Network requests never block the renderer or the resize path.
- Smooth card animation without full-window flicker; reduce effects if the frame budget is missed.
- Idle CPU below 1 percent of one core with the widget visible and no animation running.
- Resident memory below 250 MB, with no steady growth across a 24 hour run.
- Bounded chart and request buffers; no unbounded allocation.
- Repeated view changes, resizes, and reconnects must not cause steady memory growth.
- Long names wrap or shorten with a detail view, never overflow into adjacent values.

## 17. Security and privacy

Section 11 defines credential storage and application hardening. This section states the remaining privacy rules and the threat boundaries.

- Do not store prompts or generated content, in the database, in logs, or in a crash report.
- Redact authorization headers and credential form values from logs at write time.
- Keep the renderer sandboxed with a strict content security policy and no remote content.
- Do not expose any local server port to the network. If a local port is ever required, bind to loopback only and require a token.
- Provide a documented process to replace an OpenRouter credential and to clear all local data.
- Document the backup and recovery path for the OS credential store entry, and state that losing it requires re-entering the credential.
- State the data leaving the machine: only requests to OpenRouter, plus the update check. No telemetry, no analytics, and no crash upload without explicit opt-in.

## 18. Acceptance tests

### Window and platform

- The widget stays above normal windows on Windows, macOS, and X11 Linux after launch, after focus changes, after display changes, and after resume from sleep.
- The stronger level stays above full-screen apps when enabled, and the default level does not.
- The widget appears on all virtual desktops when enabled, and on the current desktop only when disabled.
- Bounds restore onto the correct display, and clamp into the work area when that display is missing.
- Ghost mode passes clicks through and can be exited with the global shortcut.
- The widget never covers system security prompts or the lock screen.
- Wayland behavior matches the documented limitation, and the notice appears once.

### Responsive layout

- Every view renders correctly at 180 x 120, 240 x 160, 320 x 240, 480 x 320, 640 x 480, and 1200 x 800.
- Dragging the resize handle continuously from minimum to maximum produces no overflow, no clipped text, no scrollbar, and no layout jump.
- Each size class boundary switches layout exactly once, with no flicker or oscillation.
- Text scaling at 100, 125, 150, and 200 percent keeps all values legible and inside their containers.
- Long key names, long model names, zero values, large totals, and missing values are all verified at every size class.
- Resizing does not reset the selected view, period, or filter, and does not trigger a network fetch.

### Display

- All five tabs render at every size class, as labels at M width and above and as an icon rail below it.
- The range strip shows exactly five ranges, labeled `10m`, `1h`, `3h`, `6h`, and `24h`.
- Window boundaries are trailing from the evaluation instant, verified against a fixed clock.
- Overlapping windows are never summed or presented as disjoint periods.
- The `24h` window and the calendar today total are visually distinct and can differ.
- A source with hourly granularity marks `1h` as unavailable with reason `source_granularity`, and never interpolates it.
- A collection start inside a window marks that cell partial with the correct reason.
- A known gap inside a window marks that cell partial.
- A confirmed zero renders as `0`; an unknown value renders as a dash, never as zero.
- Selecting a key in the Settings Scope group changes the strip values on the Spending, Tokens, Keys, and Models tabs and the Charts scope.
- `All keys` is reachable in one click from any scope.
- A renamed or deleted key keeps its historical name and is labeled `removed`.
- The strip does not scroll horizontally and does not reflow when a value crosses a magnitude boundary such as `999.9K` to `1.00M`.
- Switching tabs does not refetch data younger than the snapshot interval.
- The selected tab, per-tab metric, and scope survive a restart.
- The Settings tab never shows the rolling window strip and never triggers a source fetch.

### Log group in Settings

- Entries appear newest first with local time including seconds, severity, source, and message.
- The default filter shows `warn` and above.
- Severity, source, text, and time range filters combine correctly and can be reset in one action.
- Live tail pauses when the user scrolls away from the top and resumes when they return.
- The group summary line reports how many entries are currently loaded.
- The live tail is subscribed only while the group is expanded, so a collapsed log costs nothing.
- Clearing the in-app view leaves the on-disk log files intact.
- A forced credential failure, source outage, and rate limit each produce exactly one entry per attempt, not one per retry.
- No entry contains the credential, an authorization header, a request body, or a prompt, verified by searching the log file after a full test run.
- The in-app view stays bounded at 2,000 entries and the on-disk log rotates at 5 MB with 3 files kept.

### Settings tab

- Every group header shows a correct summary of its current value without expanding.
- Each parameter change applies immediately and survives a restart.
- Invalid values are rejected with an inline message and the previous value is kept.
- Reset to defaults affects only the named group, and the confirmation names that group.
- The API key field is write-only, and the credential is not present in the renderer after saving.
- The connection test reports latency and resolved scope, and logs no credential.
- Disconnect requires confirmation and states whether local history is kept.
- The setup instructions are expanded when not connected and collapsed when connected.
- Version shows widget, runtime, schema, and update state, and the update check reports each state correctly.
- Support copies and saves a bundle that contains no credential and no request content.
- Diagnostics reports storage, performance, window, and environment values that match the running app.
- Clearing all local data requires confirmation and does not revoke the credential without a separate action.

### Chart time axis

- Every graph uses a logarithmic time axis: the full Charts view, the Spending tab trend, and the Micro mode sparkline.
- The newest point renders at the right edge and the oldest at the left edge for a fixed clock.
- A point at half the age of another renders at the expected log position, verified against a computed table of positions.
- Bar widths shrink monotonically from right to left, and no bar renders narrower than one device pixel.
- Vertical grid lines compress toward the left and never appear at uniform spacing.
- Major ticks land on decade boundaries and minor ticks on the 2x and 5x positions, or on the calendar-natural set when that set is selected.
- Labels are dropped from minor to major as width shrinks, and no two labels overlap at any size class.
- The rightmost label reads `now` for the current period and the period end label for a past period.
- A gap in data keeps its true log width and is not collapsed.
- The current partial bin is drawn at the right edge with its partial marker and only its elapsed width.
- Hover and click resolve to the correct bin at the left edge, the middle, and the right edge.
- The previous and next bin controls reach a bin that is too narrow to click.
- A range shorter than one decade still uses the log mapping and does not fall back to linear.
- A single-bin range renders as one full-width bar labeled `now`.
- Enabling the linear override shows the persistent `Linear axis` label on every chart, and disabling it restores the log axis.

### Charts and animation

- Charts opens from a strip cell and from a total, and Back returns to the view that opened it.
- `Escape` closes Charts and returns focus to the control that opened it.
- The new request transition plays exactly once per new generation ID and never on a same-ID update.
- Reduced motion and Animation off both suppress the transition, and the OS setting is honored by default.
- The chart keeps its period and scope when the window is resized.

### Accessibility

- Every control is reachable by keyboard alone, in a logical order, with a visible focus ring.
- Every icon-only control exposes an accessible name.
- Input, output, and spend remain distinguishable with color removed.
- Text meets a 4.5:1 contrast ratio at the default opacity and at the 40 percent opacity floor.
- Text scale at 200 percent clips nothing and keeps every value inside its container.
- A screen reader announces a new request once and an error state change once, with no repeated chatter.

### Data

- Account scope is checked against the provider for a fixed completed interval.
- Money matches at source precision, accounting for documented lag and adjustments.
- Tokens match confirmed source definitions.
- Missing data is not shown as zero.
- Key filters cannot be mistaken for account totals.
- External provider costs stay separate.
- Duplicate or late request delivery does not double count.
- Day, month, year, and week boundaries work in two zones, including one with clock changes.
- Partial current periods and incomplete history are labeled.

### Latest request

- A new ID triggers exactly one transition.
- Updating the same ID does not replay the transition.
- Startup does not show a false NEW label.
- A group of new requests causes one transition and a correct count.
- An older late request does not replace the newest one.
- Key name, timestamp, cost, and tokens update together.
- Coverage claims match the actual collection method.

### Reliability and security

- Source outage, rate limit, network loss, and application restart preserve clear status and prior values.
- Database backup and restore recover history and settings.
- Logs contain no secrets.
- The credential is unreadable in the database file and in settings files.
- The renderer cannot reach the network or the filesystem directly.
- A 24 hour visible run shows no steady memory growth and no idle CPU above the target.

## 19. Delivery plan

### Phase 0: Verify

Confirm platform window behavior on all three operating systems and confirm source capabilities. Produce a field coverage table and identify the request collection method. Stop and report unsupported requirements rather than inventing data.

### Phase 1: Widget shell

Build the frameless always-on-top window, tray, global shortcuts, persistence, and the responsive layout system with fixed sample data. Verify resize behavior at every size class on every platform. Add sample data labels.

### Phase 2: Display

Build the five tabs and the rolling window summary strip from section 10 against fixtures, including every coverage and empty state. Build the chart renderer with the logarithmic time axis from section 10.12.1, including log grid lines, tick thinning, and log hit testing. Build the Log group with a fixture event stream and the Settings tab with all eight groups wired to a local settings store. Add the new request animation and the accessibility pass.

### Phase 3: Local store and settings

Implement the database, migrations, settings schema, credential storage, and the IPC surface. Use a fake source adapter for repeatable tests.

### Phase 4: Real collection

Connect confirmed provider APIs, load available history, implement request collection, and show coverage and lag. Add reconciliation tests.

### Phase 5: Finish

Test reconnects, missing data, credential replacement, animation load, retention, backup, packaging, signing, and updates. Produce installers and release notes.

## 20. Required project files

- src/main/: window management, tray, shortcuts, collectors, database, IPC handlers.
- src/preload/: the context bridge surface and its types.
- src/renderer/: views, components, responsive styles, log viewer, settings groups.
- src/renderer/charts/: log time scale, tick generator, bar and sparkline renderers, hit testing.
- src/main/logging/: structured logger, redaction rules, rotation, and the in-app ring buffer.
- src/main/diagnostics/: environment, storage, and performance collectors plus bundle redaction.
- src/shared/: types, schemas, and constants shared across processes.
- tests/: unit tests for accounting and time rules, plus end-to-end window and resize tests.
- docs/platform.md: verified window behavior and limitations per platform.
- docs/openrouter-api.md: verified sources, permissions, fields, limits, and coverage.
- docs/security.md: credential handling, sandboxing, and data clearing.
- docs/data-model.md: normalization, accounting, and time rules.
- docs/operations.md: packaging, signing, updates, backup, restore, and errors.
- sample-data/: safe fixtures with no real secrets or request content.
- README.md: install, run, build, and test instructions.
- FSD.md: this specification.

## 21. Definition of done

The release is done when all of the following hold.

**Install and run**

- The widget installs and launches on Windows 10 or 11, macOS 12 or later, and Linux X11.
- Wayland launches with the documented always-on-top limitation and a one-time notice.
- The widget floats above normal windows and restores its size, position, and display after a restart.

**Layout**

- The panel resizes smoothly from a 180 x 120 badge to a full dashboard with no clipping, no overflow, and no layout breakage at any intermediate size.
- Every view is verified at every size class and at 100, 125, 150, and 200 percent text scale.

**Display**

- The Spending, Requests, Log, API, and Settings tabs all work.
- The rolling 10 minute, 1 hour, 3 hour, 6 hour, and 24 hour summaries are correct and honest about coverage.
- Every graph uses the logarithmic time axis, with compressed grid lines and correct log hit testing.
- The latest request shows its key name, model, timestamp, tokens, and cost, and a new request triggers exactly one transition.

**Data**

- Account totals and token counts match the confirmed source definitions at source precision.
- Missing data is never shown as zero, and partial coverage is always labeled.
- Reporting lag and history gaps are visible.

**Security**

- The OpenRouter credential never leaves the OS credential store and never reaches the renderer or a log file.
- The application log contains no secrets, verified by searching the log file after a full test run.

**Delivery**

- The project includes repeatable tests covering every acceptance suite in section 18.
- Installation, build, and test instructions are documented and verified on a clean machine.
