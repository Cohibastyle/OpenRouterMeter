import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spendSince, startOfLocalDay, startOfLocalMonth } from '../src/shared/counterSpend.js';

const at = (iso: string, micro: number) => ({ sampled_at: iso, total_usage_micro: micro });

/** An instant a given number of hours before local midnight of 6 Nov 2026. */
const beforeMidnight = (hours: number) =>
  new Date(new Date(2026, 10, 6, 0, 0, 0, 0).getTime() - hours * 3_600_000).toISOString();

/** An instant a given number of hours after local midnight of 6 Nov 2026. */
const afterMidnight = (hours: number) =>
  new Date(new Date(2026, 10, 6, 0, 0, 0, 0).getTime() + hours * 3_600_000).toISOString();

test('spendSince measures the delta across the period start', () => {
  const dayStart = new Date(2026, 10, 6, 0, 0, 0, 0).getTime();
  const baseline = beforeMidnight(4);
  const result = spendSince(
    [
      at(baseline, 212_000_000),
      at(afterMidnight(1), 212_500_000),
      at(afterMidnight(3), 213_250_000),
    ],
    dayStart,
  );
  assert.equal(result.reason, 'ok');
  assert.equal(result.exact, true);
  assert.equal(result.spend_micro, 1_250_000);
  assert.equal(result.baseline_at, baseline);
  assert.equal(result.as_of, afterMidnight(3));
});

test('spendSince uses the newest sample at or before the period start', () => {
  const dayStart = new Date(2026, 10, 6, 0, 0, 0, 0).getTime();
  const newestBefore = beforeMidnight(1);
  const result = spendSince(
    [
      at(beforeMidnight(48), 100_000_000),
      at(newestBefore, 200_000_000),
      at(afterMidnight(2), 200_400_000),
    ],
    dayStart,
  );
  assert.equal(result.spend_micro, 400_000);
  assert.equal(result.baseline_at, newestBefore);
});

test('spendSince is partial when no sample predates the period start', () => {
  const dayStart = new Date(2026, 10, 6, 0, 0, 0, 0).getTime();
  const first = afterMidnight(9);
  const result = spendSince([at(first, 500_000_000), at(afterMidnight(10), 500_120_000)], dayStart);
  assert.equal(result.reason, 'partial_baseline');
  assert.equal(result.exact, false);
  assert.equal(result.spend_micro, 120_000);
  assert.equal(result.baseline_at, first);
});

test('spendSince reports no_samples for an empty history', () => {
  const result = spendSince([], Date.now());
  assert.equal(result.reason, 'no_samples');
  assert.equal(result.spend_micro, null);
  assert.equal(result.exact, false);
});

test('spendSince clamps a counter reset to zero instead of going negative', () => {
  const dayStart = new Date(2026, 10, 6, 0, 0, 0, 0).getTime();
  const result = spendSince(
    [at(beforeMidnight(4), 900_000_000), at(afterMidnight(2), 10_000_000)],
    dayStart,
  );
  assert.equal(result.spend_micro, 0);
});

test('spendSince sorts unordered samples', () => {
  const dayStart = new Date(2026, 10, 6, 0, 0, 0, 0).getTime();
  const result = spendSince(
    [at(afterMidnight(3), 213_000_000), at(beforeMidnight(4), 212_000_000)],
    dayStart,
  );
  assert.equal(result.spend_micro, 1_000_000);
  assert.equal(result.as_of, afterMidnight(3));
});

test('startOfLocalDay and startOfLocalMonth use local boundaries', () => {
  const now = new Date(2026, 10, 6, 8, 32, 0).getTime();
  const day = new Date(startOfLocalDay(now));
  assert.equal(day.getDate(), 6);
  assert.equal(day.getHours(), 0);
  assert.equal(day.getMinutes(), 0);

  const month = new Date(startOfLocalMonth(now));
  assert.equal(month.getMonth(), 10);
  assert.equal(month.getDate(), 1);
  assert.equal(month.getHours(), 0);
});
