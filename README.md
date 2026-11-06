# WikiMediaCache

WikiMediaCache is a microservice that caches Wikimedia Commons geotagged photo coordinates and serves them to the Freemap mobile app.

Instead of querying the Wikimedia Commons API directly from the mobile app (which has bbox size limits and rate constraints), this service pre-caches all photo coordinates from the monthly Wikimedia data dump and exposes a simple bbox query endpoint.

## API

### 1. Fetching coordinates (Bounding Box)

```http
GET /pictures?bbox=<minLon>,<minLat>,<maxLon>,<maxLat>&clientId=<uniqueId>&prefetch=<true/false>
```

Returns a list of photos within the bounding box:

```json
[
  { "pageId": 12345678, "lat": 48.1486, "lon": 17.1077 },
  ...
]
```

Returns up to 5000 results by default. Optional parameters:

- `limit=<1..50000>` — result budget for this request (default 5000).
- `cells=<1..64>` — stratified sample: the bbox is split into `cells × cells`
  grid cells and each cell returns at most `limit / cells²` photos (newest
  first). Without it a big city eats the whole budget and the countryside
  around it comes back empty. With `cells` every photo also carries `n`, the
  true number of photos in its cell, so a client can draw density even though
  the sample itself is capped.
- `iss=1` — include photos with coarse coordinates (at most one decimal in
  both lat and lon). Those are mostly Earth-observation shots from the ISS and
  satellites, geotagged with the nadir point (often at sea); they are flagged
  `coarse` at import and skipped by default. Full original metadata (author, license, description) is still fetched directly from the Wikimedia API on demand in the mobile app.

### 2. Fetching thumbnail (Cached Thumbnail)

```http
GET /wikimedia/thumbnail/<pageId>?size=<pixels>
```

Example: `/wikimedia/thumbnail/12345678?size=120` (size is optional, defaults to 120). The backend automatically snaps the requested size to standard Wikimedia thumbnail sizes (120, 250, 500...) to maximize cache hit rate.

**Endpoint behavior and caching details:**
- **Storage**: Thumbnails live as BLOBs in SQLite (see [Cache storage](#cache-storage-sqlite)). A lookup is a primary-key read of tens of microseconds, so there is no in-RAM index of filenames any more and nothing is listed at startup.
- **Cache Hit**: If the thumbnail exists, it immediately returns the image with `Content-Type: image/jpeg`, `Content-Length`, `Cache-Control: public, max-age=31536000` and `Last-Modified` (time the thumbnail was stored). A request with a matching `If-Modified-Since` gets `304 Not Modified`.
- **Cache Miss (Queued)**: If the thumbnail is not downloaded yet, the backend adds it to an asynchronous download queue and returns **HTTP 503 Service Unavailable** with a `Retry-After: 15` header. The app shouldn't block, but rather silently retry fetching it later.
- **Dead/Deleted files**: If the upstream Wikimedia API reports that the file no longer exists (e.g., `No imageinfo`), the server dynamically generates a small placeholder JPEG (a red cross on a gray background) and saves it permanently to the cache under the same pageId. Subsequent requests for this deleted file will return `200 OK` with the placeholder, thus preventing infinite retry loops from the mobile app.
- **Queue Cleanup**: The background queue tracks the activity of each `clientId`. If a client disconnects or stops panning for more than 120 seconds, any pending downloads associated with their `clientId` are silently dropped to save bandwidth.

### 3. Server Status

```http
GET /status
```

Returns the current status of the service, uptime, and the number of images currently waiting in the background download queue. It also provides cache statistics: `cachedFilesCount` is the number of thumbnails in SQLite and `cachedFilesSizeBytes` the size of the shard files (`.db` + `-wal`). Both are cached for one minute. Files the migration has not moved yet are not counted.

```json
{
  "service": "WikiMediaCache",
  "version": "1.1.1",
  "status": "ok",
  "uptime": 1234.56,
  "queueLength": 0,
  "cachedFilesCount": 1500,
  "cachedFilesSizeBytes": 20480000,
  "activeClients24hCount": 42,
  "cacheHitsCount": 1234,
  "cacheMissesCount": 456,
  "deadFilesCount": 5,
  "apiErrorCount": 12
}
```

### 4. Cancel Prefetch

```http
GET /cancel-prefetch?clientId=<uniqueId>
```

Silently removes all pending background download tasks from the queue for the specified `clientId`. This is useful when the user pans away to a different area and the old thumbnails are no longer needed.

Note: The server will also automatically drop queue items for clients that have not been active (sent any requests) in the last 120 seconds.

### 5. Spatial Cache Cleanup (Admin / Localhost only)

```http
GET /cleanup-cache?region=svk&mode=outside
```

A powerful background task that scans all downloaded thumbnails and deletes those that fall **outside** (or **inside**) a specific bounding box. This is highly useful to free up disk space by removing globally downloaded images while keeping local ones (e.g. SVK/CZ).

**Parameters**:
- `region`: Use predefined bounding boxes. Available options: `svk`, `svk_cz`, or `all` (completely wipes the entire cache directory, bypassing spatial checks).
- `bbox`: Use a custom bounding box: `minLon,minLat,maxLon,maxLat`.
- `mode`: `outside` (default, deletes everything outside the bbox) or `inside` (deletes everything inside the bbox).

**Security**: This endpoint checks `ctx.ip` and rejects any request that doesn't originate from `127.0.0.1` or `::1` (returns `403 Forbidden`).

**Response**:
Returns `202 Accepted` immediately. The cleanup task runs asynchronously in the background.

### Idle cache warmer

While the service is idle (no active user-driven prefetch demand), a background job downloads **one fresh thumbnail per tick** (default: every `WARM_CACHE_INTERVAL_MS` = 1000ms), so the cache is already warm by the time a real user pans there. Real traffic always takes priority - the warmer pauses immediately whenever the prefetch queue is non-empty.

Within a tick, already-cached candidates are skipped immediately (no waiting) until one that actually needs downloading is found - the pacing (both the tick interval and the per-stage gap below) only applies *between* actual downloads, not between checks. So once a region is fully warm and only the odd new photo trickles in, it still ends up cached almost immediately instead of being throttled to "maybe once every N seconds" by how many already-cached IDs happen to precede it.

It walks the dataset by `page_id` ascending (not random) within the current stage's bbox - coordinates are scattered geographically regardless of `page_id` order, so this already gives effectively random coverage without the cost of `ORDER BY random()` on every tick.

**Staged escalation**: warming starts with the small, high-priority `BBOX_SVK` bbox, then `BBOX_V4` (Slovakia + Czechia + Poland + Hungary), then `BBOX_EU` (all of Europe) - each stage advances to the next once it completes a full lap (cursor reaches the end and wraps around). Each stage after the first spatially excludes the bbox(es) already covered by earlier stages (`AND NOT (location && ...)`) so that region is never even fetched again, not just skipped. `BBOX_EU` is the final stage (never advances further) - add more entries to `WARM_CACHE_STAGES` in `src/index.ts` if an even wider scope is ever needed.

**Per-stage pacing**: each stage also carries a `downloadGapMs` - a minimum spacing between two *actual* downloads, on top of the tick interval. SVK uses `0` (the tick interval alone governs, i.e. one per second), while V4 and EU use `2000`. The reasoning is that SVK is small and high-priority, so it should finish fast, whereas the wider stages are far larger and much less urgent - a local user only ever sees a fraction of them - so there's no reason to sustain a high request rate against Wikimedia for them. Slowing them down keeps rate-limit headroom for the unplanned, user-driven requests that arrive from anywhere in Europe. Override per stage with `WARM_CACHE_GAP_MS_<STAGE>`, e.g. `WARM_CACHE_GAP_MS_V4=3000`.

The gap is measured from the *completion* of the previous download and applies to every attempt that actually reached Wikimedia, failures included - a failed request counts against their rate limit just the same. Skipping already-cached candidates is never delayed. Because ticks fire on a fixed grid, the gate rounds to the nearest tick rather than always up: without that, `downloadGapMs=2000` on a 1s tick would in practice mean a 3-second spacing (1200/h instead of 1800/h), i.e. the configured number would not mean what it says.

State (current stage, cursor, lap count) is persisted to `warm_cache.checkpoint` every 60s so a restart resumes instead of starting over.

`importDump.ts` automatically resets the warmer back to stage 0 (SVK) after each successful monthly import, via a localhost-only `GET /warm-cache-reset` call to the running server - a fresh dump may contain newly-added Slovak photos, so warming should re-scan SVK rather than continuing wherever it happened to be (possibly deep into the V4/EU stage already). This is best-effort: if the server isn't running when the import script runs, it just logs a warning and continues.

Configure via `.env`:
```env
WARM_CACHE_ENABLED=true
WARM_CACHE_INTERVAL_MS=1000
# Optional per-stage overrides of the built-in downloadGapMs (svk=0, v4/eu=2000)
# WARM_CACHE_GAP_MS_SVK=0
# WARM_CACHE_GAP_MS_V4=2000
# WARM_CACHE_GAP_MS_EU=2000
BBOX_V4="12.0,45.7,24.2,55.0"
BBOX_EU="-25,34,45,71"
```

At the default interval that's up to 3600 thumbnails/hour during the SVK stage while fully idle, and 1800/hour once it reaches V4 or EU - negligible load on Wikimedia either way. Progress is visible in `/status` (`warmCacheDownloadedCount`, `warmCacheSkippedCount`, `warmCacheStage`, `warmCacheGapMs`, `warmCacheLaps`, `warmCacheCursor`) and `/metrics`.

Logged to the **stats log** (`STAT_LOG_FILE`, default `logs/stat.log`) - deliberately separate from the error log, since these are milestones rather than failures. Both paths resolve relative to the app directory, not the working directory. (Not to be confused with `logs/import.log` - that one is import-only, see above.)
- Every time a stage's bbox completes a full lap (`Completed lap N of stage 'svk'.`) and whenever it advances to the next stage (`Advancing to stage 'v4'.`) - so you can tell exactly when SVK (and later V4) has been fully pre-warmed.
- A periodic digest (`Summary: pre-warmed N thumbnails in the last 1h ...`) so warming throughput is easy to eyeball over time without counting individual lines. The period is `STAT_SUMMARY_INTERVAL_MS` (default 1 hour); the line always states the period it covers, so it stays readable if you change it.

Once V4 finishes a full lap too, adding an even wider stage (e.g. all of Europe) is a one-line addition to `WARM_CACHE_STAGES` - no other changes needed.

### 6. Metrics (Prometheus)

```http
GET /metrics
```

Exposes standard Prometheus-compatible metrics, perfect for monitoring via **Grafana** or **Uptime Kuma**.

```text
# HELP wikimedia_cache_files_count Number of cached thumbnail files
# TYPE wikimedia_cache_files_count gauge
wikimedia_cache_files_count 1500

# HELP wikimedia_cache_size_bytes Total size of cached files
# TYPE wikimedia_cache_size_bytes gauge
wikimedia_cache_size_bytes 20480000

# HELP wikimedia_active_clients_24h Number of unique clients in the last 24h
# TYPE wikimedia_active_clients_24h gauge
wikimedia_active_clients_24h 42

# HELP wikimedia_cache_hits_total Total number of cache hits
# TYPE wikimedia_cache_hits_total counter
wikimedia_cache_hits_total 1234

# HELP wikimedia_cache_misses_total Total number of cache misses
# TYPE wikimedia_cache_misses_total counter
wikimedia_cache_misses_total 456

# HELP wikimedia_api_errors_total Total number of upstream API errors
# TYPE wikimedia_api_errors_total counter
wikimedia_api_errors_total 12

# HELP wikimedia_dead_files_total Total number of deleted files placeholder hits
# TYPE wikimedia_dead_files_total counter
wikimedia_dead_files_total 5

# HELP wikimedia_prefetch_queue_length Number of items waiting to be downloaded
# TYPE wikimedia_prefetch_queue_length gauge
wikimedia_prefetch_queue_length 0
```

## Database preparation

Requires PostgreSQL with the PostGIS extension.

```bash
sudo su - postgres
createuser freemap
createdb -E UTF8 -O freemap freemap
psql -d freemap -c "CREATE EXTENSION postgis;"
exit
```

Create a `.env` file in the project root:

```env
DB_HOST=localhost
DB_PORT=5432
DB_USER=freemap
DB_PASSWORD=freemap
DB_NAME=freemap
PORT=4000
```

By default, the server requires the following HTTP header for endpoints (except `/status` and `/metrics`):

```http
X-Freemap-API-Key: your_secret_api_key_here
```

**Security (Hashed Keys):**
Create a file named `api_keys.txt` in the root directory (next to `package.json`). Add one **SHA-256 hash** per line. The server will hash incoming API keys from clients and compare them against this list.

To generate a hash for a new key in your terminal:
```bash
echo -n "my_super_secret_key" | sha256sum
```
If `api_keys.txt` is missing or empty, the server will reject all API requests with `401 Unauthorized`.

The table and spatial index are created automatically on first start.

## Cache storage (SQLite)

Thumbnails are BLOBs in 64 SQLite files, `thumbs-db/thumbs-00.db` … `thumbs-63.db` next to `cache/` (`THUMB_DB_DIR` overrides the directory), see `src/thumbStore.ts`. Shard = `pageId % 64`, table `thumb(id INTEGER PRIMARY KEY, data BLOB, updated INTEGER)`, key `pageId * 4096 + size`. WAL mode, `synchronous=NORMAL`, `auto_vacuum=INCREMENTAL`, so the server, `importDump.ts` and the migration can run at the same time. Each `-wal` file can grow to ~4–5 MB (SQLite reuses it, it does not shrink while the server runs); they disappear on a clean shutdown (SIGINT/SIGTERM).

Why: one file per ~5 KB thumbnail exhausts ext4 inodes (3.7 M files filled 97 % of the inodes on cloud01). `page_size` is 4096 (`THUMB_DB_PAGE_SIZE`, only used when a shard file is created): on a 30 000 thumbnail sample it needed 18 % over the raw JPEG bytes, 8192 needed 36 %, and the read time was the same (~15 µs).

Environment variables (also read from `.env`, by every script):

- `THUMB_DB_DIR` - directory of the shard files (default `thumbs-db/`).
- `THUMB_DB_PAGE_SIZE` - page size for new shard files (default 4096).
- `CACHE_DIR` - legacy file cache (default `cache/`), only read during the migration.

### Migrating the legacy file cache

The old layout was `cache/<shard>/<pageId>_<size>.jpg` with `<shard>` = `pageId % 1000`. Until the migration finishes the server reads SQLite first and falls back to the old file (copying a hit into SQLite); it never writes files any more.

```bash
npx tsx src/migrateToSqlite.ts --limit 10000      # trial, keeps the files
npx tsx src/migrateToSqlite.ts --delete-source    # copy, read back, compare, delete the file
```

A file is deleted only after its bytes were read back from SQLite and match. Re-running is safe (existing rows are kept). Ctrl+C finishes the current batch, prints the summary and stops; a second Ctrl+C exits at once. The summary must show `mismatch: 0` and `readErrors: 0`. `skippedName` counts files whose path does not round-trip through `getCachePath()` (junk such as `.DS_Store`, `*.part`, files directly in `cache/` from before sharding, a file in the wrong shard); they are listed (first 20) and never deleted. `skippedEmpty` counts 0-byte files, also kept.

Files sitting directly in `cache/` (unsharded leftovers) are skipped; move them into shards first with `npm run migrate-cache-shards` if there are any (`find cache -maxdepth 1 -type f | wc -l`).

### Backup

Copying a live `.db` file is not enough (WAL). Back up shard by shard, e.g.

```bash
mkdir -p /root/thumbs-backup
for f in thumbs-db/thumbs-*.db; do sqlite3 "$f" ".backup /root/thumbs-backup/$(basename "$f")"; done
```

or `VACUUM INTO '/path/thumbs-XX.db'` per shard, then copy the directory to the backup server.

## Running the server

```bash
npm install
npx tsx src/index.ts
```

## Importing data

Download and import the full Wikimedia Commons geo tags dump (run once, then monthly):

```bash
cd /opt/WikiMediaCache
NODE_OPTIONS="--max-old-space-size=4096" npx tsx src/importDump.ts
```

This streams `commonswiki-latest-geo_tags.sql.gz` (~700 MB) from `dumps.wikimedia.org`, filters primary Earth coordinates (currently only `type === 'camera'` is imported; other available types on Wikimedia include `object`, `landmark`, `church`, `city`, `mountain`, etc. — see the [Tools](#tools) section below to analyze the dump yourself), and upserts them into the database. A full import takes roughly 10–20 minutes depending on connection speed.

### Import Parameters and Features

This script includes several advanced mechanisms to ensure reliability:

- **`NODE_OPTIONS="--max-old-space-size=4096"`**: Required parameter. Processing and parsing the 700 MB SQL dump requires a significant amount of memory. This flag allows Node.js to use up to 4 GB of RAM (the default limit is 2 GB, which may cause the script to crash with an `Out of Memory` error).
- **Resume download**: If the download fails or is interrupted, the script creates a `/tmp/geo_tags.sql.gz.part` file. On the next run, it automatically resumes the download from the exact byte where it left off.
- **Checkpointing**: The database insertion saves its state (last processed record ID) to `/tmp/geo_tags_import.checkpoint` after each batch. If the script crashes or is terminated, it will resume from the exact position where it stopped.
- **Redownload**: The script does not download the dump again if the `/tmp/geo_tags.sql.gz` file already exists. To force a redownload of a fresh dump, you must manually delete it first:
  ```bash
  rm /tmp/geo_tags.sql.gz
  ```
- **Deduplication (ON CONFLICT protection)**: The SQL dump often contains duplicate photos sequentially. The script deduplicates batches before sending them to PostgreSQL, protecting the database from `ON CONFLICT` row update errors.
- **Automatic Cache Cleanup**: After the database import completes, the script lists all thumbnails (SQLite plus any legacy files not migrated yet) and cross-references them with the newly imported database records. Thumbnails whose `page_id` no longer exists in the updated Wikimedia dump (e.g., deleted images) are deleted, then `incremental_vacuum` returns the space to the filesystem. Two guards: nothing is deleted when the photo table is empty, and nothing is deleted when more than half of the cached pageIds would go (that points to a broken import, not to deleted photos).
- **Import Log**: Every run appends timestamped `INFO`/`WARN`/`ERROR` lines to `logs/import.log` (start/end markers, resume points, record counts, errors) - independent of whatever shell redirection you use to run it, so you always have a durable record of the last run's outcome. After each successful import it logs the total photo count and how many of those are within Slovakia (`BBOX_SVK`), and it also resets the [idle cache warmer](#idle-cache-warmer) back to the SVK stage since the fresh dump may include new Slovak photos.

## Updating data

Run monthly to stay in sync with the Wikimedia Commons dump schedule (dumps are published around the 1st of each month):

```crontab
0 3 2 * * cd /opt/WikiMediaCache && NODE_OPTIONS="--max-old-space-size=4096" npx tsx src/importDump.ts >> /var/log/wikimediacache-import.log 2>&1
```

## Tools

The `tools` directory contains utility Python scripts for analyzing and debugging the raw Wikimedia data dump:

- **`analyze.py`**: Reads the SQL dump stream and aggregates the top 100 `gt_type` and `gt_country` values. Useful for checking what kind of tags exist in the dump.
  ```bash
  python3 tools/analyze.py /tmp/geo_tags.sql.gz
  ```
- **`find.py`**: Fast search utility to find all raw SQL columns for a specific `gt_page_id` without loading the whole file into memory. Useful for debugging specific photos.
  ```bash
  python3 tools/find.py /tmp/geo_tags.sql.gz <pageId>
  ```
