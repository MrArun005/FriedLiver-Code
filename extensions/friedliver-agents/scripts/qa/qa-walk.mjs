#!/usr/bin/env node
/* global ClipboardEvent, DataTransfer, Event, InputEvent, getComputedStyle, innerHeight, innerWidth, performance, requestAnimationFrame, scrollY -- used inside page.evaluate */
// QA walk of the agent webviews, as a user would go through them, in Dark 2026 at 1200 and 640 px
// (Light 2026 spot checks). Screenshots and measured observations go to --out (default
// ~/code/FriedLiver-Code-design/qa). Not shipped; QA only.
//
//   node scripts/ui-harness.mjs --serve --no-build --port 5199     (in another shell)
//   PW_CHANNEL=chrome node scripts/qa/qa-walk.mjs [--base http://127.0.0.1:5199] [--out dir] [--only 07]
//
// Fixtures beyond the harness's (fresh chats, rules, a question card, 500 turns) are posted into the
// page as a host snapshot, so no product code changes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { fixture } from '../ui-fixture.mjs';
import { longFixture, freshChat, questionItem } from './qa-fixtures.mjs';

const { values: opts } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://127.0.0.1:5199' },
    out: { type: 'string', default: path.join(os.homedir(), 'code/FriedLiver-Code-design/qa') },
    only: { type: 'string' },
    axe: { type: 'string', default: path.join(os.homedir(), 'shoe-resell/node_modules/axe-core/axe.min.js') },
  },
});
fs.mkdirSync(opts.out, { recursive: true });
const obs = [];
const note = (id, what, data) => {
  obs.push({ id, what, ...(data !== undefined ? { data } : {}) });
  console.log(`  [${id}] ${what}${data !== undefined ? ' ' + JSON.stringify(data) : ''}`);
};

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome', args: ['--use-mock-keychain', '--password-store=basic'] });
const errors = [];
async function open(query, width = 1200, height = 800) {
  const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  p.on('pageerror', (e) => errors.push(`${query}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errors.push(`${query}: ${m.text()}`));
  await p.goto(`${opts.base}/?${query}`);
  await p.waitForSelector('#root > *');
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(120);
  return p;
}
async function shot(p, name, options = {}) {
  const file = path.join(opts.out, `${name}.png`);
  await (options.element ? p.locator(options.element).first() : p).screenshot({ path: file, animations: 'disabled', caret: 'hide', fullPage: !!options.full });
  console.log(`  ${name}.png`);
}
const posted = (p) => p.evaluate(() => window.__posted.filter((m) => m.type !== 'ready'));
const host = (p, m) => p.evaluate((m) => window.postMessage(m, '*'), m);
const snapshot = (p, state, selected) => host(p, { type: 'snapshot', state, selected, now: Date.now() });

/** Elements whose content spills past their box with nothing to cut it (no ellipsis/scroll), on screen. */
const spills = (p, root = 'body') =>
  p.evaluate((root) => {
    const out = [];
    for (const el of document.querySelector(root)?.querySelectorAll('*') ?? []) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'inline' || el.closest('svg')) continue;
      const clip = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
      const over = el.scrollWidth - el.clientWidth > 1;
      if (over && clip && cs.textOverflow !== 'ellipsis' && cs.overflowX !== 'auto' && cs.overflowX !== 'scroll' && el.childElementCount === 0) {
        out.push({ el: el.tagName.toLowerCase() + '.' + [...el.classList].join('.'), text: el.textContent.trim().slice(0, 40), sw: el.scrollWidth, cw: el.clientWidth });
      }
      if (r.right > innerWidth + 1 && cs.position !== 'fixed') out.push({ offscreen: el.tagName.toLowerCase() + '.' + [...el.classList].join('.'), right: Math.round(r.right), vw: innerWidth });
    }
    return out.slice(0, 15);
  }, root);
const hScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
async function axe(p, id, context) {
  if (!fs.existsSync(opts.axe)) return;
  await p.addScriptTag({ path: opts.axe });
  const res = await p.evaluate(async (ctx) => {
    const r = await window.axe.run(ctx ?? document, { resultTypes: ['violations'], rules: { region: { enabled: false } } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, sample: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  }, context);
  note(id, 'axe violations', res);
}
/** Tab through the page; report focused elements with no visible focus indicator. */
async function focusAudit(p, id, presses = 25) {
  const silent = [];
  for (let n = 0; n < presses; n++) {
    await p.keyboard.press('Tab');
    const f = await p.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const visible = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none');
      return { el: el.tagName.toLowerCase() + '.' + [...el.classList].join('.'), label: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30), visible, outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`, shadow: cs.boxShadow.slice(0, 60) };
    });
    if (f && !f.visible) silent.push(f);
  }
  note(id, 'focused with no visible indicator', silent);
}
const want = (s) => !opts.only || opts.only.split(',').some((o) => s.startsWith(o));
const D = 'theme=dark-2026';

try {
  // ---------- 01 Empty states ----------
  if (want('01')) {
    for (const w of [1200, 640]) {
      const p = await open(`surface=chat&${D}&empty=1`, w, 800);
      await shot(p, `01-empty-chat-${w}`);
      if (w === 1200) await axe(p, '01', null);
      await p.close();
    }
    const t = await open(`surface=tasks&${D}&empty=1&view=board`, 1200, 800);
    await shot(t, '01-empty-manager-board-1200');
    await t.keyboard.press('2');
    await shot(t, '01-empty-manager-list-1200');
    await t.keyboard.press('3');
    await shot(t, '01-empty-manager-map-1200');
    await t.close();
    const l = await open(`surface=chat&${D}&empty=1&list=1`, 300, 800);
    await shot(l, '01-empty-chats-list-300');
    await l.close();
  }

  // ---------- 02 New chat with each agent ----------
  if (want('02')) {
    const p = await open(`surface=chat&${D}&select=chat-c5`, 1200, 800);
    await p.click('button[aria-label="New chat with"], .switcher button[title="New chat"]');
    await shot(p, '02-new-chat-menu-1200');
    await p.keyboard.press('Escape');
    const base = fixture(Date.now()).state;
    for (const agent of ['claude', 'codex', 'gemini', 'demo']) {
      const c = freshChat(agent);
      await snapshot(p, { ...base, chats: [...base.chats, c] }, c.id);
      await p.waitForTimeout(120);
      await shot(p, `02-new-chat-${agent}-1200`);
      if (agent === 'claude') {
        note('02', 'fresh chat placeholder', await p.getAttribute('.composer textarea', 'placeholder'));
        note('02', 'fresh chat transcript text', (await p.locator('.transcript').innerText()).slice(0, 200));
      }
    }
    await p.setViewportSize({ width: 640, height: 800 });
    await shot(p, '02-new-chat-demo-640');
    await p.close();
  }

  // ---------- 03 Long message + Show more ----------
  if (want('03')) {
    for (const w of [1200, 640]) {
      const p = await open(`surface=chat&${D}&fixture=reference&select=chat-long`, w, 900);
      await shot(p, `03-long-message-sticky-${w}`);
      await p.evaluate(() => (document.querySelector('.transcript').scrollTop = 0));
      await p.waitForTimeout(80);
      await shot(p, `03-long-message-collapsed-${w}`);
      const more = p.locator('.user-msg .msg-more').first();
      note('03', `Show more present @${w}`, await more.count());
      if (await more.count()) {
        await more.click();
        await p.waitForTimeout(80);
        await shot(p, `03-long-message-expanded-${w}`);
        note('03', `after expand, button text @${w}`, await p.locator('.user-msg .msg-more').first().innerText().catch(() => null));
      }
      await p.close();
    }
  }

  // ---------- 04 Composer ----------
  if (want('04')) {
    for (const w of [1200, 640]) {
      const p = await open(`surface=chat&${D}&select=chat-c5`, w, 800);
      await p.mouse.move(0, 0);
      await shot(p, `04-composer-idle-${w}`, { element: '.composer-dock' });
      await p.click('.composer textarea');
      await shot(p, `04-composer-focus-${w}`, { element: '.composer-dock' });
      // Paste 5k chars.
      const big = Array.from({ length: 100 }, (_, n) => `Line ${n + 1}: the quick brown fox jumps over the lazy dog.`).join('\n').slice(0, 5000);
      await p.evaluate((t) => {
        const ta = document.querySelector('.composer textarea');
        const dt = new DataTransfer();
        dt.setData('text/plain', t);
        ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }, big);
      await p.waitForTimeout(80);
      let len = (await p.inputValue('.composer textarea')).length;
      if (len === 0) {
        // Paste events from script carry no default action: insert as the browser would.
        await p.evaluate((t) => document.execCommand('insertText', false, t), big);
        len = (await p.inputValue('.composer textarea')).length;
      }
      const geo = await p.evaluate(() => {
        const c = document.querySelector('.composer').getBoundingClientRect();
        const t = document.querySelector('.transcript').getBoundingClientRect();
        const ta = document.querySelector('.composer textarea');
        return { composerH: Math.round(c.height), viewH: innerHeight, transcriptH: Math.round(t.height), taScroll: ta.scrollHeight > ta.clientHeight };
      });
      note('04', `5k paste @${w}`, { len, ...geo });
      await shot(p, `04-composer-5k-paste-${w}`);
      await p.fill('.composer textarea', '');
      // Attachments.
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      await host(p, { type: 'attached', chatId: 'chat-c5', images: [1, 2, 3, 4, 5, 6].map((n) => ({ name: `screenshot-2026-10-17-at-19.${n}0.11-very-long-name.png`, mimeType: 'image/png', data: png })) });
      await p.waitForTimeout(100);
      await shot(p, `04-composer-attachments-${w}`, { element: '.composer-dock' });
      note('04', `attachment chips @${w}`, await p.evaluate(() => [...document.querySelectorAll('.cc-chip')].map((c) => Math.round(c.getBoundingClientRect().width))));
      // / menu
      await p.click('.cc-slash-btn');
      await shot(p, `04-slash-menu-${w}`);
      await p.keyboard.type('xyz-nothing');
      await shot(p, `04-slash-menu-no-match-${w}`);
      await p.keyboard.press('Escape');
      await p.keyboard.press('Escape');
      // typed / in box
      await p.fill('.composer textarea', '/');
      await shot(p, `04-typed-slash-${w}`);
      await p.fill('.composer textarea', '');
      // model menu
      await p.click('.cc-model');
      await shot(p, `04-model-menu-${w}`);
      await p.keyboard.press('ArrowDown');
      await p.keyboard.press('ArrowDown');
      await shot(p, `04-model-menu-keyboard-${w}`);
      await p.keyboard.press('Escape');
      // modes menu
      await p.click('.cc-mode');
      await shot(p, `04-modes-menu-${w}`);
      await p.keyboard.press('Escape');
      // Shift+Tab cycle
      await p.click('.composer textarea');
      const seq = [];
      for (let n = 0; n < 4; n++) {
        await p.keyboard.press('Shift+Tab');
        const m = (await posted(p)).at(-1);
        seq.push(m?.level ?? m?.on ?? m?.value);
      }
      note('04', `Shift+Tab posts (host never answers in harness) @${w}`, seq);
      note('04', `mode label after Shift+Tab x4 (no host echo) @${w}`, (await p.locator('.cc-mode').innerText()).trim());
      // effort slider drag
      await p.click('.cc-model');
      const slider = p.locator('.cc-model-menu .cc-slider');
      if (await slider.count()) {
        const b = await slider.boundingBox();
        const before = (await posted(p)).length;
        await p.mouse.move(b.x + 4, b.y + b.height / 2);
        await p.mouse.down();
        await p.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 5 });
        await p.mouse.up();
        const after = (await posted(p)).slice(before).filter((m) => m.optionId === 'effort');
        note('04', `effort slider drag posts @${w}`, after.map((m) => m.value));
        note('04', 'slider aria', await slider.evaluate((s) => ({ role: s.getAttribute('role'), now: s.getAttribute('aria-valuenow'), text: s.getAttribute('aria-valuetext'), label: s.getAttribute('aria-label') })));
        await shot(p, `04-effort-after-drag-${w}`);
      }
      await p.keyboard.press('Escape');
      if (w === 1200) {
        await axe(p, '04', '.composer-dock');
      }
      await p.close();
    }
    // Light spot check
    const l = await open('surface=chat&theme=light-2026&select=chat-c5', 1200, 800);
    await l.click('.cc-model');
    await shot(l, '04-model-menu-light-1200');
    await l.keyboard.press('Escape');
    await l.click('.cc-mode');
    await shot(l, '04-modes-menu-light-1200');
    await l.close();
  }

  // ---------- 05 Mic states ----------
  if (want('05')) {
    const p = await open(`surface=chat&${D}&select=chat-c5`, 1200, 700);
    await p.fill('.composer textarea', 'Fix the');
    await p.mouse.move(0, 0);
    await shot(p, '05-mic-idle', { element: '.composer-dock' });
    await p.hover('.cc-mic');
    await shot(p, '05-mic-hover', { element: '.composer-dock' });
    await p.click('.cc-mic');
    await host(p, { type: 'dictation', chatId: 'chat-c5', state: 'listening' });
    await host(p, { type: 'dictation', chatId: 'chat-c5', text: 'login redirect', final: false });
    await p.mouse.move(0, 0);
    await p.waitForTimeout(50);
    await shot(p, '05-mic-listening', { element: '.composer-dock' });
    await p.click('.cc-mic');
    await p.mouse.move(0, 0);
    await shot(p, '05-mic-stopping', { element: '.composer-dock' });
    await host(p, { type: 'dictation', chatId: 'chat-c5', state: 'idle' });
    await p.click('.cc-mic');
    await host(p, { type: 'dictation', chatId: 'chat-c5', state: 'fallback' });
    await p.waitForTimeout(50);
    await shot(p, '05-mic-fallback-hint', { element: '.composer-dock' });
    // Mic errors (permission denied) are host notifications (host/dictation.ts), not webview states.
    await p.close();
    const l = await open('surface=chat&theme=light-2026&select=chat-c5', 1200, 700);
    await l.click('.cc-mic');
    await l.mouse.move(0, 0);
    await shot(l, '05-mic-listening-light', { element: '.composer-dock' });
    await l.close();
  }

  // ---------- 06 Tabs ----------
  if (want('06')) {
    const p = await open(`surface=chat&${D}&select=chat-c5`, 1200, 800);
    await p.hover('.tab-wrap:not([data-active]) .tab >> nth=1');
    await shot(p, '06-tabs-hover-1200', { element: '.switcher' });
    note('06', 'tab strip roles', await p.evaluate(() => [...document.querySelector('.tabs').children].slice(0, 2).map((c) => `${c.tagName}.${c.className} role=${c.getAttribute('role')} > ${[...c.children].map((x) => x.getAttribute('role') ?? x.tagName).join(',')}`)));
    // Arrow keys between tabs (WAI-ARIA tabs)
    await p.focus('.tab[aria-selected="true"]');
    await p.keyboard.press('ArrowRight');
    note('06', 'ArrowRight on a tab moves focus to', await p.evaluate(() => `${document.activeElement.className} ${document.activeElement.textContent.trim().slice(0, 30)}`));
    const before = await p.locator('.tab').count();
    await p.click('.tab >> nth=2', { button: 'middle' });
    note('06', 'middle-click closes a tab', { before, after: await p.locator('.tab').count() });
    await p.keyboard.press('Meta+w');
    note('06', 'Cmd+W closes active tab', { after: await p.locator('.tab').count(), active: await p.locator('.tab[aria-selected="true"] .tab-title').innerText().catch(() => null) });
    // Close all via ×
    let guard = 0;
    while ((await p.locator('.tab-close').count()) && guard++ < 30) await p.locator('.tab-close').first().click({ force: true });
    await shot(p, '06-tabs-all-closed-1200');
    await p.close();
    // Overflow at 640 with all chats as tabs
    const o = await open(`surface=chat&${D}&select=chat-c5`, 640, 800);
    const ids = fixture(Date.now()).state.chats.filter((c) => !c.archived).map((c) => c.id);
    for (const id of ids) await host(o, { type: 'select', chatId: id });
    await o.waitForTimeout(150);
    await shot(o, '06-tabs-overflow-640', { element: '.switcher' });
    note('06', 'overflow at 640', await o.evaluate(() => { const t = document.querySelector('.tabs'); return { tabs: t.children.length, scrollW: t.scrollWidth, clientW: t.clientWidth, overflowAttr: t.hasAttribute('data-overflow'), activeVisible: (() => { const a = document.querySelector('.tab[aria-selected="true"]').getBoundingClientRect(), b = t.getBoundingClientRect(); return a.left >= b.left - 1 && a.right <= b.right + 1; })() }; }));
    note('06', 'tab width range', await o.evaluate(() => { const ws = [...document.querySelectorAll('.tab-wrap')].map((t) => Math.round(t.getBoundingClientRect().width)); return [Math.min(...ws), Math.max(...ws)]; }));
    await o.close();
  }

  // ---------- 07 Transcript ----------
  if (want('07')) {
    const r = await open(`surface=chat&${D}&fixture=reference&select=chat-ref`, 1200, 900);
    await r.evaluate(() => (document.querySelector('.transcript').scrollTop = 0));
    await shot(r, '07-transcript-reference-1200');
    await r.locator('details.thought summary').first().click();
    const step = r.locator('.tl-step .step-main').first();
    if (await step.count()) await step.click();
    await r.waitForTimeout(80);
    await shot(r, '07-transcript-thinking-and-step-open-1200');
    note('07', 'thinking summary is a <summary> (keyboard ok)', await r.locator('details.thought summary').count());
    await r.evaluate(() => { const t = document.querySelector('.transcript'); t.scrollTop = t.scrollHeight; });
    await r.hover('.prose .code-block >> nth=0').catch(() => {});
    await shot(r, '07-transcript-code-block-hover-1200');
    await r.setViewportSize({ width: 640, height: 900 });
    await r.waitForTimeout(80);
    await shot(r, '07-transcript-reference-640');
    note('07', 'spills @640', await spills(r, '.transcript'));
    note('07', 'page h-scroll @640', await hScroll(r));
    await axe(r, '07', '.transcript');
    await r.close();
    // Steps fixture (long heredocs)
    const s = await open(`surface=chat&${D}&fixture=steps`, 1200, 900);
    await s.evaluate(() => (document.querySelector('.transcript').scrollTop = 0));
    await shot(s, '07-steps-1200');
    await s.close();
    // Diff + decision cards with keys
    const c1 = await open(`surface=chat&${D}&select=chat-c1`, 1200, 900);
    await shot(c1, '07-decision-cards-c1-1200');
    await c1.click('.composer textarea');
    await c1.keyboard.press('Digit1');
    note('07', 'chat-c1: pressing 1 (the permission card says "1–3 picks") posts', (await posted(c1)).filter((m) => ['permission', 'bridge'].includes(m.type)));
    note('07', 'chat-c1: composer value after pressing 1', await c1.inputValue('.composer textarea'));
    await c1.keyboard.press('Control+Enter');
    note('07', 'chat-c1: Ctrl+Enter posts', (await posted(c1)).filter((m) => ['permission', 'bridge'].includes(m.type)));
    await c1.close();
    const c2 = await open(`surface=chat&${D}&select=chat-c2`, 1200, 900);
    await c2.click('.composer textarea');
    await c2.keyboard.press('Digit2');
    note('07', 'chat-c2: pressing 2 posts', (await posted(c2)).filter((m) => m.type === 'permission'));
    await shot(c2, '07-decision-card-command-1200');
    await c2.setViewportSize({ width: 640, height: 900 });
    await shot(c2, '07-decision-card-command-640');
    await c2.close();
    // Question card (AskUserQuestion)
    const q = await open(`surface=chat&${D}&select=chat-c5`, 1200, 900);
    const st = fixture(Date.now()).state;
    const c5 = st.chats.find((c) => c.id === 'chat-c5');
    c5.items = [...c5.items, questionItem()];
    c5.busy = true;
    await snapshot(q, st, 'chat-c5');
    await q.waitForTimeout(120);
    await shot(q, '07-question-card-1200');
    await q.click('.composer textarea');
    await q.keyboard.press('Digit2');
    note('07', 'question: pressing 2 posts', (await posted(q)).filter((m) => m.type === 'answerQuestion'));
    await q.close();
    // Images
    const im = await open(`surface=chat&${D}&select=chat-c5`, 1200, 900);
    await im.waitForTimeout(200);
    await shot(im, '07-step-images-1200');
    if (await im.locator('.images-pill').count()) {
      await im.click('.images-pill');
      await shot(im, '07-images-pill-1200');
    }
    await im.close();
  }

  // ---------- 08 Rewind ----------
  if (want('08')) {
    const p = await open(`surface=chat&${D}&select=chat-c5`, 1200, 800);
    await p.evaluate(() => (document.querySelector('.transcript').scrollTop = 0));
    await p.locator('.user-msg').first().hover();
    await shot(p, '08-rewind-hover-1200');
    note('08', 'rewind button reachable by keyboard (tabindex / opacity at focus)', await p.evaluate(() => { const b = document.querySelector('.rewind-btn'); b.focus(); return { focused: document.activeElement === b, opacity: getComputedStyle(b).opacity }; }));
    note('08', 'user bubble is role=button containing buttons (nested interactive)', await p.evaluate(() => { const b = document.querySelector('.user-msg .bubble'); return { role: b.getAttribute('role'), title: b.title, innerButtons: b.querySelectorAll('button,a').length }; }));
    await p.click('.rewind-btn');
    note('08', 'Rewind to here posts (host shows the confirm)', (await posted(p)).filter((m) => m.type === 'rewind'));
    await p.click('.chat-head-actions button[aria-label^="More"]');
    await shot(p, '08-more-menu-checkpoints-1200');
    await p.close();
  }

  // ---------- 09 Rules chip ----------
  if (want('09')) {
    const p = await open(`surface=chat&${D}&select=chat-c5`, 1200, 800);
    const st = fixture(Date.now()).state;
    const c5 = st.chats.find((c) => c.id === 'chat-c5');
    c5.session = { ...c5.session, rules: ['/home/dev/inventory-app/AGENTS.md', '/home/dev/inventory-app/.friedliver/rules/style.md', '/home/dev/.friedliver/rules/global.md'] };
    c5.branch = 'claude/explain-auth-middleware-and-session-store';
    await snapshot(p, st, 'chat-c5');
    await p.waitForTimeout(100);
    await shot(p, '09-rules-chip-1200', { element: '.chat-head' });
    note('09', 'rules chip', await p.evaluate(() => { const c = [...document.querySelectorAll('.chat-head .chip')].find((x) => /Rules/.test(x.textContent)); return c ? { tag: c.tagName, tabindex: c.getAttribute('tabindex'), title: c.title, role: c.getAttribute('role') } : null; }));
    await p.setViewportSize({ width: 640, height: 800 });
    await shot(p, '09-rules-chip-640', { element: '.chat-head' });
    note('09', 'chat head spills @640', await spills(p, '.chat-head'));
    await p.close();
  }

  // ---------- 10 Subagents + agent map ----------
  if (want('10')) {
    for (const w of [1200, 640]) {
      const p = await open(`surface=chat&${D}&fixture=subagents&select=chat-pay`, w, 900);
      await shot(p, `10-subagents-${w}`);
      await p.click('.cc-agents');
      await p.waitForTimeout(200);
      await shot(p, `10-agent-map-${w}`);
      if (w === 1200) {
        await axe(p, '10', '.cc-map');
        await focusAudit(p, '10-map', 8);
      }
      await p.close();
    }
    const r = await open(`surface=chat&${D}&fixture=reference&select=chat-ref`, 1200, 900);
    await r.click('.cc-agents');
    await r.waitForTimeout(200);
    await shot(r, '10-agent-map-14-agents-1200');
    await r.close();
  }

  // ---------- 11 Hand-off / consult / pipe cards ----------
  if (want('11')) {
    for (const [id, name] of [['chat-c5', 'handoff'], ['chat-c1', 'consult'], ['chat-c6', 'pipe'], ['chat-x3', 'handoff-target']]) {
      const p = await open(`surface=chat&${D}&select=${id}`, 1200, 900);
      const card = p.locator('.link-card').first();
      if (await card.count()) {
        await card.scrollIntoViewIfNeeded();
        await shot(p, `11-${name}-card-1200`);
      } else await shot(p, `11-${name}-1200`);
      await p.close();
    }
    const n = await open(`surface=chat&${D}&select=chat-c5`, 1200, 800);
    await host(n, { type: 'select', chatId: 'chat-c7' });
    await n.waitForTimeout(150);
    await shot(n, '11-notification-open-archived-1200');
    await n.close();
    // A notification's Open on a decision: the host selects the chat and reveals the item.
    const rv = await open(`surface=chat&${D}&select=chat-c5`, 1200, 800);
    await host(rv, { type: 'select', chatId: 'chat-c1' });
    await rv.waitForTimeout(150);
    await host(rv, { type: 'reveal', chatId: 'chat-c1', id: 'perm-c1' });
    await rv.waitForTimeout(300);
    note('11', 'reveal (notification Open on a decision): document scrollY afterwards (should be 0)', await rv.evaluate(() => ({ scrollY, docH: document.documentElement.scrollHeight, viewH: innerHeight, focused: document.activeElement?.textContent?.trim().slice(0, 30) })));
    await shot(rv, '11-notification-reveal-decision-1200');
    await rv.close();
    // The sticky copy's Show more: scrolls the message into view.
    const sm = await open(`surface=chat&${D}&fixture=reference&select=chat-long`, 1200, 900);
    await sm.waitForSelector('.sticky-prompt .msg-more');
    await sm.click('.sticky-prompt .msg-more');
    await sm.waitForTimeout(300);
    note('03', 'sticky Show more: document scrollY afterwards (should be 0)', await sm.evaluate(() => scrollY));
    await shot(sm, '03-sticky-show-more-after-1200');
    await sm.close();
  }

  // ---------- 12 Agent Manager ----------
  if (want('12')) {
    for (const w of [1200, 640]) {
      for (const view of ['board', 'list', 'map']) {
        const p = await open(`surface=tasks&${D}&view=${view}`, w, 900);
        await shot(p, `12-manager-${view}-${w}`);
        note('12', `page h-scroll ${view}@${w}`, await hScroll(p));
        if (view === 'board') {
          note('12', `board spills @${w}`, await spills(p, '.columns'));
          const card = p.locator('.task-card').nth(1);
          await card.hover();
          await p.waitForTimeout(250);
          await shot(p, `12-board-card-hover-${w}`);
          const more = card.locator('button[aria-label*="More"], .card-top button').last();
          if (await more.count()) {
            await more.click();
            await shot(p, `12-board-card-more-menu-${w}`);
            await p.keyboard.press('Escape');
          }
          if (w === 1200) {
            await axe(p, '12', null);
            await p.keyboard.press('Escape');
            await p.mouse.click(5, 5);
            await focusAudit(p, '12-board', 30);
          }
        }
        if (view === 'map' && w === 1200) {
          await p.hover('[data-nav="chat-x3"]').catch(() => {});
          await shot(p, '12-map-hover-1200');
        }
        await p.close();
      }
    }
    // Compare
    const c = await open(`surface=tasks&${D}&view=board`, 1200, 900);
    await c.locator('.compare').scrollIntoViewIfNeeded();
    await shot(c, '12-compare-1200', { element: '.compare' });
    await c.close();
    const l = await open('surface=tasks&theme=light-2026&view=board', 1200, 900);
    await shot(l, '12-manager-board-light-1200');
    await l.close();
  }

  // ---------- 13 Chats list view ----------
  if (want('13')) {
    for (const w of [300, 640]) {
      const p = await open(`surface=chat&${D}&list=1&select=chat-c5`, w, 900);
      await shot(p, `13-chats-list-${w}`);
      note('13', `list spills @${w}`, await spills(p));
      await p.close();
    }
    const p = await open(`surface=chat&${D}&select=chat-c5`, 1200, 800);
    await p.click('.all-btn');
    await shot(p, '13-all-chats-popover-1200');
    await p.keyboard.type('zzzz');
    await shot(p, '13-all-chats-no-match-1200');
    await p.close();
  }

  // ---------- 14 Long transcript performance ----------
  if (want('14')) {
    for (const turns of [100, 500]) {
      const p = await open(`surface=chat&${D}&select=chat-c5`, 1200, 900);
      const st = longFixture(turns);
      const t0 = await p.evaluate(() => performance.now());
      await snapshot(p, st, 'chat-long');
      // The transcript draws its latest turns (QA F03 windowing); older ones come as you scroll up.
      await p.waitForFunction((n) => document.querySelectorAll('.user-msg').length >= Math.min(n, 25), turns, { timeout: 120000 });
      const render = await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now())))));
      const nodes = await p.evaluate(() => document.querySelectorAll('*').length);
      // Scroll: 60 wheel steps up, measure frame times.
      const scroll = await p.evaluate(async () => {
        const el = document.querySelector('.transcript');
        const times = [];
        let last = performance.now();
        for (let n = 0; n < 60; n++) {
          el.scrollTop -= 400;
          el.dispatchEvent(new Event('scroll'));
          await new Promise((r) => requestAnimationFrame(r));
          const now = performance.now();
          times.push(now - last);
          last = now;
        }
        times.sort((a, b) => a - b);
        return { p50: +times[30].toFixed(1), p95: +times[56].toFixed(1), max: +times[59].toFixed(1) };
      });
      // One streamed chunk at the end: how long until painted.
      const chunk = await p.evaluate(async () => {
        const t = performance.now();
        window.postMessage({ type: 'action', action: { t: 'update', chatId: 'chat-long', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' more' } } } }, '*');
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return +(performance.now() - t).toFixed(1);
      });
      // Typing latency in the composer.
      await p.click('.composer textarea');
      const typing = await p.evaluate(async () => {
        const ta = document.querySelector('.composer textarea');
        const out = [];
        for (let n = 0; n < 20; n++) {
          const t = performance.now();
          ta.value += 'a';
          ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'a', inputType: 'insertText' }));
          await new Promise((r) => requestAnimationFrame(r));
          out.push(performance.now() - t);
        }
        out.sort((a, b) => a - b);
        return { p50: +out[10].toFixed(1), max: +out[19].toFixed(1) };
      });
      const heap = await p.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null));
      note('14', `${turns} turns`, { firstRenderMs: Math.round(render - t0), domNodes: nodes, scrollFrameMs: scroll, streamChunkPaintMs: chunk, typingFrameMs: typing, heapMB: heap });
      if (turns === 500) await shot(p, '14-500-turns-1200');
      await p.close();
    }
  }

  // ---------- 15 Streaming like the demo agent ----------
  if (want('15')) {
    const p = await open(`surface=chat&${D}&select=chat-c5`, 1200, 800);
    const base = fixture(Date.now()).state;
    const c = freshChat('demo');
    c.items = [{ kind: 'user', text: 'tour', images: [], checkpoint: 'turn-q1' }];
    c.busy = true;
    await snapshot(p, { ...base, chats: [...base.chats, c] }, c.id);
    await p.waitForTimeout(100);
    await shot(p, '15-demo-working-1200');
    const upd = (update) => host(p, { type: 'action', action: { t: 'update', chatId: c.id, update, at: Date.now() } });
    await upd({ sessionUpdate: 'plan', entries: [{ content: 'Read the README', status: 'completed', priority: 'medium' }, { content: 'Edit the config', status: 'in_progress', priority: 'medium' }, { content: 'Run the tests', status: 'pending', priority: 'medium' }] });
    await upd({ sessionUpdate: 'tool_call', toolCallId: 'd1', title: 'Read README.md', kind: 'read', status: 'completed', locations: [{ path: '/home/dev/inventory-app/README.md' }] });
    await upd({ sessionUpdate: 'tool_call', toolCallId: 'd2', title: 'npm test', kind: 'execute', status: 'in_progress', rawInput: { command: 'npm test' } });
    for (const w of 'Here is what the tour does: it reads a file, edits one, runs a command and shows an image.'.split(' ')) await upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: w + ' ' } });
    await p.waitForTimeout(100);
    await shot(p, '15-demo-streaming-1200');
    await host(p, { type: 'action', action: { t: 'busy', chatId: c.id, busy: false, at: Date.now() } });
    await p.waitForTimeout(100);
    await shot(p, '15-demo-done-1200');
    note('15', 'after the turn: plan stays at step 2 with a running tool (no host completion)', await p.locator('.card.plan .hint').innerText().catch(() => null));
    await p.close();
  }

  // ---------- 16 Light 2026 spot checks ----------
  if (want('16')) {
    for (const [q, n] of [['surface=chat&theme=light-2026&select=chat-c1', 'chat-c1'], ['surface=chat&theme=light-2026&fixture=reference&select=chat-ref', 'reference'], ['surface=tasks&theme=light-2026&view=list', 'list'], ['surface=chat&theme=light-2026&fixture=subagents&select=chat-pay', 'subagents']]) {
      const p = await open(q, 1200, 900);
      if (n === 'reference') await p.evaluate(() => (document.querySelector('.transcript').scrollTop = 0));
      await shot(p, `16-light-${n}-1200`);
      if (n === 'chat-c1') await axe(p, '16', null);
      await p.close();
    }
  }
} finally {
  note('errors', 'console/page errors', errors);
  fs.writeFileSync(path.join(opts.out, `observations${opts.only ? '-' + opts.only.replace(/,/g, '_') : ''}.json`), JSON.stringify(obs, null, 1));
  await browser.close();
}
