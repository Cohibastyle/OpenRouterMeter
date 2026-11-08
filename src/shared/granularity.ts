/**
 * Choosing one granularity per query.
 *
 * The collector stores the same spend at several granularities: minute rows for
 * the last two hours, hour rows for the last day, and day rows for the last
 * month. Those ranges overlap, so summing every row counts the same money two
 * or three times. Measured on a live account, a 24-hour total came out at
 * $3.28 when the true figure was $1.11.
 *
 * Every consumer therefore picks exactly one granularity per period and sums
 * only those rows. The finest granularity that both fits the period and covers
 * it wins, so a 10-minute window reads minute rows while a 30-day chart reads
 * day rows.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Bucket width implied by a request row's source, or null when unknown. */
export function granularityOfSource(source: string): number | null {
  if (source.endsWith('.minute')) return MINUTE;
  if (source.endsWith('.hour')) return HOUR;
  if (source.endsWith('.day')) return DAY;
  return null;
}

export interface GranularityChoice<T> {
  /** Bucket width in ms, or null when no granularity can answer the period. */
  granularityMs: number | null;
  /** Rows belonging to the chosen granularity only. */
  rows: ReadonlyArray<T>;
}

/** The range a granularity was actually fetched for. */
export interface CollectionRange {
  granularity_ms: number;
  range_start: string;
  range_end: string;
}

/**
 * Pick the finest granularity that covers `[start, end)` and is no coarser than
 * `maxGranularityMs`.
 *
 * "Covers" means the rows of that granularity span the whole period. A
 * granularity that only reaches back two hours cannot answer a 24-hour window
 * even though its rows fall inside it, because the earlier part of the window
 * would be silently missing.
 *
 * `overlapOk` relaxes "covers" for the chart's bins: a granularity qualifies
 * when its recorded range covers the whole period (zero usage is real data),
 * or when it overlaps the period *and* has at least one row inside it. A bin
 * at the trailing edge of the minute range still holds real rows — dropping
 * them made a wider window total less than a narrower one (6h < 3h). Requiring
 * a row in the partial case stops an empty edge bin from claiming the period
 * while a coarser row for the same span goes uncounted.
 */
export function selectGranularity<T extends { event_time: string; source: string }>(
  rows: ReadonlyArray<T>,
  start: number,
  end: number,
  maxGranularityMs = Number.POSITIVE_INFINITY,
  ranges: ReadonlyArray<CollectionRange> = [],
  overlapOk = false,
): GranularityChoice<T> {
  const byGranularity = new Map<number, T[]>();
  // Rows whose source names no granularity (sample data, fixtures, a future
  // collector) form one group. They are only used when no known granularity
  // covers the period, so they can never be mixed into a real total.
  const unknown: T[] = [];
  for (const row of rows) {
    const g = granularityOfSource(row.source);
    if (g === null) {
      unknown.push(row);
      continue;
    }
    const bucket = byGranularity.get(g);
    if (bucket) bucket.push(row);
    else byGranularity.set(g, [row]);
  }

  const candidates = [...byGranularity.keys()]
    .filter((g) => g <= maxGranularityMs)
    .sort((a, b) => a - b);

  const rangeFor = (g: number): { start: number; end: number } | null => {
    const found = ranges.find((r) => r.granularity_ms === g);
    if (!found) return null;
    const s = new Date(found.range_start).getTime();
    const e = new Date(found.range_end).getTime();
    return Number.isNaN(s) || Number.isNaN(e) ? null : { start: s, end: e };
  };

  for (const g of candidates) {
    const bucket = byGranularity.get(g)!;
    // Prefer the recorded fetch range. Rows alone cannot prove coverage: an
    // hour with no activity produces no row, which means zero spend rather
    // than missing data.
    const recorded = rangeFor(g);
    if (recorded) {
      const full = recorded.start <= start + g && recorded.end >= end - 2 * g;
      if (!overlapOk) {
        if (full) {
          return { granularityMs: g, rows: bucket };
        }
        continue;
      }
      // Overlap mode (chart bins): real rows always win. A granularity with
      // rows inside the period qualifies; full recorded coverage with no rows
      // inside qualifies only when no granularity has rows there — an empty
      // bin is zero usage, but a coarser row proves the fine fetch missed data
      // and must not be shadowed by it.
      const hasRowsInside = (rs: ReadonlyArray<T>) =>
        rs.some((row) => {
          const t = new Date(row.event_time).getTime();
          return !Number.isNaN(t) && t >= start && t < end;
        });
      if (hasRowsInside(bucket)) {
        return { granularityMs: g, rows: bucket };
      }
      const anyRowsInside = [...byGranularity.values()].some(hasRowsInside);
      if (full && !anyRowsInside) {
        return { granularityMs: g, rows: bucket };
      }
      continue;
    }
    // No recorded range: fall back to the span of the rows themselves.
    let earliest = Number.POSITIVE_INFINITY;
    let latest = Number.NEGATIVE_INFINITY;
    for (const row of bucket) {
      const t = new Date(row.event_time).getTime();
      if (Number.isNaN(t)) continue;
      if (t < earliest) earliest = t;
      if (t > latest) latest = t;
    }
    const covers = overlapOk
      ? earliest < end && latest >= start
      : earliest <= start + g && latest >= end - 2 * g;
    if (covers) {
      return { granularityMs: g, rows: bucket };
    }
  }

  if (unknown.length > 0) return { granularityMs: 0, rows: unknown };
  return { granularityMs: null, rows: [] };
}

/** Rows of exactly one granularity, for callers that already know which. */
export function rowsAtGranularity<T extends { source: string }>(
  rows: ReadonlyArray<T>,
  granularityMs: number,
): T[] {
  return rows.filter((row) => granularityOfSource(row.source) === granularityMs);
}
