import { buildChart } from './chart.js';
import { WINDOWS } from './constants.js';
import { sumIntOrNull, sumMicroOrNull } from './money.js';
import type { CollectionRange } from './granularity.js';
import type {
  Coverage,
  CoverageInfo,
  PartialReason,
  RequestRecord,
  WindowCell,
  WindowKey,
} from './types.js';

export interface WindowInputs {
  now: number;
  requests: ReadonlyArray<RequestRecord>;
  /** Finest granularity the source can supply, in ms. */
  sourceGranularityMs: number;
  /** When collection first started, epoch ms. */
  collectionStartedAt: number | null;
  /** Known gaps as [start, end] epoch ms pairs. */
  gaps: ReadonlyArray<[number, number]>;
  /** Retention horizon, epoch ms. Records older than this are gone. */
  retentionHorizon: number | null;
  /** True when the last successful collection is older than the stale threshold. */
  stale: boolean;
  /** Ranges each granularity was actually fetched for. */
  collectionRanges?: ReadonlyArray<CollectionRange>;
}

/**
 * Compute the five trailing windows from FSD section 10.3.
 *
 * Windows are trailing and overlapping. They are never summed. A window is
 * computable only when the finest source granularity is at most one quarter of
 * the window width; otherwise it is unavailable with reason source_granularity
 * and is never interpolated.
 */
export function computeWindows(inputs: WindowInputs): WindowCell[] {
  const asOf = new Date(inputs.now).toISOString();
  return WINDOWS.map((w) => {
    const windowStart = inputs.now - w.ms;
    const windowEnd = inputs.now;

    const base: WindowCell = {
      key: w.key,
      label: w.label,
      window_start: new Date(windowStart).toISOString(),
      window_end: new Date(windowEnd).toISOString(),
      spend_micro: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      request_count: null,
      coverage: 'unavailable',
      partial_reason: null,
      as_of: asOf,
    };

    // Granularity gate: the finest source must be at most the window width.
    // The chart handles per-bin granularity selection, so a coarser source
    // simply produces missing bins rather than an unavailable window.
    if (inputs.sourceGranularityMs > w.ms) {
      return { ...base, coverage: 'unavailable', partial_reason: 'source_granularity' };
    }

    // Sum the same bins the chart draws for this range. One granularity per
    // bin, clipped to the trailing window, so the interval button, the headline,
    // and the bars are the same number. A single granularity for the whole
    // window dropped the current partial bin's minute rows whenever hour rows
    // "covered" the range, which is why the buttons and the big number drifted.
    const chart = buildChart({
      metric: 'spend',
      scale: w.key,
      anchor: inputs.now,
      timeZone: 'UTC',
      weekStart: 'monday',
      collectionRanges: inputs.collectionRanges ?? [],
      requests: inputs.requests,
      sample: false,
      now: inputs.now,
    });
    const spend = sumMicroOrNull(chart.bins.map((b) => b.spend_micro));
    const input = sumIntOrNull(chart.bins.map((b) => b.input_tokens));
    const output = sumIntOrNull(chart.bins.map((b) => b.output_tokens));
    const total = sumIntOrNull(chart.bins.map((b) => b.total_tokens));
    const requests = sumIntOrNull(chart.bins.map((b) => b.request_count));

    const reason = partialReasonFor(windowStart, inputs);
    const coverage: Coverage = reason ? 'partial' : 'full';

    return {
      ...base,
      spend_micro: spend,
      input_tokens: input,
      output_tokens: output,
      total_tokens: total,
      request_count: requests,
      coverage,
      partial_reason: reason,
    };
  });
}

function partialReasonFor(windowStart: number, inputs: WindowInputs): PartialReason | null {
  if (inputs.collectionStartedAt !== null && inputs.collectionStartedAt > windowStart) {
    return 'collection_started_later';
  }
  for (const [gapStart, gapEnd] of inputs.gaps) {
    if (gapStart < inputs.now && gapEnd > windowStart) return 'gap';
  }
  if (inputs.retentionHorizon !== null && windowStart < inputs.retentionHorizon) {
    return 'retention';
  }
  return null;
}

export function emptyCoverage(): CoverageInfo {
  return {
    earliest_reliable: null,
    latest_source_date: null,
    spend: 'unavailable',
    tokens: 'unavailable',
    requests: 'unavailable',
    request_source: 'unavailable',
    warnings: [],
  };
}

export function windowByKey(cells: ReadonlyArray<WindowCell>, key: WindowKey): WindowCell | undefined {
  return cells.find((c) => c.key === key);
}

/** Value of a cell for the selected metric, or null when not computable. */
export function cellValue(cell: WindowCell, metric: 'spend' | 'tokens'): number | null {
  if (cell.coverage === 'unavailable') return null;
  return metric === 'spend' ? cell.spend_micro : cell.total_tokens;
}
