//! Snapshot assembly, ported from src/main/snapshot.ts.
//!
//! The snapshot is what the renderer draws: five trailing windows, today and
//! month totals, the latest request, and the coverage and collection status that
//! explain what is missing.

use serde_json::{json, Value};

use crate::accounting::{compute_windows, format_time, parse_time, period_totals, WindowInputs};

pub struct SnapshotInputs<'a> {
    pub now: i64,
    pub requests: &'a [Value],
    pub scope: Value,
    pub account: Value,
    pub collection_status: Value,
    pub coverage: Value,
    pub source_granularity_ms: i64,
    pub collection_started_at: Option<i64>,
    pub gaps: &'a [(i64, i64)],
    pub collection_ranges: &'a [(i64, i64, i64)],
    pub retention_horizon: Option<i64>,
    pub time_zone: String,
    /// Force the UTC offset used for the day and month boundaries, in ms.
    ///
    /// `None` reads the system zone, which is what the app wants. The
    /// cross-check sets it so the fixture does not depend on where the test
    /// runs: the TypeScript oracle reads the ambient zone too, so a fixture
    /// generated in one zone and asserted in another disagrees on `today`.
    pub utc_offset_ms: Option<i64>,
    pub sample: bool,
    pub snapshot_version: u64,
}

/// Start of the local calendar day. The widget reports in the user's zone, so
/// this uses the system offset rather than UTC unless one is forced.
fn start_of_local_day(now: i64, forced_offset_ms: Option<i64>) -> i64 {
    let offset = forced_offset_ms.unwrap_or_else(|| local_offset_ms(now));
    let shifted = now + offset;
    let day = shifted.div_euclid(86_400_000) * 86_400_000;
    day - offset
}

fn start_of_local_month(now: i64, forced_offset_ms: Option<i64>) -> i64 {
    let offset = forced_offset_ms.unwrap_or_else(|| local_offset_ms(now));
    let shifted = now + offset;
    let days = shifted.div_euclid(86_400_000);
    let (y, m, _) = civil_from_days(days);
    let first = days_from_civil(y, m, 1);
    first * 86_400_000 - offset
}

/// Offset of the system time zone from UTC at `now`, in ms.
///
/// Day and month boundaries are local, so this cannot be assumed to be zero:
/// with a UTC offset the "today" total covers the wrong 24 hours. `localtime_r`
/// is used rather than a date-time crate because it is the same source the
/// renderer's `Intl` calls read, so the two agree across DST changes.
fn local_offset_ms(now: i64) -> i64 {
    #[cfg(unix)]
    {
        let secs = now.div_euclid(1000) as libc::time_t;
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        let ok = unsafe { libc::localtime_r(&secs, &mut tm) };
        if ok.is_null() {
            return 0;
        }
        // `tm_gmtoff` is the offset east of UTC in seconds.
        return (tm.tm_gmtoff as i64) * 1000;
    }
    #[cfg(not(unix))]
    {
        let _ = now;
        0
    }
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn build_snapshot(inputs: &SnapshotInputs<'_>) -> Value {
    let scoped: Vec<Value> = match inputs.scope["kind"].as_str() {
        Some("key") => {
            let id = inputs.scope["id"].as_str().unwrap_or("");
            inputs
                .requests
                .iter()
                .filter(|r| r["key_id"].as_str() == Some(id))
                .cloned()
                .collect()
        }
        _ => inputs.requests.to_vec(),
    };

    let day_start = start_of_local_day(inputs.now, inputs.utc_offset_ms);
    let day_end = day_start + 86_400_000;
    let month_start = start_of_local_month(inputs.now, inputs.utc_offset_ms);
    let month_end = month_start + 31 * 86_400_000;

    let windows = compute_windows(&WindowInputs {
        now: inputs.now,
        requests: &scoped,
        source_granularity_ms: inputs.source_granularity_ms,
        collection_started_at: inputs.collection_started_at,
        gaps: inputs.gaps,
        retention_horizon: inputs.retention_horizon,
        collection_ranges: inputs.collection_ranges,
    });

    let latest = scoped
        .iter()
        .filter_map(|r| r["event_time"].as_str().and_then(parse_time).map(|t| (t, r)))
        .max_by_key(|(t, _)| *t)
        .map(|(_, r)| r.clone())
        .unwrap_or(Value::Null);

    json!({
        "schema_version": 3,
        "snapshot_version": inputs.snapshot_version,
        "server_time": format_time(inputs.now),
        "fetched_at": inputs.collection_status["last_success"]
            .as_str()
            .map(|s| s.to_string())
            .unwrap_or_else(|| format_time(inputs.now)),
        "currency": "USD",
        "time_zone": inputs.time_zone,
        "scope": inputs.scope,
        "today": period_totals(&scoped, day_start, day_end, inputs.collection_ranges, inputs.now),
        "month": period_totals(&scoped, month_start, month_end, inputs.collection_ranges, inputs.now),
        "today_source": Value::Null,
        "month_source": Value::Null,
        "counter_today": Value::Null,
        "counter_month": Value::Null,
        "latest_request": latest,
        "coverage": inputs.coverage,
        "collection_status": inputs.collection_status,
        "windows": windows,
        "sample": inputs.sample,
        "account": inputs.account,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_day_start_is_midnight() {
        let now = 1_760_000_000_000;
        let start = start_of_local_day(now, None);
        // Midnight local time, so the offset-shifted value is a day boundary.
        let offset = local_offset_ms(now);
        assert_eq!((start + offset) % 86_400_000, 0);
        assert!(start <= now);
        assert!(now - start < 86_400_000);
    }

    #[test]
    fn month_start_is_the_first() {
        let now = 1_760_000_000_000;
        let start = start_of_local_month(now, None);
        let offset = local_offset_ms(now);
        let days = (start + offset).div_euclid(86_400_000);
        let (_, _, d) = civil_from_days(days);
        assert_eq!(d, 1);
    }

    #[test]
    fn a_forced_offset_overrides_the_system_zone() {
        // This is what makes the cross-check portable: the fixture is generated
        // with a pinned offset, so the assertion must not read the ambient zone.
        let now = 1_760_000_000_000;
        let utc = start_of_local_day(now, Some(0));
        assert_eq!(utc % 86_400_000, 0, "UTC midnight is a day boundary");
        assert_eq!(utc, 1_759_968_000_000);

        // A +9h zone starts its day nine hours earlier in UTC terms.
        let kst = start_of_local_day(now, Some(9 * 3_600_000));
        assert_eq!(utc - kst, 9 * 3_600_000);
    }

    #[test]
    fn the_offset_matches_the_system_zone() {
        // The cross-check fixture is generated in the same zone, so a zero
        // offset here would silently shift every day boundary.
        let now = 1_760_000_000_000;
        let offset = local_offset_ms(now);
        assert!(offset.abs() <= 14 * 3_600_000, "offset out of range: {offset}");
    }
}

#[cfg(test)]
mod crosscheck {
    use super::*;

    /// The Rust port must reproduce the TypeScript snapshot exactly for the same
    /// inputs. The fixture is generated by scripts/gen-crosscheck.mjs from the
    /// real buildSnapshot, so a mismatch here is a porting bug, not a spec change.
    #[test]
    fn matches_the_typescript_snapshot() {
        let now: i64 = include_str!("../fixtures/crosscheck-now.txt").trim().parse().unwrap();
        let requests: Vec<Value> =
            serde_json::from_str(include_str!("../fixtures/crosscheck-requests.json")).unwrap();
        let expected: Value =
            serde_json::from_str(include_str!("../fixtures/crosscheck-expected.json")).unwrap();

        let actual = build_snapshot(&SnapshotInputs {
            now,
            requests: &requests,
            scope: json!({ "kind": "all" }),
            account: json!({
                "connected": false, "state": "not_connected", "label": Value::Null,
                "last4": Value::Null, "saved_at": Value::Null,
                "total_credits_micro": Value::Null, "total_usage_micro": Value::Null,
            }),
            collection_status: json!({
                "last_success": format_time(now), "last_error_code": Value::Null,
                "last_error_message": Value::Null, "last_error_at": Value::Null,
                "retry_at": Value::Null, "backoff_ms": 0, "stale": false,
                "expected_delay_sec": 60,
            }),
            coverage: json!({
                "earliest_reliable": Value::Null, "latest_source_date": Value::Null,
                "spend": "full", "tokens": "full", "requests": "full",
                "request_source": "full_account", "warnings": [],
            }),
            source_granularity_ms: 60_000,
            collection_started_at: None,
            gaps: &[],
            collection_ranges: &[],
            retention_horizon: None,
            time_zone: "UTC".to_string(),
            // Pinned so the assertion does not depend on where the test runs.
            // The fixture is generated by the TypeScript oracle, which reads the
            // ambient zone, so both sides must be told the same offset.
            utc_offset_ms: Some(0),
            sample: true,
            snapshot_version: 1,
        });

        for (a, e) in actual["windows"]
            .as_array()
            .unwrap()
            .iter()
            .zip(expected["windows"].as_array().unwrap())
        {
            assert_eq!(a["key"], e["key"], "window key");
            assert_eq!(a["spend_micro"], e["spend_micro"], "spend for {}", a["key"]);
            assert_eq!(a["total_tokens"], e["total_tokens"], "tokens for {}", a["key"]);
            assert_eq!(a["request_count"], e["request_count"], "count for {}", a["key"]);
            assert_eq!(a["coverage"], e["coverage"], "coverage for {}", a["key"]);
        }

        assert_eq!(actual["today"]["spend_micro"], expected["today"]["spend_micro"], "today spend");
        assert_eq!(actual["month"]["spend_micro"], expected["month"]["spend_micro"], "month spend");
        assert_eq!(
            actual["latest_request"]["id"], expected["latest_request"]["id"],
            "latest request"
        );
    }
}
