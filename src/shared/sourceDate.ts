/**
 * Parse a date the OpenRouter API reports into an ISO instant.
 *
 * OpenRouter returns `YYYY-MM-DD HH:mm:ss` with no zone. Handing that to
 * `new Date()` reads it as local time, which shifts the day boundary and
 * attributes spend to the wrong calendar day, so a date without an explicit
 * zone is read as UTC here.
 *
 * An empty or unparseable value falls back to now rather than throwing: a
 * missing timestamp on one row must not fail the whole collection.
 */
export function parseSourceDate(value: string | null): string {
  if (!value) return new Date().toISOString();
  const trimmed = value.trim();
  // Already ISO with an explicit zone.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  // "YYYY-MM-DD HH:mm:ss" or "YYYY-MM-DD".
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(trimmed);
  if (m) {
    const [, y, mo, d, h = '00', mi = '00', sec = '00'] = m;
    const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
    return new Date(utc).toISOString();
  }
  const fallback = new Date(trimmed);
  return Number.isNaN(fallback.getTime()) ? new Date().toISOString() : fallback.toISOString();
}
