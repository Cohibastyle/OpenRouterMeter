//! Accounting primitives, ported from src/shared/{money,granularity,windows}.ts.
//!
//! Money is integer micro-dollars throughout, so totals are exact. The
//! granularity rule is the important one: the collector stores the same spend at
//! minute, hour, and day granularity over overlapping ranges, so summing every
//! row counts the same money two or three times. Every consumer picks exactly
//! one granularity per period.

use serde_json::{json, Value};

pub const MICRO: i64 = 1_000_000;
pub const MINUTE: i64 = 60_000;
pub const HOUR: i64 = 60 * MINUTE;
pub const DAY: i64 = 24 * HOUR;

/// The five trailing windows from FSD section 10.3.
pub const WINDOWS: &[(&str, i64)] = &[
    ("10m", 10 * MINUTE),
    ("1h", HOUR),
    ("3h", 3 * HOUR),
    ("6h", 6 * HOUR),
    ("24h", DAY),
];

/// Bucket width implied by a row's source, or None when unknown.
pub fn granularity_of_source(source: &str) -> Option<i64> {
    if source.ends_with(".minute") {
        Some(MINUTE)
    } else if source.ends_with(".hour") {
        Some(HOUR)
    } else if source.ends_with(".day") {
        Some(DAY)
    } else {
        None
    }
}

/// Sum that returns None when every input is null, so missing never becomes zero.
pub fn sum_or_none(values: impl Iterator<Item = Option<i64>>) -> Option<i64> {
    let mut seen = false;
    let mut total = 0i64;
    for v in values {
        if let Some(n) = v {
            seen = true;
            total += n;
        }
    }
    if seen {
        Some(total)
    } else {
        None
    }
}

/// Parse an ISO-8601 timestamp to epoch ms. Returns None on anything unparseable.
pub fn parse_time(value: &str) -> Option<i64> {
    // The app only ever writes `YYYY-MM-DDTHH:MM:SS.sssZ`, so a fixed-shape
    // parse is enough and avoids a date-time dependency.
    let bytes = value.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |a: usize, b: usize| -> Option<i64> { value.get(a..b)?.parse::<i64>().ok() };
    let year = num(0, 4)?;
    let month = num(5, 7)?;
    let day = num(8, 10)?;
    let hour = num(11, 13)?;
    let minute = num(14, 16)?;
    let second = num(17, 19)?;
    let millis = if bytes.len() >= 23 && bytes[19] == b'.' {
        num(20, 23).unwrap_or(0)
    } else {
        0
    };

    Some(civil_to_epoch_ms(year, month, day, hour, minute, second, millis))
}

/// Days from civil date, per Howard Hinnant's algorithm.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_to_epoch_ms(y: i64, m: i64, d: i64, hh: i64, mm: i64, ss: i64, ms: i64) -> i64 {
    days_from_civil(y, m, d) * 86_400_000 + hh * 3_600_000 + mm * 60_000 + ss * 1000 + ms
}

/// Format epoch ms as `YYYY-MM-DDTHH:MM:SS.sssZ`.
pub fn format_time(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let hh = rem / 3_600_000;
    let mm = (rem % 3_600_000) / 60_000;
    let ss = (rem % 60_000) / 1000;
    let milli = rem % 1000;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{milli:03}Z")
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

pub struct GranularityChoice {
    pub granularity_ms: Option<i64>,
    pub rows: Vec<Value>,
}

/// Pick the finest granularity that covers `[start, end)` and is no coarser than
/// `max_granularity_ms`. Mirrors selectGranularity in shared/granularity.ts.
pub fn select_granularity(
    rows: &[Value],
    start: i64,
    end: i64,
    max_granularity_ms: i64,
    ranges: &[(i64, i64, i64)],
) -> GranularityChoice {
    use std::collections::BTreeMap;

    let mut by_granularity: BTreeMap<i64, Vec<Value>> = BTreeMap::new();
    let mut unknown: Vec<Value> = Vec::new();

    for row in rows {
        let source = row["source"].as_str().unwrap_or("");
        match granularity_of_source(source) {
            None => unknown.push(row.clone()),
            Some(g) => by_granularity.entry(g).or_default().push(row.clone()),
        }
    }

    let candidates: Vec<i64> = by_granularity
        .keys()
        .copied()
        .filter(|g| *g <= max_granularity_ms)
        .collect();

    for g in candidates {
        let bucket = by_granularity.get(&g).cloned().unwrap_or_default();

        // Prefer the recorded fetch range: rows alone cannot prove coverage,
        // because an hour with no activity produces no row.
        if let Some((_, range_start, range_end)) = ranges.iter().find(|(rg, _, _)| *rg == g) {
            if *range_start <= start + g && *range_end >= end - 2 * g {
                return GranularityChoice { granularity_ms: Some(g), rows: bucket };
            }
            continue;
        }

        let mut earliest = i64::MAX;
        let mut latest = i64::MIN;
        for row in &bucket {
            if let Some(t) = row["event_time"].as_str().and_then(parse_time) {
                earliest = earliest.min(t);
                latest = latest.max(t);
            }
        }
        if earliest <= start + g && latest >= end - 2 * g {
            return GranularityChoice { granularity_ms: Some(g), rows: bucket };
        }
    }

    if !unknown.is_empty() {
        return GranularityChoice { granularity_ms: Some(0), rows: unknown };
    }
    GranularityChoice { granularity_ms: None, rows: Vec::new() }
}

pub struct WindowInputs<'a> {
    pub now: i64,
    pub requests: &'a [Value],
    pub source_granularity_ms: i64,
    pub collection_started_at: Option<i64>,
    pub gaps: &'a [(i64, i64)],
    pub retention_horizon: Option<i64>,
    pub collection_ranges: &'a [(i64, i64, i64)],
}

/// Compute the five trailing windows. Windows are trailing and overlapping and
/// are never summed. A window is computable only when the finest source
/// granularity is at most a quarter of the window width.
pub fn compute_windows(inputs: &WindowInputs<'_>) -> Vec<Value> {
    let as_of = format_time(inputs.now);

    WINDOWS
        .iter()
        .map(|(key, ms)| {
            let window_start = inputs.now - ms;
            let window_end = inputs.now;

            let mut cell = json!({
                "key": key,
                "label": key,
                "window_start": format_time(window_start),
                "window_end": format_time(window_end),
                "spend_micro": Value::Null,
                "input_tokens": Value::Null,
                "output_tokens": Value::Null,
                "total_tokens": Value::Null,
                "request_count": Value::Null,
                "coverage": "unavailable",
                "partial_reason": Value::Null,
                "as_of": as_of,
            });

            if inputs.source_granularity_ms > ms / 4 {
                cell["partial_reason"] = json!("source_granularity");
                return cell;
            }

            let choice = select_granularity(
                inputs.requests,
                window_start,
                window_end,
                *ms,
                inputs.collection_ranges,
            );
            let source: Vec<Value> = if choice.granularity_ms.is_none() {
                inputs.requests.to_vec()
            } else {
                choice.rows
            };

            let in_window: Vec<&Value> = source
                .iter()
                .filter(|r| {
                    r["event_time"]
                        .as_str()
                        .and_then(parse_time)
                        .map(|t| t > window_start && t <= window_end)
                        .unwrap_or(false)
                })
                .collect();

            let spend = sum_or_none(in_window.iter().map(|r| r["cost_micro"].as_i64()));
            let input = sum_or_none(in_window.iter().map(|r| r["input_tokens"].as_i64()));
            let output = sum_or_none(in_window.iter().map(|r| r["output_tokens"].as_i64()));
            let total = sum_or_none(in_window.iter().map(|r| r["total_tokens"].as_i64()));
            // The source's own count, not the number of rows: a row is an
            // aggregate, so counting rows undercounts and makes the figure
            // depend on which granularity the window selected.
            let requests = sum_or_none(in_window.iter().map(|r| r["request_count"].as_i64()));

            let reason = partial_reason_for(window_start, inputs);
            let coverage = if reason.is_some() { "partial" } else { "full" };

            cell["spend_micro"] = json!(spend);
            cell["input_tokens"] = json!(input);
            cell["output_tokens"] = json!(output);
            cell["total_tokens"] = json!(total);
            cell["request_count"] = json!(requests);
            cell["coverage"] = json!(coverage);
            cell["partial_reason"] = json!(reason);
            cell
        })
        .collect()
}

fn partial_reason_for(window_start: i64, inputs: &WindowInputs<'_>) -> Option<&'static str> {
    if let Some(started) = inputs.collection_started_at {
        if started > window_start {
            return Some("collection_started_later");
        }
    }
    for (gap_start, gap_end) in inputs.gaps {
        if *gap_start < inputs.now && *gap_end > window_start {
            return Some("gap");
        }
    }
    if let Some(horizon) = inputs.retention_horizon {
        if window_start < horizon {
            return Some("retention");
        }
    }
    None
}

/// Totals for a calendar period, using one granularity only.
pub fn period_totals(
    requests: &[Value],
    start: i64,
    end: i64,
    ranges: &[(i64, i64, i64)],
    now: i64,
) -> Value {
    let effective_end = end.min(now);
    let choice = select_granularity(requests, start, effective_end, i64::MAX, ranges);
    let source: Vec<Value> = if choice.granularity_ms.is_none() {
        requests.to_vec()
    } else {
        choice.rows
    };

    let in_range: Vec<&Value> = source
        .iter()
        .filter(|r| {
            r["event_time"]
                .as_str()
                .and_then(parse_time)
                .map(|t| t >= start && t < end)
                .unwrap_or(false)
        })
        .collect();

    let spend = sum_or_none(in_range.iter().map(|r| r["cost_micro"].as_i64())).unwrap_or(0);
    let input = sum_or_none(in_range.iter().map(|r| r["input_tokens"].as_i64()));
    let output = sum_or_none(in_range.iter().map(|r| r["output_tokens"].as_i64()));
    let total = sum_or_none(in_range.iter().map(|r| r["total_tokens"].as_i64()));
    // The source's own count, not the row count: a row is an aggregate, so
    // counting rows undercounts and varies with the selected granularity.
    let requests = sum_or_none(in_range.iter().map(|r| r["request_count"].as_i64()));

    json!({
        "start": format_time(start),
        "end": format_time(end),
        "spend_micro": spend,
        "input_tokens": input,
        "output_tokens": output,
        "total_tokens": total,
        "request_count": requests,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_round_trips() {
        let ms = 1_760_000_000_000;
        let text = format_time(ms);
        assert_eq!(parse_time(&text), Some(ms));
    }

    #[test]
    fn missing_never_becomes_zero() {
        assert_eq!(sum_or_none([None, None].into_iter()), None);
        assert_eq!(sum_or_none([None, Some(5)].into_iter()), Some(5));
    }

    #[test]
    fn granularity_is_read_from_the_source_suffix() {
        assert_eq!(granularity_of_source("openrouter.analytics.minute"), Some(MINUTE));
        assert_eq!(granularity_of_source("openrouter.analytics.day"), Some(DAY));
        assert_eq!(granularity_of_source("sample"), None);
    }

    #[test]
    fn a_coarse_source_cannot_answer_a_short_window() {
        let inputs = WindowInputs {
            now: 1_760_000_000_000,
            requests: &[],
            source_granularity_ms: DAY,
            collection_started_at: None,
            gaps: &[],
            retention_horizon: None,
            collection_ranges: &[],
        };
        let cells = compute_windows(&inputs);
        assert_eq!(cells[0]["coverage"], "unavailable");
        assert_eq!(cells[0]["partial_reason"], "source_granularity");
    }

    fn aggregate_row(event_time: i64, requests: i64) -> Value {
        json!({
            "event_time": format_time(event_time),
            "cost_micro": 1_000_000,
            "input_tokens": 10,
            "output_tokens": 5,
            "total_tokens": 15,
            "request_count": requests,
            "source": "openrouter.analytics.minute",
        })
    }

    #[test]
    fn a_window_sums_the_source_request_count_not_the_row_count() {
        // The bug: request_count was the row count. A row is an aggregate, so a
        // minute bucket holding 40 requests counted as one, and because the
        // collector stores the same period at minute, hour, and day granularity
        // the figure also changed with whichever granularity the window
        // selected. That is how the 1-hour count could read higher than the
        // 24-hour one.
        let now = 1_760_000_000_000;
        let rows = vec![
            aggregate_row(now - 5 * MINUTE, 40),
            aggregate_row(now - 15 * MINUTE, 25),
            aggregate_row(now - 2 * HOUR, 300),
        ];
        let inputs = WindowInputs {
            now,
            requests: &rows,
            source_granularity_ms: MINUTE,
            collection_started_at: None,
            gaps: &[],
            retention_horizon: None,
            collection_ranges: &[],
        };
        let cells = compute_windows(&inputs);
        let one_hour = cells.iter().find(|c| c["key"] == "1h").unwrap();
        let day = cells.iter().find(|c| c["key"] == "24h").unwrap();

        assert_eq!(one_hour["request_count"], 65, "40 + 25 requests inside the hour");
        assert_eq!(day["request_count"], 365, "every request inside the day");
        assert!(
            day["request_count"].as_i64() > one_hour["request_count"].as_i64(),
            "the 24-hour count must always exceed the 1-hour count"
        );
    }

    #[test]
    fn a_window_with_no_reported_count_stays_null() {
        // Counting rows here would report 2 requests for a source that never
        // said how many there were, which is a guess dressed as a measurement.
        let now = 1_760_000_000_000;
        let rows = vec![
            json!({
                "event_time": format_time(now - 5 * MINUTE),
                "cost_micro": 1_000_000,
                "request_count": Value::Null,
                "source": "openrouter.analytics.minute",
            }),
            json!({
                "event_time": format_time(now - 10 * MINUTE),
                "cost_micro": 1_000_000,
                "request_count": Value::Null,
                "source": "openrouter.analytics.minute",
            }),
        ];
        let inputs = WindowInputs {
            now,
            requests: &rows,
            source_granularity_ms: MINUTE,
            collection_started_at: None,
            gaps: &[],
            retention_horizon: None,
            collection_ranges: &[],
        };
        let cells = compute_windows(&inputs);
        let one_hour = cells.iter().find(|c| c["key"] == "1h").unwrap();
        assert_eq!(one_hour["request_count"], Value::Null);
    }
}
