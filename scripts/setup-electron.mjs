import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

/**
 * Fetch the Electron binary when the npm postinstall step did not run.
 * Downloads the platform archive from the official GitHub release and extracts
 * it into node_modules/electron/dist, then writes path.txt.
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const electronDir = join(root, 'node_modules', 'electron');
const distDir = join(electronDir, 'dist');

if (!existsSync(electronDir)) {
  console.error('node_modules/electron is missing. Run npm install first.');
  process.exit(1);
}

const version = JSON.parse(
  execFileSync(process.execPath, ['-p', 'JSON.stringify(require("./node_modules/electron/package.json"))'], {
    cwd: root,
    encoding: 'utf8',
  }),
).version;

const platform = process.platform;
const arch = process.arch;
const archiveName = `electron-v${version}-${platform}-${arch}.zip`;
const url = `https://github.com/electron/electron/releases/download/v${version}/${archiveName}`;

console.log(`Downloading ${archiveName} ...`);
const response = await fetch(url, { redirect: 'follow' });
if (!response.ok || !response.body) {
  console.error(`Download failed: ${response.status} ${response.statusText}`);
  process.exit(1);
}

const tmpZip = join(root, `.electron-${version}.zip`);
await pipeline(Readable.fromWeb(response.body), createWriteStream(tmpZip));

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

if (platform === 'win32') {
  execFileSync('powershell', ['-command', `Expand-Archive -Path "${tmpZip}" -DestinationPath "${distDir}" -Force`], {
    stdio: 'inherit',
  });
} else {
  execFileSync('unzip', ['-q', '-o', tmpZip, '-d', distDir], { stdio: 'inherit' });
}

const relative =
  platform === 'darwin'
    ? 'Electron.app/Contents/MacOS/Electron'
    : platform === 'win32'
      ? 'electron.exe'
      : 'electron';

execFileSync(process.execPath, [
  '-e',
  `require('node:fs').writeFileSync(${JSON.stringify(join(electronDir, 'path.txt'))}, ${JSON.stringify(relative)})`,
]);

rmSync(tmpZip, { force: true });
console.log(`Electron ${version} installed.`);
