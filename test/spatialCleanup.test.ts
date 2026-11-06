/**
 * WMC03: spatial cleanup must not treat "unknown position" as "outside".
 *
 *   npx tsx test/spatialCleanup.test.ts
 */
import { planSpatialCleanup, type PhotoQuery } from '../src/spatialCleanup.js';
import { check, finish } from './helpers.js';

const BBOX: [number, number, number, number] = [16.8, 47.7, 22.6, 49.6];

/** Fake wikimedia_photo: pageId -> [lon, lat] or null (no location). */
function fakeDb(photos: Map<number, [number, number] | null>, failOnBatch = false): PhotoQuery {
  return {
    async query(sql: string, params: unknown[] = []) {
      if (!/ANY\(\$1/.test(sql)) {
        // readiness probe (any row at all?)
        return { rows: photos.size ? [{ any: 1 }] : [] };
      }
      if (failOnBatch) throw new Error('connection reset');
      const [ids, minLon, minLat, maxLon, maxLat] = params as [number[], number, number, number, number];
      const rows: any[] = [];
      for (const id of ids) {
        if (!photos.has(id)) continue;
        const p = photos.get(id)!;
        const inside = p ? p[0] >= minLon && p[0] <= maxLon && p[1] >= minLat && p[1] <= maxLat : null;
        // Old query returned only the inside rows; the fixed one returns all known rows.
        if (/AS inside/.test(sql)) rows.push({ page_id: id, inside });
        else if (inside) rows.push({ page_id: id });
      }
      return { rows };
    },
  };
}

const cache = (ids: number[]) => new Map(ids.map((id) => [id, [120]]));
const deleted = (plan: { toDelete: { pageId: number }[] }) => plan.toDelete.map((r) => r.pageId).sort((a, b) => a - b);

console.log('empty photo table:');
{
  const plan = await planSpatialCleanup(cache([1, 2]), fakeDb(new Map()), BBOX, 'outside');
  check(plan.toDelete.length === 0, `nothing deleted (${deleted(plan)})`);
  check('refused' in plan && !!plan.refused, `refused (${plan.refused})`);
}

console.log('known inside / known outside / unknown / no location, mode=outside:');
{
  const photos = new Map<number, [number, number] | null>([
    [1, [17.1, 48.1]], // Bratislava, inside
    [2, [14.4, 50.1]], // Praha, outside
    [3, [19.0, 48.7]], // inside
    [4, null], // known page, no location
    // 5: not in the table at all
  ]);
  const plan = await planSpatialCleanup(cache([1, 2, 3, 4, 5]), fakeDb(photos), BBOX, 'outside');
  check(JSON.stringify(deleted(plan)) === '[2]', `only the known outside one (${deleted(plan)})`);
}

console.log('mode=inside:');
{
  const photos = new Map<number, [number, number] | null>([[1, [17.1, 48.1]], [2, [14.4, 50.1]], [3, [19.0, 48.7]]]);
  const plan = await planSpatialCleanup(cache([1, 2, 3, 5]), fakeDb(photos), BBOX, 'inside');
  check(JSON.stringify(deleted(plan)) === '[1,3]', `the two inside (${deleted(plan)})`);
}

console.log('more than half would go:');
{
  const photos = new Map<number, [number, number] | null>([[1, [17.1, 48.1]], [2, [14.4, 50.1]], [3, [14.5, 50.2]]]);
  const plan = await planSpatialCleanup(cache([1, 2, 3]), fakeDb(photos), BBOX, 'outside');
  check(plan.toDelete.length === 0 && !!plan.refused, `refused without force (${plan.refused})`);
  const forced = await planSpatialCleanup(cache([1, 2, 3]), fakeDb(photos), BBOX, 'outside', { force: true });
  check(JSON.stringify(deleted(forced)) === '[2,3]', `force=true deletes them (${deleted(forced)})`);
}

console.log('query error:');
{
  const photos = new Map<number, [number, number] | null>([[1, [17.1, 48.1]], [2, [14.4, 50.1]]]);
  const plan = await planSpatialCleanup(cache([1, 2]), fakeDb(photos, true), BBOX, 'outside');
  check(plan.toDelete.length === 0 && plan.failedBatches === 1, `failed batch deletes nothing (${deleted(plan)})`);
}

finish();
