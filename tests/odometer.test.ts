import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planRoll } from '../src/renderer/components/odometer.js';

const WINDOW = 2000;

test('a column travels at most one lap, and only changed columns move', () => {
  // The worked example from the report: `$4.123` to `$6.456`.
  const plan = planRoll('$4.123', '$6.456', WINDOW);
  assert.ok(plan);

  // The trailing digits take 3 steps each and the leading ones 3 and 2. A
  // carry-chain counter dragging the whole numeric delta would move the last
  // column 2333 times instead of 3.
  assert.deepEqual(
    plan.columns.map((c) => [c.index, c.from, c.to, c.steps]),
    [
      [5, 3, 6, 3],
      [4, 2, 5, 3],
      [3, 1, 4, 3],
      [1, 4, 6, 2],
    ],
  );
  assert.equal(plan.totalSteps, 11);
});

test('an unchanged digit is never in the plan', () => {
  // `$4.001` to `$4.121`: the leading 4 and the final 1 do not move at all.
  const plan = planRoll('$4.001', '$4.121', WINDOW);
  assert.ok(plan);
  assert.deepEqual(
    plan.columns.map((c) => c.index),
    [4, 3],
  );
  assert.equal(plan.totalSteps, 3);
});

test('the roll runs at its natural pace, not stretched to the window', () => {
  // A small increase settles quickly instead of crawling for two seconds: one
  // column of two steps is two digits' worth of travel.
  const small = planRoll('$4.001', '$4.021', WINDOW);
  assert.ok(small);
  assert.equal(small.columns.length, 1);
  assert.equal(small.durationMs, 210);

  // The four-column example: the last column starts after three beats and then
  // travels two digits, which is the longest of the four.
  const plan = planRoll('$4.123', '$6.456', WINDOW);
  assert.ok(plan);
  assert.equal(plan.durationMs, 3 * 170 + 2 * 105);
  assert.ok(plan.durationMs < WINDOW);
});

test('a window too short for the cascade compresses it uniformly', () => {
  const plan = planRoll('$4.123', '$6.456', 400);
  assert.ok(plan);
  assert.ok(plan.durationMs <= 400);
  // Compression scales the beats and the travel together, so the cascade keeps
  // its shape rather than letting the last column overrun.
  const stagger = (plan.columns[1]!.startMs - plan.columns[0]!.startMs) / plan.columns[0]!.stepMs;
  assert.ok(Math.abs(stagger - 170 / 105) < 1e-9, `stagger ${stagger}`);
});

test('columns cascade least significant first, one beat apart', () => {
  const plan = planRoll('$4.123', '$6.456', WINDOW);
  assert.ok(plan);
  assert.equal(plan.columns[0]!.startMs, 0);
  // Every column starts one beat after the one to its right, so the carry reads
  // as a cascade rather than every digit moving at once.
  for (let i = 1; i < plan.columns.length; i += 1) {
    assert.equal(plan.columns[i]!.startMs - plan.columns[i - 1]!.startMs, 170);
    assert.equal(plan.columns[i]!.stepMs, 105);
  }
});

test('a fall rolls down, and a shape change does not roll', () => {
  const fall = planRoll('$6.456', '$4.123', WINDOW);
  assert.ok(fall);
  assert.deepEqual(
    fall.columns.map((c) => [c.index, c.from, c.to, c.steps]),
    [
      [5, 6, 3, -3],
      [4, 5, 2, -3],
      [3, 4, 1, -3],
      [1, 6, 4, -2],
    ],
  );
  assert.equal(planRoll('$4.123', '$4.123', WINDOW), null);
  assert.equal(planRoll('$148.2K', '$1.24M', WINDOW), null);
  assert.equal(planRoll('$4.123', '$6.456', 0), null);
});
test('an increase too small to change the text is not animated', () => {
  // A rise that lands inside the displayed precision must not start a roll: the
  // formatter gives both values the same string, so there is nothing to travel
  // and the number would otherwise flash for no reason.
  assert.equal(planRoll('$4.99', '$4.99', WINDOW), null);
});

test('an increase that changes a digit rolls that digit only', () => {
  // The live case: a $0.09 rise moves the cents column by one.
  const plan = planRoll('$4.99', '$5.08', WINDOW);
  assert.ok(plan);
  assert.deepEqual(
    plan.columns.map((c) => [c.index, c.from, c.to, c.steps]),
    [
      [4, 9, 8, 9],
      [3, 9, 0, 1],
      [1, 4, 5, 1],
    ],
  );
});

test('a strip parks on its starting digit before the roll begins', () => {
  // Every cell the roll can reach is inside the strip: nine steps forward plus
  // the two decades a wrapping column can cross.
  const plan = planRoll('$4.888', '$5.222', WINDOW);
  assert.ok(plan);
  for (const column of plan.columns) {
    assert.ok(Math.abs(column.steps) <= 9);
  }
});

test('the same plan serves spend and token text alike', () => {
  // Tokens use compact formatting, so the planner must not assume a currency
  // symbol or a decimal point: only the digits matter.
  const plan = planRoll('148.2K', '163.7K', WINDOW);
  assert.ok(plan);
  assert.deepEqual(
    plan.columns.map((c) => [c.index, c.from, c.to]),
    [
      [4, 2, 7],
      [2, 8, 3],
      [1, 4, 6],
    ],
  );
});
