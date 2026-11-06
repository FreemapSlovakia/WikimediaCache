/**
 * SQLite-backed thumbnail store.
 *
 * Replaces the one-file-per-thumbnail cache, which exhausts ext4 inodes
 * (millions of ~5 KB JPEGs). Thumbnails live as BLOBs in SHARD_COUNT
 * database files; shard = pageId % SHARD_COUNT.
 *
 * Key: pageId * SIZE_SLOTS + size, stored as INTEGER PRIMARY KEY (the rowid),
 * which is the fastest lookup SQLite has.
 *
 * Concurrency: WAL mode, so the server, importDump and the migration script
 * can all open the same files. One writer at a time per shard; busy_timeout
 * makes the others wait instead of failing.
 *
 * better-sqlite3 is synchronous. A point lookup of a ~5 KB BLOB takes tens of
 * microseconds from page cache, so calling it on the event loop is fine.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CACHE_DIR, getCachePath, listCacheFilesRecursive } from './cachePaths.js';

/** Fixed forever: changing it requires a full re-migration. */
export const SHARD_COUNT = 64;

/** Sizes must be 1..SIZE_SLOTS-1 (thumbnail width in px). */
const SIZE_SLOTS = 4096;

export const THUMB_DB_DIR =
  process.env.THUMB_DB_DIR || path.join(path.dirname(CACHE_DIR), 'thumbs-db');

/**
 * page_size only applies to a new, empty file; changing it later needs VACUUM.
 * PAGE_SIZE_DEFAULT was chosen by the benchmark in ZADANIE.md (step 3.4).
 */
const PAGE_SIZE_DEFAULT = 4096;
const PAGE_SIZE = (() => {
  const n = Number(process.env.THUMB_DB_PAGE_SIZE || PAGE_SIZE_DEFAULT);
  // SQLite silently ignores anything that is not a power of two in 512..65536.
  if (!Number.isInteger(n) || n < 512 || n > 65536 || (n & (n - 1)) !== 0) {
    throw new Error(`thumbStore: invalid THUMB_DB_PAGE_SIZE ${process.env.THUMB_DB_PAGE_SIZE}`);
  }
  return n;
})();

interface Shard {
  db: Database.Database;
  get: Database.Statement;
  entry: Database.Statement;
  has: Database.Statement;
  put: Database.Statement;
  putIfMissing: Database.Statement;
  del: Database.Statement;
  meta: Database.Statement;
  list: Database.Statement;
  count: Database.Statement;
}

export interface ThumbMeta {
  bytes: number;
  /** Unix time in seconds. */
  updated: number;
}

export interface ThumbEntry {
  data: Buffer;
  /** Unix time in seconds. */
  updated: number;
}

export interface ThumbRef {
  pageId: number;
  size: number;
}

const shards: (Shard | undefined)[] = new Array(SHARD_COUNT);

/**
 * NORMAL for the server: in WAL mode a commit survives a crash of the process,
 * and the server never deletes anything a lost commit would leave missing.
 * The destructive migration switches its own connections to FULL
 * (useDurableWrites), so its commits survive a power or OS failure too.
 */
let synchronousMode: 'NORMAL' | 'FULL' = 'NORMAL';

function toPageId(pageId: number | string): number {
  const n = typeof pageId === 'string' ? Number(pageId) : pageId;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`thumbStore: invalid pageId ${pageId}`);
  return n;
}

function keyOf(pageId: number | string, size: number): number {
  if (!Number.isInteger(size) || size <= 0 || size >= SIZE_SLOTS) {
    throw new Error(`thumbStore: invalid size ${size}`);
  }
  return toPageId(pageId) * SIZE_SLOTS + size;
}

function refOf(key: number): ThumbRef {
  return { pageId: Math.floor(key / SIZE_SLOTS), size: key % SIZE_SLOTS };
}

function shardIndex(pageId: number | string): number {
  return toPageId(pageId) % SHARD_COUNT;
}

function shardFile(i: number): string {
  return path.join(THUMB_DB_DIR, `thumbs-${String(i).padStart(2, '0')}.db`);
}

function openShard(i: number): Shard {
  fs.mkdirSync(THUMB_DB_DIR, { recursive: true });
  const db = new Database(shardFile(i));
  // auto_vacuum and page_size only take effect before the first table exists.
  db.pragma(`page_size = ${PAGE_SIZE}`);
  db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('journal_mode = WAL');
  db.pragma(`synchronous = ${synchronousMode}`);
  db.pragma('busy_timeout = 10000');
  db.pragma('cache_size = -4000');
  db.pragma('mmap_size = 268435456');
  db.exec(`CREATE TABLE IF NOT EXISTS thumb (
    id      INTEGER PRIMARY KEY,
    data    BLOB    NOT NULL,
    updated INTEGER NOT NULL
  )`);
  // Small index whose entries carry the rowid. count(*) and listThumbs() scan
  // it instead of the table: with ~5 KB BLOBs a table leaf holds only one or
  // two rows, so a full table scan reads most of the file (on cloud01 that
  // would be >10 GB for every /status count). Also lets us find old rows.
  db.exec('CREATE INDEX IF NOT EXISTS thumb_updated ON thumb (updated)');
  return {
    db,
    get: db.prepare('SELECT data FROM thumb WHERE id = ?').pluck(),
    entry: db.prepare('SELECT data, updated FROM thumb WHERE id = ?'),
    has: db.prepare('SELECT 1 FROM thumb WHERE id = ?').pluck(),
    put: db.prepare('INSERT OR REPLACE INTO thumb (id, data, updated) VALUES (?, ?, ?)'),
    putIfMissing: db.prepare('INSERT OR IGNORE INTO thumb (id, data, updated) VALUES (?, ?, ?)'),
    del: db.prepare('DELETE FROM thumb WHERE id = ?'),
    meta: db.prepare('SELECT length(data) AS bytes, updated FROM thumb WHERE id = ?'),
    // No ORDER BY: callers do not need an order, and it would force a table scan.
    list: db.prepare('SELECT id FROM thumb INDEXED BY thumb_updated').pluck(),
    count: db.prepare('SELECT count(*) FROM thumb INDEXED BY thumb_updated').pluck(),
  };
}

function shard(i: number): Shard {
  let s = shards[i];
  if (!s) {
    s = openShard(i);
    shards[i] = s;
  }
  return s;
}

/** Shard index of a pageId, for callers that group work per shard (durableShards). */
export function thumbShardIndex(pageId: number | string): number {
  return shardIndex(pageId);
}

/**
 * synchronous=FULL for this process's connections (open ones and future ones).
 * Only for the migration with --delete-source; the server stays on NORMAL.
 */
export function useDurableWrites(): void {
  synchronousMode = 'FULL';
  for (const s of shards) s?.db.pragma('synchronous = FULL');
}

/**
 * Durability barrier before deleting the source of migrated rows.
 *
 * A row that can be read back is not necessarily on disk: with
 * synchronous=NORMAL it may live only in the -wal file, unsynced, and a power
 * or OS failure would lose it. Rows the server wrote earlier (INSERT OR IGNORE
 * then commits nothing new) are in the same situation. A completed
 * wal_checkpoint(FULL) copies every committed frame into the .db file and
 * fsyncs it, whoever wrote the frame.
 *
 * Returns the shard indices for which the checkpoint completed (busy = 0 and
 * every WAL frame checkpointed). For any other shard the caller must keep the
 * source files. Never throws.
 */
export function durableShards(shardIndices: Iterable<number>): Set<number> {
  const ok = new Set<number>();
  for (const i of new Set(shardIndices)) {
    try {
      const [r] = shard(i).db.pragma('wal_checkpoint(FULL)') as {
        busy: number;
        log: number;
        checkpointed: number;
      }[];
      if (r && r.busy === 0 && r.log >= 0 && r.checkpointed === r.log) ok.add(i);
    } catch {
      // not confirmed -> not in the set
    }
  }
  return ok;
}

function shardFor(pageId: number | string): Shard {
  return shard(shardIndex(pageId));
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function getThumb(pageId: number | string, size: number): Buffer | undefined {
  return shardFor(pageId).get.get(keyOf(pageId, size)) as Buffer | undefined;
}

export function getThumbEntry(pageId: number | string, size: number): ThumbEntry | undefined {
  return shardFor(pageId).entry.get(keyOf(pageId, size)) as ThumbEntry | undefined;
}

export function hasThumb(pageId: number | string, size: number): boolean {
  return shardFor(pageId).has.get(keyOf(pageId, size)) !== undefined;
}

export function getThumbMeta(pageId: number | string, size: number): ThumbMeta | undefined {
  return shardFor(pageId).meta.get(keyOf(pageId, size)) as ThumbMeta | undefined;
}

export function putThumb(pageId: number | string, size: number, data: Buffer, updated = nowSeconds()): void {
  if (data.length === 0) throw new Error(`thumbStore: refusing empty thumbnail for ${pageId}/${size}`);
  shardFor(pageId).put.run(keyOf(pageId, size), data, updated);
}

/** Returns true when inserted, false when a row already existed (it is left untouched). */
export function putThumbIfMissing(
  pageId: number | string,
  size: number,
  data: Buffer,
  updated = nowSeconds(),
): boolean {
  if (data.length === 0) throw new Error(`thumbStore: refusing empty thumbnail for ${pageId}/${size}`);
  return shardFor(pageId).putIfMissing.run(keyOf(pageId, size), data, updated).changes > 0;
}

export function deleteThumb(pageId: number | string, size: number): boolean {
  return shardFor(pageId).del.run(keyOf(pageId, size)).changes > 0;
}

/** Bulk delete, one transaction per shard. Returns the number of rows removed. */
export function deleteThumbs(refs: Iterable<ThumbRef>): number {
  const byShard = new Map<number, number[]>();
  for (const r of refs) {
    const i = shardIndex(r.pageId);
    let keys = byShard.get(i);
    if (!keys) byShard.set(i, (keys = []));
    keys.push(keyOf(r.pageId, r.size));
  }
  let removed = 0;
  for (const [i, keys] of byShard) {
    const s = shard(i);
    s.db.transaction(() => {
      for (const k of keys) removed += s.del.run(k).changes;
    })();
  }
  return removed;
}

/**
 * Bulk insert used by the migration, one transaction per shard.
 * Existing rows are kept (INSERT OR IGNORE). Returns how many were new.
 */
export function putThumbsIfMissing(
  items: Iterable<ThumbRef & { data: Buffer; updated: number }>,
): number {
  const byShard = new Map<number, (ThumbRef & { data: Buffer; updated: number })[]>();
  for (const it of items) {
    const i = shardIndex(it.pageId);
    let list = byShard.get(i);
    if (!list) byShard.set(i, (list = []));
    list.push(it);
  }
  let inserted = 0;
  for (const [i, list] of byShard) {
    const s = shard(i);
    s.db.transaction(() => {
      for (const it of list) {
        if (it.data.length === 0) continue;
        inserted += s.putIfMissing.run(keyOf(it.pageId, it.size), it.data, it.updated).changes;
      }
    })();
  }
  return inserted;
}

/**
 * Lists every stored thumbnail, shard by shard, in no particular order.
 *
 * better-sqlite3 cannot run other statements on a connection while it is
 * iterating, so callers must not write (e.g. deleteThumbs) inside this loop.
 * Collect what to delete first, then delete.
 */
export function* listThumbs(): Generator<ThumbRef> {
  for (let i = 0; i < SHARD_COUNT; i++) {
    for (const key of shard(i).list.iterate() as IterableIterator<number>) {
      yield refOf(key);
    }
  }
}

export function countThumbs(): number {
  let total = 0;
  for (let i = 0; i < SHARD_COUNT; i++) total += shard(i).count.get() as number;
  return total;
}

/** Bytes the shard files take on disk (.db + -wal). Cheap: 128 stat calls. */
export function storeDiskBytes(): number {
  let total = 0;
  for (let i = 0; i < SHARD_COUNT; i++) {
    for (const suffix of ['', '-wal']) {
      try {
        total += fs.statSync(shardFile(i) + suffix).size;
      } catch {
        // shard not created yet
      }
    }
  }
  return total;
}

/** Returns free pages to the filesystem after large deletes (auto_vacuum = INCREMENTAL). */
export function incrementalVacuum(): void {
  for (let i = 0; i < SHARD_COUNT; i++) {
    const s = shard(i);
    s.db.pragma('incremental_vacuum');
    s.db.pragma('wal_checkpoint(TRUNCATE)');
  }
}

export function closeThumbStore(): void {
  for (let i = 0; i < SHARD_COUNT; i++) {
    shards[i]?.db.close();
    shards[i] = undefined;
  }
}

/**
 * Removes every thumbnail. Replaces wiping CACHE_DIR.
 *
 * Rows are deleted instead of unlinking the shard files: another process
 * (migration, importDump) may have the same files open and would keep writing
 * into the unlinked inode, so its thumbnails would silently vanish. DELETE
 * without WHERE uses SQLite's truncate optimisation; incremental_vacuum then
 * gives the space back to the filesystem.
 */
export function clearThumbs(): void {
  for (let i = 0; i < SHARD_COUNT; i++) {
    const s = shard(i);
    s.db.exec('DELETE FROM thumb');
    s.db.pragma('incremental_vacuum');
    s.db.pragma('wal_checkpoint(TRUNCATE)');
  }
}

// --- Transitional: legacy one-file-per-thumbnail cache --------------------
// Everything below exists only while CACHE_DIR still holds files that the
// migration (migrateToSqlite.ts --delete-source) has not moved yet. Once
// `find cache -type f | wc -l` shows only explained leftovers, delete this
// section and switch the callers to getThumbEntry / hasThumb / listThumbs /
// deleteThumbs (ZADANIE.md, step 5).

/**
 * Store failures during the transition (full disk, locked shard, unreadable
 * file) are reported at most once a minute, so a lasting problem does not
 * flood the log on every thumbnail request.
 */
let lastStoreErrorReport = 0;
function reportStoreError(what: string, err: unknown): void {
  const now = Date.now();
  if (now - lastStoreErrorReport < 60_000) return;
  lastStoreErrorReport = now;
  console.error(`[thumbStore] ${what} failed, serving the legacy file instead: ${err}`);
}

/**
 * SQLite first, then the old file. A legacy hit is copied into SQLite so it
 * is served from there next time. The legacy file is not deleted here; the
 * migration script does that after verifying the bytes.
 *
 * Both SQLite steps are best-effort: when the lookup or the copy fails, a
 * valid legacy file is still returned. Serving must not depend on the store
 * being writable.
 */
export function getThumbOrLegacy(
  pageId: number | string,
  size: number,
  legacyPath: string = getCachePath(pageId, size),
): ThumbEntry | undefined {
  try {
    const hit = getThumbEntry(pageId, size);
    if (hit) return hit;
  } catch (err) {
    reportStoreError(`SQLite lookup of ${pageId}/${size}`, err);
  }
  let data: Buffer;
  let updated: number;
  try {
    data = fs.readFileSync(legacyPath);
    updated = Math.floor(fs.statSync(legacyPath).mtimeMs / 1000);
  } catch {
    return undefined;
  }
  if (data.length === 0) return undefined;
  try {
    putThumbIfMissing(pageId, size, data, updated);
  } catch (err) {
    reportStoreError(`SQLite copy of ${pageId}/${size}`, err);
  }
  return { data, updated };
}

/** Existence check over both stores, so a not-yet-migrated thumbnail is not downloaded again. */
export function hasThumbOrLegacy(
  pageId: number | string,
  size: number,
  legacyPath: string = getCachePath(pageId, size),
): boolean {
  try {
    if (hasThumb(pageId, size)) return true;
  } catch (err) {
    reportStoreError(`SQLite existence check of ${pageId}/${size}`, err);
  }
  // Called for every id of a /pictures?prefetch=true response (up to 50 000):
  // no exception for the common "no legacy file" case.
  const st = fs.statSync(legacyPath, { throwIfNoEntry: false });
  return st !== undefined && st.size > 0;
}

/**
 * Every thumbnail in SQLite plus every legacy file, de-duplicated, grouped by
 * pageId. Collected fully before returning, so callers may delete afterwards
 * (listThumbs() must not be interleaved with writes, see above).
 */
export async function collectThumbRefsByPage(): Promise<Map<number, number[]>> {
  const byPage = new Map<number, number[]>();
  const add = (pageId: number, size: number) => {
    let sizes = byPage.get(pageId);
    if (!sizes) byPage.set(pageId, (sizes = []));
    if (!sizes.includes(size)) sizes.push(size);
  };
  for (const r of listThumbs()) add(r.pageId, r.size);
  // Legacy names are "<pageId>_<size>.jpg" (cachePaths.getCacheFileName).
  for (const relPath of await listCacheFilesRecursive()) {
    const m = /^(\d+)_(\d+)\.jpg$/.exec(path.basename(relPath));
    if (!m) continue;
    const pageId = Number(m[1]);
    const size = Number(m[2]);
    if (path.resolve(CACHE_DIR, relPath) !== path.resolve(getCachePath(pageId, size))) continue;
    add(pageId, size);
  }
  return byPage;
}

/**
 * deleteThumbs() plus the matching legacy files; without the latter,
 * getThumbOrLegacy() would bring a deleted thumbnail back from its old file.
 */
export function deleteThumbsAndLegacy(refs: ThumbRef[]): { rows: number; files: number } {
  const rows = deleteThumbs(refs);
  let files = 0;
  for (const r of refs) {
    try {
      fs.unlinkSync(getCachePath(r.pageId, r.size));
      files++;
    } catch {
      // no legacy file - the normal case after the migration
    }
  }
  return { rows, files };
}
