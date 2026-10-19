// Pure rules for the built-in browser (browser.ts): which URLs agents may open,
// how wide the browser may be, which tools need the user's OK, and the
// optional CORS relaxation for localhost. No vscode here, so all of it is tested.
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApprovalLevel } from '../shared/session';

/** The browser's share of the window: the user drags it, FriedLiver keeps it within these. */
export const BROWSER_WIDTH = { min: 0.4, max: 0.7, default: 0.5 };

export function clampBrowserWidth(fraction: unknown): number {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return BROWSER_WIDTH.default;
  return Math.min(BROWSER_WIDTH.max, Math.max(BROWSER_WIDTH.min, fraction));
}

/**
 * The URL an agent asked for, normalized, or an Error saying why not. Only
 * http and https; `localhost:3000` and `127.0.0.1:8080/x` get `http://`.
 * file:, chrome:, devtools:, javascript:, data:, about: and the rest are refused.
 */
export function checkBrowserUrl(raw: string): string {
  const text = raw.trim();
  const bare = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text);
  let url: URL;
  try {
    url = new URL(bare ? `http://${text}` : text);
  } catch {
    throw new Error(`Not a URL: ${raw.slice(0, 200)}. Give a full http:// or https:// address.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`FriedLiver's browser opens only http and https pages, not ${url.protocol} ones.`);
  }
  return url.href;
}

/**
 * The tab agents may drive: only the one FriedLiver opened (an approved
 * browser_open or the user's Open Browser), never another tab of the user's.
 */
export function ownTab<T>(tab: T | undefined, open: readonly T[]): T {
  if (!tab || !open.includes(tab)) throw new Error("FriedLiver's browser has no page open. Use browser_open first.");
  return tab;
}

export function isLocalhost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname.toLowerCase()) : false;
  } catch {
    return false;
  }
}

/** Tools that only look: they never need the user's OK. The rest act on the page. */
export const BROWSER_READ_TOOLS = new Set(['browser_snapshot', 'browser_screenshot', 'browser_console']);

/** Whether a browser tool call waits for the user: anything that acts, unless the chat is on Full auto. */
export function browserNeedsApproval(tool: string, level: ApprovalLevel | undefined): boolean {
  return !BROWSER_READ_TOOLS.has(tool) && level !== 'full';
}

type Header = { name: string; value: string };

/** A response paused by CDP's Fetch domain at the response stage (the fields used here). */
export interface PausedResponse {
  request: { url: string; method: string; headers: Record<string, string> };
  responseHeaders?: Header[];
}

/**
 * With friedliver.browser.relaxLocalhostCors on, what to do with a paused
 * response: null leaves it alone (anything not from localhost, or a request
 * with no Origin, or an Origin that isn't itself localhost); otherwise the headers to answer with. A preflight
 * (OPTIONS) is answered 204 by FriedLiver itself, since dev servers often 404
 * it. Only localhost responses in the browser's own session are touched.
 */
export function relaxLocalhostCors(paused: PausedResponse): { fulfill: boolean; headers: Header[] } | null {
  if (!isLocalhost(paused.request.url)) return null;
  const req = lower(paused.request.headers);
  const origin = req['origin'];
  // Only a local page talking to a local server: a remote Origin never gets reflected (with credentials) here.
  if (!origin || !isLocalhost(origin)) return null;
  const cors: Header[] = [
    { name: 'Access-Control-Allow-Origin', value: origin },
    { name: 'Access-Control-Allow-Credentials', value: 'true' },
    { name: 'Access-Control-Allow-Methods', value: req['access-control-request-method'] || 'GET, POST, PUT, PATCH, DELETE, OPTIONS' },
    { name: 'Access-Control-Allow-Headers', value: req['access-control-request-headers'] || '*' },
    { name: 'Vary', value: 'Origin' },
  ];
  const replaced = new Set(cors.map((h) => h.name.toLowerCase()));
  const kept = (paused.responseHeaders ?? []).filter((h) => !replaced.has(h.name.toLowerCase()));
  const fulfill = paused.request.method.toUpperCase() === 'OPTIONS';
  return { fulfill, headers: fulfill ? cors : [...kept, ...cors] };
}

function lower(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

const shotDirs = new Map<string, Promise<string>>();
let shots = 0;

/**
 * Writes a screenshot into a folder only this user can open, made fresh (mkdtemp, 0700) under
 * `base` once per session, with 'wx' so an existing file is never overwritten or followed.
 */
export async function saveScreenshot(base: string, png: Buffer, ext = 'png'): Promise<string> {
  const file = await screenshotFile(base, 'screenshot', ext);
  await writeFile(file, png, { flag: 'wx', mode: 0o600 });
  return file;
}

/** A new file name in that private folder, for a program that writes the screenshot itself (system.ts). */
export async function screenshotFile(base: string, name = 'screenshot', ext = 'png'): Promise<string> {
  let dir = shotDirs.get(base);
  if (!dir) {
    dir = mkdtemp(path.join(base, 'shots-'));
    shotDirs.set(base, dir);
    dir.catch(() => shotDirs.delete(base));
  }
  return path.join(await dir, `${name}-${++shots}.${ext}`);
}

/** Screenshot sizing: the widest a capture is by default, the range an agent may ask for, JPEG quality, margin around an element. */
export const SHOT = { maxWidth: 1024, minWidth: 200, maxMaxWidth: 1568, quality: 75, margin: 8 };

/** About what an image costs Claude: width×height/750 tokens, after its own fit to 1568 px on the long edge and 1.15 MP. */
export function imageTokens(width: number, height: number): number {
  let s = Math.min(1, 1568 / Math.max(width, height));
  s = Math.min(s, Math.sqrt(1_150_000 / (width * height * s * s)) * s);
  return Math.round((Math.round(width * s) * Math.round(height * s)) / 750);
}

/**
 * Page.captureScreenshot parameters: the viewport, or one element (`rect`, viewport coordinates)
 * with a margin, at most `maxWidth` image pixels wide whatever the device pixel ratio, as JPEG.
 */
export function shotParams(
  view: { width: number; height: number; dpr: number; scrollX?: number; scrollY?: number },
  opts: { rect?: { x: number; y: number; width: number; height: number }; maxWidth?: number },
): { format: 'jpeg'; quality: number; clip: { x: number; y: number; width: number; height: number; scale: number }; size: { width: number; height: number } } {
  const m = SHOT.margin;
  const r = opts.rect;
  const x = r ? Math.max(0, r.x - m) : 0;
  const y = r ? Math.max(0, r.y - m) : 0;
  const width = r ? Math.min(view.width - x, r.width + 2 * m) : view.width;
  const height = r ? Math.min(view.height - y, r.height + 2 * m) : view.height;
  const css = Math.min(1, (opts.maxWidth ?? SHOT.maxWidth) / width);
  // The capture comes out at width × scale × dpr pixels: undo the ratio so a retina screen doesn't double it.
  return {
    format: 'jpeg',
    quality: SHOT.quality,
    clip: { x: x + (view.scrollX ?? 0), y: y + (view.scrollY ?? 0), width, height, scale: css / view.dpr },
    size: { width: Math.round(width * css), height: Math.round(height * css) },
  };
}

/** browser_console's answer, at most this many characters (~1.5k tokens) unless the agent asks for less. */
export const CONSOLE_BUDGET = 6000;
/** Console lines a page keeps for its readers, each cut to 2,000 characters. */
const CONSOLE_KEEP = 300;

/**
 * A page's console for browser_console: each reader (a chat) gets only the lines since it last asked,
 * repeats collapsed ("… ×12"), the newest that fit CONSOLE_BUDGET, and a note of what was left out,
 * so polling a chatty page doesn't send the same hundred lines every time.
 */
export class ConsoleLog {
  private lines: string[] = [];
  /** Lines pushed since the page was attached; `lines` holds the newest of them. */
  private total = 0;
  private readonly read = new Map<string, number>();

  push(line: string): void {
    this.lines.push(line.slice(0, 2000));
    this.total++;
    if (this.lines.length > CONSOLE_KEEP) this.lines.splice(0, this.lines.length - CONSOLE_KEEP);
  }

  take(reader = '', budget = CONSOLE_BUDGET): string {
    const from = this.read.get(reader) ?? 0;
    this.read.set(reader, this.total);
    const fresh = this.total - from;
    if (!fresh) return from ? 'No new console messages since your last browser_console.' : 'No console messages since FriedLiver attached to the page.';
    const kept = this.lines.slice(-Math.min(fresh, this.lines.length));
    const lost = fresh - kept.length;
    // Repeats, wherever they are, as one line with a count, at the place of their latest occurrence.
    const count = new Map<string, number>();
    for (const l of kept) count.set(l, (count.get(l) ?? 0) + 1);
    const last = new Map<string, number>();
    kept.forEach((l, n) => last.set(l, n));
    const rows = kept.flatMap((l, n) => (last.get(l) === n ? [count.get(l)! > 1 ? `${l} (×${count.get(l)})` : l] : []));
    // The newest lines that fit the budget.
    const out: string[] = [];
    let size = 0;
    for (let n = rows.length - 1; n >= 0; n--) {
      const add = Math.min(rows[n].length, budget) + 1;
      if (out.length && size + add > budget) break;
      out.unshift(rows[n].length > budget ? `${rows[n].slice(0, budget - 1)}…` : rows[n]);
      size += add;
    }
    const older = rows.length - out.length;
    const notes = [
      older ? `${older} older line${older === 1 ? '' : 's'} left out (over the ${budget.toLocaleString('en-US')}-character budget)` : '',
      lost ? `${lost} earlier line${lost === 1 ? '' : 's'} no longer kept` : '',
      count.size < kept.length ? 'repeats collapsed' : '',
    ].filter(Boolean);
    return `${notes.length ? `[${notes.join('; ')}]\n` : ''}${out.join('\n')}`;
  }
}
