/**
 * WikiMediaCache Microservice for Freemap
 * Open-source project for caching Wikimedia Commons thumbnails.
 * Author: Ladislav Nagy
 */

import got from 'got';
import zlib from 'zlib';
import readline from 'readline';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool, initDb } from './database.js';
import { CACHE_DIR, ensureShardDirsExist, listCacheFilesRecursive } from './cachePaths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOG_DIR = path.join(__dirname, '../logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const IMPORT_LOG_FILE = path.join(LOG_DIR, 'import.log');

function logImport(level: 'INFO' | 'WARN' | 'ERROR', msg: string) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
  try { fs.appendFileSync(IMPORT_LOG_FILE, line + '\n'); } catch (e) {}
}

async function resetWarmCache() {
  // A fresh dump may contain newly-added Slovak photos, so the idle cache
  // warmer should re-scan the SVK bbox from the start instead of continuing
  // wherever it happened to be (possibly already deep into the larger V4
  // stage) - see the /warm-cache-reset handler in index.ts. Best-effort:
  // the server may not be running (e.g. import triggered manually before
  // first start), in which case this is a harmless no-op.
  const port = process.env.PORT || 4000;
  try {
    await got.get(`http://localhost:${port}/warm-cache-reset`, { timeout: { request: 5000 } });
    logImport('INFO', 'Warm cache reset to the SVK stage (fresh dump may include new Slovak photos).');
  } catch (err: any) {
    logImport('WARN', `Could not reset warm cache (is the server running?): ${err.message}`);
  }
}

async function logImportSummary(pool: ReturnType<typeof getPool>) {
  try {
    const totalRes = await pool.query('SELECT COUNT(*)::bigint AS count FROM wikimedia_photo');
    const totalCount = totalRes.rows[0]?.count ?? '0';

    const bbox = process.env.BBOX_SVK
      ? process.env.BBOX_SVK.split(',').map(Number)
      : [16.83, 47.73, 22.57, 49.61];
    const svkRes = await pool.query(
      'SELECT COUNT(*)::bigint AS count FROM wikimedia_photo WHERE location && ST_MakeEnvelope($1, $2, $3, $4, 4326)',
      bbox
    );
    const svkCount = svkRes.rows[0]?.count ?? '0';

    logImport('INFO', `Database now holds ${totalCount} photos total, of which ${svkCount} are in Slovakia (BBOX_SVK).`);
  } catch (err: any) {
    logImport('WARN', `Failed to compute import summary counts: ${err.message}`);
  }
}

const DUMP_URL = process.env.DUMP_URL || 'https://dumps.wikimedia.org/commonswiki/latest/commonswiki-latest-geo_tags.sql.gz';
const BATCH_SIZE = process.env.BATCH_SIZE ? parseInt(process.env.BATCH_SIZE, 10) : 5000;
const DUMP_PATH = process.env.DUMP_PATH || '/tmp/geo_tags.sql.gz';
const CHECKPOINT_PATH = process.env.CHECKPOINT_PATH || '/tmp/geo_tags_import.checkpoint';

async function downloadDump() {
  const partPath = DUMP_PATH + '.part';

  let startByte = 0;
  if (fs.existsSync(partPath)) {
    startByte = fs.statSync(partPath).size;
    logImport('INFO', `Resuming download from byte ${startByte}...`);
  }

  const headers: Record<string, string> = {
    'User-Agent': process.env.USER_AGENT || 'FreemapCacheBot/1.0 (https://freemap.sk; freemap@freemap.sk)',
  };
  if (startByte > 0) headers['Range'] = `bytes=${startByte}-`;

  const response = got.stream(DUMP_URL, { headers });

  response.on('downloadProgress', ({ transferred, total, percent }) => {
    const pct = total ? `${(percent * 100).toFixed(1)}%` : `${(transferred / 1024 / 1024).toFixed(1)}MB`;
    process.stdout.write(`\rDownloading: ${pct}   `);
  });

  const flags = startByte > 0 ? 'a' : 'w';
  await pipeline(response, fs.createWriteStream(partPath, { flags }));
  console.log('');
  logImport('INFO', 'Dump download complete.');

  fs.renameSync(partPath, DUMP_PATH);
}

async function processDump(pool: ReturnType<typeof getPool>) {
  const isResuming = fs.existsSync(CHECKPOINT_PATH);
  const importStartTime = new Date();

  let skipUntilGtId = 0;
  if (isResuming) {
    skipUntilGtId = parseInt(fs.readFileSync(CHECKPOINT_PATH, 'utf8').trim(), 10);
    logImport('INFO', `Resuming from gt_id > ${skipUntilGtId}...`);
  } else {
    logImport('INFO', 'Processing dump from beginning...');
  }

  const gunzip = zlib.createGunzip();
  const rl = readline.createInterface({
    input: fs.createReadStream(DUMP_PATH).pipe(gunzip),
    crlfDelay: Infinity,
  });

  let batch: { pageId: number; lat: number; lon: number }[] = [];
  let totalInserted = 0;
  let lastGtId = skipUntilGtId;
  const tupleRegex = /\(([^)]+)\)/g;

  const flushBatch = async () => {
    if (batch.length === 0) return;

    // Deduplicate by page_id to prevent "ON CONFLICT DO UPDATE command cannot affect row a second time"
    const map = new Map<number, { pageId: number; lat: number; lon: number }>();
    for (const item of batch) {
      map.set(item.pageId, item);
    }
    const currentBatch = Array.from(map.values());
    batch = [];

    let query = 'INSERT INTO wikimedia_photo (page_id, location) VALUES ';
    const values: any[] = [];
    const placeholders: string[] = [];

    let paramIndex = 1;
    for (const item of currentBatch) {
      placeholders.push(`($${paramIndex++}, ST_SetSRID(ST_MakePoint($${paramIndex++}, $${paramIndex++}), 4326))`);
      values.push(item.pageId, item.lon, item.lat);
    }

    query += placeholders.join(', ');
    query += ' ON CONFLICT (page_id) DO UPDATE SET location = EXCLUDED.location, updated_at = CURRENT_TIMESTAMP';

    try {
      await pool.query(query, values);
      totalInserted += currentBatch.length;
      fs.writeFileSync(CHECKPOINT_PATH, String(lastGtId));
      process.stdout.write(`\rInserted ${totalInserted} records (gt_id: ${lastGtId})...`);
    } catch (err: any) {
      logImport('ERROR', `Batch insert error: ${err.message}`);
      throw err;
    }
  };

  for await (const line of rl) {
    if (!line.startsWith('INSERT INTO `geo_tags` VALUES')) continue;

    let match;
    tupleRegex.lastIndex = 0;
    while ((match = tupleRegex.exec(line)) !== null) {
      const parts = match[1]!.split(',');
      if (parts.length >= 6) {
        const gtId = parseInt(parts[0]!, 10);
        if (gtId <= skipUntilGtId) continue;

        const pageId = parseInt(parts[1]!, 10);
        const globe = parts[2]!.replace(/'/g, '');
        const isPrimary = parts[3]!;
        const lat = parseFloat(parts[4]!);
        const lon = parseFloat(parts[5]!);
        const type = parts.length > 7 ? parts[7]!.replace(/'/g, '') : '';

        if (globe === 'earth' && isPrimary === '1' && type === 'camera' && !isNaN(lat) && !isNaN(lon)) {
          lastGtId = gtId;
          batch.push({ pageId, lat, lon });
          if (batch.length >= BATCH_SIZE) await flushBatch();
        }
      }
    }
  }

  if (batch.length > 0) await flushBatch();

  if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);
  console.log('');
  logImport('INFO', `Import finished! Total inserted/updated: ${totalInserted}`);

  if (!isResuming) {
    logImport('INFO', 'Cleaning up old records (not present in this dump)...');
    try {
      const deleteRes = await pool.query('DELETE FROM wikimedia_photo WHERE updated_at < $1', [importStartTime]);
      logImport('INFO', `Deleted ${deleteRes.rowCount} obsolete records from database.`);
    } catch (err: any) {
      logImport('ERROR', `Database cleanup error: ${err.message}`);
    }
  } else {
    logImport('INFO', 'Skipping database cleanup because import was resumed from a checkpoint.');
  }
}

async function cleanupDeletedThumbnails(pool: ReturnType<typeof getPool>) {
  logImport('INFO', 'Starting cache cleanup for deleted thumbnails...');

  const files = await listCacheFilesRecursive(); // relative paths, e.g. "042/1234567_120.jpg"
  const fileMap = new Map<number, string[]>(); // pageId -> relative paths

  for (const relPath of files) {
    const baseName = path.basename(relPath);
    const pageId = parseInt(baseName.split('_')[0]!, 10);
    if (!isNaN(pageId)) {
      if (!fileMap.has(pageId)) fileMap.set(pageId, []);
      fileMap.get(pageId)!.push(relPath);
    }
  }

  const pageIds = Array.from(fileMap.keys());
  logImport('INFO', `Found ${pageIds.length} unique pageIds in cache.`);

  let deletedCount = 0;
  const BATCH = 5000;
  for (let i = 0; i < pageIds.length; i += BATCH) {
    const batchIds = pageIds.slice(i, i + BATCH);
    try {
      const res = await pool.query('SELECT page_id FROM wikimedia_photo WHERE page_id = ANY($1::int[])', [batchIds]);
      const existingIds = new Set(res.rows.map(r => r.page_id));

      for (const id of batchIds) {
        if (!existingIds.has(id)) {
          for (const relPath of fileMap.get(id)!) {
            const cachePath = path.join(CACHE_DIR, relPath);
            if (fs.existsSync(cachePath)) {
              fs.unlinkSync(cachePath);
              deletedCount++;
            }
          }
        }
      }
      process.stdout.write(`\rChecked ${Math.min(i + BATCH, pageIds.length)}/${pageIds.length} cached IDs...`);
    } catch (err: any) {
      logImport('ERROR', `Error during cleanup batch: ${err.message}`);
    }
  }

  console.log('');
  logImport('INFO', `Cache cleanup finished! Deleted ${deletedCount} obsolete thumbnails.`);
}

export async function runImport() {
  const startedAt = Date.now();
  logImport('INFO', '=== Import started ===');
  await initDb();
  ensureShardDirsExist();
  const pool = getPool();

  if (fs.existsSync(DUMP_PATH)) {
    logImport('INFO', `Found existing dump at ${DUMP_PATH}, skipping download. Delete it manually to force re-download.`);
  } else {
    await downloadDump();
  }

  await processDump(pool);

  await cleanupDeletedThumbnails(pool);

  await logImportSummary(pool);

  await resetWarmCache();

  // Keep the file for potential re-runs; delete only on explicit cleanup
  const sizeMB = (fs.statSync(DUMP_PATH).size / 1024 / 1024).toFixed(0);
  logImport('INFO', `Dump kept at ${DUMP_PATH} (${sizeMB}MB). Delete manually when no longer needed.`);

  const durationMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  logImport('INFO', `=== Import finished successfully in ${durationMin} min ===`);
}

runImport().then(() => process.exit(0)).catch(err => {
  logImport('ERROR', `=== Import FAILED: ${err.message} ===`);
  process.exit(1);
});
