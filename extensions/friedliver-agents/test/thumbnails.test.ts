import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_IMAGE_FILE_BYTES, MAX_PREVIEW_BYTES, THUMB_PX, imageThumb, thumbKey, workerScaler } from '../src/host/imageAccess';
import { MAX_PIXELS, downscalePng, encodeRgba, pngSize } from '../src/host/png';

/** Filters a row the way an encoder would, so the decoder's unfiltering is exercised for every type. */
function filterRow(type: number, row: Buffer, prev: Buffer, bpp: number): Buffer {
  const out = Buffer.alloc(row.length);
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    const p = a + b - c;
    const pred = [0, a, b, (a + b) >> 1, Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c][type];
    out[i] = (row[i] - pred) & 255;
  }
  return out;
}

function crcChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** A PNG of any color type and depth from raw (unfiltered) rows, cycling filter types 0–4 row by row. */
function png(w: number, h: number, color: number, depth: number, rows: Buffer[], extra: Buffer[] = []): Buffer {
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color]!;
  const bpp = Math.max(1, (ch * depth) >> 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = depth;
  ihdr[9] = color;
  let prev: Buffer = Buffer.alloc(rows[0].length);
  const parts: Buffer[] = [];
  rows.forEach((row, y) => {
    const type = y % 5;
    parts.push(Buffer.from([type]), filterRow(type, row, prev, bpp));
    prev = row;
  });
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crcChunk('IHDR', ihdr), ...extra, crcChunk('IDAT', deflateSync(Buffer.concat(parts))), crcChunk('IEND', Buffer.alloc(0))]);
}

/** Decodes the RGBA PNG the encoder writes (filter 0 only), for checking pixels. */
function pixels(bytes: Buffer): { w: number; h: number; at(x: number, y: number): number[] } {
  const { width: w, height: h } = pngSize(bytes)!;
  // Signature 8, IHDR chunk 25, IDAT length and type 8; then IDAT's CRC 4 and IEND 12.
  const raw = inflateSync(bytes.subarray(41, bytes.length - 16));
  return { w, h, at: (x, y) => [...raw.subarray(y * (w * 4 + 1) + 1 + x * 4, y * (w * 4 + 1) + 1 + x * 4 + 4)] };
}

/** Four quadrants: red, green, blue, white. */
const QUAD = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];
const quadrant = (x: number, y: number, w: number, h: number) => QUAD[(y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1)];

describe('PNG thumbnails', () => {
  it('scales an RGB PNG to fit 320, every filter type undone', () => {
    const w = 640, h = 400;
    const rows = Array.from({ length: h }, (_, y) => Buffer.from(Array.from({ length: w }, (_, x) => quadrant(x, y, w, h)).flat()));
    const small = downscalePng(png(w, h, 2, 8, rows), THUMB_PX)!;
    const out = pixels(small);
    expect([out.w, out.h]).toEqual([320, 200]);
    expect(out.at(10, 10)).toEqual([255, 0, 0, 255]);
    expect(out.at(300, 10)).toEqual([0, 255, 0, 255]);
    expect(out.at(10, 190)).toEqual([0, 0, 255, 255]);
    expect(out.at(300, 190)).toEqual([255, 255, 255, 255]);
  });

  it('reads RGBA, 16-bit, grayscale, 1-bit and palette images', () => {
    const w = 400, h = 400;
    const rgba = Array.from({ length: h }, (_, y) => Buffer.from(Array.from({ length: w }, (_, x) => [...quadrant(x, y, w, h), x < w / 2 ? 255 : 0]).flat()));
    const a = pixels(downscalePng(png(w, h, 6, 8, rgba), THUMB_PX)!);
    expect(a.at(5, 5)).toEqual([255, 0, 0, 255]);
    expect(a.at(300, 5)[3]).toBe(0);

    const rgb16 = Array.from({ length: h }, (_, y) => Buffer.from(Array.from({ length: w }, (_, x) => quadrant(x, y, w, h).flatMap((v) => [v, 0x7f])).flat()));
    expect(pixels(downscalePng(png(w, h, 2, 16, rgb16), THUMB_PX)!).at(5, 300)).toEqual([0, 0, 255, 255]);

    const gray = Array.from({ length: h }, () => Buffer.from(Array.from({ length: w }, (_, x) => (x < w / 2 ? 0 : 200))));
    expect(pixels(downscalePng(png(w, h, 0, 8, gray), THUMB_PX)!).at(300, 5)).toEqual([200, 200, 200, 255]);

    // 1-bit: left half black, right half white (8 pixels per byte).
    const bits = Array.from({ length: h }, () => Buffer.from(Array.from({ length: w / 8 }, (_, i) => (i < w / 16 ? 0x00 : 0xff))));
    const b = pixels(downscalePng(png(w, h, 0, 1, bits), THUMB_PX)!);
    expect([b.at(5, 5), b.at(300, 5)]).toEqual([[0, 0, 0, 255], [255, 255, 255, 255]]);

    // 4-bit palette with a transparent entry.
    const plte = crcChunk('PLTE', Buffer.from([10, 20, 30, 200, 100, 50]));
    const trns = crcChunk('tRNS', Buffer.from([0]));
    const pal = Array.from({ length: h }, () => Buffer.from(Array.from({ length: w / 2 }, (_, i) => (i < w / 4 ? 0x00 : 0x11))));
    const c = pixels(downscalePng(png(w, h, 3, 4, pal, [plte, trns]), THUMB_PX)!);
    expect(c.at(5, 5)[3]).toBe(0);
    expect(c.at(300, 5)).toEqual([200, 100, 50, 255]);
  });

  it('leaves alone what fits, is interlaced, damaged, or too many pixels', () => {
    const tiny = encodeRgba(2, 2, Buffer.alloc(2 * 9));
    expect(downscalePng(tiny, THUMB_PX)).toBeNull();
    expect(downscalePng(Buffer.from('not a png at all, really not'), THUMB_PX)).toBeNull();
    const big = png(400, 1, 2, 8, [Buffer.alloc(1200)]);
    const interlaced = Buffer.from(big);
    interlaced[28] = 1;
    expect(downscalePng(interlaced, THUMB_PX)).toBeNull();
    const huge = Buffer.from(big);
    huge.writeUInt32BE(MAX_PIXELS, 16);
    huge.writeUInt32BE(2, 20);
    expect(downscalePng(huge, THUMB_PX)).toBeNull();
    // A header that promises more rows than the data has.
    const short = Buffer.from(big);
    short.writeUInt32BE(400, 20);
    expect(downscalePng(short, THUMB_PX)).toBeNull();
  });

  it('a real screenshot', () => {
    const shot = fs.readFileSync(path.join(__dirname, '../screenshots/08-images.png'));
    const small = downscalePng(shot, THUMB_PX)!;
    const size = pngSize(small)!;
    expect(Math.max(size.width, size.height)).toBe(THUMB_PX);
    expect(small.length).toBeLessThan(shot.length);
  });
});

describe('the thumbnail cache', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-thumb-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-thumb-out-'));
  const cache = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fl-cache-')), 'thumbs');
  afterAll(() => {
    for (const d of [dir, outside, path.dirname(cache)]) fs.rmSync(d, { recursive: true, force: true });
  });
  const solid = (w: number, h: number, rgb: number[]) => png(w, h, 2, 8, Array.from({ length: h }, () => Buffer.from(Array.from({ length: w }, () => rgb).flat())));
  const centre = (uri: string) => {
    const p = pixels(Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64'));
    return p.at(p.w >> 1, p.h >> 1);
  };

  it('makes a 320px thumbnail once, in a 0700 folder, and reuses it', async () => {
    const f = path.join(dir, 'shot.png');
    fs.writeFileSync(f, solid(800, 600, [9, 99, 199]));
    const first = (await imageThumb(f, [dir], cache))!;
    expect(first).toMatch(/^data:image\/png;base64,/);
    expect(pngSize(Buffer.from(first.split(',')[1], 'base64'))).toEqual({ width: 320, height: 240 });
    expect(fs.statSync(cache).mode & 0o777).toBe(0o700);
    const files = fs.readdirSync(cache);
    expect(files).toHaveLength(1);
    expect(fs.statSync(path.join(cache, files[0])).mode & 0o777).toBe(0o600);
    // A hit reads the cache: change the cached file and the change shows.
    const stand = Buffer.concat(Array.from({ length: 4 }, () => Buffer.from([0, ...Array.from({ length: 4 }, () => [1, 2, 3, 255]).flat()])));
    fs.writeFileSync(path.join(cache, files[0]), encodeRgba(4, 4, stand));
    expect(centre((await imageThumb(f, [dir], cache))!)).toEqual([1, 2, 3, 255]);
  });

  it('an edited image (new mtime or size) gets a new thumbnail', async () => {
    const f = path.join(dir, 'edit.png');
    fs.writeFileSync(f, solid(800, 600, [10, 10, 10]));
    fs.utimesSync(f, new Date(1000), new Date(1000));
    expect(centre((await imageThumb(f, [dir], cache))!)).toEqual([10, 10, 10, 255]);
    fs.writeFileSync(f, solid(800, 600, [200, 10, 10]));
    fs.utimesSync(f, new Date(2000), new Date(2000));
    expect(centre((await imageThumb(f, [dir], cache))!)).toEqual([200, 10, 10, 255]);
    expect(thumbKey(f, 1000, 5)).not.toBe(thumbKey(f, 2000, 5));
    expect(thumbKey(f, 1000, 5)).not.toBe(thumbKey(f, 1000, 6));
    expect(thumbKey(f, 1000, 5)).not.toBe(thumbKey(`${f}x`, 1000, 5));
  });

  it('a symlink in the cache is not followed', async () => {
    const f = path.join(dir, 'linked.png');
    fs.writeFileSync(f, solid(800, 600, [50, 60, 70]));
    const st = fs.statSync(f);
    const target = path.join(outside, 'decoy.png');
    fs.writeFileSync(target, solid(4, 4, [1, 1, 1]));
    fs.mkdirSync(cache, { recursive: true });
    fs.symlinkSync(target, path.join(cache, `${thumbKey(f, st.mtimeMs, st.size)}.png`));
    expect(centre((await imageThumb(f, [dir], cache))!)).toEqual([50, 60, 70, 255]);
  });

  it('a small PNG comes as it is; the same checks as a preview refuse the rest', async () => {
    const small = path.join(dir, 'small.png');
    fs.writeFileSync(small, solid(100, 50, [1, 2, 3]));
    expect(await imageThumb(small, [dir], cache)).toBe(`data:image/png;base64,${fs.readFileSync(small).toString('base64')}`);
    const secret = path.join(outside, 'secret.png');
    fs.writeFileSync(secret, solid(800, 600, [0, 0, 0]));
    expect(await imageThumb(secret, [dir], cache)).toBeNull();
    fs.symlinkSync(secret, path.join(dir, 'escape.png'));
    expect(await imageThumb(path.join(dir, 'escape.png'), [dir], cache)).toBeNull();
    fs.writeFileSync(path.join(dir, 'fake.png'), '<svg onload=alert(1)>');
    expect(await imageThumb(path.join(dir, 'fake.png'), [dir], cache)).toBeNull();
    fs.writeFileSync(path.join(dir, 'pic.svg'), '<svg/>');
    expect(await imageThumb(path.join(dir, 'pic.svg'), [dir], cache)).toBeNull();
  });

  it('a big PNG is scaled down, past the preview cap but not past the read cap', async () => {
    const f = path.join(dir, 'big.png');
    const bytes = solid(800, 600, [5, 6, 7]);
    // Padding after IEND makes the file bigger without changing the picture.
    fs.writeFileSync(f, Buffer.concat([bytes, Buffer.alloc(MAX_PREVIEW_BYTES)]));
    expect(centre((await imageThumb(f, [dir], cache))!)).toEqual([5, 6, 7, 255]);
    fs.truncateSync(f, MAX_IMAGE_FILE_BYTES + 1);
    expect(await imageThumb(f, [dir], cache)).toBeNull();
  });

  it('a JPEG over the preview cap shows its name only', async () => {
    const f = path.join(dir, 'photo.jpg');
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]));
    expect(await imageThumb(f, [dir], cache)).toMatch(/^data:image\/jpeg;base64,/);
    fs.truncateSync(f, MAX_PREVIEW_BYTES + 1);
    expect(await imageThumb(f, [dir], cache)).toBeNull();
  });
});

describe('scaling off the extension host thread', () => {
  it('the worker scales like the code it runs, and survives a bad image', async () => {
    const { build } = await import('esbuild');
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fl-worker-')), 'thumbWorker.js');
    await build({ entryPoints: [path.join(__dirname, '../src/host/thumbWorker.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' });
    const scale = workerScaler(out);
    try {
      const w = 640, h = 400;
      const rows = Array.from({ length: h }, (_, y) => Buffer.from(Array.from({ length: w }, (_, x) => quadrant(x, y, w, h)).flat()));
      const source = png(w, h, 2, 8, rows);
      const [a, b] = await Promise.all([scale(source, THUMB_PX), scale(Buffer.from('nonsense'), THUMB_PX)]);
      expect(a!.equals(downscalePng(source, THUMB_PX)!)).toBe(true);
      expect(b).toBeNull();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-wthumb-'));
      fs.writeFileSync(path.join(dir, 'a.png'), source);
      expect(pngSize(Buffer.from((await imageThumb(path.join(dir, 'a.png'), [dir], path.join(dir, '.cache'), scale))!.split(',')[1], 'base64'))).toEqual({ width: 320, height: 200 });
    } finally {
      scale.dispose();
      fs.rmSync(path.dirname(out), { recursive: true, force: true });
    }
  });
});
