#!/usr/bin/env node
// See the agent webviews without the editor. Builds them, serves media/ with a
// stub acquireVsCodeApi and a FriedLiver theme mapped to --vscode-* variables,
// posts a fixture snapshot (ui-fixture.mjs), checks a few interactions and saves
// Playwright screenshots. Not shipped: .vscodeignore ships dist and media only.
//
//   node scripts/ui-harness.mjs              build, check, screenshot to docs/screenshots/agents/
//   node scripts/ui-harness.mjs --serve      build and serve on http://localhost:5178 to look around
//        [--no-build] [--out dir] [--port n] [--themes black-blue,light-blue]
//
// Pages: /?surface=tasks|chat|images&theme=black-blue&side=1&select=<chat id>&view=board|list|map&empty=1
//        &fixture=steps (a Claude chat with long heredoc commands and a plain-text summary, ui-fixture-steps.mjs)
//        &fixture=subagents (a Claude chat with three subagents, and outside Claude Code sessions, ui-fixture-subagents.mjs)
//        &fixture=reference (the session in the Claude Code reference screenshots, ui-fixture-reference.mjs)
//        &theme=dark-2026|light-2026 (the owner's theme, test/fixtures/theme-*-2026.css)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fixture } from './ui-fixture.mjs';
import { COMMANDS, ROOT as STEPS_ROOT, stepsFixture } from './ui-fixture-steps.mjs';
import { subagentsFixture } from './ui-fixture-subagents.mjs';
import { referenceFixture } from './ui-fixture-reference.mjs';

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(ext, '../..');
const themesDir = path.join(repo, 'extensions/friedliver-theme/themes');

const { values: opts } = parseArgs({
  options: {
    serve: { type: 'boolean', default: false },
    'no-build': { type: 'boolean', default: false },
    out: { type: 'string', default: path.join(repo, 'docs/screenshots/agents') },
    port: { type: 'string', default: '5178' },
    themes: { type: 'string', default: 'black-blue,light-blue' },
  },
});

if (!opts['no-build']) {
  const built = spawnSync('npm', ['run', 'build'], { cwd: ext, stdio: 'inherit', shell: process.platform === 'win32' });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

// ---- Themes → --vscode-* variables, the way VS Code hands them to webviews ----

const pkg = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));

function readTheme(name) {
  // The owner's theme, as a webview gets it (test/fixtures/theme-*-2026.css, scripts/theme-fixture.mjs).
  const fixture = path.join(ext, 'test/fixtures', `theme-${name}.css`);
  if (/^(dark|light)-2026$/.test(name) && fs.existsSync(fixture)) {
    const css = fs.readFileSync(fixture, 'utf8');
    const colors = Object.fromEntries([...css.matchAll(/--vscode-([\w-]+):\s*([^;]+);/g)].map(([, k, v]) => [k.replace(/-/g, '.'), v.trim()]));
    return { kind: name.startsWith('light') ? 'light' : 'dark', colors, css };
  }
  const file = path.join(themesDir, `friedliver-${name}-color-theme.json`);
  const text = fs.readFileSync(file, 'utf8');
  let theme;
  try {
    theme = JSON.parse(text);
  } catch {
    theme = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
  }
  const kind = theme.type === 'light' ? 'light' : 'dark';
  const colors = { ...theme.colors };
  // Colors this extension contributes take their defaults unless the theme sets them.
  for (const c of pkg.contributes.colors) colors[c.id] ??= c.defaults[kind];
  const vars = Object.entries(colors).map(([k, v]) => `--vscode-${k.replace(/\./g, '-')}: ${v};`);
  vars.push(
    "--vscode-font-family: system-ui, 'Ubuntu', 'Droid Sans', sans-serif;",
    '--vscode-font-size: 13px;',
    '--vscode-font-weight: normal;',
    "--vscode-editor-font-family: 'Droid Sans Mono', monospace;",
    '--vscode-editor-font-size: 13px;',
  );
  return { kind, colors, css: `:root { ${vars.join(' ')} }` };
}

function page(params) {
  const surface = ['tasks', 'chat', 'images'].includes(params.get('surface')) ? params.get('surface') : 'tasks';
  const theme = readTheme(params.get('theme') ?? 'black-blue');
  const side = params.get('side') === '1';
  const background = side ? theme.colors['sideBar.background'] : theme.colors['editor.background'];
  const data =
    params.get('empty') === '1'
      ? { state: { chats: [], images: [], links: [] } }
      : params.get('fixture') === 'steps'
        ? stepsFixture(Date.now())
        : params.get('fixture') === 'subagents'
          ? subagentsFixture(Date.now())
          : params.get('fixture') === 'reference'
            ? referenceFixture(Date.now())
            : fixture(Date.now());
  const snapshot = { type: 'snapshot', state: data.state, selected: params.get('select') ?? undefined, now: Date.now(), defaults: data.defaults };
  // textSize: a tab's saved text size, as vscode.setState would have kept it.
  const savedEntries = [['view', params.get('view')], ['textSize', params.get('textSize') && Number(params.get('textSize'))]].filter(([, v]) => v);
  const saved = savedEntries.length ? Object.fromEntries(savedEntries) : undefined;
  const stub = `
    window.__posted = [];
    window.__vscodeState = () => saved;
    let saved = ${JSON.stringify(saved ?? null)};
    const snapshot = ${JSON.stringify(snapshot).replace(/</g, '\\u003c')};
    const claude = ${JSON.stringify(data.claude ?? null).replace(/</g, '\\u003c')};
    window.acquireVsCodeApi = () => ({
      postMessage(m) {
        window.__posted.push(m);
        if (m && m.type === 'ready') setTimeout(() => window.postMessage(snapshot, '*'), 0);
        // Step images: a drawn stand-in for files the host would allow; paths with "outside" are refused.
        if (m && m.type === 'imageSrc') {
          const label = m.path.split('/').pop();
          const c = document.createElement('canvas');
          c.width = 480;
          c.height = 300;
          const g = c.getContext('2d');
          g.fillStyle = '#e8ecf2'; g.fillRect(0, 0, 480, 300);
          g.fillStyle = '#fff'; g.fillRect(140, 70, 200, 160);
          g.fillStyle = '#dfe3ea'; g.fillRect(165, 110, 150, 18); g.fillRect(165, 140, 150, 18);
          g.fillStyle = '#5b7cfa'; g.fillRect(165, 180, 150, 26);
          g.fillStyle = '#7a8394'; g.font = '14px sans-serif'; g.fillText(label, 20, 285);
          setTimeout(() => window.postMessage({ type: 'imageSrc', path: m.path, ...(m.path.includes('outside') ? {} : { src: c.toDataURL('image/png') }) }, '*'), 0);
        }
        if (m && m.type === 'ready' && claude) setTimeout(() => window.postMessage({ type: 'claudeSessions', sessions: claude }, '*'), 0);
      },
      getState: () => saved ?? undefined,
      setState: (s) => { saved = s; },
      __saved: () => saved,
    });`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${theme.css} body { background-color: ${background}; }</style>
<link rel="stylesheet" href="/media/webview.css">
<title>${surface} · harness</title>
<script>${stub}</script>
</head>
<body class="vscode-${theme.kind}" data-accent="#D97757" data-surface="${surface}"${params.get('list') === '1' ? ' data-view="list"' : ''} data-platform="${params.get('platform') === 'linux' ? 'linux' : 'darwin'}">
<div id="root"></div>
<script src="/media/dist/${surface}.js"></script>
</body>
</html>`;
}

const TYPES = { '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.map': 'application/json' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page(url.searchParams));
    return;
  }
  // The browser asks for a favicon on the first page; no 404 in the console for it.
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  const media = path.join(ext, 'media');
  const file = path.resolve(media, `.${decodeURIComponent(url.pathname).replace(/^\/media/, '')}`);
  if (!url.pathname.startsWith('/media/') || !file.startsWith(media + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
const port = Number(opts.port);
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${port}`;

if (opts.serve) {
  console.log(`Serving ${base}/?surface=tasks  (also ?surface=chat&side=1&select=chat-c1, &theme=light-blue, &view=map)`);
} else {
  try {
    await shoot();
  } finally {
    server.close();
  }
}

// ---- Checks and screenshots ----

async function shoot() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}), args: ['--use-mock-keychain', '--password-store=basic'] });
  const ids = fixture().ids;
  fs.mkdirSync(opts.out, { recursive: true });
  const problems = [];

  const open = async (query, width, height) => {
    const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    p.on('pageerror', (e) => problems.push(`${query}: ${e.message}`));
    p.on('console', (m) => m.type() === 'error' && problems.push(`${query}: ${m.text()}`));
    await p.goto(`${base}/?${query}`);
    await p.waitForSelector('#root > *');
    await p.evaluate(() => document.fonts.ready);
    return p;
  };
  const save = async (p, name, options = {}) => {
    const file = path.join(opts.out, `${name}.png`);
    await (options.element ? p.locator(options.element) : p).screenshot({ path: file, animations: 'disabled', caret: 'hide' });
    console.log(`  ${path.relative(repo, file)}`);
  };
  const posted = (p) => p.evaluate(() => window.__posted.filter((m) => m.type !== 'ready'));
  const check = (ok, what) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) problems.push(what);
  };

  for (const theme of opts.themes.split(',')) {
    console.log(`${theme}:`);
    for (const view of ['board', 'list', 'map']) {
      const p = await open(`surface=tasks&theme=${theme}&view=${view}`, 1440, 900);
      await save(p, `manager-${view}-${theme}`);
      if (view === 'map' && theme === 'black-blue') {
        // The whole diagram: a viewport tall enough that nothing scrolls.
        const tall = await p.evaluate(() => document.querySelector('.map-canvas').getBoundingClientRect().bottom + 40);
        await p.setViewportSize({ width: 1440, height: Math.ceil(tall) });
        await save(p, `manager-map-full-${theme}`, { element: '.map-scroll' });
        await p.setViewportSize({ width: 1440, height: 900 });
        await p.hover(`[data-nav="${ids.center}"]`);
        await save(p, `manager-map-hover-${theme}`);
      }
      await p.close();
    }
    const side = await open(`surface=chat&theme=${theme}&side=1&select=${ids.side}`, 400, 900);
    await save(side, `chat-side-${theme}`);
    if (theme === 'black-blue') {
      await side.click('.all-btn');
      await save(side, `chat-all-chats-${theme}`);
      await side.keyboard.press('Escape');
      await side.fill('.composer textarea', '@g');
      await save(side, `chat-mention-${theme}`);
      await side.fill('.composer textarea', '');
      await side.click('.cc-mode');
      await save(side, `chat-approval-menu-${theme}`);
      await side.keyboard.press('Escape');
      await side.keyboard.press('Escape');
      await side.click('.cc-model');
      await save(side, `chat-model-menu-${theme}`);
      await side.keyboard.press('Escape');
      await side.keyboard.press('Escape');
      await side.fill('.composer textarea', '/');
      await save(side, `chat-slash-${theme}`);
    }
    await side.close();
    const center = await open(`surface=chat&theme=${theme}&select=${ids.center}`, 1000, 900);
    await save(center, `chat-center-${theme}`);
    await center.close();
    // Long shell steps and a plain-text summary: steps collapsed, two opened, and the reply.
    const steps = await open(`surface=chat&theme=${theme}&side=1&fixture=steps`, 460, 900);
    await steps.evaluate(() => (document.querySelector('.transcript').scrollTop = 0));
    await save(steps, `chat-steps-${theme}`);
    await steps.click('.tl-step:has(.step-text:text("cat << EOF | python3 minidb.py")) .step-main');
    await steps.click('.tl-step:has(.step-verb:text-is("Write")):has(.step-text:text-is("README.md")) .step-main');
    await steps.evaluate(() => document.querySelector('.tl-step[data-open]')?.scrollIntoView({ block: 'start' }));
    await save(steps, `chat-steps-open-${theme}`);
    await steps.evaluate(() => {
      const t = document.querySelector('.transcript');
      t.scrollTop = t.scrollHeight;
    });
    await save(steps, `chat-steps-reply-${theme}`);
    await steps.close();
  }

  console.log('checks:');
  {
    const p = await open('surface=tasks&view=board', 1440, 900);
    await p.fill('.new-task textarea', 'Make the reports page load faster');
    await p.click('.agent-option:has-text("Codex")');
    await p.click('.agent-option:has-text("Gemini")');
    check(await p.isChecked('.new-task input[type="checkbox"]'), 'own worktree turns on for several agents');
    await p.press('.new-task textarea', 'Control+Enter');
    const fan = (await posted(p)).find((m) => m.type === 'fanout');
    check(fan?.agents.join() === 'claude,codex,gemini' && fan.worktree === true, 'Ctrl+Enter with three agents sends a fan-out');

    await p.click(`[data-nav="chat-c1"] button:has-text("Allow for this chat")`);
    check((await posted(p)).some((m) => m.type === 'bridge' && m.requestId === 'bridge-c1' && m.answer === 'allowChat'), 'a bridge request is answered from its card');

    const trigger = p.locator(`[data-nav="chat-c3"] .card-connect button[aria-haspopup="menu"][aria-label="Hand off"]`);
    await trigger.click();
    check(await p.locator('.popover[role="menu"]').isVisible(), 'Hand off opens a menu');
    await p.keyboard.press('ArrowDown');
    await p.keyboard.press('Escape');
    check((await p.locator('.popover').count()) === 0 && (await trigger.evaluate((el) => el === document.activeElement)), 'Escape closes the menu and focus returns');

    await p.click('.pill.loud');
    await p.waitForTimeout(100);
    check(await p.evaluate(() => document.activeElement?.getAttribute('data-nav') === 'chat-c1'), 'the decisions pill jumps to the first decision');
    await p.keyboard.press('j');
    check(await p.evaluate(() => document.activeElement?.getAttribute('data-nav') === 'chat-x1'), 'j moves to the next card');
    await p.keyboard.press('3');
    check(await p.locator('svg.map').isVisible(), '3 shows the map');
    await p.keyboard.press('2');
    check(await p.locator('.chat-table').isVisible(), '2 shows the list');
    await p.click('th.c-files .th-btn');
    check((await p.locator('.chat-table tbody tr').first().getAttribute('data-nav')) === 'chat-c2', 'the list sorts by files');
    await p.keyboard.press('/');
    await p.keyboard.type('gemini');
    check((await p.locator('.chat-table tbody tr').count()) === 4, 'search filters by agent');
    await p.close();
  }
  {
    const p = await open(`surface=chat&side=1&select=${ids.side}`, 400, 900);
    await p.click('.composer textarea');
    await p.keyboard.type('@ge');
    check(await p.locator('.mention-menu [role="option"]:has-text("Gemini")').isVisible(), '@ opens the agent picker');
    await p.keyboard.press('Enter');
    await p.keyboard.type('is this safe for de-CH?');
    check(((await p.locator('.composer-bar button.primary').getAttribute('aria-label')) ?? '').includes('Ask Gemini'), 'the send button reads Ask Gemini');
    await p.keyboard.press('Enter');
    const consult = (await posted(p)).find((m) => m.type === 'consult');
    check(consult?.agent === 'gemini' && consult.text === 'is this safe for de-CH?' && consult.chatId === ids.side, 'a mention sends a consultation');
    await p.click('button:has-text("Send to Claude 1")');
    check((await posted(p)).some((m) => m.type === 'forward' && m.fromChatId === 'chat-g1' && m.toChatId === ids.side), 'Send to forwards the reply');
    await p.click('.all-btn');
    await p.keyboard.type('swappable');
    await p.keyboard.press('Enter');
    check((await posted(p)).some((m) => m.type === 'select' && m.chatId === ids.center), 'All chats searches and selects');
    await p.close();
  }
  {
    // Code references from the editor: a chip on the message, and Add Selection to Chat in the composer.
    const p = await open(`surface=chat&side=1&select=${ids.side}`, 400, 900);
    const file = '/home/dev/inventory-app/src/format.ts';
    await p.click('.bubble .code-ref button.ref:has-text("format.ts:12–18")');
    check((await posted(p)).some((m) => m.type === 'openFile' && m.path === file && m.line === 12 && m.endLine === 18), 'a code reference chip opens its lines');
    await p.close();
  }
  {
    // An idle chat, so its composer can send.
    const p = await open('surface=chat&side=1&select=chat-c5', 400, 900);
    const file = '/home/dev/inventory-app/src/format.ts';
    await p.evaluate((ref) => window.postMessage({ type: 'addRef', chatId: 'chat-c5', ref }, '*'), { path: file, startLine: 3, endLine: 5 });
    await p.waitForSelector('.composer .code-ref');
    check(await p.evaluate(() => document.activeElement?.matches('.composer textarea') ?? false), 'adding a reference focuses the composer');
    await p.evaluate((ref) => window.postMessage({ type: 'addRef', chatId: 'chat-c5', ref }, '*'), { path: file, startLine: 3, endLine: 5 });
    await p.waitForTimeout(50);
    check((await p.locator('.composer .code-ref').count()) === 1, 'the same reference is added once');
    await p.keyboard.type('Is this the rounding bug?');
    await p.keyboard.press('Enter');
    const sent = (await posted(p)).find((m) => m.type === 'send');
    check(sent?.text === 'Is this the rounding bug?' && sent.refs?.[0]?.startLine === 3 && sent.refs[0].endLine === 5, 'the message carries the reference');
    check((await p.locator('.composer .code-ref').count()) === 0, 'sending clears the composer’s references');
    await p.close();
  }

  {
    // The session controls: approval level, model, effort, Plan, and Shift+Tab.
    const p = await open('surface=chat&side=1&select=chat-c5', 400, 900);
    const last = async () => (await posted(p)).at(-1);
    await p.click('.cc-mode');
    const modes = await p.locator('.cc-modes-menu .cc-item-name').allInnerTexts();
    check(['Manual', 'Edit automatically', 'Plan', 'Auto'].every((m) => modes.includes(m)), `Modes lists Manual, Edit automatically, Plan, Auto [${modes}]`);
    check(await p.locator('.cc-modes-menu .cc-keys:has-text("tab to switch")').isVisible(), 'Modes says ⇧ + tab switches');
    check((await p.locator('.cc-modes-menu .cc-slider[role="slider"]').count()) === 1, 'Modes has the effort slider');
    await p.click('.cc-modes-menu [role="menuitemradio"]:has(.cc-item-name:text-is("Edit automatically"))');
    check(JSON.stringify(await last()) === JSON.stringify({ type: 'approval', chatId: 'chat-c5', level: 'edits' }), 'picking a mode posts its level');
    await p.click('.cc-mode');
    await p.click('.cc-modes-menu [role="menuitemradio"]:has(.cc-item-name:text-is("Plan"))');
    check(JSON.stringify(await last()) === JSON.stringify({ type: 'plan', chatId: 'chat-c5', on: true }), 'Plan turns Plan mode on');
    await p.click('.cc-mode');
    const names = await p.locator('.cc-modes-menu .cc-item-name').allInnerTexts();
    check(names.filter((n) => n === 'Manual' || n === 'Plan').length === 2 && !names.includes('Bypass permissions') && !names.includes('Accept edits'), `Modes shows the four rows once, no duplicates [${names}]`);
    check((await p.locator('.cc-modes-menu .cc-more-btn').getAttribute('aria-expanded')) === 'false', 'other agent modes sit behind More modes…');
    await p.click('.cc-modes-menu .cc-more-btn');
    await p.click('.cc-modes-menu [role="menuitemradio"]:has(.cc-item-name:text-is("Bypass permissions"))');
    const mode = await last();
    check(mode?.type === 'setOption' && mode.optionId === 'mode' && mode.value === 'bypassPermissions', 'an agent mode is set as its own option');
    await p.click('.cc-model');
    check((await p.locator('.cc-model-menu .cc-menu-title').innerText()) === 'Select a model', 'the model menu is titled Select a model');
    check((await p.locator('.cc-model-menu .cc-item-desc').count()) >= 1, 'models show their descriptions');
    await p.click('.cc-model-menu [role="menuitemradio"]:has-text("Small")');
    const picked = await last();
    check(picked?.type === 'setOption' && picked.optionId === 'model' && picked.value === 'small', 'picking a model posts setOption');
    check(!(await p.locator('.cc-model-menu').count()), 'picking a model closes the menu');
    await p.click('.cc-model');
    await p.focus('.cc-model-menu .cc-slider');
    await p.keyboard.press('End');
    const effort = await last();
    check(effort?.optionId === 'effort' && effort.value === 'max', 'the effort slider posts setOption (End = Max)');
    await p.click('.cc-model-menu [role="switch"][aria-label="Fast mode"]');
    const fast = await last();
    check(fast?.optionId === 'fast' && fast.value === true, 'Fast mode is a toggle in the model menu');
    await p.keyboard.press('Escape');
    check(!(await p.locator('.cc-menu').count()), 'Esc closes the menu');
    await p.click('.composer textarea');
    await p.keyboard.press('Shift+Tab');
    check(JSON.stringify(await last()) === JSON.stringify({ type: 'approval', chatId: 'chat-c5', level: 'edits' }), 'Shift+Tab moves to the next level');
    const tip = (await p.getAttribute('.cc-model', 'title')) ?? '';
    check(/of 200k tokens left/.test(tip) && /Context lasts/.test(tip), 'the model pill’s tooltip has the context left and the turns estimate');
    // The / button: search, Context, Model, the agent's commands.
    await p.click('.cc-slash-btn');
    check((await p.inputValue('.cc-slash-menu .cc-search')) === '/', 'the / menu opens with its search at /');
    const subs = await p.locator('.cc-slash-menu .cc-menu-sub').allInnerTexts();
    // One command list (QA F07): FriedLiver's commands first, then Context, Model and the agent's own.
    check(subs[0] === 'FriedLiver' && subs[1] === 'Context' && subs[2] === 'Model' && subs.length === 4, `the / menu has FriedLiver, Context, Model and the agent’s commands [${subs}]`);
    await p.fill('.cc-slash-menu .cc-search', '/comp');
    check((await p.locator('.cc-slash-menu [role="menuitem"]').allInnerTexts()).every((t) => /comp/i.test(t)), 'typing filters the / menu');
    await p.keyboard.press('Enter');
    check((await p.inputValue('.composer textarea')) === '/compact ', 'Enter picks the first match into the box');
    await p.fill('.composer textarea', '');
    await p.click('.cc-slash-btn');
    await p.click('.cc-slash-menu [role="menuitem"]:has-text("Mention file from this project")');
    check((await p.inputValue('.composer textarea')) === '#', 'Mention file starts a # file search');
    await p.fill('.composer textarea', '');
    await p.click('.cc-slash-btn');
    await p.click('.cc-slash-menu [role="menuitem"]:has-text("Switch model")');
    check(await p.locator('.cc-model-menu').isVisible(), 'Switch model… opens the model menu');
    await p.keyboard.press('Escape');
    await p.click('.composer textarea');
    await p.keyboard.type('/co');
    check(await p.locator('.mention-menu [role="option"]:has-text("/compact")').isVisible(), '/ opens the agent’s commands');
    await p.keyboard.press('Enter');
    check((await p.inputValue('.composer textarea')) === '/compact ', 'picking a command fills it in');

    // Drafts stay with their own chat.
    await p.fill('.composer textarea', 'draft for Claude 5');
    await p.click('.all-btn');
    await p.keyboard.type('csv export');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(50);
    check((await p.inputValue('.composer textarea')) === '', 'another chat starts with its own empty draft');
    await p.click('.all-btn');
    await p.keyboard.type('auth middleware');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(50);
    check((await p.inputValue('.composer textarea')) === 'draft for Claude 5', 'the draft comes back with its chat');
    await p.fill('.composer textarea', '');
    await p.keyboard.press('ArrowUp');
    check((await p.inputValue('.composer textarea')) === 'Does the login page still look right?', 'Up in an empty box recalls the last message');
    await p.close();
  }
  {
    // The mic (macOS): one click listens, the words appear at the caret as they come, a click or Esc stops. No hint.
    // In the owner's theme (Dark 2026); Light 2026 is shot below.
    const p = await open('surface=chat&side=1&select=chat-c5&theme=dark-2026', 900, 700);
    const box = () => p.inputValue('.composer textarea');
    const host = async (m) => {
      await p.evaluate((m) => window.postMessage({ type: 'dictation', chatId: 'chat-c5', ...m }, '*'), m);
      await p.waitForTimeout(30);
    };
    const dictates = async () => (await posted(p)).filter((m) => m.type === 'dictate');
    await p.fill('.composer textarea', 'Fix the');
    const look = () =>
      p.evaluate(() => {
        const b = document.querySelector('.cc-mic'), cs = window.getComputedStyle(b), ring = window.getComputedStyle(b, '::after');
        const probe = document.createElement('i');
        probe.style.color = '#0078d4'; // the mic's brand blue, the same in every theme
        document.body.append(probe);
        const want = window.getComputedStyle(probe).color;
        probe.remove();
        const r = b.getBoundingClientRect();
        return { blue: cs.backgroundColor === want, white: cs.color === 'rgb(255, 255, 255)', size: r.width === 26 && r.height === 26, ring: ring.content !== 'none' && ring.borderTopWidth === '2px' && ring.borderTopColor === 'rgb(255, 255, 255)', opacity: cs.opacity };
      });
    const idle = await look();
    check(idle.blue && idle.white && idle.size && !idle.ring, 'the mic is a 26px blue button with a white glyph, no ring at rest');
    await p.mouse.move(0, 0);
    await save(p, 'composer-mic-idle', { element: '.composer' });
    await p.click('.cc-mic');
    check((await dictates()).at(-1)?.on === true && (await dictates()).at(-1)?.chatId === 'chat-c5', 'one click starts dictating into this chat');
    check(await p.evaluate(() => document.activeElement?.matches('.composer textarea') ?? false), 'the mic focuses the message box');
    check((await p.locator('.cc-mic[data-state="listening"][title="Listening… click to stop"][aria-pressed="true"]').count()) === 1, 'the mic shows it is listening');
    check((await p.locator('.mic-hint').count()) === 0, 'no Fn Fn hint when the helper runs');
    await host({ state: 'listening' });
    await host({ text: 'login', final: false });
    check((await box()) === 'Fix the login', 'a partial appears at the caret');
    await host({ text: 'login redirect', final: false });
    check((await box()) === 'Fix the login redirect', 'the next partial replaces it');
    await p.mouse.move(0, 0);
    const listening = await look();
    check(listening.blue && listening.ring && listening.opacity === '1', 'listening: still blue, with a white 2px ring');
    await save(p, 'composer-mic-listening', { element: '.composer' });
    await p.click('.cc-mic');
    check((await dictates()).at(-1)?.on === false, 'a second click stops');
    check((await p.locator('.cc-mic[data-state="stopping"]').count()) === 1, 'the mic shows it is finishing');
    check((await look()).opacity === '0.6', 'finishing: the mic at 60%');
    await host({ text: 'login redirect bug.', final: true });
    await host({ state: 'idle' });
    check((await box()) === 'Fix the login redirect bug.', 'the final words stay');
    check((await p.locator('.cc-mic:not([data-state])[aria-pressed="false"]').count()) === 1, 'the mic is idle again');
    const before = (await posted(p)).length;
    await p.click('.cc-mic');
    await host({ state: 'listening' });
    await p.keyboard.press('Escape');
    const after = (await posted(p)).slice(before);
    check(after.at(-1)?.type === 'dictate' && after.at(-1)?.on === false && !after.some((m) => m.type === 'stop'), 'Esc stops dictating, not the agent');
    await host({ state: 'idle' });
    await p.click('.cc-mic');
    await host({ text: 'and', final: false });
    await p.keyboard.type('!');
    check((await dictates()).at(-1)?.on === false, 'typing takes the box back from the mic');
    await host({ text: 'and more', final: true });
    check((await box()) === 'Fix the login redirect bug. and!', 'words after typing are dropped');
    await host({ state: 'idle' });
    // A build without the helper (a dev build): the old hint.
    await p.click('.cc-mic');
    await host({ state: 'fallback' });
    check(await p.locator('.mic-hint:has-text("Press Fn twice to dictate")').isVisible(), 'no helper: the mic shows the Fn Fn hint');
    check((await p.locator('.cc-mic:not([data-state])').count()) === 1, 'no helper: the mic is idle');
    await p.click('.mic-hint a');
    check((await posted(p)).some((m) => m.type === 'dictationSettings'), 'the hint opens Dictation settings');
    const r = await p.evaluate(() => {
      const m = document.querySelector('.cc-mic').getBoundingClientRect(), t = document.querySelector('.cc-input').getBoundingClientRect();
      return t.right - m.right < 16 && m.top - t.top < 16;
    });
    check(r, 'the mic sits at the top right inside the box');
    await p.click('.attach-btn');
    check((await posted(p)).some((m) => m.type === 'attach'), '+ attaches images');
    await p.close();
    const light = await open('surface=chat&side=1&select=chat-c5&theme=light-2026', 900, 700);
    await save(light, 'composer-mic-idle-light', { element: '.composer' });
    await light.click('.cc-mic');
    await light.mouse.move(0, 0);
    await save(light, 'composer-mic-listening-light', { element: '.composer' });
    await light.close();
    const blackBlue = await open('surface=chat&side=1&select=chat-c5&theme=black-blue', 900, 700);
    await save(blackBlue, 'composer-mic-idle-black-blue', { element: '.composer' });
    await blackBlue.close();
    const linux = await open('surface=chat&side=1&select=chat-c5&platform=linux', 400, 700);
    check((await linux.locator('.cc-mic').count()) === 0, 'no mic off macOS');
    await linux.close();
  }
  {
    // Text size: Cmd/Ctrl + = - 0 in a tab, that tab only, kept in its own webview state, and never reaching the window's zoom.
    const p = await open('surface=chat&theme=black-blue&select=chat-c5', 1200, 800);
    await p.evaluate(() => {
      window.__forwarded = 0;
      window.addEventListener('keydown', (e) => e.key !== 'Meta' && e.key !== 'Control' && window.__forwarded++); // what the webview host forwards to the workbench
    });
    const size = async () => (await p.waitForTimeout(50), p.evaluate(() => window.getComputedStyle(document.querySelector('.composer textarea')).fontSize));
    check((await size()) === '13px', 'the chat starts at 13px');
    await p.click('.composer textarea');
    await p.keyboard.press('ControlOrMeta+Equal');
    await p.keyboard.press('ControlOrMeta+Equal');
    check((await size()) === '15px', 'Cmd/Ctrl + = grows this tab by 1px a press');
    check(await p.locator('.text-size-toast:has-text("Text 15px")').isVisible(), 'the new size shows briefly');
    check((await p.evaluate(() => window.__forwarded)) === 0, 'the zoom keys don’t reach the window');
    check((await p.evaluate(() => window.__vscodeState()?.textSize)) === 15, 'the size is kept in this webview’s state');
    await p.keyboard.press('ControlOrMeta+Minus');
    check((await size()) === '14px', 'Cmd/Ctrl + - shrinks it');
    await p.keyboard.press('ControlOrMeta+Digit0');
    check((await size()) === '13px', 'Cmd/Ctrl + 0 resets it');
    await p.close();
    const restored = await open('surface=chat&theme=black-blue&select=chat-c5&textSize=17', 1200, 800);
    check((await restored.evaluate(() => window.getComputedStyle(document.querySelector('.composer textarea')).fontSize)) === '17px', 'a tab comes back at its own size');
    await restored.close();
    const other = await open('surface=chat&theme=black-blue&select=chat-c5', 1200, 800);
    check((await other.evaluate(() => window.getComputedStyle(document.querySelector('.composer textarea')).fontSize)) === '13px', 'another tab keeps the default');
    await other.screenshot({ path: path.join(os.homedir(), 'code/chat-sizes-dark.png'), animations: 'disabled', caret: 'hide' });
    await other.close();
  }
  {
    // Step images: a thumbnail with a title, opening the editor's preview; the header's Images pill lists them.
    const p = await open('surface=chat&theme=black-blue&select=chat-c5', 1200, 900);
    await p.waitForSelector('.step-image img');
    const titles = await p.locator('.step-image .image-title').allInnerTexts();
    check(titles.join('|') === 'Screenshot of localhost:3000/login|Login page mockup', 'image steps show thumbnails titled from the step or the file name');
    const box = await p.locator('.step-image img').first().boundingBox();
    check(!!box && box.width <= 240 && box.height <= 160, 'thumbnails fit 240×160');
    await p.locator('.step-image .image-thumb').nth(1).click();
    check((await posted(p)).some((m) => m.type === 'openImage' && m.path.endsWith('docs/login-page_mockup.png')), 'a thumbnail opens the image preview');
    check((await p.locator('.images-pill').innerText()).includes('Images · 2'), 'the header counts the chat’s images');
    await p.screenshot({ path: path.join(os.homedir(), 'code/chat-images.png'), animations: 'disabled', caret: 'hide' });
    await p.click('.images-pill');
    check((await p.locator('.image-strip .image-thumb').count()) === 2, 'the Images pill opens the gallery');
    await p.close();
  }
  {
    // Rewind: a message with a checkpoint shows "Rewind to here" on hover; the ⋯ menu lists the checkpoints.
    const p = await open('surface=chat&theme=black-blue&select=chat-c5', 1200, 800);
    const msg = p.locator('.user-msg').first();
    await msg.hover();
    const btn = msg.locator('.rewind-btn');
    check((await btn.count()) === 1 && (await btn.evaluate((b) => window.getComputedStyle(b).opacity)) === '1', 'hovering a message shows Rewind to here');
    await p.screenshot({ path: path.join(os.homedir(), 'code/rewind.png'), animations: 'disabled', caret: 'hide' });
    await btn.click();
    check((await posted(p)).some((m) => m.type === 'rewind' && m.chatId === 'chat-c5' && /^turn-/.test(m.turnId)), 'Rewind to here asks the host for that message');
    await p.click('.chat-head-actions button[aria-label="More"]');
    await p.screenshot({ path: path.join(os.homedir(), 'code/rewind-menu.png'), animations: 'disabled', caret: 'hide' });
    await p.getByRole('menuitem', { name: 'Rewind…' }).click();
    check((await posted(p)).some((m) => m.type === 'rewind' && m.chatId === 'chat-c5' && m.turnId === undefined), 'the ⋯ menu opens the checkpoint list');
    await p.close();
  }
  {
    // The chat list lives in its own side bar view; the chat tab has none, at any width.
    const tab = await open('surface=chat&theme=black-blue&select=chat-c5', 1400, 800);
    check((await tab.locator('.chat-side').count()) === 0, 'the chat tab has no chat list beside it');
    await tab.close();
    const list = await open('surface=chat&theme=black-blue&list=1&select=chat-c5', 300, 800);
    check((await list.locator('.chat-list-view .new-chat').count()) === 1 && (await list.locator('.transcript').count()) === 0, 'the side bar view is the list only');
    await list.locator('.chat-list-view [role="option"]').first().click();
    check((await posted(list)).some((m) => m.type === 'openChat'), 'picking a chat in the list opens it in the chat tab');
    await list.screenshot({ path: path.join(os.homedir(), 'code/chat-list-sidebar.png'), animations: 'disabled' });
    await list.close();
  }
  {
    // Open: on a hand-off or consultation card it shows that chat; from the host it shows one even when archived.
    const p = await open('surface=chat&theme=black-blue&select=chat-c5', 1200, 800);
    // The host's select arrives as a message, so the title is waited for, not read at once.
    const shows = (text) => p.locator('.chat-head-title', { hasText: text }).waitFor({ timeout: 2000 }).then(() => true, () => false);
    await p.locator('.link-card button:has-text("Open")').first().click();
    check((await shows('Make the session store swappable')) && (await posted(p)).some((m) => m.type === 'select' && m.chatId === 'chat-x3'), 'Open on a hand-off card shows that chat');
    await p.locator('.link-card[aria-label="Asked Gemini 4"] button:has-text("Open")').click();
    check(await shows('Which session store fits serverless?'), 'Open on a consultation card shows that chat');
    await p.evaluate(() => window.postMessage({ type: 'select', chatId: 'chat-c7' }, '*'));
    check((await shows('Rename the price helpers')) && (await p.locator('.link-strip .tag:has-text("archived")').count()) === 1, 'Open from a notification shows an archived chat');
    await p.close();
  }
  {
    // The document look: the editor's own background, a plain placeholder, one handoff note, numbered decisions.
    const p = await open('surface=chat&theme=black-blue&select=chat-c5', 1200, 800);
    check(await p.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.background = 'var(--vscode-editor-background)';
      document.body.append(probe);
      const want = window.getComputedStyle(probe).backgroundColor;
      probe.remove();
      return window.getComputedStyle(document.body).backgroundColor === want;
    }), 'the chat background is the editor background exactly');
    check((await p.getAttribute('.composer textarea', 'placeholder')) === 'Message…', 'the placeholder is just Message…');
    check((await p.locator('.link-strip .badge[data-kind="handoff"]').count()) === 0, 'a handoff shows once, as its transcript card');
    await p.close();
    const d = await open('surface=chat&theme=black-blue&select=chat-c2', 1200, 800);
    check((await d.locator('.ask .opt-num').first().innerText()) === '1.', 'decision options are numbered');
    check(await d.evaluate(() => {
      const yes = window.getComputedStyle(document.querySelector('.ask button.decide'));
      const probe = document.createElement('div');
      probe.style.background = 'var(--button-bg)';
      probe.style.color = 'var(--button-fg)';
      document.body.append(probe);
      const want = window.getComputedStyle(probe);
      const others = [...document.querySelectorAll('.ask .actions button:not(.decide)')].map((b) => window.getComputedStyle(b));
      const ok = yes.backgroundColor === want.backgroundColor && yes.color === want.color && others.length > 0 && others.every((o) => o.backgroundColor !== want.backgroundColor && o.boxShadow.includes('inset'));
      probe.remove();
      return ok;
    }), 'the default option is in the button colours; the others are rows on a hairline ring (Claude Code’s card)');
    check((await d.locator('.step-files').count()) === 0 && (await d.locator('.step-target').first().innerText()).includes('src/store.ts'), 'a tool line names its file once, as the link');
    await d.locator('.step-target').first().click();
    check((await posted(d)).some((m) => m.type === 'openFile' && m.path === 'src/store.ts'), 'the path opens the file');
    check((await d.getAttribute('.composer textarea', 'placeholder')) === 'Message…', 'a busy chat’s placeholder is just Message…');
    await d.fill('.composer textarea', 'and then');
    check(await d.locator('.composer-hint:has-text("Sends after this turn · Esc stops")').isVisible(), 'with text in a busy chat, the faint hint says when it sends');
    await d.fill('.composer textarea', '');
    await d.click('.composer textarea');
    // The decision keys wait out a short grace period once a card is marked (security: no retargeting).
    await d.waitForTimeout(650);
    await d.keyboard.press('2');
    const picked = (await posted(d)).find((m) => m.type === 'permission');
    check(picked?.requestId === 'perm-c2' && (await d.inputValue('.composer textarea')) === '', '2 in an empty box picks the second option');
    await d.close();
  }
  for (const [name, theme, width] of [['chat-final-dark', 'black-blue', 1200], ['chat-final-light', 'light-blue', 1200], ['chat-final-narrow', 'black-blue', 480]]) {
    const p = await open(`surface=chat&theme=${theme}&select=chat-c2`, width, 900);
    await p.screenshot({ path: path.join(os.homedir(), `code/${name}.png`), animations: 'disabled', caret: 'hide' });
    await p.close();
  }
  {
    // The composer: centred, 640px at most; one row; orange border on focus.
    for (const width of [480, 900, 1600]) {
      const p = await open('surface=chat&select=chat-c5', width, 700);
      const r = await p.evaluate(() => {
        const c = document.querySelector('.composer').getBoundingClientRect();
        return { w: c.width, left: c.left, right: window.innerWidth - c.right };
      });
      check(r.w <= 680.5 && Math.abs(r.left - r.right) <= 1 && (width > 712 || r.left >= 15.5), `at ${width}px the composer is centred, ${Math.round(r.w)}px wide (<= 680, 16px gutters)`);
      await p.close();
    }
    for (const [width, id] of [[320, 'chat-c6'], [480, 'chat-c6'], [640, 'chat-c6'], [320, 'chat-c5'], [900, 'chat-pay&fixture=subagents']]) {
      // One row: +, /, agents, model on the left; mode then send at the right end.
      const q = await open(`surface=chat&side=1&select=${id}`, width, 700);
      const r = await q.evaluate(() => {
        const box = (s) => document.querySelector(s).getBoundingClientRect();
        const bar = box('.composer-bar'), send = box('.composer-bar .send-btn'), mode = box('.composer-bar .cc-mode');
        const mid = (b) => b.top + b.height / 2;
        const rows = [...document.querySelectorAll('.composer-bar button')].filter((b) => b.offsetWidth).map((b) => Math.round(mid(b.getBoundingClientRect())));
        return { oneRow: Math.max(...rows) - Math.min(...rows) <= 6, modeLeftOfSend: mode.right <= send.left + 0.5 && send.left - mode.right < 12, right: bar.right - send.right };
      });
      check(r.oneRow && r.modeLeftOfSend && r.right <= 8, `at ${width}px (${id}) one row, mode just left of send at the right end [${JSON.stringify(r)}]`);
      await q.close();
    }
    const p = await open('surface=chat&select=chat-c6', 1200, 700);
    check((await p.locator('.cc-mode').innerText()).trim() === 'Auto', 'the mode button reads Auto in Full auto (the agent’s Bypass is no more permissive)');
    // Manual while Claude itself bypasses permissions: the button must say Bypass, loud, and the menu check it.
    await p.evaluate(() => window.postMessage({ type: 'action', action: { t: 'approval', chatId: 'chat-c6', level: 'ask' } }, '*'));
    await p.waitForTimeout(50);
    const warn = p.locator('.cc-mode[data-warn="full"]');
    check((await warn.count()) === 1 && (await warn.innerText()).trim() === 'Bypass permissions', 'Manual + the agent in Bypass permissions: the button reads Bypass permissions, in the warning style');
    check(/won't ask/.test((await warn.getAttribute('title')) ?? ''), 'its tooltip says the agent won’t ask');
    await warn.click();
    check((await p.locator('.cc-modes-menu [role="menuitemradio"][aria-checked="true"]').allInnerTexts()).join().includes('Bypass permissions') && !(await p.locator('.cc-modes-menu [aria-checked="true"]:has(.cc-item-name:text-is("Manual"))').count()), 'the Modes menu checks Bypass permissions, not Manual');
    await p.keyboard.press('Escape');
    await p.evaluate(() => window.postMessage({ type: 'action', action: { t: 'approval', chatId: 'chat-c6', level: 'full' } }, '*'));
    await p.waitForTimeout(50);
    const untitled = await p.evaluate(() => [...document.querySelectorAll('.composer button')].filter((b) => !b.title && !b.getAttribute('aria-label')).length);
    check(untitled === 0, 'every composer control has a tooltip or label');
    await p.evaluate(() => document.activeElement?.blur());
    const border = () => p.evaluate(() => window.getComputedStyle(document.querySelector('.composer')).borderTopColor);
    const idle = await border();
    await p.click('.composer textarea');
    const focused = await border();
    const tone = (v) => p.evaluate((v) => {
      const d = document.createElement('div');
      d.style.color = `var(${v})`;
      document.querySelector('.composer').appendChild(d);
      const c = window.getComputedStyle(d).color;
      d.remove();
      return c;
    }, v);
    // Auto (Full auto): the mode's colour is errorForeground, as in Claude Code; Manual's is the orange accent.
    check(idle !== focused && focused === (await tone('--error')), `focus turns the border the mode's colour (${idle} → ${focused})`);
    const ring = await p.evaluate(() => window.getComputedStyle(document.querySelector('.composer')).boxShadow);
    check(/ 0px 0px 3px/.test(ring) && !ring.includes('rgb(0, 120'), `a 3px halo in the mode's colour, no blue ring [${ring}]`);
    await p.evaluate(() => window.postMessage({ type: 'action', action: { t: 'approval', chatId: 'chat-c6', level: 'ask' } }, '*'));
    await p.waitForTimeout(50);
    await p.close();
    // Agent map: modal with this chat and its agents; each opens its card or chat; Open Agent Manager.
    const ag = await open('surface=chat&select=chat-pay&fixture=subagents', 1200, 800);
    check(/^\d+ agents?$/.test((await ag.locator('.cc-agents').innerText()).trim()), 'the agents pill reads N agents');
    await ag.click('.cc-agents');
    check(await ag.locator('.cc-map[role="dialog"] .cc-map-title:text-is("Agent map")').isVisible(), 'the pill opens the Agent map');
    check(/\d+ agents? · click an agent for details/.test(await ag.locator('.cc-map-sub').innerText()), 'it says how many agents');
    check((await ag.locator('.cc-map-children .cc-map-node').count()) >= 1 && /tool call|tokens/.test(await ag.locator('.cc-map-children .cc-map-meta').first().innerText()), 'children show time and tool calls or tokens');
    await ag.keyboard.press('Escape');
    await ag.waitForTimeout(300);
    await ag.locator('.cc-map').waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
    check(!(await ag.locator('.cc-map').count()), 'Esc closes the map');
    await ag.click('.cc-agents');
    await ag.click('.cc-map-manager');
    check((await posted(ag)).some((m) => m.type === 'openTasks'), 'Open Agent Manager opens it');
    await ag.close();
    const none = await open('surface=chat&select=chat-c4', 1200, 700);
    check((await none.locator('.cc-agents').count()) === 0, 'no agents pill without agents');
    await none.close();
    // Screenshots, comparable with the Claude Code references.
    const shot = async (q, name, sel) => {
      const c = await q.locator('.composer').boundingBox();
      const m = sel && (await q.locator(sel).count()) ? await q.locator(sel).boundingBox() : null;
      const top = Math.max(0, Math.min(c.y, m ? m.y : c.y) - 16);
      const left = Math.max(0, Math.min(c.x, m ? m.x : c.x) - 16);
      const right = Math.max(c.x + c.width, m ? m.x + m.width : 0) + 16;
      const bottom = Math.max(c.y + c.height, m ? m.y + m.height : 0) + 16;
      await q.screenshot({ path: path.join(os.homedir(), `code/${name}.png`), clip: { x: left, y: top, width: right - left, height: bottom - top }, animations: 'disabled', caret: 'hide' });
    };
    for (const [name, theme, id, act, sel] of [
      ['cc-composer', 'black-blue', 'chat-pay&fixture=subagents', 'focus', null],
      ['cc-model-menu', 'black-blue', 'chat-c5', '.cc-model', '.cc-menu'],
      ['cc-modes-menu', 'black-blue', 'chat-c6', '.cc-mode', '.cc-menu'],
      ['cc-slash-menu', 'black-blue', 'chat-c5', '.cc-slash-btn', '.cc-menu'],
      ['cc-model-menu-light', 'light-blue', 'chat-c2', '.cc-model', '.cc-menu'],
    ]) {
      const q = await open(`surface=chat&theme=${theme}&select=${id}`, 1200, 860);
      await q.click('.composer textarea');
      await q.keyboard.type('I want this composer to look like Claude Code’s.');
      if (act !== 'focus') await q.click(act);
      await shot(q, name, sel);
      await q.close();
    }
    const map = await open('surface=chat&theme=black-blue&select=chat-pay&fixture=subagents', 1200, 860);
    await map.click('.cc-agents');
    await map.screenshot({ path: path.join(os.homedir(), 'code/cc-agent-map.png'), animations: 'disabled', caret: 'hide' });
    await map.close();
  }
  for (const width of [320, 480, 700, 1200]) {
    // The message box keeps the composer's width however narrow the panel: the pills shrink, not the text.
    const p = await open('surface=chat&side=1&select=chat-c5', width, 700);
    await p.fill('.composer textarea', 'ok ticket');
    const r = await p.evaluate(() => {
      const box = (s) => document.querySelector(s).getBoundingClientRect();
      const c = box('.composer'), t = box('.composer textarea'), b = box('.composer-bar');
      const kids = [...document.querySelectorAll('.composer-bar button')].map((e) => e.getBoundingClientRect()).filter((k) => k.width > 0).sort((x, y) => x.left - y.left);
      const apart = kids.every((k, i) => i === 0 || k.left >= kids[i - 1].right - 0.5);
      return { apart, ratio: t.width / c.width, barInside: b.right <= c.right + 1 && b.left >= c.left - 1, page: document.documentElement.scrollWidth <= window.innerWidth };
    });
    check(r.ratio >= 0.7, `at ${width}px the message box is ${Math.round(r.ratio * 100)}% of the composer (>= 70%)`);
    check(r.barInside && r.page && r.apart, `at ${width}px the controls don't overlap, stay inside the composer and nothing scrolls sideways`);
    if (width < 1200) await p.screenshot({ path: path.join(os.homedir(), `code/composer-${width}.png`), animations: 'disabled', caret: 'hide' });
    await p.close();
  }
  {
    // The permission card is the review: the diff, Open diff, the loud yes, keys, and the queue.
    const p = await open(`surface=chat&side=1&select=${ids.side}`, 400, 900);
    const card = p.locator('#item-perm-c1');
    check(await card.locator('.diff .dl[data-op="add"]').first().isVisible(), 'the permission card shows the diff');
    check((await card.locator('button.decide').innerText()).replace(/^\d\.\s*/, '').trim() === 'Yes', "the loud button is the one-time yes, not \"don't ask again\"");
    await card.locator('button:has-text("Open diff")').click();
    check((await posted(p)).some((m) => m.type === 'permissionDiff' && m.requestId === 'perm-c1'), 'Open diff asks for the whole file');
    await p.click('.composer textarea');
    await p.waitForTimeout(650);
    await p.keyboard.press('Control+Enter');
    const answer = (await posted(p)).filter((m) => m.type === 'bridge' || m.type === 'permission').at(-1);
    // The keys act on the marked card: the one you last clicked (Open diff, in this card), QA F02.
    check(answer?.type === 'permission' && answer.requestId === 'perm-c1', 'Ctrl+Enter answers the card you were working in');
    check(((await p.locator('.composer-bar button.primary').getAttribute('aria-label')) ?? '') === 'Stop', 'with nothing typed, a busy chat’s send button stops the turn');
    await p.fill('.composer textarea', 'and the tests');
    check(((await p.locator('.composer-bar button.primary').getAttribute('aria-label')) ?? '').includes('Queue'), 'a busy chat queues the message');
    await p.fill('.composer textarea', '');
    await p.click('.bubble.queued button[aria-label="Remove from the queue"]');
    check((await posted(p)).some((m) => m.type === 'unqueue' && m.id === 'queued-c1'), 'a queued message can be removed');
    check(await p.locator('.edits-bar').isVisible(), 'edits waiting get Accept all');
    await p.click('.edits-bar button:has-text("Accept all")');
    check((await posted(p)).some((m) => m.type === 'reviewAll' && m.action === 'accept'), 'Accept all posts for the chat');
    await p.close();
  }
  {
    // A command card offers "Always allow" for the exact line and for program + subcommand.
    const p = await open('surface=chat&side=1&select=chat-c2', 400, 900);
    await p.click('#item-perm-c2 button:has-text("Always allow")');
    check(await p.locator('.popover [role="menuitem"]:has-text("rm src/legacyStore.ts")').isVisible(), 'Always allow offers the exact command');
    await p.click('.popover [role="menuitem"]:has-text("rm src/legacyStore.ts")');
    const rule = (await posted(p)).find((m) => m.type === 'allowAlways');
    check(rule?.requestId === 'perm-c2' && rule.rule.kind === 'exact', 'Always allow posts the rule');
    check((await p.locator('.cc-mode').getAttribute('aria-label')) === 'Mode: Edit automatically' && (await p.locator('.composer').getAttribute('data-mode')) === 'edits', 'the mode button shows the mode in use');
    await p.close();
  }
  {
    // A new task takes each agent's model and effort and an approval level.
    const p = await open('surface=tasks&view=board', 1440, 900);
    check(await p.locator('[data-nav="chat-c6"] .auto-badge').isVisible(), 'a Full auto task shows its badge');
    await p.click('.approval-seg [data-level="edits"]');
    await p.click('.task-options button[aria-label^="Claude Model"]');
    await p.click('.popover [role="menuitemradio"][data-value="small"]');
    await p.fill('.new-task textarea', 'Tidy the README');
    await p.press('.new-task textarea', 'Enter');
    const task = (await posted(p)).find((m) => m.type === 'createTask');
    check(task?.approval === 'edits' && task.choices?.claude?.model === 'small', 'a new task carries its model and approval level');
    await p.close();
    const map = await open('surface=tasks&view=map', 1440, 900);
    check(await map.locator('[data-nav="chat-c6"] .node-auto').count() === 1, 'the map marks a Full auto chat');
    await map.close();
  }

  {
    // Tabs close: an × (hover, active, focus), middle-click, Cmd/Ctrl+W; the chat itself stays in the Chats list.
    const p = await open('surface=chat&theme=dark-2026&select=chat-c5', 1200, 800);
    await p.evaluate(() => {
      window.__forwarded = 0;
      window.addEventListener('keydown', (e) => e.key !== 'Meta' && e.key !== 'Control' && window.__forwarded++);
    });
    const strip = () => p.locator('.tabs [role="tab"]').evaluateAll((ts) => ts.map((t) => t.dataset.chat));
    const before = await strip();
    const closes = await p.locator('.tabs .tab-close').evaluateAll((bs) => bs.map((b) => ({ label: b.getAttribute('aria-label'), title: b.title, w: b.getBoundingClientRect().width })));
    // The × is for the pointer (the keyboard closes the focused tab with Delete, QA F05): titled with both keys.
    check(before.length >= 3 && closes.length === before.length && closes.every((c) => /^Close tab \((⌘|Ctrl\+)W · Delete\)$/.test(c.title) && c.w >= 15.5), `every tab has an × titled with its keys [${closes.length} of ${before.length}]`);
    const opacity = (id) => p.locator(`.tab-wrap:has([data-chat="${id}"]) .tab-close`).evaluate((b) => (new Promise((r) => setTimeout(r, 200))).then(() => window.getComputedStyle(b).opacity));
    const other = before.find((id) => id !== 'chat-c5');
    await p.mouse.move(0, 400);
    check((await opacity('chat-c5')) === '1' && (await opacity(other)) === '0', 'the active tab shows its ×; the others wait for the pointer');
    await p.hover(`.tabs [data-chat="${other}"]`);
    check((await opacity(other)) === '1', 'hovering a tab shows its ×');
    await p.locator(`.tab-wrap:has([data-chat="${other}"]) .tab-close`).click();
    let now = await strip();
    check(!now.includes(other) && (await p.locator('.chat-head-title').innerText()).length > 0 && (await p.locator('.tabs [aria-selected="true"]').getAttribute('data-chat')) === 'chat-c5', '× closes that tab and leaves the open chat as it is');
    check(now.length === before.length - 1 && now.every((id) => before.includes(id)), `closing a tab adds none in its place [${before.length} → ${now.length}]`);
    const third = now.find((id) => id !== 'chat-c5');
    await p.locator(`.tabs [data-chat="${third}"]`).click({ button: 'middle' });
    const was = now;
    now = await strip();
    check(!now.includes(third) && now.length === was.length - 1 && now.every((id) => was.includes(id)), 'a middle-click closes a tab, and nothing takes its place');
    // Cmd/Ctrl+W closes the open chat's tab and shows its right neighbour (else the left), without reaching the editor.
    const order = await strip();
    const at = order.indexOf('chat-c5');
    const expected = order[at + 1] ?? order[at - 1];
    await p.click('.composer textarea');
    await p.keyboard.press('ControlOrMeta+KeyW');
    await p.waitForTimeout(100);
    check(!(await strip()).includes('chat-c5') && (await p.locator('.tabs [aria-selected="true"]').getAttribute('data-chat')) === expected && (await posted(p)).some((m) => m.type === 'select' && m.chatId === expected), `Cmd/Ctrl+W closes the open tab and shows its neighbour (${expected})`);
    check((await p.evaluate(() => window.__forwarded)) === 0, 'Cmd/Ctrl+W never reaches the editor (its own tab stays)');
    const kept = (await p.evaluate(() => window.__vscodeState()?.openTabs)) ?? [];
    check(kept.length === (await strip()).length && !kept.includes('chat-c5'), 'the open tabs are kept in this window’s state');
    // The chats themselves are untouched: still in the Chats list, nothing stopped or archived.
    await p.click('.all-btn');
    const listed = await p.locator('.all-chats [role="option"]').evaluateAll((os) => os.map((o) => o.id));
    check([other, third, 'chat-c5'].every((id) => listed.some((l) => l.endsWith(`-${id}`))) && !(await posted(p)).some((m) => ['stop', 'archive'].includes(m.type)), 'closed tabs stay in the Chats list; nothing is stopped or archived');
    // Opening a chat from the list adds its tab at the end, as a browser does.
    await p.locator(`.all-chats [role="option"][id$="-${other}"]`).click();
    await p.waitForTimeout(100);
    const reopened = await strip();
    check(reopened.at(-1) === other && (await p.locator('.tabs [aria-selected="true"]').getAttribute('data-chat')) === other, 'opening a chat from the list adds its tab at the end');
    await p.screenshot({ path: path.join(os.homedir(), 'code/FriedLiver-Code-design/review/tabs-close.png'), clip: { x: 0, y: 0, width: 1200, height: 140 } }).catch(() => {});
    // More tabs than fit: the strip scrolls sideways, fading at its edges; the tabs keep their size.
    const many = await open('surface=chat&theme=dark-2026&select=chat-c5', 520, 700);
    const fit = await many.evaluate(() => {
      const t = document.querySelector('.tabs');
      return { scrolls: t.scrollWidth > t.clientWidth, fade: window.getComputedStyle(t).maskImage !== 'none', min: Math.min(...[...t.querySelectorAll('.tab-wrap')].map((w) => w.getBoundingClientRect().width)), page: document.documentElement.scrollWidth <= window.innerWidth };
    });
    check(fit.scrolls && fit.fade && fit.min >= 80 && fit.page, `at 520px the tabs scroll sideways with faded edges, none squeezed [${JSON.stringify(fit)}]`);
    await many.close();
        // Close them all: the empty state.
    for (let n = 0; n < 40 && (await p.locator('.tabs .tab-close').count()); n++) await p.locator('.tabs .tab-close').first().click();
    check((await p.locator('.empty').count()) === 1, 'closing the last tab shows the empty state');
    await p.close();
  }
  {
    // A very long message never takes the chat over: 3 lines and Show more, in place and in the sticky copy; the composer caps.
    for (const width of [640, 1200]) {
      const p = await open('surface=chat&theme=dark-2026&fixture=reference&select=chat-long', width, 900);
      // The chat opens at its end, where the sticky copy shows; start at the message itself.
      await p.evaluate(() => (document.querySelector('.transcript').scrollTop = 0));
      await p.waitForTimeout(100);
      const msg = p.locator('.user-msg').first();
      const lines = (sel) => p.locator(sel).first().evaluate((el) => el.getBoundingClientRect().height / parseFloat(window.getComputedStyle(el).lineHeight));
      check((await lines('.user-msg .bubble-text')) <= 3.05, `at ${width}px a 3,000-character message shows 3 lines`);
      const more = msg.locator('.msg-more');
      const corner = await p.evaluate(() => {
        const b = document.querySelector('.user-msg .bubble').getBoundingClientRect();
        const m = document.querySelector('.user-msg .msg-more').getBoundingClientRect();
        return { right: b.right - m.right, bottom: b.bottom - m.bottom };
      });
      check((await more.isVisible()) && (await more.innerText()).trim() === 'Show more' && (await more.getAttribute('aria-expanded')) === 'false' && corner.right >= 0 && corner.right < 16 && corner.bottom >= 0 && corner.bottom < 12, `at ${width}px Show more sits at the bottom right [${JSON.stringify(corner)}]`);
      // No glyph under it: its box starts below the text's last shown line.
      const clear = (scope) =>
        p.evaluate((scope) => {
          const box = document.querySelector(`${scope} .bubble-text`).getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(document.querySelector(`${scope} .bubble-text`));
          const lines = [...range.getClientRects()].filter((r) => r.width && r.bottom <= box.bottom + 0.5 && r.top >= box.top - 0.5);
          const b = document.querySelector(`${scope} .msg-more`).getBoundingClientRect();
          return lines.length > 0 && lines.every((r) => r.bottom <= b.top + 0.5 || r.top >= b.bottom - 0.5 || r.right <= b.left || r.left >= b.right);
        }, scope);
      check(await clear('.user-msg'), `at ${width}px Show more covers no text`);
      if (width === 1200) await p.screenshot({ path: path.join(os.homedir(), 'code/FriedLiver-Code-design/review/long-message-collapsed.png') }).catch(() => {});
      await more.click();
      check((await lines('.user-msg .bubble-text')) > 3.5 && (await more.innerText()).trim() === 'Show less' && (await more.getAttribute('aria-expanded')) === 'true', `at ${width}px Show more expands it in place and reads Show less`);
      if (width === 1200) await p.screenshot({ path: path.join(os.homedir(), 'code/FriedLiver-Code-design/review/long-message-expanded.png') }).catch(() => {});
      // Scrolled past, the sticky copy stays at 3 lines and under 30% of the view, even with the message expanded.
      await p.evaluate(() => {
        const t = document.querySelector('.transcript');
        t.scrollTop += document.querySelector('.user-msg').getBoundingClientRect().bottom - t.getBoundingClientRect().top + 400;
      });
      await p.waitForTimeout(150);
      const sticky = p.locator('.sticky-prompt');
      const sh = await sticky.evaluate((el) => el.getBoundingClientRect().height).catch(() => -1);
      check(sh > 0 && sh <= 0.3 * 900 && (await lines('.sticky-prompt .bubble-text')) <= 3.05, `at ${width}px the sticky copy is 3 lines, ${Math.round(sh)}px (<= 30% of the view)`);
      check(await clear('.sticky-prompt'), `at ${width}px the sticky copy's Show more covers no text`);
      // Collapse the in-flow one again without scrolling to it (a pointer click would bring it back into view).
      await more.evaluate((b) => b.click());
      await p.waitForTimeout(100);
      await sticky.locator('.msg-more').click();
      await p.waitForTimeout(400);
      const back = await p.evaluate(() => {
        const t = document.querySelector('.transcript').getBoundingClientRect();
        const m = document.querySelector('.user-msg').getBoundingClientRect();
        return m.top >= t.top - 1 && m.top < t.top + 60;
      });
      check(back && (await more.getAttribute('aria-expanded')) === 'true', `at ${width}px the sticky copy's Show more scrolls to the message and expands it there`);
      check((await more.focus().then(() => p.keyboard.press('Enter')).then(() => more.getAttribute('aria-expanded'))) === 'false', `at ${width}px Show less works from the keyboard`);
      // A 5,000-character paste: the box scrolls inside, the composer stays under 40% of the panel, the transcript stays on screen.
      await p.fill('.composer textarea', 'x'.repeat(40).concat(' ').repeat(122).slice(0, 5000));
      await p.waitForTimeout(100);
      const box = await p.evaluate(() => {
        const ta = document.querySelector('.composer textarea');
        return { composer: document.querySelector('.composer').getBoundingClientRect().height, transcript: document.querySelector('.transcript').getBoundingClientRect().height, scrolls: ta.scrollHeight > ta.clientHeight + 1, lines: ta.clientHeight / parseFloat(window.getComputedStyle(ta).lineHeight) };
      });
      check(box.scrolls && box.lines <= 9.1 && box.composer <= 0.4 * 900 && box.transcript >= 0.3 * 900, `at ${width}px a 5,000-character paste scrolls inside the box: composer ${Math.round(box.composer)}px (<= 40%), transcript ${Math.round(box.transcript)}px`);
      await p.close();
    }
  }
  {
    // Board polish: one tidy action row (the primary action, connections on hover or focus, ⋯ for the rest);
    // other chats by their topic, never "Claude 1"; calm cards (12px rhythm, one meta line, titles at most two lines).
    const p = await open('surface=tasks&theme=dark-2026&view=board', 1440, 900);
    const rows = await p.evaluate(() =>
      [...document.querySelectorAll('.task-card .card-actions')].map((a) => {
        const mids = [...a.querySelectorAll('button')].filter((b) => b.offsetWidth).map((b) => b.getBoundingClientRect()).map((r) => r.top + r.height / 2);
        return { spread: Math.max(...mids) - Math.min(...mids), h: a.getBoundingClientRect().height };
      }),
    );
    check(rows.length > 0 && rows.every((r) => r.spread <= 4 && r.h <= 30), `every card's actions are one row [${rows.map((r) => Math.round(r.h)).join(', ')}]`);
    const card = p.locator('[data-nav="chat-g1"]');
    // After the .15s fade.
    const shown = async () => (await p.waitForTimeout(250), card.locator('.card-connect').evaluate((el) => window.getComputedStyle(el).opacity));
    await p.mouse.move(0, 0);
    check((await shown()) === '0', 'Hand off, Ask and Pipe to wait out of sight');
    await card.hover();
    check((await shown()) === '1', 'they show on hover');
    await p.mouse.move(0, 0);
    await card.focus();
    check((await shown()) === '1', 'and when the card has keyboard focus');
    await card.locator('.card-more').click();
    const items = await p.locator('.popover[role="menu"] [role^="menuitem"]').allInnerTexts();
    check(['Open chat', 'View changes', 'Ask another agent…'].every((t) => items.some((i) => i.includes(t))) && items.some((i) => i.includes('Claude')) && items.some((i) => i.includes('Rename')), `⋯ holds Open, View changes, Hand off, Ask, Pipe to and the rest [${items.join(' | ')}]`);
    check((await p.locator('.popover .pop-title:text-is("Hand off to")').count()) === 1 && (await p.locator('.popover .pop-title:has-text("Send each finished turn to")').count()) === 1, '⋯ lists Hand off to and Pipe to');
    await p.keyboard.press('Escape');
    const calm = await p.evaluate(() => {
      const c = document.querySelector('.task-card');
      const cs = window.getComputedStyle(c);
      const metas = [...document.querySelectorAll('.task-card .card-meta')].map((m) => m.getBoundingClientRect().height / parseFloat(window.getComputedStyle(m).lineHeight));
      const titles = [...document.querySelectorAll('.task-card .card-title')].map((t) => t.getBoundingClientRect().height / parseFloat(window.getComputedStyle(t).lineHeight));
      return { pad: cs.paddingTop, side: cs.paddingLeft, gap: cs.rowGap, metas, titles };
    });
    check(calm.pad === '12px' && calm.side === '12px' && calm.gap === '12px', `cards keep a 12px rhythm [${calm.pad} ${calm.side} ${calm.gap}]`);
    check(calm.metas.length > 0 && calm.metas.every((n) => n <= 1.05), `files, turns and age are one muted line [${calm.metas.map((n) => n.toFixed(2))}]`);
    check(calm.titles.every((n) => n <= 2.05), `titles take at most two lines [${calm.titles.map((n) => n.toFixed(2))}]`);
    await p.close();
    for (const view of ['board', 'list', 'map']) {
      const q = await open(`surface=tasks&theme=dark-2026&view=${view}`, 1440, 900);
      if (view === 'map') await q.hover('[data-nav="chat-c1"]');
      const labels = await q.evaluate(() => document.querySelector('.manager').innerText.match(/\b(Claude|Codex|Gemini|Demo) \d+\b/g) ?? []);
      check(labels.length === 0, `the ${view} names chats by topic, never by label [${labels.slice(0, 5)}]`);
      await q.close();
    }
  }
  {
    // Nothing spills out of a card, list row or map node, at any card width: pills shrink, wrap or cut with an ellipsis.
    const spills = (p, container) =>
      p.evaluate((sel) => {
        const out = [];
        for (const box of document.querySelectorAll(sel)) {
          const r = box.getBoundingClientRect();
          const cs = window.getComputedStyle(box);
          const inner = { left: r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft), right: r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight) };
          for (const el of box.querySelectorAll('*')) {
            const e = el.getBoundingClientRect();
            if (!e.width || window.getComputedStyle(el).position === 'fixed' || el.closest('.popover')) continue;
            if (e.left < inner.left - 0.5 || e.right > inner.right + 0.5) out.push(`${el.className || el.tagName} in ${box.getAttribute('data-nav') ?? sel} by ${Math.round(Math.max(inner.left - e.left, e.right - inner.right))}px`);
          }
        }
        return out;
      }, container);
    for (const width of [280, 360, 480]) {
      const board = await open('surface=tasks&theme=dark-2026&view=board', 1440, 900);
      await board.addStyleTag({ content: `.columns { grid-template-columns: repeat(var(--cols, 3), ${width}px) !important; }` });
      const bad = await spills(board, '.task-card');
      check(bad.length === 0, `board cards ${width}px wide: nothing spills out [${bad.slice(0, 4).join('; ')}]`);
      await board.close();
      // The list and the map at a viewport as narrow as the card.
      for (const view of ['list', 'map']) {
        const q = await open(`surface=tasks&theme=dark-2026&view=${view}`, width + 400, 900);
        const sel = view === 'list' ? '.chat-table td' : '.map-node';
        const out = view === 'list' ? await spills(q, sel) : await q.evaluate(() => {
          const out = [];
          for (const node of document.querySelectorAll('.map-node')) {
            const box = node.querySelector('.box')?.getBoundingClientRect();
            if (!box) continue;
            for (const t of node.querySelectorAll('text')) {
              const e = t.getBoundingClientRect();
              if (e.width && (e.left < box.left - 0.5 || e.right > box.right + 0.5)) out.push(`${t.textContent} by ${Math.round(Math.max(box.left - e.left, e.right - box.right))}px`);
            }
          }
          return out;
        });
        check(out.length === 0, `${view} at ${width + 400}px: nothing spills out of its ${view === 'list' ? 'cells' : 'nodes'} [${out.slice(0, 4).join('; ')}]`);
        await q.close();
      }
    }
  }
  {
    // Steps read as one line each and open to something you can use; replies keep their shape.
    const p = await open('surface=chat&side=1&fixture=steps', 460, 900);
    const row = (text) => p.locator(`.tl-step:has(.step-text:text("${text}"))`);
    const rows = await p.locator('.tl-step .step-row').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
    check(rows.length >= 8 && rows.every((h) => h <= 26), `every step is one line (${rows.join(', ')} px)`);
    const tagSameRow = await p.locator('.tl-step .step-row').evaluateAll((els) =>
      els.every((el) => {
        const tag = el.querySelector('.step-end .tag');
        const dot = el.querySelector('.dot');
        if (!tag || !dot) return true;
        const a = tag.getBoundingClientRect();
        const b = dot.getBoundingClientRect();
        return Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) < 6;
      }),
    );
    check(tagSameRow, 'the kind tag sits on the row of its dot');
    check((await row('cat << EOF | python3 minidb.py').locator('.step-lines').innerText()) === '15 lines', 'a heredoc command shows its line count');
    check(await p.locator('.tl-step:has(.step-verb:text-is("Write")):has(.step-text:text-is("README.md"))').count() === 1, 'cat << EOF > README.md reads as Write README.md');
    check((await row('python3 minidb.py test.sql 2>&1').locator('.step-main').getAttribute('title'))?.includes(`cd ${STEPS_ROOT} && python3`) ?? false, 'the tooltip has the full command');
    check(await p.locator('.tl-step[data-open]:has(.tag.bad:text("exit 2"))').count() === 1, 'a failed step opens with its exit code');
    const answered = p.locator('.answered:has(.step-label)');
    check((await answered.count()) === 1 && (await answered.evaluate((el) => Math.round(el.getBoundingClientRect().height))) <= 26, 'an answered request for a long command is one line');
    await row('cat << EOF | python3 minidb.py').locator('.step-main').click();
    const opened = p.locator('.tl-step[data-open]:has(.step-text:text("cat << EOF | python3 minidb.py"))');
    check((await opened.locator('.step-command pre.code').innerText()) === COMMANDS.users, 'the command shows in full with every line');
    check((await opened.locator('.step-command pre.code').evaluate((el) => window.getComputedStyle(el).whiteSpace)) === 'pre', 'the command never wraps');
    check(await opened.locator('.step-output pre.code.capped').count() === 1, 'long output starts capped');
    await opened.locator('.step-output button:has-text("Show all")').click();
    check(await opened.locator('.step-output pre.code.capped').count() === 0, 'Show all opens the whole output');
    await opened.locator('.step-command button[aria-label="Copy command"]').click();
    check((await posted(p)).some((m) => m.type === 'copy' && m.text === COMMANDS.users), 'Copy copies the exact command');
    await opened.locator('.step-command .run-btn').click();
    check((await posted(p)).some((m) => m.type === 'runInTerminal' && m.chatId === 'chat-sql' && m.command === COMMANDS.users), 'Run in terminal sends the exact command');
    const readme = p.locator('.tl-step:has(.step-verb:text-is("Write")):has(.step-text:text-is("README.md"))');
    await readme.locator('.step-main').click();
    check((await readme.locator('.step-file .file-name').innerText()).includes('README.md'), 'a heredoc write shows the file it writes');
    check((await readme.locator('.step-file pre.code').innerText()).startsWith('# Mini SQL Database Engine'), 'the file text shows without the command around it');
    await readme.locator('.step-file button:has-text("Open file")').click();
    check((await posted(p)).some((m) => m.type === 'openFile' && m.path === `${STEPS_ROOT}/README.md`), 'Open file opens the file in the workspace');

    const reply = p.locator('.prose .md').last();
    check(await reply.locator('h5.md-label:text-is("FEATURES IMPLEMENTED & VERIFIED")').count() === 1, 'a capitals label is a heading');
    check(await reply.locator('li[data-tone="ok"] > ul > li:text("CREATE TABLE (INT, TEXT, FLOAT types)")').count() === 1, '- items nest under a ✓ item');
    check(await reply.locator('ol > li > ul > li[data-tone="ok"]:has-text("CREATE TABLE × 2")').count() === 1, '✓ items nest under a numbered item');
    check(await reply.locator('li[data-tone="bad"] > .li-mark:text-is("✗")').count() === 1, '✗ keeps its symbol');
    check(await reply.locator('.md-table th:text-is("Lines")').count() === 1, 'a table renders as a table');
    check(await reply.locator('p br').count() >= 3, 'single newlines stay line breaks');
    await reply.locator('.path-link:text-is("' + `${STEPS_ROOT}/README.md:12` + '")').click();
    check((await posted(p)).some((m) => m.type === 'openFile' && m.path === `${STEPS_ROOT}/README.md` && m.line === 12), 'a path with a line opens there');
    await reply.locator('.path-link.outside:text-is("/tmp/minidb-history.txt")').click();
    check((await posted(p)).some((m) => m.type === 'copy' && m.text === '/tmp/minidb-history.txt'), 'a path outside the workspace copies');
    check((await reply.innerText()).includes('(561 lines)'), 'numbers stay plain');
    const block = reply.locator('.code-block');
    check((await block.locator('.code-lang').innerText()) === 'bash' && (await block.locator('.tk-fn').count()) > 0, 'a code block has its language and colours');
    await block.locator('.run-btn').click();
    check((await posted(p)).some((m) => m.type === 'runInTerminal' && m.command === `cd ${STEPS_ROOT} && python3 minidb.py test.sql`), 'a bash block runs in a terminal');
    await p.close();
  }

  await browser.close();
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
    process.exitCode = 1;
  }
}
