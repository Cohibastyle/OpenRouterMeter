import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAnalyticsBody,
  granularityForRange,
  parseAnalyticsDate,
  parseAnalyticsResponse,
  parseAnalyticsRow,
} from '../src/shared/analytics.ts';

test('buildAnalyticsBody omits empty optional fields', () => {
  const body = buildAnalyticsBody({
    metrics: ['total_usage'],
    granularity: 'day',
    start: '2026-11-01T00:00:00.000Z',
    end: '2026-11-06T00:00:00.000Z',
  });
  assert.deepEqual(body, {
    metrics: ['total_usage'],
    granularity: 'day',
    time_range: { start: '2026-11-01T00:00:00.000Z', end: '2026-11-06T00:00:00.000Z' },
  });
  assert.equal('dimensions' in body, false);
  assert.equal('filters' in body, false);
});

test('buildAnalyticsBody includes dimensions and filters when present', () => {
  const body = buildAnalyticsBody({
    metrics: ['total_usage'],
    dimensions: ['api_key_id'],
    granularity: 'hour',
    start: '2026-11-06T00:00:00.000Z',
    end: '2026-11-06T01:00:00.000Z',
    filters: [{ field: 'model', operator: 'eq', value: 'deepseek/deepseek-v4.1-flash-20261017' }],
    limit: 10,
  });
  assert.deepEqual(body.dimensions, ['api_key_id']);
  assert.equal(body.limit, 10);
  assert.equal((body.filters as unknown[]).length, 1);
});

test('parseAnalyticsDate treats a zone-less timestamp as UTC', () => {
  // The API returns "YYYY-MM-DD HH:mm:ss" with no zone. Reading it as local
  // time would shift the bucket across a day boundary.
  assert.equal(parseAnalyticsDate('2026-11-06 00:00:00'), '2026-11-06T00:00:00.000Z');
  assert.equal(parseAnalyticsDate('2026-11-06 13:45:00'), '2026-11-06T13:45:00.000Z');
});

test('parseAnalyticsDate keeps an explicit zone', () => {
  assert.equal(parseAnalyticsDate('2026-11-06T00:00:00Z'), '2026-11-06T00:00:00.000Z');
  assert.equal(parseAnalyticsDate('2026-11-06T09:00:00+09:00'), '2026-11-06T00:00:00.000Z');
});

test('parseAnalyticsDate rejects unusable input', () => {
  assert.equal(parseAnalyticsDate(''), null);
  assert.equal(parseAnalyticsDate('not a date'), null);
});

test('parseAnalyticsRow reads the granularity-specific date key', () => {
  const row = parseAnalyticsRow(
    {
      date__hour: '2026-11-06 00:00:00',
      total_usage: 0.012981,
      tokens_total: '1205833',
      request_count: '8',
      api_key_id: 'VScode OR Plugin M5',
    },
    'hour',
    ['api_key_id'],
  );
  assert.ok(row);
  assert.equal(row.bucket, '2026-11-06T00:00:00.000Z');
  assert.equal(row.total_usage_micro, 0.012981);
  // Numeric strings are coerced, because the API returns counts as strings.
  assert.equal(row.tokens_total, 1205833);
  assert.equal(row.request_count, 8);
  assert.equal(row.dimensions.api_key_id, 'VScode OR Plugin M5');
});

test('parseAnalyticsRow returns null when the date key is missing', () => {
  assert.equal(parseAnalyticsRow({ total_usage: 1 }, 'day', []), null);
});

test('parseAnalyticsResponse reports truncation and skips bad rows', () => {
  const result = parseAnalyticsResponse(
    {
      data: {
        data: [
          { date__day: '2026-11-06', total_usage: 0.5 },
          { total_usage: 9 },
          { date__day: '2026-11-05', total_usage: 1.5 },
        ],
        metadata: { truncated: true },
      },
    },
    'day',
  );
  assert.equal(result.rows.length, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.granularity, 'day');
});

test('parseAnalyticsResponse tolerates a malformed envelope', () => {
  assert.deepEqual(parseAnalyticsResponse(null, 'day').rows, []);
  assert.deepEqual(parseAnalyticsResponse({ data: {} }, 'day').rows, []);
  assert.equal(parseAnalyticsResponse({ data: {} }, 'day').truncated, false);
});

test('granularityForRange picks the finest granularity under the row cap', () => {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  // 6 hours is 360 minutes, which still fits under a 1000-row cap.
  assert.equal(granularityForRange(30 * minute), 'minute');
  assert.equal(granularityForRange(6 * hour), 'minute');
  // 30 hours is 1800 minutes, over the cap, but only 30 hourly buckets.
  assert.equal(granularityForRange(30 * hour), 'hour');
  // 20 days is 480 hours, under the cap, so hourly still wins.
  assert.equal(granularityForRange(20 * day), 'hour');
  // Daily buckets stay under the cap for any range the endpoint accepts, which
  // is 367 days, so day is the coarsest granularity actually reachable.
  assert.equal(granularityForRange(60 * day), 'day');
  assert.equal(granularityForRange(200 * day), 'day');
  assert.equal(granularityForRange(367 * day), 'day');
  // Beyond the accepted range the coarser steps still apply.
  assert.equal(granularityForRange(2000 * day), 'week');
  assert.equal(granularityForRange(9000 * day), 'month');
});
