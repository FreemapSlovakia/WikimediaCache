/**
 * migrateToSqlite leaves its last run in THUMB_DB_DIR/migration-status.json
 * for /status; a "running" record whose process is gone reads as interrupted.
 *
 *   npx tsx test/migrationStatus.test.ts
 */
import fs from 'node:fs';
import { check, finish, runCli, setupEnv, writeFile } from './helpers.js';

const env = setupEnv('mstatus');
const { getCachePath } = await import('../src/cachePaths.js');
const { MIGRATION_STATUS_FILE, readMigrationStatus, writeMigrationStatus } = await import(
  '../src/migrationStatus.js'
);

check(readMigrationStatus() === null, 'no file -> null');

for (const id of [7, 8, 9]) writeFile(getCachePath(id, 120), Buffer.from(`JPEG_${id}`));
const r = runCli(env, 'migrateToSqlite.ts', ['--delete-source']);
check(r.status === 0, `migration exit 0 (${r.status})`);
check(MIGRATION_STATUS_FILE.startsWith(env.dbDir), 'status file lives in THUMB_DB_DIR');
const s = readMigrationStatus();
check(s?.state === 'done', `state done (${s?.state})`);
check(s?.exitCode === 0 && s?.deleteSource === true, 'exitCode 0, deleteSource');
check(s?.stats.deleted === 3 && s?.rowsInStore === 3, `3 deleted, 3 rows (${JSON.stringify(s)})`);
check(!!s?.finishedAt && Date.parse(s.finishedAt) >= Date.parse(s.startedAt), 'finishedAt after startedAt');

// A run killed without writing its end: pid no longer exists.
const { finishedAt: _f, ...unfinished } = s!;
writeMigrationStatus({ ...unfinished, state: 'running', pid: 2 ** 22 + 12345 });
check(readMigrationStatus()?.state === 'interrupted', 'dead running -> interrupted');
writeMigrationStatus({ ...unfinished, state: 'running', pid: process.pid });
check(readMigrationStatus()?.state === 'running', 'live running stays running');

fs.writeFileSync(MIGRATION_STATUS_FILE, '{broken');
check(readMigrationStatus() === null, 'broken file -> null');
finish();
