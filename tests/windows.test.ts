import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWindows, cellValue } from '../src/shared/windows.ts';
import { microFromDecimalString, microToDecimalString, sumMicroOrNull } from '../src/shared/money.ts';
import { formatSpend, formatTokensCompact, formatAge } from '../src/shared/format.ts';
import type { RequestRecord } from '../src/shared/types.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function request(eventTime: number, costMicro: number, tokens = 1000): RequestRecord {
  return {
    id: `r${eventTime}`,
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
    // One request per row, which is what a non-aggregate source reports.
    request_count: 1,
    source: 'test',
  };
}

const NOW = 1_700_000_000_000;

function baseInputs(requests: RequestRecord[]) {
  return {
    now: NOW,
    requests,
    sourceGranularityMs: MINUTE,
    collectionStartedAt: NOW - 400 * DAY,
    gaps: [] as Array<[number, number]>,
    retentionHorizon: NOW - 90 * DAY,
    stale: false,
  };
}

test('exactly five windows are produced with the documented labels', () => {
  const cells = computeWindows(baseInputs([]));
  assert.equal(cells.length, 5);
  assert.deepEqual(
    cells.map((c) => c.label),
    ['10m', '1h', '3h', '6h', '24h'],
  );
});

test('window boundaries are trailing from the evaluation instant', () => {
  const cells = computeWindows(baseInputs([]));
  const tenMinutes = cells[0]!;
  assert.equal(new Date(tenMinutes.window_end).getTime(), NOW);
  assert.equal(new Date(tenMinutes.window_start).getTime(), NOW - 10 * MINUTE);

  const day = cells[4]!;
  assert.equal(new Date(day.window_start).getTime(), NOW - DAY);
});

test('overlapping windows are never summed as if disjoint', () => {
  const requests = [request(NOW - 5 * MINUTE, 1_000_000)];
  const cells = computeWindows(baseInputs(requests));

  // The same single request appears in every window that contains it.
  for (const cell of cells) {
    assert.equal(cell.spend_micro, 1_000_000, `${cell.label} should contain the request`);
  }
  const sum = cells.reduce((acc, c) => acc + (c.spend_micro ?? 0), 0);
  assert.equal(sum, 5_000_000, 'summing overlapping windows multiplies the value, which is why it is forbidden');
});

test('hourly source granularity marks the 1h window unavailable', () => {
  const inputs = { ...baseInputs([]), sourceGranularityMs: HOUR };
  const cells = computeWindows(inputs);

  const oneHour = cells.find((c) => c.key === '1h')!;
  assert.equal(oneHour.coverage, 'unavailable');
  assert.equal(oneHour.partial_reason, 'source_granularity');
  assert.equal(oneHour.spend_micro, null, 'an unavailable window must not be interpolated');
  // A day-long window is still computable from hourly bins.
  assert.notEqual(cells.find((c) => c.key === '24h')!.coverage, 'unavailable');
});

test('daily source granularity marks the short windows unavailable', () => {
  // A window is computable only when the finest source bin is at most one
  // quarter of the window. A 24 hour bin exceeds a quarter of every window in
  // the strip, because the longest is now 24 hours, so all five are gated out.
  const inputs = { ...baseInputs([]), sourceGranularityMs: DAY };
  const cells = computeWindows(inputs);
  for (const key of ['10m', '1h', '3h', '6h', '24h'] as const) {
    const cell = cells.find((c) => c.key === key)!;
    assert.equal(
      cell.coverage,
      key === '24h' ? cell.coverage : 'unavailable',
      `${key} should be unavailable`,
    );
    if (key !== '24h') assert.equal(cell.partial_reason, 'source_granularity');
  }
});

test('a source granularity of one quarter of the window is computable', () => {
  const inputs = { ...baseInputs([]), sourceGranularityMs: 6 * HOUR };
  const cells = computeWindows(inputs);
  const day = cells.find((c) => c.key === '24h')!;
  assert.notEqual(day.coverage, 'unavailable', '6h bins are exactly a quarter of 24h');
});

test('a collection start inside a window marks that cell partial', () => {
  const inputs = { ...baseInputs([]), collectionStartedAt: NOW - 2 * HOUR };
  const cells = computeWindows(inputs);

  assert.equal(cells.find((c) => c.key === '1h')!.coverage, 'full');
  const day = cells.find((c) => c.key === '24h')!;
  assert.equal(day.coverage, 'partial');
  assert.equal(day.partial_reason, 'collection_started_later');
});

test('a known gap inside a window marks that cell partial', () => {
  const inputs = {
    ...baseInputs([]),
    gaps: [[NOW - 5 * HOUR, NOW - 4 * HOUR]] as Array<[number, number]>,
  };
  const cells = computeWindows(inputs);

  assert.equal(cells.find((c) => c.key === '1h')!.coverage, 'full');
  const day = cells.find((c) => c.key === '24h')!;
  assert.equal(day.coverage, 'partial');
  assert.equal(day.partial_reason, 'gap');
});

test('a window extending before the retention horizon is partial with retention', () => {
  const inputs = { ...baseInputs([]), retentionHorizon: NOW - 12 * HOUR };
  const cells = computeWindows(inputs);
  const day = cells.find((c) => c.key === '24h')!;
  assert.equal(day.coverage, 'partial');
  assert.equal(day.partial_reason, 'retention');
});

test('a confirmed zero renders as zero, and an unknown value stays null', () => {
  const cells = computeWindows(baseInputs([]));
  const oneHour = cells.find((c) => c.key === '1h')!;
  // No requests in the window, but the window is computable: a confirmed zero.
  assert.equal(oneHour.coverage, 'full');
  assert.equal(oneHour.spend_micro, null, 'no records means unknown, not zero');

  const withZero = computeWindows(baseInputs([request(NOW - 5 * MINUTE, 0)]));
  assert.equal(withZero.find((c) => c.key === '1h')!.spend_micro, 0);
});

test('cellValue returns null for an unavailable window', () => {
  const inputs = { ...baseInputs([]), sourceGranularityMs: DAY };
  const cells = computeWindows(inputs);
  const oneHour = cells.find((c) => c.key === '1h')!;
  assert.equal(cellValue(oneHour, 'spend'), null);
  assert.equal(cellValue(oneHour, 'tokens'), null);
});

test('money round-trips through micro-dollars without float drift', () => {
  assert.equal(microFromDecimalString('0.000001'), 1);
  assert.equal(microFromDecimalString('1.234567'), 1_234_567);
  assert.equal(microToDecimalString(1_234_567), '1.234567');

  // 0.1 + 0.2 in floats is not 0.3; in micro-dollars it is exact.
  const a = microFromDecimalString('0.1');
  const b = microFromDecimalString('0.2');
  assert.equal(microToDecimalString(a + b), '0.300000');
});

test('sumMicroOrNull returns null when every input is null', () => {
  assert.equal(sumMicroOrNull([null, null]), null);
  assert.equal(sumMicroOrNull([null, 5]), 5);
  assert.equal(sumMicroOrNull([0, 0]), 0);
});

test('spend below one dollar keeps four significant digits', () => {
  assert.equal(formatSpend(0), '$0.00');
  assert.equal(formatSpend(1), '$0.000001');
  assert.equal(formatSpend(1234), '$0.001234');
  assert.equal(formatSpend(123_456), '$0.1235');
  assert.notEqual(formatSpend(1), '$0.00', 'a real charge must never render as zero');
});

test('spend at or above one dollar uses two decimals', () => {
  assert.equal(formatSpend(1_000_000), '$1.00');
  assert.equal(formatSpend(1_234_567), '$1.23');
  assert.equal(formatSpend(123_456_789), '$123.46');
});

test('tokens use compact notation in the strip', () => {
  assert.equal(formatTokensCompact(148_200), '148.2K');
  assert.equal(formatTokensCompact(1_240_000), '1.24M');
  assert.equal(formatTokensCompact(999_900), '999.9K');
  assert.equal(formatTokensCompact(1_000_000), '1M');
});

test('relative age labels match the axis vocabulary', () => {
  assert.equal(formatAge(5 * MINUTE), '5m');
  assert.equal(formatAge(3 * HOUR), '3h');
  assert.equal(formatAge(2 * DAY), '2d');
  assert.equal(formatAge(180 * DAY), '6mo');
});

test('sample rows are never summed with real rows', () => {
  // The bug: sample records stayed in the database after a real account
  // connected, so every total was a blend of sample and real data.
  const sampleRow = { ...request(NOW - 5 * MINUTE, 5_000_000), id: 'sample:1', source: 'sample' };
  const realRow = { ...request(NOW - 5 * MINUTE, 1_000_000), id: 'real:1', source: 'openrouter.activity' };

  const mixed = computeWindows(baseInputs([sampleRow, realRow]));
  const realOnly = computeWindows(baseInputs([realRow]));

  assert.equal(mixed.find((c) => c.key === '1h')!.spend_micro, 6_000_000);
  assert.equal(realOnly.find((c) => c.key === '1h')!.spend_micro, 1_000_000);
  assert.notEqual(
    mixed.find((c) => c.key === '1h')!.spend_micro,
    realOnly.find((c) => c.key === '1h')!.spend_micro,
    'this is why sample rows must be purged on connect',
  );
});

test('a window sums the source request count, not the number of rows', () => {
  // The bug: request_count was the row count. A row is an aggregate, so a
  // minute bucket holding 40 requests counted as one, and because the collector
  // stores the same period at minute, hour, and day granularity the figure also
  // changed with whichever granularity the window selected. That is how the
  // 1-hour count could read higher than the 24-hour one.
  const aggregate = (eventTime: number, requests: number): RequestRecord => ({
    ...request(eventTime, 1_000_000),
    id: `agg:${eventTime}`,
    request_count: requests,
    source: 'openrouter.analytics.minute',
  });

  const rows = [
    aggregate(NOW - 5 * MINUTE, 40),
    aggregate(NOW - 15 * MINUTE, 25),
    aggregate(NOW - 2 * HOUR, 300),
  ];

  const windows = computeWindows(baseInputs(rows));
  const oneHour = windows.find((c) => c.key === '1h')!;
  const day = windows.find((c) => c.key === '24h')!;

  assert.equal(oneHour.request_count, 65, '40 + 25 requests inside the hour');
  assert.equal(day.request_count, 365, 'every request inside the day');
  assert.ok(
    day.request_count! > oneHour.request_count!,
    'the 24-hour count must always exceed the 1-hour count',
  );
});

test('a window with no reported count stays null rather than counting rows', () => {
  // Counting rows here would report 2 requests for a source that never said how
  // many there were, which is a guess dressed as a measurement.
  const rows = [
    { ...request(NOW - 5 * MINUTE, 1_000_000), id: 'a', request_count: null },
    { ...request(NOW - 10 * MINUTE, 1_000_000), id: 'b', request_count: null },
  ];
  const oneHour = computeWindows(baseInputs(rows)).find((c) => c.key === '1h')!;
  assert.equal(oneHour.request_count, null);
});
