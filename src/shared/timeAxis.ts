/**
 * Time and value axes for the charts.
 *
 * The time axis is linear: a point's horizontal position is proportional to its
 * timestamp within the plotted period, so a bar's width says how long its
 * bucket was and two bars of the same duration are the same width wherever they
 * sit. The value axis is linear too, with 1-2-5 steps.
 */

export interface TimeAxis {
  tStart: number;
  tEnd: number;
  /** Map an absolute timestamp to a normalized position in [0, 1]. */
  positionOf(time: number): number;
  /** Map a normalized position in [0, 1] back to an absolute timestamp. */
  timeAt(position: number): number;
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
 * Grid lines and labels for the linear time axis. The spacing is a nice time
 * step chosen so labels never collide; as width shrinks, the step grows.
 */
export function generateTicks(axis: TimeAxis, options: TickOptions): AxisTick[] {
  const width = Math.max(1, options.width);
  const minSpacing = options.minLabelSpacing ?? 48;
  const nowLabel = options.nowLabel ?? 'now';
  return generateLinearTicks(axis, width, minSpacing, nowLabel);
}

/** Evenly spaced ticks for the linear time axis. */
function generateLinearTicks(
  axis: TimeAxis,
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
 * Geometry for one bin. Equal durations get equal widths, and a minimum
 * rendered width of one device pixel keeps a bin from vanishing entirely.
 */
export function barGeometry(
  axis: TimeAxis,
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
 * Hit testing on the linear time axis.
 *
 * A bin whose span contains the pointer wins; when several qualify (because
 * `minHitPx` widened them), the nearest bin centre in time wins.
 */
export function hitTest(
  axis: TimeAxis,
  bins: ReadonlyArray<{ start: number; end: number }>,
  pointerX: number,
  width: number,
  minHitPx = 8,
): number {
  if (bins.length === 0) return -1;
  const time = axis.timeAt(pointerX / Math.max(1, width));

  let bestIndex = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < bins.length; i += 1) {
    const bin = bins[i]!;
    const xStart = axis.positionOf(bin.start) * width;
    const xEnd = axis.positionOf(bin.end) * width;
    const inside = pointerX >= xStart - minHitPx / 2 && pointerX <= xEnd + minHitPx / 2;
    if (!inside) continue;
    const distance = Math.abs((bin.start + bin.end) / 2 - time);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  if (bestIndex >= 0) return bestIndex;

  // Fall back to the nearest bin centre.
  for (let i = 0; i < bins.length; i += 1) {
    const bin = bins[i]!;
    const distance = Math.abs((bin.start + bin.end) / 2 - time);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/**
 * A linear time axis over `[tStart, tEnd]`.
 *
 * A range with no extent has no left or right edge to interpolate between, so
 * every instant maps to the right edge and the time at any position is `tEnd`.
 * That keeps a degenerate chart to one bar rather than dividing by zero.
 */
export function createTimeAxis(tStart: number, tEnd: number): TimeAxis {
  const span = tEnd - tStart;
  if (!(span > 0)) {
    return {
      tStart,
      tEnd,
      positionOf: () => 1,
      timeAt: () => tEnd,
    };
  }
  const positionOf = (time: number): number => clamp01((time - tStart) / span);
  const timeAt = (position: number): number => tStart + clamp01(position) * span;
  return { tStart, tEnd, positionOf, timeAt };
}

/**
 * Nice round values for a linear value axis.
 *
 * Returns ascending ticks from 0 to at least `max`, using a 1-2-5 step so the
 * labels are readable numbers rather than arbitrary fractions of the maximum.
 *
 * `minStep` raises the step when the natural one would be finer than the unit
 * worth labelling. The spend axis passes the micro-dollar value of $0.001, so a
 * tick is never smaller than a tenth of a cent: a plot whose maximum is a
 * fraction of a cent shows `$0 · $0.001` rather than four decimals.
 */
export function generateValueTicks(max: number, targetCount = 4, minStep = 0): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0];
  const rough = max / Math.max(1, targetCount);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / magnitude;
  let step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  if (Number.isFinite(minStep) && minStep > step) {
    // Snap the floor up to the next 1-2-5 value so the labels stay round.
    const floorMagnitude = Math.pow(10, Math.floor(Math.log10(minStep)));
    const floorNormalized = minStep / floorMagnitude;
    step =
      (floorNormalized <= 1 ? 1 : floorNormalized <= 2 ? 2 : floorNormalized <= 5 ? 5 : 10) *
      floorMagnitude;
  }

  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  // Always include a tick at or above the maximum so the top of the plot is
  // labelled and the tallest bar does not touch an unlabelled edge.
  if (ticks[ticks.length - 1]! < max) ticks.push(Number((ticks[ticks.length - 1]! + step).toFixed(10)));
  return ticks;
}
