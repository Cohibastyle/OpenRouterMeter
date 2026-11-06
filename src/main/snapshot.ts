import { SCHEMA_VERSION } from '../shared/constants.js';
import { sumMicro } from '../shared/money.js';
import { computeWindows } from '../shared/windows.js';
import { selectGranularity, type CollectionRange } from '../shared/granularity.js';
import type {
  AccountInfo,
  CollectionStatus,
  CoverageInfo,
  PeriodTotals,
  RequestRecord,
  Scope,
  Snapshot,
} from '../shared/types.js';

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
  sample: boolean;
  snapshotVersion: number;
  todaySource: Snapshot['today_source'];
  monthSource: Snapshot['month_source'];
  counterToday: Snapshot['counter_today'];
  counterMonth: Snapshot['counter_month'];
}

function startOfLocalDay(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

function startOfLocalMonth(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime();
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
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    spend_micro: spend,
    input_tokens: inRange.length === 0 ? null : input,
    output_tokens: inRange.length === 0 ? null : output,
    total_tokens: inRange.length === 0 ? null : total,
    request_count: inRange.length,
  };
}

export function buildSnapshot(inputs: SnapshotInputs): Snapshot {
  const scope = inputs.scope;
  const scoped =
    scope.kind === 'all' ? inputs.requests : inputs.requests.filter((r) => r.key_id === scope.id);

  const dayStart = startOfLocalDay(inputs.now);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const monthStart = startOfLocalMonth(inputs.now);
  const monthEnd = new Date(monthStart);
  monthEnd.setMonth(monthEnd.getMonth() + 1);

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
    today: totalsFor(scoped, dayStart, dayEnd.getTime(), inputs.collectionRanges),
    month: totalsFor(scoped, monthStart, monthEnd.getTime(), inputs.collectionRanges),
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
