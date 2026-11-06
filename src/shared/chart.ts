import type { ChartBin, ChartData, Metric, RequestRecord, WindowKey } from './types.js';
import { sumMicro } from './money.js';
import { selectGranularity, type CollectionRange } from './granularity.js';

/**
 * Chart ranges match the five range buttons on the Spending and Tokens tabs.
 * They are rolling windows ending at the anchor, not calendar periods, so the
 * chart always covers exactly the range the button names.
 */
export type ChartScale = WindowKey;

const CHART_MINUTE_MS = 60 * 1000;
const CHART_HOUR_MS = 60 * CHART_MINUTE_MS;

/**
 * Bin width per range. Chosen so each range has a readable number of bars and
 * so the bins never get finer than the granularity the collector retains:
 * minute rows for the two shortest ranges, hour rows for the three longer ones.
 */
export const CHART_BIN_MS: Record<ChartScale, number> = {
  '10m': CHART_MINUTE_MS,
  '1h': 5 * CHART_MINUTE_MS,
  '3h': 15 * CHART_MINUTE_MS,
  '6h': 30 * CHART_MINUTE_MS,
  '24h': CHART_HOUR_MS,
};

/** Total span per range. */
export const CHART_RANGE_MS: Record<ChartScale, number> = {
  '10m': 10 * CHART_MINUTE_MS,
  '1h': 60 * CHART_MINUTE_MS,
  '3h': 3 * CHART_HOUR_MS,
  '6h': 6 * CHART_HOUR_MS,
  '24h': 24 * CHART_HOUR_MS,
};

export interface ChartRequest {
  metric: Metric;
  scale: ChartScale;
  /** Anchor instant; the period containing it is rendered. */
  anchor: number;
  timeZone: string;
  weekStart: 'monday' | 'sunday';
  axis: 'log' | 'linear';
  /** Ranges each granularity was fetched for, so coverage is not guessed. */
  collectionRanges?: ReadonlyArray<CollectionRange>;
  requests: ReadonlyArray<RequestRecord>;
  sample: boolean;
}

interface Period {
  start: number;
  end: number;
  bins: Array<{ start: number; end: number }>;
}

/**
 * Rolling period and bin boundaries for a range.
 *
 * The window ends at the anchor and reaches back by the range's span, so the
 * chart covers exactly the range the button names. Bins are aligned to the bin
 * width so a bar always represents the same interval.
 */
export function buildPeriod(scale: ChartScale, anchor: number, _weekStart: 'monday' | 'sunday'): Period {
  const span = CHART_RANGE_MS[scale];
  const binMs = CHART_BIN_MS[scale];
  const end = anchor;
  const start = end - span;

  const bins: Array<{ start: number; end: number }> = [];
  // Align the first bin down to a bin boundary so bars are stable as time moves.
  const firstBin = Math.floor(start / binMs) * binMs;
  for (let t = firstBin; t < end; t += binMs) {
    bins.push({ start: t, end: t + binMs });
  }
  return { start, end, bins };
}

export function buildChart(request: ChartRequest): ChartData {
  const period = buildPeriod(request.scale, request.anchor, request.weekStart);
  const now = Date.now();
  // The right edge of the axis is the current time for the current period and
  // the period end for a past period. It is never in the future.
  const axisEnd = Math.min(period.end, now);

  const bins: ChartBin[] = period.bins
    // A bin that has not started yet is not data; drawing it would pile every
    // future bin onto the right edge of the log axis.
    .filter((bin) => bin.start < axisEnd)
    .map((bin) => {
      // One granularity per bin. Summing every row would count the same spend
      // at minute, hour, and day granularity.
      const choice = selectGranularity(
        request.requests,
        bin.start,
        bin.end,
        bin.end - bin.start,
        request.collectionRanges ?? [],
      );
      const inBin = choice.rows.filter((r) => {
        const t = new Date(r.event_time).getTime();
        return t >= bin.start && t < bin.end;
      });
      const partial = bin.end > now;
      const missing = inBin.length === 0;
      return {
        start: new Date(bin.start).toISOString(),
        end: new Date(Math.min(bin.end, axisEnd)).toISOString(),
        spend_micro: missing ? null : sumMicro(inBin.map((r) => r.cost_micro)),
        input_tokens: missing ? null : sumMicro(inBin.map((r) => r.input_tokens)),
        output_tokens: missing ? null : sumMicro(inBin.map((r) => r.output_tokens)),
        partial,
        missing,
      };
    });

  const totalSpend = sumMicro(bins.map((b) => b.spend_micro));
  const totalInput = sumMicro(bins.map((b) => b.input_tokens));
  const totalOutput = sumMicro(bins.map((b) => b.output_tokens));

  return {
    metric: request.metric,
    scale: request.scale,
    period_start: new Date(period.start).toISOString(),
    period_end: new Date(axisEnd).toISOString(),
    bins,
    total_spend_micro: totalSpend,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    axis: request.axis,
    sample: request.sample,
  };
}

/**
 * Nominal bin width in ms, used as a_min for the log axis. The most common
 * width is used so the clamped current partial bin cannot shrink the axis.
 */
export function finestBinMs(chart: ChartData): number {
  const counts = new Map<number, number>();
  for (const bin of chart.bins) {
    const width = new Date(bin.end).getTime() - new Date(bin.start).getTime();
    if (width > 0) counts.set(width, (counts.get(width) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [width, count] of counts) {
    if (count > bestCount || (count === bestCount && width < best)) {
      best = width;
      bestCount = count;
    }
  }
  return best > 0 ? best : 1000;
}
