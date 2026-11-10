#!/usr/bin/env node
/* global fetch -- Node 18+ has it; the eslint config predates it for scripts */
// FriedLiver's agent UI as a static website: every webview surface (chat, Agent Manager, inbox, /discuss,
// Welcome, Agents & Accounts, permissions) in FriedLiver Dark and Light, rendered from the UI harness's
// fixtures (ui-harness.mjs), with a gallery page linking them. Not shipped with the extension; it is how the
// design is looked at and reviewed in a browser (and deployed to Vercel, see vercel.json at the repo root).
//
//   node esbuild.mjs && node scripts/web-export.mjs [--out web-dist] [--port 5199]
//
// Each page is the harness's own HTML with its absolute /media/ links made relative, plus a prelude that
// (1) moves the fixture's timestamps to the viewer's clock, so "20s ago" still reads 20s ago a week after the
// build, and (2) answers the Images view's thumbnail requests with a drawn stand-in (a static site has no host).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts } = parseArgs({ options: { out: { type: 'string', default: path.join(ext, 'web-dist') }, port: { type: 'string', default: '5199' } } });
const out = path.resolve(opts.out);

/** [file, title, group, harness query]. Each is exported in both themes as <file>-dark.html and <file>-light.html. */
export const PAGES = [
  ['chat', 'Chat', 'Chat', 'surface=chat&select=chat-c1'],
  ['chat-side', 'Chat in the side bar', 'Chat', 'surface=chat&side=1&select=chat-c1'],
  ['chat-steps', 'A long run of steps', 'Chat', 'surface=chat&fixture=steps'],
  ['approvals', 'Approvals at every weight', 'Chat', 'surface=chat&fixture=approvals'],
  ['discuss', '/discuss: split', 'Chat', 'surface=chat&fixture=discuss&select=chat-split'],
  ['discuss-running', '/discuss: running', 'Chat', 'surface=chat&fixture=discuss&select=chat-main'],
  ['agent-errors', 'Agent errors', 'Chat', 'surface=chat&fixture=agent-errors'],
  ['manager-board', 'Agent Manager: board', 'Agent Manager', 'surface=tasks&view=board'],
  ['manager-list', 'Agent Manager: list', 'Agent Manager', 'surface=tasks&view=list'],
  ['manager-map', 'Agent Manager: map', 'Agent Manager', 'surface=tasks&view=map'],
  ['inbox', 'Decision inbox', 'Agent Manager', 'surface=tasks&fixture=inbox&view=inbox'],
  ['welcome', 'Welcome', 'Pages', 'surface=welcome'],
  ['welcome-first', 'Welcome, first run', 'Pages', 'surface=welcome&empty=1&firstRun=1'],
  ['accounts', 'Agents & Accounts', 'Pages', 'surface=accounts'],
  ['permissions', 'Manage permissions', 'Pages', 'surface=permissions&fixture=permissions'],
];
const THEMES = [
  ['dark', 'Dark'],
  ['light', 'Light'],
];

const prelude = (built) => `<script>
(() => {
  // The fixture was written at ${new Date(built).toISOString()}; move its times to now.
  const shift = Date.now() - ${built};
  const isTime = (v) => typeof v === 'number' && v > 1.5e12 && v < 4e12;
  const move = (v, depth = 0) => {
    if (depth > 40 || v === null || typeof v !== 'object') return isTime(v) ? v + shift : v;
    if (Array.isArray(v)) return v.map((x) => move(x, depth + 1));
    const o = {};
    for (const k of Object.keys(v)) o[k] = move(v[k], depth + 1);
    return o;
  };
  const post = window.postMessage.bind(window);
  window.postMessage = (m, target, transfer) => post(move(m), target, transfer);
  // No host behind a static page: the Images view's files are drawn stand-ins.
  const get = window.fetch.bind(window);
  window.fetch = (url, init) => String(url).startsWith('/host-image') ? Promise.resolve(new Response('{"standIn":true}', { headers: { 'content-type': 'application/json' } })) : get(url, init);
})();
</script>`;

function gallery(built) {
  const groups = [...new Set(PAGES.map((p) => p[2]))];
  const card = ([file, title]) =>
    `<li><span class="t">${title}</span><span class="links">${THEMES.map(([t, name]) => `<a href="${file}-${t}.html">${name}</a>`).join('')}</span></li>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="FriedLiver's agent UI (design v3 Mono), every surface in FriedLiver Dark and Light.">
<title>FriedLiver UI</title>
<link rel="stylesheet" href="media/fonts.css">
<style>
  :root { color-scheme: dark; --bg: #0b0b0b; --page: #151515; --line: #262626; --fg: #e9e9e9; --fg-2: #adadad; --accent: #ebebeb; --ink: #0a0a0a; }
  @media (prefers-color-scheme: light) { :root { color-scheme: light; --bg: #f4f4f4; --page: #fdfdfd; --line: #e2e2e2; --fg: #232323; --fg-2: #575757; --accent: #161616; --ink: #fff; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 Geist, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  main { max-width: 960px; margin: 0 auto; padding: 48px 16px 64px; }
  h1 { margin: 0 0 4px; font-size: 28px; font-weight: 600; letter-spacing: -0.022em; }
  p.lead { margin: 0 0 32px; color: var(--fg-2); }
  h2 { margin: 32px 0 8px; color: var(--fg-2); font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; }
  ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: 10px; background: var(--page); }
  li { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 48px; padding: 8px 12px 8px 16px; }
  li + li { border-top: 1px solid var(--line); }
  .links { display: flex; gap: 8px; flex: none; }
  a { display: inline-flex; align-items: center; min-height: 32px; padding: 0 12px; border-radius: 6px; color: var(--fg); text-decoration: none; background: color-mix(in srgb, var(--fg) 9%, transparent); }
  a:hover { background: color-mix(in srgb, var(--fg) 14%, transparent); }
  a:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
  footer { margin-top: 40px; color: var(--fg-2); font-size: 12px; }
</style>
</head>
<body>
<main>
<h1>FriedLiver UI</h1>
<p class="lead">The agent panel's real webviews (design v3 Mono), with sample chats, in FriedLiver Dark and Light. Nothing here talks to an agent.</p>
${groups.map((g) => `<h2>${g}</h2>\n<ul>\n${PAGES.filter((p) => p[2] === g).map(card).join('\n')}\n</ul>`).join('\n')}
<footer>Built ${new Date(built).toISOString().slice(0, 10)} from <code>extensions/friedliver-agents/scripts/web-export.mjs</code>.</footer>
</main>
</body>
</html>
`;
}

const server = spawn(process.execPath, [path.join(ext, 'scripts/ui-harness.mjs'), '--serve', '--no-build', '--port', opts.port], { stdio: ['ignore', 'pipe', 'inherit'] });
try {
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('Serving') && resolve());
    server.on('exit', (code) => reject(new Error(`harness exited ${code}`)));
  });
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const built = Date.now();
  for (const [file, title, , query] of PAGES)
    for (const [theme, name] of THEMES) {
      const res = await fetch(`http://127.0.0.1:${opts.port}/?${query}&theme=${theme}`);
      if (!res.ok) throw new Error(`${file}-${theme}: HTTP ${res.status}`);
      let html = await res.text();
      html = html
        .replaceAll('"/media/', '"media/')
        .replace(/<title>[^<]*<\/title>/, `<title>${title} · ${name} · FriedLiver</title>`)
        .replace('<head>', `<head>\n${prelude(built)}`);
      if (html.includes('"/media/')) throw new Error(`${file}-${theme}: an absolute /media/ link is left`);
      fs.writeFileSync(path.join(out, `${file}-${theme}.html`), html);
    }
  // Only what the pages load: the stylesheets, the fonts and the webview bundles.
  const media = path.join(ext, 'media');
  for (const f of ['fonts.css', 'tokens.css', 'webview.css', 'components.css']) fs.cpSync(path.join(media, f), path.join(out, 'media', f));
  fs.cpSync(path.join(media, 'fonts'), path.join(out, 'media', 'fonts'), { recursive: true });
  const dist = path.join(media, 'dist');
  if (!fs.existsSync(dist)) throw new Error('media/dist is missing: run node esbuild.mjs first');
  fs.mkdirSync(path.join(out, 'media', 'dist'), { recursive: true });
  for (const f of fs.readdirSync(dist).filter((f) => f.endsWith('.js'))) fs.cpSync(path.join(dist, f), path.join(out, 'media', 'dist', f));
  fs.writeFileSync(path.join(out, 'index.html'), gallery(built));
  console.log(`${PAGES.length * THEMES.length} pages and the gallery → ${out}`);
} finally {
  server.kill();
}
