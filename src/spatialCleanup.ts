/**
 * Plan for /cleanup-cache?bbox=...&mode=inside|outside: which cached
 * thumbnails to delete. Separate from index.ts so it can be tested without
 * the HTTP server or PostgreSQL.
 *
 * Every cached pageId falls into one of three groups:
 *   inside / outside - the photo table knows its location;
 *   unknown          - not in the table, or without a location.
 * Unknown ones are always kept: missing from the geotag table is no proof that
 * a thumbnail lies outside the bbox (an empty or half-imported table would
 * otherwise send the whole cache to deletion).
 *
 * Guards, the same spirit as the cleanup after an import (importDump.ts):
 *   - an empty photo table refuses the whole cleanup;
 *   - more than half of the cached pageIds to delete is refused unless
 *     force is set (a real "keep only Slovakia" run on an EU-wide cache needs
 *     it, a broken table does not get it by accident);
 *   - a batch whose query failed deletes nothing.
 */
import type { ThumbRef } from './thumbStore.js';

export interface PhotoQuery {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export type Bbox = [number, number, number, number];

export interface SpatialPlan {
  toDelete: ThumbRef[];
  cachedPages: number;
  inside: number;
  outside: number;
  unknown: number;
  deletePages: number;
  failedBatches: number;
  /** Set when nothing may be deleted; toDelete is then empty. */
  refused?: string;
}

export const MAX_DELETE_FRACTION = 0.5;

export async function planSpatialCleanup(
  byPage: Map<number, number[]>,
  db: PhotoQuery,
  bbox: Bbox,
  mode: 'inside' | 'outside',
  opts: { force?: boolean } = {},
): Promise<SpatialPlan> {
  const pageIds = Array.from(byPage.keys());
  const plan: SpatialPlan = {
    toDelete: [],
    cachedPages: pageIds.length,
    inside: 0,
    outside: 0,
    unknown: 0,
    deletePages: 0,
    failedBatches: 0,
  };

  const probe = await db.query('SELECT 1 AS any FROM wikimedia_photo LIMIT 1');
  if (probe.rows.length === 0) {
    plan.refused = 'photo table is empty, every thumbnail would look unknown';
    return plan;
  }

  const BATCH = 5000;
  for (let i = 0; i < pageIds.length; i += BATCH) {
    const batchIds = pageIds.slice(i, i + BATCH);
    let res: { rows: any[] };
    try {
      // inside is NULL for a row without location -> unknown.
      res = await db.query(
        `SELECT page_id, location && ST_MakeEnvelope($2, $3, $4, $5, 4326) AS inside
         FROM wikimedia_photo
         WHERE page_id = ANY($1::int[])`,
        [batchIds, ...bbox],
      );
    } catch {
      plan.failedBatches++;
      continue;
    }
    const known = new Map<number, boolean>();
    for (const r of res.rows) {
      if (r.inside === true || r.inside === false) known.set(Number(r.page_id), r.inside);
    }
    for (const id of batchIds) {
      const isInside = known.get(id);
      if (isInside === undefined) {
        plan.unknown++;
        continue;
      }
      if (isInside) plan.inside++;
      else plan.outside++;
      if (isInside === (mode === 'inside')) {
        plan.deletePages++;
        for (const size of byPage.get(id)!) plan.toDelete.push({ pageId: id, size });
      }
    }
  }

  const limit = Math.floor(plan.cachedPages * MAX_DELETE_FRACTION);
  if (plan.deletePages > limit && !opts.force) {
    plan.refused =
      `${plan.deletePages} of ${plan.cachedPages} cached pageIds would be deleted, more than ` +
      `${MAX_DELETE_FRACTION * 100} %; check with dry=true and repeat with force=true if intended`;
    plan.toDelete = [];
  }
  return plan;
}

export function describePlan(p: SpatialPlan): string {
  return (
    `cached ${p.cachedPages} pageIds: inside ${p.inside}, outside ${p.outside}, unknown ${p.unknown} (kept), ` +
    `to delete ${p.deletePages} pageIds / ${p.toDelete.length} thumbnails` +
    (p.failedBatches ? `, ${p.failedBatches} batches skipped on error` : '')
  );
}
