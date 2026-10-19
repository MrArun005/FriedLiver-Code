// A PNG made smaller, with nothing but zlib: the gallery's thumbnails. Agents
// read and make PNGs above all, so PNG is the one format scaled here; the
// others show as they are (see imageAccess.ts).
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Bigger than this (8K × 8K) is not decoded: its pixels alone would be a quarter of a gigabyte. */
export const MAX_PIXELS = 64 * 1024 * 1024;
/** Nor a side longer than this, whatever the other side. */
export const MAX_SIDE = 16384;
/** Nor rows that inflate to more than this (16-bit RGBA is 8 bytes a pixel): checked before inflating. */
export const MAX_DECODED = 64 * 1024 * 1024;

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export interface PngSize {
  width: number;
  height: number;
}

/** Width and height from the header, or null when it isn't a PNG. */
export function pngSize(bytes: Buffer): PngSize | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(SIGNATURE) || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The bit depths each colour type has (PNG spec, table 11.1). */
const DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

export interface PngLimits extends PngSize {
  depth: number;
  color: number;
  /** Bytes of one row, without its filter byte. */
  stride: number;
  /** Bytes the image data inflates to: (stride + 1) × height. */
  decoded: number;
}

/**
 * The header's numbers when this decoder takes the image: a colour type and
 * bit depth PNG has, not interlaced, each side at most MAX_SIDE, at most
 * MAX_PIXELS pixels and MAX_DECODED inflated bytes. Otherwise null: nothing
 * past the header is read.
 */
export function pngLimits(bytes: Buffer): PngLimits | null {
  const size = pngSize(bytes);
  if (!size || bytes.length < 29) return null;
  const { width, height } = size;
  const depth = bytes[24];
  const color = bytes[25];
  if (!DEPTHS[color]?.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) return null;
  if (!width || !height || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) return null;
  const stride = Math.ceil((width * CHANNELS[color] * depth) / 8);
  const decoded = (stride + 1) * height;
  return decoded > MAX_DECODED ? null : { width, height, depth, color, stride, decoded };
}

/**
 * The image scaled to fit `max` × `max` (box average, alpha-weighted), as a new
 * 8-bit RGBA PNG; null when it already fits, or can't be read here (see
 * pngLimits; or damaged, or its data is cut short).
 */
export function downscalePng(bytes: Buffer, max: number): Buffer | null {
  const limits = pngLimits(bytes);
  if (!limits) return null;
  const { width: w, height: h, depth, color, stride } = limits;
  if (w <= max && h <= max) return null;
  const channels = CHANNELS[color];

  let palette: Buffer | undefined;
  let alphas: Buffer | undefined;
  const idat: Buffer[] = [];
  for (let at = 8; at + 12 <= bytes.length; ) {
    const len = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (data.length !== len) return null;
    if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') alphas = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (color === 3 && !palette) return null;

  const bpp = Math.max(1, (channels * depth) >> 3);
  let raw: Buffer;
  try {
    // At most what the header promised (itself at most MAX_DECODED): a small file can't inflate to gigabytes.
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: limits.decoded });
  } catch {
    return null;
  }
  if (raw.length < limits.decoded) return null;

  const scale = max / Math.max(w, h);
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  // Per target pixel: alpha-weighted r, g, b, then alpha and the count of source pixels.
  const sums = new Float64Array(tw * th * 5);
  const column = new Uint32Array(w);
  for (let x = 0; x < w; x++) column[x] = Math.min(tw - 1, Math.floor((x * tw) / w));
  const maxSample = (1 << depth) - 1;
  let prev = Buffer.alloc(stride);
  let row = Buffer.alloc(stride);
  const rgba = [0, 0, 0, 255];

  for (let y = 0; y < h; y++) {
    const start = y * (stride + 1);
    const filter = raw[start];
    raw.copy(row, 0, start + 1, start + 1 + stride);
    if (!unfilter(filter, row, prev, bpp)) return null;
    const ty = Math.min(th - 1, Math.floor((y * th) / h));
    for (let x = 0; x < w; x++) {
      pixel(row, x, color, depth, maxSample, palette, alphas, rgba);
      const o = (ty * tw + column[x]) * 5;
      const a = rgba[3];
      sums[o] += rgba[0] * a;
      sums[o + 1] += rgba[1] * a;
      sums[o + 2] += rgba[2] * a;
      sums[o + 3] += a;
      sums[o + 4] += 1;
    }
    [prev, row] = [row, prev];
  }

  const out = Buffer.alloc((tw * 4 + 1) * th);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const o = (y * tw + x) * 5;
      const p = y * (tw * 4 + 1) + 1 + x * 4;
      const a = sums[o + 3];
      const n = sums[o + 4] || 1;
      out[p] = a ? Math.round(sums[o] / a) : 0;
      out[p + 1] = a ? Math.round(sums[o + 1] / a) : 0;
      out[p + 2] = a ? Math.round(sums[o + 2] / a) : 0;
      out[p + 3] = Math.round(a / n);
    }
  }
  return encodeRgba(tw, th, out);
}

/** Undoes one row's filter in place; false for a filter type PNG doesn't have. */
function unfilter(filter: number, row: Buffer, prev: Buffer, bpp: number): boolean {
  const n = row.length;
  switch (filter) {
    case 0:
      return true;
    case 1:
      for (let i = bpp; i < n; i++) row[i] = (row[i] + row[i - bpp]) & 255;
      return true;
    case 2:
      for (let i = 0; i < n; i++) row[i] = (row[i] + prev[i]) & 255;
      return true;
    case 3:
      for (let i = 0; i < n; i++) row[i] = (row[i] + (((i >= bpp ? row[i - bpp] : 0) + prev[i]) >> 1)) & 255;
      return true;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      return true;
    default:
      return false;
  }
}

/** Pixel x of an unfiltered row as 8-bit RGBA, into `out`. 16-bit samples keep their high byte. */
function pixel(row: Buffer, x: number, color: number, depth: number, maxSample: number, palette: Buffer | undefined, alphas: Buffer | undefined, out: number[]): void {
  if (depth < 8) {
    const bit = x * depth;
    const v = (row[bit >> 3] >> (8 - depth - (bit & 7))) & maxSample;
    if (color === 3) return paletteColor(v, palette!, alphas, out);
    const g = Math.round((v * 255) / maxSample);
    out[0] = out[1] = out[2] = g;
    out[3] = 255;
    return;
  }
  const step = depth >> 3;
  const channels = CHANNELS[color];
  const at = x * channels * step;
  const s = (c: number) => row[at + c * step];
  switch (color) {
    case 0:
      out[0] = out[1] = out[2] = s(0);
      out[3] = 255;
      return;
    case 2:
      out[0] = s(0);
      out[1] = s(1);
      out[2] = s(2);
      out[3] = 255;
      return;
    case 3:
      return paletteColor(row[at], palette!, alphas, out);
    case 4:
      out[0] = out[1] = out[2] = s(0);
      out[3] = s(1);
      return;
    default:
      out[0] = s(0);
      out[1] = s(1);
      out[2] = s(2);
      out[3] = s(3);
  }
}

function paletteColor(index: number, palette: Buffer, alphas: Buffer | undefined, out: number[]): void {
  out[0] = palette[index * 3] ?? 0;
  out[1] = palette[index * 3 + 1] ?? 0;
  out[2] = palette[index * 3 + 2] ?? 0;
  out[3] = alphas && index < alphas.length ? alphas[index] : 255;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** Rows that already carry their filter byte (0), as an 8-bit RGBA PNG. */
export function encodeRgba(width: number, height: number, rows: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
