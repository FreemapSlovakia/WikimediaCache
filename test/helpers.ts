/**
 * Small helpers for the tsx test scripts (the project has no test framework).
 *
 * Every test works only in a fresh directory under /tmp. setupEnv() must run
 * before src/ modules are imported (dynamic import), because cachePaths.ts and
 * thumbStore.ts read CACHE_DIR / THUMB_DB_DIR at import time. It also changes
 * the working directory, so dotenv never loads the project's .env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SRC_DIR = path.join(PROJECT_DIR, 'src');
const TSX = path.join(PROJECT_DIR, 'node_modules', '.bin', 'tsx');

const roots: string[] = [];
let failures = 0;

export function tmpRoot(name: string): string {
  // Always /tmp (not $TMPDIR, which may point into the home directory).
  const base = fs.realpathSync('/tmp');
  const root = fs.mkdtempSync(path.join(base, `wmc-test-${name}-`));
  roots.push(root);
  return root;
}

export interface TestEnv {
  root: string;
  cacheDir: string;
  dbDir: string;
}

export function setupEnv(name: string, dbDir?: string): TestEnv {
  const root = tmpRoot(name);
  const cacheDir = path.join(root, 'cache');
  const db = dbDir ?? path.join(root, 'thumbs-db');
  fs.mkdirSync(cacheDir, { recursive: true });
  process.env.CACHE_DIR = cacheDir;
  process.env.THUMB_DB_DIR = db;
  process.chdir(root);
  return { root, cacheDir, dbDir: db };
}

export function check(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
}

/** Runs a src/ CLI with the test directories, from the test root (no project .env). */
export function runCli(env: TestEnv, script: string, args: string[] = []) {
  const r = spawnSync(TSX, [path.join(SRC_DIR, script), ...args], {
    cwd: env.root,
    env: { ...process.env, CACHE_DIR: env.cacheDir, THUMB_DB_DIR: env.dbDir },
    encoding: 'utf8',
  });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

/** Parses the JSON after "Done:" (or "Stopped early:") in the migration output. */
export function migrationStats(out: string): Record<string, number> {
  const m = /(?:Done|Stopped early):\s*(\{.*\})/.exec(out);
  return m ? JSON.parse(m[1]!) : {};
}

export function writeFile(file: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

/** Removes the test's own /tmp directories and exits with the result. */
export function finish(): never {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
}
