import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headlineDelta, requestsBetween } from '../src/shared/delta.ts';

test('a rise reports its size and direction', () => {
  const change = headlineDelta(4_986_000, 5_002_000, 3);
  assert.deepEqual(change, { amount: 16_000, direction: 'up', requests: 3 });
});

test('a fall reports its size and direction', () => {
  // A headline that drops is a correction to a figure already on screen, so it
  // is reported rather than swallowed.
  const change = headlineDelta(5_002_000, 4_986_000, 0);
  assert.deepEqual(change, { amount: 16_000, direction: 'down', requests: 0 });
});

test('an unchanged value is not a delta', () => {
  // Reporting `↑ $0.00` would announce an event that did not happen.
  assert.equal(headlineDelta(4_986_000, 4_986_000, 0), null);
});

test('an unknown value on either side is not a delta', () => {
  // Null means unknown, not zero, so no change can be claimed.
  assert.equal(headlineDelta(null, 5_000_000, 1), null);
  assert.equal(headlineDelta(5_000_000, null, 1), null);
  assert.equal(headlineDelta(null, null, null), null);
});
test('the amount is always positive so the arrow carries the direction', () => {
  const up = headlineDelta(1_000_000, 1_500_000, null);
  const down = headlineDelta(1_500_000, 1_000_000, null);
  assert.equal(up?.amount, 500_000);
  assert.equal(down?.amount, 500_000);
  assert.equal(up?.direction, 'up');
  assert.equal(down?.direction, 'down');
});

test('requests between two readings never goes negative', () => {
  // The count can fall when the rolling window drops an old bucket, and a
  // negative number of requests would be nonsense.
  assert.equal(requestsBetween(10, 14), 4);
  assert.equal(requestsBetween(14, 10), 0);
  assert.equal(requestsBetween(10, 10), 0);
});

test('requests between two readings is null when either side is unknown', () => {
  assert.equal(requestsBetween(null, 14), null);
  assert.equal(requestsBetween(10, null), null);
});
