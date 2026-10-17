#!/usr/bin/env node
/* global performance, requestAnimationFrame, Event, getComputedStyle -- used inside page.evaluate */
// Regression checks for the QA findings (~/code/FriedLiver-Code-design/qa/QA-REPORT.md),
// one block per finding id, each written to fail before its fix. Runs the UI
// harness server, Dark 2026, headless Chrome. Not shipped.
//
//   PW_CHANNEL=chrome node scripts/ui-regress.mjs [--no-build] [--only F01,F02] [--perf]

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { freshChat, longFixture, questionItem } from './qa/qa-fixtures.mjs';

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts } = parseArgs({
  options: {
    'no-build': { type: 'boolean', default: false },
    only: { type: 'string' },
    port: { type: 'string', default: '5231' },
    axe: { type: 'string', default: path.join(os.homedir(), 'shoe-resell/node_modules/axe-core/axe.min.js') },
  },
});
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

const problems = [];
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
};
async function open(query, width = 1200, height = 900) {
  const p = await browser.newPage({ viewport: { width, height } });
  p.on('pageerror', (e) => problems.push(`${query}: ${e.message}`));
  await p.goto(`${base}/?${query}`);
  await p.waitForSelector('#root > *');
  await p.evaluate(() => document.fonts.ready);
  return p;
}
const posted = (p) => p.evaluate(() => window.__posted.filter((m) => m.type !== 'ready'));
/** Replaces the page's state as the host would, with a snapshot. */
const snapshot = (p, state, selected) => p.evaluate(([s, sel]) => window.postMessage({ type: 'snapshot', state: s, selected: sel, now: Date.now() }, '*'), [state, selected]);
const fixtureState = (p) => p.evaluate(() => window.__snapshotState);
async function axe(p, selector) {
  if (!fs.existsSync(opts.axe)) return null;
  await p.addScriptTag({ path: opts.axe });
  return p.evaluate(async (sel) => (await window.axe.run(document.querySelector(sel) ?? document, { resultTypes: ['violations'], rules: { region: { enabled: false } } })).violations.map((v) => `${v.id} (${v.impact})`), selector);
}

const BLOCKS = {};
const only = opts.only ? new Set(opts.only.split(',')) : null;
const run = async () => {
  for (const [id, fn] of Object.entries(BLOCKS)) {
    if (only && !only.has(id)) continue;
    console.log(`${id}:`);
    try {
      await fn();
    } catch (err) {
      check(false, `${id} threw: ${err.message.split('\n')[0]}`);
    }
  }
};

// ---- F01: nothing scrolls the document; the tab bar and header never leave the screen ----
BLOCKS.F01 = async () => {
  for (const width of [1200, 640]) {
    const p = await open('surface=chat&theme=dark-2026&select=chat-c1', width, 800);
    const tall = () => p.evaluate(() => ({ doc: document.documentElement.scrollHeight, view: window.innerHeight, y: window.scrollY }));
    let d = await tall();
    check(d.doc <= d.view, `at ${width}px the document is no taller than the view (${d.doc} vs ${d.view})`);
    // Notification Open: reveal a decision, as the host does.
    await p.evaluate(() => window.postMessage({ type: 'reveal', id: 'perm-c1' }, '*'));
    await p.waitForTimeout(300);
    d = await tall();
    const tabs = await p.evaluate(() => document.querySelector('.switcher').getBoundingClientRect().top);
    check(d.y === 0 && tabs >= 0, `at ${width}px revealing a decision leaves the tab bar in place (scrollY ${d.y}, tabs at ${tabs})`);
    await p.close();
  }
};

// ---- F02: decision keys act on one card, the one that shows the hint ----
BLOCKS.F02 = async () => {
  // chat-c1 waits on two things: an agent's request to message another chat, then an edit permission.
  const p = await open('surface=chat&theme=dark-2026&select=chat-c1', 1200, 900);
  const hinted = () => p.locator('.ask:has(.hint.keys)').evaluateAll((cs) => cs.map((c) => c.id));
  check(JSON.stringify(await hinted()) === JSON.stringify(['item-perm-c1']), `only the nearest waiting card shows the key hint [${await hinted()}]`);
  await p.click('.composer textarea');
  await p.keyboard.press('1');
  let last = (await posted(p)).at(-1);
  check(last?.type === 'permission' && last.requestId === 'perm-c1' && (await p.inputValue('.composer textarea')) === '', `1 picks the hinted card's first option and types nothing [${JSON.stringify(last)}]`);
  // Out of range: still nothing typed while a decision waits.
  await p.keyboard.press('9');
  check((await p.inputValue('.composer textarea')) === '', 'a digit is never typed into the empty composer while a decision waits');
  // Choosing the other card moves the keys and the hint to it.
  await p.click('#item-bridge-c1 .ask-head');
  check(JSON.stringify(await hinted()) === JSON.stringify(['item-bridge-c1']), 'clicking a card makes it the one the keys act on');
  await p.click('.composer textarea');
  await p.keyboard.press('ControlOrMeta+Enter');
  last = (await posted(p)).at(-1);
  check(last?.type === 'bridge' && last.requestId === 'bridge-c1' && last.answer === 'allow', `Ctrl/Cmd+Enter answers the chosen card [${JSON.stringify(last)}]`);
  check((await p.locator('#item-bridge-c1 .opt-num').count()) === 3, 'the request card numbers its options too');
  await p.close();
};

await run();
await browser.close();
server.kill();
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
  process.exitCode = 1;
}
export { axe, fixtureState, freshChat, longFixture, posted, questionItem, snapshot };
