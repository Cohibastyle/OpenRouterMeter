/**
 * Measure startup time and resident memory for a running app.
 *
 * Startup is measured as the time from spawn to the first sample where the
 * process has a resident set above a small floor, which is a proxy for "the
 * window exists". Memory is the RSS of the whole process tree, because both
 * builds spawn helpers.
 */
import { execFileSync, spawn } from 'node:child_process';

const target = process.argv[2];
if (!target) {
  console.error('usage: measure-runtime.mjs <binary> [args...]');
  process.exit(1);
}
const args = process.argv.slice(3);

function treeRssKb(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
    let total = Number(out.trim()) || 0;
    // Include children, since both builds spawn helper processes.
    let kids = '';
    try {
      kids = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim();
    } catch {
      kids = '';
    }
    for (const kid of kids.split('\n').filter(Boolean)) {
      total += treeRssKb(Number(kid));
    }
    return total;
  } catch {
    return 0;
  }
}

const started = Date.now();
const child = spawn(target, args, { stdio: 'ignore', detached: false });

let firstPaintMs = null;
const poll = setInterval(() => {
  const rss = treeRssKb(child.pid);
  if (firstPaintMs === null && rss > 20_000) firstPaintMs = Date.now() - started;
}, 50);

await new Promise((r) => setTimeout(r, 8000));
clearInterval(poll);

const rssKb = treeRssKb(child.pid);
child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 500));

console.log(
  JSON.stringify({
    startup_ms: firstPaintMs,
    rss_mb: Math.round(rssKb / 1024),
  }),
);
