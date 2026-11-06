/**
 * Deriving spend from the cumulative account counter.
 *
 * The credits endpoint returns `total_usage`, a live cumulative counter that
 * updates within seconds. The activity endpoint returns per-day aggregates but
 * can lag by several days. Neither alone answers "how much did I spend today":
 *
 *   - activity is exact per day, but the newest day may be missing entirely
 *   - the counter is live, but it is cumulative, not per-day
 *
 * Combining them gives an exact answer for today:
 *
 *   today = total_usage_now - total_usage_at_start_of_today
 *
 * The start-of-day reading comes from a sample recorded by this widget. When no
 * sample exists from before midnight the value is reported as partial, anchored
 * at the earliest reading available, so the UI can say "since 09:14" instead of
 * silently overstating or understating the day.
 */

export interface UsageSample {
  sampled_at: string;
  total_usage_micro: number;
}

export interface CounterSpend {
  spend_micro: number | null;
  /** True when the baseline predates the period start, so the value is exact. */
  exact: boolean;
  /** When the baseline reading was taken. */
  baseline_at: string | null;
  /** When the newest reading was taken. */
  as_of: string | null;
  reason: 'ok' | 'partial_baseline' | 'no_samples';
}

/**
 * Spend since a period start, from the cumulative counter.
 *
 * @param samples Samples in any order; they are sorted internally.
 * @param periodStartMs Period start as an epoch millisecond value.
 */
export function spendSince(
  samples: ReadonlyArray<UsageSample>,
  periodStartMs: number,
): CounterSpend {
  if (samples.length === 0) {
    return { spend_micro: null, exact: false, baseline_at: null, as_of: null, reason: 'no_samples' };
  }

  const ordered = [...samples].sort(
    (a, b) => new Date(a.sampled_at).getTime() - new Date(b.sampled_at).getTime(),
  );
  const latest = ordered[ordered.length - 1]!;

  // Prefer the newest reading at or before the period start: it keeps the
  // measured interval as short as possible, which minimises any drift.
  let baseline: UsageSample | null = null;
  for (const sample of ordered) {
    if (new Date(sample.sampled_at).getTime() <= periodStartMs) baseline = sample;
  }

  let exact = true;
  if (!baseline) {
    // Nothing from before the period start. Anchor at the earliest reading we
    // do have and mark the result partial, so the UI can show the anchor time.
    baseline = ordered[0]!;
    exact = false;
  }

  const delta = latest.total_usage_micro - baseline.total_usage_micro;
  return {
    // A negative delta means the counter was reset or credits were refunded.
    // Clamp to zero rather than showing negative spend.
    spend_micro: Math.max(0, delta),
    exact,
    baseline_at: baseline.sampled_at,
    as_of: latest.sampled_at,
    reason: exact ? 'ok' : 'partial_baseline',
  };
}

/** Local midnight for the day containing `now`. */
export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

/** Local first-of-month for the month containing `now`. */
export function startOfLocalMonth(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime();
}
