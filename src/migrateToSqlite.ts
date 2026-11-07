/**
 * Moves legacy thumbnail files from CACHE_DIR into the SQLite thumb store.
 *
 * Safe to re-run: rows that already exist are kept (INSERT OR IGNORE). With
 * --delete-source a file is deleted only after three steps per batch:
 *   1. inserted (or already present),
 *   2. verified: its bytes read back from SQLite match the file,
 *   3. durable: a completed wal_checkpoint(FULL) of its shard put the row into
 *      the .db file and synced it (thumbStore.durableShards). The migration's
 *      own connections also run with synchronous=FULL.
 * A file whose shard could not be made durable stays; the next run picks it up.
 * Can run while the server is up (WAL mode).
 *
 * Exit code 3 when anything was left for inspection (mismatch, readErrors,
 * notDurable), so automation does not have to parse the summary.
 *
 *   npx tsx src/migrateToSqlite.ts --limit 10000      # trial, keeps files
 *   npx tsx src/migrateToSqlite.ts                    # copy all, keep files
 *   npx tsx src/migrateToSqlite.ts --delete-source    # copy, verify, delete files
 *
 * --delete-source frees disk space and inodes as it goes, so the migration fits
 * on a disk without room for a second full copy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, getCachePath } from './cachePaths.js';
import {
  closeThumbStore,
  countThumbs,
  durableShards,
  getThumb,
  putThumbsIfMissing,
  thumbShardIndex,
  useDurableWrites,
} from './thumbStore.js';
import { type MigrationStatus, writeMigrationStatus } from './migrationStatus.js';

const args = process.argv.slice(2);
const DELETE_SOURCE = args.includes('--delete-source');
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
if (!(LIMIT > 0)) {
  console.error(`--limit needs a positive number, got: ${args[limitArg + 1]}`);
  process.exit(2);
}
const BATCH = 2000;
if (DELETE_SOURCE) useDurableWrites();

// Ctrl+C (alebo SIGTERM) nezabije beh uprostred dávky: dokončí sa rozpísaná
// dávka, vypíše sa súhrn a store sa korektne zatvorí. Druhý Ctrl+C ukončí
// hneď (aj to je bezpečné - súbor sa maže až po overení zápisu).
let stopRequested = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopRequested) {
      console.error(`\n${sig} again, exiting now.`);
      closeThumbStore();
      process.exit(130);
    }
    stopRequested = true;
    console.error(`\n${sig}: finishing the current batch, then stopping (press again to exit at once).`);
  });
}

/** First few names that did not round-trip, so a high skippedName can be explained. */
const skippedSamples: string[] = [];

const stats = {
  seen: 0,
  inserted: 0,
  alreadyPresent: 0,
  verified: 0,
  durable: 0,
  notDurable: 0,
  deleted: 0,
  skippedName: 0,
  skippedEmpty: 0,
  mismatch: 0,
  readErrors: 0,
};

/**
 * Filename -> pageId and size. The regex is only a first guess; the round-trip
 * check against getCachePath() is what makes it safe. Files that do not
 * round-trip are skipped and counted, never deleted.
 */
function parse(absPath: string): { pageId: number; size: number } | null {
  const m = /(\d+)\D+(\d+)\.jpe?g$/i.exec(path.basename(absPath));
  if (!m) return null;
  const candidates: [number, number][] = [
    [Number(m[1]), Number(m[2])],
    [Number(m[2]), Number(m[1])],
  ];
  for (const [pageId, size] of candidates) {
    if (path.resolve(getCachePath(String(pageId), size)) === path.resolve(absPath)) {
      return { pageId, size };
    }
  }
  return null;
}

async function* walk(dir: string): AsyncGenerator<string> {
  const d = await fs.promises.opendir(dir);
  for await (const entry of d) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}

async function flush(batch: string[]): Promise<void> {
  const items: { pageId: number; size: number; data: Buffer; updated: number; file: string }[] = [];
  for (const file of batch) {
    const ref = parse(file);
    if (!ref) {
      stats.skippedName++;
      if (skippedSamples.length < 20) skippedSamples.push(path.relative(CACHE_DIR, file));
      continue;
    }
    let data: Buffer;
    let mtime: number;
    try {
      [data, mtime] = await Promise.all([
        fs.promises.readFile(file),
        fs.promises.stat(file).then((s) => Math.floor(s.mtimeMs / 1000)),
      ]);
    } catch {
      stats.readErrors++;
      continue;
    }
    if (data.length === 0) {
      stats.skippedEmpty++;
      continue;
    }
    items.push({ ...ref, data, updated: mtime, file });
  }

  const inserted = putThumbsIfMissing(items);
  stats.inserted += inserted;
  stats.alreadyPresent += items.length - inserted;

  if (!DELETE_SOURCE) return;
  const verified: typeof items = [];
  for (const it of items) {
    const stored = getThumb(it.pageId, it.size);
    if (!stored || !stored.equals(it.data)) {
      // A row that differs (e.g. re-downloaded meanwhile) is kept; the file stays for inspection.
      stats.mismatch++;
      continue;
    }
    verified.push(it);
  }
  stats.verified += verified.length;

  // Durability point: nothing is unlinked before it.
  const durable = durableShards(verified.map((it) => thumbShardIndex(it.pageId)));
  for (const it of verified) {
    if (!durable.has(thumbShardIndex(it.pageId))) {
      stats.notDurable++;
      continue;
    }
    stats.durable++;
    await fs.promises.unlink(it.file);
    stats.deleted++;
  }
}

const report: MigrationStatus = {
  state: 'running',
  pid: process.pid,
  deleteSource: DELETE_SOURCE,
  limit: Number.isFinite(LIMIT) ? LIMIT : null,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  stats,
};

function saveReport(changes: Partial<MigrationStatus>, startedMs: number): void {
  Object.assign(report, changes);
  const now = Date.now();
  report.updatedAt = new Date(now).toISOString();
  report.perSecond = Math.round(stats.seen / Math.max((now - startedMs) / 1000, 0.001));
  report.stats = { ...stats };
  writeMigrationStatus(report);
}

async function main(): Promise<void> {
  console.log(`Migrating ${CACHE_DIR} -> SQLite (delete source: ${DELETE_SOURCE}, limit: ${LIMIT})`);
  const started = Date.now();
  saveReport({}, started);
  let batch: string[] = [];
  for await (const file of walk(CACHE_DIR)) {
    if (stats.seen >= LIMIT || stopRequested) break;
    stats.seen++;
    batch.push(file);
    if (batch.length >= BATCH) {
      await flush(batch);
      batch = [];
      if (stats.seen % 50000 < BATCH) {
        saveReport({}, started);
        console.log(JSON.stringify({ ...stats, perSecond: report.perSecond }));
      }
    }
  }
  if (batch.length) await flush(batch);
  console.log(stopRequested ? 'Stopped early:' : 'Done:', JSON.stringify(stats));
  if (skippedSamples.length) console.log('skippedName samples:', skippedSamples.join(', '));
  const rowsInStore = countThumbs();
  console.log('Rows in store:', rowsInStore);
  closeThumbStore();
  const kept = stats.mismatch || stats.readErrors || stats.notDurable;
  if (kept) {
    console.log('Some files were kept for inspection or a re-run (mismatch / readErrors / notDurable), exit code 3.');
    process.exitCode = 3;
  }
  saveReport(
    {
      state: stopRequested ? 'stopped' : 'done',
      finishedAt: new Date().toISOString(),
      exitCode: kept ? 3 : 0,
      rowsInStore,
    },
    started,
  );
}

main().catch((err) => {
  console.error(err);
  closeThumbStore();
  saveReport(
    { state: 'failed', finishedAt: new Date().toISOString(), exitCode: 1, error: String(err) },
    Date.parse(report.startedAt),
  );
  process.exit(1);
});
