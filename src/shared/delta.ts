/**
 * The change between two headline readings.
 *
 * The headline is repainted on every snapshot, so the chip beside it describes a
 * refresh-to-refresh delta rather than the interval total. Both directions are
 * reported: a rise is new usage, and a fall is a correction to a figure that was
 * already on screen.
 */

export type DeltaDirection = 'up' | 'down';

export interface HeadlineDelta {
  /** Size of the change, always positive; `direction` says which way it went. */
  amount: number;
  direction: DeltaDirection;
  /** Requests that arrived with the change, or null when the source did not say. */
  requests: number | null;
}

/**
 * The change between two readings, or null when the value did not move.
 *
 * A null on either side means the value is unknown, not zero, so no change can
 * be claimed. A zero change is not a delta: reporting `↑ $0.00` would announce
 * an event that did not happen.
 */
export function headlineDelta(
  previous: number | null,
  current: number | null,
  requests: number | null,
): HeadlineDelta | null {
  if (previous === null || current === null) return null;
  const change = current - previous;
  if (change === 0) return null;
  return {
    amount: Math.abs(change),
    direction: change > 0 ? 'up' : 'down',
    requests,
  };
}

/**
 * The requests that arrived with a change, or null when either side is unknown.
 *
 * A negative difference is clamped to zero: the count can fall when the rolling
 * window drops an old bucket, and reporting a negative number of requests would
 * be nonsense.
 */
export function requestsBetween(previous: number | null, current: number | null): number | null {
  if (previous === null || current === null) return null;
  return Math.max(0, current - previous);
}
