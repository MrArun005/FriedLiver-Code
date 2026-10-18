#!/usr/bin/env node
// The design check (DESIGN-SYSTEM.md §5): the chat in the owner's theme (Dark
// 2026), on the reference session (ui-fixture-reference.mjs), at DPR 2 and 1200
// and 640 px wide. For each state it saves our render, a side-by-side
// reference | ours composite, and measures our geometry and colours from the
// DOM against the spec's numbers: review/GAPS.md, one row per number, each
// within the spec's tolerance or marked FAIL.
//
//   node scripts/ui-compare.mjs [--out ~/code/FriedLiver-Code-design/review] [--refs dir-with-5..8.png] [--no-build]
//
// Uses the UI harness server (ui-harness.mjs --serve) and Playwright's Chromium,
// or Chrome with PW_CHANNEL=chrome; headless, no keychain.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ATTACHMENTS, DICTATED } from './ui-fixture-reference.mjs';

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts } = parseArgs({
  options: {
    out: { type: 'string', default: path.join(os.homedir(), 'code/FriedLiver-Code-design/review') },
    refs: { type: 'string', default: path.join(os.homedir(), 'code/FriedLiver-Code-design/references') },
    port: { type: 'string', default: '5191' },
    'no-build': { type: 'boolean', default: false },
    only: { type: 'string' },
  },
});
fs.mkdirSync(opts.out, { recursive: true });
if (!opts['no-build']) {
  const built = spawnSync('npm', ['run', 'build'], { cwd: ext, stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const server = spawn(process.execPath, [path.join(ext, 'scripts/ui-harness.mjs'), '--serve', '--no-build', '--port', opts.port], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes('Serving') && resolve());
  server.on('exit', (code) => reject(new Error(`harness exited ${code}`)));
});
const base = `http://127.0.0.1:${opts.port}`;
const { chromium } = await import('playwright');
const browser = await chromium.launch({ ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}), args: ['--use-mock-keychain', '--password-store=basic'] });

const QUERY = 'surface=chat&theme=dark-2026&fixture=reference&select=chat-ref';

/** The reference chat at `width`, DPR 2, with the three images and the dictated text in its composer. */
async function open(width, height = 900, query = QUERY) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  await page.goto(`${base}/?${query}`);
  await page.waitForSelector('.composer textarea');
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((sizes) => {
    const images = sizes.map(([w, h]) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = '#16181b';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#2b2e33';
      g.fillRect(w * 0.08, h * 0.1, w * 0.84, h * 0.12);
      g.fillRect(w * 0.08, h * 0.3, w * 0.5, h * 0.5);
      g.fillStyle = '#d97757';
      g.fillRect(w * 0.64, h * 0.3, w * 0.28, h * 0.08);
      return { name: 'image.png', mimeType: 'image/png', data: c.toDataURL('image/png').split(',')[1] };
    });
    window.postMessage({ type: 'attached', chatId: 'chat-ref', images: images }, '*');
  }, ATTACHMENTS);
  await page.waitForSelector('.composer .cc-chip img');
  await page.fill('.composer textarea', DICTATED);
  await page.waitForTimeout(100);
  return { page, problems };
}

// Reference crops, in the screenshots' own device pixels (DPR 2), and what of ours to set beside each.
const REFS = {
  composer: { file: '8.png', box: [225, 788, 1632, 1143], ours: ['.composer'] },
  'model-menu': { file: '5.png', box: [0, 0, 1356, 958], ours: ['.cc-menu', '.composer'] },
  'modes-menu': { file: '7.png', box: [0, 0, 1672, 842], ours: ['.cc-menu', '.composer'] },
  'slash-menu': { file: '8.png', box: [225, 80, 1632, 1143], ours: ['.cc-menu', '.composer'] },
  'agent-map': { file: '6.png', box: [1040, 215, 2475, 1625], ours: ['.cc-map'] },
  // 6.png's transcript sits under the map's overlay; ours is cropped the same way, left of the map.
  transcript: { file: '6.png', box: [100, 240, 1060, 1200], ours: 'left-of-map' },
};

const STATES = {
  composer: async (p) => p.click('.composer textarea'),
  'model-menu': async (p) => p.click('.cc-model'),
  'modes-menu': async (p) => p.click('.cc-mode'),
  'slash-menu': async (p) => p.click('.cc-slash-btn'),
  'agent-map': async (p) => p.click('.cc-agents'),
  transcript: async (p) => {
    await p.click('#item-toolu_bash .step-main');
    await p.evaluate(() => document.activeElement?.blur());
  },
};

/** Where to crop ours, in CSS px. */
async function oursBox(page, state) {
  const ref = REFS[state];
  if (ref.ours === 'left-of-map') {
    await page.click('.cc-agents');
    await page.waitForTimeout(250);
    return page.evaluate(() => {
      const m = document.querySelector('.cc-map').getBoundingClientRect();
      const t = document.querySelector('.transcript').getBoundingClientRect();
      return { x: 0, y: t.top, width: Math.max(1, m.left - 8), height: Math.min(480, window.innerHeight - t.top) };
    });
  }
  return page.evaluate((sels) => {
    const rs = sels.map((s) => document.querySelector(s)?.getBoundingClientRect()).filter(Boolean);
    const l = Math.min(...rs.map((r) => r.left)) - 12, t = Math.min(...rs.map((r) => r.top)) - 12;
    const r = Math.max(...rs.map((x) => x.right)) + 12, b = Math.max(...rs.map((x) => x.bottom)) + 12;
    return { x: Math.max(0, l), y: Math.max(0, t), width: Math.min(window.innerWidth, r) - Math.max(0, l), height: Math.min(window.innerHeight, b) - Math.max(0, t) };
  }, ref.ours);
}

/** reference | ours, at the same scale (both DPR 2), labelled. */
async function composite(state, width, oursPng) {
  const ref = REFS[state];
  const refFile = path.join(opts.refs, ref.file);
  if (!fs.existsSync(refFile)) return undefined;
  const page = await browser.newPage({ viewport: { width: 400, height: 300 }, deviceScaleFactor: 1 });
  const data = (b) => `data:image/png;base64,${b.toString('base64')}`;
  await page.setContent(`<html><body style="margin:0;background:#000;font:600 20px -apple-system,sans-serif;color:#fff">
    <div style="display:flex;gap:16px;padding:16px;align-items:flex-start">
      <figure style="margin:0"><figcaption style="margin-bottom:8px">Claude Code (reference ${ref.file})</figcaption><canvas id="ref"></canvas></figure>
      <figure style="margin:0"><figcaption style="margin-bottom:8px">FriedLiver (Dark 2026, ${width}px, DPR 2)</figcaption><img id="ours" src="${data(oursPng)}"></figure>
    </div></body></html>`);
  await page.evaluate(
    async ({ src, box }) => {
      const img = new window.Image();
      img.src = src;
      await img.decode();
      const c = document.getElementById('ref');
      const [x0, y0, x1, y1] = box;
      c.width = x1 - x0;
      c.height = y1 - y0;
      c.getContext('2d').drawImage(img, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
      await document.getElementById('ours').decode();
    },
    { src: data(fs.readFileSync(refFile)), box: ref.box },
  );
  const size = await page.evaluate(() => ({ width: document.body.scrollWidth, height: document.body.scrollHeight }));
  await page.setViewportSize(size);
  const file = path.join(opts.out, `compare-${state}-${width}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
  return file;
}

// ---- The numbers: each measured from the DOM, against the spec (DESIGN-SYSTEM.md §1–§2) ----

/** Runs in the page: the box, computed styles and the colour as rendered (composited over what is behind it). */
const PROBE = () => {
  // rgb()/rgba() and the color(srgb …) that color-mix() computes to.
  const parse = (c) => {
    const srgb = c.match(/color\(srgb ([^)]+)\)/);
    if (srgb) {
      const v = srgb[1].split(/[ /]+/).filter(Boolean).map(Number);
      return [v[0] * 255, v[1] * 255, v[2] * 255, v[3] ?? 1];
    }
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return [0, 0, 0, 0];
    const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [v[0], v[1], v[2], v[3] ?? 1];
  };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  /** The background an element shows: its own over its ancestors', down to the page. */
  const backdrop = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) layers.push(parse(window.getComputedStyle(e).backgroundColor));
    return layers.reverse().reduce((under, top) => over(top, under), [0, 0, 0, 1]);
  };
  const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  window.__probe = {
    box: (sel) => {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      return el ? el.getBoundingClientRect().toJSON() : null;
    },
    css: (sel, prop, pseudo) => {
      const el = document.querySelector(sel);
      return el ? window.getComputedStyle(el, pseudo).getPropertyValue(prop) : null;
    },
    bg: (sel) => {
      const el = document.querySelector(sel);
      return el ? hex(backdrop(el)) : null;
    },
    /** A colour property as it shows over the element's own backdrop. */
    color: (sel, prop = 'color', pseudo) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const c = parse(window.getComputedStyle(el, pseudo).getPropertyValue(prop));
      const opacity = Number(window.getComputedStyle(el).opacity);
      return hex(over([c[0], c[1], c[2], c[3] * opacity], backdrop(el)));
    },
  };
};

// CIEDE2000 between two sRGB hex colours.
function deltaE(h1, h2) {
  const lab = (h) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const xyz = [(0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * b, (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883];
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    const [fx, fy, fz] = xyz.map(f);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  };
  const [L1, a1, b1] = lab(h1), [L2, a2, b2] = lab(h2);
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const ap1 = a1 * (1 + G), ap2 = a2 * (1 + G);
  const Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
  const hp = (b, a) => { const h = Math.atan2(b, a) / rad; return h < 0 ? h + 360 : h; };
  const h1p = hp(b1, ap1), h2p = hp(b2, ap2);
  const dL = L2 - L1, dC = Cp2 - Cp1;
  let dh = h2p - h1p;
  if (Cp1 * Cp2 === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh / 2) * rad);
  const Lm = (L1 + L2) / 2, Cpm = (Cp1 + Cp2) / 2;
  let hm = h1p + h2p;
  if (Cp1 * Cp2 !== 0) hm = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2 : (h1p + h2p) / 2;
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2), Sc = 1 + 0.045 * Cpm, Sh = 1 + 0.015 * Cpm * T;
  const Rt = -2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hm - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

const px = (v) => (v == null ? NaN : parseFloat(v));
const rows = [];
/** One number: geometry within ±0.5 CSS px, colours within ΔE2000 2, words equal. */
function row(component, property, reference, ours, tol = 0.5) {
  let pass;
  if (typeof reference === 'string' && reference.startsWith('#')) pass = typeof ours === 'string' && /^#[0-9a-f]{6}$/.test(ours) && deltaE(reference, ours) < 2;
  else if (typeof reference === 'number') pass = Number.isFinite(ours) && Math.abs(ours - reference) <= tol;
  else if (typeof reference === 'function') pass = reference(ours);
  else pass = ours === reference;
  const shown = (v) => (typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v));
  rows.push({ component, property, reference: typeof reference === 'function' ? reference.label : shown(reference), ours: shown(ours), delta: typeof reference === 'number' && Number.isFinite(ours) ? shown(ours - reference) : typeof reference === 'string' && reference.startsWith('#') && /^#/.test(String(ours)) ? `ΔE ${deltaE(reference, ours).toFixed(2)}` : '', pass });
}
const radius = (v, h) => Math.min(px(v), h / 2);
const check = (label, fn) => Object.assign(fn, { label });

async function measure(page, state, width) {
  await page.evaluate(PROBE);
  const P = (fn, ...args) => page.evaluate(({ fn, args }) => window.__probe[fn](...args), { fn, args });
  const box = (s) => P('box', s);
  const css = (s, prop, pseudo) => P('css', s, prop, pseudo);
  const c = `@${width}`;
  if (state === 'composer') {
    const comp = await box('.composer');
    row(`Composer ${c}`, 'max width', width >= 712 ? 680 : width - 32, comp.width);
    row(`Composer ${c}`, 'side gap', width >= 712 ? (width - 680) / 2 : 16, comp.left);
    row(`Composer ${c}`, 'gap below', 16, (await page.evaluate(() => window.innerHeight)) - comp.bottom);
    row(`Composer ${c}`, 'radius', 8, px(await css('.composer', 'border-top-left-radius')));
    row(`Composer ${c}`, 'border', 1, px(await css('.composer', 'border-top-width')));
    row(`Composer ${c}`, 'background (one tone)', '#191a1b', await P('bg', '.composer'));
    row(`Composer ${c}`, 'footer background = input tone', '#191a1b', await P('bg', '.composer-bar'));
    row(`Composer ${c}`, 'focus border (Auto: errorForeground)', '#f48771', await P('color', '.composer', 'border-top-color'));
    row(`Composer ${c}`, 'focus halo', check('3px ring', (v) => / 0px 0px 3px/.test(v)), await css('.composer', 'box-shadow'));
    row(`Composer ${c}`, 'message font size', 13, px(await css('.cc-input textarea', 'font-size')));
    row(`Composer ${c}`, 'message line height', 19.5, px(await css('.cc-input textarea', 'line-height')));
    for (const [side, want] of [['top', 10], ['right', 36], ['bottom', 10], ['left', 14]]) row(`Composer ${c}`, `message padding ${side}`, want, px(await css('.cc-input textarea', `padding-${side}`)));
    row(`Composer ${c}`, 'placeholder colour', '#555555', await P('color', '.cc-input textarea', 'color', '::placeholder').catch(() => null) ?? 'n/a');
    const bar = await box('.composer-bar');
    row(`Composer ${c}`, 'footer height', 36.5, bar.height);
    row(`Composer ${c}`, 'footer padding', 5, px(await css('.composer-bar', 'padding-left')));
    row(`Composer ${c}`, 'footer gap', 2, px(await css('.composer-bar', 'column-gap')));
    row(`Composer ${c}`, 'footer rule', 0.5, px(await css('.composer-bar', 'border-top-width')));
    const plus = await box('.attach-btn');
    row(`Composer ${c}`, '+ button', 26, plus.width);
    row(`Composer ${c}`, '+ radius', 5, px(await css('.attach-btn', 'border-top-left-radius')));
    const pill = await box('.cc-model');
    row(`Composer ${c}`, 'pill height', 18, pill.height);
    row(`Composer ${c}`, 'pill radius (h/2)', 9, radius(await css('.cc-model', 'border-top-left-radius'), pill.height));
    row(`Composer ${c}`, 'pill font size', 11.05, px(await css('.cc-model', 'font-size')));
    row(`Composer ${c}`, 'pill padding', 8, px(await css('.cc-model', 'padding-left')));
    row(`Composer ${c}`, 'pill margin-left', 6, px(await css('.cc-model', 'margin-left')));
    row(`Composer ${c}`, 'pill fill', '#2a2b2b', await P('bg', '.cc-model'));
    row(`Composer ${c}`, 'agents dot', 6, (await box('.cc-agents .dot')).width);
    // One status palette (QA F06, owner decision 2026-10-17): working is the theme's blue, not the spec's green.
    row(`Composer ${c}`, 'agents dot colour (running)', '#57a3f8', await P('color', '.cc-agents .dot', 'background-color'));
    row(`Composer ${c}`, 'mode button height', 26, (await box('.cc-mode')).height);
    const sendBox = await box('.send-btn');
    row(`Composer ${c}`, 'send size', 26, sendBox.width);
    row(`Composer ${c}`, 'send radius', 5, px(await css('.send-btn', 'border-top-left-radius')));
    row(`Composer ${c}`, 'send fill (Auto)', '#f48771', await P('bg', '.send-btn'));
    row(`Composer ${c}`, 'send icon', 20, (await box('.send-btn .icon')).width);
    row(`Composer ${c}`, 'mic', 26, (await box('.cc-mic')).height);
    row(`Composer ${c}`, 'mic radius', 5, px(await css('.cc-mic', 'border-top-left-radius')));
    const chip = await box('.cc-chip');
    row(`Attachment chip ${c}`, 'height', 24, chip.height);
    row(`Attachment chip ${c}`, 'radius', 4, px(await css('.cc-chip', 'border-top-left-radius')));
    row(`Attachment chip ${c}`, 'max width', check('<= 180', (v) => v <= 180.5), chip.width);
    row(`Attachment chip ${c}`, 'label size', 11.05, px(await css('.cc-chip', 'font-size')));
    row(`Attachment chip ${c}`, 'fill', '#2a2b2c', await P('bg', '.cc-chip'));
    row(`Attachment chip ${c}`, 'thumbnail', 12, (await box('.cc-chip img')).width);
    row(`Attachment row ${c}`, 'padding', 6, px(await css('.cc-chips', 'padding-left')));
    row(`Attachment row ${c}`, 'gap', 4, px(await css('.cc-chips', 'column-gap')));
    row(`Type ${c}`, 'family is the chat font, not Inter', check('system, no Inter', (v) => !/inter|jetbrains/i.test(v)), await css('body', 'font-family'));
    row(`Type ${c}`, 'body text', '#bfbfbf', await P('color', '.prose'));
    row(`Type ${c}`, 'secondary text', '#8c8c8c', await P('color', '.step-time'));
  }
  if (state.endsWith('-menu')) {
    const name = { 'model-menu': 'Model menu', 'modes-menu': 'Modes menu', 'slash-menu': 'Slash menu' }[state] + ` ${c}`;
    const menu = await box('.cc-menu');
    const comp = await box('.composer');
    row(name, 'radius', 8, px(await css('.cc-menu', 'border-top-left-radius')));
    row(name, 'fill', '#202122', await P('bg', '.cc-menu'));
    row(name, 'border', '#2a2b2c', await P('color', '.cc-menu', 'border-top-color'));
    row(name, 'shadow', 'none', await css('.cc-menu', 'box-shadow'));
    row(name, 'gap to composer', 8, comp.top - menu.bottom);
    row(name, 'padding bottom', 4, px(await css('.cc-menu', 'padding-bottom')));
    const item = state === 'slash-menu' ? '.cc-slash-menu .cc-menu-section .cc-item' : '.cc-menu .cc-item';
    const it = await box(item);
    row(name, 'row inset', 4, it.left - menu.left - 1);
    row(name, 'row radius', 4, px(await css(item, 'border-top-left-radius')));
    row(name, 'row padding', '4px 8px', await css(item, 'padding'));
    if (state === 'model-menu') {
      row(name, 'padding top', 6, px(await css('.cc-menu', 'padding-top')));
      row(name, 'width (= composer)', comp.width, menu.width);
      row(name, 'font size', 13, px(await css('.cc-item-name', 'font-size')));
      row(name, '2-line row height', 39.5, it.height);
      const items = await page.evaluate(() => [...document.querySelectorAll('.cc-model-menu .cc-menu-list .cc-item')].slice(0, 2).map((e) => e.getBoundingClientRect().top));
      row(name, 'row pitch', 41.5, items[1] - items[0]);
      row(name, 'title colour (fg 50%)', '#707071', await P('color', '.cc-menu-title'));
      row(name, 'title padding', '4px 12px', await css('.cc-menu-title', 'padding'));
      row(name, 'selected fill', '#3d3e3f', await P('bg', '.cc-item[aria-checked="true"]'));
      row(name, 'selected text', '#ededed', await P('color', '.cc-item[aria-checked="true"] .cc-item-name'));
      row(name, 'description size', 11.05, px(await css('.cc-item-desc', 'font-size')));
      await page.hover('.cc-model-menu .cc-menu-list .cc-item:nth-child(3)');
      row(name, 'hover fill (≠ selected)', '#313233', await P('bg', '.cc-model-menu .cc-menu-list .cc-item:nth-child(3)'));
      const track = await box('.cc-slider');
      row(name, 'effort track', '76x18', `${track.width}x${track.height}`);
      row(name, 'effort track radius', 9, radius(await css('.cc-slider', 'border-top-left-radius'), track.height));
      row(name, 'effort thumb', 14, (await box('.cc-thumb')).width);
      const sw = await box('.cc-switch');
      row(name, 'toggle', '32x18', `${sw.width}x${sw.height}`);
      row(name, 'toggle thumb', 14, px(await css('.cc-switch', 'width', '::after')));
      row(name, 'divider', 1, (await box('.cc-divider')).height);
    }
    if (state === 'modes-menu') {
      // 7.png: 602 device px with its border, right edge 73 device px in from the composer's.
      row(name, 'width (not the composer width)', 301, menu.width);
      row(name, 'right edge, in from the composer', 36.5, comp.right - menu.right);
      const desc = await box('.cc-modes-menu .cc-item[aria-checked="true"] .cc-item-desc');
      row(name, 'selected description wraps to two lines', check('2 lines', (v) => v === 2), Math.round(desc.height / (9.95 * 1.2)));
      row(name, 'row font size (.9em)', 11.7, px(await css('.cc-modes-menu .cc-item-name', 'font-size')));
      row(name, 'description size (.85 × .9em)', 9.95, px(await css('.cc-modes-menu .cc-item-desc', 'font-size')));
      row(name, 'row icon box', 20, (await box('.cc-modes-menu .cc-item > .icon')).width);
      row(name, 'check', 16, (await box('.cc-modes-menu .cc-item[aria-checked="true"] .icon:last-child')).width);
      row(name, 'kbd radius', 3, px(await css('.cc-keys kbd', 'border-top-left-radius')));
      row(name, 'kbd padding', '1px 4px', await css('.cc-keys kbd', 'padding'));
      row(name, 'kbd fill', '#242526', await P('bg', '.cc-keys kbd'));
    }
    if (state === 'slash-menu') {
      row(name, 'width (= composer)', comp.width, menu.width);
      const f = await box('.cc-search');
      row(name, 'filter height', 29.5, f.height);
      row(name, 'filter inset', 4, f.left - menu.left - 1);
      row(name, 'filter radius', 4, px(await css('.cc-search', 'border-top-left-radius')));
      row(name, 'filter fill', '#191a1b', await P('bg', '.cc-search'));
      const items = await page.evaluate(() => [...document.querySelectorAll('.cc-slash-menu .cc-menu-section:first-child .cc-item')].slice(0, 2).map((e) => e.getBoundingClientRect().top));
      row(name, 'item pitch', 27.5, items[1] - items[0]);
      row(name, 'text inset from the border', 12.5, (await page.evaluate(() => {
        const t = document.querySelector('.cc-slash-menu .cc-item .cc-item-name').getBoundingClientRect();
        return t.left - document.querySelector('.cc-slash-menu').getBoundingClientRect().left - 1;
      })) + 0.5);
      row(name, 'section header colour', '#707071', await P('color', '.cc-menu-sub'));
      row(name, 'section header size', 11.7, px(await css('.cc-menu-sub', 'font-size')));
      row(name, 'section header padding', '4px 12px', await css('.cc-menu-sub', 'padding'));
    }
  }
  if (state === 'agent-map') {
    const name = `Agent map ${c}`;
    const d = await box('.cc-map');
    row(name, 'overlay (black 75%)', check('rgba(0, 0, 0, 0.75)', (v) => v === 'rgba(0, 0, 0, 0.75)'), await css('.cc-overlay', 'background-color'));
    if (width >= 720) row(name, 'dialog width (fit)', 694, d.width);
    row(name, 'dialog radius', 8, px(await css('.cc-map', 'border-top-left-radius')));
    row(name, 'dialog padding', 16, px(await css('.cc-map', 'padding-left')));
    row(name, 'dialog fill', '#191a1b', await P('bg', '.cc-map'));
    row(name, 'dialog border', '#242526', await P('color', '.cc-map', 'border-top-color'));
    row(name, 'title size', 16, px(await css('.cc-map-title', 'font-size')));
    row(name, 'title weight', '600', await css('.cc-map-title', 'font-weight'));
    row(name, 'subtitle colour', '#8c8c8c', await P('color', '.cc-map-sub'));
    const child = await box('.cc-map-children .cc-map-node');
    if (width >= 720) {
      row(name, 'agent row width', 300, child.width);
      row(name, 'agent row height', 44, child.height);
      row(name, 'this chat row', 320, (await box('.cc-map-main')).width);
      row(name, 'children indent', 32, child.left - (await box('.cc-map-main')).right);
    }
    row(name, 'row radius', 4, px(await css('.cc-map-node', 'border-top-left-radius')));
    row(name, 'row fill', '#202122', await P('bg', '.cc-map-children .cc-map-node'));
    const kids = await page.evaluate(() => [...document.querySelectorAll('.cc-map-children .cc-map-node')].slice(0, 2).map((e) => e.getBoundingClientRect()));
    row(name, 'row gap', 8, kids[1].top - kids[0].bottom);
    row(name, 'running dot (status palette, QA F06)', '#57a3f8', await P('color', '.cc-map-children .dot[data-state="working"]', 'background-color'));
    row(name, 'dot size', 8, (await box('.cc-map-children .dot')).width);
    row(name, 'meta size', 11.05, px(await css('.cc-map-meta', 'font-size')));
    row(name, 'main row weight', '600', await css('.cc-map-main .cc-map-name', 'font-weight'));
    row(name, 'no footer button', 0, await page.locator('.cc-map-foot').count());
  }
  if (state === 'transcript') {
    const name = `Transcript ${c}`;
    // Spacing pass 2026-10-17: the side gutter is 16 at narrow widths, lined up with the composer.
    const gutter = width <= 720 ? 16 : 20;
    row(name, 'padding', `20px ${gutter}px 40px`, await css('.transcript', 'padding'));
    const step = await box('#item-toolu_bash');
    const tr = await box('.transcript');
    row(name, 'timeline indent', 30, px(await css('#item-toolu_bash', 'padding-left')));
    row(name, 'dot size', 7, px(await css('#item-toolu_bash', 'width', '::before')));
    row(name, 'dot left', 9, px(await css('#item-toolu_bash', 'left', '::before')));
    row(name, 'spine left', 12, px(await css('#item-toolu_bash', 'left', '::after')));
    row(name, 'spine width', 1, px(await css('#item-toolu_bash', 'width', '::after')));
    row(name, 'done dot', '#74c991', await P('color', '#item-toolu_bash', 'background-color', '::before'));
    row(name, 'full width (no max-width)', tr.width - 2 * gutter, step.width);
    row(name, 'tool name weight', '700', await css('#item-toolu_read .step-verb', 'font-weight'));
    row(name, 'target size (mono .85em)', 11.05, px(await css('#item-toolu_bash .step-text', 'font-size')));
    row(name, 'tool body border', 0.5, px(await css('#item-toolu_bash .tool-body', 'border-top-width')));
    row(name, 'tool body radius', 5, px(await css('#item-toolu_bash .tool-body', 'border-top-left-radius')));
    row(name, 'IN/OUT label colour (fg-2 at 50%)', '#4f4f50', await P('color', '#item-toolu_bash .tool-label'));
    row(name, 'OUT fill', '#242526', await P('bg', '#item-toolu_bash .step-output .tool-cell'));
    row(name, 'IN clamp', 60, px(await css('#item-toolu_bash .step-command pre.code.capped', 'max-height')));
    row(name, 'user message radius', 6, px(await css('.user-msg .bubble', 'border-top-left-radius')));
    row(name, 'user message padding', '4px 6px', await css('.user-msg .bubble', 'padding'));
    row(name, 'user message fill', '#191a1b', await P('bg', '.user-msg .bubble'));
    row(name, 'code block fill', '#242526', await P('bg', '.prose pre.code'));
    row(name, 'code block radius', 4, px(await css('.prose pre.code', 'border-top-left-radius')));
    row(name, 'code block border', 0, px(await css('.prose pre.code', 'border-top-width')));
    row(name, 'inline code fill', '#262626', await P('bg', '.prose p code'));
    row(name, 'inline code radius', 3, px(await css('.prose p code', 'border-top-left-radius')));
    row(name, 'inline code border', 0, px(await css('.prose p code', 'border-top-width')));
    row(name, 'text colour', '#bfbfbf', await P('color', '.prose p'));
    row(name, 'line height', 19.5, px(await css('.prose p', 'line-height')));
    await spacing(page, width, P, box, css);
  }
}

/** The chat tab's spacing (owner, 2026-10-17): the 4/8/12/16/24 scale, measured against 6.png/8.png and the spec. */
async function spacing(page, width, P, box, css) {
  const name = `Spacing @${width}`;
  const gutter = width <= 720 ? 16 : 20;
  const tab = await box('.tabs [role="tab"]');
  row(name, 'tab height (6.png: 30)', 30, tab.height);
  row(name, 'tab padding left', 8, px(await css('.tabs [role="tab"]', 'padding-left')));
  row(name, 'gap between tabs', 4, px(await css('.tabs', 'column-gap')));
  row(name, 'header side padding = gutter', gutter, px(await css('.chat-head', 'padding-left')));
  row(name, 'header padding top/bottom', 8, px(await css('.chat-head', 'padding-top')));
  const head = await box('.chat-head');
  const tr = await box('.transcript');
  row(name, 'header to transcript text', 20, (await box('.transcript > .user-msg')).top - head.bottom - (tr.top - head.bottom));
  row(name, 'transcript gutter', gutter, px(await css('.transcript', 'padding-left')));
  row(name, 'transcript bottom', 40, px(await css('.transcript', 'padding-bottom')));
  row(name, 'title lines up with the transcript', 0, (await box('.chat-head-title')).left + 6 - (tr.left + gutter));
  row(name, 'user message padding', '4px 6px', await css('.user-msg .bubble', 'padding'));
  // Owner, 2026-10-17: the box spans the transcript like Claude Code's prompt box, however short the message.
  row(name, 'user message box = transcript content width', tr.width - 2 * gutter, (await box('.user-msg .bubble')).width);
  row(name, 'user message box starts at the gutter', 0, (await box('.user-msg .bubble')).left - (tr.left + gutter));
  row(name, 'user message margin (4px 0; the first one 0 on top)', 4, px(await css('.user-msg', 'padding-bottom')));
  const rows = await page.evaluate(() => [...document.querySelectorAll('.transcript > .tl')].slice(0, 2).map((e) => e.getBoundingClientRect().top));
  row(name, 'timeline pitch (6.png: 36)', 36, rows[1] - rows[0]);
  row(name, 'timeline row padding', 8, px(await css('.transcript > .tl', 'padding-top')));
  row(name, 'IN/OUT block margin', 8, px(await css('#item-toolu_bash .tool-body', 'margin-top')));
  row(name, 'code block margin', 8, px(await css('.prose .code-block', 'margin-top')));
  row(name, 'reply padding', 8, px(await css('.prose', 'padding-top')));
  row(name, 'paragraph gap (.2em)', 2.6, px(await css('.prose .md > p', 'margin-bottom')), 0.1);
  row(name, 'list indent (2em)', 26, px(await css('.prose .md > ul', 'padding-inline-start')));
  const comp = await box('.composer');
  row(name, 'composer side gap', width >= 712 ? (width - 680) / 2 : 16, comp.left);
  row(name, 'composer gap below', 16, (await page.evaluate(() => window.innerHeight)) - comp.bottom);
  if (width <= 720) row(name, 'composer lines up with the transcript', 0, comp.left - (tr.left + gutter));
  // A chat with several turns, and one with a decision card.
  const other = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
  await other.goto(`${base}/?surface=chat&theme=dark-2026&select=chat-c5`);
  await other.waitForSelector('.transcript > .user-msg ~ .user-msg');
  const gaps = await other.evaluate(() => {
    const second = document.querySelectorAll('.transcript > .user-msg')[1];
    const prev = second.previousElementSibling;
    const step = document.querySelector('.transcript > .tl + .tl');
    const pad = (e, side) => parseFloat(window.getComputedStyle(e)[`padding${side}`]);
    // Text box to text box: the bubble's top against the previous block's content bottom; a step's line against the next.
    return {
      turn: second.querySelector('.bubble').getBoundingClientRect().top - (prev.getBoundingClientRect().bottom - pad(prev, 'Bottom')),
      within: step ? step.getBoundingClientRect().top + pad(step, 'Top') - (step.previousElementSibling.getBoundingClientRect().bottom - pad(step.previousElementSibling, 'Bottom')) : NaN,
    };
  });
  row(name, 'gap between turns', 24, gaps.turn);
  row(name, 'gap between steps in a turn', 16, gaps.within);
  await other.goto(`${base}/?surface=chat&theme=dark-2026&select=chat-c2`);
  await other.waitForSelector('.ask');
  row(name, 'decision card margin', 8, px(await other.evaluate(() => window.getComputedStyle(document.querySelector('.ask')).marginTop)));
  row(name, 'decision card padding', 8, px(await other.evaluate(() => window.getComputedStyle(document.querySelector('.ask')).paddingTop)));
  await other.close();
}

const shots = [];
for (const width of [1200, 640]) {
  for (const [state, act] of Object.entries(STATES)) {
    if (opts.only && !opts.only.split(',').includes(state)) continue;
    const { page, problems } = await open(width);
    await act(page);
    await page.waitForTimeout(250);
    const file = path.join(opts.out, `ours-${state}-${width}.png`);
    await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
    await measure(page, state, width);
    const clip = await oursBox(page, state);
    const crop = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
    const comp = await composite(state, width, crop);
    shots.push({ state, width, file, comp });
    if (problems.length) console.error(`${state} @${width}: ${problems.join('; ')}`);
    await page.close();
  }
}

// ---- review/GAPS.md ----
const byComponent = new Map();
for (const r of rows) {
  const key = r.component.replace(/ @\d+$/, '');
  byComponent.set(key, [...(byComponent.get(key) ?? []), r]);
}
const failed = rows.filter((r) => !r.pass);
const cell = (v) => String(v).replace(/\|/g, '\\|');
const md = [
  '# FriedLiver chat vs Claude Code: the numbers',
  '',
  `Generated by \`extensions/friedliver-agents/scripts/ui-compare.mjs\` on ${new Date().toISOString().slice(0, 10)}: the reference session (ui-fixture-reference.mjs) in Dark 2026 (test/fixtures/theme-dark-2026.css), DPR 2, at 1200 and 640 px. Every value is measured from the rendered DOM (geometry from boxes, colours as rendered over their backdrop) and compared with DESIGN-SYSTEM.md. Tolerance: ±0.5 CSS px for sizes, ΔE2000 < 2 for colours, exact for words.`,
  '',
  `**${rows.length - failed.length} of ${rows.length} pass.**`,
  '',
  '## By component',
  '',
  '| Component | Rows | Pass | Fail |',
  '|---|---|---|---|',
  ...[...byComponent].map(([k, rs]) => `| ${k} | ${rs.length} | ${rs.filter((r) => r.pass).length} | ${rs.filter((r) => !r.pass).length} |`),
  '',
  '## Every row',
  '',
  '| Component | Property | Reference | Ours | Δ | Result |',
  '|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${cell(r.component)} | ${cell(r.property)} | ${cell(r.reference)} | ${cell(r.ours)} | ${cell(r.delta)} | ${r.pass ? 'pass' : '**FAIL**'} |`),
  '',
  '## Composites',
  '',
  ...shots.filter((s) => s.comp).map((s) => `- \`${path.basename(s.comp)}\`: ${s.state} at ${s.width}px (reference left, ours right)`),
  '',
];
fs.writeFileSync(path.join(opts.out, 'GAPS.md'), md.join('\n'));
console.log(`${rows.length - failed.length}/${rows.length} rows pass; ${path.join(opts.out, 'GAPS.md')}`);
for (const r of failed) console.log(`  FAIL ${r.component} · ${r.property}: reference ${r.reference}, ours ${r.ours}`);
await browser.close();
server.kill();
process.exitCode = failed.length ? 1 : 0;
