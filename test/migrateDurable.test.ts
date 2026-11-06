/**
 * WMC01: migrateToSqlite --delete-source deletes a source file only after the
 * row is durable (checkpointed into the .db file and synced), never right
 * after a read-back.
 *
 * Fault injection: a reader that holds an old snapshot of the shard makes the
 * FULL checkpoint impossible (it waits busy_timeout, then reports busy). The
 * migration must then keep every source file of that shard.
 *
 *   npx tsx test/migrateDurable.test.ts      (~15 s, one busy_timeout)
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { check, finish, migrationStats, runCli, setupEnv, writeFile } from './helpers.js';

const env = setupEnv('durable');
const { getCachePath } = await import('../src/cachePaths.js');

// pageIds 64, 128, 192, ... all land in shard 0 (pageId % 64).
const file = (pageId: number) => getCachePath(pageId, 120);
const bytes = (pageId: number) => Buffer.from(`JPEG_${pageId}`);
for (const id of [64, 128]) writeFile(file(id), bytes(id));

console.log('copy only (no --delete-source):');
{
  const r = runCli(env, 'migrateToSqlite.ts');
  const s = migrationStats(r.out);
  check(r.status === 0, `exit 0 (${r.status})`);
  check(s.inserted === 2 && s.deleted === 0, `2 inserted, 0 deleted (${JSON.stringify(s)})`);
}

console.log('checkpoint blocked by an old reader -> nothing deleted:');
{
  const shardDb = path.join(env.dbDir, 'thumbs-00.db');
  const reader = new Database(shardDb);
  reader.exec('BEGIN');
  reader.prepare('SELECT count(*) FROM thumb').get(); // snapshot taken now
  for (const id of [192, 256]) writeFile(file(id), bytes(id));
  const r = runCli(env, 'migrateToSqlite.ts', ['--delete-source']);
  const s = migrationStats(r.out);
  reader.exec('COMMIT');
  reader.close();
  check(r.status !== 0, `non-zero exit when durability is not confirmed (${r.status})`);
  check(s.deleted === 0, `0 deleted (${JSON.stringify(s)})`);
  check((s.notDurable ?? 0) === 4, `notDurable = 4 (${s.notDurable})`);
  check([64, 128, 192, 256].every((id) => fs.existsSync(file(id))), 'all source files kept');
}

console.log('re-run without the reader -> verified, durable, deleted:');
{
  // An idle second connection (like the running server) keeps the WAL from
  // being checkpointed and removed when the migration closes, so the copy of
  // the .db file below shows only what the barrier itself made durable.
  const keeper = new Database(path.join(env.dbDir, 'thumbs-00.db'));
  keeper.prepare('SELECT count(*) FROM thumb').get(); // attach to the WAL index
  for (const id of [320, 384]) writeFile(file(id), bytes(id)); // new rows, written by this run
  const r = runCli(env, 'migrateToSqlite.ts', ['--delete-source']);
  const s = migrationStats(r.out);
  check(r.status === 0, `exit 0 (${r.status})`);
  check(s.deleted === 6 && s.durable === 6, `6 durable, 6 deleted (${JSON.stringify(s)})`);
  check([64, 128, 192, 256, 320, 384].every((id) => !fs.existsSync(file(id))), 'source files gone');
  // The rows must be in the main .db file itself, not only in the -wal.
  const wal = path.join(env.dbDir, 'thumbs-00.db-wal');
  const walSize = fs.existsSync(wal) ? fs.statSync(wal).size : -1;
  const copy = path.join(env.root, 'main-only.db');
  fs.copyFileSync(path.join(env.dbDir, 'thumbs-00.db'), copy);
  keeper.close();
  const db = new Database(copy, { readonly: true });
  const n = db.prepare('SELECT count(*) AS n FROM thumb').get() as { n: number };
  db.close();
  check(n.n === 6, `main .db file alone holds all 6 rows (${n.n}; -wal ${walSize} B)`);
}

finish();
