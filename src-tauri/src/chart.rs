//! Chart binning, ported from src/shared/chart.ts.
//!
//! Ranges are rolling windows ending at the anchor, not calendar periods, so the
//! chart covers exactly the range the button names. Each bin sums one
//! granularity only, for the same reason the windows do.

use serde_json::{json, Value};

use crate::accounting::{
    clipped_bin_interval, format_time, in_half_open_range, parse_time, select_granularity,
    sum_or_none, trailing_window_bins,
};

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
    let (start, end, period_bins) = trailing_window_bins(&req.scale, req.anchor);

    // The right edge is the current time for the current period and the period
    // end for a past period. It is never in the future.
    let axis_end = end.min(req.now);

    let mut bins = Vec::new();
    let mut total_spend = 0i64;
    let mut total_input = 0i64;
    let mut total_output = 0i64;

    for (bin_start, bin_end) in period_bins {
        // A bin that has not started yet is not data; drawing it would pile
        // every future bin onto the right edge of the axis.
        if bin_start >= axis_end {
            continue;
        }

        let Some((lo, hi)) = clipped_bin_interval(bin_start, bin_end, start, axis_end) else {
            bins.push(json!({
                "start": format_time(bin_start),
                "end": format_time(bin_end),
                "spend_micro": Value::Null,
                "input_tokens": Value::Null,
                "output_tokens": Value::Null,
                "total_tokens": Value::Null,
                "request_count": Value::Null,
                "partial": bin_end > req.now,
                "missing": true,
            }));
            continue;
        };
        let choice = select_granularity(
            req.requests,
            lo,
            hi,
            bin_end - bin_start,
            req.collection_ranges,
            true,
        );
        let in_bin: Vec<&Value> = choice
            .rows
            .iter()
            .filter(|r| {
                r["event_time"]
                    .as_str()
                    .and_then(parse_time)
                    .map(|ts| in_half_open_range(ts, lo, hi))
                    .unwrap_or(false)
            })
            .collect();

        let missing = in_bin.is_empty();
        let spend = if missing { None } else { sum_or_none(in_bin.iter().map(|r| r["cost_micro"].as_i64())) };
        let input = if missing { None } else { sum_or_none(in_bin.iter().map(|r| r["input_tokens"].as_i64())) };
        let output = if missing { None } else { sum_or_none(in_bin.iter().map(|r| r["output_tokens"].as_i64())) };
        let total = if missing { None } else { sum_or_none(in_bin.iter().map(|r| r["total_tokens"].as_i64())) };
        let requests = if missing { None } else { sum_or_none(in_bin.iter().map(|r| r["request_count"].as_i64())) };

        total_spend += spend.unwrap_or(0);
        total_input += input.unwrap_or(0);
        total_output += output.unwrap_or(0);

        bins.push(json!({
            "start": format_time(bin_start),
            "end": format_time(bin_end),
            "spend_micro": spend,
            "input_tokens": input,
            "output_tokens": output,
            "total_tokens": total,
            "request_count": requests,
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
        assert_eq!(crate::accounting::chart_bin_ms("10m"), crate::accounting::MINUTE);
        assert_eq!(crate::accounting::chart_bin_ms("1h"), 5 * crate::accounting::MINUTE);
        assert_eq!(crate::accounting::chart_bin_ms("3h"), crate::accounting::HOUR);
        assert_eq!(crate::accounting::chart_bin_ms("6h"), crate::accounting::HOUR);
        assert_eq!(crate::accounting::chart_bin_ms("24h"), crate::accounting::HOUR);
        assert_eq!(crate::accounting::chart_range_ms("10m"), 10 * crate::accounting::MINUTE);
        assert_eq!(crate::accounting::chart_range_ms("1h"), crate::accounting::HOUR);
        assert_eq!(crate::accounting::chart_range_ms("3h"), 3 * crate::accounting::HOUR);
        assert_eq!(crate::accounting::chart_range_ms("6h"), 6 * crate::accounting::HOUR);
        assert_eq!(crate::accounting::chart_range_ms("24h"), crate::accounting::DAY);
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

    #[test]
    fn the_current_bin_keeps_its_full_end() {
        let now = 1_760_000_000_123;
        let chart = build_chart(&ChartRequest {
            metric: "spend".into(),
            scale: "10m".into(),
            anchor: now,
            axis: "log".into(),
            requests: &[],
            collection_ranges: &[],
            sample: true,
            now,
        });
        let bins = chart["bins"].as_array().unwrap();
        let last = bins.last().unwrap();
        let end = crate::accounting::parse_time(last["end"].as_str().unwrap()).unwrap();
        assert!(end > now, "end is the nominal bucket so live width can follow the clock");
        assert_eq!(last["partial"], true);
    }

    #[test]
    fn spend_before_the_window_is_clipped_out_of_the_first_bin() {
        let now = 1_760_000_000_000;
        let (start, _, bins) = crate::accounting::trailing_window_bins("24h", now);
        let first = bins[0];
        let rows = vec![
            serde_json::json!({
                "event_time": crate::accounting::format_time(first.0),
                "cost_micro": 9_000_000,
                "source": "test",
            }),
            serde_json::json!({
                "event_time": crate::accounting::format_time(start),
                "cost_micro": 1_000_000,
                "source": "test",
            }),
        ];
        let chart = build_chart(&ChartRequest {
            metric: "spend".into(),
            scale: "24h".into(),
            anchor: now,
            axis: "log".into(),
            requests: &rows,
            collection_ranges: &[],
            sample: false,
            now,
        });
        assert_eq!(chart["total_spend_micro"], 1_000_000);
    }
}
