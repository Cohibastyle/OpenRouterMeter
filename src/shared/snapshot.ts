import { SCHEMA_VERSION } from './constants.js';
import { sumIntOrNull, sumMicro } from './money.js';
import { computeWindows } from './windows.js';
import { selectGranularity, type CollectionRange } from './granularity.js';
import type {
  AccountInfo,
  CollectionStatus,
  CoverageInfo,
  PeriodTotals,
  RequestRecord,
  Scope,
  Snapshot,
} from './types.js';

export interface SnapshotInputs {
  now: number;
  requests: ReadonlyArray<RequestRecord>;
  scope: Scope;
  account: AccountInfo;
  collectionStatus: CollectionStatus;
  coverage: CoverageInfo;
  sourceGranularityMs: number;
  collectionStartedAt: number | null;
  gaps: ReadonlyArray<[number, number]>;
  collectionRanges: ReadonlyArray<CollectionRange>;
  retentionHorizon: number | null;
  timeZone: string;
  /**
   * Force the UTC offset used for the day and month boundaries, in ms.
   *
   * Omitted, the boundaries come from the ambient zone, which is what the app
   * wants. The cross-check sets it so the fixture does not depend on where it is
   * generated: a fixture built in one zone and asserted in another disagrees on
   * `today`, which is exactly how the CI failure surfaced.
   */
  utcOffsetMs?: number;
  sample: boolean;
  snapshotVersion: number;
  todaySource: Snapshot['today_source'];
  monthSource: Snapshot['month_source'];
  counterToday: Snapshot['counter_today'];
  counterMonth: Snapshot['counter_month'];
}

/**
 * The UTC offset to use for a boundary, in ms.
 *
 * A forced offset wins so a fixture is reproducible. Otherwise the ambient zone
 * is read, which is what the app wants: the widget reports in the user's zone.
 */
function offsetFor(now: number, forced: number | undefined): number {
  if (forced !== undefined) return forced;
  return -new Date(now).getTimezoneOffset() * 60_000;
}

function startOfLocalDay(now: number, forced?: number): number {
  const offset = offsetFor(now, forced);
  const shifted = now + offset;
  const day = Math.floor(shifted / 86_400_000) * 86_400_000;
  return day - offset;
}

function startOfLocalMonth(now: number, forced?: number): number {
  const offset = offsetFor(now, forced);
  const shifted = now + offset;
  const d = new Date(shifted);
  const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return first - offset;
}

function totalsFor(
  requests: ReadonlyArray<RequestRecord>,
  start: number,
  end: number,
  ranges: ReadonlyArray<CollectionRange>,
): PeriodTotals {
  // One granularity only: the collector stores the same spend at minute, hour,
  // and day granularity over overlapping ranges.
  // The current month ends in the future, so the coverage check must compare
  // against now rather than the nominal period end.
  const effectiveEnd = Math.min(end, Date.now());
  const choice = selectGranularity(requests, start, effectiveEnd, Number.POSITIVE_INFINITY, ranges);
  const inRange = choice.rows.filter((r) => {
    const t = new Date(r.event_time).getTime();
    return t >= start && t < end;
  });
  const spend = sumMicro(inRange.map((r) => r.cost_micro));
  const input = sumMicro(inRange.map((r) => r.input_tokens));
  const output = sumMicro(inRange.map((r) => r.output_tokens));
  const total = sumMicro(inRange.map((r) => r.total_tokens));
  // The source's own count, not the row count: a row is an aggregate, so
  // counting rows undercounts and varies with the selected granularity.
  const requestCount = sumIntOrNull(inRange.map((r) => r.request_count));
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    spend_micro: spend,
    input_tokens: inRange.length === 0 ? null : input,
    output_tokens: inRange.length === 0 ? null : output,
    total_tokens: inRange.length === 0 ? null : total,
    request_count: requestCount,
  };
}

export function buildSnapshot(inputs: SnapshotInputs): Snapshot {
  const scope = inputs.scope;
  const scoped =
    scope.kind === 'all' ? inputs.requests : inputs.requests.filter((r) => r.key_id === scope.id);

  const dayStart = startOfLocalDay(inputs.now, inputs.utcOffsetMs);
  const dayEnd = dayStart + 86_400_000;
  const monthStart = startOfLocalMonth(inputs.now, inputs.utcOffsetMs);
  const monthEnd = monthStart + 31 * 86_400_000;

  const windows = computeWindows({
    now: inputs.now,
    requests: scoped,
    sourceGranularityMs: inputs.sourceGranularityMs,
    collectionStartedAt: inputs.collectionStartedAt,
    gaps: inputs.gaps,
    retentionHorizon: inputs.retentionHorizon,
    stale: inputs.collectionStatus.stale,
    collectionRanges: inputs.collectionRanges,
  });

  const latest = scoped.reduce<RequestRecord | null>((best, r) => {
    if (!best) return r;
    return new Date(r.event_time).getTime() > new Date(best.event_time).getTime() ? r : best;
  }, null);

  return {
    schema_version: SCHEMA_VERSION,
    snapshot_version: inputs.snapshotVersion,
    server_time: new Date(inputs.now).toISOString(),
    fetched_at: inputs.collectionStatus.last_success ?? new Date(inputs.now).toISOString(),
    currency: 'USD',
    time_zone: inputs.timeZone,
    scope: inputs.scope,
    today: totalsFor(scoped, dayStart, dayEnd, inputs.collectionRanges),
    month: totalsFor(scoped, monthStart, monthEnd, inputs.collectionRanges),
    today_source: inputs.todaySource,
    month_source: inputs.monthSource,
    counter_today: inputs.counterToday,
    counter_month: inputs.counterMonth,
    latest_request: latest,
    coverage: inputs.coverage,
    collection_status: inputs.collectionStatus,
    windows,
    sample: inputs.sample,
    account: inputs.account,
  };
}
