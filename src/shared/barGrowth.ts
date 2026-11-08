/**
 * Height animation for a chart bar that just received new data.
 *
 * The existing value stays put. The increment grows upward from that top, then
 * the whole bar turns solid after `BAR_SOLID_MS`. First paint is not animated:
 * there is no previous top to grow from.
 */

/** Time the increment takes to rise from the previous top to the new one. */
export const BAR_GROW_MS = 480;
/** Time after the change at which the increment becomes the solid bar. */
export const BAR_SOLID_MS = 4000;

export function easeOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - x, 3);
}

export interface BarGrowth {
  from: number;
  to: number;
  startedAt: number;
}

/**
 * Plan a rise from the value last drawn to the value just received.
 *
 * A fall or an unchanged value is not a rise: the overlay is dropped. A plan
 * already in flight for the same target is kept so a rebuild does not restart
 * the four-second solidify.
 */
export function planBarGrowth(
  previous: number | undefined,
  next: number,
  now: number,
  existing: BarGrowth | undefined,
  animate: boolean,
): BarGrowth | undefined {
  if (!animate || next <= 0) return undefined;
  if (existing && existing.to === next && now - existing.startedAt < BAR_SOLID_MS) {
    return existing;
  }
  if (previous === undefined) return undefined;
  if (next <= previous) return undefined;
  return { from: previous, to: next, startedAt: now };
}

/** The heights to draw at `now`: the solid base and the rising overlay. */
export function barGrowthFrame(
  growth: BarGrowth,
  now: number,
): { base: number; shown: number; solid: boolean } {
  const age = now - growth.startedAt;
  if (age >= BAR_SOLID_MS) {
    return { base: growth.to, shown: growth.to, solid: true };
  }
  const shown = growth.from + (growth.to - growth.from) * easeOutCubic(age / BAR_GROW_MS);
  return { base: growth.from, shown, solid: false };
}
