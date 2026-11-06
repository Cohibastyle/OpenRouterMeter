import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  granularityOfSource,
  rowsAtGranularity,
  selectGranularity,
  type CollectionRange,
} from '../src/shared/granularity.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const row = (t: number, source: string) => ({ event_time: new Date(t).toISOString(), source });

test('granularityOfSource reads the suffix the collector writes', () => {
  assert.equal(granularityOfSource('openrouter.analytics.minute'), MINUTE);
  assert.equal(granularityOfSource('openrouter.analytics.hour'), HOUR);
  assert.equal(granularityOfSource('openrouter.analytics.day'), DAY);
  assert.equal(granularityOfSource('openrouter.activity'), null);
  assert.equal(granularityOfSource('sample'), null);
});

test('overlapping granularities are never summed together', () => {
  // The same hour is stored three times: once as minute rows, once as an hour
  // row, and once inside a day row. Summing all of them triple-counts.
  const now = new Date(2026, 10, 6, 12, 0, 0).getTime();
  const rows = [
    row(now - 30 * MINUTE, 'openrouter.analytics.minute'),
    row(now - 20 * MINUTE, 'openrouter.analytics.minute'),
    row(now - 2 * HOUR, 'openrouter.analytics.hour'),
    row(now - 5 * HOUR, 'openrouter.analytics.day'),
  ];
  const ranges: CollectionRange[] = [
    { granularity_ms: MINUTE, range_start: new Date(now - 2 * HOUR).toISOString(), range_end: new Date(now).toISOString() },
    { granularity_ms: HOUR, range_start: new Date(now - 24 * HOUR).toISOString(), range_end: new Date(now).toISOString() },
    { granularity_ms: DAY, range_start: new Date(now - 30 * DAY).toISOString(), range_end: new Date(now).toISOString() },
  ];

  const tenMin = selectGranularity(rows, now - 10 * MINUTE, now, 10 * MINUTE, ranges);
  assert.equal(tenMin.granularityMs, MINUTE);
  assert.equal(tenMin.rows.length, 2);

  const sixHour = selectGranularity(rows, now - 6 * HOUR, now, 6 * HOUR, ranges);
  assert.equal(sixHour.granularityMs, HOUR, 'a 6h window must not use minute rows');
  assert.equal(sixHour.rows.length, 1);
});

test('a granularity coarser than the window is never chosen', () => {
  const now = new Date(2026, 10, 6, 12, 0, 0).getTime();
  const rows = [row(now - 5 * HOUR, 'openrouter.analytics.day')];
  const ranges: CollectionRange[] = [
    { granularity_ms: DAY, range_start: new Date(now - 30 * DAY).toISOString(), range_end: new Date(now).toISOString() },
  ];
  // A 3h window cannot be resolved by day buckets.
  const choice = selectGranularity(rows, now - 3 * HOUR, now, 3 * HOUR, ranges);
  assert.equal(choice.granularityMs, null);
  assert.equal(choice.rows.length, 0);
});

test('a recorded range proves coverage even when a bucket has no rows', () => {
  // An hour with no activity produces no row. That means zero spend, not
  // missing data, so the recorded range must be what decides coverage.
  const now = new Date(2026, 10, 6, 12, 0, 0).getTime();
  const rows = [row(now - 20 * HOUR, 'openrouter.analytics.hour')];
  const ranges: CollectionRange[] = [
    { granularity_ms: HOUR, range_start: new Date(now - 24 * HOUR).toISOString(), range_end: new Date(now).toISOString() },
  ];
  const choice = selectGranularity(rows, now - 24 * HOUR, now, 24 * HOUR, ranges);
  assert.equal(choice.granularityMs, HOUR);
});

test('a range that does not reach back far enough is rejected', () => {
  const now = new Date(2026, 10, 6, 12, 0, 0).getTime();
  const rows = [row(now - 30 * MINUTE, 'openrouter.analytics.minute')];
  const ranges: CollectionRange[] = [
    { granularity_ms: MINUTE, range_start: new Date(now - 2 * HOUR).toISOString(), range_end: new Date(now).toISOString() },
  ];
  // Minute rows only cover two hours, so a 24h window cannot use them.
  const choice = selectGranularity(rows, now - 24 * HOUR, now, 24 * HOUR, ranges);
  assert.equal(choice.granularityMs, null);
});

test('rows with no declared granularity are used only as a fallback', () => {
  const now = new Date(2026, 10, 6, 12, 0, 0).getTime();
  const rows = [row(now - 5 * MINUTE, 'sample'), row(now - 4 * MINUTE, 'test')];
  const choice = selectGranularity(rows, now - 10 * MINUTE, now, 10 * MINUTE, []);
  assert.equal(choice.granularityMs, 0);
  assert.equal(choice.rows.length, 2);
});

test('rowsAtGranularity filters to exactly one bucket width', () => {
  const now = Date.now();
  const rows = [
    row(now, 'openrouter.analytics.minute'),
    row(now, 'openrouter.analytics.hour'),
    row(now, 'openrouter.analytics.day'),
  ];
  assert.equal(rowsAtGranularity(rows, HOUR).length, 1);
  assert.equal(rowsAtGranularity(rows, MINUTE).length, 1);
});
