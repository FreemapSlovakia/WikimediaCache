/**
 * WikiMediaCache Microservice for Freemap
 * Open-source project for caching Wikimedia Commons thumbnails.
 * Author: Ladislav Nagy
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CACHE_DIR = path.join(__dirname, '../cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Shards the cache/ directory into NUM_SHARDS subdirectories ("000".."999")
// keyed by page_id, so no single directory ever holds more than roughly
// (total files / NUM_SHARDS) entries. A flat directory with hundreds of
// thousands to millions of files (the idle cache warmer's staged SVK -> V4
// -> EU escalation can realistically reach that scale) makes every
// readdir()/stat() pass noticeably slower - and /status in particular is
// polled frequently by uptime monitoring, so that slowdown is user-visible.
export const NUM_SHARDS = 1000;

export function getShardDir(pageId: number | string): string {
  const id = typeof pageId === 'string' ? parseInt(pageId, 10) : pageId;
  const shard = ((id % NUM_SHARDS) + NUM_SHARDS) % NUM_SHARDS; // defensive against a stray negative id
  return String(shard).padStart(3, '0');
}

export function getCacheFileName(pageId: number | string, size: number): string {
  return `${pageId}_${size}.jpg`;
}

export function getCachePath(pageId: number | string, size: number): string {
  return path.join(CACHE_DIR, getShardDir(pageId), getCacheFileName(pageId, size));
}

// Pre-creates all shard subdirectories once, so getCachePath() callers never
// need to check-and-mkdir per file write (that's on the hot path for every
// thumbnail download).
export function ensureShardDirsExist(): void {
  for (let i = 0; i < NUM_SHARDS; i++) {
    const dir = path.join(CACHE_DIR, String(i).padStart(3, '0'));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

// Recursively lists all cached .jpg files across shard subdirectories.
// Returns paths RELATIVE to CACHE_DIR (e.g. "042/1234567_120.jpg"), so
// callers can still recover the plain file name via path.basename() same as
// before sharding, while being able to join(CACHE_DIR, relPath) for the
// real filesystem path. Ignores anything sitting directly in CACHE_DIR
// (stray pre-migration leftovers) - run migrateCacheShards.ts first.
export async function listCacheFilesRecursive(): Promise<string[]> {
  const entries = await fs.promises.readdir(CACHE_DIR, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const shardPath = path.join(CACHE_DIR, entry.name);
    const files = await fs.promises.readdir(shardPath);
    for (const f of files) {
      if (f.endsWith('.jpg')) results.push(path.join(entry.name, f));
    }
  }
  return results;
}
