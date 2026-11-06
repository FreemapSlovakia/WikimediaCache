/**
 * WMC05: a failing SQLite store must not hide a valid legacy JPEG.
 *
 *   npx tsx test/legacyFallback.test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { check, finish, setupEnv, writeFile } from './helpers.js';

const env = setupEnv('legacy');
const { getCachePath } = await import('../src/cachePaths.js');
const store = await import('../src/thumbStore.js');

const JPEG = Buffer.from('LEGACY_JPEG_BYTES');

console.log('write fails (shard locked by another writer), read works:');
{
  // Shard 2 exists and another connection holds the write lock.
  store.getThumb(2, 120);
  const locker = new Database(path.join(env.dbDir, 'thumbs-02.db'));
  locker.pragma('busy_timeout = 0');
  locker.exec('BEGIN IMMEDIATE');
  writeFile(getCachePath(2, 120), JPEG);
  let hit: { data: Buffer } | undefined;
  let error: unknown;
  try {
    hit = store.getThumbOrLegacy(2, 120);
  } catch (e) {
    error = e;
  }
  check(!error, `no exception (${error})`);
  check(hit?.data.equals(JPEG), 'legacy bytes returned');
  check(fs.existsSync(getCachePath(2, 120)), 'legacy file kept');
  locker.exec('ROLLBACK');
  locker.close();
  check(store.getThumbOrLegacy(2, 120)?.data.equals(JPEG), 'after the lock is gone the copy works');
  check(store.getThumb(2, 120)?.equals(JPEG), 'row now in SQLite');
}

console.log('store cannot even open (lookup fails):');
{
  store.closeThumbStore();
  // THUMB_DB_DIR is read once; make it unusable by replacing it with a file.
  fs.rmSync(env.dbDir, { recursive: true, force: true });
  fs.writeFileSync(env.dbDir, 'not a directory');
  writeFile(getCachePath(3, 120), JPEG);
  let hit: { data: Buffer } | undefined;
  let error: unknown;
  try {
    hit = store.getThumbOrLegacy(3, 120);
  } catch (e) {
    error = e;
  }
  check(!error, `no exception (${error})`);
  check(hit?.data.equals(JPEG), 'legacy bytes returned');
  let has: boolean | undefined;
  try {
    has = store.hasThumbOrLegacy(3, 120);
  } catch (e) {
    error = e;
  }
  check(has === true, 'hasThumbOrLegacy sees the legacy file');
  check(store.getThumbOrLegacy(4, 120) === undefined, 'nothing anywhere -> undefined, no exception');
}

store.closeThumbStore();
finish();
