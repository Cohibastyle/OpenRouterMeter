import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BAR_GROW_MS,
  BAR_SOLID_MS,
  barGrowthFrame,
  planBarGrowth,
} from '../src/shared/barGrowth.ts';

test('the first paint is not a rise', () => {
  assert.equal(planBarGrowth(undefined, 100, 0, undefined, true), undefined);
});

test('a rise is planned from the previous top', () => {
  const planned = planBarGrowth(100, 150, 1_000, undefined, true);
  assert.deepEqual(planned, { from: 100, to: 150, startedAt: 1_000 });
});

test('a fall or a zero is not animated', () => {
  assert.equal(planBarGrowth(150, 100, 0, undefined, true), undefined);
  assert.equal(planBarGrowth(0, 0, 0, undefined, true), undefined);
  assert.equal(planBarGrowth(10, 20, 0, undefined, false), undefined);
});

test('an in-flight plan for the same target is kept across rebuilds', () => {
  const existing = { from: 100, to: 150, startedAt: 1_000 };
  const kept = planBarGrowth(150, 150, 1_000 + 500, existing, true);
  assert.equal(kept, existing);
});

test('the increment is solid after four seconds', () => {
  const growth = { from: 100, to: 200, startedAt: 0 };
  const rising = barGrowthFrame(growth, BAR_GROW_MS);
  assert.equal(rising.solid, false);
  assert.equal(rising.base, 100);
  assert.equal(rising.shown, 200);

  const mid = barGrowthFrame(growth, BAR_SOLID_MS - 1);
  assert.equal(mid.solid, false);
  assert.ok(mid.shown > 100);

  const done = barGrowthFrame(growth, BAR_SOLID_MS);
  assert.deepEqual(done, { base: 200, shown: 200, solid: true });
});
