/**
 * runFullCleanup() removes every subdirectory of CACHE_DIR. A THUMB_DB_DIR
 * inside CACHE_DIR would take the open SQLite shards with it, so thumbStore
 * refuses such a configuration at start.
 *
 *   npx tsx test/storeDirs.test.ts
 */
import path from 'node:path';
import { check, finish, setupEnv } from './helpers.js';

const env = setupEnv('dirs');
process.env.THUMB_DB_DIR = path.join(env.cacheDir, 'thumbs-db');
let error: unknown;
try {
  await import('../src/thumbStore.js');
} catch (e) {
  error = e;
}
check(error instanceof Error && /inside CACHE_DIR/.test(error.message), `THUMB_DB_DIR inside CACHE_DIR refused (${error})`);
finish();
