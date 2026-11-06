# OpenRouter API notes

Confirmed contracts only. Anything not verified here is treated as a capability
gap and reported as such in the UI, never invented.

## Verified endpoints

All four were probed live and respond. Unauthenticated requests return `401`
with `{"error":{"message":"No cookie auth credentials found","code":401}}`,
which confirms the routes exist and require a bearer credential.

| Endpoint | Method | Purpose | Status |
|---|---|---|---|
| `https://openrouter.ai/api/v1/credits` | GET | Account credit and total usage | Confirmed reachable |
| `https://openrouter.ai/api/v1/key` | GET | Info about the authenticating key | Confirmed reachable |
| `https://openrouter.ai/api/v1/activity` | GET | Per-day, per-model usage aggregates | Confirmed reachable |
| `https://openrouter.ai/api/v1/generation` | GET | Look up one generation by id | Confirmed reachable; requires `id` |

### `GET /api/v1/credits`

Response shape used by the collector:

```json
{ "data": { "total_credits": 250.0, "total_usage": 87.4213 } }
```

Both values are USD as decimal numbers. The collector converts them to integer
micro-dollars immediately so no accounting total is ever held as a float.

### `GET /api/v1/key`

Verified response fields:

```json
{
  "data": {
    "label": "sk-or-v1-1a5...753",
    "is_management_key": true,
    "is_provisioning_key": false,
    "limit": null,
    "usage": 0,
    "usage_daily": 0,
    "usage_weekly": 0,
    "usage_monthly": 0,
    "is_free_tier": false,
    "rate_limit": { "requests": 60, "interval": "1m" }
  }
}
```

Two behaviors matter and both are handled:

1. **`label` is the masked key itself for a management key.** It is not a
   friendly name. The widget detects a key-shaped label with
   `looksLikeCredential()` and displays `Management key` instead. A label is
   never persisted if it is key-shaped, and a label written by an earlier build
   is repaired on startup with log code `label_repaired`.
2. **`usage`, `usage_daily`, `usage_weekly`, and `usage_monthly` are all `0` for
   a management key**, because the usage belongs to the account rather than to
   the key. The widget therefore ignores these fields when
   `is_management_key` is true and falls back to the activity-derived totals.
   Trusting them would have shown `$0.00` for a month with real spend.

### `GET /api/v1/activity`

Returns an array of per-day, per-model rows. Fields the collector reads, with
fallbacks because the exact schema is not yet pinned:

| Field | Fallbacks tried |
|---|---|
| `date` | `created_at` |
| `model` | `model_permaslug` |
| `key_id` | `api_key_id` |
| `key_name` | `label` |
| `requests` | `request_count` |
| `prompt_tokens` | `input_tokens` |
| `completion_tokens` | `output_tokens` |
| `total_tokens` | derived from input + output |
| `usage` | `cost` |

**Granularity consequence.** Because activity rows are daily, the finest source
bin is 24 hours. A window is computable only when the finest bin is at most one
quarter of the window width, so on a live account the `10m`, `1h`, `3h`, `6h`,
and `24h` cells all report `unavailable` with reason `source_granularity`. This is
the honest result, not a bug. The cells populate from request records when a
finer source is available. The UI states this once above the strip rather than
leaving five bare dashes.

**Date format.** `date` is `"YYYY-MM-DD HH:mm:ss"` with **no time zone**. Parsing
it with `new Date()` treats it as local time, which shifts the day boundary and
misattributes spend. `parseSourceDate()` treats it as UTC.

**No key identity.** Activity rows carry `model`, `model_permaslug`,
`endpoint_id`, `provider_name`, `usage`, `requests`, `prompt_tokens`,
`completion_tokens`, `reasoning_tokens`, `cached_tokens`, and `byok_*` fields,
but **no `key_id` or `key_name`**. A per-key breakdown therefore cannot be built
from this endpoint, and the API tab says so instead of showing an empty panel.

**Reporting lag.** The newest reported date can be several days behind today. The
widget shows a lag line naming the newest date, so a `$0.00` today is not
mistaken for a bug.

**Query parameters.** `granularity`, `interval`, `start`, `end`, `start_date`,
`end_date`, `from`, `to`, `date_from`, `date_to`, `days`, `range`, `limit`,
`offset`, `page`, and `order` are all accepted but ignored: the response is
always the same daily rows. `group_by` accepts only `workspace`; any other value
returns `400`. There is no sub-daily option and no date filtering.

**`/activity` is superseded.** It is not the endpoint the dashboard uses. The
dashboard reads `/analytics/query`, which does report the current day. The widget
therefore treats `/activity` as a fallback only, used when the analytics endpoint
is unavailable, and purges its rows once analytics answers so the two sources
never double-count.

### `POST /api/v1/analytics/query` — the live source

This is the endpoint the OpenRouter dashboard itself uses, and it is the primary
source for every window. It requires a management key.

Request body:

```json
{
  "metrics": ["total_usage", "tokens_total", "tokens_prompt", "tokens_completion", "request_count"],
  "dimensions": ["api_key_id", "model"],
  "granularity": "hour",
  "time_range": { "start": "2026-11-05T00:00:00.000Z", "end": "2026-11-06T00:00:00.000Z" },
  "limit": 5000
}
```

Response:

```json
{
  "data": {
    "data": [
      { "date__hour": "2026-11-06 00:00:00", "api_key_id": "VScode OR Plugin M5",
        "model": "deepseek/deepseek-v4.1-flash-20261017",
        "total_usage": 0.012981, "tokens_total": "1205833", "request_count": "8" }
    ],
    "metadata": { "query_time_ms": 12, "row_count": 4, "truncated": false }
  }
}
```

Verified properties:

| Property | Value |
|---|---|
| Granularity | `minute`, `hour`, `day`, `week`, `month` |
| Metrics | `total_usage`, `tokens_total`, `tokens_prompt`, `tokens_completion`, `request_count`, `cached_tokens`, `reasoning_tokens`, plus latency percentiles |
| Dimensions | `model`, `api_key_id`, `provider`, `origin`, `country`, `workspace`, `app`, `user`, and more from `/analytics/meta` |
| Maximum range | 367 days; a longer range returns `400` |
| Row order | Newest first, so an over-large request silently drops the oldest buckets |
| Truncation | Reported as `metadata.truncated` |
| Date format | `YYYY-MM-DD HH:mm:ss`, no zone, so it must be parsed as UTC |
| `total_usage` units | Dollars, not micro-dollars |
| `tokens_*` and `request_count` | Returned as strings, so they must be coerced |

**`api_key_id` is enriched.** The response returns the key's display name, not
its hash. `/api/v1/keys` returns the hash, so the widget maps name to hash to
give request rows and key rows a shared identifier.

**Filters use `field`, not `dimension`.** A filter is
`{ "field": "model", "operator": "eq", "value": "openai/gpt-4o" }`. Operators are
`eq`, `neq`, `in`, `not_in`, `gt`, `gte`, `lt`, `lte`. Filtering on an enriched
dimension such as `api_key_id` with a display name returns `500`, so filters must
use the underlying id.

### `GET /api/v1/analytics/meta`

Returns the available metrics, dimensions, operators, and granularities. Useful
for confirming capability rather than hard-coding it.

### `GET /api/v1/keys`

Returns the account's keys, each with `hash`, `name`, `label`, `limit`,
`usage`, and `last_used_at`. The `hash` is the identifier the analytics endpoint
accepts as `api_key_id` in a filter. Requires a management key.

### `GET /api/v1/credits` as a live counter

`total_usage` is a cumulative lifetime counter that moves within seconds of a
request completing. Sampling it on every poll and differencing against a reading
taken at local midnight yields exact spend for the current day, even while
`/activity` is days behind.

- Samples are stored in the `usage_sample` table (schema v2) and pruned after 45
  days.
- The baseline is the newest sample at or before local midnight, which keeps the
  measured interval as short as possible.
- When the widget was not running at midnight there is no such sample. The value
  is then reported as partial, anchored at the earliest reading available, and
  the UI says `live since HH:MM` instead of implying a full-day total.
- A negative delta means the counter was reset or credits were refunded; it is
  clamped to zero rather than shown as negative spend.
- The month figure uses the same derivation but only when the baseline predates
  the first of the month. A partial counter would understate the month, so the
  reported total is preferred in that case.

### `GET /api/v1/generation?id=...`

Enriches a known generation id. It cannot discover unknown requests, so it is not
used as a request feed.

## Capability gaps

| Capability | Status | Consequence |
|---|---|---|
| Account-wide request feed | Not confirmed | Latest-request coverage is reported as `Selected apps`, not `Full account` |
| Sub-daily aggregates | Available via analytics | `/analytics/query` supports `minute` and `hour`; `/activity` ignores `granularity` |
| Current-day activity | Available via analytics | `/activity` lags by days, but `/analytics/query` reports the current day at minute granularity |
| Per-key breakdown | Available via analytics | The `api_key_id` dimension splits spend by key; `/activity` has no key identity |
| Per-generation list | Not in public API | The individual generation rows on openrouter.ai are not exposed; analytics returns aggregates only |
| Key identity in activity | Confirmed absent | No `key_id` or `key_name` field, so no per-key breakdown is possible |
| Key listing endpoint | Not confirmed | The API tab reports that per-key data is unavailable |
| Reasoning and cached token breakdown | Not confirmed | Stored as optional subsets when present, never double counted |
| Refunds and adjustments | Not confirmed | Money matches source precision; adjustments appear only when the source reports them |

## Rate limits and reporting delay

- `429` responses are honored: the `Retry-After` header sets the backoff, with a
  60 second default.
- Backoff is exponential with a 5 second floor and a 5 minute ceiling.
- Reporting delay is assumed to be 60 seconds until measured. The UI shows source
  data age separately from the last successful fetch.

## Error mapping

| HTTP | Collector code | UI treatment |
|---|---|---|
| 401, 403 | `invalid_credential` | Persistent banner, `Fix in Settings`, one log entry per attempt |
| 429 | `rate_limit` | Keep last values, dim, show retry time |
| 5xx | `source_outage` | Keep last values, dim, show in status strip |
| Network failure | `network_offline` | Keep last values, dim |
| Timeout (15 s) | `source_outage` | Keep last values, dim |
| Non-JSON body | `source_outage` | Keep last values, dim |

## Redaction

The collector never logs the credential, an authorization header, a request body,
or a prompt. Redaction runs at write time in `src/shared/redact.ts`, so a value
that looks like a key is replaced before it reaches memory or disk.
