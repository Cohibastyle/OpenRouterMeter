import { build } from 'esbuild';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = await mkdtemp(join(tmpdir(), 'orw-tests-'));

// Bundle each test file with esbuild so TypeScript sources and their .js
// specifiers resolve without a separate compile step.
const testsDir = join(root, 'tests');
const files = (await readdir(testsDir)).filter((f) => f.endsWith('.test.ts'));

for (const file of files) {
  await build({
    entryPoints: [join(testsDir, file)],
    outfile: join(out, file.replace(/\.ts$/, '.mjs')),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: ['node:*'],
    logLevel: 'error',
  });
}

const child = spawn(process.execPath, ['--test', ...files.map((f) => join(out, f.replace(/\.ts$/, '.mjs')))], {
  stdio: 'inherit',
});

child.on('exit', async (code) => {
  await rm(out, { recursive: true, force: true });
  process.exit(code ?? 1);
});
