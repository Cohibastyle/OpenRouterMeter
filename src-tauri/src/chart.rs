//! Chart binning, ported from src/shared/chart.ts.
//!
//! Ranges are rolling windows ending at the anchor, not calendar periods, so the
//! chart covers exactly the range the button names. Each bin sums one
//! granularity only, for the same reason the windows do.

use serde_json::{json, Value};

use crate::accounting::{format_time, parse_time, select_granularity, sum_or_none, MINUTE};

const HOUR: i64 = 60 * MINUTE;

/// Bin width per range, chosen so each range has a readable number of bars and
/// never gets finer than the granularity the collector retains.
fn bin_ms(scale: &str) -> i64 {
    match scale {
        "10m" => MINUTE,
        "1h" => 5 * MINUTE,
        "3h" => 15 * MINUTE,
        "6h" => 30 * MINUTE,
        _ => HOUR,
    }
}

fn range_ms(scale: &str) -> i64 {
    match scale {
        "10m" => 10 * MINUTE,
        "1h" => 60 * MINUTE,
        "3h" => 3 * HOUR,
        "6h" => 6 * HOUR,
        _ => 24 * HOUR,
    }
}

pub struct ChartRequest<'a> {
    pub metric: String,
    pub scale: String,
    pub anchor: i64,
    pub axis: String,
    pub requests: &'a [Value],
    pub collection_ranges: &'a [(i64, i64, i64)],
    pub sample: bool,
    pub now: i64,
}

pub fn build_chart(req: &ChartRequest<'_>) -> Value {
    let span = range_ms(&req.scale);
    let width = bin_ms(&req.scale);
    let end = req.anchor;
    let start = end - span;

    // The right edge is the current time for the current period and the period
    // end for a past period. It is never in the future.
    let axis_end = end.min(req.now);

    let mut bins = Vec::new();
    let mut total_spend = 0i64;
    let mut total_input = 0i64;
    let mut total_output = 0i64;

    // Align the first bin down to a bin boundary so bars are stable as time moves.
    let mut t = (start as f64 / width as f64).floor() as i64 * width;
    while t < end {
        let bin_start = t;
        let bin_end = t + width;
        t += width;

        // A bin that has not started yet is not data; drawing it would pile
        // every future bin onto the right edge of the log axis.
        if bin_start >= axis_end {
            continue;
        }

        let choice = select_granularity(req.requests, bin_start, bin_end, width, req.collection_ranges);
        let in_bin: Vec<&Value> = choice
            .rows
            .iter()
            .filter(|r| {
                r["event_time"]
                    .as_str()
                    .and_then(parse_time)
                    .map(|ts| ts >= bin_start && ts < bin_end)
                    .unwrap_or(false)
            })
            .collect();

        let missing = in_bin.is_empty();
        let spend = if missing { None } else { sum_or_none(in_bin.iter().map(|r| r["cost_micro"].as_i64())) };
        let input = if missing { None } else { sum_or_none(in_bin.iter().map(|r| r["input_tokens"].as_i64())) };
        let output = if missing { None } else { sum_or_none(in_bin.iter().map(|r| r["output_tokens"].as_i64())) };

        total_spend += spend.unwrap_or(0);
        total_input += input.unwrap_or(0);
        total_output += output.unwrap_or(0);

        bins.push(json!({
            "start": format_time(bin_start),
            "end": format_time(bin_end.min(axis_end)),
            "spend_micro": spend,
            "input_tokens": input,
            "output_tokens": output,
            "partial": bin_end > req.now,
            "missing": missing,
        }));
    }

    json!({
        "metric": req.metric,
        "scale": req.scale,
        "period_start": format_time(start),
        "period_end": format_time(axis_end),
        "bins": bins,
        "total_spend_micro": total_spend,
        "total_input_tokens": total_input,
        "total_output_tokens": total_output,
        "axis": req.axis,
        "sample": req.sample,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bin_widths_match_the_typescript_table() {
        assert_eq!(bin_ms("10m"), MINUTE);
        assert_eq!(bin_ms("1h"), 5 * MINUTE);
        assert_eq!(bin_ms("3h"), 15 * MINUTE);
        assert_eq!(bin_ms("6h"), 30 * MINUTE);
        assert_eq!(bin_ms("24h"), HOUR);
    }

    #[test]
    fn a_range_produces_the_expected_number_of_bins() {
        let now = 1_760_000_000_000;
        let chart = build_chart(&ChartRequest {
            metric: "spend".into(),
            scale: "24h".into(),
            anchor: now,
            axis: "log".into(),
            requests: &[],
            collection_ranges: &[],
            sample: true,
            now,
        });
        // 24 hours at one-hour bins, plus the partial bin the aligned start
        // adds. The TypeScript buildPeriod produces the same 25 for this anchor.
        assert_eq!(chart["bins"].as_array().unwrap().len(), 25);
    }

    #[test]
    fn future_bins_are_not_drawn() {
        let now = 1_760_000_000_000;
        // Anchor in the future: the axis must stop at now, not at the anchor.
        let chart = build_chart(&ChartRequest {
            metric: "spend".into(),
            scale: "1h".into(),
            anchor: now + 3_600_000,
            axis: "log".into(),
            requests: &[],
            collection_ranges: &[],
            sample: true,
            now,
        });
        let bins = chart["bins"].as_array().unwrap();
        assert!(!bins.is_empty());
        assert!(bins.len() < 12, "future bins were drawn: {}", bins.len());
    }
}
