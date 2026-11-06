# Data model

## Money

Money is stored as integer micro-dollars (1e-6 USD) everywhere: in the database,
in IPC payloads, and in memory. Summing integers is exact, which satisfies the
"never binary floating point for accounting totals" rule.

- `microFromDecimalString('1.234567')` → `1234567`
- `microToDecimalString(1234567)` → `'1.234567'`
- `sumMicroOrNull([null, null])` → `null`, so missing never becomes zero

Rounding happens only at display time, in `formatSpend`.

## Tokens

Token counts are integers. `null` means unknown and is never coerced to zero.
Input, output, and total are stored separately. The source-reported total is
preserved when supplied; total is derived as input plus output only when the
source definitions permit it. Cached input and reasoning details are optional
subsets and are never added twice.

## Time

- All timestamps are stored as ISO 8601 UTC strings.
- Grouping uses the selected display zone, which defaults to the OS zone.
- Calendar boundaries are computed with real calendar arithmetic, not fixed 24
  hour assumptions, so zones with clock changes are correct.
- The rolling windows are trailing from the evaluation instant `T`, which is the
  current time at the last successful collection tick.

## Tables

| Table | Purpose | Key |
|---|---|---|
| `meta` | Schema version, last migration | `key` |
| `account` | Connection state, label, last four, capabilities | `id = 1` |
| `api_key` | Key identity, current and historical name | `id` |
| `request` | Normalized request records | `id` (account + generation) |
| `aggregate_bin` | Source aggregates by scope, metric, interval | `(source, scope, metric, interval, bin_start)` |
| `settings` | Serialized settings document | `key` |
| `window_cache` | Last computed rolling window cells | `(scope, metric, window_key)` |
| `app_log` | Persisted application log entries | `seq` |
| `diagnostic_snapshot` | Captured redacted bundles | `id` |
| `collector_state` | Cursor, last success, retry time, error code | `id = 1` |
| `known_gap` | Known coverage gaps | `id` |

## Duplicate and late delivery

`request` uses `INSERT ... ON CONFLICT(id) DO UPDATE`, so a duplicate delivery
revises the existing row instead of creating a second one. A late update may
revise tokens and cost without creating a second request. `received_time` and
`updated_at` are tracked separately from `event_time`, so first-seen and
last-updated are both recoverable.

## Provenance

`request.source` and `aggregate_bin.source` record where a value came from.
Aggregates and request sums are never added together, because that would double
count. The UI labels a partial request sum as a request sum, never as an
authoritative account total.

## Coverage

Each rolling window cell carries `coverage` (`full`, `partial`, `unavailable`),
`partial_reason`, and `as_of`. Reasons:

| Reason | Meaning |
|---|---|
| `source_granularity` | The finest source bin is coarser than a quarter of the window |
| `collection_started_later` | Collection began after the window start |
| `gap` | A known gap overlaps the window |
| `retention` | The window extends before the retention horizon |
| `no_data` | Connected, but no data has arrived yet |

## Migrations

Migrations run on startup inside a transaction. The database is copied to
`widget.db.backup-v<n>` before a destructive migration. A failed migration rolls
back and logs `db_migration_failed`.

## Retention

- Raw requests: 30, 90, 180, or 365 days. Default 90.
- Aggregates: 12 or 24 months. Default 24.
- Application log: 2,000 entries in memory, 5 MB × 3 files on disk.

## Granularity and double counting

The collector stores the same spend at three granularities over overlapping
ranges: minute rows for the last two hours, hour rows for the last day, and day
rows for the last month. Summing every row therefore counts the same money two
or three times. Measured on a live account, a 24-hour total came out at $3.28
when the true figure was $1.11.

Every consumer picks exactly one granularity per period:

- `src/shared/granularity.ts` chooses the finest granularity that both fits the
  period and covers it.
- The `collection_range` table records the range each granularity was actually
  fetched for. Coverage cannot be inferred from the rows themselves, because an
  hour with no activity produces no row, which means zero spend rather than
  missing data.
- A granularity coarser than the period is never chosen, since it cannot resolve
  the period.
- Rows whose source names no granularity, such as sample data and fixtures, form
  one fallback group used only when no known granularity covers the period.

The rolling windows, the period totals, and the chart bins all use this
selection, so the strip, the Today figure, and the chart agree with each other
and with the source.
