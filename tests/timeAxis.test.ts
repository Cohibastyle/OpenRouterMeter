import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimeAxis, generateTicks, hitTest, barGeometry } from '../src/shared/timeAxis.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('newest point sits at the right edge and oldest at the left edge', () => {
  const tEnd = 1_700_000_000_000;
  const tStart = tEnd - 24 * HOUR;
  const axis = createTimeAxis(tStart, tEnd);

  assert.equal(axis.positionOf(tEnd), 1);
  assert.equal(axis.positionOf(tStart), 0);
  assert.equal(axis.positionOf(tStart + 12 * HOUR), 0.5);
});

test('a point at half the age of another renders nearer the left edge', () => {
  const tEnd = 1_700_000_000_000;
  const tStart = tEnd - 24 * HOUR;
  const axis = createTimeAxis(tStart, tEnd);

  // Linear: the older point is exactly twice as far from the right edge.
  const older = axis.positionOf(tEnd - 12 * HOUR);
  const newer = axis.positionOf(tEnd - 6 * HOUR);
  assert.ok(older < newer);
  assert.equal(1 - older, 2 * (1 - newer));
});

test('bar widths are equal for equal durations anywhere on the axis', () => {
  const tEnd = 1_700_000_000_000;
  const tStart = tEnd - 24 * HOUR;
  const width = 600;
  const axis = createTimeAxis(tStart, tEnd);

  const recent = barGeometry(axis, tEnd - HOUR, tEnd, width);
  const old = barGeometry(axis, tStart, tStart + HOUR, width);
  assert.ok(Math.abs(recent.width - old.width) < 0.001);
});

test('no bar renders narrower than one device pixel', () => {
  const tEnd = 1_700_000_000_000;
  const tStart = tEnd - 30 * DAY;
  const axis = createTimeAxis(tStart, tEnd);
  const geometry = barGeometry(axis, tEnd - SECOND, tEnd, 100);
  assert.equal(geometry.width, 1);
});

test('grid lines are uniformly spaced on the linear axis', () => {
  const tEnd = 1_700_000_000_000;
  const tStart = tEnd - 6 * HOUR;
  const axis = createTimeAxis(tStart, tEnd);
  const ticks = generateTicks(axis, { width: 640, minLabelSpacing: 48 });
  const positions = ticks.map((t) => t.position);
  assert.ok(positions.length >= 3);
  const gaps: number[] = [];
  for (let i = 1; i < positions.length; i += 1) gaps.push(positions[i]! - positions[i - 1]!);
  // The now tick is appended at position 1, so compare only the generated run.
  const body = gaps.slice(0, -1);
  for (const gap of body) {
    assert.ok(Math.abs(gap - body[0]!) < 0.02, `uneven gap ${gap} vs ${body[0]}`);
  }
});

test('grid lines land on round time multiples', () => {
  const tEnd = new Date(2026, 10, 6, 12, 0, 0).getTime();
  const tStart = tEnd - 6 * HOUR;
  const axis = createTimeAxis(tStart, tEnd);
  const ticks = generateTicks(axis, { width: 640, minLabelSpacing: 48 });
  const times = ticks.map((t) => axis.timeAt(t.position)).filter((t) => t < tEnd);
  assert.ok(times.length >= 2);
  // Each tick is a multiple of the same step, so the gaps are identical.
  const steps = times.slice(1).map((t, i) => t - times[i]!);
  for (const step of steps) assert.equal(step, steps[0]);
  assert.equal(steps[0]! % MINUTE, 0);
});

test('the rightmost label is always now', () => {
  const tEnd = 1_700_000_000_000;
  const axis = createTimeAxis(tEnd - 6 * HOUR, tEnd);
  const ticks = generateTicks(axis, { width: 480, minLabelSpacing: 40 });
  assert.equal(ticks[ticks.length - 1]!.label, 'now');
  assert.equal(ticks[ticks.length - 1]!.position, 1);
});

test('no two labels overlap at any width', () => {
  const tEnd = new Date(2026, 10, 6, 12, 0, 0).getTime();
  for (const span of [10 * MINUTE, HOUR, 6 * HOUR, DAY, 30 * DAY]) {
    const axis = createTimeAxis(tEnd - span, tEnd);
    for (const width of [180, 320, 480, 900]) {
      const minSpacing = 48;
      const ticks = generateTicks(axis, { width, minLabelSpacing: minSpacing });
      const labelled = ticks.filter((t) => t.label !== '');
      for (let i = 1; i < labelled.length; i += 1) {
        const gap = (labelled[i]!.position - labelled[i - 1]!.position) * width;
        assert.ok(
          gap >= minSpacing - 0.001,
          `span ${span} width ${width}: labels only ${gap}px apart`,
        );
      }
    }
  }
});

test('a range shorter than one hour still gets readable ticks', () => {
  const tEnd = 1_700_000_000_000;
  const axis = createTimeAxis(tEnd - 10 * MINUTE, tEnd);
  const ticks = generateTicks(axis, { width: 480, minLabelSpacing: 48 });
  const labelled = ticks.filter((t) => t.label !== '');
  assert.ok(labelled.length >= 3, `only ${labelled.length} labels`);
});

test('a zero-length range does not divide by zero', () => {
  const tEnd = 1_700_000_000_000;
  const axis = createTimeAxis(tEnd, tEnd);
  assert.equal(axis.positionOf(tEnd), 1);
  assert.equal(axis.positionOf(tEnd - SECOND), 1);
  assert.ok(Number.isFinite(axis.timeAt(0)));
});

test('hit testing resolves the correct bin at the left, middle, and right edges', () => {
  const tEnd = 1_700_000_000_000;
  const tStart = tEnd - 6 * HOUR;
  const width = 600;
  const axis = createTimeAxis(tStart, tEnd);
  const bins = Array.from({ length: 6 }, (_, i) => ({
    start: tStart + i * HOUR,
    end: tStart + (i + 1) * HOUR,
  }));

  assert.equal(hitTest(axis, bins, 20, width, 8), 0);
  // 350px is inside the fourth hour bucket (3h-4h), not on a bucket boundary.
  assert.equal(hitTest(axis, bins, 350, width, 8), 3);
  assert.equal(hitTest(axis, bins, 590, width, 8), 5);
});

test('a gap keeps its true width and is not collapsed', () => {
  const tEnd = 1_700_000_000_000;
  const tStart = tEnd - 6 * HOUR;
  const width = 600;
  const axis = createTimeAxis(tStart, tEnd);
  // A one-hour gap is one sixth of the plot at any position on a linear axis.
  const gap = barGeometry(axis, tStart + 2 * HOUR, tStart + 3 * HOUR, width);
  assert.ok(Math.abs(gap.width - width / 6) < 0.001);
});

test('the current partial bin reflects only its elapsed width', () => {
  const tEnd = 1_700_000_000_000;
  const tStart = tEnd - 6 * HOUR;
  const width = 600;
  const axis = createTimeAxis(tStart, tEnd);
  // The final bin is half elapsed, so it is half as wide as a full hour bin.
  const partial = barGeometry(axis, tEnd - HOUR / 2, tEnd, width);
  const full = barGeometry(axis, tEnd - HOUR, tEnd, width);
  assert.ok(Math.abs(partial.width - full.width / 2) < 0.001);
});

test('linear ticks never repeat the same relative label', () => {
  const tEnd = new Date(2026, 10, 6, 12, 0, 0).getTime();
  const tStart = tEnd - 5 * DAY;
  const axis = createTimeAxis(tStart, tEnd);
  const ticks = generateTicks(axis, { width: 640, minLabelSpacing: 48 });
  const labels = ticks.map((t) => t.label).filter((l) => l !== '');
  assert.equal(new Set(labels).size, labels.length, `duplicate labels: ${labels.join(',')}`);
});

test('every chart scale produces at least three labelled ticks', () => {
  const now = new Date(2026, 10, 6, 12, 0, 0).getTime();
  const cases: Array<[string, number, number]> = [
    ['10m', now - 10 * MINUTE, now],
    ['1h', now - HOUR, now],
    ['3h', now - 3 * HOUR, now],
    ['6h', now - 6 * HOUR, now],
    ['24h', now - DAY, now],
    ['week', now - 7 * DAY, now],
    ['month', now - 30 * DAY, now],
  ];
  for (const [name, tStart, tEnd] of cases) {
    const axis = createTimeAxis(tStart, tEnd);
    const ticks = generateTicks(axis, { width: 600, minLabelSpacing: 48, nowLabel: 'now' });
    const labelled = ticks.filter((t) => t.label !== '');
    assert.ok(labelled.length >= 3, `${name} produced only ${labelled.length} labelled ticks`);
  }
});
