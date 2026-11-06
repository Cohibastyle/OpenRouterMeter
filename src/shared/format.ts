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

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

/** Relative age label used on the logarithmic axis, e.g. 5m, 3h, 2d, 6mo. */
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

export function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${value.slice(0, head)}\u2026${value.slice(value.length - tail)}`;
}
