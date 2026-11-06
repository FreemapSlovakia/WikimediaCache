/**
 * Wikimedia API answer for prop=imageinfo, and the "missing photo" cross.
 *
 * Only an explicit answer that the file does not exist may produce the cross.
 * Anything else (API error such as maxlag or ratelimited, an incomplete or
 * unexpected answer) is a temporary error: nothing is stored and the
 * thumbnail is fetched again on the next request. HTTP errors, timeouts and
 * 429 never reach this module, got throws them before.
 */
import sharp from 'sharp';
import { putThumbIfMissing } from './thumbStore.js';

export type ImageInfoResult =
  | { kind: 'ok'; thumbUrl: string }
  | { kind: 'missing'; reason: string }
  | { kind: 'error'; reason: string };

export function classifyImageInfo(apiResponse: any, pageId: string): ImageInfoResult {
  if (!apiResponse || typeof apiResponse !== 'object') return { kind: 'error', reason: 'not a JSON object' };
  if (apiResponse.error) {
    return { kind: 'error', reason: `API error ${apiResponse.error.code ?? '?'}: ${apiResponse.error.info ?? ''}`.trim() };
  }
  const pages = apiResponse.query?.pages;
  if (!pages || typeof pages !== 'object') return { kind: 'error', reason: 'no query.pages' };
  const page = pages[pageId];
  if (!page || typeof page !== 'object') return { kind: 'error', reason: `pageId ${pageId} not in the answer` };
  if ('missing' in page) return { kind: 'missing', reason: 'page missing (deleted)' };
  if ('invalid' in page) return { kind: 'missing', reason: 'invalid pageId' };

  const info = Array.isArray(page.imageinfo) ? page.imageinfo[0] : undefined;
  if (info) {
    return typeof info.thumburl === 'string' && info.thumburl
      ? { kind: 'ok', thumbUrl: info.thumburl }
      : { kind: 'error', reason: 'imageinfo without thumburl' };
  }
  if (apiResponse.continue) return { kind: 'error', reason: 'incomplete answer (continue)' };
  // A file description page whose file is gone has imagerepository "".
  if (page.imagerepository === '') return { kind: 'missing', reason: 'file page without a file' };
  if (typeof page.ns === 'number' && page.ns !== 6) return { kind: 'missing', reason: `not a file page (ns ${page.ns})` };
  return { kind: 'error', reason: 'page without imageinfo' };
}

/**
 * The cross carries this text in its EXIF, so it can be told apart from a
 * real thumbnail (those are re-encoded by sharp without metadata).
 */
const PLACEHOLDER_MARKER = Buffer.from('wmc:placeholder:missing');

/** Browsers keep a cross for a day, not a year like a real thumbnail. */
export const PLACEHOLDER_MAX_AGE_S = 24 * 3600;
/** After a week a cross is dropped and the photo asked for again. */
export const PLACEHOLDER_TTL_S = 7 * 24 * 3600;

export async function makeCrossPlaceholder(size: number): Promise<Buffer> {
  const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#f8f9fa"/>
      <line x1="20%" y1="20%" x2="80%" y2="80%" stroke="#dc3545" stroke-width="4"/>
      <line x1="80%" y1="20%" x2="20%" y2="80%" stroke="#dc3545" stroke-width="4"/>
    </svg>
  `;
  return sharp(Buffer.from(svg))
    .jpeg()
    .withExif({ IFD0: { ImageDescription: PLACEHOLDER_MARKER.toString() } })
    .toBuffer();
}

/** The marker sits in the EXIF segment right after the JPEG header. */
export function isPlaceholder(data: Buffer): boolean {
  return data.subarray(0, 1024).includes(PLACEHOLDER_MARKER);
}

export function placeholderExpired(updatedSeconds: number, nowSeconds = Date.now() / 1000): boolean {
  return nowSeconds - updatedSeconds > PLACEHOLDER_TTL_S;
}

/**
 * Stores the cross unless a row already exists: a valid thumbnail written
 * while the API call was pending is never replaced. Returns true when stored.
 */
export async function storeMissingPlaceholder(pageId: string, size: number): Promise<boolean> {
  return putThumbIfMissing(pageId, size, await makeCrossPlaceholder(size));
}
