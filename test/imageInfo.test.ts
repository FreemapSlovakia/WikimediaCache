/**
 * WMC04: a temporary API error must not be stored as a permanent
 * "deleted photo" cross, and a cross must never replace a valid thumbnail.
 *
 *   npx tsx test/imageInfo.test.ts
 */
import sharp from 'sharp';
import { check, finish, setupEnv } from './helpers.js';

setupEnv('imageinfo');
const { classifyImageInfo, isPlaceholder, makeCrossPlaceholder, storeMissingPlaceholder } = await import(
  '../src/imageInfo.js'
);
const store = await import('../src/thumbStore.js');

console.log('API responses:');
const cases: [string, any, string][] = [
  ['maxlag error', { error: { code: 'maxlag', info: 'Waiting for a database server' }, servedby: 'mw1' }, 'error'],
  ['ratelimited error', { error: { code: 'ratelimited' } }, 'error'],
  ['empty object', {}, 'error'],
  ['query without pages', { batchcomplete: '', query: {} }, 'error'],
  ['pages without our id', { batchcomplete: '', query: { pages: { '999': { pageid: 999 } } } }, 'error'],
  ['incomplete (continue)', { continue: { iicontinue: 'x' }, query: { pages: { '42': { pageid: 42, ns: 6 } } } }, 'error'],
  ['imageinfo without thumburl', { batchcomplete: '', query: { pages: { '42': { pageid: 42, ns: 6, imageinfo: [{}] } } } }, 'error'],
  ['explicitly missing page', { batchcomplete: '', query: { pages: { '42': { pageid: 42, missing: '' } } } }, 'missing'],
  ['file page without file', { batchcomplete: '', query: { pages: { '42': { pageid: 42, ns: 6, title: 'File:X.jpg', imagerepository: '' } } } }, 'missing'],
  ['success', { batchcomplete: '', query: { pages: { '42': { pageid: 42, ns: 6, imageinfo: [{ thumburl: 'https://upload.wikimedia.org/x.jpg' }] } } } }, 'ok'],
];
for (const [name, resp, expected] of cases) {
  const r = classifyImageInfo(resp, '42');
  check(r.kind === expected, `${name} -> ${expected} (${r.kind}${'reason' in r ? ': ' + r.reason : ''})`);
}

console.log('placeholder:');
{
  const cross = await makeCrossPlaceholder(120);
  check(isPlaceholder(cross), 'generated cross is recognised');
  const real = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#336699' } }).jpeg({ quality: 85 }).toBuffer();
  check(!isPlaceholder(real), 'real thumbnail is not a placeholder');

  // A valid thumbnail stored while the API call was pending must survive.
  store.putThumb(42, 120, real);
  const wrote = await storeMissingPlaceholder('42', 120);
  check(!wrote, 'storeMissingPlaceholder reports it did not write');
  check(store.getThumb(42, 120)?.equals(real), 'valid thumbnail not replaced by a cross');

  check(await storeMissingPlaceholder('43', 120), 'missing photo gets a cross');
  check(isPlaceholder(store.getThumb(43, 120)!), 'stored cross is recognised');
}

store.closeThumbStore();
finish();
