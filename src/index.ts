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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();

const app = new Koa();
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

const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, '../wikimedia_errors.log');

function writeLog(msg: string) {
  console.log(msg);
  try { fs.appendFileSync(LOG_FILE, msg + '\n'); } catch (e) {}
}

function writeErrorLog(msg: string) {
  console.error(msg);
  try { fs.appendFileSync(LOG_FILE, msg + '\n'); } catch (e) {}
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
    apiResponse = await customGot.get(apiUrl, { headers: { 'User-Agent': BOT_UA } }).json();
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
        headers: { 'User-Agent': BOT_UA, 'Accept': 'image/jpeg,image/png,*/*;q=0.5' },
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
      const cachePath = path.join(CACHE_DIR, fileName);
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

const CACHE_DIR = path.join(__dirname, '../cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
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

  let fileCount = 0;
  let totalSize = 0;
  try {
    const files = await fs.promises.readdir(CACHE_DIR);
    fileCount = files.length;
    for (const file of files) {
      const stats = await fs.promises.stat(path.join(CACHE_DIR, file)).catch(() => null);
      if (stats) {
        totalSize += stats.size;
      }
    }
  } catch (err) {
    console.error('Error reading cache dir for status', err);
  }

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
    dbPhotosCount: dbRowsEstimate
  };
});

router.get('/metrics', async (ctx) => {
  const now = Date.now();
  for (const [id, lastSeen] of activeClients.entries()) {
    if (now - lastSeen > 24 * 60 * 60 * 1000) activeClients.delete(id);
  }

  let fileCount = 0;
  let totalSize = 0;
  try {
    const files = await fs.promises.readdir(CACHE_DIR);
    fileCount = files.length;
    for (const file of files) {
      const stats = await fs.promises.stat(path.join(CACHE_DIR, file)).catch(() => null);
      if (stats) totalSize += stats.size;
    }
  } catch (err) {}

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
  } catch (error) {
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
  const cachePath = path.join(CACHE_DIR, fileName);

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
  const files = await fs.promises.readdir(CACHE_DIR);
  const fileMap = new Map<number, string[]>();
  
  for (const file of files) {
    if (!file.endsWith('.jpg')) continue;
    const pageId = parseInt(file.split('_')[0]!, 10);
    if (!isNaN(pageId)) {
      if (!fileMap.has(pageId)) fileMap.set(pageId, []);
      fileMap.get(pageId)!.push(file);
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
          for (const file of fileMap.get(id)!) {
            const cachePath = path.join(CACHE_DIR, file);
            if (fs.existsSync(cachePath)) {
              fs.unlinkSync(cachePath);
              validCacheEntries.delete(file);
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
  let deletedCount = 0;
  try {
    const files = await fs.promises.readdir(CACHE_DIR);
    for (const file of files) {
      if (file.endsWith('.jpg')) {
        const cachePath = path.join(CACHE_DIR, file);
        if (fs.existsSync(cachePath)) {
          fs.unlinkSync(cachePath);
          deletedCount++;
        }
      }
    }
    validCacheEntries.clear();
    console.log(`[cleanup] Finished full wipe. Deleted ${deletedCount} files.`);
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
  
  try {
    const files = await fs.promises.readdir(CACHE_DIR);
    for (const file of files) {
      if (file.endsWith('.jpg')) validCacheEntries.add(file);
    }
    console.log(`Loaded ${validCacheEntries.size} cache entries into RAM.`);
  } catch (err) {
    console.error('Failed to load cache entries to RAM:', err);
  }

  app.listen(PORT as number, '0.0.0.0', () => console.log(`WikiMediaCache service running on port ${PORT}`));
}
start();
