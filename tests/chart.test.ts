import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildChart,
  buildPeriod,
  clippedBinInterval,
  inHalfOpenRange,
  CHART_BIN_MS,
} from '../src/shared/chart.ts';
import { computeWindows } from '../src/shared/windows.ts';
import type { CollectionRange } from '../src/shared/granularity.ts';
import type { RequestRecord } from '../src/shared/types.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

function request(eventTime: number, costMicro: number, tokens = 1000, source = 'test'): RequestRecord {
  return {
    id: `r${eventTime}:${source}`,
    event_time: new Date(eventTime).toISOString(),
    received_time: new Date(eventTime).toISOString(),
    key_id: 'k1',
    key_name: 'prod-key',
    model: 'test/model',
    status: 'success',
    input_tokens: Math.round(tokens * 0.7),
    output_tokens: Math.round(tokens * 0.3),
    total_tokens: tokens,
    cost_micro: costMicro,
    request_count: 1,
    source,
  };
}

function chartRequest(rows: RequestRecord[], scale: '10m' | '1h' | '3h' | '6h' | '24h' = '24h') {
  return {
    metric: 'spend' as const,
    scale,
    anchor: NOW,
    timeZone: 'UTC',
    weekStart: 'monday' as const,
    requests: rows,
    sample: false,
    now: NOW,
  };
}

test('membership is half-open on the bucket start', () => {
  assert.equal(inHalfOpenRange(100, 100, 200), true);
  assert.equal(inHalfOpenRange(200, 100, 200), false);
  assert.equal(inHalfOpenRange(99, 100, 200), false);
});

test('a leading aligned bin is clipped to the trailing window', () => {
  const period = buildPeriod('24h', NOW, 'monday');
  const first = period.bins[0]!;
  assert.ok(first.start < period.start, 'alignment reaches before the window');
  const clip = clippedBinInterval(first.start, first.end, period.start, period.end);
  assert.ok(clip);
  assert.equal(clip.start, period.start);
  assert.equal(clip.end, first.end);
});

test('spend before the window is not counted even when it sits in the first bin', () => {
  const period = buildPeriod('24h', NOW, 'monday');
  const first = period.bins[0]!;
  const rows = [
    request(first.start, 9_000_000),
    request(period.start, 1_000_000),
  ];
  const chart = buildChart(chartRequest(rows, '24h'));
  assert.equal(chart.total_spend_micro, 1_000_000);
});

test('the current bin keeps its full bucket end so width can follow the clock', () => {
  const chart = buildChart(chartRequest([], '10m'));
  const last = chart.bins[chart.bins.length - 1]!;
  assert.ok(new Date(last.end).getTime() > NOW, 'end is the nominal bucket, not the fetch instant');
  assert.equal(last.partial, true);
});

test('the selected window and the chart bars are the same spend', () => {
  const rows = [
    request(NOW - 5 * MINUTE, 400_000),
    request(NOW - 2 * HOUR, 1_200_000),
    request(NOW - 20 * HOUR, 3_000_000),
  ];
  const windows = computeWindows({
    now: NOW,
    requests: rows,
    sourceGranularityMs: MINUTE,
    collectionStartedAt: NOW - 400 * DAY,
    gaps: [],
    retentionHorizon: NOW - 90 * DAY,
    stale: false,
  });
  for (const scale of ['10m', '1h', '3h', '6h', '24h'] as const) {
    const chart = buildChart(chartRequest(rows, scale));
    const cell = windows.find((w) => w.key === scale)!;
    const barSum = chart.bins.reduce((sum, bin) => sum + (bin.spend_micro ?? 0), 0);
    assert.equal(cell.spend_micro, chart.total_spend_micro, `${scale} window vs chart total`);
    assert.equal(cell.spend_micro, barSum, `${scale} window vs bar sum`);
  }
});

test('a 24h total includes the current hour of minute rows', () => {
  const ranges: CollectionRange[] = [
    {
      granularity_ms: MINUTE,
      range_start: new Date(NOW - 2 * HOUR).toISOString(),
      range_end: new Date(NOW).toISOString(),
    },
    {
      granularity_ms: HOUR,
      range_start: new Date(NOW - DAY).toISOString(),
      range_end: new Date(NOW).toISOString(),
    },
  ];
  const rows = [
    request(NOW - 5 * MINUTE, 500_000, 100, 'openrouter.analytics.minute'),
    request(NOW - 5 * HOUR, 1_000_000, 200, 'openrouter.analytics.hour'),
  ];
  const windows = computeWindows({
    now: NOW,
    requests: rows,
    sourceGranularityMs: MINUTE,
    collectionStartedAt: NOW - 400 * DAY,
    gaps: [],
    retentionHorizon: NOW - 90 * DAY,
    stale: false,
    collectionRanges: ranges,
  });
  const chart = buildChart({ ...chartRequest(rows, '24h'), collectionRanges: ranges });
  const day = windows.find((w) => w.key === '24h')!;
  assert.equal(day.spend_micro, 1_500_000);
  assert.equal(chart.total_spend_micro, 1_500_000);
  assert.equal(CHART_BIN_MS['24h'], HOUR);
});
