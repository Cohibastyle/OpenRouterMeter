/**
 * Capture the Tauri window at the same sizes the Electron --capture mode uses,
 * so the two sets can be pixel-diffed.
 *
 * Uses macOS `screencapture -l <windowid>` against the window's CGWindowID,
 * which avoids including the desktop behind a transparent window.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'captures-tauri');
mkdirSync(out, { recursive: true });

const SIZES = [
  ['01-spending-micro-180x120', 180, 120],
  ['02-spending-compact-320x240', 320, 240],
  ['03-spending-standard-480x360', 480, 360],
  ['04-spending-expanded-900x560', 900, 560],
];

function windowId() {
  // The app sets its window title; find the matching CGWindowID.
  const script = `
    tell application "System Events"
      set procs to every process whose name contains "openrouter"
      repeat with p in procs
        try
          set w to first window of p
          return id of w
        end try
      end repeat
    end tell
    return 0`;
  try {
    return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
  } catch {
    return '0';
  }
}

const id = windowId();
console.log(`window id: ${id}`);

for (const [name, w, h] of SIZES) {
  // Resize via AppleScript, then capture the window by id.
  const resize = `
    tell application "System Events"
      set procs to every process whose name contains "openrouter"
      repeat with p in procs
        try
          set size of first window of p to {${w}, ${h}}
        end try
      end repeat
    end tell`;
  try {
    execFileSync('osascript', ['-e', resize]);
  } catch {
    // Resizing is best effort; the capture still records what is on screen.
  }
  await new Promise((r) => setTimeout(r, 700));
  const file = join(out, `${name}.png`);
  try {
    execFileSync('screencapture', ['-x', '-o', '-l', id, file]);
    console.log(`captured ${name}`);
  } catch (e) {
    console.log(`failed ${name}: ${e.message}`);
  }
}
