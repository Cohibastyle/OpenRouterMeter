/**
 * Logarithmic time axis, FSD section 10.11.1.
 *
 * x(t) = 1 - (log(a) - log(a_min)) / (log(a_max) - log(a_min))
 * where a = t_end - t is the age of a point relative to the right edge.
 *
 * The newest point sits at the right edge (x = 1) and the oldest at the left
 * edge (x = 0). Bar widths therefore shrink toward the left, which is the
 * intended compression. There is no silent linear fallback.
 */

export interface LogAxis {
  /** 'log' for the default axis, 'linear' only for the accessibility override. */
  kind: 'log' | 'linear';
  tStart: number;
  tEnd: number;
  aMin: number;
  aMax: number;
  logAMin: number;
  logAMax: number;
  /** Map an absolute timestamp to a normalized position in [0, 1]. */
  positionOf(time: number): number;
  /** Map a normalized position in [0, 1] back to an absolute timestamp. */
  timeAt(position: number): number;
  /** Age in ms at a normalized position. */
  ageAt(position: number): number;
}

const MIN_AGE_MS = 1000;

export function createLogAxis(tStart: number, tEnd: number, finestBinMs: number): LogAxis {
  const span = Math.max(0, tEnd - tStart);
  const aMax = Math.max(MIN_AGE_MS, span);
  // a_min is half the finest bin width, floored at one second. Using the full
  // bin width would collapse the newest bin to zero width, because its right
  // edge sits at age zero and its left edge at exactly a_min.
  const aMin = Math.min(aMax, Math.max(MIN_AGE_MS, finestBinMs / 2));
  const logAMin = Math.log10(aMin);
  const logAMax = Math.log10(aMax);
  const denom = logAMax - logAMin;

  const positionOf = (time: number): number => {
    const age = tEnd - time;
    // A range where a_max equals a_min has no log extent. The documented
    // behaviour is one full-width bar, so map linearly across the span.
    if (denom <= 0) return clamp01(span === 0 ? 1 : (time - tStart) / span);
    if (age <= aMin) return 1;
    if (age >= aMax) return 0;
    const x = 1 - (Math.log10(age) - logAMin) / denom;
    return clamp01(x);
  };

  const ageAt = (position: number): number => {
    const p = clamp01(position);
    if (denom <= 0) return Math.max(MIN_AGE_MS, span * (1 - p));
    return Math.pow(10, logAMin + (1 - p) * denom);
  };

  const timeAt = (position: number): number => tEnd - ageAt(position);

  return { kind: 'log', tStart, tEnd, aMin, aMax, logAMin, logAMax, positionOf, timeAt, ageAt };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}


const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30.44 * DAY;
const YEAR = 365.25 * DAY;

/**
 * Decade boundaries of age, per FSD section 10.11.1. These are the major grid
 * lines: 1 s, 10 s, 1 min, 10 min, 1 h, 10 h, 1 d, 10 d, 100 d.
 */
const DECADE_MAJORS: ReadonlyArray<number> = [
  1 * SECOND,
  10 * SECOND,
  1 * MINUTE,
  10 * MINUTE,
  1 * HOUR,
  10 * HOUR,
  1 * DAY,
  10 * DAY,
  100 * DAY,
  1000 * DAY,
];

/** 2x and 5x positions inside each decade, used as minor grid lines. */
const DECADE_MINORS: ReadonlyArray<number> = [
  2 * SECOND,
  5 * SECOND,
  20 * SECOND,
  50 * SECOND,
  2 * MINUTE,
  5 * MINUTE,
  20 * MINUTE,
  50 * MINUTE,
  2 * HOUR,
  5 * HOUR,
  20 * HOUR,
  50 * HOUR,
  2 * DAY,
  5 * DAY,
  20 * DAY,
  50 * DAY,
  200 * DAY,
  500 * DAY,
];

/** Calendar-natural tick set, used when the range is dominated by calendar units. */
const CALENDAR_TICKS: ReadonlyArray<number> = [
  1 * MINUTE,
  5 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  1 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  1 * DAY,
  2 * DAY,
  1 * WEEK,
  2 * WEEK,
  1 * MONTH,
  3 * MONTH,
  6 * MONTH,
  1 * YEAR,
];

/**
 * A dense 1-2-3-5 sequence across every decade. Used when the visible range is
 * narrower than a decade, where the strict decade set would yield too few
 * grid lines to read the axis.
 */
const DENSE_TICKS: ReadonlyArray<number> = (() => {
  const out: number[] = [];
  // The exponent must reach far enough that a multi-day span still has grid
  // lines. Stopping at 10^4 seconds left a week-long range with a single tick.
  for (let exp = 0; exp <= 7; exp += 1) {
    const base = Math.pow(10, exp);
    for (const mult of [1, 2, 3, 5]) {
      const ms = mult * base * SECOND;
      if (ms >= SECOND && ms <= 1000 * DAY) out.push(ms);
    }
  }
  return out.sort((a, b) => a - b);
})();

export interface AxisTick {
  /** Age in ms from the right edge. */
  ageMs: number;
  /** Normalized position in [0, 1]. */
  position: number;
  /** Relative-age label, e.g. 5m, 3h, 2d, 6mo. Empty for unlabeled grid lines. */
  label: string;
  major: boolean;
}

export interface TickOptions {
  /** Available width in logical pixels. */
  width: number;
  /** Minimum spacing between labels in logical pixels. Default 48. */
  minLabelSpacing?: number;
  /** Prefer the calendar-natural tick set. */
  calendarNatural?: boolean;
  /** Label for the rightmost tick. Default 'now'. */
  nowLabel?: string;
}

/**
 * Generate grid lines and labels. Minor ticks are dropped before major ticks as
 * width shrinks, and no two labels are closer than minLabelSpacing.
 */
export function generateTicks(axis: LogAxis, options: TickOptions): AxisTick[] {
  const width = Math.max(1, options.width);
  const minSpacing = options.minLabelSpacing ?? 48;
  const nowLabel = options.nowLabel ?? 'now';

  if (axis.kind === 'linear') {
    return generateLinearTicks(axis, width, minSpacing, nowLabel);
  }

  const decades = axis.logAMax - axis.logAMin;
  const useCalendar = options.calendarNatural === true;
  const useDense = !useCalendar && decades < 1.2;

  const candidates: Array<{ ageMs: number; major: boolean }> = useCalendar
    ? CALENDAR_TICKS.map((ageMs) => ({ ageMs, major: true }))
    : useDense
      ? DENSE_TICKS.map((ageMs) => ({ ageMs, major: true }))
      : [
          ...DECADE_MAJORS.map((ageMs) => ({ ageMs, major: true })),
          ...DECADE_MINORS.map((ageMs) => ({ ageMs, major: false })),
        ];

  const inRange = candidates
    .filter((c) => c.ageMs >= axis.aMin && c.ageMs <= axis.aMax)
    .map((c) => ({
      ageMs: c.ageMs,
      major: c.major,
      position: axis.positionOf(axis.tEnd - c.ageMs),
      label: labelForAge(c.ageMs),
    }))
    .sort((a, b) => a.position - b.position);

  const ticks: AxisTick[] = [];
  let lastLabelX = -Infinity;

  for (const tick of inRange) {
    const x = tick.position * width;
    // The right edge always carries the now label, so skip anything that would
    // collide with it.
    if (x > width - minSpacing) {
      ticks.push({ ...tick, label: '' });
      continue;
    }
    if (x - lastLabelX >= minSpacing) {
      ticks.push({ ...tick, label: tick.label });
      lastLabelX = x;
    } else {
      ticks.push({ ...tick, label: '' });
    }
  }

  ticks.push({ ageMs: 0, position: 1, label: nowLabel, major: true });
  return ticks;
}

/**
 * Evenly spaced ticks for the linear accessibility override. The spacing is a
 * nice time step chosen so labels never collide.
 */
function generateLinearTicks(
  axis: LogAxis,
  width: number,
  minSpacing: number,
  nowLabel: string,
): AxisTick[] {
  const span = Math.max(1, axis.tEnd - axis.tStart);
  const maxTicks = Math.max(2, Math.floor(width / minSpacing));
  const rawStep = span / maxTicks;
  const step = niceStep(rawStep);

  const ticks: AxisTick[] = [];
  const first = Math.ceil(axis.tStart / step) * step;
  // Ticks land on absolute time multiples while labels are relative ages, so
  // two neighbouring ticks can round to the same label ("4d" next to "4d").
  // Keep the first of each run and blank the rest.
  let lastLabel = '';
  for (let t = first; t <= axis.tEnd; t += step) {
    const position = axis.positionOf(t);
    if (position > 1 - minSpacing / width) continue;
    const label = labelForAge(axis.tEnd - t);
    const duplicate = label === lastLabel;
    if (!duplicate) lastLabel = label;
    ticks.push({
      ageMs: axis.tEnd - t,
      position,
      label: duplicate ? '' : label,
      major: true,
    });
  }
  ticks.push({ ageMs: 0, position: 1, label: nowLabel, major: true });
  return ticks;
}

function niceStep(raw: number): number {
  const candidates = [
    SECOND, 2 * SECOND, 5 * SECOND, 10 * SECOND, 15 * SECOND, 30 * SECOND,
    MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE,
    HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
    DAY, 2 * DAY, WEEK, 2 * WEEK, MONTH, 3 * MONTH, 6 * MONTH, YEAR,
  ];
  for (const candidate of candidates) {
    if (candidate >= raw) return candidate;
  }
  return YEAR;
}

function labelForAge(ageMs: number): string {
  const sec = ageMs / SECOND;
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = ageMs / MINUTE;
  if (min < 60) return `${Math.round(min)}m`;
  const hr = ageMs / HOUR;
  if (hr < 24) return `${Math.round(hr)}h`;
  const day = ageMs / DAY;
  if (day < 30) return `${Math.round(day)}d`;
  const mo = ageMs / MONTH;
  if (mo < 12) return `${Math.round(mo)}mo`;
  return `${Math.round(ageMs / YEAR)}y`;
}

export interface BarGeometry {
  start: number;
  end: number;
  width: number;
  center: number;
}

/**
 * Geometry for one bin. Widths shrink toward the left; a minimum rendered width
 * of one device pixel keeps a bin from vanishing entirely.
 */
export function barGeometry(
  axis: LogAxis,
  binStart: number,
  binEnd: number,
  width: number,
  minWidthPx = 1,
): BarGeometry {
  const xEnd = axis.positionOf(binEnd) * width;
  const xStart = axis.positionOf(binStart) * width;
  const raw = xEnd - xStart;
  const w = Math.max(minWidthPx, raw);
  const center = (xStart + xEnd) / 2;
  return { start: xStart, end: xEnd, width: w, center };
}

/**
 * Hit testing through the log mapping. When several bins fall inside the hit
 * target, the nearest bin by log distance wins.
 */
export function hitTest(
  axis: LogAxis,
  bins: ReadonlyArray<{ start: number; end: number }>,
  pointerX: number,
  width: number,
  minHitPx = 8,
): number {
  if (bins.length === 0) return -1;
  const time = axis.timeAt(pointerX / Math.max(1, width));
  const pointerAge = axis.tEnd - time;

  let bestIndex = -1;
  let bestDistance = Infinity;

  for (let i = 0; i < bins.length; i += 1) {
    const bin = bins[i]!;
    const xStart = axis.positionOf(bin.start) * width;
    const xEnd = axis.positionOf(bin.end) * width;
    const inside = pointerX >= xStart - minHitPx / 2 && pointerX <= xEnd + minHitPx / 2;
    if (!inside) continue;

    const centerTime = (bin.start + bin.end) / 2;
    const centerAge = Math.max(axis.aMin, axis.tEnd - centerTime);
    const distance = Math.abs(Math.log10(centerAge) - Math.log10(Math.max(axis.aMin, pointerAge)));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  if (bestIndex >= 0) return bestIndex;

  // Fall back to the nearest bin center in log space.
  for (let i = 0; i < bins.length; i += 1) {
    const bin = bins[i]!;
    const centerTime = (bin.start + bin.end) / 2;
    const centerAge = Math.max(axis.aMin, axis.tEnd - centerTime);
    const distance = Math.abs(Math.log10(centerAge) - Math.log10(Math.max(axis.aMin, pointerAge)));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/** Linear mapping, used only by the accessibility override. */
export function createLinearAxis(tStart: number, tEnd: number): LogAxis {
  const span = Math.max(1, tEnd - tStart);
  const positionOf = (time: number): number => clamp01((time - tStart) / span);
  const timeAt = (position: number): number => tStart + clamp01(position) * span;
  const ageAt = (position: number): number => tEnd - timeAt(position);
  return {
    kind: 'linear',
    tStart,
    tEnd,
    aMin: 1000,
    aMax: span,
    logAMin: 0,
    logAMax: 0,
    positionOf,
    timeAt,
    ageAt,
  };
}

/**
 * Nice round values for a linear value axis.
 *
 * Returns ascending ticks from 0 to at least `max`, using a 1-2-5 step so the
 * labels are readable numbers rather than arbitrary fractions of the maximum.
 */
export function generateValueTicks(max: number, targetCount = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0];
  const rough = max / Math.max(1, targetCount);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;

  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  // Always include a tick at or above the maximum so the top of the plot is
  // labelled and the tallest bar does not touch an unlabelled edge.
  if (ticks[ticks.length - 1]! < max) ticks.push(Number((ticks[ticks.length - 1]! + step).toFixed(10)));
  return ticks;
}
