import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(join(dist, 'main'), { recursive: true });
  await mkdir(join(dist, 'preload'), { recursive: true });
  await mkdir(join(dist, 'renderer'), { recursive: true });

  const common = {
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: true,
    logLevel: 'info',
    external: ['electron'],
  };

  await build({
    ...common,
    entryPoints: [join(root, 'src/main/index.ts')],
    outfile: join(dist, 'main/index.js'),
  });

  await build({
    ...common,
    entryPoints: [join(root, 'src/preload/index.ts')],
    outfile: join(dist, 'preload/index.js'),
  });

  await build({
    bundle: true,
    platform: 'browser',
    target: 'chrome130',
    format: 'iife',
    sourcemap: true,
    logLevel: 'info',
    entryPoints: [join(root, 'src/renderer/index.ts')],
    outfile: join(dist, 'renderer/index.js'),
  });

  await cp(join(root, 'src/renderer/index.html'), join(dist, 'renderer/index.html'));
  await cp(join(root, 'src/renderer/styles'), join(dist, 'renderer/styles'), { recursive: true });

  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(
    join(dist, 'package.json'),
    JSON.stringify({ name: pkg.name, version: pkg.version, main: 'main/index.js' }, null, 2),
  );

  if (!existsSync(join(root, 'node_modules/electron/dist/Electron.app'))) {
    console.warn('\n[warn] Electron binary not found. Run: npm run setup:electron\n');
  }

  console.log('\nBuild complete -> dist/');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
