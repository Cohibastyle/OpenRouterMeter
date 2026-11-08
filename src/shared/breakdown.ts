/**
 * Grouping usage rows into a breakdown.
 *
 * The public API does not expose individual generations. `/analytics/query`
 * returns aggregates per bucket, and the per-generation list on openrouter.ai is
 * served by an internal endpoint. The Requests tab therefore shows a breakdown
 * of the same aggregates the charts use, grouped by model or key, rather than
 * pretending to list individual requests.
 *
 * Grouping must respect the granularity rule: the collector stores the same
 * spend at minute, hour, and day granularity over overlapping ranges, so a
 * breakdown sums one granularity only.
 */

import { selectGranularity, type CollectionRange } from './granularity.js';
import { sumMicroOrNull } from './money.js';
import { buildPeriod, clippedBinInterval, inHalfOpenRange, type ChartScale } from './chart.js';

export type BreakdownGroupBy = 'model' | 'key';

export interface BreakdownInput {
  event_time: string;
  source: string;
  model: string | null;
  key_id: string | null;
  key_name: string | null;
  cost_micro: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
}

export interface BreakdownRow {
  /** Stable identifier for the group, safe to use as a React-style key. */
  id: string;
  /** Display label, never secret material. */
  label: string;
  spend_micro: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  /** Number of source buckets that contributed, not a request count. */
  bucket_count: number;
  /** Newest bucket time in the group. */
  latest: string | null;
}

export interface BreakdownResult {
  group_by: BreakdownGroupBy;
  rows: BreakdownRow[];
  /** Granularity used, in ms, or null when nothing could be summed. */
  granularity_ms: number | null;
  /** True when the period could not be covered by any single granularity. */
  incomplete: boolean;
}

const UNKNOWN_LABEL = 'Unknown';

function groupKeyOf(row: BreakdownInput, groupBy: BreakdownGroupBy): { id: string; label: string } {
  if (groupBy === 'model') {
    const model = row.model?.trim();
    return model ? { id: `model:${model}`, label: model } : { id: 'model:unknown', label: UNKNOWN_LABEL };
  }
  // Prefer the display name; fall back to the id, which is a key hash and is
  // not secret material. Never surface a credential.
  const label = row.key_name?.trim() || row.key_id?.trim();
  return label ? { id: `key:${row.key_id ?? label}`, label } : { id: 'key:unknown', label: UNKNOWN_LABEL };
}

/**
 * Build a breakdown for the trailing window `scale` ending at `anchor`.
 *
 * The rows are selected exactly the way the chart selects them: one granularity
 * per bin, clipped to the trailing window. A single granularity for the whole
 * window dropped the current partial bin's minute rows whenever hour rows also
 * covered the range, so the table's total drifted from the interval buttons —
 * which sum the same bins the chart draws.
 *
 * @param rows Every stored usage row, at any granularity.
 * @param ranges The recorded fetch range per granularity.
 * @param now Evaluation instant; defaults to the clock. Tests freeze this.
 */
export function buildBreakdown(
  rows: ReadonlyArray<BreakdownInput>,
  scale: ChartScale,
  anchor: number,
  groupBy: BreakdownGroupBy,
  ranges: ReadonlyArray<CollectionRange> = [],
  now: number = anchor,
): BreakdownResult {
  const period = buildPeriod(scale, anchor, 'monday');
  const axisEnd = Math.min(period.end, now);

  const groups = new Map<string, BreakdownInput[]>();
  let anyRow = false;

  for (const bin of period.bins) {
    if (bin.start >= axisEnd) continue;
    const clip = clippedBinInterval(bin.start, bin.end, period.start, axisEnd);
    if (!clip) continue;
    // One granularity per bin — the same choice buildChart makes for the same
    // bin, so the table and the bars cannot disagree. Overlap is enough, for
    // the same reason it is in the chart.
    const choice = selectGranularity(rows, clip.start, clip.end, bin.end - bin.start, ranges, true);
    for (const row of choice.rows) {
      const t = new Date(row.event_time).getTime();
      if (Number.isNaN(t) || !inHalfOpenRange(t, clip.start, clip.end)) continue;
      anyRow = true;
      const { id } = groupKeyOf(row, groupBy);
      const bucket = groups.get(id);
      if (bucket) bucket.push(row);
      else groups.set(id, [row]);
    }
  }

  if (!anyRow) {
    return { group_by: groupBy, rows: [], granularity_ms: null, incomplete: true };
  }

  const out: BreakdownRow[] = [];
  for (const [id, bucket] of groups) {
    const { label } = groupKeyOf(bucket[0]!, groupBy);
    let latest: string | null = null;
    for (const row of bucket) {
      if (!latest || new Date(row.event_time).getTime() > new Date(latest).getTime()) {
        latest = row.event_time;
      }
    }
    out.push({
      id,
      label,
      spend_micro: sumMicroOrNull(bucket.map((r) => r.cost_micro)),
      input_tokens: sumMicroOrNull(bucket.map((r) => r.input_tokens)),
      output_tokens: sumMicroOrNull(bucket.map((r) => r.output_tokens)),
      total_tokens: sumMicroOrNull(bucket.map((r) => r.total_tokens)),
      bucket_count: bucket.length,
      latest,
    });
  }

  // Largest spend first, then largest token count, so the interesting rows lead.
  out.sort((a, b) => {
    const spend = (b.spend_micro ?? 0) - (a.spend_micro ?? 0);
    if (spend !== 0) return spend;
    return (b.total_tokens ?? 0) - (a.total_tokens ?? 0);
  });

  // Bins can mix granularities (minute rows for the current partial bin, hour
  // rows for older ones), so no single granularity names the table.
  return { group_by: groupBy, rows: out, granularity_ms: null, incomplete: false };
}
