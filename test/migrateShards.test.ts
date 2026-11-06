/**
 * WMC02: migrateCacheShards.ts must never overwrite an existing target.
 *
 *   npx tsx test/migrateShards.test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { check, finish, runCli, setupEnv, writeFile } from './helpers.js';

const env = setupEnv('shards');
const flat = (name: string) => path.join(env.cacheDir, name);
const sharded = (shard: string, name: string) => path.join(env.cacheDir, shard, name);

// missing target
writeFile(flat('200_120.jpg'), 'FLAT_A');
// different target (the reviewer's reproduction)
writeFile(flat('201_120.jpg'), 'FLAT_OLD');
writeFile(sharded('201', '201_120.jpg'), 'SHARDED_NEW');
// identical target, separate file
writeFile(flat('202_120.jpg'), 'SAME');
writeFile(sharded('202', '202_120.jpg'), 'SAME');
// interrupted earlier run: target is a hard link of the source
writeFile(flat('203_120.jpg'), 'LINKED');
fs.mkdirSync(path.join(env.cacheDir, '203'), { recursive: true });
fs.linkSync(flat('203_120.jpg'), sharded('203', '203_120.jpg'));

const r = runCli(env, 'migrateCacheShards.ts');
console.log(r.out.trim().split('\n').map((l) => '    | ' + l).join('\n'));

const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
check(read(sharded('200', '200_120.jpg')) === 'FLAT_A' && read(flat('200_120.jpg')) === null, 'missing target: moved');
check(read(sharded('201', '201_120.jpg')) === 'SHARDED_NEW', 'different target: NOT overwritten');
check(read(flat('201_120.jpg')) === 'FLAT_OLD', 'different target: source kept');
check(/conflict/i.test(r.out) && r.out.includes('201_120.jpg'), 'conflict is reported by name');
check(read(sharded('202', '202_120.jpg')) === 'SAME' && read(flat('202_120.jpg')) === 'SAME', 'identical separate file: both kept');
check(read(sharded('203', '203_120.jpg')) === 'LINKED' && read(flat('203_120.jpg')) === null, 'same inode (interrupted run): finished');
check(r.status === 3, `exit code 3 when something was left (${r.status})`);

finish();
