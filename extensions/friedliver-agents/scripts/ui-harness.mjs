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

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fixture } from './ui-fixture.mjs';

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
  const data = params.get('empty') === '1' ? { state: { chats: [], images: [], links: [] } } : fixture(Date.now());
  const snapshot = { type: 'snapshot', state: data.state, selected: params.get('select') ?? undefined, now: Date.now() };
  const saved = params.get('view') ? { view: params.get('view') } : undefined;
  const stub = `
    window.__posted = [];
    let saved = ${JSON.stringify(saved ?? null)};
    const snapshot = ${JSON.stringify(snapshot).replace(/</g, '\\u003c')};
    window.acquireVsCodeApi = () => ({
      postMessage(m) {
        window.__posted.push(m);
        if (m && m.type === 'ready') setTimeout(() => window.postMessage(snapshot, '*'), 0);
      },
      getState: () => saved ?? undefined,
      setState: (s) => { saved = s; },
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
<body class="vscode-${theme.kind}" data-surface="${surface}">
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
  const browser = await chromium.launch();
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
    }
    await side.close();
    const center = await open(`surface=chat&theme=${theme}&select=${ids.center}`, 1000, 900);
    await save(center, `chat-center-${theme}`);
    await center.close();
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
    check((await p.locator('.composer-bar button.primary').innerText()).includes('Ask Gemini'), 'the send button reads Ask Gemini');
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

  await browser.close();
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
    process.exitCode = 1;
  }
}
