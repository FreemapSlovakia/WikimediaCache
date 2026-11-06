/**
 * WikiMediaCache Microservice for Freemap
 * Open-source project for caching Wikimedia Commons thumbnails.
 * Author: Ladislav Nagy
 */

/**
 * One-time migration: moves existing flat cache/<pageId>_<size>.jpg files
 * into sharded cache/<shard>/<pageId>_<size>.jpg subdirectories (see
 * cachePaths.ts). Run this ONCE, with the server stopped, after upgrading to
 * the sharded cache layout - then start the server normally.
 *
 * Safe to re-run: only touches files sitting directly in CACHE_DIR (already-
 * migrated files inside shard subdirectories are left alone).
 *
 * Never overwrites: a file is published under its shard with link(), which
 * fails when the target exists, and only then is the flat name removed.
 * When the target already exists:
 *   - same inode (an earlier run stopped between link and unlink): the flat
 *     name is removed, nothing is lost;
 *   - identical bytes, separate file: both are kept and counted as duplicate;
 *   - different bytes: both are kept and reported as a conflict.
 * Exit code 3 when duplicates, conflicts or errors were left for inspection.
 */
import fs from 'fs';
import path from 'path';
import { CACHE_DIR, ensureShardDirsExist, getShardDir } from './cachePaths.js';

type Outcome = 'moved' | 'finished' | 'duplicate' | 'conflict';

/** Moves src to dest without ever replacing an existing dest. */
function moveNoClobber(src: string, dest: string): Outcome {
  try {
    fs.linkSync(src, dest);
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;
    const s = fs.statSync(src);
    const d = fs.statSync(dest);
    if (s.ino === d.ino && s.dev === d.dev) {
      fs.unlinkSync(src);
      return 'finished';
    }
    if (s.size === d.size && fs.readFileSync(src).equals(fs.readFileSync(dest))) return 'duplicate';
    return 'conflict';
  }
  fs.unlinkSync(src);
  return 'moved';
}

async function migrate(): Promise<number> {
  ensureShardDirsExist();

  const entries = await fs.promises.readdir(CACHE_DIR, { withFileTypes: true });
  const flatFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.jpg'));
  console.log(`Found ${flatFiles.length} files directly in ${CACHE_DIR} to migrate.`);

  if (flatFiles.length === 0) {
    console.log('Nothing to migrate - cache is already sharded (or empty).');
    return 0;
  }

  const stats = { moved: 0, finished: 0, duplicate: 0, conflict: 0, skipped: 0, failed: 0 };
  for (const entry of flatFiles) {
    const pageId = parseInt(entry.name.split('_')[0]!, 10);
    if (isNaN(pageId)) {
      console.warn(`Skipping unrecognized file name (no leading pageId): ${entry.name}`);
      stats.skipped++;
      continue;
    }
    const src = path.join(CACHE_DIR, entry.name);
    const dest = path.join(CACHE_DIR, getShardDir(pageId), entry.name);
    try {
      const outcome = moveNoClobber(src, dest);
      stats[outcome]++;
      if (outcome === 'conflict') {
        console.warn(`CONFLICT: ${entry.name} differs from ${path.relative(CACHE_DIR, dest)}, both kept`);
      } else if (outcome === 'duplicate') {
        console.warn(`Duplicate: ${entry.name} is identical to ${path.relative(CACHE_DIR, dest)}, both kept`);
      }
    } catch (err: any) {
      console.error(`Failed to move ${entry.name}: ${err.message}`);
      stats.failed++;
    }
    const done = stats.moved + stats.finished;
    if (done > 0 && done % 10000 === 0) {
      process.stdout.write(`\rMigrated ${done}/${flatFiles.length}...`);
    }
  }
  console.log(`\nMigration complete: ${JSON.stringify(stats)}`);
  if (stats.conflict) console.log(`${stats.conflict} conflicts: the flat file differs from the one already in the shard; both kept, compare them by hand.`);
  return stats.duplicate || stats.conflict || stats.failed || stats.skipped ? 3 : 0;
}

migrate().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
