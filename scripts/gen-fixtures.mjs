/**
 * Generate the sample rows the Tauri shell seeds an empty database with.
 *
 * The Rust side builds the snapshot from the stored rows, so only the raw
 * inputs are fixtures: sample requests, the key list, and the default settings.
 * A precomputed snapshot would be a second source of truth that nothing reads.
 */
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'src-tauri', 'fixtures');

const entry = `
import { generateSampleRequests, sampleKeys } from '${join(root, 'src/shared/sample.ts').replace(/\\/g, '/')}';
import { DEFAULT_SETTINGS } from '${join(root, 'src/shared/settings.ts').replace(/\\/g, '/')}';

const now = Date.now();
const requests = generateSampleRequests({ now });
const keys = sampleKeys();

export const fixture = { requests, keys, settings: DEFAULT_SETTINGS };
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
const { requests, keys, settings } = mod.fixture;

await mkdir(out, { recursive: true });
await writeFile(join(out, 'requests.json'), JSON.stringify(requests.slice(0, 500), null, 2));
await writeFile(join(out, 'keys.json'), JSON.stringify(keys, null, 2));
await writeFile(join(out, 'settings.json'), JSON.stringify(settings, null, 2));

console.log(`fixtures written: ${requests.length} requests, ${keys.length} keys`);
