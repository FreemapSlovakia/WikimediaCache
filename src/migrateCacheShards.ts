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
 * migrated files inside shard subdirectories are left alone), and moves
 * (renameSync, same filesystem) rather than copies, so a re-run after a
 * partial/interrupted migration just picks up wherever it left off.
 */
import fs from 'fs';
import path from 'path';
import { CACHE_DIR, ensureShardDirsExist, getShardDir } from './cachePaths.js';

async function migrate() {
  ensureShardDirsExist();

  const entries = await fs.promises.readdir(CACHE_DIR, { withFileTypes: true });
  const flatFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.jpg'));
  console.log(`Found ${flatFiles.length} files directly in ${CACHE_DIR} to migrate.`);

  if (flatFiles.length === 0) {
    console.log('Nothing to migrate - cache is already sharded (or empty).');
    return;
  }

  let moved = 0;
  let skipped = 0;
  for (const entry of flatFiles) {
    const pageId = parseInt(entry.name.split('_')[0]!, 10);
    if (isNaN(pageId)) {
      console.warn(`Skipping unrecognized file name (no leading pageId): ${entry.name}`);
      skipped++;
      continue;
    }
    const src = path.join(CACHE_DIR, entry.name);
    const dest = path.join(CACHE_DIR, getShardDir(pageId), entry.name);
    try {
      fs.renameSync(src, dest);
      moved++;
    } catch (err: any) {
      console.error(`Failed to move ${entry.name}: ${err.message}`);
      skipped++;
    }
    if (moved % 10000 === 0) {
      process.stdout.write(`\rMigrated ${moved}/${flatFiles.length}...`);
    }
  }
  console.log(`\nMigration complete. Moved ${moved} files into shard subdirectories.${skipped > 0 ? ` Skipped ${skipped}.` : ''}`);
}

migrate().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
