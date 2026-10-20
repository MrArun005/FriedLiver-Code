#!/usr/bin/env node
/* global NodeFilter -- used inside page.evaluate */
// Design System v2 "Beacon", phase B2: the real webviews, in FriedLiver Dark and Light, beside the v2 mocks.
// Serves the UI harness (ui-harness.mjs --serve), renders every screen at 1440×900 and 1280×800 (and 640 / 480
// for the narrow ones; Windows at 1440), runs the objective gates on each render, writes a side-by-side
// "ours | mock" composite where a mock of the same screen exists, colour-blind simulations of the board, and
// (with --video) three short motion clips. Not shipped.
//
//   PW_CHANNEL=chrome node scripts/ui-v2.mjs [--no-build] [--out dir] [--mocks dir] [--only chat,manager] [--video]
//
// Out (default ~/code/FriedLiver-Code-design/review/v2-real/webviews): <screen>-<theme>[-win]-<w>x<h>.png,
// compare/<screen>-<theme>-<w>x<h>.png, cvd/manager-<kind>.png, clips/*.webm, gates.json.
// Gates (COMPONENTS.md v2 §3): text 4.5:1 (3:1 large) on its composited background; status marks 3:1;
// accent groups ≤ 1 per screen (switches and checkboxes excepted; a split button counts once); spacing on the
// 2px half-grid; no control outside the window; icon buttons with a 24×24 hit box.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const design = path.join(os.homedir(), 'code/FriedLiver-Code-design/review');
const { values: opts } = parseArgs({
  options: {
    'no-build': { type: 'boolean', default: false },
    out: { type: 'string', default: path.join(design, 'v2-real/webviews') },
    mocks: { type: 'string', default: path.join(design, 'v2') },
    only: { type: 'string' },
    port: { type: 'string', default: '5241' },
    video: { type: 'boolean', default: false },
  },
});
if (!opts['no-build']) {
  const built = spawnSync('npm', ['run', 'build'], { cwd: ext, stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

// name: harness query; mock: the v2 mock screen it answers to; narrow: also at 640 and 480; win: also Windows.
const SCREENS = [
  { name: 'chat', q: 'surface=chat&select=chat-c1', mock: 'chat', narrow: true, win: true },
  { name: 'chat-steps', q: 'surface=chat&fixture=steps' },
  { name: 'approvals', q: 'surface=chat&fixture=approvals', narrow: true },
  { name: 'manager', q: 'surface=tasks', mock: 'manager', narrow: true, win: true },
  { name: 'list', q: 'surface=tasks&view=list' },
  { name: 'inbox', q: 'surface=tasks&fixture=inbox&view=inbox' },
  { name: 'discuss', q: 'surface=chat&fixture=discuss&select=chat-split', mock: 'discuss', narrow: true, win: true },
  { name: 'discuss-running', q: 'surface=chat&fixture=discuss&select=chat-main' },
  { name: 'welcome', q: 'surface=welcome', mock: 'welcome', narrow: true, win: true },
  { name: 'welcome-first', q: 'surface=welcome&empty=1&firstRun=1' },
  { name: 'accounts', q: 'surface=accounts' },
].filter((s) => !opts.only || opts.only.split(',').includes(s.name));
const THEMES = { dark: 'dark', light: 'light' };

for (const d of ['', 'compare', 'cvd', 'clips']) fs.mkdirSync(path.join(opts.out, d), { recursive: true });
const server = spawn(process.execPath, [path.join(ext, 'scripts/ui-harness.mjs'), '--serve', '--no-build', '--port', opts.port], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes('Serving') && resolve());
  server.on('exit', (code) => reject(new Error(`harness exited ${code}`)));
});
const base = `http://127.0.0.1:${opts.port}`;
const { chromium } = await import('playwright');
const browser = await chromium.launch({ ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}), args: ['--use-mock-keychain', '--password-store=basic'] });

function gates() {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) {
      const s = c.match(/srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?/);
      return s ? [s[1] * 255, s[2] * 255, s[3] * 255, s[4] === undefined ? 1 : +s[4]] : [0, 0, 0, 0];
    }
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const over = (t, u) => [0, 1, 2].map((k) => t[k] * t[3] + u[k] * (1 - t[3])).concat(1);
  const lum = ([r, g, b]) => {
    const f = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };
  const bgOf = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c[3] > 0) stack.push(c);
      if (c[3] >= 1) break;
    }
    let b = parse(getComputedStyle(document.body).backgroundColor);
    for (const c of stack.reverse()) b = over(c, b);
    return b;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.left < innerWidth && cs.visibility !== 'hidden';
  };
  const opacity = (el) => {
    let op = 1;
    for (let e = el; e; e = e.parentElement) op *= +getComputedStyle(e).opacity;
    return op;
  };
  const fails = [];
  let checked = 0;
  const seen = new Set();
  const walker = document.createTreeWalker(document.getElementById('root'), NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!n.textContent.trim() || seen.has(el) || !visible(el)) continue;
    seen.add(el);
    // Disabled controls are exempt (WCAG 1.4.3), as are things hidden until hover (opacity 0).
    const op = opacity(el);
    if (op < 0.05 || el.closest(':disabled, [aria-disabled="true"]')) continue;
    const cs = getComputedStyle(el);
    const bg = bgOf(el);
    const c = parse(cs.color);
    const fg = over([c[0], c[1], c[2], c[3] * op], bg);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700);
    const v = ratio(fg, bg);
    checked++;
    if (v < (large ? 3 : 4.5) - 0.01) fails.push({ text: n.textContent.trim().slice(0, 40), ratio: +v.toFixed(2), cls: String(el.className).slice(0, 60) });
  }
  // Status marks against their surface (WCAG 1.4.11).
  const marks = [];
  for (const el of document.querySelectorAll('.fl-dot:not([data-state="done"])')) {
    if (!visible(el)) continue;
    const v = ratio(over(parse(getComputedStyle(el).borderTopColor), bgOf(el.parentElement)), bgOf(el.parentElement));
    if (v < 3) marks.push({ state: el.dataset.state, ratio: +v.toFixed(2) });
  }
  // The accent: elements filled with it; a split button counts once; switches and checkboxes excepted.
  const probe = document.createElement('i');
  probe.style.background = 'var(--accent-bg)';
  document.body.append(probe);
  const accent = parse(getComputedStyle(probe).backgroundColor);
  probe.remove();
  const same = (a, b) => a[3] > 0.5 && a.slice(0, 3).every((x, k) => Math.abs(x - b[k]) < 3);
  const accented = [...document.querySelectorAll('#root *')].filter((e) => visible(e) && !e.closest('.fl-toggle, .fl-check__box, .fl-check, :disabled') && same(parse(getComputedStyle(e).backgroundColor), accent));
  const groups = new Set(accented.map((e) => e.closest('.fl-split') ?? e));
  // Spacing on the 2px half-grid.
  const off = new Set();
  let spacings = 0;
  for (const e of document.querySelectorAll('#root *')) {
    if (!visible(e)) continue;
    const cs = getComputedStyle(e);
    for (const p of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'rowGap', 'columnGap']) {
      const v = Math.abs(parseFloat(cs[p]));
      if (!v || Number.isNaN(v)) continue;
      // Not spacing: a margin auto resolved to px (it pushes an item to the end), an sm icon button's 1px of
      // hit-box margin (§2.2), and markdown's em rhythm, which scales with the reader's text size.
      // The composer is frozen (layout and spacing; HANDOFF-v2 §B2.3), so its 5px insets are the approved ones.
      const prop = p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      if (p.startsWith('margin') && (String(e.computedStyleMap?.().get(prop)) === 'auto' || (v === 1 && e.matches('.fl-btn--icon, .fl-btn--sm')) || e.closest('.md'))) continue;
      if (e.closest('.composer')) continue;
      spacings++;
      if (Math.abs(v - Math.round(v / 2) * 2) > 0.05) off.add(`${String(e.className).slice(0, 40)} ${p}=${v}`);
    }
  }
  // Controls inside the window; icon buttons with a 24×24 hit box (an sm one's 1px margins count).
  const outside = [...document.querySelectorAll('#root .fl-btn, #root .fl-pill, #root .fl-toggle, #root .fl-input, #root .fl-seg')].filter((e) => {
    const b = e.getBoundingClientRect();
    return b.width && b.top < innerHeight && (b.right > innerWidth + 0.5 || b.left < -0.5);
  }).map((e) => (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 30));
  const small = [...document.querySelectorAll('#root .fl-btn--icon')].filter((e) => {
    if (!visible(e)) return false;
    const b = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return b.width + parseFloat(cs.marginLeft) + parseFloat(cs.marginRight) < 23.5 || b.height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom) < 23.5;
  }).length;
  return { checked, contrast: fails, marks, accentGroups: groups.size, spacings, offGrid: [...off].slice(0, 12), offGridCount: off.size, outside, smallHitBoxes: small };
}

async function open(query, width, height, extra = {}) {
  const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion: 'reduce', ...extra });
  await p.goto(`${base}/?${query}`);
  await p.waitForSelector('#root > *');
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(600);
  return p;
}

const report = {};
for (const s of SCREENS) {
  const sizes = [[1440, 900], [1280, 800], ...(s.narrow ? [[640, 900], [480, 900]] : [])];
  const variants = [...Object.keys(THEMES).flatMap((t) => sizes.map(([w, h]) => ({ t, w, h, win: false }))), ...(s.win ? [{ t: 'dark', w: 1440, h: 900, win: true }] : [])];
  for (const { t, w, h, win } of variants) {
    const name = `${s.name}-${t}${win ? '-win' : ''}-${w}x${h}`;
    const p = await open(`${s.q}&theme=${THEMES[t]}${win ? '&platform=win' : ''}`, w, h);
    const file = path.join(opts.out, `${name}.png`);
    await p.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
    report[name] = await p.evaluate(gates);
    await p.close();
    const mock = s.mock && path.join(opts.mocks, `${s.mock}-${win ? 'windows-' : ''}${t}-${w}x${h}.png`);
    if (mock && fs.existsSync(mock)) {
      const c = await browser.newPage({ viewport: { width: 2 * w + 24, height: h + 40 } });
      const img = (f) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
      await c.setContent(`<body style="margin:0;background:#888;display:flex;gap:24px;font:13px system-ui;color:#fff"><figure style="margin:0"><figcaption>ours · ${name}</figcaption><img src="${img(file)}" style="width:${w}px;height:${h}px"></figure><figure style="margin:0"><figcaption>mock · ${path.basename(mock)}</figcaption><img src="${img(mock)}" style="width:${w}px;height:${h}px;object-fit:cover;object-position:right bottom"></figure></body>`);
      await c.screenshot({ path: path.join(opts.out, 'compare', `${name}.png`) });
      await c.close();
    }
    const r = report[name];
    const bad = r.contrast.length + r.marks.length + (r.accentGroups > 1 ? 1 : 0) + r.offGridCount + r.outside.length + r.smallHitBoxes;
    console.log(`${bad ? 'FAIL' : 'ok  '} ${name}: ${r.checked} texts, contrast ${r.contrast.length}, marks ${r.marks.length}, accent ${r.accentGroups}, off-grid ${r.offGridCount}, outside ${r.outside.length}, small hit boxes ${r.smallHitBoxes}`);
  }
}

// Colour-blind simulations of the board: the four states must stay apart by shape.
if (!opts.only || opts.only.split(',').includes('manager')) {
  const M = {
    protanopia: '0.567 0.433 0 0 0 0.558 0.442 0 0 0 0 0.242 0.758 0 0 0 0 0 1 0',
    deuteranopia: '0.625 0.375 0 0 0 0.7 0.3 0 0 0 0 0.3 0.7 0 0 0 0 0 1 0',
    tritanopia: '0.95 0.05 0 0 0 0 0.433 0.567 0 0 0 0.475 0.525 0 0 0 0 0 1 0',
  };
  for (const [kind, matrix] of Object.entries(M)) {
    const p = await open('surface=tasks&theme=dark', 1440, 900);
    await p.addStyleTag({ content: 'html { filter: url(#cvd); }' });
    await p.evaluate((m) => document.body.insertAdjacentHTML('beforeend', `<svg width="0" height="0" style="position:absolute"><filter id="cvd"><feColorMatrix type="matrix" values="${m}"/></filter></svg>`), matrix);
    await p.waitForTimeout(100);
    await p.screenshot({ path: path.join(opts.out, 'cvd', `manager-${kind}.png`) });
    await p.close();
  }
}

// Motion (--video): an approval arriving, a toast, a /discuss turn moving on. Reduced motion off.
if (opts.video) {
  const clip = async (name, query, act, width = 1280, height = 800) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-clip-'));
    const ctx = await browser.newContext({ viewport: { width, height }, recordVideo: { dir, size: { width, height } } });
    const p = await ctx.newPage();
    await p.goto(`${base}/?${query}`);
    await p.waitForSelector('#root > *');
    await act(p);
    await p.waitForTimeout(1200);
    const v = p.video();
    await ctx.close();
    fs.copyFileSync(await v.path(), path.join(opts.out, 'clips', `${name}.webm`));
    fs.rmSync(dir, { recursive: true, force: true });
  };
  await clip('approval-appear', 'surface=chat&theme=dark&fixture=approvals', async (p) => {
    await p.waitForTimeout(300);
    // A new request arrives: the snapshot again with its newest card re-keyed, so it mounts and rises.
    await p.evaluate(() => document.querySelectorAll('.apv[data-enter]').forEach((e) => { e.style.animation = 'none'; void e.offsetWidth; e.style.animation = ''; }));
  });
  await clip('toast', 'surface=tasks&theme=dark&fixture=images&view=images', async (p) => {
    await p.waitForTimeout(500);
    await p.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+Backspace' : 'Control+Shift+Backspace');
  });
  await clip('discuss-turn', 'surface=chat&theme=dark&fixture=discuss&select=chat-main', async (p) => {
    await p.waitForTimeout(500);
    await p.evaluate(() => window.postMessage({ type: 'action', action: { t: 'discussion', id: 'discuss-1', patch: { speaking: 'claude', round: 3 } } }, '*'));
  });
}

fs.writeFileSync(path.join(opts.out, 'gates.json'), `${JSON.stringify(report, null, 1)}\n`);
await browser.close();
server.kill();
const failing = Object.entries(report).filter(([, r]) => r.contrast.length + r.marks.length + (r.accentGroups > 1 ? 1 : 0) + r.offGridCount + r.outside.length + r.smallHitBoxes);
console.log(`\n${Object.keys(report).length} renders, ${failing.length} with gate failures → ${path.join(opts.out, 'gates.json')}`);
process.exitCode = failing.length ? 1 : 0;
