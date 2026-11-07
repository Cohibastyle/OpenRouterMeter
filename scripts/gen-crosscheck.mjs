/**
 * Generate a deterministic cross-check fixture.
 *
 * Both implementations are given the same fixed `now` and the same request
 * rows, so their snapshots must agree exactly. This is what proves the Rust
 * port of the accounting is faithful rather than merely plausible.
 */
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'src-tauri', 'fixtures');

// A fixed instant so both sides compute identical window boundaries.
const NOW = 1_760_000_000_000;

const entry = `
import { buildSnapshot } from '${join(root, 'src/shared/snapshot.ts').replace(/\\/g, '/')}';
import { generateSampleRequests } from '${join(root, 'src/shared/sample.ts').replace(/\\/g, '/')}';

const NOW = ${NOW};
const requests = generateSampleRequests({ now: NOW });

const snapshot = buildSnapshot({
  now: NOW,
  requests,
  scope: { kind: 'all' },
  account: { connected: false, state: 'not_connected', label: null, last4: null, saved_at: null, total_credits_micro: null, total_usage_micro: null },
  collectionStatus: { last_success: new Date(NOW).toISOString(), last_error_code: null, last_error_message: null, last_error_at: null, retry_at: null, backoff_ms: 0, stale: false, expected_delay_sec: 60 },
  coverage: { earliest_reliable: null, latest_source_date: null, spend: 'full', tokens: 'full', requests: 'full', request_source: 'full_account', warnings: [] },
  sourceGranularityMs: 60000,
  collectionStartedAt: null,
  gaps: [],
  collectionRanges: [],
  retentionHorizon: null,
  timeZone: 'UTC',
  // Pinned so the fixture is identical wherever it is generated. Without this
  // the day and month boundaries come from the ambient zone, so a fixture built
  // in one zone and asserted in another disagrees on the today total.
  utcOffsetMs: 0,
  sample: true,
  snapshotVersion: 1,
  todaySource: null,
  monthSource: null,
  counterToday: null,
  counterMonth: null,
});

export const fixture = { snapshot, requests };
`;

const bundle = await build({
  stdin: { contents: entry, resolveDir: root, loader: 'ts' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  write: false,
  external: ['node:*'],
});

const code = bundle.outputFiles[0].text;
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const { snapshot, requests } = mod.fixture;

await mkdir(out, { recursive: true });
await writeFile(join(out, 'crosscheck-now.txt'), String(NOW));
await writeFile(join(out, 'crosscheck-requests.json'), JSON.stringify(requests));
await writeFile(join(out, 'crosscheck-expected.json'), JSON.stringify(snapshot, null, 2));

console.log(`cross-check fixture: now=${NOW}, ${requests.length} requests`);
console.log('expected windows:', snapshot.windows.map((w) => `${w.key}=${w.spend_micro}`).join(' '));
console.log('expected today:', snapshot.today.spend_micro, 'month:', snapshot.month.spend_micro);
