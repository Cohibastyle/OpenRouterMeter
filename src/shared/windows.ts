import { WINDOWS } from './constants.js';
import { sumIntOrNull, sumMicroOrNull } from './money.js';
import { selectGranularity, type CollectionRange } from './granularity.js';
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

    // Granularity gate: the finest source must be at most a quarter of the window.
    if (inputs.sourceGranularityMs > w.ms / 4) {
      return { ...base, coverage: 'unavailable', partial_reason: 'source_granularity' };
    }

    // Sum one granularity only. The collector stores the same spend at minute,
    // hour, and day granularity over overlapping ranges, so summing every row
    // would count the same money two or three times. When no row declares a
    // granularity, every row is used, which keeps fixture and sample data
    // working.
    // A granularity coarser than the window cannot resolve it, so the window
    // size is the ceiling. The quarter rule above is the separate question of
    // whether the source is fine enough to be worth showing at all.
    const choice = selectGranularity(
      inputs.requests,
      windowStart,
      windowEnd,
      w.ms,
      inputs.collectionRanges ?? [],
    );
    const source = choice.granularityMs === null ? inputs.requests : choice.rows;
    const inWindow = source.filter((r) => {
      const t = new Date(r.event_time).getTime();
      return t > windowStart && t <= windowEnd;
    });

    const spend = sumMicroOrNull(inWindow.map((r) => r.cost_micro));
    const input = sumIntOrNull(inWindow.map((r) => r.input_tokens));
    const output = sumIntOrNull(inWindow.map((r) => r.output_tokens));
    const total = sumIntOrNull(inWindow.map((r) => r.total_tokens));

    const reason = partialReasonFor(windowStart, inputs);
    const coverage: Coverage = reason ? 'partial' : 'full';

    return {
      ...base,
      spend_micro: spend,
      input_tokens: input,
      output_tokens: output,
      total_tokens: total,
      request_count: inWindow.length,
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
