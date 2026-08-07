/**
 * WikiMediaCache Microservice for Freemap
 * Open-source project for caching Wikimedia Commons thumbnails.
 * Author: Ladislav Nagy
 */

import Koa from 'koa';
import Router from '@koa/router';
import dotenv from 'dotenv';
import { getPool, initDb } from './database.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import got from 'got';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import sharp from 'sharp';
import crypto from 'crypto';
import {
  CACHE_DIR,
  ensureShardDirsExist,
  getCachePath,
  listCacheFilesRecursive,
} from './cachePaths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();

const app = new Koa();
// The service sits behind nginx (proxy_pass to 127.0.0.1), which already
// sets X-Real-IP/X-Forwarded-For correctly - but without this flag Koa
// ignores those headers entirely and ctx.request.ip always resolves to the
// proxy's own loopback address, NOT the real client. That silently broke
// the "localhost only" checks on /cleanup-cache and /warm-cache-reset -
// every request arriving through nginx looked local to Koa, regardless of
// where it actually came from.
app.proxy = true;
const router = new Router();

const pkgPath = path.join(__dirname, '../package.json');
const pkgVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '1.0.0';

let allowedHashes = new Set<string>();
const keysFile = path.join(__dirname, '../api_keys.txt');
if (fs.existsSync(keysFile)) {
  const lines = fs.readFileSync(keysFile, 'utf8').split('\n');
  for (const line of lines) {
    const hash = line.trim();
    if (hash) allowedHashes.add(hash);
  }
}

// No fallback. If api_keys.txt is missing or empty, the server will block all requests.
if (allowedHashes.size === 0) {
  console.warn('WARNING: No valid API keys found in api_keys.txt. All requests will be rejected with 401 Unauthorized.');
}

app.use(async (ctx, next) => {
  if (ctx.path === '/status' || ctx.path === '/metrics') {
    return next();
  }
  
  const reqKey = ctx.get('X-Freemap-API-Key') || '';
  const reqHash = crypto.createHash('sha256').update(reqKey).digest('hex');
  
  if (!allowedHashes.has(reqHash)) {
    ctx.status = 401;
    ctx.body = 'Unauthorized';
    return;
  }
  await next();
});

class Semaphore {
  tasks: Function[] = [];
  active = 0;
  constructor(public max: number) {}
  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise(resolve => this.tasks.push(resolve as Function));
  }
  release() {
    this.active--;
    const next = this.tasks.shift();
    if (next) {
      this.active++;
      next();
    }
  }
}
const concurrency = process.env.DOWNLOAD_CONCURRENCY ? parseInt(process.env.DOWNLOAD_CONCURRENCY, 10) : 2;
const downloadSemaphore = new Semaphore(concurrency);
const BOT_UA = process.env.USER_AGENT || 'FreemapCacheBot/1.0 (https://freemap.sk; freemap@freemap.sk)';
const WIKIMEDIA_ACCESS_TOKEN = process.env.WIKIMEDIA_ACCESS_TOKEN || '';

const commonHeaders: Record<string, string> = { 'User-Agent': BOT_UA };
if (WIKIMEDIA_ACCESS_TOKEN) {
  commonHeaders['Authorization'] = `Bearer ${WIKIMEDIA_ACCESS_TOKEN}`;
}

const httpAgent = new HttpAgent({ keepAlive: true });
const httpsAgent = new HttpsAgent({ keepAlive: true });
const customGot = got.extend({
  agent: {
    http: httpAgent,
    https: httpsAgent,
  }
});

// Background prefetch queue
interface PrefetchItem { pageId: string; clientId: string; }
const prefetchQueue: PrefetchItem[] = [];
const prefetchQueued = new Set<string>(); // Set of pageIds currently in queue
let prefetchWorkerRunning = false;
let successfulDownloadsSinceLastBlock = 0;

// LOG_FILE sa VZDY rozvinie na absolutnu cestu ukotvenu v adresari appky.
//
// Predtym sa relativna hodnota brala tak, ako prisla - a `.env.example` ju
// taku aj ponuka (LOG_FILE="wikimedia_errors.log"). `fs.appendFileSync` ju
// potom riesil voci `process.cwd()`, co pod systemd bez `WorkingDirectory=`
// je "/" - zapis teda skoncil na EACCES a do suboru sa nedostalo nic.
// Default smeruje do `logs/`, rovnako ako import (`importDump.ts`), aby boli
// vsetky logy na jednom mieste.
const LOG_FILE = path.resolve(
  __dirname,
  '..',
  process.env.LOG_FILE || 'logs/wikimedia_errors.log',
);
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

// Statistiky maju vlastny subor. Do error logu nepatria - miluje sa ich
// hladat prave preto, ze ich tam prekryvala prevadzkova omacka. Su to
// milniky, ktore chce clovek vidiet na jednom mieste a v case:
// dokoncene okruhy prehrievania cache, prechody medzi stagemi, denny suhrn
// a startovaci banner (ten dava zvysnym cislam kontext).
const STAT_LOG_FILE = path.resolve(
  __dirname,
  '..',
  process.env.STAT_LOG_FILE || 'logs/stat.log',
);
fs.mkdirSync(path.dirname(STAT_LOG_FILE), { recursive: true });

// Zlyhany zapis do logu sa uz NEPREHLTNE potichu. Prave to bolo na povodnej
// verzii najhorsie: `catch (e) {}` znamenalo, ze nefunkcne logovanie
// vyzeralo presne ako "nic sa nedeje". Hlasi sa raz, nech to nezaplavi
// journal pri trvalom probleme s pravami.
let logWriteFailureReported = false;

function appendToLogFile(msg: string, file: string = LOG_FILE) {
  try {
    fs.appendFileSync(file, msg + '\n');
  } catch (e) {
    if (!logWriteFailureReported) {
      logWriteFailureReported = true;
      console.error(
        `[log] Nepodarilo sa zapisat do ${file}: ${e}. ` +
        `Dalsie zlyhania zapisu uz nehlasim.`,
      );
    }
  }
}

function writeLog(msg: string) {
  console.log(msg);
  appendToLogFile(msg);
}

function writeErrorLog(msg: string) {
  console.error(msg);
  appendToLogFile(msg);
}

/// Milnik alebo suhrn - ide do `stat.log`, nie medzi chyby.
function writeStatLog(msg: string) {
  console.log(msg);
  appendToLogFile(msg, STAT_LOG_FILE);
}

function logWikimediaError(context: string, err: any) {
  const timestamp = new Date().toISOString();
  if (err.response) {
    writeErrorLog(`[${timestamp}] [WikimediaError] ${context}: Status ${err.response.statusCode}`);
    writeErrorLog(`[${timestamp}] [WikimediaError] Headers: ${JSON.stringify(err.response.headers)}`);
    const bodyStr = typeof err.response.body === 'string' ? err.response.body : 
                    (err.response.body instanceof Buffer ? err.response.body.toString('utf8') : JSON.stringify(err.response.body));
    const isHtml = bodyStr?.toLowerCase().includes('<!doctype html') || bodyStr?.toLowerCase().includes('<html');
    if (isHtml) {
      const cleanText = bodyStr
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      writeErrorLog(`[${timestamp}] [WikimediaError] Body snippet: ${cleanText.substring(0, 500)}`);
    } else {
      writeErrorLog(`[${timestamp}] [WikimediaError] Body snippet: ${bodyStr?.substring(0, 500)}`);
    }
  } else {
    writeErrorLog(`[${timestamp}] [WikimediaError] ${context}: ${err.message}`);
  }
  apiErrorCount++;
}

async function downloadThumbnailToCache(pageId: string, size: number, cachePath: string): Promise<void> {
  writeLog(`[prefetch] Starting fetch for pageId ${pageId}...`);
  const apiUrl = `https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url&iiurlwidth=${size}&pageids=${pageId}&format=json`;
  let apiResponse: any;
  try {
    apiResponse = await customGot.get(apiUrl, { headers: commonHeaders }).json();
  } catch (err: any) {
    if (err.response?.statusCode === 429) {
      writeLog(`[prefetch] === API BLOCKED AFTER ${successfulDownloadsSinceLastBlock} SUCCESSFUL DOWNLOADS ===`);
      successfulDownloadsSinceLastBlock = 0;
    }
    logWikimediaError(`API Request (pageId: ${pageId})`, err);
    throw err;
  }
  
  const pages = apiResponse.query?.pages as Record<string, any> | undefined;
  if (!pages || !pages[pageId]?.imageinfo) {
    deadFilesCount++;
    const svg = `
      <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#f8f9fa"/>
        <line x1="20%" y1="20%" x2="80%" y2="80%" stroke="#dc3545" stroke-width="4"/>
        <line x1="80%" y1="20%" x2="20%" y2="80%" stroke="#dc3545" stroke-width="4"/>
      </svg>
    `;
    const jpeg = await sharp(Buffer.from(svg)).jpeg().toBuffer();
    fs.writeFileSync(cachePath, jpeg);
    validCacheEntries.add(`${pageId}_${size}.jpg`);
    writeLog(`[prefetch] pageId ${pageId} has no imageinfo (deleted). Saved cross placeholder.`);
    return;
  }
  const thumbUrl = pages[pageId].imageinfo[0].thumburl as string;
  writeLog(`[prefetch] API success for pageId ${pageId}, found URL: ${thumbUrl}. Downloading image...`);

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const buffer = await customGot.get(thumbUrl, {
        headers: { ...commonHeaders, 'Accept': 'image/jpeg,image/png,*/*;q=0.5' },
        timeout: { request: 30000 },
        retry: { limit: 0 },
      }).buffer();
      if (buffer.length === 0) throw new Error('Empty response');
      const jpeg = await sharp(buffer).jpeg({ quality: 85 }).toBuffer();
      fs.writeFileSync(cachePath, jpeg);
      validCacheEntries.add(`${pageId}_${size}.jpg`);
      successfulDownloadsSinceLastBlock++;
      writeLog(`[prefetch] SUCCESS: Saved pageId ${pageId} to cache. (Total successful in a row: ${successfulDownloadsSinceLastBlock})`);
      return;
    } catch (err: any) {
      if (err.response?.statusCode === 429) {
        const retryAfter = parseInt(err.response.headers['retry-after'] ?? '15', 10);
        writeLog(`[prefetch] === IMAGE BLOCKED AFTER ${successfulDownloadsSinceLastBlock} SUCCESSFUL DOWNLOADS ===`);
        successfulDownloadsSinceLastBlock = 0;
        writeLog(`[prefetch] 429 pageId ${pageId}, waiting ${retryAfter}s`);
        logWikimediaError(`Image Download 429 (pageId: ${pageId})`, err);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      logWikimediaError(`Image Download Error (pageId: ${pageId})`, err);
      throw err;
    }
  }
  throw new Error('Failed to download thumbnail after 5 attempts (HTTP 429)');
}

async function runPrefetchWorker() {
  if (prefetchWorkerRunning) return;
  prefetchWorkerRunning = true;
  try {
    while (prefetchQueue.length > 0) {
      const item = prefetchQueue.shift()!;
      const pageId = item.pageId;
      const clientId = item.clientId;
      
      // Check if client is still active (within last 120 seconds)
      if (clientId && clientId !== 'legacy') {
        const lastSeen = activeClients.get(clientId);
        if (!lastSeen || Date.now() - lastSeen > 120 * 1000) {
          prefetchQueued.delete(pageId);
          continue;
        }
      }

      prefetchQueued.delete(pageId);
      const fileName = `${pageId}_120.jpg`;
      if (validCacheEntries.has(fileName)) continue;
      const cachePath = getCachePath(pageId, 120);
      await downloadSemaphore.acquire();
      try {
        await downloadThumbnailToCache(pageId, 120, cachePath);
        
        // Calculation: 25 Mbit/s = 3.125 MB/s = ~312 thumbs (10KB each) per second.
        // With 2 threads it's 156 thumbs/s per thread, which is a ~6ms pause.
        // Let's use 10ms to maximize bandwidth utilization.
        await new Promise(r => setTimeout(r, 10));
      } catch (err: any) {
        writeErrorLog(`[prefetch] Failed to download pageId ${pageId}: ${err.message}`);
      } finally {
        downloadSemaphore.release();
      }
    }
  } finally {
    prefetchWorkerRunning = false;
  }
}

function enqueuePrefetch(pageIds: string[], clientId: string) {
  for (const id of pageIds) {
    if (!prefetchQueued.has(id)) {
      const fileName = `${id}_120.jpg`;
      if (!validCacheEntries.has(fileName)) {
        prefetchQueued.add(id);
        prefetchQueue.push({ pageId: id, clientId });
      }
    }
  }
  if (!prefetchWorkerRunning) runPrefetchWorker().catch(() => {});
}

// Standard thumbnail sizes per https://www.mediawiki.org/wiki/Common_thumbnail_sizes
const STANDARD_THUMB_SIZES = [20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840];

function snapToStandardSize(requested: number): number {
  return STANDARD_THUMB_SIZES.reduce((prev, curr) =>
    Math.abs(curr - requested) < Math.abs(prev - requested) ? curr : prev
  );
}

async function getCacheDirStats(): Promise<{ fileCount: number; totalSize: number }> {
  let fileCount = 0;
  let totalSize = 0;
  try {
    const files = await listCacheFilesRecursive();
    fileCount = files.length;
    for (const relPath of files) {
      const stats = await fs.promises.stat(path.join(CACHE_DIR, relPath)).catch(() => null);
      if (stats) totalSize += stats.size;
    }
  } catch (err) {
    console.error('Error reading cache dir stats', err);
  }
  return { fileCount, totalSize };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)}${units[unitIndex]}`;
}

const activeClients = new Map<string, number>();
const validCacheEntries = new Set<string>();
let cacheMissesCount = 0;
let cacheHitsCount = 0;
let apiErrorCount = 0;
let deadFilesCount = 0;

router.get('/status', async (ctx) => {
  const now = Date.now();
  for (const [id, lastSeen] of activeClients.entries()) {
    if (now - lastSeen > 24 * 60 * 60 * 1000) activeClients.delete(id);
  }

  const { fileCount, totalSize } = await getCacheDirStats();

  let dbRowsEstimate = 0;
  try {
    const result = await getPool().query("SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'wikimedia_photo'");
    dbRowsEstimate = parseInt(result.rows[0]?.estimate || '0', 10);
  } catch (err) {
    console.error('Error fetching db row count estimate', err);
  }

  ctx.body = {
    service: 'WikiMediaCache',
    version: pkgVersion,
    status: 'ok',
    uptime: process.uptime(),
    queueLength: prefetchQueue.length,
    cachedFilesCount: fileCount,
    cachedFilesSizeBytes: totalSize,
    activeClients24hCount: activeClients.size,
    cacheHitsCount,
    cacheMissesCount,
    deadFilesCount,
    apiErrorCount,
    dbPhotosCount: dbRowsEstimate,
    warmCacheEnabled: WARM_CACHE_ENABLED,
    warmCacheDownloadedCount,
    warmCacheSkippedCount,
    warmCacheStage: WARM_CACHE_STAGES[warmCacheState.stageIndex]?.name,
    warmCacheLaps: warmCacheState.laps,
    warmCacheCursor: warmCacheState.cursor
  };
});

router.get('/metrics', async (ctx) => {
  const now = Date.now();
  for (const [id, lastSeen] of activeClients.entries()) {
    if (now - lastSeen > 24 * 60 * 60 * 1000) activeClients.delete(id);
  }

  const { fileCount, totalSize } = await getCacheDirStats();

  let dbRowsEstimate = 0;
  try {
    const result = await getPool().query("SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'wikimedia_photo'");
    dbRowsEstimate = parseInt(result.rows[0]?.estimate || '0', 10);
  } catch (err) {}

  ctx.type = 'text/plain; version=0.0.4';
  ctx.body = `
# HELP wikimedia_cache_files_count Number of cached thumbnail files
# TYPE wikimedia_cache_files_count gauge
wikimedia_cache_files_count ${fileCount}

# HELP wikimedia_cache_size_bytes Total size of cached files
# TYPE wikimedia_cache_size_bytes gauge
wikimedia_cache_size_bytes ${totalSize}

# HELP wikimedia_active_clients_24h Number of unique clients in the last 24h
# TYPE wikimedia_active_clients_24h gauge
wikimedia_active_clients_24h ${activeClients.size}

# HELP wikimedia_db_photos_count Estimated number of photo records in the database
# TYPE wikimedia_db_photos_count gauge
wikimedia_db_photos_count ${dbRowsEstimate}

# HELP wikimedia_cache_hits_total Total number of cache hits
# TYPE wikimedia_cache_hits_total counter
wikimedia_cache_hits_total ${cacheHitsCount}

# HELP wikimedia_cache_misses_total Total number of cache misses
# TYPE wikimedia_cache_misses_total counter
wikimedia_cache_misses_total ${cacheMissesCount}

# HELP wikimedia_api_errors_total Total number of upstream API errors
# TYPE wikimedia_api_errors_total counter
wikimedia_api_errors_total ${apiErrorCount}

# HELP wikimedia_dead_files_total Total number of deleted files placeholder hits
# TYPE wikimedia_dead_files_total counter
wikimedia_dead_files_total ${deadFilesCount}

# HELP wikimedia_prefetch_queue_length Number of items waiting to be downloaded
# TYPE wikimedia_prefetch_queue_length gauge
wikimedia_prefetch_queue_length ${prefetchQueue.length}

# HELP wikimedia_warm_cache_downloaded_total Total number of thumbnails downloaded by the idle cache warmer
# TYPE wikimedia_warm_cache_downloaded_total counter
wikimedia_warm_cache_downloaded_total ${warmCacheDownloadedCount}

# HELP wikimedia_warm_cache_skipped_total Total number of already-cached thumbnails skipped by the idle cache warmer
# TYPE wikimedia_warm_cache_skipped_total counter
wikimedia_warm_cache_skipped_total ${warmCacheSkippedCount}

# HELP wikimedia_warm_cache_stage_index Index of the current warm-cache bbox stage (0 = svk, 1 = v4, ...)
# TYPE wikimedia_warm_cache_stage_index gauge
wikimedia_warm_cache_stage_index ${warmCacheState.stageIndex}

# HELP wikimedia_warm_cache_laps Number of full laps completed of the current warm-cache stage's bbox
# TYPE wikimedia_warm_cache_laps gauge
wikimedia_warm_cache_laps ${warmCacheState.laps}
`.trim() + '\n';
});

router.get('/cancel-prefetch', (ctx) => {
  const clientId = ctx.query['clientId'] as string;
  if (!clientId) {
    ctx.status = 400;
    ctx.body = 'Missing clientId';
    return;
  }
  activeClients.delete(clientId);
  let removedCount = 0;
  for (let i = prefetchQueue.length - 1; i >= 0; i--) {
    const item = prefetchQueue[i];
    if (item && item.clientId === clientId) {
      prefetchQueued.delete(item.pageId);
      prefetchQueue.splice(i, 1);
      removedCount++;
    }
  }
  ctx.body = { status: 'ok', removedCount };
});

router.get('/pictures', async (ctx) => {
  const { bbox, clientId } = ctx.query;
  if (typeof clientId === 'string' && clientId) activeClients.set(clientId, Date.now());
  if (!bbox || typeof bbox !== 'string') return;
  const parts = bbox.split(',').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return;
  const [minLon, minLat, maxLon, maxLat] = parts;
  try {
    const query = `
      SELECT page_id, ST_X(location) as lon, ST_Y(location) as lat 
      FROM wikimedia_photo 
      WHERE location && ST_MakeEnvelope($1, $2, $3, $4, 4326)
      ORDER BY page_id DESC
      LIMIT 5000
    `;
    const result = await getPool().query(query, [minLon, minLat, maxLon, maxLat]);
    const rows = result.rows
      .filter(row => isFinite(row.lat) && isFinite(row.lon))
      .map(row => ({ pageId: row.page_id, lat: row.lat, lon: row.lon }));
    ctx.body = rows;
    
    if (ctx.query['prefetch'] === 'true' && typeof clientId === 'string') {
      enqueuePrefetch(rows.map(r => String(r.pageId)), clientId);
    }
  } catch (error: any) {
    writeErrorLog(`[/pictures] DB query failed for bbox ${bbox}: ${error.message}`);
    ctx.status = 500;
  }
});

router.get('/wikimedia/thumbnail/:pageId', async (ctx) => {
  const pageId = ctx.params['pageId'] as string;
  if (!/^\d+$/.test(pageId)) {
    ctx.status = 400;
    ctx.body = 'Invalid pageId';
    return;
  }
  const size = snapToStandardSize(parseInt(ctx.query['size'] as string) || 120);
  const fileName = `${pageId}_${size}.jpg`;
  const cachePath = getCachePath(pageId, size);

  const clientId = ctx.query['clientId'] as string;
  if (clientId) activeClients.set(clientId, Date.now());
  
  if (validCacheEntries.has(fileName)) {
    if (fs.existsSync(cachePath)) {
      const stat = fs.statSync(cachePath);
      if (stat.size > 0) {
        cacheHitsCount++;
        ctx.set('Content-Type', 'image/jpeg');
        ctx.set('Cache-Control', 'public, max-age=31536000');
        ctx.body = fs.createReadStream(cachePath);
        return;
      }
      fs.unlinkSync(cachePath);
    }
    validCacheEntries.delete(fileName);
  }

  // Not cached yet — enqueue for background download and return 503
  cacheMissesCount++;
  enqueuePrefetch([pageId], clientId || 'legacy');
  ctx.status = 503;
  ctx.set('Retry-After', '15');
});

async function runSpatialCleanup(minLon: number, minLat: number, maxLon: number, maxLat: number, mode: 'inside' | 'outside') {
  console.log(`[cleanup] Starting spatial cleanup (mode: ${mode}) for bbox: ${minLon},${minLat},${maxLon},${maxLat}`);
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
  let deletedCount = 0;
  const BATCH = 5000;
  const pool = getPool();

  for (let i = 0; i < pageIds.length; i += BATCH) {
    const batchIds = pageIds.slice(i, i + BATCH);
    try {
      const query = `
        SELECT page_id FROM wikimedia_photo 
        WHERE page_id = ANY($1::int[]) 
        AND location && ST_MakeEnvelope($2, $3, $4, $5, 4326)
      `;
      const res = await pool.query(query, [batchIds, minLon, minLat, maxLon, maxLat]);
      const insideIds = new Set(res.rows.map(r => r.page_id));

      for (const id of batchIds) {
        const isInside = insideIds.has(id);
        const shouldDelete = mode === 'inside' ? isInside : !isInside;
        
        if (shouldDelete) {
          for (const relPath of fileMap.get(id)!) {
            const cachePath = path.join(CACHE_DIR, relPath);
            if (fs.existsSync(cachePath)) {
              fs.unlinkSync(cachePath);
              validCacheEntries.delete(path.basename(relPath));
              deletedCount++;
            }
          }
        }
      }
    } catch (err) {
      console.error(`[cleanup] Error in batch ${i}:`, err);
    }
  }
  console.log(`[cleanup] Finished spatial cleanup. Deleted ${deletedCount} files.`);
}

async function runFullCleanup() {
  console.log('[cleanup] Starting full cache wipe...');
  try {
    const files = await listCacheFilesRecursive();
    // Wipe the shard subdirectories themselves (not just their contents) and
    // recreate them empty, rather than unlinking one file at a time - a
    // recursive rm is a single syscall-cheap operation regardless of how
    // many files are inside, unlike iterating potentially millions of them.
    const entries = await fs.promises.readdir(CACHE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await fs.promises.rm(path.join(CACHE_DIR, entry.name), { recursive: true, force: true });
      }
    }
    ensureShardDirsExist();
    validCacheEntries.clear();
    console.log(`[cleanup] Finished full wipe. Deleted ${files.length} files.`);
  } catch (err) {
    console.error('[cleanup] Error during full wipe:', err);
  }
}

router.get('/cleanup-cache', async (ctx) => {
  const ip = ctx.request.ip;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    ctx.status = 403;
    ctx.body = 'Forbidden';
    return;
  }

  const region = ctx.query['region'] as string;
  const bboxStr = ctx.query['bbox'] as string;
  const mode = (ctx.query['mode'] as string) || 'outside';
  
  if (region === 'all') {
    runFullCleanup().catch(err => console.error('Full cleanup error', err));
    ctx.status = 202;
    ctx.body = { status: 'Accepted', message: 'Full cache cleanup started.' };
    return;
  }

  let bbox = [0, 0, 0, 0];
  if (region === 'svk') {
    bbox = process.env.BBOX_SVK ? process.env.BBOX_SVK.split(',').map(Number) : [16.83, 47.73, 22.57, 49.61];
  } else if (region === 'svk_cz') {
    bbox = process.env.BBOX_SVK_CZ ? process.env.BBOX_SVK_CZ.split(',').map(Number) : [12.09, 47.73, 22.57, 51.05];
  } else if (bboxStr) {
    const parts = bboxStr.split(',').map(Number);
    if (parts.length === 4 && parts.every(isFinite)) bbox = parts;
    else { ctx.status = 400; ctx.body = 'Invalid bbox'; return; }
  } else {
    ctx.status = 400; ctx.body = 'Missing region or bbox'; return;
  }

  if (mode !== 'outside' && mode !== 'inside') {
    ctx.status = 400; ctx.body = 'Mode must be outside or inside'; return;
  }

  runSpatialCleanup(bbox[0]!, bbox[1]!, bbox[2]!, bbox[3]!, mode as 'inside'|'outside').catch(err => {
    console.error('Spatial cleanup error', err);
  });

  ctx.status = 202;
  ctx.body = { status: 'Accepted', message: `Cleanup started for mode: ${mode}, bbox: ${bbox}` };
});

app.use(router.routes()).use(router.allowedMethods());

// --- Cache warmer -----------------------------------------------------
// Proactively pre-downloads thumbnails for photos in the current warm-cache
// stage's bbox during idle periods, so common requests are already warm by
// the time a real user pans there. Ticks at most once per
// WARM_CACHE_INTERVAL_MS and only when there's no active user-driven
// prefetch demand - real traffic always wins, this never competes with it.
// At the default 1s interval that's up to 3600 thumbs/hour while completely
// idle, negligible load on Wikimedia.
//
// Iterates by page_id ascending (not random) - coordinates are scattered
// across the bbox regardless of page_id order, so a sequential cursor
// already gives effectively random geographic coverage without the cost of
// `ORDER BY random()` on every tick.
//
// Staged escalation: starts with the (small, high-priority) SVK bbox; once
// a full lap of it is done (cursor reaches the end and wraps), it advances
// to the larger V4 bbox (SK+CZ+PL+HU) and continues from page_id 0 there.
// The V4 stage excludes the SVK bbox entirely (spatial NOT, not just a
// post-hoc skip) - SVK was already fully warmed in the previous stage, so
// there's no point even fetching those page_ids again. Add more stages to
// WARM_CACHE_STAGES for further escalation later (e.g. all of Europe) -
// each stage can exclude any bbox already covered by an earlier stage.
//
// State (stage index, cursor, lap count) persists to disk so a service
// restart resumes instead of starting over.
const WARM_CACHE_ENABLED = process.env.WARM_CACHE_ENABLED !== 'false';
const WARM_CACHE_INTERVAL_MS = process.env.WARM_CACHE_INTERVAL_MS
  ? parseInt(process.env.WARM_CACHE_INTERVAL_MS, 10)
  : 1000;
const WARM_CACHE_BATCH_SIZE = 50;
const WARM_CACHE_STATE_FILE = path.join(__dirname, '../warm_cache.checkpoint');

interface WarmCacheStage {
  name: string;
  bboxEnv: string;
  defaultBbox: number[];
  // Optional bbox to EXCLUDE from this stage's query (e.g. a smaller region
  // already fully warmed by an earlier stage, so it's not re-fetched).
  excludeBboxEnv?: string;
  excludeDefaultBbox?: number[];
  // How many full laps of this stage's bbox before advancing to the next
  // stage. The last stage should use Infinity (never advances further).
  lapsBeforeAdvance: number;
}

const SVK_DEFAULT_BBOX = [16.83, 47.73, 22.57, 49.61];
const V4_DEFAULT_BBOX = [12.0, 45.7, 24.2, 55.0];
// Rough Europe bbox (Iceland/Portugal to the Urals, Mediterranean to
// Scandinavia) - doesn't need to be precise, this is just a warming order,
// not a hard filter on what's ever servable.
const EU_DEFAULT_BBOX = [-25, 34, 45, 71];

const WARM_CACHE_STAGES: WarmCacheStage[] = [
  { name: 'svk', bboxEnv: 'BBOX_SVK', defaultBbox: SVK_DEFAULT_BBOX, lapsBeforeAdvance: 1 },
  {
    name: 'v4',
    bboxEnv: 'BBOX_V4',
    defaultBbox: V4_DEFAULT_BBOX,
    excludeBboxEnv: 'BBOX_SVK',
    excludeDefaultBbox: SVK_DEFAULT_BBOX,
    // Next month, once V4 is (near-)fully warm from continued idle running,
    // one more lap here should complete fast - most candidates will already
    // be cached and get skipped in the same tick (see warmCacheTick).
    lapsBeforeAdvance: 1,
  },
  {
    name: 'eu',
    bboxEnv: 'BBOX_EU',
    defaultBbox: EU_DEFAULT_BBOX,
    excludeBboxEnv: 'BBOX_V4',
    excludeDefaultBbox: V4_DEFAULT_BBOX,
    lapsBeforeAdvance: Infinity,
  },
];

function resolveBbox(envName: string, fallback: number[]): number[] {
  const envVal = process.env[envName];
  return envVal ? envVal.split(',').map(Number) : fallback;
}

function getStageBbox(stage: WarmCacheStage): number[] {
  return resolveBbox(stage.bboxEnv, stage.defaultBbox);
}

interface WarmCacheState { stageIndex: number; cursor: number; laps: number; }

let warmCacheState: WarmCacheState = { stageIndex: 0, cursor: 0, laps: 0 };
try {
  if (fs.existsSync(WARM_CACHE_STATE_FILE)) {
    const raw = fs.readFileSync(WARM_CACHE_STATE_FILE, 'utf8').trim();
    // Backward-compat: older checkpoint files just contained a bare page_id.
    warmCacheState = /^\d+$/.test(raw)
      ? { stageIndex: 0, cursor: parseInt(raw, 10), laps: 0 }
      : { ...warmCacheState, ...JSON.parse(raw) };
  }
} catch (e) {}

let warmCacheBatch: number[] = [];
let warmCacheDownloadedCount = 0;
let warmCacheSkippedCount = 0;
let warmCacheDownloadedSinceLastSummary = 0;

async function fetchWarmCacheBatch(stage: WarmCacheStage, afterPageId: number): Promise<number[]> {
  const bbox = getStageBbox(stage);
  const params: number[] = [bbox[0]!, bbox[1]!, bbox[2]!, bbox[3]!, afterPageId];
  let query = `
    SELECT page_id FROM wikimedia_photo
    WHERE location && ST_MakeEnvelope($1, $2, $3, $4, 4326)
      AND page_id > $5
  `;
  if (stage.excludeBboxEnv || stage.excludeDefaultBbox) {
    const exBbox = stage.excludeBboxEnv
      ? resolveBbox(stage.excludeBboxEnv, stage.excludeDefaultBbox!)
      : stage.excludeDefaultBbox!;
    params.push(exBbox[0]!, exBbox[1]!, exBbox[2]!, exBbox[3]!);
    query += ` AND NOT (location && ST_MakeEnvelope($6, $7, $8, $9, 4326))`;
  }
  query += ` ORDER BY page_id ASC LIMIT $${params.length + 1}`;
  params.push(WARM_CACHE_BATCH_SIZE);
  const result = await getPool().query(query, params);
  return result.rows.map(r => r.page_id as number);
}

function nextStageForAdvance(): WarmCacheStage {
  const stage = WARM_CACHE_STAGES[warmCacheState.stageIndex]!;
  // Reached the end of this stage's bbox by page_id - one full lap done.
  warmCacheState.laps++;
  writeStatLog(`[warm-cache] Completed lap ${warmCacheState.laps} of stage '${stage.name}'.`);
  if (warmCacheState.laps >= stage.lapsBeforeAdvance && warmCacheState.stageIndex < WARM_CACHE_STAGES.length - 1) {
    warmCacheState.stageIndex++;
    warmCacheState.laps = 0;
    const nextStage = WARM_CACHE_STAGES[warmCacheState.stageIndex]!;
    writeStatLog(`[warm-cache] Advancing to stage '${nextStage.name}'.`);
    return nextStage;
  }
  return stage;
}

// Upper bound on how many already-cached candidates a single tick will skip
// past while looking for one that actually needs downloading. Without this,
// a mostly/fully-warmed stage (e.g. re-lapping V4 after a month of steady
// warming) would mean most ticks find nothing to do and effectively stall -
// this makes the guarantee "one fresh download per tick, unless the entire
// stage really is fully cached" instead of "one *check* per tick".
const WARM_CACHE_MAX_ATTEMPTS_PER_TICK = 500;

async function warmCacheTick() {
  if (!WARM_CACHE_ENABLED) return;
  // Real user traffic always has priority - never compete with it.
  if (prefetchQueue.length > 0 || prefetchWorkerRunning) return;

  try {
    for (let attempt = 0; attempt < WARM_CACHE_MAX_ATTEMPTS_PER_TICK; attempt++) {
      let stage = WARM_CACHE_STAGES[warmCacheState.stageIndex]!;

      if (warmCacheBatch.length === 0) {
        warmCacheBatch = await fetchWarmCacheBatch(stage, warmCacheState.cursor);
        if (warmCacheBatch.length === 0) {
          stage = nextStageForAdvance();
          warmCacheState.cursor = 0;
          warmCacheBatch = await fetchWarmCacheBatch(stage, 0);
          if (warmCacheBatch.length === 0) return; // no photos in this stage's bbox at all
        }
      }

      const pageId = warmCacheBatch.shift()!;
      warmCacheState.cursor = pageId;
      const fileName = `${pageId}_120.jpg`;
      if (validCacheEntries.has(fileName)) {
        warmCacheSkippedCount++;
        continue; // already warm - try the next candidate right away, same tick
      }

      const cachePath = getCachePath(pageId, 120);
      await downloadSemaphore.acquire();
      try {
        await downloadThumbnailToCache(String(pageId), 120, cachePath);
        warmCacheDownloadedCount++;
        warmCacheDownloadedSinceLastSummary++;
      } catch (err: any) {
        writeErrorLog(`[warm-cache] Failed to download pageId ${pageId}: ${err.message}`);
      } finally {
        downloadSemaphore.release();
      }
      return; // downloaded (or tried to) one photo - done for this tick
    }
    writeStatLog(`[warm-cache] Skipped ${WARM_CACHE_MAX_ATTEMPTS_PER_TICK} already-cached candidates in one tick without finding new work - stage is nearly/fully warm.`);
  } catch (err: any) {
    writeErrorLog(`[warm-cache] Tick error: ${err.message}`);
  }
}

if (WARM_CACHE_ENABLED) {
  setInterval(() => {
    warmCacheTick().catch(() => {});
  }, WARM_CACHE_INTERVAL_MS);

  // Persist state periodically (not on every tick) so a restart resumes
  // close to where it left off without a disk write every second.
  setInterval(() => {
    try {
      fs.writeFileSync(WARM_CACHE_STATE_FILE, JSON.stringify(warmCacheState));
    } catch (e) {}
  }, 60 * 1000);

  // Daily digest, independent of the per-tick/per-lap logging above - makes
  // it easy to eyeball warming throughput over time (e.g. "are we actually
  // making progress towards a full SVK/V4 pass?") without having to count
  // individual tick lines.
  setInterval(async () => {
    const stage = WARM_CACHE_STAGES[warmCacheState.stageIndex]?.name;
    const { fileCount, totalSize } = await getCacheDirStats();
    writeStatLog(
      `[warm-cache] Daily summary: pre-warmed ${warmCacheDownloadedSinceLastSummary} thumbnails in the last 24h ` +
      `(current stage: '${stage}', lap ${warmCacheState.laps}, total pre-warmed since startup: ${warmCacheDownloadedCount}). ` +
      `Cache now holds ${fileCount} files (${formatBytes(totalSize)}).`
    );
    warmCacheDownloadedSinceLastSummary = 0;
  }, 24 * 60 * 60 * 1000);
}

// Called by importDump.ts once a fresh monthly dump has finished importing -
// a new dump may contain newly-added Slovak photos, so warming should start
// over from the small, high-priority SVK bbox instead of continuing wherever
// it happened to be (e.g. deep into the V4 stage). Localhost-only, same
// pattern as /cleanup-cache.
router.get('/warm-cache-reset', (ctx) => {
  const ip = ctx.request.ip;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    ctx.status = 403;
    ctx.body = 'Forbidden';
    return;
  }
  warmCacheState = { stageIndex: 0, cursor: 0, laps: 0 };
  warmCacheBatch = [];
  writeStatLog('[warm-cache] State reset to stage 0 (svk) via /warm-cache-reset.');
  ctx.body = { status: 'ok', warmCacheState };
});

const PORT = process.env.PORT || 4000;

setInterval(() => {
  const now = Date.now();
  for (const [clientId, lastSeen] of activeClients.entries()) {
    if (now - lastSeen > 24 * 60 * 60 * 1000) {
      activeClients.delete(clientId);
    }
  }
}, 60 * 60 * 1000); // Run cleanup every hour

async function start() {
  await initDb();
  ensureShardDirsExist();

  try {
    const files = await listCacheFilesRecursive();
    for (const relPath of files) {
      validCacheEntries.add(path.basename(relPath));
    }
    console.log(`Loaded ${validCacheEntries.size} cache entries into RAM.`);
  } catch (err) {
    console.error('Failed to load cache entries to RAM:', err);
  }

  const tokenStr = WIKIMEDIA_ACCESS_TOKEN ? `${WIKIMEDIA_ACCESS_TOKEN.substring(0, 15)}...` : 'NONE';
  const startupMsg = `[${new Date().toISOString()}] [STARTUP] WikiMediaCache started.\n` +
                     `[STARTUP] User-Agent: ${BOT_UA}\n` +
                     `[STARTUP] Concurrency: ${concurrency}\n` +
                     `[STARTUP] Token (first 15 chars): ${tokenStr}`;
  writeStatLog(startupMsg);

  app.listen(PORT as number, '0.0.0.0', () => console.log(`WikiMediaCache service running on port ${PORT}`));
}

// Without these, an error thrown outside a request handler's own try/catch
// (e.g. in a stray promise, a timer callback) crashes the process silently -
// systemd/pm2 would just see it exit and restart it, with no record of why.
// Still exits after logging (Node's own advice: an uncaught exception leaves
// the process in an undefined state, so resuming instead of restarting is
// riskier than the crash itself).
process.on('uncaughtException', (err) => {
  writeErrorLog(`[FATAL] Uncaught exception: ${err.stack || err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  writeErrorLog(`[FATAL] Unhandled rejection: ${msg}`);
  process.exit(1);
});

start();
