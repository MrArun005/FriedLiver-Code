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
    const images = sizes.map(([w, h], n) => {
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

const STATES = {
  composer: async (p) => p.click('.composer textarea'),
  'model-menu': async (p) => p.click('.cc-model'),
  'modes-menu': async (p) => p.click('.cc-mode'),
  'slash-menu': async (p) => p.click('.cc-slash-btn'),
  'agent-map': async (p) => p.click('.cc-agents'),
  transcript: async (p) => {
    await p.click('.tl-step:has(.step-verb:text-is("Bash")) .step-main');
    await p.evaluate(() => document.activeElement?.blur());
  },
};

const shots = [];
for (const width of [1200, 640]) {
  for (const [state, act] of Object.entries(STATES)) {
    if (opts.only && !opts.only.split(',').includes(state)) continue;
    const { page, problems } = await open(width);
    await act(page);
    await page.waitForTimeout(250);
    const file = path.join(opts.out, `ours-${state}-${width}.png`);
    await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
    shots.push({ state, width, file });
    if (problems.length) console.error(`${state} @${width}: ${problems.join('; ')}`);
    await page.close();
  }
}
console.log(shots.map((s) => path.relative(opts.out, s.file)).join('\n'));
await browser.close();
server.kill();
