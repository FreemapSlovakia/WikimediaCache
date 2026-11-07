/**
 * Last run of migrateToSqlite, for /status.
 *
 * The migration is a separate CLI process, so it leaves a small JSON file in
 * THUMB_DB_DIR (never inside CACHE_DIR, which runFullCleanup() empties). It is
 * written at the start, after every progress line and at the end, atomically
 * (temp file + rename), so the server never reads half a file.
 *
 * A run that died without writing its end (kill -9, reboot) still says
 * "running"; readMigrationStatus() reports it as "interrupted" once its pid
 * is gone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { THUMB_DB_DIR } from './thumbStore.js';

export const MIGRATION_STATUS_FILE = path.join(THUMB_DB_DIR, 'migration-status.json');

export type MigrationState = 'running' | 'done' | 'stopped' | 'failed' | 'interrupted';

export interface MigrationStatus {
  state: MigrationState;
  pid: number;
  deleteSource: boolean;
  limit: number | null;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  /** Exit code of the finished run (3 = files kept for inspection or a re-run). */
  exitCode?: number;
  error?: string;
  /** Files per second over the whole run so far. */
  perSecond?: number;
  /** Rows in the store at the end of the run. */
  rowsInStore?: number;
  stats: Record<string, number>;
}

export function writeMigrationStatus(status: MigrationStatus, file = MIGRATION_STATUS_FILE): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    // The status file is only a report; the migration itself must go on.
    console.error('Could not write migration status:', err);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists, it just belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Null when no migration has run with this version yet. */
export function readMigrationStatus(file = MIGRATION_STATUS_FILE): MigrationStatus | null {
  let status: MigrationStatus;
  try {
    status = JSON.parse(fs.readFileSync(file, 'utf8')) as MigrationStatus;
  } catch {
    return null;
  }
  if (status.state === 'running' && !pidAlive(status.pid)) {
    return { ...status, state: 'interrupted' };
  }
  return status;
}
