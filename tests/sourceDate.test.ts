import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSourceDate } from '../src/shared/sourceDate.ts';

test('a source date without a zone is parsed as UTC, not local time', () => {
  // OpenRouter returns "YYYY-MM-DD HH:mm:ss". Parsing that with new Date()
  // treats it as local time, which shifts the day boundary and misattributes
  // spend to the wrong calendar day.
  const parsed = parseSourceDate('2026-11-02 00:00:00');
  assert.equal(parsed, '2026-11-02T00:00:00.000Z');
});

test('a date-only value is parsed as UTC midnight', () => {
  assert.equal(parseSourceDate('2026-11-02'), '2026-11-02T00:00:00.000Z');
});

test('an ISO value with an explicit zone is preserved', () => {
  assert.equal(parseSourceDate('2026-11-02T05:30:00Z'), '2026-11-02T05:30:00.000Z');
  assert.equal(parseSourceDate('2026-11-02T05:30:00+09:00'), '2026-11-01T20:30:00.000Z');
});

test('a null date falls back to now rather than throwing', () => {
  const parsed = parseSourceDate(null);
  assert.ok(!Number.isNaN(new Date(parsed).getTime()));
});

test('the parsed date is stable regardless of the host time zone', () => {
  // The same input must produce the same instant everywhere.
  const a = parseSourceDate('2026-11-02 13:45:00');
  const b = parseSourceDate('2026-11-02 13:45:00');
  assert.equal(a, b);
  assert.equal(a, '2026-11-02T13:45:00.000Z');
});

test('activity rows get a stable natural key, not a positional index', async () => {
  const { OpenRouterCollector } = await import('../src/shared/openrouter.ts');
  const row = {
    date: '2026-11-02T00:00:00.000Z',
    model: 'deepseek/deepseek-v4.1-flash-1017',
    endpoint_id: 'ep-1',
    provider_name: 'DeepSeek',
    key_id: null,
    key_name: null,
    requests: 133,
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    cost_micro: 331171,
  };

  const first = OpenRouterCollector.activityToRequests([row])[0]!;
  // The same row in a different position must produce the same id, otherwise
  // every fetch inserts a duplicate.
  const second = OpenRouterCollector.activityToRequests([{ ...row }, { ...row, model: 'other' }])[0]!;
  assert.equal(first.id, second.id);
  assert.equal(
    first.id,
    'activity:2026-11-02T00:00:00.000Z:deepseek/deepseek-v4.1-flash-1017:ep-1:DeepSeek',
    'the id must be the natural key of the row, with no positional index',
  );
});

test('two different activity rows produce different ids', async () => {
  const { OpenRouterCollector } = await import('../src/shared/openrouter.ts');
  const base = {
    date: '2026-11-02T00:00:00.000Z',
    model: 'a/b',
    endpoint_id: 'ep-1',
    provider_name: 'P',
    key_id: null,
    key_name: null,
    requests: 1,
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
    cost_micro: 1,
  };
  const a = OpenRouterCollector.activityToRequests([base])[0]!;
  const b = OpenRouterCollector.activityToRequests([{ ...base, model: 'c/d' }])[0]!;
  const c = OpenRouterCollector.activityToRequests([{ ...base, endpoint_id: 'ep-2' }])[0]!;
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.id, c.id);
});
