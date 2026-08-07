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
// Znacka o poslednom USPESNOM importe. Zapisuje sa az uplne na konci
// `runImport()`, takze prerusenny alebo padnuty beh ju nechá na predoslej
// hodnote - presne o to ide, ked sa niekto pyta "kedy naposledy presiel".
// Cita ju server (`index.ts`), aby to raz denne pripomenul v `stat.log`;
// cesta preto musi sediet s LAST_IMPORT_FILE tam.
const LAST_IMPORT_FILE = path.join(LOG_DIR, 'last_import.json');

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
  // Endpoint je sice localhost-only, ale ide aj cez globalnu autorizaciu
  // servera - bez kluca vrati 401 (co sa aj dialo, viz WARN v import.log).
  // Beriem prvy kluc z toho isteho suboru, z akeho ich cita server.
  let apiKey = '';
  try {
    apiKey = fs.readFileSync(path.join(__dirname, '../api_keys.txt'), 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))[0] || '';
  } catch (e) { /* kluc sa neda precitat - skusime to aj tak */ }

  try {
    await got.get(`http://localhost:${port}/warm-cache-reset`, {
      timeout: { request: 5000 },
      headers: apiKey ? { 'X-Freemap-API-Key': apiKey } : {},
    });
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

  // Znacka zaciatku importu MUSI prist z databazy a ako RETAZEC.
  //
  // `wikimedia_photo.updated_at` je `TIMESTAMP` (bez casovej zony) a plni sa
  // cez `CURRENT_TIMESTAMP`, teda hodinami databazy. Ked sa sem dosadil
  // `new Date()` z Node-u, driver ho poslal s offsetom lokalnej zony
  // procesu - a Postgres pri porovnani s `timestamp without time zone`
  // offset ZAHODI a zoberie len cislice. Pri Node v CEST a databaze v UTC
  // tak bola znacka o dve hodiny "v buducnosti" oproti prave zapisanym
  // riadkom a nasledny `DELETE ... WHERE updated_at < $1` zmazal CELU
  // tabulku vratane toho, co import prave vlozil (7.8.2026: 37,061,315
  // riadkov, databaza ostala prazdna).
  //
  // Retazec ziadnu konverziu zon neprejde - to, co Postgres vrati, to aj
  // dostane spat.
  const { rows: startRows } = await pool.query(
    'SELECT CURRENT_TIMESTAMP::timestamp::text AS t',
  );
  const importStartTime: string = startRows[0].t;

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
      // Najprv len SPOCITAT. Cistenie ma odstranit hrstku zaznamov, ktore uz
      // v novom dumpe nie su - ked ich vyjde porovnatelne vela ako toho, co
      // sme prave vlozili, nieco je zle a mazat sa NESMIE. Tato poistka je
      // tu preto, ze presne to sa raz stalo (viz importStartTime vyssie) a
      // databaza ostala prazdna.
      const { rows } = await pool.query(
        'SELECT COUNT(*)::int AS c FROM wikimedia_photo WHERE updated_at < $1::timestamp',
        [importStartTime],
      );
      const stale = rows[0].c as number;
      const limit = Math.floor(totalInserted * 0.5);

      if (stale > limit) {
        logImport(
          'ERROR',
          `Cleanup ABORTED: would delete ${stale} records, which is more than half of the ${totalInserted} just imported. ` +
            'That points to a bug, not to obsolete data - database left untouched.',
        );
      } else {
        const deleteRes = await pool.query(
          'DELETE FROM wikimedia_photo WHERE updated_at < $1::timestamp',
          [importStartTime],
        );
        logImport('INFO', `Deleted ${deleteRes.rowCount} obsolete records from database.`);
      }
    } catch (err: any) {
      logImport('ERROR', `Database cleanup error: ${err.message}`);
    }
  } else {
    logImport('INFO', 'Skipping database cleanup because import was resumed from a checkpoint.');
  }
}

async function cleanupDeletedThumbnails(pool: ReturnType<typeof getPool>) {
  logImport('INFO', 'Starting cache cleanup for deleted thumbnails...');

  // Prazdna tabulka znamena, ze kazdy nahlad vyzera ako "uz neexistujuca
  // fotka" - a cistenie by zmazalo CELU cache. Presne to sa 7.8.2026 stalo
  // (129,170 nahladov) po tom, co import omylom vyprazdnil databazu.
  // Prazdna tabulka nie je stav, v ktorom sa da o cache rozhodovat.
  const { rows: guard } = await pool.query('SELECT COUNT(*)::int AS c FROM wikimedia_photo');
  if (guard[0].c === 0) {
    logImport(
      'ERROR',
      'Cache cleanup SKIPPED: photo table is empty, so every thumbnail would look obsolete. ' +
        'Fix the import first, then re-run.',
    );
    return;
  }

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

  try {
    fs.writeFileSync(
      LAST_IMPORT_FILE,
      JSON.stringify(
        {
          finishedAt: new Date().toISOString(),
          durationMin: Number(durationMin),
        },
        null,
        2,
      ) + '\n',
    );
  } catch (err: any) {
    logImport('WARN', `Could not write ${LAST_IMPORT_FILE}: ${err.message}`);
  }
}

runImport().then(() => process.exit(0)).catch(err => {
  logImport('ERROR', `=== Import FAILED: ${err.message} ===`);
  process.exit(1);
});
