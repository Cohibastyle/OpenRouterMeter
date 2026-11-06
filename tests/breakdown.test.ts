import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBreakdown, type BreakdownInput } from '../src/shared/breakdown.ts';
import type { CollectionRange } from '../src/shared/granularity.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const NOW = new Date(2026, 10, 6, 12, 0, 0).getTime();

const row = (over: Partial<BreakdownInput> & { event_time: string; source: string }): BreakdownInput => ({
  model: null,
  key_id: null,
  key_name: null,
  cost_micro: null,
  input_tokens: null,
  output_tokens: null,
  total_tokens: null,
  ...over,
});

const ranges: CollectionRange[] = [
  { granularity_ms: MINUTE, range_start: new Date(NOW - 2 * HOUR).toISOString(), range_end: new Date(NOW).toISOString() },
  { granularity_ms: HOUR, range_start: new Date(NOW - 24 * HOUR).toISOString(), range_end: new Date(NOW).toISOString() },
  { granularity_ms: DAY, range_start: new Date(NOW - 30 * DAY).toISOString(), range_end: new Date(NOW).toISOString() },
];

test('breakdown groups by model and sums one granularity only', () => {
  const rows = [
    row({ event_time: new Date(NOW - 2 * HOUR).toISOString(), source: 'openrouter.analytics.hour', model: 'a/one', cost_micro: 1_000_000, total_tokens: 100 }),
    row({ event_time: new Date(NOW - 1 * HOUR).toISOString(), source: 'openrouter.analytics.hour', model: 'a/one', cost_micro: 2_000_000, total_tokens: 200 }),
    row({ event_time: new Date(NOW - 1 * HOUR).toISOString(), source: 'openrouter.analytics.hour', model: 'b/two', cost_micro: 500_000, total_tokens: 50 }),
    // A day row covering the same period must not be added on top.
    row({ event_time: new Date(NOW - 5 * HOUR).toISOString(), source: 'openrouter.analytics.day', model: 'a/one', cost_micro: 9_000_000, total_tokens: 900 }),
  ];
  const result = buildBreakdown(rows, NOW - 24 * HOUR, NOW, 'model', ranges);
  assert.equal(result.incomplete, false);
  assert.equal(result.granularity_ms, HOUR);
  assert.equal(result.rows.length, 2);
  const one = result.rows.find((r) => r.label === 'a/one')!;
  assert.equal(one.spend_micro, 3_000_000);
  assert.equal(one.total_tokens, 300);
  assert.equal(one.bucket_count, 2);
});

test('breakdown sorts by spend descending', () => {
  const rows = [
    row({ event_time: new Date(NOW - 2 * HOUR).toISOString(), source: 'openrouter.analytics.hour', model: 'small/x', cost_micro: 100 }),
    row({ event_time: new Date(NOW - 2 * HOUR).toISOString(), source: 'openrouter.analytics.hour', model: 'big/y', cost_micro: 900 }),
  ];
  const result = buildBreakdown(rows, NOW - 24 * HOUR, NOW, 'model', ranges);
  assert.deepEqual(result.rows.map((r) => r.label), ['big/y', 'small/x']);
});

test('breakdown by key prefers the display name and never a credential', () => {
  const rows = [
    row({
      event_time: new Date(NOW - 2 * HOUR).toISOString(),
      source: 'openrouter.analytics.hour',
      key_id: 'abc123hash',
      key_name: 'Ace VS Code',
      cost_micro: 1_000_000,
    }),
  ];
  const result = buildBreakdown(rows, NOW - 24 * HOUR, NOW, 'key', ranges);
  assert.equal(result.rows[0]!.label, 'Ace VS Code');
  assert.equal(result.rows[0]!.id, 'key:abc123hash');
});

test('breakdown by key falls back to the hash when no name is known', () => {
  const rows = [
    row({
      event_time: new Date(NOW - 2 * HOUR).toISOString(),
      source: 'openrouter.analytics.hour',
      key_id: 'abc123hash',
      cost_micro: 1_000_000,
    }),
  ];
  const result = buildBreakdown(rows, NOW - 24 * HOUR, NOW, 'key', ranges);
  assert.equal(result.rows[0]!.label, 'abc123hash');
});

test('breakdown reports incomplete when no granularity covers the window', () => {
  const rows = [
    row({ event_time: new Date(NOW - 30 * MINUTE).toISOString(), source: 'openrouter.analytics.minute', model: 'a/one', cost_micro: 1 }),
  ];
  // Minute rows only reach back two hours, so a 30-day window cannot use them.
  const result = buildBreakdown(rows, NOW - 30 * DAY, NOW, 'model', ranges);
  assert.equal(result.incomplete, true);
  assert.equal(result.rows.length, 0);
});

test('breakdown ignores rows outside the window', () => {
  const rows = [
    row({ event_time: new Date(NOW - 2 * HOUR).toISOString(), source: 'openrouter.analytics.hour', model: 'in/x', cost_micro: 100 }),
    row({ event_time: new Date(NOW - 20 * HOUR).toISOString(), source: 'openrouter.analytics.hour', model: 'out/y', cost_micro: 900 }),
  ];
  const result = buildBreakdown(rows, NOW - 3 * HOUR, NOW, 'model', ranges);
  assert.deepEqual(result.rows.map((r) => r.label), ['in/x']);
});

test('breakdown labels an unknown model rather than dropping it', () => {
  const rows = [
    row({ event_time: new Date(NOW - 2 * HOUR).toISOString(), source: 'openrouter.analytics.hour', cost_micro: 100 }),
  ];
  const result = buildBreakdown(rows, NOW - 24 * HOUR, NOW, 'model', ranges);
  assert.equal(result.rows[0]!.label, 'Unknown');
});
