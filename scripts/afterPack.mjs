/**
 * electron-builder afterPack hook: trim macOS bundle size.
 *
 * `mac.electronLanguages` only prunes the top-level `Contents/Resources/*.lproj`
 * folders. Chromium's own translations live inside
 * `Electron Framework.framework/.../Resources/*.lproj` and are 44 MB of the
 * unpacked app, so they are removed here as well; the widget UI is English-only
 * and formats every date and number with an explicit `en-US` locale.
 *
 * SwiftShader (`libvk_swiftshader.dylib`, 16 MB) is a CPU fallback for machines
 * with no usable GPU. A 2D-only widget renders through the normal GPU path, so
 * the fallback is dropped too.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const KEPT_LANGUAGES = new Set(['en', 'en_GB', 'Base']);
const SUFFIXES = ['_FEMININE', '_MASCULINE', '_NEUTER'];

/** `en.lproj` -> `en`, and `af_MASCULINE.lproj` -> `af`. */
function languageOf(entry) {
  let base = entry.slice(0, -'.lproj'.length);
  for (const suffix of SUFFIXES) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  return base;
}

async function pruneLocales(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.lproj')) continue;
    if (KEPT_LANGUAGES.has(languageOf(entry))) continue;
    await rm(join(dir, entry), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

async function removeIfPresent(path) {
  try {
    await stat(path);
  } catch {
    return false;
  }
  await rm(path, { recursive: true, force: true });
  return true;
}

export default async function afterPack(context) {
  // Only the macOS bundle carries .lproj folders and SwiftShader.
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const frameworksPath = join(appPath, 'Contents', 'Frameworks');

  const frameworkLocales = await pruneLocales(
    join(frameworksPath, 'Electron Framework.framework', 'Versions', 'A', 'Resources'),
  );
  const appLocales = await pruneLocales(join(appPath, 'Contents', 'Resources'));

  const librariesPath = join(frameworksPath, 'Electron Framework.framework', 'Versions', 'A', 'Libraries');
  const swiftshader = await removeIfPresent(join(librariesPath, 'libvk_swiftshader.dylib'));
  const swiftshaderIcd = await removeIfPresent(join(librariesPath, 'vk_swiftshader_icd.json'));

  console.log(
    `  • trimmed bundle  locales=${frameworkLocales + appLocales} removed` +
      ` swiftshader=${swiftshader || swiftshaderIcd ? 'removed' : 'absent'}`,
  );
}
