#!/usr/bin/env node
// QA helper: screenshot one harness page, optionally after a few Playwright steps.
//   node scripts/qa/shot.mjs '<query>' out.png [width] [height] ['js steps: async (p) => {...}']
// Needs the harness serving: node scripts/ui-harness.mjs --serve --no-build --port 5199
import { chromium } from 'playwright';
const [query, out, w = '1200', h = '800', steps] = process.argv.slice(2);
const base = process.env.QA_BASE ?? 'http://127.0.0.1:5199';
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome', args: ['--use-mock-keychain', '--password-store=basic'] });
const p = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await p.goto(`${base}/?${query}`);
await p.waitForSelector('#root > *');
await p.waitForTimeout(150);
if (steps) await (0, eval)(steps)(p);
await p.screenshot({ path: out, animations: 'disabled', caret: 'hide' });
if (errs.length) console.log('ERRORS:', errs.join('\n'));
await browser.close();
