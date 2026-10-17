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
import { fixture } from './ui-fixture.mjs';

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

// ---- F02 + security: the keys act on the one marked card; arrivals never take it over ----
const GRACE = 650;
BLOCKS.F02 = async () => {
  // chat-c1 waits on two things: an agent's request to message another chat (older), then an edit permission.
  const p = await open('surface=chat&theme=dark-2026&select=chat-c1', 1200, 900);
  const hinted = () => p.locator('.ask:has(.hint.keys[data-on])').evaluateAll((cs) => cs.map((c) => c.id));
  check(JSON.stringify(await hinted()) === JSON.stringify(['item-bridge-c1']), `only the oldest waiting card is marked [${await hinted()}]`);
  const outline = await p.locator('#item-bridge-c1').evaluate((c) => window.getComputedStyle(c).outlineStyle);
  check(outline === 'solid', 'the marked card has a visible outline');
  await p.click('.composer textarea');
  await p.waitForTimeout(GRACE);
  await p.keyboard.press('1');
  let last = (await posted(p)).at(-1);
  check(last?.type === 'bridge' && last.answer === 'allow' && (await p.inputValue('.composer textarea')) === '', `1 picks the marked card's first option and types nothing [${JSON.stringify(last)}]`);
  await p.keyboard.press('9');
  check((await p.inputValue('.composer textarea')) === '', 'a digit is never typed into the empty composer while a decision waits');
  // Choosing the other card moves the keys and the mark, after the grace period.
  const before = (await posted(p)).length;
  await p.click('#item-perm-c1 .ask-head');
  check(JSON.stringify(await hinted()) === JSON.stringify(['item-perm-c1']), 'clicking a card marks it');
  await p.click('.composer textarea');
  await p.keyboard.press('ControlOrMeta+Enter');
  check((await posted(p)).length === before, 'a shortcut right after the mark moved does nothing');
  await p.waitForTimeout(GRACE);
  await p.keyboard.press('ControlOrMeta+Enter');
  last = (await posted(p)).at(-1);
  check(last?.type === 'permission' && last.requestId === 'perm-c1', `after the grace period Ctrl/Cmd+Enter answers the marked card [${JSON.stringify(last)}]`);
  check((await p.locator('#item-bridge-c1 .opt-num').count()) === 3, 'the request card numbers its options too');
  await p.close();
  // A new request that arrives just before the keypress never takes the keys.
  const q = await open('surface=chat&theme=dark-2026&select=chat-c2', 1200, 900);
  await q.click('.composer textarea');
  await q.waitForTimeout(GRACE);
  await q.evaluate(() => window.postMessage({ type: 'action', action: { t: 'items', chatId: 'chat-c2', items: [{ kind: 'command', commandId: 'cmd-new', commandLine: 'rm -rf build', cwd: '/w', state: 'awaiting' }] } }, '*'));
  await q.keyboard.press('1');
  last = (await posted(q)).at(-1);
  check(last?.type === 'permission' && last.requestId === 'perm-c2', `1 pressed as a new request arrives applies to the card already marked [${JSON.stringify(last)}]`);
  check(JSON.stringify(await q.locator('.ask:has(.hint.keys[data-on])').evaluateAll((cs) => cs.map((c) => c.id))) === JSON.stringify(['item-perm-c2']), 'the new request is not marked');
  await q.close();
  // Each chat keeps its own mark.
  const r = await open('surface=chat&theme=dark-2026&select=chat-c1', 1200, 900);
  await r.click('#item-perm-c1 .ask-head');
  await r.evaluate(() => window.postMessage({ type: 'select', chatId: 'chat-c2' }, '*'));
  await r.waitForTimeout(200);
  check(JSON.stringify(await r.locator('.ask:has(.hint.keys[data-on])').evaluateAll((cs) => cs.map((c) => c.id))) === JSON.stringify(['item-perm-c2']), 'another chat keeps its own marked card');
  await r.close();
};

// ---- F09: a question's options are numbered, with their descriptions and the key hint ----
BLOCKS.F09 = async () => {
  const p = await open('surface=chat&theme=dark-2026&select=chat-c5', 1200, 900);
  const state = fixture(Date.now()).state;
  const c5 = state.chats.find((c) => c.id === 'chat-c5');
  c5.items = [...c5.items, questionItem()];
  await snapshot(p, state, 'chat-c5');
  await p.waitForSelector('#item-q-1');
  const opts = await p.locator('#item-q-1 .actions button').evaluateAll((bs) => bs.map((b) => b.innerText.replace(/\s+/g, ' ').trim()));
  check(opts[0]?.startsWith('1. Redis') && opts[0].includes('Shared across instances; needs a Redis server') && opts[2]?.startsWith('3. In memory'), `options are numbered with their descriptions [${opts.slice(0, 3).join(' | ')}]`);
  check(await p.locator('#item-q-1 .hint.keys[data-on]').isVisible(), 'the question shows the key hint');
  await p.click('.composer textarea');
  await p.waitForTimeout(GRACE);
  await p.keyboard.press('2');
  const last = (await posted(p)).at(-1);
  check(last?.type === 'answerQuestion' && last.values?.store === 'sqlite', `2 answers with the second option [${JSON.stringify(last)}]`);
  await p.close();
};

// ---- F04 / F05: a newly opened tab scrolls into view; the strip is a real tablist ----
BLOCKS.F04 = async () => {
  const p = await open('surface=chat&theme=dark-2026&select=chat-c5', 640, 800);
  // Open a chat that has no tab yet, as the list or a notification does.
  const ids = await p.locator('.tabs [role="tab"]').evaluateAll((ts) => ts.map((t) => t.dataset.chat));
  const outside = fixture(Date.now()).state.chats.find((c) => !c.archived && !ids.includes(c.id)).id;
  await p.evaluate((id) => window.postMessage({ type: 'select', chatId: id }, '*'), outside);
  await p.waitForTimeout(400);
  const r = await p.evaluate((id) => {
    const t = document.querySelector(`.tabs [data-chat="${id}"]`)?.getBoundingClientRect();
    const s = document.querySelector('.tabs').getBoundingClientRect();
    return t && { inView: t.left >= s.left - 1 && t.right <= s.right + 1, t: [Math.round(t.left), Math.round(t.right)], s: [Math.round(s.left), Math.round(s.right)] };
  }, outside);
  check(!!r?.inView, `a chat opened from outside the strip shows its new tab in view ${JSON.stringify(r)}`);
  await p.close();
};
BLOCKS.F05 = async () => {
  const p = await open('surface=chat&theme=dark-2026&select=chat-c5', 1200, 800);
  const tab = p.locator('.tabs [role="tab"][aria-selected="true"]');
  await tab.focus();
  const order = await p.locator('.tabs [role="tab"]').evaluateAll((ts) => ts.map((t) => t.dataset.chat));
  const at = order.indexOf('chat-c5');
  await p.keyboard.press('ArrowRight');
  const focused = await p.evaluate(() => document.activeElement?.dataset?.chat);
  check(focused === order[(at + 1) % order.length], `ArrowRight moves to the next tab [${focused}]`);
  await p.keyboard.press('Home');
  check((await p.evaluate(() => document.activeElement?.dataset?.chat)) === order[0], 'Home goes to the first tab');
  await p.keyboard.press('End');
  check((await p.evaluate(() => document.activeElement?.dataset?.chat)) === order.at(-1), 'End goes to the last tab');
  const stops = await p.evaluate(() => [...document.querySelectorAll('.tabs [tabindex], .tabs button')].filter((e) => e.tabIndex >= 0).length);
  check(stops === 1, `the strip is one Tab stop (roving tabindex), not ${stops}`);
  const last = order.at(-1);
  await p.keyboard.press('Delete');
  check(!(await p.locator('.tabs [role="tab"]').evaluateAll((ts) => ts.map((t) => t.dataset.chat))).includes(last), 'Delete closes the focused tab');
  check((await p.locator('.tabs [role="tab"]').first().getAttribute('aria-keyshortcuts')) === 'Delete', 'tabs announce Delete as their close key');
  const v = await axe(p, '.switcher');
  check(v === null || !v.length, `axe finds nothing in the tab strip [${v ?? 'axe-core not found'}]`);
  await p.close();
};

// ---- F03: a long chat stays instant: stable keys, a window of the transcript, no remount at the cap ----
const PERF = {};
BLOCKS.F03 = async () => {
  const p = await open('surface=chat&theme=dark-2026&select=chat-c5', 1200, 900);
  const long = longFixture(500); // 2,000 items: the cap
  // Open: from the snapshot to the transcript laid out.
  PERF.openMs = await p.evaluate(async (state) => {
    const t0 = performance.now();
    window.postMessage({ type: 'snapshot', state, selected: 'chat-long', now: Date.now() }, '*');
    await new Promise((res) => {
      const mo = new MutationObserver(() => document.querySelector('.user-msg') && (mo.disconnect(), res()));
      mo.observe(document.body, { childList: true, subtree: true });
    });
    void document.querySelector('.transcript').scrollHeight;
    return +(performance.now() - t0).toFixed(1);
  }, long);
  await p.waitForTimeout(300);
  /** One appended item at the cap, as the host sends it: from the message to the transcript laid out again. */
  const append = (n) =>
    p.evaluate(async (n) => {
      const t = document.querySelector('.transcript');
      const kept = t.querySelector('.user-msg:last-of-type') ?? t.lastElementChild;
      kept.__mark = true;
      const t0 = performance.now();
      window.postMessage({ type: 'action', action: { t: 'items', chatId: 'chat-long', items: [{ kind: 'agent', text: `More ${n}.` }], at: Date.now() } }, '*');
      await new Promise((res) => {
        const mo = new MutationObserver(() => (mo.disconnect(), res()));
        mo.observe(t, { childList: true, subtree: true, characterData: true });
      });
      void t.scrollHeight;
      return { ms: performance.now() - t0, kept: kept.isConnected && kept.__mark === true };
    }, n);
  const runs = [];
  for (let n = 0; n < 7; n++) runs.push(await append(n));
  const ms = runs.map((r) => r.ms).sort((a, b) => a - b);
  PERF.appendMedianMs = +ms[3].toFixed(1);
  PERF.appendMaxMs = +ms.at(-1).toFixed(1);
  PERF.domNodes = await p.evaluate(() => document.querySelectorAll('*').length);
  check(runs.every((r) => r.kept), 'items already on screen are kept, not remounted, when an item arrives at the cap');
  check(PERF.appendMedianMs < 16, `an appended item at 2,000 items costs < 16 ms (median ${PERF.appendMedianMs} ms, max ${PERF.appendMaxMs} ms)`);
  check(PERF.openMs < 150, `a 2,000-item chat opens in < 150 ms (${PERF.openMs} ms)`);
  check(PERF.domNodes < 8000, `the transcript keeps a window, not every item, in the page (${PERF.domNodes} nodes)`);
  // Scrolled to the top, earlier items come in.
  const before = await p.locator('.user-msg').count();
  for (let n = 0; n < 6; n++) {
    await p.evaluate(() => (document.querySelector('.transcript').scrollTop = 0));
    await p.waitForTimeout(150);
  }
  check((await p.locator('.user-msg').count()) > before, 'scrolling up brings earlier items in');
  console.log(`  perf ${JSON.stringify(PERF)}`);
  await p.close();
};

// ---- F06: one status palette everywhere: working blue, done green, problem red, needs you the accent ----
BLOCKS.F06 = async () => {
  const tone = (p, v) => p.evaluate((v) => {
    const d = document.createElement('div');
    d.style.color = `var(${v})`;
    document.body.append(d);
    const c = window.getComputedStyle(d).color;
    d.remove();
    return c;
  }, v);
  const bg = (p, sel, pseudo) => p.locator(sel).first().evaluate((el, ps) => window.getComputedStyle(el, ps).backgroundColor, pseudo);
  // Chat: a running subagent's timeline dot, a finished one's, and the agents pill; the agent map's rows.
  const c = await open('surface=chat&theme=dark-2026&select=chat-pay&fixture=subagents', 1200, 900);
  const W = await tone(c, '--status-working'), D = await tone(c, '--status-done'), N = await tone(c, '--status-waiting'), E = await tone(c, '--status-failed');
  check(new Set([W, D, N, E]).size === 4, `four distinct status colours [${W} ${D} ${N} ${E}]`);
  check((await bg(c, '.tl.sa-card[data-state="working"]', '::before')) === W, 'a running subagent in the transcript is the working colour');
  check((await bg(c, '.tl.sa-card[data-state="done"]', '::before')) === D, 'a finished subagent in the transcript is the done colour');
  check((await bg(c, '.cc-agents .dot')) === W, 'the agents pill (agents running) is the working colour');
  await c.click('.cc-agents');
  check((await bg(c, '.cc-map-children .dot[data-state="working"]')) === W, 'a running agent in the agent map is the working colour');
  check((await c.locator('.cc-map-children .dot[data-state="done"]').count()) > 0 && (await bg(c, '.cc-map-children .dot[data-state="done"]')) === D, 'a finished agent in the agent map is the done colour');
  await c.close();
  // Agent Manager: header counts and columns.
  const m = await open('surface=tasks&theme=dark-2026&view=board', 1440, 900);
  const W2 = await tone(m, '--status-working'), D2 = await tone(m, '--status-done'), N2 = await tone(m, '--status-waiting');
  check((await bg(m, '.mgr-counts .dot[data-state="working"]')) === W2 && (await bg(m, '.mgr-counts .dot[data-state="done"]')) === D2 && (await bg(m, '.mgr-counts .dot[data-state="needs-you"]')) === N2, 'the Manager counts use the same palette (working ≠ done)');
  check((await bg(m, '.seg-bar i[data-step="working"]')) !== (await bg(m, '.seg-bar i[data-step="done"]')), 'a plan’s step in progress differs from its done steps');
  await m.close();
  const map = await open('surface=tasks&theme=dark-2026&view=map', 1440, 900);
  const fill = await map.locator('.node-dot[data-state="working"]').first().evaluate((el) => window.getComputedStyle(el).fill);
  check(fill === (await tone(map, '--status-working')), 'a working chat on the map is the working colour');
  await map.close();
};

// ---- F07: one command list: the / button and a typed / show the same commands, FriedLiver's first ----
BLOCKS.F07 = async () => {
  const p = await open('surface=chat&theme=dark-2026&select=chat-c5', 1200, 900);
  await p.click('.cc-slash-btn');
  const button = await p.locator('.cc-slash-menu [role="menuitem"] .cc-item-name').evaluateAll((es) => es.map((e) => e.textContent.trim()).filter((t) => t.startsWith('/')));
  const more = await p.locator('.cc-slash-menu .cc-menu-list').evaluate((l) => ({ scrolls: l.scrollHeight > l.clientHeight, more: l.hasAttribute('data-more'), mask: window.getComputedStyle(l).maskImage }));
  await p.keyboard.press('Escape');
  await p.click('.composer textarea');
  await p.keyboard.type('/');
  const typed = await p.locator('.mention-menu [role="option"] .cc-item-name').evaluateAll((es) => es.map((e) => e.textContent.trim()));
  check(button.length > 4 && JSON.stringify(button) === JSON.stringify(typed), `the / button and a typed / list the same commands [${button.join(' ')}] vs [${typed.join(' ')}]`);
  check(['/handoff ‹agent›', '/ask ‹agent and question›', '/pipe ‹agent›', '/new ‹agent (optional)›'].every((c, n) => button[n] === c), `FriedLiver's commands come first, with their arguments [${button.slice(0, 4).join(' ')}]`);
  const descs = await p.locator('.mention-menu [role="option"] .cc-item-value').allInnerTexts();
  check(descs.every((d) => !/ · (agent|agent and question|agent \(optional\))$/.test(d)), 'descriptions no longer end in the argument word');
  check(!more.scrolls || (more.more && more.mask !== 'none'), `a list that scrolls says so with a fade at its end [${JSON.stringify(more)}]`);
  await p.close();
};

// ---- F08: attachment chips: click previews, a separate × removes (with Undo), names and contrast ----
BLOCKS.F08 = async () => {
  const p = await open('surface=chat&theme=dark-2026&select=chat-c5', 640, 900);
  await p.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 40;
    c.getContext('2d').fillRect(0, 0, 64, 40);
    const data = c.toDataURL('image/png').split(',')[1];
    const images = Array.from({ length: 6 }, (_, n) => ({ name: `screenshot-2026-10-17-at-14.0${n}.png`, mimeType: 'image/png', data }));
    window.postMessage({ type: 'attached', chatId: 'chat-c5', images }, '*');
  });
  await p.waitForSelector('.cc-chip');
  const count = () => p.locator('.cc-chip').count();
  check((await count()) === 6, 'six images attached');
  const name = await p.locator('.cc-chip .cc-chip-name').first().innerText();
  check(name.includes('…') && name.endsWith('14.00.png'), `a long name keeps its end [${name}]`);
  check(await p.locator('.cc-chips-count:has-text("6 images")').isVisible(), 'the row says how many images');
  const fade = await p.locator('.cc-chips').evaluate((r) => ({ over: r.scrollWidth > r.clientWidth, mask: window.getComputedStyle(r).maskImage }));
  check(!fade.over || fade.mask !== 'none', `the row fades at its edge when it scrolls [${JSON.stringify(fade)}]`);
  await p.locator('.cc-chip').first().click();
  check((await p.locator('[role="dialog"].image-preview img').count()) === 1 && (await count()) === 6, 'clicking a chip previews the image and keeps it');
  await p.keyboard.press('Escape');
  check((await p.locator('.image-preview').count()) === 0, 'Esc closes the preview');
  const x = p.locator('.cc-chip-remove').first();
  check(/^Remove screenshot-/.test((await x.getAttribute('aria-label')) ?? ''), 'the × is its own button, named Remove …');
  await x.click();
  check((await count()) === 5 && (await p.locator('.banner:has-text("Removed")').isVisible()), 'the × removes the image and offers Undo');
  await p.locator('.banner button:has-text("Undo")').click();
  check((await count()) === 6, 'Undo puts it back');
  const v = await axe(p, '.cc-chips');
  check(v === null || !v.some((x) => x.startsWith('color-contrast')), `the chips pass contrast [${v}]`);
  await p.close();
};

// ---- F10: "Starting…" only while a session really starts ----
BLOCKS.F10 = async () => {
  const p = await open('surface=chat&theme=dark-2026&fixture=steps', 1200, 800);
  const pill = (q) => q.locator('.cc-model').innerText();
  check(!/Starting/.test(await pill(p)), `a finished chat's model pill names the agent, not Starting… [${await pill(p)}]`);
  await p.close();
  const q = await open('surface=chat&theme=dark-2026&select=chat-c5', 1200, 800);
  const state = fixture(Date.now()).state;
  state.chats.push(freshChat('claude'));
  await snapshot(q, state, 'chat-new-claude');
  await q.waitForSelector('.chat-head-title:has-text("New chat")');
  const head = await q.locator('.status-pill').innerText();
  check(/Starting/.test(await pill(q)) && head === 'Starting', `a starting chat says Starting in its pill and its status [${await pill(q)} / ${head}]`);
  await q.close();
};

// ---- F11: the rules chip is a button that lists the rules files; chips cut with an ellipsis ----
BLOCKS.F11 = async () => {
  for (const width of [1200, 640]) {
    const p = await open('surface=chat&theme=dark-2026&select=chat-c5', width, 800);
    const state = fixture(Date.now()).state;
    const c5 = state.chats.find((c) => c.id === 'chat-c5');
    c5.branch = 'claude/explain-the-auth-middleware-and-session-store';
    c5.session = { ...c5.session, rules: ['/home/dev/inventory-app/AGENTS.md', '/home/dev/inventory-app/.friedliver/rules/style.md', '/home/dev/.friedliver/rules/global.md'] };
    await snapshot(p, state, 'chat-c5');
    const chip = p.locator('.chat-head .rules-chip');
    await chip.waitFor();
    check((await chip.evaluate((b) => b.tagName)) === 'BUTTON' && (await chip.getAttribute('aria-haspopup')) === 'menu', `at ${width}px the rules chip is a button with a menu`);
    await chip.focus();
    await p.keyboard.press('Enter');
    const files = await p.locator('.popover [role="menuitem"]').allInnerTexts();
    check(files.some((f) => f.includes('AGENTS.md')) && files.length >= 3, `at ${width}px it lists the rules files [${files.join(' | ')}]`);
    await p.locator('.popover [role="menuitem"]:has-text("AGENTS.md")').click();
    check((await posted(p)).some((m) => m.type === 'openFile' && m.path.endsWith('AGENTS.md')), `at ${width}px a file opens from it`);
    const cut = await p.evaluate(() => [...document.querySelectorAll('.chat-head .chip-text')].every((t) => window.getComputedStyle(t).textOverflow === 'ellipsis'));
    check(cut, `at ${width}px header chips cut with an ellipsis`);
    if (width === 640) check(await p.locator('.chat-head .branch-chip').evaluate((b) => window.getComputedStyle(b).display === 'none'), 'at 640px the branch chip gives its room to the title');
    await p.close();
  }
};

// ---- F12: the Copy reply button never covers the reply's text ----
BLOCKS.F12 = async () => {
  for (const width of [1200, 640]) {
    const p = await open('surface=chat&theme=dark-2026&select=chat-c5', width, 800);
    const state = fixture(Date.now()).state;
    const c5 = state.chats.find((c) => c.id === 'chat-c5');
    const words = 'The mode and the effort travel with the chat so a handoff keeps both of them as they were set. '.repeat(4);
    c5.items = [...c5.items, { kind: 'agent', at: Date.now(), text: words }];
    await snapshot(p, state, 'chat-c5');
    await p.waitForTimeout(200);
    const prose = p.locator('.prose').last();
    await prose.scrollIntoViewIfNeeded();
    await prose.hover();
    const hit = await prose.evaluate((el) => {
      const b = el.querySelector('.msg-tools .copy-btn').getBoundingClientRect();
      const w = document.createTreeWalker(el.querySelector('.md'), NodeFilter.SHOW_TEXT);
      const boxes = [];
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const r = document.createRange();
        r.selectNodeContents(n);
        boxes.push(...r.getClientRects());
      }
      return boxes.filter((t) => t.width && t.left < b.right && t.right > b.left && t.top < b.bottom && t.bottom > b.top).length;
    });
    check(hit === 0, `at ${width}px Copy reply covers no text [${hit} line boxes under it]`);
    await p.close();
  }
};

// ---- F13: a menu always fits in the window, scrolling inside when it's long ----
BLOCKS.F13 = async () => {
  const inside = async (p) =>
    (await p.waitForTimeout(300)) ||
    p.evaluate(() => {
      const m = document.querySelector('.popover');
      const r = m.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: window.innerHeight, scrolls: m.scrollHeight > m.clientHeight + 1 };
    });
  for (const [w, h] of [[1200, 900], [640, 520]]) {
    const p = await open('surface=tasks&theme=dark-2026&view=board', w, h);
    const card = p.locator('.task-card').nth(1);
    await card.hover();
    await card.locator('button[aria-label*="More"], .card-top button').last().click();
    const r = await inside(p);
    check(r.top >= 0 && r.bottom <= r.h, `board card ⋯ menu fits ${w}×${h} [${JSON.stringify(r)}]`);
    await p.close();
  }
  const p = await open('surface=chat&theme=dark-2026&select=chat-c5', 640, 520);
  const state = fixture(Date.now()).state;
  const base = state.chats.find((c) => c.id !== 'chat-c5');
  for (let i = 0; i < 30; i++) state.chats.push({ ...base, id: `extra-${i}`, title: `Extra chat ${i}`, items: [] });
  await snapshot(p, state, 'chat-c5');
  await p.click('.chat-head-actions button[aria-label^="More"]');
  const r = await inside(p);
  check(r.top >= 0 && r.bottom <= r.h && r.scrolls, `chat ⋯ menu with 30 more chats fits and scrolls [${JSON.stringify(r)}]`);
  await p.close();
};

// ---- F14: list group headers breathe; at 640 the task column gets the room ----
BLOCKS.F14 = async () => {
  for (const w of [1200, 640]) {
    const p = await open('surface=tasks&theme=dark-2026&view=list', w, 900);
    const gap = await p.locator('.group-row .col-count').first().evaluate((c) => {
      const r = document.createRange();
      r.selectNodeContents(c.previousSibling);
      return Math.round(c.getBoundingClientRect().left - r.getBoundingClientRect().right);
    });
    check(gap >= 6, `at ${w}px the count sits apart from its group name [${gap}px]`);
    if (w === 640) {
      const task = await p.locator('thead .c-task').evaluate((t) => Math.round(t.getBoundingClientRect().width));
      check(task >= 200, `at 640px the task column is wide enough to read [${task}px]`);
    }
    await p.close();
  }
};

// ---- F15: one set of mode names (the composer's) and one name for rewinding ----
BLOCKS.F15 = async () => {
  for (const w of [1200, 640]) {
    const p = await open('surface=tasks&theme=dark-2026&view=board', w, 900);
    const seg = (await p.locator('.approval-seg [role="radio"]').allInnerTexts()).map((t) => t.trim());
    check(JSON.stringify(seg) === JSON.stringify(['Manual', 'Edit automatically', 'Auto']), `at ${w}px the Manager's levels use the composer's names [${seg.join(' | ')}]`);
    const spill = await p.locator('.approval-seg').evaluate((s) => s.scrollWidth > s.clientWidth + 1 || [...s.children].some((c) => c.scrollWidth > c.clientWidth + 1));
    check(!spill, `at ${w}px the names fit their buttons`);
    await p.close();
  }
  const p = await open('surface=chat&theme=dark-2026&select=chat-c5', 1200, 800);
  await p.click('.chat-head-actions button[aria-label^="More"]');
  const more = await p.locator('.popover [role="menuitem"]').allInnerTexts();
  check(more.some((t) => t.trim() === 'Rewind…') && !more.some((t) => /Checkpoints/.test(t)), `the ⋯ menu says Rewind… [${more.map((t) => t.trim()).join(' | ')}]`);
  await p.keyboard.press('Escape');
  await p.click('.cc-slash-btn');
  const slash = await p.locator('.cc-slash-menu .cc-item-name').allInnerTexts();
  check(slash.includes('Rewind…'), `the / menu says Rewind… too [${slash.filter((t) => /rewind/i.test(t)).join(' | ')}]`);
  const auto = await p.evaluate(() => [...document.querySelectorAll('*')].some((e) => !e.children.length && /Full auto/.test(e.textContent ?? '')));
  check(!auto, 'no "Full auto" left on the page');
  await p.close();
};

// ---- F16: the Manager's model/effort pickers are our menus; the Light search box is visible ----
BLOCKS.F16 = async () => {
  const p = await open('surface=tasks&theme=dark-2026&view=board', 1200, 900);
  check(!(await p.locator('select').count()), 'no native <select> on the Manager');
  const pick = p.locator('.task-options button[aria-haspopup="menu"]').first();
  check((await pick.count()) === 1, 'the model picker is a menu button');
  if (await pick.count()) {
    await pick.click();
    const items = p.locator('.popover [role="menuitemradio"]');
    check((await items.count()) > 1 && (await p.locator('.popover [role="menuitemradio"][aria-checked="true"]').count()) === 1, 'it lists the choices with the current one checked');
    const want = (await items.nth(1).locator('.grow').innerText()).trim();
    await items.nth(1).click();
    const label = (await pick.innerText()).trim();
    check(label === want && !(await items.count()), `the button shows the new choice [${label}]`);
  }
  await p.close();
  const l = await open('surface=tasks&theme=light-2026&view=board', 1200, 900);
  const look = await l.locator('.mgr-head .search').evaluate((s) => {
    const cs = window.getComputedStyle(s);
    const page = window.getComputedStyle(document.body).backgroundColor;
    return { bg: cs.backgroundColor, page, border: cs.borderTopWidth + ' ' + cs.borderTopColor };
  });
  check(look.bg !== look.page || !look.border.startsWith('0px'), `Light 2026 search box stands out from the page [${JSON.stringify(look)}]`);
  check(!look.border.startsWith('0px'), 'and has a border');
  await l.close();
};

// ---- F17: the empty state centres its agents, cards line up, and recent chats can be reopened ----
BLOCKS.F17 = async () => {
  for (const w of [1200, 640]) {
    const p = await open('surface=chat&theme=dark-2026&empty=1', w, 800);
    const g = await p.evaluate(() => {
      const box = document.querySelector('.empty').getBoundingClientRect();
      const cards = [...document.querySelectorAll('.pick-agent')].map((c) => c.getBoundingClientRect());
      const glyphs = [...document.querySelectorAll('.pick-agent .glyph, .pick-agent svg')].map((c) => Math.round(c.getBoundingClientRect().top));
      return {
        left: Math.round(cards[0].left - box.left),
        right: Math.round(box.right - cards.at(-1).right),
        heights: [...new Set(cards.map((c) => Math.round(c.height)))],
        glyphs: [...new Set(glyphs)],
      };
    });
    check(Math.abs(g.left - g.right) <= 2, `at ${w}px the agent cards are centred [${g.left} | ${g.right}]`);
    check(g.heights.length === 1 && g.glyphs.length === 1, `at ${w}px the cards share one height and glyph line [${JSON.stringify(g)}]`);
    await p.close();
  }
  const p = await open('surface=chat&theme=dark-2026&select=chat-c5', 1200, 800);
  for (let i = 0; i < 40 && (await p.locator('.tab-close').count()); i++) await p.locator('.tab-close').first().click({ force: true });
  const rows = p.locator('.empty .reopen [data-chat]');
  check((await rows.count()) === 5, `with every tab closed, five recent chats are offered [${await rows.count()}]`);
  if (await rows.count()) {
    await rows.first().click();
    await p.waitForTimeout(200);
    const n = await p.locator('.tabs [role="tab"]').count();
    check(n === 1, `a recent chat reopens in a tab [${n} tabs; ${await p.locator('.empty').count()} empty]`);
  }
  await p.close();
};

// ---- F18: a fresh chat offers a few starters and the keys; they go with the first message ----
BLOCKS.F18 = async () => {
  for (const agent of ['claude', 'demo']) {
    const p = await open('surface=chat&theme=dark-2026&select=chat-c5', 1200, 800);
    const state = fixture(Date.now()).state;
    const fresh = freshChat(agent);
    state.chats.push(fresh);
    await snapshot(p, state, fresh.id);
    await p.waitForTimeout(150);
    const starters = (await p.locator('.starters button').allInnerTexts()).map((t) => t.trim());
    check(starters.length >= 3 && starters.length <= 4, `a fresh ${agent} chat offers 3–4 starters [${starters.join(' | ')}]`);
    const keys = await p.locator('.starters .starter-keys').innerText().catch(() => '');
    check(/@/.test(keys) && /\//.test(keys) && /(⇧|Shift\+)Tab/.test(keys), `and the keys [${keys}]`);
    if (starters.length) {
      await p.locator('.starters button').first().click();
      check((await p.inputValue('.composer textarea')) === starters[0], 'a starter goes into the composer to edit or send');
    }
    fresh.items = [{ kind: 'user', text: 'hello', images: [] }];
    await snapshot(p, state, fresh.id);
    await p.waitForTimeout(150);
    check(!(await p.locator('.starters').count()), 'the starters go with the first message');
    await p.close();
  }
};

// ---- F19: the transcript has no nested controls, and code that scrolls is reachable and shows it scrolls ----
BLOCKS.F19 = async () => {
  const p = await open('surface=chat&theme=dark-2026&select=chat-c5', 640, 800);
  const state = fixture(Date.now()).state;
  const c5 = state.chats.find((c) => c.id === 'chat-c5');
  c5.items = [...c5.items, { kind: 'agent', at: Date.now(), text: 'Run this:\n\n```ts\nexport const SESSION_STORE_CONNECTION_STRING = process.env.SESSION_STORE_URL ?? \'redis://localhost:6379/0?pool=16&timeout=2500\';\n```' }];
  await snapshot(p, state, 'chat-c5');
  await p.waitForTimeout(200);
  const pre = p.locator('pre.code').last();
  const info = await pre.evaluate((el) => ({ over: el.scrollWidth > el.clientWidth, tab: el.tabIndex, bg: window.getComputedStyle(el).backgroundImage, attach: window.getComputedStyle(el).backgroundAttachment }));
  check(info.over && info.tab === 0, `code that scrolls can be focused to scroll by keyboard [${JSON.stringify({ over: info.over, tab: info.tab })}]`);
  check(/gradient/.test(info.bg) && /local/.test(info.attach), `its right edge shades while there's more [${info.attach}]`);
  const v = await axe(p, '.transcript');
  if (v) check(!v.some((x) => /nested-interactive|scrollable-region-focusable/.test(x)), `axe: no nested controls or unreachable scrolling [${v.join(', ')}]`);
  await p.close();
};

// ---- F20: dragging the effort thumb previews and posts once, on release ----
BLOCKS.F20 = async () => {
  const p = await open('surface=chat&theme=dark-2026&select=chat-c5', 1200, 800);
  await p.click('.cc-model');
  const box = await p.locator('.cc-slider').boundingBox();
  await p.mouse.move(box.x + 2, box.y + box.height / 2);
  await p.mouse.down();
  for (let x = 0; x <= box.width; x += 6) await p.mouse.move(box.x + x, box.y + box.height / 2);
  const during = (await posted(p)).filter((m) => m.type === 'setOption').length;
  const label = await p.locator('.cc-slider').getAttribute('aria-valuetext');
  await p.mouse.up();
  const sent = (await posted(p)).filter((m) => m.type === 'setOption');
  check(during === 0 && sent.length === 1, `one setOption for a whole drag [${during} during, ${sent.length} after: ${sent.map((m) => m.value).join(',')}]`);
  check(sent[0]?.value && label && label.length > 0, `the thumb previews where it is while dragging [${label}]`);
  await p.close();
};

// ---- F21: in Light themes an off switch and the effort thumb read as off; Needs you passes contrast ----
BLOCKS.F21 = async () => {
  const p = await open('surface=chat&theme=light-2026&select=chat-c2', 1200, 800);
  const pill = await axe(p, '.chat-head');
  if (pill) check(!pill.some((x) => /color-contrast/.test(x)), `the header pills pass contrast [${pill.join(', ')}]`);
  await p.click('.cc-model');
  const lum = (c) => {
    const [r, g, b] = c.match(/[\d.]+/g).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };
  const thumb = await p.locator('.cc-thumb').evaluate((t) => window.getComputedStyle(t).backgroundColor);
  check(lum(thumb) > 0.9, `the effort thumb is light on a light theme [${thumb}]`);
  const off = p.locator('button.cc-switch[aria-checked="false"]').first();
  if (await off.count()) {
    const knob = await off.evaluate((b) => window.getComputedStyle(b, '::after').backgroundColor);
    check(lum(knob) > 0.9, `an off switch's knob is light too [${knob}]`);
  }
  await p.close();
};

// ---- F26: each Chats list row has its agent's glyph and when it was last active ----
BLOCKS.F26 = async () => {
  const p = await open('surface=chat&theme=dark-2026&side=1&list=1', 300, 800);
  const rows = p.locator('.chat-item');
  await rows.first().waitFor();
  const r = await rows.evaluateAll((rs) => rs.map((e) => ({ glyph: !!e.querySelector('.glyph'), time: e.querySelector('.chat-item-time')?.textContent ?? '' })));
  check(r.length > 0 && r.every((x) => x.glyph && x.time), `every row has a glyph and a time [${r.slice(0, 3).map((x) => JSON.stringify(x)).join(' ')}]`);
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
