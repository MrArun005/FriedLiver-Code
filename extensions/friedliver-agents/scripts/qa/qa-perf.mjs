#!/usr/bin/env node
/* global Event, PerformanceObserver, performance, requestAnimationFrame -- used inside page.evaluate */
// QA: costs that grow with a long transcript (qa-fixtures.mjs longFixture). Not shipped.
//   PW_CHANNEL=chrome node scripts/qa/qa-perf.mjs [--base http://127.0.0.1:5199] [--turns 500]
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { longFixture } from './qa-fixtures.mjs';

const { values: opts } = parseArgs({ options: { base: { type: 'string', default: 'http://127.0.0.1:5199' }, turns: { type: 'string', default: '500' } } });
const turns = Number(opts.turns);
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome', args: ['--use-mock-keychain', '--password-store=basic'] });
const p = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await p.goto(`${opts.base}/?surface=chat&theme=dark-2026&select=chat-c5`);
await p.waitForSelector('#root > *');
const a = longFixture(turns);
const b = longFixture(turns);
b.chats[0] = { ...b.chats[0], id: 'chat-long-2', title: 'Second long chat' };
const state = { chats: [...a.chats, ...b.chats], images: [], links: [] };
await p.evaluate((s) => window.postMessage({ type: 'snapshot', state: s, selected: 'chat-long', now: Date.now() }, '*'), state);
// The transcript draws its latest turns (QA F03 windowing); older ones come as you scroll up.
await p.waitForFunction((n) => document.querySelectorAll('.user-msg').length >= Math.min(n, 25), turns, { timeout: 120000 });
await p.waitForTimeout(300);

const r = await p.evaluate(async () => {
  const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
  const out = {};
  const t = document.querySelector('.transcript');
  // The transcript's scroll handler, synchronously (it reads every .user-msg's box).
  t.scrollTop = t.scrollHeight / 2;
  let s = performance.now();
  for (let n = 0; n < 20; n++) {
    t.scrollTop -= 50;
    t.dispatchEvent(new Event('scroll'));
  }
  out.scrollHandlerMsEach = +((performance.now() - s) / 20).toFixed(2);
  // A new user message appended (what Send does once the host echoes it).
  s = performance.now();
  window.postMessage({ type: 'action', action: { t: 'items', chatId: 'chat-long', items: [{ kind: 'user', text: 'one more', images: [] }], at: Date.now() } }, '*');
  await frame();
  out.appendMessageMs = +(performance.now() - s).toFixed(1);
  // 50 streamed chunks, as an agent streams a reply.
  window.postMessage({ type: 'action', action: { t: 'busy', chatId: 'chat-long', busy: true } }, '*');
  await frame();
  s = performance.now();
  for (let n = 0; n < 50; n++) {
    window.postMessage({ type: 'action', action: { t: 'update', chatId: 'chat-long', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `word${n} ` } } } }, '*');
    await frame();
  }
  out.streamChunkMsAvg = +((performance.now() - s) / 50).toFixed(1);
  // Switching to the other long chat's tab and back.
  s = performance.now();
  document.querySelector('.tab[data-chat="chat-long-2"]')?.click();
  await frame();
  await frame();
  out.switchTabMs = +(performance.now() - s).toFixed(1);
  out.domNodes = document.querySelectorAll('*').length;
  return out;
});
// Long tasks during a real wheel scroll.
await p.evaluate(() => {
  window.__long = [];
  new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: false });
});
await p.mouse.move(600, 400);
for (let n = 0; n < 40; n++) {
  await p.mouse.wheel(0, -600);
  await p.waitForTimeout(16);
}
await p.waitForTimeout(200);
r.longTasksDuringWheel = await p.evaluate(() => window.__long);
// Other agents streaming in background chats while this one is open (memo checks).
r.backgroundStreamMsAvg = await p.evaluate(async () => {
  const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
  const s = performance.now();
  for (let n = 0; n < 50; n++) {
    window.postMessage({ type: 'action', action: { t: 'update', chatId: 'chat-long', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x ' } } } }, '*');
    await frame();
  }
  return +((performance.now() - s) / 50).toFixed(1);
});
console.log(JSON.stringify({ turns, ...r }));
await browser.close();
