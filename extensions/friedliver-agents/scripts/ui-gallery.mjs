#!/usr/bin/env node
// The living component gallery: every component in src/webview/ui × variant × size × state
// (scripts/ui-gallery-page.tsx), drawn with tokens.css + components.css only, in Dark 2026, Light 2026
// and High Contrast (test/fixtures/theme-*.css). Hover, active and focus are real CSS states, forced
// over CDP on the elements the page marks data-force (data-force-target: a descendant instead).
// Headless Chrome; nothing ships (scripts/ is not packaged).
//
//   node scripts/ui-gallery.mjs [--out ~/code/FriedLiver-Code-design/components] [--width 1440] [--themes dark,light,hc]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as esbuild from 'esbuild';

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts } = parseArgs({
  options: {
    out: { type: 'string', default: path.join(os.homedir(), 'code/FriedLiver-Code-design/components') },
    width: { type: 'string', default: '1440' },
    themes: { type: 'string', default: 'dark,light,hc' },
  },
});
const THEMES = {
  dark: { fixture: 'theme-dark-2026.css', body: 'vscode-dark', name: 'Dark 2026' },
  light: { fixture: 'theme-light-2026.css', body: 'vscode-light', name: 'Light 2026' },
  hc: { fixture: 'theme-hc-dark.css', body: 'vscode-dark vscode-high-contrast', name: 'Dark High Contrast' },
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-gallery-'));
await esbuild.build({
  entryPoints: [path.join(ext, 'scripts/ui-gallery-page.tsx')],
  outfile: path.join(work, 'gallery.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  absWorkingDir: ext,
  nodePaths: [path.join(ext, 'node_modules')],
  alias: { '@friedliver/main': path.resolve(ext, '../../agent-core/main') },
  logLevel: 'warning',
});
for (const f of ['tokens.css', 'components.css']) fs.copyFileSync(path.join(ext, 'media', f), path.join(work, f));

// The gallery's own layout (not a component): full width, sections, a state grid.
const PAGE_CSS = `
body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--font); font-size: var(--fs); line-height: 1.5; -webkit-font-smoothing: antialiased; }
.g { padding: 24px 32px 48px; display: flex; flex-direction: column; gap: 28px; }
.g-top { display: flex; align-items: baseline; gap: 16px; }
.g-top h1 { margin: 0; font-size: 20px; font-weight: 600; }
.g-section { display: flex; flex-direction: column; gap: 14px; padding-top: 20px; border-top: 1px solid var(--border); }
.g-h { margin: 0; font-size: 14px; font-weight: 600; display: flex; gap: 12px; align-items: baseline; }
.g-note { font-size: 12px; font-weight: 400; color: var(--fg-2); }
.g-matrix { display: grid; gap: 10px 16px; align-items: center; }
.g-col { font-size: 11px; color: var(--fg-2); }
.g-row { font-size: 12px; color: var(--fg-2); }
.g-cell { display: flex; align-items: center; min-width: 0; }
.g-line { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.g-top-align { align-items: flex-start; }
.g-stack { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.g-grow { flex: 1; }
.g-cols2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; align-items: start; }
.g-cols3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; align-items: start; }
.g-radios { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.g-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg-2); }
.g-static { position: relative !important; inset: auto !important; transform: none !important; animation: none !important; }
.g-contents { display: contents; }
.g-show { opacity: 1 !important; }
.g-paused * { animation-play-state: paused !important; animation-delay: -3s !important; }
.g-mid::after { animation-play-state: paused !important; animation-delay: -300ms !important; }
.g-overlay { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 24px; align-items: end; padding: 32px; border-radius: 8px; background: var(--overlay); }
.g-sheet { border-radius: var(--r-12) var(--r-12) 0 0; }
.composer textarea { width: 100%; }
.spacer { flex: 1; }
`;

const { chromium } = await import('playwright');
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome', args: ['--use-mock-keychain', '--password-store=basic'] });
fs.mkdirSync(opts.out, { recursive: true });
for (const key of opts.themes.split(',')) {
  const t = THEMES[key];
  const theme = fs.readFileSync(path.join(ext, 'test/fixtures', t.fixture), 'utf8');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Components · ${t.name}</title>
<style>${theme}</style><link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="components.css"><style>${PAGE_CSS}</style>
<script>window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });</script></head>
<body class="${t.body}" data-theme-name="${t.name}"><div id="root"></div><script src="gallery.js"></script></body></html>`;
  const file = path.join(work, `${key}.html`);
  fs.writeFileSync(file, html);
  const page = await browser.newPage({ viewport: { width: Number(opts.width), height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(pathToFileURL(file).href);
  await page.waitForSelector('.g');
  // Force the marked states with DevTools' own pseudo-state forcing.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const marked = await page.$$eval('[data-force]', (els) =>
    els.map((el, i) => {
      el.setAttribute('data-force-id', String(i));
      const target = el.dataset.forceTarget ? el.querySelector(el.dataset.forceTarget) : el;
      target?.setAttribute('data-force-at', String(i));
      // The composer's focused state: its textarea is focused inside it.
      if (el.dataset.force === 'focus-within') target?.querySelector('textarea')?.setAttribute('data-force-at', `${i}t`);
      return { i, states: el.dataset.force.split(' ') };
    }),
  );
  for (const { i, states } of marked) {
    for (const [sel, forced] of [
      [`[data-force-at="${i}"]`, states],
      [`[data-force-at="${i}t"]`, ['focus', 'focus-visible']],
    ]) {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
      if (nodeId) await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: forced });
    }
  }
  await page.waitForTimeout(400);
  const out = path.join(opts.out, `gallery-${key}.png`);
  await page.screenshot({ path: out, fullPage: true });
  console.log(`${path.relative(process.cwd(), out)}${errors.length ? `  errors: ${errors.join(' | ')}` : ''}`);
  await page.close();
}
await browser.close();
fs.rmSync(work, { recursive: true, force: true });
