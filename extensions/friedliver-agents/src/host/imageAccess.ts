import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, utimes, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { insideRoots } from './paths';
import { downscalePng, pngSize } from './png';

/** Files bigger than this are not read at all. */
export const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;
/** What a preview may carry into the webview; larger images show their name only (or their thumbnail). */
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
/** A thumbnail's longest side. */
export const THUMB_PX = 320;
/** The thumbnail cache's size; past it the least recently used go. */
export const THUMB_CACHE_BYTES = 200 * 1024 * 1024;

/** Raster types by their first bytes. SVG is not here: it shows as its name only. */
const MAGIC: [string, (b: Buffer) => boolean][] = [
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', (b) => b.subarray(0, 4).toString('latin1') === 'GIF8'],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];
const RASTER_EXT = /\.(png|jpe?g|gif|webp)$/i;

export interface Vetted {
  file: string;
  bytes: Buffer;
  type: string;
  mtimeMs: number;
}

const typeOf = (bytes: Buffer) => MAGIC.find(([, is]) => is(bytes))?.[0];

/**
 * Opens the image at `file` when the webview may show it: a PNG, JPEG, GIF or
 * WebP by extension, inside one of `roots` also after symlinks, a regular file
 * of at most `maxBytes`. `use` gets the open file, which is what was checked,
 * so a swap after the check can't change what is read. The webview never gets
 * a file URI, so nothing else under those roots is reachable from it.
 */
async function withVetted<T>(file: string, roots: readonly string[], maxBytes: number, use: (handle: FileHandle, inside: string, info: { size: number; mtimeMs: number }) => Promise<T | null>): Promise<T | null> {
  if (!RASTER_EXT.test(file)) return null;
  const inside = insideRoots(file, roots);
  if (!inside) return null;
  const handle = await open(inside, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_IMAGE_FILE_BYTES || info.size > maxBytes) return null;
    return await use(handle, inside, info);
  } finally {
    await handle.close();
  }
}

/** The vetted file's bytes, when they are an image of a kind the webview shows (by its first bytes, not its name). */
export function readVetted(file: string, roots: readonly string[], maxBytes: number): Promise<Vetted | null> {
  return withVetted(file, roots, maxBytes, async (handle, inside, info) => {
    const bytes = await handle.readFile();
    const type = typeOf(bytes);
    return type ? { file: inside, bytes, type, mtimeMs: info.mtimeMs } : null;
  });
}

export const dataUri = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString('base64')}`;

/** A data: URI of the whole image (see readVetted), or null. */
export async function imagePreview(file: string, roots: readonly string[]): Promise<string | null> {
  const v = await readVetted(file, roots, MAX_PREVIEW_BYTES);
  return v && dataUri(v.type, v.bytes);
}

/** A thumbnail's cache name: from the file's path, modified time and size, so an edited image gets a new one. */
export function thumbKey(file: string, mtimeMs: number, size: number): string {
  return createHash('sha256').update(`${file}\0${mtimeMs}\0${size}`).digest('hex').slice(0, 40);
}

let writes = 0;
/** The cache is looked over on the first thumbnail written and then every this many. */
const PRUNE_EVERY = 50;

/** Removes the least recently used thumbnails (by modified time, which a hit renews) until the cache is under `cap` bytes. */
export async function pruneThumbs(cacheDir: string, cap: number): Promise<void> {
  const names = (await readdir(cacheDir).catch(() => [] as string[])).filter((n) => n.endsWith('.png'));
  const files = (
    await Promise.all(
      names.map(async (n) => {
        const st = await lstat(path.join(cacheDir, n)).catch(() => null);
        return st?.isFile() ? { file: path.join(cacheDir, n), size: st.size, used: st.mtimeMs } : null;
      }),
    )
  ).flatMap((f) => (f ? [f] : []));
  let total = files.reduce((n, f) => n + f.size, 0);
  for (const f of files.sort((a, b) => a.used - b.used)) {
    if (total <= cap) break;
    await rm(f.file, { force: true }).catch(() => {});
    total -= f.size;
  }
}

/** Scales a PNG to fit max × max, or null (see downscalePng); off the extension host's thread in the app (thumbWorker.ts). */
export type Scaler = (png: Buffer, max: number) => Promise<Buffer | null>;
export const scaleHere: Scaler = async (png, max) => downscalePng(png, max);

/**
 * A data: URI of the image at most THUMB_PX on its longest side, for the gallery.
 * Same checks as a preview, but files up to MAX_IMAGE_FILE_BYTES: a bigger PNG is
 * scaled down and cached in `cacheDir` (made 0700); a PNG that fits, or another
 * format up to MAX_PREVIEW_BYTES, comes as it is.
 */
// ponytail: only PNG is scaled (no image library here); a JPEG/GIF/WebP over 5 MB shows its name. Add a decoder if they turn up.
export function imageThumb(file: string, roots: readonly string[], cacheDir: string, scale: Scaler = scaleHere): Promise<string | null> {
  return withVetted(file, roots, MAX_IMAGE_FILE_BYTES, async (handle, inside, info) => {
    // A cached thumbnail needs only the file's first bytes read, to know it is still a PNG.
    const head = Buffer.alloc(24);
    await handle.read(head, 0, 24, 0);
    const cached = path.join(cacheDir, `${thumbKey(inside, info.mtimeMs, info.size)}.png`);
    if (pngSize(head)) {
      const hit = await lstat(cached).catch(() => null);
      const bytes = hit?.isFile() ? await readFile(cached).catch(() => null) : null;
      if (bytes && pngSize(bytes)) {
        // Its modified time is its last use, for pruning.
        const now = new Date();
        await utimes(cached, now, now).catch(() => {});
        return dataUri('image/png', bytes);
      }
    }
    // A read at a given position doesn't move the file's own, so this is the whole file.
    const bytes = await handle.readFile();
    const type = typeOf(bytes);
    if (!type) return null;
    const asIs = bytes.length <= MAX_PREVIEW_BYTES ? dataUri(type, bytes) : null;
    const size = pngSize(bytes);
    if (type !== 'image/png' || !size || (size.width <= THUMB_PX && size.height <= THUMB_PX)) return asIs;
    // A PNG that can't be scaled here (damaged, cut short, too big, too slow) shows its name only:
    // the whole file is never handed on in its place.
    const small = await scale(bytes, THUMB_PX).catch(() => null);
    if (!small || !pngSize(small)) return null;
    try {
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      await chmod(cacheDir, 0o700);
      // Written aside and renamed, so a reader never sees half a file.
      const tmp = `${cached}.${process.pid}.tmp`;
      await writeFile(tmp, small, { mode: 0o600 });
      await rename(tmp, cached);
      if (writes++ % PRUNE_EVERY === 0) await pruneThumbs(cacheDir, THUMB_CACHE_BYTES);
    } catch {
      // No cache this time; the thumbnail still shows.
    }
    return dataUri('image/png', small);
  });
}

/**
 * A Scaler that runs in a worker thread (`script` is the built thumbWorker.js), one
 * image at a time: an 11-megapixel screenshot takes about 0.4 s to scale. The worker
 * has a heap cap and each image a time limit; a worker that fails, exits, runs out
 * of memory or time answers null for what it had, and the next call starts another.
 */
export function workerScaler(script: string, { timeoutMs = 2000, maxOldMb = 128, maxYoungMb = 32 } = {}): Scaler & { dispose(): void } {
  let worker: Worker | undefined;
  let next = 0;
  const waiting = new Map<number, (out: Buffer | null) => void>();
  const drop = () => {
    worker = undefined;
    for (const done of waiting.values()) done(null);
    waiting.clear();
  };
  const scaler = (png: Buffer, max: number) =>
    new Promise<Buffer | null>((resolve) => {
      if (!worker) {
        // A crafted image can't take more than this memory, or time (below), from the extension host.
        const w = new Worker(script, { resourceLimits: { maxOldGenerationSizeMb: maxOldMb, maxYoungGenerationSizeMb: maxYoungMb } });
        w.unref();
        w.on('message', (m: { id: number; out: Uint8Array | null }) => {
          const done = waiting.get(m.id);
          waiting.delete(m.id);
          done?.(m.out ? Buffer.from(m.out.buffer, m.out.byteOffset, m.out.byteLength) : null);
        });
        w.on('error', () => worker === w && drop());
        w.on('exit', () => worker === w && drop());
        worker = w;
      }
      const id = next++;
      const w = worker;
      // Too slow: the worker is stopped (everything it had answers null) and the next call starts another.
      const timer = setTimeout(() => {
        if (worker === w) drop();
        void w.terminate();
      }, timeoutMs);
      waiting.set(id, (out) => {
        clearTimeout(timer);
        resolve(out);
      });
      w.postMessage({ id, png, max });
    });
  return Object.assign(scaler, {
    dispose: () => {
      const w = worker;
      drop();
      void w?.terminate();
    },
  });
}
