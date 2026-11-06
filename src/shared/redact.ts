/**
 * Redaction rules applied at write time, never at display time, per FSD
 * section 10.8. Kept free of Electron imports so it can be unit tested.
 */
const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/\b(sk-or-v1-[A-Za-z0-9]{8})[A-Za-z0-9_-]+/g, '$1<redacted>'],
  [/\b(sk-[A-Za-z0-9]{6})[A-Za-z0-9_-]{10,}/g, '$1<redacted>'],
  [/(authorization\s*[:=]\s*)(bearer\s+)?\S+/gi, '$1$2<redacted>'],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1<redacted>'],
  [/(api[_-]?key\s*[:=]\s*)\S+/gi, '$1<redacted>'],
  [/(["']?(?:prompt|messages|content|completion)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1<redacted>'],
];

export function redact(input: string): { text: string; redacted: boolean } {
  let text = input;
  let redacted = false;
  for (const [pattern, replacement] of REDACTIONS) {
    const next = text.replace(pattern, replacement);
    if (next !== text) redacted = true;
    text = next;
  }
  return { text, redacted };
}

/**
 * True when a value looks like an OpenRouter credential rather than a friendly
 * label. A real key label never starts with `sk-`, so the prefix alone is
 * enough, and it also catches partially masked forms such as
 * `sk-or-v1-1a5...753`.
 */
export function looksLikeCredential(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^sk-/i.test(value.trim());
}
