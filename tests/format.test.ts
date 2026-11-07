import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSignificant,
  formatSpendAxis,
  formatTokensAxis,
  formatMetricValue,
  formatTokensPrecise,
} from '../src/shared/format.ts';
import { generateValueTicks } from '../src/shared/timeAxis.ts';

const USD = 1_000_000;

test('significant digits drop decimals as the magnitude grows', () => {
  assert.equal(formatSignificant(1.234567), '1.235');
  assert.equal(formatSignificant(12.34567), '12.35');
  assert.equal(formatSignificant(123.4567), '123.5');
  assert.equal(formatSignificant(1234.567), '1235');
  assert.equal(formatSignificant(12345.67), '12346');
});

test('a spend axis label never resolves below one tenth of a cent', () => {
  // $0.0001 is refused: the axis floors at $0.001, so a sub-milli value rounds
  // away to zero rather than printing a fourth decimal.
  assert.equal(formatSpendAxis(100), '$0');
  assert.equal(formatSpendAxis(400), '$0');
  assert.equal(formatSpendAxis(1000), '$0.001');
  assert.equal(formatSpendAxis(5000), '$0.005');
  for (const micro of [1, 10, 100, 500, 1000, 12_345, 999_000]) {
    assert.ok(!/\$\d+\.\d{4}/.test(formatSpendAxis(micro)), `${micro} printed four decimals`);
  }
});

test('a spend axis label carries at most four significant digits', () => {
  for (const micro of [1234, 12340, 123400, 1234000, 12340000, 123400000]) {
    const label = formatSpendAxis(micro).replace(/[$KMB]/g, '').replace('.', '');
    const digits = label.replace(/^0+/, '') || '0';
    assert.ok(digits.length <= 4, `${micro} produced ${formatSpendAxis(micro)}`);
  }
});

test('a spend axis label switches to K and M as amounts grow', () => {
  assert.equal(formatSpendAxis(1500 * USD), '$1.5K');
  assert.equal(formatSpendAxis(12_340 * USD), '$12.34K');
  assert.equal(formatSpendAxis(1_500_000 * USD), '$1.5M');
  assert.equal(formatSpendAxis(999 * USD), '$999');
});

test('a spend axis label keeps plain decimal notation below a thousand', () => {
  assert.equal(formatSpendAxis(1.5 * USD), '$1.5');
  assert.equal(formatSpendAxis(4.83 * USD), '$4.83');
  assert.equal(formatSpendAxis(999.99 * USD), '$1K');
  assert.equal(formatSpendAxis(0), '$0');
});

test('a token axis label uses the same digit budget as spend', () => {
  assert.equal(formatTokensAxis(0), '0');
  assert.equal(formatTokensAxis(999), '999');
  assert.equal(formatTokensAxis(1500), '1.5K');
  assert.equal(formatTokensAxis(12_345), '12.35K');
  assert.equal(formatTokensAxis(1_500_000), '1.5M');
  assert.equal(formatTokensAxis(49_287_497), '49.29M');
});

test('the display budget keeps four significant digits for tokens', () => {
  assert.equal(formatTokensPrecise(3_755_000), '3.755M');
  assert.equal(formatTokensPrecise(49_287_497), '49.29M');
  assert.equal(formatTokensPrecise(1500), '1.5K');
  assert.equal(formatTokensPrecise(999), '999');
});

test('the display budget is richer than the axis budget', () => {
  // The axis must fit a gutter, so it rounds harder than a headline does.
  assert.equal(formatSpendAxis(64_800), '$0.065');
  assert.equal(formatMetricValue('spend', 64_800), '$0.06480');
  assert.equal(formatTokensAxis(3_755_000), '3.755M');
  assert.equal(formatMetricValue('tokens', 3_755_000), '3.755M');
});

test('metric formatting states spend and tokens at the same precision', () => {
  assert.equal(formatMetricValue('spend', 4.83 * USD), '$4.83');
  assert.equal(formatMetricValue('tokens', 4_830_000), '4.83M');
});

test('a tick step is never finer than the axis minimum', () => {
  // A plot of a fraction of a cent still gets a $0.001 step, not $0.0001.
  const ticks = generateValueTicks(400, 4, 1000);
  assert.deepEqual(ticks, [0, 1000]);
  const cent = generateValueTicks(5000, 4, 1000);
  assert.ok(cent.every((t) => t % 1000 === 0), `non-round ticks: ${cent.join(',')}`);
});

test('the tick step snaps up to a round number when floored', () => {
  // A natural step of 1 micro-dollar is raised to the 1-2-5 value at or above
  // $0.001, so the labels stay round rather than landing on arbitrary values.
  const ticks = generateValueTicks(50_000, 4, 1000);
  assert.ok(ticks.every((t) => t % ticks[1]! === 0));
  assert.ok(ticks[1]! >= 1000);
});

test('the top tick is always at or above the maximum', () => {
  for (const max of [1, 7, 42, 999, 1001, 58_295_700]) {
    const ticks = generateValueTicks(max, 4, 1);
    assert.ok(ticks[ticks.length - 1]! >= max, `${max} produced top tick ${ticks[ticks.length - 1]}`);
  }
});

test('a zero or invalid maximum yields a single zero tick', () => {
  assert.deepEqual(generateValueTicks(0, 4, 1), [0]);
  assert.deepEqual(generateValueTicks(Number.NaN, 4, 1), [0]);
});
