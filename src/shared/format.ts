import { MICRO } from './money.js';

export const DASH = '\u2013';

/**
 * Spend formatting per FSD section 10.14.
 * Below one dollar: at least four significant digits so a real charge never
 * renders as $0.00. At or above one dollar: two decimals.
 */
export function formatSpend(micro: number | null | undefined): string {
  if (micro === null || micro === undefined || !Number.isFinite(micro)) return DASH;
  const usd = micro / MICRO;
  if (usd === 0) return '$0.00';
  const abs = Math.abs(usd);
  const sign = usd < 0 ? '-' : '';
  if (abs >= 1) {
    return `${sign}$${abs.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  // Four significant digits below one dollar.
  const digits = Math.min(6, Math.max(2, 3 - Math.floor(Math.log10(abs))));
  return `${sign}$${abs.toFixed(digits)}`;
}

/** Compact spend for tight cells; keeps four significant digits below $1. */
export function formatSpendCompact(micro: number | null | undefined): string {
  if (micro === null || micro === undefined || !Number.isFinite(micro)) return DASH;
  const usd = micro / MICRO;
  if (Math.abs(usd) >= 1000) {
    return `$${compactNumber(usd)}`;
  }
  return formatSpend(micro);
}

/**
 * A number rounded to at most `maxSig` significant digits, in plain decimal.
 *
 * Decimals are dropped as the magnitude grows, so 1.234, 12.34, 123.4, and 1234
 * all carry four significant digits rather than a fixed number of decimal
 * places.
 */
export function formatSignificant(value: number, maxSig = 4): string {
  const abs = Math.abs(value);
  if (!Number.isFinite(abs) || abs === 0) return '0';
  const decimals = Math.max(0, Math.min(6, maxSig - 1 - Math.floor(Math.log10(abs))));
  return abs.toFixed(decimals);
}

/**
 * A fixed-decimal string with trailing zeroes removed.
 *
 * `1.500` becomes `1.5` and `12.00` becomes `12`, so a label never spends width
 * on digits that carry no information.
 */
function trimZerosFixed(value: string): string {
  if (!value.includes('.')) return value;
  const out = value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return out === '' ? '0' : out;
}

/**
 * Spend for an axis tick or a narrow cell.
 *
 * Four significant digits at most, never finer than $0.001, and K/M as the
 * amounts grow so a label still fits the left gutter. `$0.0001` cannot be
 * produced: decimals stop at three, which is the $0.001 floor.
 */
export function formatSpendAxis(micro: number | null | undefined): string {
  if (micro === null || micro === undefined || !Number.isFinite(micro)) return DASH;
  const usd = micro / MICRO;
  const abs = Math.abs(usd);
  const sign = usd < 0 ? '-' : '';
  if (abs === 0) return '$0';
  // Anything below half a thousandth of a dollar is zero at this resolution.
  // The tick generator floors its step at $0.001, so a sub-milli label is only
  // ever produced for a value that rounds away.
  if (abs < 0.0005) return '$0';
  if (abs >= 1_000_000_000) return `${sign}$${trimZerosFixed(formatSignificant(abs / 1_000_000_000))}B`;
  if (abs >= 1_000_000) return `${sign}$${trimZerosFixed(formatSignificant(abs / 1_000_000))}M`;
  if (abs >= 1_000) return `${sign}$${trimZerosFixed(formatSignificant(abs / 1_000))}K`;
  // Four significant digits, floored at $0.001 so a tick never needs a fourth
  // decimal, and capped so a large label does not spend width on cents.
  const decimals = Math.min(3, Math.max(0, 4 - 1 - Math.floor(Math.log10(abs))));
  const label = trimZerosFixed(abs.toFixed(decimals));
  // A value just under a thousand would round to `1000`, which is a K-scale
  // number. Re-label it at that scale rather than printing five digits.
  if (Number(label) >= 1_000) {
    return `${sign}$${trimZerosFixed(formatSignificant(abs / 1_000))}K`;
  }
  return `${sign}$${label}`;
}

/**
 * Token count for an axis tick.
 *
 * Tokens have no sub-unit to floor, so the axis and the display budgets agree
 * and this delegates: unlike spend, a token label needs no coarser fallback.
 */
export function formatTokensAxis(value: number | null | undefined): string {
  return formatTokensPrecise(value);
}

/**
 * One formatter per metric for axis labels, so the two charts use the same
 * digit rules. This is the tight budget: it must fit the left gutter.
 */
export function formatAxisValue(metric: 'spend' | 'tokens', value: number | null | undefined): string {
  return metric === 'spend' ? formatSpendAxis(value) : formatTokensAxis(value);
}

/**
 * The display formatter for strip cells and headlines.
 *
 * This is deliberately richer than the axis formatter: a headline is the one
 * number the reader is looking at, so it keeps four significant digits below a
 * dollar (`$0.06480`) where an axis label would not. Tokens use the same
 * budget, so a token total and a spend total of the same relative size are
 * stated to the same precision.
 */
export function formatMetricValue(metric: 'spend' | 'tokens', value: number | null | undefined): string {
  if (metric === 'spend') return formatSpendCompact(value);
  return formatTokensPrecise(value);
}

/**
 * Token count at four significant digits, with K/M/B above a thousand.
 *
 * The strip and the headline need more resolution than the compact two-digit
 * form: `3.755M` says whether the number moved, `3.75M` can hide a real change.
 */
export function formatTokensPrecise(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}${trimZerosFixed(formatSignificant(abs / 1_000_000_000))}B`;
  if (abs >= 1_000_000) return `${sign}${trimZerosFixed(formatSignificant(abs / 1_000_000))}M`;
  if (abs >= 1_000) return `${sign}${trimZerosFixed(formatSignificant(abs / 1_000))}K`;
  return `${sign}${Math.round(abs)}`;
}

export function compactNumber(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}${trimZeros(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${sign}${trimZeros(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}${trimZeros(abs / 1_000)}K`;
  return `${sign}${Math.round(abs)}`;
}

function trimZeros(value: number): string {
  const fixed = value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return fixed.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1');
}

/** Compact token notation for the strip, e.g. 148.2K, 1.24M. */
export function formatTokensCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return compactNumber(value);
}

/** Exact token count for detail views. */
export function formatTokensExact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return value.toLocaleString('en-US');
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return value.toLocaleString('en-US');
}

/** Relative age label used on the time axis, e.g. 5m, 3h, 2d, 6mo. */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return DASH;
  const sec = ms / 1000;
  if (sec < 1) return 'now';
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = sec / 60;
  if (min < 60) return `${Math.round(min)}m`;
  const hr = min / 60;
  if (hr < 24) return `${Math.round(hr)}h`;
  const day = hr / 24;
  if (day < 30) return `${Math.round(day)}d`;
  const mo = day / 30.44;
  if (mo < 12) return `${Math.round(mo)}mo`;
  return `${Math.round(day / 365.25)}y`;
}

export function formatClock(iso: string, opts: { seconds?: boolean; hour12?: boolean } = {}): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return DASH;
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    ...(opts.seconds ? { second: '2-digit' } : {}),
    hour12: opts.hour12 ?? false,
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return DASH;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatAgeSince(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return DASH;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return DASH;
  const delta = now - then;
  if (delta < 0) return 'now';
  return `${formatAge(delta)} ago`;
}
