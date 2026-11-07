/**
 * Generate the sample snapshot the Tauri shell serves in Phase 1.
 *
 * Phase 1 proves the renderer runs unchanged in a WKWebView. Reimplementing the
 * accounting in Rust before that is proven would be wasted work, so the fixture
 * is produced by the existing TypeScript snapshot builder and committed as JSON.
 * Phase 3 replaces it with a live Rust implementation.
 */
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'src-tauri', 'fixtures');

const entry = `
import { buildSnapshot } from '${join(root, 'src/main/snapshot.ts').replace(/\\/g, '/')}';
import { generateSampleRequests, sampleKeys } from '${join(root, 'src/main/collectors/sample.ts').replace(/\\/g, '/')}';
import { DEFAULT_SETTINGS } from '${join(root, 'src/shared/settings.ts').replace(/\\/g, '/')}';
const SAMPLE_GRANULARITY_MS = 60 * 1000;

const now = Date.now();
const requests = generateSampleRequests({ now });
const keys = sampleKeys();

const snapshot = buildSnapshot({
  now,
  requests,
  scope: { kind: 'all' },
  account: {
    connected: false,
    state: 'not_connected',
    label: null,
    last4: null,
    saved_at: null,
    total_credits_micro: null,
    total_usage_micro: null,
  },
  collectionStatus: {
    last_success: new Date(now).toISOString(),
    last_error_code: null,
    last_error_message: null,
    last_error_at: null,
    retry_at: null,
    backoff_ms: 0,
    stale: false,
    expected_delay_sec: 60,
  },
  coverage: {
    earliest_reliable: new Date(now - 120 * 86400000).toISOString(),
    latest_source_date: new Date(now).toISOString().slice(0, 10),
    spend: 'full',
    tokens: 'full',
    requests: 'full',
    request_source: 'full_account',
    warnings: [],
  },
  sourceGranularityMs: SAMPLE_GRANULARITY_MS,
  collectionStartedAt: now - 120 * 86400000,
  gaps: [],
  collectionRanges: [],
  retentionHorizon: null,
  timeZone: 'UTC',
  sample: true,
  snapshotVersion: 1,
  todaySource: null,
  monthSource: null,
  counterToday: null,
  counterMonth: null,
});

export const fixture = { snapshot, requests, keys, settings: DEFAULT_SETTINGS };
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
const { snapshot, requests, keys, settings } = mod.fixture;

await mkdir(out, { recursive: true });
await writeFile(join(out, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
await writeFile(join(out, 'requests.json'), JSON.stringify(requests.slice(0, 500), null, 2));
await writeFile(join(out, 'keys.json'), JSON.stringify(keys, null, 2));
await writeFile(join(out, 'settings.json'), JSON.stringify(settings, null, 2));

console.log(`fixtures written: ${requests.length} requests, ${snapshot.windows.length} windows`);
