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

Returns up to 5000 results. Full original metadata (author, license, description) is still fetched directly from the Wikimedia API on demand in the mobile app.

### 2. Fetching thumbnail (Cached Thumbnail)

```http
GET /wikimedia/thumbnail/<pageId>?size=<pixels>
```

Example: `/wikimedia/thumbnail/12345678?size=120` (size is optional, defaults to 120). The backend automatically snaps the requested size to standard Wikimedia thumbnail sizes (120, 250, 500...) to maximize cache hit rate.

**Endpoint behavior and caching details:**
- **In-RAM Index**: Upon startup, the service loads all existing filenames from the `/cache` directory into memory (`Set<string>`). This allows it to check if a file is already downloaded in `O(1)` time without any CPU-blocking `fs.existsSync` disk calls, dramatically improving performance during mass coordinate requests.
- **Cache Hit**: If the thumbnail exists, it immediately returns the image (MIME type: `image/jpeg`).
- **Cache Miss (Queued)**: If the thumbnail is not downloaded yet, the backend adds it to an asynchronous download queue and returns **HTTP 503 Service Unavailable** with a `Retry-After: 15` header. The app shouldn't block, but rather silently retry fetching it later.
- **Dead/Deleted files**: If the upstream Wikimedia API reports that the file no longer exists (e.g., `No imageinfo`), the server dynamically generates a small placeholder JPEG (a red cross on a gray background) and saves it permanently to the cache under the same pageId. Subsequent requests for this deleted file will return `200 OK` with the placeholder, thus preventing infinite retry loops from the mobile app.
- **Queue Cleanup**: The background queue tracks the activity of each `clientId`. If a client disconnects or stops panning for more than 120 seconds, any pending downloads associated with their `clientId` are silently dropped to save bandwidth.

### 3. Server Status

```http
GET /status
```

Returns the current status of the service, uptime, and the number of images currently waiting in the background download queue. It also provides cache statistics.

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
- **Automatic Cache Cleanup**: After the database import completes, the script scans the `/cache` directory. It cross-references all downloaded thumbnails with the newly imported database records. Any thumbnail whose `page_id` no longer exists in the updated Wikimedia dump (e.g., deleted images) is automatically unlinked and permanently deleted from the disk to free up space.

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
