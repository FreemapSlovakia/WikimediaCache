/**
 * WMC06: the THUMB_DB_DIR / CACHE_DIR guard compares physical paths and
 * whole `..` components. Each case runs in its own process, because
 * thumbStore checks the directories at import time.
 *
 *   npx tsx test/storeDirsPhysical.test.ts
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { check, finish, tmpRoot } from './helpers.js';

function imports(cacheDir: string, dbDir: string): boolean {
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', '-e', "await import('./src/thumbStore.ts')"],
    { env: { ...process.env, CACHE_DIR: cacheDir, THUMB_DB_DIR: dbDir }, encoding: 'utf8' },
  );
  return r.status === 0;
}

const root = tmpRoot('dirs-physical');
const physical = path.join(root, 'physical-cache');
fs.mkdirSync(physical, { recursive: true });
const link = path.join(root, 'cache-link');
fs.symlinkSync(physical, link);

check(!imports(physical, physical), 'same directory refused');
check(!imports(physical, path.join(physical, 'thumbs-db')), 'direct child refused');
check(!imports(physical, path.join(physical, '..thumbs')), 'child named `..thumbs` refused');
check(!imports(link, path.join(physical, 'thumbs-db')), 'symlinked CACHE_DIR, physical DB path refused');
check(!imports(physical, path.join(link, 'thumbs-db')), 'DB path through a symlink to the cache refused');
check(imports(physical, path.join(root, 'thumbs-db')), 'separate sibling directory accepted');
check(imports(link, path.join(root, 'thumbs-db')), 'symlinked cache with separate DB accepted');

fs.rmSync(root, { recursive: true, force: true });
finish();
