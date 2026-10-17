import { open } from 'node:fs/promises';
import { insideRoots } from './paths';

/** Files bigger than this are not read at all. */
export const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;
/** What a preview may carry into the webview; larger images show their name only. */
// ponytail: no downscaling (no image library in the extension); add one if 5 MB screenshots turn up.
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

/** Raster types by their first bytes. SVG is not here: it shows as its name only. */
const MAGIC: [string, (b: Buffer) => boolean][] = [
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', (b) => b.subarray(0, 4).toString('latin1') === 'GIF8'],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];
const RASTER_EXT = /\.(png|jpe?g|gif|webp)$/i;

/**
 * A data: URI of the image at `file` when the webview may show it: a PNG, JPEG,
 * GIF or WebP (by extension and by its bytes) of at most MAX_PREVIEW_BYTES,
 * inside one of `roots` also after symlinks. Otherwise null, and the webview
 * shows the name. The webview never gets a file URI, so nothing else under
 * those roots is reachable from it.
 */
export async function imagePreview(file: string, roots: readonly string[]): Promise<string | null> {
  if (!RASTER_EXT.test(file)) return null;
  const inside = insideRoots(file, roots);
  if (!inside) return null;
  const handle = await open(inside, 'r').catch(() => null);
  if (!handle) return null;
  try {
    // The open file is what gets checked and read, so a swap after the check can't change it.
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_IMAGE_FILE_BYTES || info.size > MAX_PREVIEW_BYTES) return null;
    const bytes = await handle.readFile();
    const type = MAGIC.find(([, is]) => is(bytes))?.[0];
    return type ? `data:${type};base64,${bytes.toString('base64')}` : null;
  } finally {
    await handle.close();
  }
}
