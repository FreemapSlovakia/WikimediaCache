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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DUMP_URL = process.env.DUMP_URL || 'https://dumps.wikimedia.org/commonswiki/latest/commonswiki-latest-geo_tags.sql.gz';
const BATCH_SIZE = process.env.BATCH_SIZE ? parseInt(process.env.BATCH_SIZE, 10) : 5000;
const DUMP_PATH = process.env.DUMP_PATH || '/tmp/geo_tags.sql.gz';
const CHECKPOINT_PATH = process.env.CHECKPOINT_PATH || '/tmp/geo_tags_import.checkpoint';

async function downloadDump() {
  const partPath = DUMP_PATH + '.part';

  let startByte = 0;
  if (fs.existsSync(partPath)) {
    startByte = fs.statSync(partPath).size;
    console.log(`Resuming download from byte ${startByte}...`);
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
  console.log('\nDownload complete.');

  fs.renameSync(partPath, DUMP_PATH);
}

async function processDump(pool: ReturnType<typeof getPool>) {
  const isResuming = fs.existsSync(CHECKPOINT_PATH);
  const importStartTime = new Date();
  
  let skipUntilGtId = 0;
  if (isResuming) {
    skipUntilGtId = parseInt(fs.readFileSync(CHECKPOINT_PATH, 'utf8').trim(), 10);
    console.log(`Resuming from gt_id > ${skipUntilGtId}...`);
  } else {
    console.log('Processing dump from beginning...');
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
    } catch (err) {
      console.error('Batch insert error:', err);
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
  console.log(`\nImport finished! Total inserted/updated: ${totalInserted}`);

  if (!isResuming) {
    console.log('Cleaning up old records (not present in this dump)...');
    try {
      const deleteRes = await pool.query('DELETE FROM wikimedia_photo WHERE updated_at < $1', [importStartTime]);
      console.log(`Deleted ${deleteRes.rowCount} obsolete records from database.`);
    } catch (err) {
      console.error('Database cleanup error:', err);
    }
  } else {
    console.log('Skipping database cleanup because import was resumed from a checkpoint.');
  }
}

async function cleanupDeletedThumbnails(pool: ReturnType<typeof getPool>) {
  console.log('\nStarting cache cleanup for deleted thumbnails...');
  const CACHE_DIR = path.join(__dirname, '../cache');
  if (!fs.existsSync(CACHE_DIR)) return;

  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.jpg'));
  const fileMap = new Map<number, string[]>();

  for (const file of files) {
    const pageId = parseInt(file.split('_')[0]!, 10);
    if (!isNaN(pageId)) {
      if (!fileMap.has(pageId)) fileMap.set(pageId, []);
      fileMap.get(pageId)!.push(file);
    }
  }

  const pageIds = Array.from(fileMap.keys());
  console.log(`Found ${pageIds.length} unique pageIds in cache.`);

  let deletedCount = 0;
  const BATCH = 5000;
  for (let i = 0; i < pageIds.length; i += BATCH) {
    const batchIds = pageIds.slice(i, i + BATCH);
    try {
      const res = await pool.query('SELECT page_id FROM wikimedia_photo WHERE page_id = ANY($1::int[])', [batchIds]);
      const existingIds = new Set(res.rows.map(r => r.page_id));

      for (const id of batchIds) {
        if (!existingIds.has(id)) {
          for (const file of fileMap.get(id)!) {
            const cachePath = path.join(CACHE_DIR, file);
            if (fs.existsSync(cachePath)) {
              fs.unlinkSync(cachePath);
              deletedCount++;
            }
          }
        }
      }
      process.stdout.write(`\rChecked ${Math.min(i + BATCH, pageIds.length)}/${pageIds.length} cached IDs...`);
    } catch (err) {
      console.error('\nError during cleanup batch:', err);
    }
  }

  console.log(`\nCache cleanup finished! Deleted ${deletedCount} obsolete thumbnails.`);
}

export async function runImport() {
  await initDb();
  const pool = getPool();

  if (fs.existsSync(DUMP_PATH)) {
    console.log(`Found existing dump at ${DUMP_PATH}, skipping download.`);
    console.log('Delete it manually to force re-download.');
  } else {
    await downloadDump();
  }

  await processDump(pool);

  await cleanupDeletedThumbnails(pool);

  // Keep the file for potential re-runs; delete only on explicit cleanup
  const sizeMB = (fs.statSync(DUMP_PATH).size / 1024 / 1024).toFixed(0);
  console.log(`Dump kept at ${DUMP_PATH} (${sizeMB}MB). Delete manually when no longer needed.`);
}

runImport().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
