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
      await side.click('.approval-chip');
      await save(side, `chat-approval-menu-${theme}`);
      await side.keyboard.press('Escape');
      await side.click('.chip-btn:has(.chip-text:text-is("Default"))');
      await save(side, `chat-model-menu-${theme}`);
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
    await steps.click('.steps li:has(.step-text:text("cat << EOF | python3 minidb.py")) .step-main');
    await steps.click('.steps li:has(.step-verb:text-is("Write")):has(.step-text:text-is("README.md")) .step-main');
    await steps.evaluate(() => document.querySelector('.steps li[data-open]')?.scrollIntoView({ block: 'start' }));
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

    const trigger = p.locator(`[data-nav="chat-c3"] button[aria-haspopup="menu"]:has-text("Hand off")`);
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
    await p.click('.approval-chip');
    check(await p.locator('.popover [role="menuitemradio"]:has-text("Auto-accept edits")').isVisible(), 'the approval chip lists the levels');
    check(await p.locator('.popover .menu-sub:has-text("Claude: Accept edits")').isVisible(), 'each level says which of the agent’s modes it uses');
    await p.click('.popover [role="menuitemradio"]:has-text("Auto-accept edits")');
    check(JSON.stringify(await last()) === JSON.stringify({ type: 'approval', chatId: 'chat-c5', level: 'edits' }), 'picking a level posts it');
    await p.click('.approval-chip');
    await p.click('.popover [role="menuitemcheckbox"]:has-text("Plan first")');
    check(JSON.stringify(await last()) === JSON.stringify({ type: 'plan', chatId: 'chat-c5', on: true }), 'Plan first turns Plan mode on');
    await p.click('.approval-chip');
    await p.click('.popover [role="menuitemradio"]:has(.menu-label:text-is("Bypass permissions"))');
    const mode = await last();
    check(mode?.type === 'setOption' && mode.optionId === 'mode' && mode.value === 'bypassPermissions', 'an agent mode is set as its own option');
    await p.click('.chip-btn:has(.chip-text:text-is("Default"))');
    await p.click('.popover [role="menuitemradio"]:has-text("Small")');
    const model = await last();
    check(model?.type === 'setOption' && model.optionId === 'model' && model.value === 'small', 'picking a model posts setOption');
    await p.click('.chip-btn:has(.chip-text:text-is("Medium"))');
    await p.click('.popover [role="menuitemradio"]:has-text("Max")');
    const effort = await last();
    check(effort?.optionId === 'effort' && effort.value === 'max', 'picking an effort level posts setOption');
    await p.click('.chip-btn:has(.chip-text:text-is("Default"))');
    await p.click('.popover [role="menuitemcheckbox"]:has-text("Fast mode")');
    const fast = await last();
    check(fast?.optionId === 'fast' && fast.value === true, 'Fast mode toggles as a boolean');
    await p.click('.composer textarea');
    await p.keyboard.press('Shift+Tab');
    check(JSON.stringify(await last()) === JSON.stringify({ type: 'approval', chatId: 'chat-c5', level: 'edits' }), 'Shift+Tab moves to the next level');
    check((await p.locator('.usage').getAttribute('title'))?.includes('12k of 200k tokens') ?? false, 'the usage meter shows the context used');

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
    // The mic: macOS only. No programmatic start beeps; it focuses the box and says Fn Fn, with a settings link.
    const p = await open('surface=chat&side=1&select=chat-c5', 900, 700);
    await p.click('.mic-btn');
    check(!(await posted(p)).some((m) => m.type === 'dictate'), 'the mic no longer asks the app to start dictation (it beeped)');
    check(await p.evaluate(() => document.activeElement?.matches('.composer textarea') ?? false), 'the mic focuses the message box');
    check(await p.locator('.mic-hint:has-text("Press Fn twice to dictate")').isVisible(), 'the mic shows the Fn Fn hint');
    await p.click('.mic-hint a');
    check((await posted(p)).some((m) => m.type === 'dictationSettings'), 'the hint opens Dictation settings');
    await p.close();
    const linux = await open('surface=chat&side=1&select=chat-c5&platform=linux', 400, 700);
    check((await linux.locator('.mic-btn').count()) === 0, 'no mic off macOS');
    await linux.close();
  }
  {
    // The composer: centred, 640px at most; plain-word labels; mode border; blue focus ring.
    for (const width of [480, 900, 1600]) {
      const p = await open('surface=chat&select=chat-c5', width, 700);
      const r = await p.evaluate(() => {
        const c = document.querySelector('.composer').getBoundingClientRect();
        return { w: c.width, left: c.left, right: window.innerWidth - c.right };
      });
      check(r.w <= 640.5 && Math.abs(r.left - r.right) <= 1 && (width > 672 || r.left >= 15.5), `at ${width}px the composer is centred, ${Math.round(r.w)}px wide (<= 640)`);
      await p.close();
    }
    for (const [width, id] of [[480, 'chat-c6'], [640, 'chat-c6'], [672, 'chat-c6'], [900, 'chat-c6'], [480, 'chat-c5'], [900, 'chat-c5']]) {
      // The send/queue button stays on the first row, level with the mode pill, at the right end.
      const q = await open(`surface=chat&select=${id}`, width, 700);
      const r = await q.evaluate(() => {
        const box = (s) => document.querySelector(s).getBoundingClientRect();
        const send = box('.composer-bar .send-btn'), mode = box('.composer-bar .approval-chip'), bar = box('.composer-bar');
        return { top: Math.abs(send.top + send.height / 2 - (mode.top + mode.height / 2)), right: bar.right - send.right };
      });
      check(r.top <= 6 && r.right <= 2, `at ${width}px (${id}) [${JSON.stringify(r)}] send sits on the mode pill's row at the right end`);
      await q.close();
    }
    const p = await open('surface=chat&select=chat-c5', 1200, 700);
    const usage = p.locator('.composer-bar .usage');
    check(/^Context \d+%/.test(await usage.innerText()), 'context usage reads "Context N%"');
    check(/% of the model's context window used/.test((await usage.getAttribute('title')) ?? ''), 'its tooltip says what the percentage is');
    check(/this chat/.test(await usage.innerText()), 'the cost reads "$x this chat"');
    check(await p.locator('.approval-chip .chip-text').isVisible(), 'the mode dot has its label');
    const untitled = await p.evaluate(() => [...document.querySelectorAll('.composer-bar button')].filter((b) => !b.title && !b.getAttribute('aria-label')).length);
    check(untitled === 0, 'every composer control has a tooltip or label');
    const ring = () => p.evaluate(() => window.getComputedStyle(document.querySelector('.composer')).boxShadow);
    await p.evaluate(() => document.activeElement?.blur());
    check((await ring()) === 'none', 'no ring unfocused');
    await p.click('.composer textarea');
    check(/^rgba?\(.*\) 0px 0px 0px 2px$/.test(await ring()), 'focus draws a 2px ring');
    await p.close();
    const colour = async (id) => {
      const q = await open(`surface=chat&select=${id}`, 1200, 700);
      const out = await q.evaluate(() => [document.querySelector('.composer').dataset.mode, window.getComputedStyle(document.querySelector('.composer')).borderTopColor]);
      await q.close();
      return out;
    };
    const [ask, edits, full] = [await colour('chat-c5'), await colour('chat-c2'), await colour('chat-c6')];
    check(ask[0] === 'ask' && edits[0] === 'edits' && full[0] === 'full', 'the composer names its mode: ask, edits, full');
    check(new Set([ask[1], edits[1], full[1]]).size === 3, `each mode has its own border colour (${ask[1]} / ${edits[1]} / ${full[1]})`);
    for (const [name, theme, id] of [['composer-clarity-dark', 'black-blue', 'chat-c5'], ['composer-clarity-light', 'light-blue', 'chat-c2'], ['composer-clarity-fullauto', 'black-blue', 'chat-c6']]) {
      const q = await open(`surface=chat&theme=${theme}&select=${id}`, 1200, 520);
      const clip = async () => {
        const b = await q.locator('.composer').boundingBox();
        return { x: b.x - 24, y: b.y - 40, width: b.width + 48, height: b.height + 56 };
      };
      await q.evaluate(() => document.activeElement?.blur());
      const unfocused = await q.screenshot({ clip: await clip(), animations: 'disabled', caret: 'hide' });
      await q.click('.composer textarea');
      await q.click('.mic-btn');
      const focused = await q.screenshot({ clip: await clip(), animations: 'disabled', caret: 'hide' });
      // Unfocused above focused, one image.
      await q.setContent(`<body style="margin:0;padding:16px;background:#888;display:grid;gap:16px"><img src="data:image/png;base64,${unfocused.toString('base64')}"><img src="data:image/png;base64,${focused.toString('base64')}"></body>`);
      await q.screenshot({ path: path.join(os.homedir(), `code/${name}.png`), fullPage: true });
      await q.close();
    }
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
      probe.style.background = 'var(--c-surface)';
      probe.style.borderColor = 'var(--c-acc)';
      document.body.append(probe);
      const want = window.getComputedStyle(probe);
      const ok = yes.backgroundColor === want.backgroundColor && yes.borderTopColor === want.borderTopColor;
      probe.remove();
      return ok;
    }), 'the recommended option is a neutral surface with the accent border, not a fill');
    check((await d.locator('.step-files').count()) === 0 && (await d.locator('.step-target').first().innerText()).includes('src/store.ts'), 'a tool line names its file once, as the link');
    await d.locator('.step-target').first().click();
    check((await posted(d)).some((m) => m.type === 'openFile' && m.path === 'src/store.ts'), 'the path opens the file');
    check((await d.getAttribute('.composer textarea', 'placeholder')) === 'Message…', 'a busy chat’s placeholder is just Message…');
    await d.fill('.composer textarea', 'and then');
    check(await d.locator('.composer-hint:has-text("Sends after this turn · Esc stops")').isVisible(), 'with text in a busy chat, the faint hint says when it sends');
    await d.fill('.composer textarea', '');
    await d.click('.composer textarea');
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
    await p.keyboard.press('Control+Enter');
    const answer = (await posted(p)).filter((m) => m.type === 'bridge' || m.type === 'permission').at(-1);
    check(answer?.type === 'bridge' && answer.answer === 'allow', 'Ctrl+Enter answers the first waiting decision');
    check(((await p.locator('.composer-bar button.primary').getAttribute('aria-label')) ?? '').includes('Queue'), 'a busy chat queues the message');
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
    check(await p.locator('.mode-badge[data-tone="edits"]').isVisible(), 'the header shows the mode the agent reports');
    await p.close();
  }
  {
    // A new task takes each agent's model and effort and an approval level.
    const p = await open('surface=tasks&view=board', 1440, 900);
    check(await p.locator('[data-nav="chat-c6"] .auto-badge').isVisible(), 'a Full auto task shows its badge');
    await p.click('.approval-seg [data-level="edits"]');
    await p.selectOption('.task-options select[aria-label="Claude Model"]', 'small');
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
    // Steps read as one line each and open to something you can use; replies keep their shape.
    const p = await open('surface=chat&side=1&fixture=steps', 460, 900);
    const row = (text) => p.locator(`.steps li:has(.step-text:text("${text}"))`);
    const rows = await p.locator('.steps .step-row').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
    check(rows.length >= 8 && rows.every((h) => h <= 26), `every step is one line (${rows.join(', ')} px)`);
    const tagSameRow = await p.locator('.steps .step-row').evaluateAll((els) =>
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
    check(await p.locator('.steps li:has(.step-verb:text-is("Write")):has(.step-text:text-is("README.md"))').count() === 1, 'cat << EOF > README.md reads as Write README.md');
    check((await row('python3 minidb.py test.sql 2>&1').locator('.step-main').getAttribute('title'))?.includes(`cd ${STEPS_ROOT} && python3`) ?? false, 'the tooltip has the full command');
    check(await p.locator('.steps li[data-open]:has(.tag.bad:text("exit 2"))').count() === 1, 'a failed step opens with its exit code');
    const answered = p.locator('.answered:has(.step-label)');
    check((await answered.count()) === 1 && (await answered.evaluate((el) => Math.round(el.getBoundingClientRect().height))) <= 26, 'an answered request for a long command is one line');
    await row('cat << EOF | python3 minidb.py').locator('.step-main').click();
    const opened = p.locator('.steps li[data-open]:has(.step-text:text("cat << EOF | python3 minidb.py"))');
    check((await opened.locator('.step-command pre.code').innerText()) === COMMANDS.users, 'the command shows in full with every line');
    check((await opened.locator('.step-command pre.code').evaluate((el) => window.getComputedStyle(el).whiteSpace)) === 'pre', 'the command never wraps');
    check(await opened.locator('.step-output pre.code.capped').count() === 1, 'long output starts capped');
    await opened.locator('.step-output button:has-text("Show all")').click();
    check(await opened.locator('.step-output pre.code.capped').count() === 0, 'Show all opens the whole output');
    await opened.locator('.step-command button[aria-label="Copy command"]').click();
    check((await posted(p)).some((m) => m.type === 'copy' && m.text === COMMANDS.users), 'Copy copies the exact command');
    await opened.locator('.step-command .run-btn').click();
    check((await posted(p)).some((m) => m.type === 'runInTerminal' && m.chatId === 'chat-sql' && m.command === COMMANDS.users), 'Run in terminal sends the exact command');
    const readme = p.locator('.steps li:has(.step-verb:text-is("Write")):has(.step-text:text-is("README.md"))');
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
