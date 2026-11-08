import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBreakdown, type BreakdownInput } from '../src/shared/breakdown.ts';
import { computeWindows } from '../src/shared/windows.ts';
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
  const result = buildBreakdown(rows, '24h', NOW, 'model', ranges);
  assert.equal(result.incomplete, false);
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
  const result = buildBreakdown(rows, '24h', NOW, 'model', ranges);
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
  const result = buildBreakdown(rows, '24h', NOW, 'key', ranges);
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
  const result = buildBreakdown(rows, '24h', NOW, 'key', ranges);
  assert.equal(result.rows[0]!.label, 'abc123hash');
});

test('breakdown reports incomplete when nothing was reported in the window', () => {
  // No rows at all means the period cannot be answered, so the tab says so
  // rather than rendering an empty table that reads as "no usage".
  const result = buildBreakdown([], '24h', NOW, 'model', ranges);
  assert.equal(result.incomplete, true);
  assert.equal(result.rows.length, 0);
});

test('breakdown ignores rows outside the window', () => {
  const rows = [
    row({ event_time: new Date(NOW - 2 * HOUR).toISOString(), source: 'openrouter.analytics.hour', model: 'in/x', cost_micro: 100 }),
    row({ event_time: new Date(NOW - 30 * HOUR).toISOString(), source: 'openrouter.analytics.hour', model: 'out/y', cost_micro: 900 }),
  ];
  const result = buildBreakdown(rows, '24h', NOW, 'model', ranges);
  assert.deepEqual(result.rows.map((r) => r.label), ['in/x']);
});

test('breakdown labels an unknown model rather than dropping it', () => {
  const rows = [
    row({ event_time: new Date(NOW - 2 * HOUR).toISOString(), source: 'openrouter.analytics.hour', cost_micro: 100 }),
  ];
  const result = buildBreakdown(rows, '24h', NOW, 'model', ranges);
  assert.equal(result.rows[0]!.label, 'Unknown');
});

test('breakdown rows add up to the interval button totals', () => {
  // Rule: the table and the range buttons are one figure. The buttons sum the
  // same bins the chart draws — one granularity per bin — so the breakdown
  // must select rows the same way. Minute rows cover the last two hours and
  // hour rows cover the day; the window sums the recent bins from minute rows
  // and the older bins from hour rows.
  const minute = (minsAgo: number, model: string, cost: number, tokens: number) =>
    row({
      event_time: new Date(NOW - minsAgo * MINUTE).toISOString(),
      source: 'openrouter.analytics.minute',
      model,
      cost_micro: cost,
      total_tokens: tokens,
    });
  const hour = (hoursAgo: number, model: string, cost: number, tokens: number) =>
    row({
      event_time: new Date(NOW - hoursAgo * HOUR).toISOString(),
      source: 'openrouter.analytics.hour',
      model,
      cost_micro: cost,
      total_tokens: tokens,
    });
  const rows = [
    minute(5, 'a/one', 100, 10),
    minute(65, 'a/one', 200, 20),
    hour(5, 'a/one', 1_000, 100),
    hour(20, 'b/two', 2_000, 200),
  ];

  const breakdown = buildBreakdown(rows, '24h', NOW, 'model', ranges);
  const tableSpend = breakdown.rows.reduce((sum, r) => sum + (r.spend_micro ?? 0), 0);
  const tableTokens = breakdown.rows.reduce((sum, r) => sum + (r.total_tokens ?? 0), 0);

  const windows = computeWindows({
    now: NOW,
    requests: rows.map((r) => ({ ...r, id: r.event_time, received_time: r.event_time, key_id: 'k', key_name: 'k', status: 'success', request_count: 1 })),
    sourceGranularityMs: MINUTE,
    collectionStartedAt: NOW - 400 * DAY,
    gaps: [],
    retentionHorizon: NOW - 90 * DAY,
    stale: false,
    collectionRanges: ranges,
  });
  const day = windows.find((w) => w.key === '24h')!;

  assert.equal(tableSpend, day.spend_micro, 'table spend equals the 24h button');
  assert.equal(tableTokens, day.total_tokens, 'table tokens equal the 24h button');
});
