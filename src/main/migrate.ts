/**
 * One-time migration of the application data folder.
 *
 * Electron derives `userData` from `productName`, so renaming the product moves
 * the folder. Without this migration the widget would start against an empty
 * folder and appear to have lost the saved credential and all history.
 *
 * The migration copies rather than moves, so a failed or interrupted run leaves
 * the original intact and the next launch retries. It is idempotent: once the
 * destination holds a database, it does nothing.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface MigrationResult {
  migrated: boolean;
  from: string;
  to: string;
  /** Files copied, for the log. */
  files: number;
  /** Set when the migration was skipped or failed. */
  reason?: string;
}

/** True when the directory exists and holds at least one entry. */
function hasContent(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Copy `from` into `to` when `to` is empty and `from` is not.
 *
 * @param from Absolute path of the old data folder.
 * @param to Absolute path of the new data folder.
 */
export function migrateUserData(from: string, to: string): MigrationResult {
  if (from === to) return { migrated: false, from, to, files: 0, reason: 'same_path' };
  if (!hasContent(from)) return { migrated: false, from, to, files: 0, reason: 'no_source' };
  // A destination that already holds a database is authoritative: never
  // overwrite data the user has been writing to since the rename.
  if (existsSync(join(to, 'widget.db'))) {
    return { migrated: false, from, to, files: 0, reason: 'destination_exists' };
  }

  try {
    mkdirSync(to, { recursive: true });
    // Copy entry by entry rather than with `cpSync(from, to)`: Electron creates
    // the destination folder before the app is ready, so a whole-directory copy
    // fails with EEXIST. Copying the children also leaves Electron's own fresh
    // cache files alone.
    const copied = copyContents(from, to);
    return { migrated: copied > 0, from, to, files: copied };
  } catch (error) {
    return { migrated: false, from, to, files: 0, reason: (error as Error).message };
  }
}

/**
 * Copy files from `from` into `to`, skipping anything already present and any
 * entry that is a socket or lock held by a running process. Returns the number
 * of files copied.
 */
function copyContents(from: string, to: string): number {
  let copied = 0;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    // Locks and sockets belong to a running instance and must not be copied.
    if (/^(Singleton|DIPS-wal|SharedStorage-wal)/.test(entry.name)) continue;
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      copied += copyContents(src, dest);
    } else if (entry.isFile() && !existsSync(dest)) {
      copyFileSync(src, dest);
      copied += 1;
    }
  }
  return copied;
}

function countFiles(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) total += countFiles(join(dir, entry.name));
      else total += 1;
    }
  } catch {
    // Counting is for the log only.
  }
  return total;
}

/**
 * Move a file into place, falling back to copy when the source and destination
 * are on different volumes.
 */
export function moveFile(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    return true;
  } catch {
    try {
      cpSync(from, to, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}
