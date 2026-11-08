/**
 * Build the Tauri frontend.
 *
 * The renderer bundle is byte-identical to the Electron build; the only
 * difference is a small prelude that installs `window.widget` over Tauri's
 * invoke/listen before the renderer runs.
 */
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'dist', 'renderer');

await rm(join(root, 'dist'), { recursive: true, force: true });
await mkdir(out, { recursive: true });

// 1. The bridge prelude, as its own bundle so it runs first.
await build({
  entryPoints: [join(root, 'src-tauri/frontend/tauriBridge.ts')],
  outfile: join(out, 'bridge.js'),
  bundle: true,
  platform: 'browser',
  target: 'safari15',
  format: 'iife',
  globalName: 'TauriBridge',
  logLevel: 'info',
});

// 2. The renderer, unchanged from the Electron build.
await build({
  entryPoints: [join(root, 'src/renderer/index.ts')],
  outfile: join(out, 'index.js'),
  bundle: true,
  platform: 'browser',
  target: 'safari15',
  format: 'iife',
  logLevel: 'info',
});

// 2b. Standalone animation lab for headline + chip behavior testing.
await build({
  entryPoints: [join(root, 'src/renderer/delta-lab.ts')],
  outfile: join(out, 'delta-lab.js'),
  bundle: true,
  platform: 'browser',
  target: 'safari15',
  format: 'iife',
  logLevel: 'info',
});

await cp(join(root, 'src/renderer/styles'), join(out, 'styles'), { recursive: true });

// 3. The HTML, with the bridge prelude inserted before the renderer script.
const html = await (await import('node:fs/promises')).readFile(join(root, 'src/renderer/index.html'), 'utf8');
// bridge.js self-installs; an inline call would be blocked by `script-src 'self'`.
const withBridge = html.replace(
  '<script src="index.js"></script>',
  '<script src="bridge.js"></script>\n    <script src="index.js"></script>',
);
await (await import('node:fs/promises')).writeFile(join(out, 'index.html'), withBridge);
await cp(join(root, 'src/renderer/delta-lab.html'), join(out, 'delta-lab.html'));

console.log('\nTauri frontend built -> dist/renderer');
