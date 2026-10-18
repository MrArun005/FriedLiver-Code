#!/usr/bin/env node
// Screenshots of FriedLiver Remote without a phone or the editor: the real
// server (on loopback, which only this harness may use) serving the real phone
// app with fixture chats, at 390×844 in dark and light; and the desktop
// pairing panel in the owner's Dark/Light 2026 themes. Not shipped.
//
//   node scripts/remote-harness.mjs [--out dir] [--no-build]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts } = parseArgs({ options: { out: { type: 'string', default: path.join(os.homedir(), 'code/FriedLiver-Code-design/review') }, 'no-build': { type: 'boolean', default: false } } });

if (!opts['no-build']) {
  const built = spawnSync('node', ['esbuild.mjs'], { cwd: ext, stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-remote-harness-'));
const { build } = await import('esbuild');
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(
  entry,
  ['server', 'auth', 'cert', 'panel'].map((m) => `export * from ${JSON.stringify(path.join(ext, 'src/remote', m))};`).join('\n'),
);
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(tmp, 'remote.cjs'), logLevel: 'error' });
const R = createRequire(import.meta.url)(path.join(tmp, 'remote.cjs'));

// ---- Fixture: what the phone would see on a working afternoon ----

const now = Date.now();
const min = 60_000;
const s = (id, agent, label, title, status, folder, extra = {}) => ({ id, agent, label, title, status, folder, busy: status === 'working', lastActivity: now - (extra.ago ?? 2) * min, waiting: 0, subagents: 0, approval: 'ask', ...extra });
const chats = {
  'chat-3': s('chat-3', 'claude', 'Claude', 'Add rate limiting to the pairing endpoint', 'needs-you', 'wt-remote', { waiting: 1, ago: 0.2, approval: 'edits' }),
  'chat-7': s('chat-7', 'codex', 'Codex', 'Fix flaky checkpoint test on CI', 'needs-you', 'FriedLiver-Code', { waiting: 2, ago: 1 }),
  'chat-5': s('chat-5', 'claude', 'Claude 2', 'Profile transcript rendering at 10k items', 'working', 'FriedLiver-Code', { subagents: 3, ago: 0.1 }),
  'chat-9': s('chat-9', 'gemini', 'Gemini', 'Review the WebSocket framing code', 'working', 'wt-remote', { ago: 0.5 }),
  'chat-2': s('chat-2', 'codex', 'Codex 2', 'Bump esbuild to 0.28 and rebuild', 'error', 'FriedLiver-Code', { ago: 14 }),
  'chat-1': s('chat-1', 'claude', 'Claude 3', 'Write docs/REMOTE.md setup guide', 'done', 'wt-remote', { ago: 42 }),
  'chat-4': s('chat-4', 'gemini', 'Gemini 2', 'Summarise open dependabot PRs', 'done', 'FriedLiver-Code', { ago: 95 }),
};
const groups = [
  ['needs-you', 'Needs you', ['chat-3', 'chat-7']],
  ['working', 'Working', ['chat-5', 'chat-9']],
  ['error', 'Problem', ['chat-2']],
  ['done', 'Done', ['chat-1', 'chat-4']],
].map(([status, title, ids]) => ({ status, title, chats: ids.map((id) => chats[id]) }));
const list = {
  groups,
  agents: [
    { key: 'claude', name: 'Claude' },
    { key: 'codex', name: 'Codex' },
    { key: 'gemini', name: 'Gemini' },
  ],
  folders: [
    { path: '/Users/arun/code/wt-remote', name: 'wt-remote' },
    { path: '/Users/arun/code/FriedLiver-Code', name: 'FriedLiver-Code' },
  ],
  now,
};
const chat3 = {
  ...chats['chat-3'],
  earlier: 0,
  queued: 0,
  subagentList: [
    { id: 'toolu_1', title: 'Find every place that counts failed logins', state: 'done', tools: 9, last: 'Grep · lockout' },
    { id: 'toolu_2', title: 'Check Node’s timingSafeEqual length rules', state: 'done', tools: 3, last: 'Read · crypto.md' },
  ],
  items: [
    { k: 'user', text: 'Add rate limiting to the pairing endpoint. Five bad codes a minute should lock the address out.' },
    { k: 'tool', id: 't1', title: 'Find every place that counts failed logins', status: 'completed', subagent: true },
    { k: 'tool', id: 't2', title: 'Read src/remote/server.ts', status: 'completed' },
    { k: 'tool', id: 't3', title: 'Read src/remote/auth.ts', status: 'completed' },
    {
      k: 'agent',
      text: 'The pairing route already rejects wrong codes, but nothing remembers them. I’ll add a `Lockout` keyed by the remote address:\n\n- **5 failures in 60 s** lock the address for 5 minutes\n- the map is capped at 1,000 addresses, oldest first\n- a valid token from a locked address is refused too, so guessing can’t continue',
    },
    {
      k: 'permission',
      id: 'perm-41',
      title: 'Edit src/remote/auth.ts',
      options: [
        { id: 'allow', name: 'Yes', kind: 'allow_once', escalates: false },
        { id: 'always', name: 'Yes, and don’t ask again this session', kind: 'allow_always', escalates: true },
        { id: 'reject', name: 'No, and tell Claude what to do differently', kind: 'reject_once', escalates: false },
      ],
      files: [
        {
          path: 'src/remote/auth.ts',
          added: 6,
          removed: 1,
          lines: [
            { op: ' ', text: 'export class Lockout {' },
            { op: ' ', text: '  private readonly fails = new Map<string, { at: number[]; until?: number }>();' },
            { op: '-', text: '  fail(key: string): void {}' },
            { op: '+', text: '  fail(key: string): void {' },
            { op: '+', text: '    const at = this.now();' },
            { op: '+', text: '    const entry = this.fails.get(key) ?? { at: [] };' },
            { op: '+', text: '    entry.at = [...entry.at.filter((t) => at - t < LOCK_WINDOW_MS), at];' },
            { op: '+', text: '    if (entry.at.length >= LOCK_FAILS) entry.until = at + LOCK_MS;' },
            { op: '+', text: '  }' },
          ],
          more: 0,
        },
      ],
      always: [
        { grant: { kind: 'folder', folder: '/Users/arun/code/wt-remote/src/remote', access: 'write' }, label: 'Always allow changing files in src/remote' },
      ],
    },
  ],
};
const chat5 = {
  ...chats['chat-5'],
  earlier: 0,
  queued: 0,
  subagentList: [
    { id: 's1', title: 'Measure render time per 1k items', state: 'working', tools: 12, last: 'Bash · node bench/render.mjs --items 10000' },
    { id: 's2', title: 'Find components that re-render on every action', state: 'working', tools: 7, last: 'Grep · useMemo' },
    { id: 's3', title: 'Check virtualisation options in preact', state: 'working', tools: 4, last: 'Read · preact/compat' },
    { id: 's4', title: 'Collect a baseline profile', state: 'done', tools: 5, last: 'Bash · node --cpu-prof' },
  ],
  items: [
    { k: 'user', text: 'Profile transcript rendering at 10k items and tell me what dominates.' },
    { k: 'plan', entries: [
      { content: 'Collect a baseline profile', status: 'completed' },
      { content: 'Measure render time per 1k items', status: 'in_progress' },
      { content: 'Find components that re-render on every action', status: 'in_progress' },
      { content: 'Propose fixes with expected gains', status: 'pending' },
    ] },
    { k: 'tool', id: 's4', title: 'Collect a baseline profile', status: 'completed', subagent: true },
    { k: 'command', id: 'cmd-8', line: 'node --cpu-prof bench/render.mjs --items 10000', cwd: '.', state: 'exited', outside: false, output: 'rendered 10000 items in 1843 ms\nprofile written to CPU.20261018.093301.cpuprofile', exitCode: 0 },
    { k: 'agent', text: 'Baseline: **1.84 s** for 10k items. `Markdown` parses every reply on each render; `parseDoc` caching should cut that by about a third. Three subagents are measuring the rest.' },
    { k: 'tool', id: 's1', title: 'Measure render time per 1k items', status: 'in_progress', subagent: true },
  ],
};
const chat7 = {
  ...chats['chat-7'],
  earlier: 0,
  queued: 0,
  subagentList: [],
  items: [
    { k: 'user', text: 'The checkpoints test fails about one run in ten on CI. Find out why and fix it.' },
    { k: 'agent', text: 'It races the git index lock when two checkpoints start in the same tick. I want to run the test 50 times to confirm.' },
    { k: 'command', id: 'cmd-12', line: 'for i in $(seq 50); do npx vitest run test/checkpoints.test.ts || break; done', cwd: 'extensions/friedliver-agents', state: 'awaiting', outside: false, output: '' },
    { k: 'question', id: 'q-3', message: 'Which fix do you prefer?', state: 'awaiting', fields: [{ key: 'fix', title: 'Fix', type: 'choice', options: [
      { value: 'lock', title: 'Serialise checkpoints per repo', description: 'One queue per repository; simplest, slightly slower' },
      { value: 'retry', title: 'Retry on index.lock', description: 'Up to 3 retries with 50 ms backoff' },
    ] }] },
  ],
};
const views = { 'chat-3': chat3, 'chat-5': chat5, 'chat-7': chat7 };

// ---- The server, as the editor would run it ----

const HOST = '127.0.0.1';
const { cert, key } = R.selfSigned([HOST]);
const store = () => {
  const data = {};
  return { get: (k) => data[k], update: (k, v) => void (data[k] = v) };
};
const devices = new R.Devices(store());
const pairing = new R.Pairing(devices);
const { token } = devices.add('Arun’s iPhone');
const server = await R.RemoteServer.start({
  endpoints: [{ host: HOST, names: [HOST], cert, key }],
  devices,
  pairing,
  lockout: new R.Lockout(),
  host: { list: () => list, chat: (id) => views[id] ?? { ...chats[id], items: [], earlier: 0, queued: 0, subagentList: [] }, act: async () => ({ ok: true }) },
  assets: {
    js: fs.readFileSync(path.join(ext, 'media/dist/remote.js'), 'utf8'),
    css: fs.readFileSync(path.join(ext, 'media/remote.css'), 'utf8'),
    icon: fs.readFileSync(path.join(ext, 'media/remote-icon.svg'), 'utf8'),
    manifest: '{}',
  },
  checkHost: () => {},
});
const base = server.urls()[0];
const fp = R.fingerprint(cert);

const { chromium } = await import('playwright');
const browser = await chromium.launch({ ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}), args: ['--use-mock-keychain', '--password-store=basic'] });
fs.mkdirSync(opts.out, { recursive: true });
const shots = [];
const errors = [];

async function phone(scheme, name, steps, { paired = true, open, hash = '' } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme, ignoreHTTPSErrors: true, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  await context.addInitScript(
    ([t, o, f]) => {
      /* global localStorage, sessionStorage */
      if (t) {
        localStorage.setItem('fl.token', t);
        localStorage.setItem('fl.name', 'Arun’s iPhone');
        localStorage.setItem('fl.fingerprint', f);
      }
      if (o) sessionStorage.setItem('fl.open', o);
    },
    [paired ? token : '', open ?? '', fp],
  );
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text()}`));
  await page.goto(base + hash);
  await page.waitForTimeout(600);
  if (steps) {
    await steps(page);
    await page.waitForTimeout(300);
  }
  const file = path.join(opts.out, `remote-phone-${name}-${scheme}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
  await context.close();
}

for (const scheme of ['dark', 'light']) {
  await phone(scheme, 'list');
  await phone(scheme, 'chat-approval', undefined, { open: 'chat-3' });
  await phone(scheme, 'chat-command', undefined, { open: 'chat-7' });
  await phone(scheme, 'subagents', (p) => p.click('.subs__head'), { open: 'chat-5' });
}
await phone('dark', 'new-chat', (p) => p.click('[aria-label="New chat"]'));
const code = pairing.start().code;
const fpB64 = Buffer.from(fp.replace(/:/g, ''), 'hex').toString('base64url');
await phone('dark', 'pairing', undefined, { paired: false, hash: `#c=${code}&f=${fpB64}` });
await phone('light', 'pairing', undefined, { paired: false, hash: `#c=${pairing.start().code}&f=${fpB64}` });

// ---- The desktop pairing panel, in the owner's themes ----

for (const scheme of ['dark', 'light']) {
  const theme = fs.readFileSync(path.join(ext, `test/fixtures/theme-${scheme}-2026.css`), 'utf8');
  const html = R.pairingHtml({
    nonce: 'harness',
    state: { via: 'lan', code: pairing.start().code, expires: Date.now() + 97_000 },
    active: true,
    url: 'https://192.168.1.23:50123/',
    pinned: true,
    fingerprint: fp,
    lanUrl: 'https://192.168.1.23:50123/',
    tailscaleUrl: 'https://arun-mac.tail1234.ts.net:50123/',
    tailscaleAllowed: true,
    tailscaleFound: true,
    devices: [
      { id: '0123456789abcdef', name: 'Arun’s iPhone', createdAt: now - 3 * 86_400_000, lastSeen: now },
      { id: 'fedcba9876543210', name: 'Pixel 9', createdAt: now - 20 * 86_400_000, lastSeen: now - 2 * 3_600_000 },
    ],
    connected: new Set(['0123456789abcdef']),
  }).replace('</head>', `<style nonce="harness">${theme}</style><script nonce="harness">window.acquireVsCodeApi = () => ({ postMessage() {} });</script></head>`);
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 2, colorScheme: scheme });
  page.on('pageerror', (e) => errors.push(`panel: ${e.message}`));
  await page.setContent(html);
  await page.waitForTimeout(300);
  const file = path.join(opts.out, `remote-desktop-panel-${scheme}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
  await page.close();
}

await browser.close();
await server.dispose();
console.log(shots.join('\n'));
if (errors.length) {
  console.error(`Page errors:\n${errors.join('\n')}`);
  process.exit(1);
}
