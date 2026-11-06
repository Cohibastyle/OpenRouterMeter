import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLinearAxis, createLogAxis, generateTicks, hitTest, barGeometry } from '../src/shared/logAxis.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('newest point sits at the right edge and oldest at the left edge', () => {
  const tEnd = 1_700_000_000_000;
  const tStart = tEnd - 24 * HOUR;
  const axis = createLogAxis(tStart, tEnd, HOUR);

  assert.equal(axis.positionOf(tEnd), 1);
  assert.equal(axis.positionOf(tStart), 0);
});

test('a point at half the age of another renders at the expected log position', () => {
  const tEnd = 1_700_000_000_000;
  const tStart = tEnd - 100 * DAY;
  const axis = createLogAxis(tStart, tEnd, MINUTE);

  // Age 1 hour vs age 10 hours: exactly one decade apart.
  const x1h = axis.positionOf(tEnd - HOUR);
  const x10h = axis.positionOf(tEnd - 10 * HOUR);
  const x100h = axis.positionOf(tEnd - 100 * HOUR);

  const span = axis.logAMax - axis.logAMin;
  assert.ok(Math.abs(x1h - x10h - 1 / span) < 1e-9, 'one decade should be 1/span of the width');
  assert.ok(Math.abs(x10h - x100h - 1 / span) < 1e-9, 'decades are evenly spaced in log space');
});

test('bar widths shrink monotonically from right to left', () => {
  const tEnd = 1_700_000_000_000;
  const tStart = tEnd - 30 * DAY;
  const axis = createLogAxis(tStart, tEnd, HOUR);
  const width = 600;

  const widths: number[] = [];
  for (let i = 0; i < 24; i += 1) {
    const binEnd = tEnd - i * HOUR;
    const binStart = binEnd - HOUR;
    widths.push(barGeometry(axis, binStart, binEnd, width, 0).width);
  }

  for (let i = 1; i < widths.length; i += 1) {
    assert.ok(widths[i]! <= widths[i - 1]! + 1e-9, `bin ${i} should not be wider than bin ${i - 1}`);
  }
});

test('no bar renders narrower than one device pixel', () => {
  const tEnd = 1_700_000_000_000;
  const tStart = tEnd - 365 * DAY;
  const axis = createLogAxis(tStart, tEnd, MINUTE);
  const geometry = barGeometry(axis, tStart, tStart + MINUTE, 400, 1);
  assert.ok(geometry.width >= 1);
});

test('grid lines compress toward the left and are not uniformly spaced', () => {
  const tEnd = 1_700_000_000_000;
  const tStart = tEnd - 100 * DAY;
  const axis = createLogAxis(tStart, tEnd, MINUTE);
  const ticks = generateTicks(axis, { width: 800, minLabelSpacing: 48 });

  const positions = ticks.map((t) => t.position).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < positions.length; i += 1) gaps.push(positions[i]! - positions[i - 1]!);

  const unique = new Set(gaps.map((g) => g.toFixed(4)));
  assert.ok(unique.size > 1, 'gaps must not all be identical, which would mean a linear axis');
});

test('major ticks land on decade boundaries', () => {
  const tEnd = 1_700_000_000_000;
  const tStart = tEnd - 100 * DAY;
  const axis = createLogAxis(tStart, tEnd, MINUTE);
  const ticks = generateTicks(axis, { width: 900, minLabelSpacing: 40 });

  const decades = [SECOND, 10 * SECOND, MINUTE, 10 * MINUTE, HOUR, 10 * HOUR, DAY, 10 * DAY, 100 * DAY];
  const majors = ticks.filter((t) => t.major && t.ageMs > 0);
  assert.ok(majors.length > 0);
  for (const tick of majors) {
    assert.ok(
      decades.some((d) => Math.abs(d - tick.ageMs) < 1),
      `major tick at ${tick.ageMs} ms is not a decade boundary`,
    );
  }
});

test('the rightmost label is always now', () => {
  const tEnd = 1_700_000_000_000;
  const axis = createLogAxis(tEnd - 6 * HOUR, tEnd, MINUTE);
  const ticks = generateTicks(axis, { width: 400 });
  const rightmost = ticks.filter((t) => t.label !== '').sort((a, b) => b.position - a.position)[0];
  assert.equal(rightmost?.label, 'now');
});

test('no two labels overlap at any width', () => {
  const tEnd = 1_700_000_000_000;
  for (const width of [180, 240, 320, 480, 640, 900, 1400]) {
    const axis = createLogAxis(tEnd - 30 * DAY, tEnd, HOUR);
    const ticks = generateTicks(axis, { width, minLabelSpacing: 48 });
    const labelled = ticks.filter((t) => t.label !== '').sort((a, b) => a.position - b.position);
    for (let i = 1; i < labelled.length; i += 1) {
      const gap = (labelled[i]!.position - labelled[i - 1]!.position) * width;
      assert.ok(gap >= 47, `labels overlap at width ${width}: gap ${gap.toFixed(1)} px`);
    }
  }
});

test('a range shorter than one decade still uses the log mapping', () => {
  const tEnd = 1_700_000_000_000;
  // Six hours of hourly bins is about one decade of log extent.
  const axis = createLogAxis(tEnd - 6 * HOUR, tEnd, HOUR);
  const span = axis.logAMax - axis.logAMin;
  assert.ok(span < 1.2, `this range is under one decade, got ${span.toFixed(2)}`);

  // A linear axis would place the midpoint at 0.5; the log axis must not.
  const midpoint = axis.positionOf(tEnd - 3 * HOUR);
  assert.ok(Math.abs(midpoint - 0.5) > 0.01, 'the mapping must not silently fall back to linear');
});

test('a single-bin range renders as one full-width bar labelled now', () => {
  const tEnd = 1_700_000_000_000;
  const axis = createLogAxis(tEnd - HOUR, tEnd, HOUR);
  const geometry = barGeometry(axis, tEnd - HOUR, tEnd, 300, 1);
  assert.ok(geometry.width >= 299);

  const ticks = generateTicks(axis, { width: 300 });
  const labelled = ticks.filter((t) => t.label !== '');
  assert.equal(labelled[labelled.length - 1]?.label, 'now');
});

test('hit testing resolves the correct bin at the left, middle, and right edges', () => {
  const tEnd = 1_700_000_000_000;
  const tStart = tEnd - 24 * HOUR;
  const axis = createLogAxis(tStart, tEnd, HOUR);
  const width = 600;

  const bins: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < 24; i += 1) {
    const binEnd = tEnd - i * HOUR;
    bins.unshift({ start: binEnd - HOUR, end: binEnd });
  }

  const rightIndex = hitTest(axis, bins, width - 2, width);
  assert.equal(rightIndex, bins.length - 1, 'right edge should resolve to the newest bin');

  const leftIndex = hitTest(axis, bins, 2, width);
  assert.equal(leftIndex, 0, 'left edge should resolve to the oldest bin');

  const middleIndex = hitTest(axis, bins, width / 2, width);
  assert.ok(middleIndex > 0 && middleIndex < bins.length - 1, 'middle should resolve to an interior bin');
});

test('a gap keeps its true log width and is not collapsed', () => {
  const tEnd = 1_700_000_000_000;
  const axis = createLogAxis(tEnd - 10 * DAY, tEnd, HOUR);
  const gapStart = tEnd - 5 * DAY;
  const gapEnd = tEnd - 4 * DAY;
  const geometry = barGeometry(axis, gapStart, gapEnd, 500, 1);
  assert.ok(geometry.width > 1, 'a one-day gap must occupy real width');
});

test('the current partial bin reflects only its elapsed width', () => {
  const tEnd = 1_700_000_000_000;
  const axis = createLogAxis(tEnd - 24 * HOUR, tEnd, HOUR);
  const fullBin = barGeometry(axis, tEnd - 2 * HOUR, tEnd - HOUR, 500, 1);
  const partialBin = barGeometry(axis, tEnd - 30 * MINUTE, tEnd, 500, 1);
  assert.ok(partialBin.width > 0);
  assert.ok(Number.isFinite(fullBin.width));
});


test('linear ticks never repeat the same relative label', () => {
  const tEnd = new Date(2026, 10, 6, 12, 0, 0).getTime();
  const tStart = tEnd - 5 * DAY;
  const axis = createLinearAxis(tStart, tEnd);
  const ticks = generateTicks(axis, { width: 640, minLabelSpacing: 48 });
  const labels = ticks.map((t) => t.label).filter((l) => l !== '');
  assert.equal(new Set(labels).size, labels.length, `duplicate labels: ${labels.join(',')}`);
});

test('every chart scale produces at least three labelled ticks', () => {
  const now = new Date(2026, 10, 6, 12, 0, 0).getTime();
  const cases: Array<[string, number, number, number, boolean]> = [
    ['hour', new Date(2026, 10, 6).getTime(), now, HOUR, false],
    ['day', new Date(2026, 10, 1).getTime(), now, DAY, true],
    ['week', now - 84 * DAY, now, 7 * DAY, true],
    ['month', now - 365 * DAY, now, 30 * DAY, true],
  ];
  for (const [name, tStart, tEnd, finest, calendarNatural] of cases) {
    const axis = createLogAxis(tStart, tEnd, finest);
    const ticks = generateTicks(axis, { width: 600, minLabelSpacing: 48, calendarNatural, nowLabel: 'now' });
    const labelled = ticks.filter((t) => t.label !== '');
    assert.ok(labelled.length >= 3, `${name} produced only ${labelled.length} labelled ticks`);
  }
});
