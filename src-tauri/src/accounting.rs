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

/// Bin width per chart/window range. Must match src/shared/chart.ts. A bin
/// finer than an hour cannot represent hour-granularity data — the row cannot
/// be split across bins — so the 3h and 6h ranges use hour bins; their recent
/// bins still read the finer minute rows.
pub fn chart_bin_ms(scale: &str) -> i64 {
    match scale {
        "10m" => MINUTE,
        "1h" => 5 * MINUTE,
        _ => HOUR,
    }
}

/// Trailing span per range. Must match src/shared/chart.ts.
pub fn chart_range_ms(scale: &str) -> i64 {
    match scale {
        "10m" => 10 * MINUTE,
        "1h" => HOUR,
        "3h" => 3 * HOUR,
        "6h" => 6 * HOUR,
        _ => DAY,
    }
}

pub fn in_half_open_range(t: i64, start: i64, end: i64) -> bool {
    t >= start && t < end
}

pub fn clipped_bin_interval(
    bin_start: i64,
    bin_end: i64,
    period_start: i64,
    period_end: i64,
) -> Option<(i64, i64)> {
    let start = bin_start.max(period_start);
    let end = bin_end.min(period_end);
    if end <= start {
        None
    } else {
        Some((start, end))
    }
}

/// Aligned bins covering a trailing window ending at `anchor`.
pub fn trailing_window_bins(scale: &str, anchor: i64) -> (i64, i64, Vec<(i64, i64)>) {
    let span = chart_range_ms(scale);
    let width = chart_bin_ms(scale);
    let end = anchor;
    let start = end - span;
    let mut t = (start as f64 / width as f64).floor() as i64 * width;
    let mut bins = Vec::new();
    while t < end {
        bins.push((t, t + width));
        t += width;
    }
    (start, end, bins)
}

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
///
/// `overlap_ok` relaxes "covers" to "overlaps": the recorded range only has to
/// touch the period. The chart's bins use this, because a bin at the trailing
/// edge of the minute range still holds real rows — dropping them made a wider
/// window total less than a narrower one (6h < 3h). The half-open row filter
/// clips rows to the bin, so rows outside the recorded range are never
/// invented; the uncovered part of the bin simply has no rows.
pub fn select_granularity(
    rows: &[Value],
    start: i64,
    end: i64,
    max_granularity_ms: i64,
    ranges: &[(i64, i64, i64)],
    overlap_ok: bool,
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
            let full = *range_start <= start + g && *range_end >= end - 2 * g;
            if !overlap_ok {
                if full {
                    return GranularityChoice { granularity_ms: Some(g), rows: bucket };
                }
                continue;
            }
            // Overlap mode (chart bins): real rows always win. A granularity
            // with rows inside the period qualifies; full recorded coverage
            // with no rows inside qualifies only when no granularity has rows
            // there — an empty bin is zero usage, but a coarser row proves the
            // fine fetch missed data and must not be shadowed by it.
            let has_rows_inside = |rs: &[Value]| {
                rs.iter().any(|row| {
                    row["event_time"]
                        .as_str()
                        .and_then(parse_time)
                        .map(|t| t >= start && t < end)
                        .unwrap_or(false)
                })
            };
            if has_rows_inside(&bucket) {
                return GranularityChoice { granularity_ms: Some(g), rows: bucket };
            }
            let any_rows_inside = by_granularity.values().any(|rs| has_rows_inside(rs));
            if full && !any_rows_inside {
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
        let covers = if overlap_ok {
            earliest < end && latest >= start
        } else {
            earliest <= start + g && latest >= end - 2 * g
        };
        if covers {
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
/// granularity is no coarser than the window itself; a coarser source simply
/// produces missing bins in the chart, which the window then sums as partial.
pub fn compute_windows(inputs: &WindowInputs<'_>) -> Vec<Value> {
    let as_of = format_time(inputs.now);

    WINDOWS
        .iter()
        .map(|(key, ms)| {
            let window_start = inputs.now - ms;

            let mut cell = json!({
                "key": key,
                "label": key,
                "window_start": format_time(window_start),
                "window_end": format_time(inputs.now),
                "spend_micro": Value::Null,
                "input_tokens": Value::Null,
                "output_tokens": Value::Null,
                "total_tokens": Value::Null,
                "request_count": Value::Null,
                "coverage": "unavailable",
                "partial_reason": Value::Null,
                "as_of": as_of,
            });

            // The gate must match src/shared/windows.ts exactly: a source no
            // finer than the window cannot answer it. The port briefly used a
            // quarter of the window here, which marked windows unavailable that
            // the renderer computed — the range buttons showed "–" while the
            // chart drew bars, and the totals disagreed.
            if inputs.source_granularity_ms > *ms {
                cell["partial_reason"] = json!("source_granularity");
                return cell;
            }

            // Same bins as the chart for this range, so the interval button,
            // the headline, and the bars are one number. One granularity per
            // bin, clipped to the trailing window.
            let (period_start, period_end, bins) = trailing_window_bins(key, inputs.now);
            let axis_end = period_end.min(inputs.now);
            let mut spend_parts: Vec<Option<i64>> = Vec::new();
            let mut input_parts: Vec<Option<i64>> = Vec::new();
            let mut output_parts: Vec<Option<i64>> = Vec::new();
            let mut total_parts: Vec<Option<i64>> = Vec::new();
            let mut request_parts: Vec<Option<i64>> = Vec::new();

            for (bin_start, bin_end) in bins {
                if bin_start >= axis_end {
                    continue;
                }
                let Some((lo, hi)) = clipped_bin_interval(bin_start, bin_end, period_start, axis_end) else {
                    continue;
                };
                let choice = select_granularity(
                    inputs.requests,
                    lo,
                    hi,
                    bin_end - bin_start,
                    inputs.collection_ranges,
                    true,
                );
                let in_bin: Vec<&Value> = choice
                    .rows
                    .iter()
                    .filter(|r| {
                        r["event_time"]
                            .as_str()
                            .and_then(parse_time)
                            .map(|t| in_half_open_range(t, lo, hi))
                            .unwrap_or(false)
                    })
                    .collect();
                if in_bin.is_empty() {
                    continue;
                }
                spend_parts.push(sum_or_none(in_bin.iter().map(|r| r["cost_micro"].as_i64())));
                input_parts.push(sum_or_none(in_bin.iter().map(|r| r["input_tokens"].as_i64())));
                output_parts.push(sum_or_none(in_bin.iter().map(|r| r["output_tokens"].as_i64())));
                total_parts.push(sum_or_none(in_bin.iter().map(|r| r["total_tokens"].as_i64())));
                request_parts.push(sum_or_none(in_bin.iter().map(|r| r["request_count"].as_i64())));
            }

            let spend = sum_or_none(spend_parts.into_iter());
            let input = sum_or_none(input_parts.into_iter());
            let output = sum_or_none(output_parts.into_iter());
            let total = sum_or_none(total_parts.into_iter());
            let requests = sum_or_none(request_parts.into_iter());

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
    // A whole-period query: the granularity must cover the period, not merely
    // overlap it, or the earlier part would be silently missing.
    let choice = select_granularity(requests, start, effective_end, i64::MAX, ranges, false);
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

/// Group usage rows into a breakdown for the Models and Keys tabs.
///
/// Mirrors `buildBreakdown` in src/shared/breakdown.ts. The public API exposes
/// aggregates rather than individual generations, so this groups the same
/// buckets the charts use.
///
/// The rows are selected exactly the way the chart selects them: one
/// granularity per bin, clipped to the trailing window. A single granularity
/// for the whole window dropped the current partial bin's minute rows whenever
/// hour rows also covered the range, so the table's total drifted from the
/// interval buttons — which sum the same bins the chart draws.
pub fn build_breakdown(
    requests: &[Value],
    scale: &str,
    anchor: i64,
    now: i64,
    group_by: &str,
    ranges: &[(i64, i64, i64)],
) -> Value {
    use std::collections::BTreeMap;

    let (period_start, period_end, bins) = trailing_window_bins(scale, anchor);
    let axis_end = period_end.min(now);

    // The group key and its display label. A key row prefers the display name
    // and falls back to the id, which is a hash and not secret material.
    let group_of = |row: &Value| -> (String, String) {
        if group_by == "model" {
            match row["model"].as_str().map(str::trim).filter(|m| !m.is_empty()) {
                Some(model) => (format!("model:{model}"), model.to_string()),
                None => ("model:unknown".to_string(), "Unknown".to_string()),
            }
        } else {
            let name = row["key_name"].as_str().map(str::trim).filter(|s| !s.is_empty());
            let id = row["key_id"].as_str().map(str::trim).filter(|s| !s.is_empty());
            match name.or(id) {
                Some(label) => {
                    let id = row["key_id"].as_str().unwrap_or(label);
                    (format!("key:{id}"), label.to_string())
                }
                None => ("key:unknown".to_string(), "Unknown".to_string()),
            }
        }
    };

    let mut groups: BTreeMap<String, (String, Vec<&Value>)> = BTreeMap::new();
    let mut any_bin = false;

    for (bin_start, bin_end) in bins {
        if bin_start >= axis_end {
            continue;
        }
        let Some((lo, hi)) = clipped_bin_interval(bin_start, bin_end, period_start, axis_end) else {
            continue;
        };
        // One granularity per bin — the same choice build_chart makes for the
        // same bin, so the table and the bars cannot disagree. The rows are
        // then taken from `requests` directly rather than from the choice's
        // owned copy, so the groups can borrow them.
        let choice = select_granularity(requests, lo, hi, bin_end - bin_start, ranges, true);
        let Some(g) = choice.granularity_ms else { continue };
        for row in requests {
            let source = row["source"].as_str().unwrap_or("");
            let matches = match granularity_of_source(source) {
                Some(row_g) => row_g == g,
                // A source that names no granularity is only used when no known
                // granularity covers the bin, which is what Some(0) reports.
                None => g == 0,
            };
            if !matches {
                continue;
            }
            let Some(t) = row["event_time"].as_str().and_then(parse_time) else { continue };
            if !in_half_open_range(t, lo, hi) {
                continue;
            }
            any_bin = true;
            let (id, label) = group_of(row);
            groups.entry(id).or_insert_with(|| (label, Vec::new())).1.push(row);
        }
    }

    if !any_bin && groups.is_empty() {
        return json!({
            "group_by": group_by,
            "rows": [],
            "granularity_ms": Value::Null,
            "incomplete": true,
        });
    }

    let mut rows: Vec<Value> = groups
        .into_iter()
        .map(|(id, (label, bucket))| {
            let latest = bucket
                .iter()
                .filter_map(|r| r["event_time"].as_str())
                .max()
                .map(str::to_string);
            json!({
                "id": id,
                "label": label,
                "spend_micro": sum_or_none(bucket.iter().map(|r| r["cost_micro"].as_i64())),
                "input_tokens": sum_or_none(bucket.iter().map(|r| r["input_tokens"].as_i64())),
                "output_tokens": sum_or_none(bucket.iter().map(|r| r["output_tokens"].as_i64())),
                "total_tokens": sum_or_none(bucket.iter().map(|r| r["total_tokens"].as_i64())),
                "bucket_count": bucket.len(),
                "latest": latest,
            })
        })
        .collect();

    // Largest spend first, then largest token count, so the interesting rows lead.
    rows.sort_by(|a, b| {
        let spend_a = a["spend_micro"].as_i64().unwrap_or(0);
        let spend_b = b["spend_micro"].as_i64().unwrap_or(0);
        if spend_a != spend_b {
            return spend_b.cmp(&spend_a);
        }
        let tokens_a = a["total_tokens"].as_i64().unwrap_or(0);
        let tokens_b = b["total_tokens"].as_i64().unwrap_or(0);
        tokens_b.cmp(&tokens_a)
    });

    json!({
        "group_by": group_by,
        "rows": rows,
        // Bins can mix granularities (minute rows for the current partial bin,
        // hour rows for older ones), so no single granularity names the table.
        "granularity_ms": Value::Null,
        "incomplete": false,
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

    #[test]
    fn the_granularity_gate_matches_the_typescript_spec() {
        // The gate is "no coarser than the window", matching
        // src/shared/windows.ts. An hourly source answers the 1h window and a
        // daily source answers the 24h window; the quarter-window rule the port
        // briefly used gates both out and the totals disagree with the chart.
        let base = WindowInputs {
            now: 1_760_000_000_000,
            requests: &[],
            source_granularity_ms: HOUR,
            collection_started_at: None,
            gaps: &[],
            retention_horizon: None,
            collection_ranges: &[],
        };
        let cells = compute_windows(&base);
        let one_hour = cells.iter().find(|c| c["key"] == "1h").unwrap();
        assert_ne!(one_hour["coverage"], "unavailable", "an hourly source answers 1h");
        let day = cells.iter().find(|c| c["key"] == "24h").unwrap();
        assert_ne!(day["coverage"], "unavailable", "an hourly source answers 24h");

        let daily = WindowInputs { source_granularity_ms: DAY, ..base };
        let cells = compute_windows(&daily);
        let day = cells.iter().find(|c| c["key"] == "24h").unwrap();
        assert_ne!(day["coverage"], "unavailable", "a daily source answers 24h");
        let ten_min = cells.iter().find(|c| c["key"] == "10m").unwrap();
        assert_eq!(ten_min["coverage"], "unavailable", "a daily source cannot answer 10m");
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
            json!({
                "event_time": format_time(now - 2 * HOUR),
                "cost_micro": 1_000_000,
                "input_tokens": 10,
                "output_tokens": 5,
                "total_tokens": 15,
                "request_count": 300,
                "source": "openrouter.analytics.hour",
            }),
        ];
        let ranges = recorded_ranges(now);
        let inputs = WindowInputs {
            now,
            requests: &rows,
            source_granularity_ms: MINUTE,
            collection_started_at: None,
            gaps: &[],
            retention_horizon: None,
            collection_ranges: &ranges,
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
        let ranges = recorded_ranges(now);
        let inputs = WindowInputs {
            now,
            requests: &rows,
            source_granularity_ms: MINUTE,
            collection_started_at: None,
            gaps: &[],
            retention_horizon: None,
            collection_ranges: &ranges,
        };
        let cells = compute_windows(&inputs);
        let one_hour = cells.iter().find(|c| c["key"] == "1h").unwrap();
        assert_eq!(one_hour["request_count"], Value::Null);
    }

    #[test]
    fn a_leading_aligned_bin_does_not_count_spend_before_the_window() {
        let now = 1_760_000_000_000;
        let (start, _, bins) = trailing_window_bins("24h", now);
        let first = bins[0];
        assert!(first.0 < start, "alignment reaches before the window");
        let rows = vec![
            json!({
                "event_time": format_time(first.0),
                "cost_micro": 9_000_000,
                "request_count": 1,
                "source": "test",
            }),
            json!({
                "event_time": format_time(start),
                "cost_micro": 1_000_000,
                "request_count": 1,
                "source": "test",
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
        let day = cells.iter().find(|c| c["key"] == "24h").unwrap();
        assert_eq!(day["spend_micro"], 1_000_000);
    }

    #[test]
    fn a_24h_window_includes_the_current_hour_of_minute_rows() {
        let now = 1_760_000_000_000;
        let ranges = recorded_ranges(now);
        let rows = vec![
            json!({
                "event_time": format_time(now - 5 * MINUTE),
                "cost_micro": 500_000,
                "request_count": 2,
                "source": "openrouter.analytics.minute",
            }),
            json!({
                "event_time": format_time(now - 5 * HOUR),
                "cost_micro": 1_000_000,
                "request_count": 10,
                "source": "openrouter.analytics.hour",
            }),
        ];
        let inputs = WindowInputs {
            now,
            requests: &rows,
            source_granularity_ms: MINUTE,
            collection_started_at: None,
            gaps: &[],
            retention_horizon: None,
            collection_ranges: &ranges,
        };
        let cells = compute_windows(&inputs);
        let day = cells.iter().find(|c| c["key"] == "24h").unwrap();
        assert_eq!(day["spend_micro"], 1_500_000);
        assert_eq!(day["request_count"], 12);
    }

    fn breakdown_row(event_time: i64, model: &str, key: &str, tokens: i64, cost: i64) -> Value {
        json!({
            "event_time": format_time(event_time),
            "model": model,
            "key_id": key,
            "key_name": key,
            "cost_micro": cost,
            "input_tokens": tokens / 2,
            "output_tokens": tokens / 2,
            "total_tokens": tokens,
            "request_count": 1,
            "source": "openrouter.analytics.minute",
        })
    }

    /// The ranges the collector records, so a window is answerable even where a
    /// bucket produced no row.
    fn recorded_ranges(now: i64) -> Vec<(i64, i64, i64)> {
        vec![
            (MINUTE, now - 2 * HOUR, now),
            (HOUR, now - DAY, now),
            (DAY, now - 30 * DAY, now),
        ]
    }

    #[test]
    fn a_breakdown_groups_by_model_and_sums_one_granularity() {
        let now = 1_760_000_000_000;
        let rows = vec![
            breakdown_row(now - 50 * MINUTE, "model-a", "key-1", 100, 2_000_000),
            breakdown_row(now - 5 * MINUTE, "model-a", "key-2", 50, 1_000_000),
            breakdown_row(now - 7 * MINUTE, "model-b", "key-1", 10, 500_000),
            // A day row covering the same period must not be added on top.
            json!({
                "event_time": format_time(now - 5 * HOUR),
                "model": "model-a",
                "cost_micro": 9_000_000,
                "total_tokens": 900,
                "source": "openrouter.analytics.day",
            }),
        ];
        let result = build_breakdown(&rows, "1h", now, now, "model", &recorded_ranges(now));
        let out = result["rows"].as_array().unwrap();
        assert_eq!(out.len(), 2, "two models");
        assert_eq!(out[0]["label"], "model-a", "largest spend leads");
        assert_eq!(out[0]["total_tokens"], 150);
        assert_eq!(out[0]["spend_micro"], 3_000_000);
        assert_eq!(out[0]["bucket_count"], 2);
        assert_eq!(out[1]["label"], "model-b");
    }

    #[test]
    fn a_breakdown_groups_by_key_and_keeps_the_display_name() {
        let now = 1_760_000_000_000;
        let rows = vec![
            breakdown_row(now - 50 * MINUTE, "model-a", "VScode M1", 100, 2_000_000),
            breakdown_row(now - 5 * MINUTE, "model-b", "VScode M1", 50, 1_000_000),
            breakdown_row(now - 7 * MINUTE, "model-a", "Strix M5", 10, 500_000),
        ];
        let result = build_breakdown(&rows, "1h", now, now, "key", &recorded_ranges(now));
        let out = result["rows"].as_array().unwrap();
        assert_eq!(out.len(), 2, "two keys");
        assert_eq!(out[0]["label"], "VScode M1");
        assert_eq!(out[0]["total_tokens"], 150);
        assert_eq!(out[0]["spend_micro"], 3_000_000);
    }

    #[test]
    fn a_breakdown_with_no_rows_is_incomplete() {
        // Nothing stored means the period cannot be answered at all, so the tab
        // must say so rather than render an empty table that reads as "no
        // usage".
        let now = 1_760_000_000_000;
        let result = build_breakdown(&[], "10m", now, now, "model", &[]);
        assert_eq!(result["incomplete"], true);
        assert_eq!(result["rows"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn a_breakdown_adds_up_to_the_interval_button() {
        // Rule: the table and the range buttons are one figure. Minute rows
        // cover the last two hours and hour rows cover the day; the window sums
        // the recent bins from minute rows and the older bins from hour rows,
        // and the table must select rows the same way.
        let now = 1_760_000_000_000;
        let ranges = recorded_ranges(now);
        let rows = vec![
            breakdown_row(now - 5 * MINUTE, "model-a", "key-1", 10, 100),
            breakdown_row(now - 65 * MINUTE, "model-a", "key-1", 20, 200),
            json!({
                "event_time": format_time(now - 5 * HOUR),
                "model": "model-a",
                "key_id": "key-1",
                "key_name": "key-1",
                "cost_micro": 1_000,
                "total_tokens": 100,
                "source": "openrouter.analytics.hour",
            }),
            json!({
                "event_time": format_time(now - 20 * HOUR),
                "model": "model-b",
                "key_id": "key-2",
                "key_name": "key-2",
                "cost_micro": 2_000,
                "total_tokens": 200,
                "source": "openrouter.analytics.hour",
            }),
        ];

        let breakdown = build_breakdown(&rows, "24h", now, now, "model", &ranges);
        let table_spend: i64 = breakdown["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["spend_micro"].as_i64().unwrap_or(0))
            .sum();
        let table_tokens: i64 = breakdown["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["total_tokens"].as_i64().unwrap_or(0))
            .sum();

        let cells = compute_windows(&WindowInputs {
            now,
            requests: &rows,
            source_granularity_ms: MINUTE,
            collection_started_at: None,
            gaps: &[],
            retention_horizon: None,
            collection_ranges: &ranges,
        });
        let day = cells.iter().find(|c| c["key"] == "24h").unwrap();

        assert_eq!(table_spend, day["spend_micro"].as_i64().unwrap(), "table spend equals the 24h button");
        assert_eq!(table_tokens, day["total_tokens"].as_i64().unwrap(), "table tokens equal the 24h button");
    }

    /// Consistency check against the live database, when it exists.
    ///
    /// The interval buttons and the Models/Keys tables must total the same
    /// figure at every scale, and the scales must be monotonic. Reads the real
    /// widget.db on the developer's machine; a no-op anywhere else.
    #[test]
    fn the_live_database_is_consistent_across_every_scale() {
        let home = match std::env::var("HOME") {
            Ok(h) => h,
            Err(_) => return,
        };
        let dir = std::path::PathBuf::from(home).join("Library/Application Support/OpenRouter Meter");
        if !dir.join("widget.db").exists() {
            eprintln!("no live database; skipping");
            return;
        }
        let db = crate::db::Db::open(&dir).unwrap();
        let requests = db.list_requests(100_000, None);
        let ranges = db.collection_ranges();
        let now = crate::logging::now_ms();

        let mut previous: Option<i64> = None;
        for scale in ["10m", "1h", "3h", "6h", "24h"] {
            let cells = compute_windows(&WindowInputs {
                now,
                requests: &requests,
                source_granularity_ms: MINUTE,
                collection_started_at: None,
                gaps: &[],
                retention_horizon: None,
                collection_ranges: &ranges,
            });
            let cell = cells.iter().find(|c| c["key"] == scale).unwrap();
            let button_spend = cell["spend_micro"].as_i64().unwrap_or(0);
            let button_tokens = cell["total_tokens"].as_i64().unwrap_or(0);

            for group_by in ["model", "key"] {
                let breakdown = build_breakdown(&requests, scale, now, now, group_by, &ranges);
                let rows = breakdown["rows"].as_array().unwrap();
                let table_spend: i64 =
                    rows.iter().map(|r| r["spend_micro"].as_i64().unwrap_or(0)).sum();
                let table_tokens: i64 =
                    rows.iter().map(|r| r["total_tokens"].as_i64().unwrap_or(0)).sum();
                assert_eq!(
                    button_spend, table_spend,
                    "{scale} {group_by} table spend disagrees with the button"
                );
                assert_eq!(
                    button_tokens, table_tokens,
                    "{scale} {group_by} table tokens disagree with the button"
                );
            }

            if let Some(prev) = previous {
                assert!(
                    button_spend >= prev,
                    "{scale} spend ({button_spend}) is less than the previous window ({prev})"
                );
            }
            previous = Some(button_spend);
        }
    }
}
