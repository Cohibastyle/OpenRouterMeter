import type { ChartBin, ChartData, Metric, RequestRecord, WindowKey } from './types.js';
import { sumIntOrNull, sumMicro } from './money.js';
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
 * minute rows for the two shortest ranges, hour rows for the three longer
 * ones. A bin finer than an hour cannot represent hour-granularity data — the
 * row cannot be split across bins — so the 3h and 6h ranges use hour bins;
 * their recent bins still read the finer minute rows.
 */
export const CHART_BIN_MS: Record<ChartScale, number> = {
  '10m': CHART_MINUTE_MS,
  '1h': 5 * CHART_MINUTE_MS,
  '3h': CHART_HOUR_MS,
  '6h': CHART_HOUR_MS,
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
  /** Ranges each granularity was fetched for, so coverage is not guessed. */
  collectionRanges?: ReadonlyArray<CollectionRange>;
  requests: ReadonlyArray<RequestRecord>;
  sample: boolean;
  /** Evaluation instant; defaults to the clock. Tests freeze this. */
  now?: number;
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
  // The time axis is linear, so equal spans of time get equal widths. Bins are
  // aligned down to a bin boundary so bars are stable as time moves.
  const firstBin = Math.floor(start / binMs) * binMs;
  for (let t = firstBin; t < end; t += binMs) {
    bins.push({ start: t, end: t + binMs });
  }
  return { start, end, bins };
}

/**
 * Half-open membership used by both the trailing windows and the chart bins.
 *
 * Analytics rows are bucket starts, so a row at `start` belongs to this interval
 * and a row at `end` belongs to the next one. The same rule on every consumer is
 * what makes the selected interval, the headline, and the chart bars add up.
 */
export function inHalfOpenRange(t: number, start: number, end: number): boolean {
  return t >= start && t < end;
}

/**
 * Intersection of a bin with the trailing window, or null when they miss.
 *
 * Bins are aligned to a grid that can start before the window, so without this
 * clip the first bar would count spend the interval button does not include.
 */
export function clippedBinInterval(
  binStart: number,
  binEnd: number,
  periodStart: number,
  periodEnd: number,
): { start: number; end: number } | null {
  const start = Math.max(binStart, periodStart);
  const end = Math.min(binEnd, periodEnd);
  if (end <= start) return null;
  return { start, end };
}

export function buildChart(request: ChartRequest): ChartData {
  const period = buildPeriod(request.scale, request.anchor, request.weekStart);
  const now = request.now ?? Date.now();
  // The right edge of the axis is the current time for the current period and
  // the period end for a past period. It is never in the future.
  const axisEnd = Math.min(period.end, now);

  const bins: ChartBin[] = period.bins
    // A bin that has not started yet is not data; drawing it would pile every
    // future bin onto the right edge of the time axis.
    .filter((bin) => bin.start < axisEnd)
    .map((bin) => {
      const clip = clippedBinInterval(bin.start, bin.end, period.start, axisEnd);
      // Keep the nominal bucket end, even when it is still in the future, so a
      // live chart can grow the current bar to `now` between fetches instead of
      // freezing the width at whatever instant this payload was built.
      if (!clip) {
        return {
          start: new Date(bin.start).toISOString(),
          end: new Date(bin.end).toISOString(),
          spend_micro: null,
          input_tokens: null,
          output_tokens: null,
          total_tokens: null,
          request_count: null,
          partial: bin.end > now,
          missing: true,
        };
      }
      // One granularity per bin. Summing every row would count the same spend
      // at minute, hour, and day granularity. The current partial bin therefore
      // reads minute rows when they cover it, while older bins keep hour rows —
      // which is also how the interval buttons are summed, so the totals match.
      // A bin at the trailing edge of a granularity's recorded range still
      // holds real rows, so overlap is enough — dropping them made a wider
      // window total less than a narrower one.
      const choice = selectGranularity(
        request.requests,
        clip.start,
        clip.end,
        bin.end - bin.start,
        request.collectionRanges ?? [],
        true,
      );
      const inBin = choice.rows.filter((r) => {
        const t = new Date(r.event_time).getTime();
        return inHalfOpenRange(t, clip.start, clip.end);
      });
      const partial = bin.end > now;
      const missing = inBin.length === 0;
      return {
        start: new Date(bin.start).toISOString(),
        end: new Date(bin.end).toISOString(),
        spend_micro: missing ? null : sumMicro(inBin.map((r) => r.cost_micro)),
        input_tokens: missing ? null : sumMicro(inBin.map((r) => r.input_tokens)),
        output_tokens: missing ? null : sumMicro(inBin.map((r) => r.output_tokens)),
        total_tokens: missing ? null : sumIntOrNull(inBin.map((r) => r.total_tokens)),
        request_count: missing ? null : sumIntOrNull(inBin.map((r) => r.request_count)),
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
    sample: request.sample,
  };
}

/**
 * Nominal bin width in ms, the finest bucket the range can resolve. The most common
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
