import { microFromNumber } from './money.js';
import type { KeyRecord, RequestRecord } from './types.js';

/**
 * Deterministic sample data. Every value produced here is labeled sample data
 * in the UI until a real account is connected, per FSD section 1.
 */

const MODELS = [
  'anthropic/claude-sonnet-4.5',
  'openai/gpt-5.1',
  'google/gemini-3-pro',
  'deepseek/deepseek-v3.2',
  'meta-llama/llama-4-maverick',
  'qwen/qwen3-coder',
  'mistralai/mistral-large-2512',
  'x-ai/grok-4.6',
];

const KEYS: KeyRecord[] = [
  { id: 'key_prod', name: 'prod-key', removed: false, last4: 'a91f' },
  { id: 'key_dev', name: 'dev-key', removed: false, last4: '7c02' },
  { id: 'key_ci', name: 'ci-runner', removed: false, last4: '3d55' },
  { id: 'key_old', name: 'legacy-key', removed: true, last4: 'e410' },
];

/** Small deterministic PRNG so sample data is stable across restarts. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleKeys(): KeyRecord[] {
  return KEYS.map((k) => ({ ...k }));
}

export interface SampleOptions {
  now?: number;
  /** How far back to generate, in ms. Default 120 days. */
  horizonMs?: number;
  /** Average requests per hour. Default 2. */
  ratePerHour?: number;
}

/**
 * Generate request records with a realistic diurnal pattern and a long tail, so
 * the time axis has something meaningful to show.
 */
export function generateSampleRequests(options: SampleOptions = {}): RequestRecord[] {
  const now = options.now ?? Date.now();
  const horizon = options.horizonMs ?? 120 * 24 * 60 * 60 * 1000;
  const ratePerHour = options.ratePerHour ?? 2;
  const random = mulberry32(20261106);
  const records: RequestRecord[] = [];

  const start = now - horizon;
  const hourMs = 60 * 60 * 1000;
  const totalHours = Math.floor(horizon / hourMs);

  for (let h = 0; h < totalHours; h += 1) {
    const hourStart = start + h * hourMs;
    const hourOfDay = new Date(hourStart).getHours();
    // Diurnal weighting: busier during working hours.
    const diurnal = 0.35 + 0.9 * Math.max(0, Math.sin(((hourOfDay - 5) / 24) * Math.PI * 2) * 0.5 + 0.5);
    // Recency weighting: more detail in the last day.
    const ageHours = (now - hourStart) / hourMs;
    const recency = ageHours < 24 ? 2.2 : ageHours < 24 * 7 ? 1.4 : 1;
    const expected = ratePerHour * diurnal * recency;
    const count = Math.max(0, Math.round(expected + (random() - 0.5) * expected * 0.8));

    for (let i = 0; i < count; i += 1) {
      const eventTime = hourStart + Math.floor(random() * hourMs);
      if (eventTime > now) continue;
      const key = KEYS[Math.floor(random() * KEYS.length)]!;
      const model = MODELS[Math.floor(random() * MODELS.length)]!;
      const input = 400 + Math.floor(random() * 9000);
      const output = 80 + Math.floor(random() * 2600);
      const total = input + output;
      // Roughly $3 per million input tokens and $15 per million output tokens.
      const cost = (input / 1_000_000) * 3 + (output / 1_000_000) * 15;
      const failed = random() < 0.03;
      records.push({
        id: `sample:${eventTime}:${i}`,
        event_time: new Date(eventTime).toISOString(),
        received_time: new Date(eventTime + 1500).toISOString(),
        key_id: key.id,
        key_name: key.name,
        model,
        status: failed ? 'error' : 'success',
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        cost_micro: microFromNumber(failed ? cost * 0.1 : cost),
        source: 'sample',
      });
    }
  }

  records.sort((a, b) => new Date(b.event_time).getTime() - new Date(a.event_time).getTime());
  return records;
}

export function sampleCredits(): { total_credits_micro: number; total_usage_micro: number } {
  return {
    total_credits_micro: microFromNumber(250),
    total_usage_micro: microFromNumber(87.4213),
  };
}
