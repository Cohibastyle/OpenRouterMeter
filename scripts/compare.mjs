/**
 * Compare the Electron and Tauri builds.
 *
 * Reports artifact size, startup time, and resident memory for both. Run from
 * the Tauri worktree with the Electron build already produced in the main
 * worktree.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const electronRoot = join(root, '..', 'Openrouter monitor');

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function findDmg(dir) {
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir).find((f) => f.endsWith('.dmg'));
  return hit ? join(dir, hit) : null;
}

function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}

const rows = [];

const electronDmg = findDmg(join(electronRoot, 'dist'));
if (electronDmg) {
  rows.push(['Electron', 'DMG', mb(statSync(electronDmg).size)]);
  const app = join(electronRoot, 'dist', 'mac-arm64', 'OpenRouter Meter.app');
  if (existsSync(app)) rows.push(['Electron', 'app (unpacked)', mb(dirSize(app))]);
}

const tauriDmg = findDmg(join(root, 'src-tauri', 'target', 'release', 'bundle', 'dmg'));
if (tauriDmg) {
  rows.push(['Tauri', 'DMG', mb(statSync(tauriDmg).size)]);
}
const tauriApp = join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'OpenRouter Meter.app');
if (existsSync(tauriApp)) rows.push(['Tauri', 'app (unpacked)', mb(dirSize(tauriApp))]);

const tauriBin = join(root, 'src-tauri', 'target', 'release', 'openrouter-meter');
if (existsSync(tauriBin)) rows.push(['Tauri', 'binary', mb(statSync(tauriBin).size)]);

// Runtime numbers are measured separately by scripts/measure-runtime.mjs and
// passed in as JSON so this script stays a pure reporter.
const runtime = process.env.RUNTIME_JSON ? JSON.parse(process.env.RUNTIME_JSON) : null;
if (runtime) {
  rows.push(['Electron', 'startup', `${runtime.electron.startup_ms} ms`]);
  rows.push(['Electron', 'memory (RSS)', `${runtime.electron.rss_mb} MB`]);
  rows.push(['Tauri', 'startup', `${runtime.tauri.startup_ms} ms`]);
  rows.push(['Tauri', 'memory (RSS)', `${runtime.tauri.rss_mb} MB`]);
}

const width = [10, 16, 14];
const header = ['Build', 'Artifact', 'Size'];
console.log(header.map((h, i) => h.padEnd(width[i])).join(''));
console.log(width.map((w) => '-'.repeat(w)).join(''));
for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(width[i])).join(''));
