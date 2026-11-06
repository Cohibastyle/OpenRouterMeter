/**
 * Money is stored as integer micro-dollars (1e-6 USD) everywhere in the app.
 * Summing integers is exact, which satisfies the "never binary floating point
 * for accounting totals" rule in FSD section 8.
 */
export const MICRO = 1_000_000;

export function microFromDecimalString(value: string): number {
  const trimmed = value.trim();
  if (trimmed === '') return 0;
  const negative = trimmed.startsWith('-');
  const body = negative ? trimmed.slice(1) : trimmed;
  const [whole = '0', frac = ''] = body.split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  const micro = Number(whole) * MICRO + Number(fracPadded);
  if (!Number.isFinite(micro)) throw new Error(`invalid money value: ${value}`);
  return negative ? -micro : micro;
}

export function microFromNumber(value: number): number {
  return Math.round(value * MICRO);
}

export function microToDecimalString(micro: number): string {
  const negative = micro < 0;
  const abs = Math.abs(micro);
  const whole = Math.floor(abs / MICRO);
  const frac = String(abs % MICRO).padStart(6, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

export function sumMicro(values: ReadonlyArray<number | null | undefined>): number {
  let total = 0;
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) total += value;
  }
  return total;
}

/** Sum that returns null when every input is null, so missing never becomes zero. */
export function sumMicroOrNull(values: ReadonlyArray<number | null | undefined>): number | null {
  let seen = false;
  let total = 0;
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      seen = true;
      total += value;
    }
  }
  return seen ? total : null;
}

export function sumIntOrNull(values: ReadonlyArray<number | null | undefined>): number | null {
  return sumMicroOrNull(values);
}
