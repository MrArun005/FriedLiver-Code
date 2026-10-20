// Many agents at once, and FriedLiver at rest: a stress and memory test of a packaged
// FriedLiver build with the offline Demo agent. Not shipped.
//
// The agents scenario (the default) opens N Demo chats through the chat view (15 by
// default), sends each `busy <s> stamp` so they all run together, opens the Agent Manager
// beside an editor (board, then map), and measures while they run:
//   - memory (PSS) of the whole process tree, every 2 s, with a breakdown by process
//     (the demo agent connects each session's FriedLiver tools at once, as real agents
//     do: over HTTP, or, with FAKE_AGENT_MCP_HTTP=0 in the environment, by starting a
//     tools server per session; --no-bridges leaves them out);
//   - CPU of the extension host, the renderers and the rest;
//   - long tasks and long animation frames in the workbench window and in the chat and
//     Agent Manager webviews;
//   - keypress-to-visible latency, typing in an editor while the agents stream;
//   - how far the chat view and the board lag behind the agents (the demo agent stamps
//     each sentence and plan step with the time it sent it).
// The idle scenario measures memory at rest, step by step: the folder open with the Agents
// panel and no chat; one finished Demo chat; the Agent Manager open; and closed again.
// --without-agents runs only its first step with the agents extension turned off, for
// what the rest of the app costs.
//
// It prints a JSON summary and writes summary.json, samples.json and screenshots to <dir>.
// Keep <dir> short, since the app's sockets live under it.
//
//   xvfb-run -a -s "-screen 0 1920x1080x24" node scripts/stress-demo.mjs VSCode-linux-x64/friedliver /tmp/fls
//        [--agents 15] [--phase 25] [--seconds <busy time>] [--settle 15] [--profile] [--no-bridges]
//   xvfb-run -a -s "-screen 0 1920x1080x24" node scripts/stress-demo.mjs VSCode-linux-x64/friedliver /tmp/fli --scenario idle [--without-agents]
//
// --arg <app argument> (repeatable) passes a flag to the app, e.g. --arg=--js-flags=--optimize-for-size
// or --arg=--disable-extension=vscode.github; --setting <key>=<JSON> (repeatable) adds a user
// setting. Both are for measuring one change at a time on the same build.
//
// --profile also records CPU profiles (extension host, workbench, both webviews) for each
// phase into <dir>/profiles and prints the functions with the most self time. Profiling
// slows things down, so take the numbers from a run without it.
/* global setInterval, clearInterval, clearTimeout, fetch, WebSocket, performance, PerformanceObserver, MutationObserver */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(root, 'extensions/friedliver-agents/package.json'));
const { _electron: electron } = require('playwright');

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    scenario: { type: 'string', default: 'agents' },
    agents: { type: 'string', default: '15' },
    phase: { type: 'string', default: '25' },
    seconds: { type: 'string' },
    settle: { type: 'string', default: '15' },
    profile: { type: 'boolean', default: false },
    'without-agents': { type: 'boolean', default: false },
    'no-bridges': { type: 'boolean', default: false },
    arg: { type: 'string', multiple: true, default: [] },
    setting: { type: 'string', multiple: true, default: [] },
  },
});
const [exe, dir] = positionals;
if (!exe || !dir || !['agents', 'idle'].includes(opts.scenario)) {
  console.error('Usage: node scripts/stress-demo.mjs <app executable> <short output dir> [--scenario agents|idle] [--agents 15] [--phase 25] [--seconds n] [--settle 15] [--profile] [--no-bridges] [--without-agents] [--arg <app flag>] [--setting key=<JSON>]');
  process.exit(2);
}
const IDLE = opts.scenario === 'idle';
const WITHOUT = IDLE && opts['without-agents'];
const N = Math.max(1, Number(opts.agents));
const PHASE_MS = Number(opts.phase) * 1000;
// Long enough that every agent still works through both phases.
const BUSY_S = Number(opts.seconds ?? Math.ceil((2 * PHASE_MS) / 1000 + N * 2 + 30));
const SETTLE_MS = Number(opts.settle) * 1000;
const INSPECT_PORT = 9339;
const T0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

// ---- A fresh workspace and profile ----

rmSync(dir, { recursive: true, force: true });
const ws = `${dir}/ws`;
for (const d of ['src', 'test', '.vscode']) mkdirSync(`${ws}/${d}`, { recursive: true });
writeFileSync(`${ws}/package.json`, '{ "name": "prices", "private": true, "type": "module" }\n');
writeFileSync(`${ws}/README.md`, '# Prices\n\nFormats prices in cents.\n');
writeFileSync(`${ws}/src/format.ts`, 'export function formatCents(cents: number): string {\n  return `$${(cents / 100).toFixed(2)}`;\n}\n');
writeFileSync(`${ws}/src/index.ts`, "export { formatCents } from './format';\n");
writeFileSync(`${ws}/test/format.test.ts`, "import { formatCents } from '../src/format';\n\nconsole.assert(formatCents(150) === '$1.50');\n");
writeFileSync(`${ws}/notes.txt`, 'Typed while the agents work:\n');
// Plain typing: no suggestion popups between the keys.
writeFileSync(`${ws}/.vscode/settings.json`, JSON.stringify({ 'editor.quickSuggestions': { other: false, comments: false, strings: false }, 'editor.wordBasedSuggestions': 'off' }, null, 2));
mkdirSync(`${dir}/ud/User`, { recursive: true });
// Nothing reaches the network.
const extraSettings = Object.fromEntries(opts.setting.map((kv) => [kv.slice(0, kv.indexOf('=')), JSON.parse(kv.slice(kv.indexOf('=') + 1))]));
writeFileSync(`${dir}/ud/User/settings.json`, JSON.stringify({ 'friedliver.update.mode': 'off', 'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'extensions.autoCheckUpdates': false, ...extraSettings }, null, 2));
mkdirSync(`${dir}/profiles`, { recursive: true });

const launched = Date.now();
const app = await electron.launch({
  executablePath: exe,
  // Real agents start each session's MCP servers, the FriedLiver tools among them, when the
  // session starts; the demo agent does too with this, so their processes count.
  env: { ...process.env, FRIEDLIVER_TEST_AGENTS: '1', ...(opts['no-bridges'] ? {} : { FAKE_AGENT_START_MCP: '1' }) },
  args: [
    ws,
    '--no-sandbox',
    `--user-data-dir=${dir}/ud`,
    `--extensions-dir=${dir}/ext`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-gpu',
    ...(opts.profile ? [`--inspect-extensions=${INSPECT_PORT}`] : []),
    ...(WITHOUT ? ['--disable-extension=friedliver.friedliver-agents'] : []),
    ...opts.arg,
  ],
});
const rootPid = app.process().pid;
const win = await app.firstWindow();
await win.setViewportSize({ width: 1920, height: 1080 }).catch(() => {});
await win.waitForSelector('.monaco-workbench', { timeout: 60000 });
const ready = Date.now();
await win.waitForTimeout(9000);

const palette = async (command) => {
  await win.keyboard.press('Control+Shift+P');
  await win.waitForTimeout(500);
  await win.keyboard.type(command);
  await win.waitForTimeout(600);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(600);
};
// The container runs as root, which adds a warning toast; clear it so the shots show the app.
await palette('Notifications: Clear All Notifications');

/** Opens the Agent Manager in the active editor group; the palette now and then misses the first Enter. */
async function openManager() {
  for (let attempt = 1; ; attempt++) {
    await palette('FriedLiver: Agent Manager');
    try {
      return await surface('tasks', 10_000);
    } catch (err) {
      if (attempt === 3) throw err;
      await win.keyboard.press('Escape');
    }
  }
}

/** The webview frame showing one of the extension's surfaces (chat, tasks, images). */
async function surface(kind, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const f of win.frames()) {
      const s = await f.evaluate(() => document.body?.dataset.surface).catch(() => null);
      if (s === kind) return f;
    }
    await win.waitForTimeout(300);
  }
  throw new Error(`no ${kind} surface`);
}

// ---- Processes: memory and CPU ----

const CLK_TCK = 100;
let meta = { metrics: [], frames: [] };
const surfacePids = new Map(); // renderer pid → 'chat' | 'tasks'
async function refreshMeta() {
  meta = await app.evaluate(({ app, webContents }) => ({
    metrics: app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name ?? '' })),
    frames: webContents.getAllWebContents().flatMap((wc) => wc.mainFrame.framesInSubtree.map((f) => ({ url: f.url, pid: f.osProcessId }))),
  }));
}
/** Which renderer shows which of our webviews. */
async function nameSurfaces(frames) {
  surfacePids.clear();
  await refreshMeta();
  for (const [name, frame] of Object.entries(frames)) {
    const pid = meta.frames.find((f) => f.url === frame.url())?.pid;
    if (pid) surfacePids.set(pid, name);
  }
}

function processTable() {
  const table = new Map();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      table.set(Number(d), { ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]) });
    } catch {
      // Gone already.
    }
  }
  return table;
}

function kindOf(pid, cmd) {
  if (pid === rootPid) return 'main';
  if (cmd.includes('demo-agent.js')) return 'demoAgent';
  if (cmd.includes('bridge.js')) return 'bridge';
  if (cmd.includes('jsonServerMain')) return 'jsonServer';
  if (cmd.includes('tsserver')) return 'tsserver';
  const m = meta.metrics.find((x) => x.pid === pid);
  if (m?.type === 'GPU') return 'gpu';
  if (m?.name.startsWith('extensionHost')) return 'extensionHost';
  if (surfacePids.has(pid)) return `webview:${surfacePids.get(pid)}`;
  if (meta.frames.some((f) => f.pid === pid && f.url.startsWith('vscode-file:'))) return 'workbench';
  if (meta.frames.some((f) => f.pid === pid && f.url.startsWith('vscode-webview:'))) return 'webview:other';
  if (m?.type === 'Utility') return `utility:${m.name.replace(/-\d+$/, '') || 'unnamed'}`;
  if (cmd.includes('--type=zygote')) return 'zygote';
  if (cmd.includes('--type=renderer')) return 'renderer:other';
  return `other:${path.basename(cmd.split(' ')[0] || '?')}`;
}

const samples = []; // { t, total, count, kinds: { kind: pssKB }, cpu: { kind: percent } }
let lastTicks = new Map();
let lastT = 0;
let processCount = 0;
const seenKinds = new Map();
function sample() {
  const table = processTable();
  const tree = [];
  const add = (pid) => {
    tree.push(pid);
    for (const [child, p] of table) if (p.ppid === pid) add(child);
  };
  add(rootPid);
  const t = Date.now();
  const kinds = {};
  const cpu = {};
  let total = 0;
  const ticks = new Map();
  for (const pid of tree) {
    let cmd;
    let pss;
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      pss = Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))?.[1] ?? 0);
    } catch {
      continue;
    }
    const kind = kindOf(pid, cmd);
    seenKinds.set(pid, kind);
    kinds[kind] = (kinds[kind] ?? 0) + pss;
    total += pss;
    const tk = table.get(pid).ticks;
    ticks.set(pid, tk);
    if (lastT && lastTicks.has(pid)) cpu[kind] = (cpu[kind] ?? 0) + ((tk - lastTicks.get(pid)) / CLK_TCK / ((t - lastT) / 1000)) * 100;
  }
  processCount = Math.max(processCount, tree.length);
  if (lastT) samples.push({ t, total, count: tree.length, kinds, cpu });
  lastTicks = ticks;
  lastT = t;
}

await refreshMeta();
sample();
let sampleCount = 0;
const sampler = setInterval(() => {
  sample();
  if (++sampleCount % 5 === 0) void refreshMeta().catch(() => {});
}, 2000);

const marks = {};
const mark = (name) => {
  marks[name] = Date.now();
  log(name);
};

const round = (n) => Math.round(n * 10) / 10;
const mb = (kb) => Math.round(kb / 1024);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const within = (from, to) => samples.filter((s) => s.t >= from && s.t <= to);
const allKinds = () => [...new Set(samples.flatMap((s) => Object.keys(s.kinds)))].sort();

/** Memory over a window: the total and each kind of process, averaged. */
function memoryIn(from, to) {
  const w = within(from, to);
  const byProcess = Object.fromEntries(
    allKinds()
      .map((k) => [k, mb(avg(w.map((s) => s.kinds[k] ?? 0)))])
      .filter(([, v]) => v > 0),
  );
  return { totalMB: mb(avg(w.map((s) => s.total))), processes: Math.round(avg(w.map((s) => s.count))), byProcess };
}

/** JavaScript heaps of the renderers we can reach, in MB. */
async function heaps(frames) {
  const out = {};
  for (const [name, frame] of Object.entries(frames)) {
    try {
      const session = await app.context().newCDPSession(frame);
      const { usedSize } = await session.send('Runtime.getHeapUsage');
      out[name] = round(usedSize / 1048576);
      await session.detach();
    } catch {
      // Gone.
    }
  }
  return out;
}

class Inspector {
  static async connect(port) {
    for (let i = 0; i < 40; i++) {
      try {
        const [target] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          socket.onopen = resolve;
          socket.onerror = reject;
        });
        return new Inspector(socket);
      } catch {
        await sleep(500);
      }
    }
    throw new Error('The extension host inspector did not answer.');
  }
  constructor(socket) {
    this.socket = socket;
    this.next = 1;
    this.waiting = new Map();
    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message));
      else w.resolve(msg.result);
    };
  }
  send(method, params = {}) {
    const id = this.next++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
  }
}

if (IDLE) {
  // ---- Memory at rest ----
  const steps = {};
  // With --profile, the extension host's heap too, through its inspector (after a GC).
  const extHost = opts.profile ? await Inspector.connect(INSPECT_PORT) : undefined;
  const measure = async (name, frames) => {
    mark(name);
    await sleep(10_000);
    mark(`${name} end`);
    const jsHeapMB = await heaps(frames);
    if (extHost) {
      await extHost.send('HeapProfiler.collectGarbage');
      jsHeapMB.extensionHost = round((await extHost.send('Runtime.getHeapUsage')).usedSize / 1048576);
    }
    steps[name] = { ...memoryIn(marks[name], marks[`${name} end`]), jsHeapMB };
  };
  // Settled after start: the folder open, the Agents panel showing, no chat.
  await sleep(Math.max(0, ready + 25_000 - Date.now()));
  if (WITHOUT) {
    await measure('empty', { workbench: win });
  } else {
    const chat = await surface('chat');
    await nameSurfaces({ chat });
    await measure('empty', { workbench: win, chat: chat.parentFrame() });
    await win.screenshot({ path: `${dir}/idle-empty.png` });

    // One Demo chat that ran and finished.
    await chat.getByRole('button', { name: /Demo/ }).first().click();
    const box = chat.locator('textarea[aria-label="Message Demo"]');
    await box.waitFor({ timeout: 30000 });
    await box.fill('busy 5');
    await box.press('Enter');
    await chat.getByText(/Done after 5 s/).waitFor({ timeout: 60000 });
    await sleep(SETTLE_MS);
    await measure('oneChat', { workbench: win, chat: chat.parentFrame() });

    // The Agent Manager open, then closed again.
    const tasks = await openManager();
    await nameSurfaces({ chat, tasks });
    await sleep(SETTLE_MS);
    await measure('managerOpen', { workbench: win, chat: chat.parentFrame(), tasks: tasks.parentFrame() });
    await win.screenshot({ path: `${dir}/idle-manager.png` });
    await palette('View: Close Editor');
    await sleep(SETTLE_MS);
    await measure('managerClosed', { workbench: win, chat: chat.parentFrame() });
    steps.managerClosed.managerFrames = win.frames().filter((f) => f.url().includes('purpose=webviewPanel') || f === tasks).length;
    await win.screenshot({ path: `${dir}/idle-closed.png` });
  }
  clearInterval(sampler);
  await app.close();
  const summary = { scenario: WITHOUT ? 'idle without the agents extension' : 'idle', startupMs: ready - launched, steps };
  writeFileSync(`${dir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(`${dir}/samples.json`, JSON.stringify({ marks, samples }));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

// ---- In-page probes: long tasks, long animation frames, view lag, typing ----

/** Long tasks and long animation frames in this document, as [start ms since epoch, duration]. */
const installLongTasks = () => {
  if (window.__longTasks) return;
  window.__longTasks = [];
  window.__longFrames = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__longTasks.push([performance.timeOrigin + e.startTime, e.duration]);
  }).observe({ type: 'longtask', buffered: true });
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longFrames.push([performance.timeOrigin + e.startTime, e.duration]);
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch {
    // Not in this engine.
  }
};

/** Each stamp the agents wrote, when it first shows: [shown at, lag ms]. */
const installLag = (kind) => {
  if (window.__lags) return;
  window.__lags = [];
  const seen = new Set();
  // Stamps already on screen don't count.
  for (const m of document.body.textContent.matchAll(/t=(\d{13})/g)) seen.add(m[1]);
  const shown = () => {
    if (kind === 'tasks') return [...document.querySelectorAll('.card-state-text')];
    const replies = document.querySelectorAll('.transcript .prose');
    return [...replies].slice(-2);
  };
  let pending = false;
  const scan = () => {
    pending = false;
    const now = Date.now();
    for (const el of shown()) {
      for (const m of el.textContent.slice(-800).matchAll(/t=(\d{13})/g)) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        window.__lags.push([now, now - Number(m[1])]);
      }
    }
  };
  // After the change is laid out and painted: a task after the mutation's frame.
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(scan, 0);
  }).observe(document.body, { subtree: true, childList: true, characterData: true });
};

await win.evaluate(installLongTasks);
await win.evaluate(() => {
  /** Resolves with the time `expect` shows in the focused editor, after it is painted. */
  window.__arm = (expect) => {
    const lines = document.activeElement?.closest('.monaco-editor')?.querySelector('.view-lines');
    window.__typed = new Promise((resolve) => {
      if (!lines) return resolve(-1);
      const timer = setTimeout(() => {
        obs.disconnect();
        resolve(-1);
      }, 5000);
      const obs = new MutationObserver(() => {
        if (!lines.textContent.includes(expect)) return;
        obs.disconnect();
        clearTimeout(timer);
        setTimeout(() => resolve(Date.now()), 0);
      });
      obs.observe(lines, { subtree: true, childList: true, characterData: true });
    });
  };
});

let line = 0;
let typed = '';
/** Types into the focused editor until `until`, one key every 300 ms; returns keypress→visible times. */
async function typeUntil(until) {
  const out = [];
  let n = 0;
  while (Date.now() < until) {
    if (!typed || typed.length >= 34) {
      await win.keyboard.press('Control+End');
      await win.keyboard.press('Enter');
      typed = `L${String(++line).padStart(3, '0')}:`;
      await win.keyboard.type(typed);
      await sleep(150);
    }
    const ch = String.fromCharCode(97 + (n++ % 26));
    typed += ch;
    await win.evaluate((e) => window.__arm(e), typed);
    const t0 = Date.now();
    await win.keyboard.press(ch);
    const shown = await win.evaluate(() => window.__typed);
    if (shown > 0) out.push(shown - t0);
    await sleep(300);
  }
  return out;
}

// ---- CPU profiles (--profile) ----

const profilers = new Map(); // name → { send(method, params) }
async function startProfiles() {
  for (const p of profilers.values()) {
    await p.send('Profiler.enable');
    await p.send('Profiler.setSamplingInterval', { interval: 500 });
    await p.send('Profiler.start');
  }
}
const topFunctions = (profile, n = 12) => {
  const self = new Map();
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  let total = 0;
  profile.samples.forEach((id, i) => {
    const dt = (profile.timeDeltas[i] ?? 0) / 1000;
    const { functionName, url, lineNumber } = byId.get(id).callFrame;
    const key = `${functionName || '(anonymous)'} ${url ? `${path.basename(url.split('?')[0])}:${lineNumber + 1}` : ''}`.trim();
    if (key !== '(idle)') total += dt;
    self.set(key, (self.get(key) ?? 0) + dt);
  });
  self.delete('(idle)');
  return {
    busyMs: Math.round(total),
    top: [...self]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, ms]) => `${ms.toFixed(0).padStart(6)} ms  ${k}`),
  };
};
const profileReport = {};
async function stopProfiles(tag) {
  for (const [name, p] of profilers) {
    const { profile } = await p.send('Profiler.stop');
    writeFileSync(`${dir}/profiles/${tag}-${name}.cpuprofile`, JSON.stringify(profile));
    profileReport[`${tag}:${name}`] = topFunctions(profile);
  }
}

// ---- Where each renderer's main thread spends its time (CDP Performance metrics) ----

const metricSessions = new Map(); // name → CDP session
async function rendererMetrics() {
  const out = {};
  for (const [name, session] of metricSessions) {
    try {
      const { metrics } = await session.send('Performance.getMetrics');
      out[name] = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
    } catch {
      // Gone.
    }
  }
  return out;
}
/** Per second between two readings: busy, script, layout and style time in ms, and layouts and style passes. */
function metricRates(a, b, seconds) {
  return Object.fromEntries(
    Object.keys(b)
      .filter((name) => a[name])
      .map((name) => {
        const d = (k) => (b[name][k] ?? 0) - (a[name][k] ?? 0);
        const ms = (k) => Math.round((d(k) * 1000) / seconds);
        return [name, { busyMs: ms('TaskDuration'), scriptMs: ms('ScriptDuration'), layoutMs: ms('LayoutDuration'), styleMs: ms('RecalcStyleDuration'), layouts: round(d('LayoutCount') / seconds), styles: round(d('RecalcStyleCount') / seconds) }];
      }),
  );
}

// ---- The run ----

/** The second editor group shows notes.txt; typing goes there, at the end. */
async function focusNotes() {
  await win.locator('.part.editor .editor-group-container').nth(1).locator('.monaco-editor .view-lines').click({ position: { x: 40, y: 8 } });
  await win.keyboard.press('Control+End');
  await win.waitForTimeout(300);
}

// An editor to type in, beside where the Agent Manager will open.
await win.keyboard.press('Control+P');
await win.waitForTimeout(500);
await win.keyboard.type('notes.txt');
await win.waitForTimeout(800);
await win.keyboard.press('Enter');
await win.waitForTimeout(1000);
await palette('View: Split Editor Right');
// The chat view lives in the side bar (the FriedLiver Agents container): keep it, and make sure it shows.
await palette('View: Show FriedLiver Agents');
await win.keyboard.press('Control+1');
await win.waitForTimeout(300);

const chat = await surface('chat');
await chat.evaluate(installLongTasks);
await chat.evaluate(installLag, 'chat');
const prompt = `busy ${BUSY_S} stamp`;
/** Open chats: a tab each in the chat view's strip. */
const openTabs = () => chat.evaluate(() => document.querySelectorAll('.switcher [role="tab"]').length).catch(() => 0);
mark('start');
for (let i = 1; i <= N; i++) {
  if (i === 1) {
    await chat.getByRole('button', { name: /Demo/ }).first().click();
  } else {
    // The header's + ("New chat"; "New chat with" in some builds) opens a menu of agents.
    await chat.getByRole('button', { name: /^New chat/ }).first().click();
    await chat.getByRole('menuitem', { name: /^Demo/ }).first().click();
  }
  // Every chat's message box is "Message Demo" (chats are named by topic, not numbered): wait for this chat's tab.
  for (const end = Date.now() + 30000; (await openTabs()) < i && Date.now() < end; ) await sleep(100);
  const box = chat.locator('textarea[aria-label="Message Demo"]');
  await box.waitFor({ timeout: 30000 });
  await box.fill(prompt);
  await box.press('Enter');
  if (i === 1) mark('first sent');
}
mark('all sent');

await win.keyboard.press('Control+1');
const tasks = await openManager();
await tasks.evaluate(installLongTasks);
await tasks.evaluate(installLag, 'tasks');
await nameSurfaces({ chat, tasks });

if (opts.profile) {
  profilers.set('extensionHost', await Inspector.connect(INSPECT_PORT));
  const ctx = app.context();
  profilers.set('workbench', await ctx.newCDPSession(win));
  // A webview's content frame shares its process, and its CDP session, with the frame around it.
  profilers.set('chat', await ctx.newCDPSession(chat.parentFrame()));
  profilers.set('tasks', await ctx.newCDPSession(tasks.parentFrame()));
}

{
  const ctx = app.context();
  for (const [name, target] of [
    ['workbench', win],
    ['chat', chat.parentFrame()],
    ['tasks', tasks.parentFrame()],
  ]) {
    const session = await ctx.newCDPSession(target);
    await session.send('Performance.enable');
    metricSessions.set(name, session);
  }
}

const workingCount = () => tasks.evaluate(() => Number(/(\d+) working/.exec(document.querySelector('.mgr-counts')?.textContent ?? '')?.[1] ?? -1)).catch(() => -1);

// Board.
await tasks.getByRole('tab', { name: /Board/ }).click();
await focusNotes();
if (opts.profile) await startProfiles();
mark('board');
const boardMetrics = await rendererMetrics();
const typingBoard = await typeUntil(marks.board + PHASE_MS);
mark('board end');
const boardRates = metricRates(boardMetrics, await rendererMetrics(), (marks['board end'] - marks.board) / 1000);
if (opts.profile) await stopProfiles('board');
const workingBoard = await workingCount();
await win.screenshot({ path: `${dir}/board.png` });
await win.locator('.part.sidebar, .part.auxiliarybar').filter({ has: win.locator('iframe, webview') }).first().screenshot({ path: `${dir}/chat.png` }).catch(() => {});

// Map.
await tasks.getByRole('tab', { name: /Map/ }).click();
await focusNotes();
if (opts.profile) await startProfiles();
mark('map');
const mapMetrics = await rendererMetrics();
const typingMap = await typeUntil(marks.map + PHASE_MS);
mark('map end');
const mapRates = metricRates(mapMetrics, await rendererMetrics(), (marks['map end'] - marks.map) / 1000);
if (opts.profile) await stopProfiles('map');
const workingMap = await workingCount();
await win.screenshot({ path: `${dir}/map.png` });

// Until every agent is done, then let it settle.
const doneBy = Date.now() + BUSY_S * 1000 + 60_000;
while (Date.now() < doneBy && (await workingCount()) > 0) await sleep(1000);
mark('all done');
await sleep(SETTLE_MS);
mark('settle');
await sleep(10_000);
mark('end');
clearInterval(sampler);
sample();

// ---- Results ----

const collect = async (frame) =>
  frame.evaluate(() => ({ longTasks: window.__longTasks ?? [], longFrames: window.__longFrames ?? [], lags: window.__lags ?? [] })).catch(() => ({ longTasks: [], longFrames: [], lags: [] }));
const pages = { workbench: await collect(win), chat: await collect(chat), tasks: await collect(tasks) };
const stateFile = (() => {
  const base = `${dir}/ud/User/workspaceStorage`;
  try {
    for (const d of readdirSync(base)) {
      const f = `${base}/${d}/friedliver.friedliver-agents/chats.json`;
      try {
        return Math.round(statSync(f).size / 1024);
      } catch {
        // Not this one.
      }
    }
  } catch {
    // No storage.
  }
  return null;
})();
await app.close();

const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return round(s[Math.min(s.length - 1, Math.floor(q * s.length))]);
};
const dist = (xs) => ({ n: xs.length, median: quantile(xs, 0.5), p95: quantile(xs, 0.95), max: xs.length ? round(Math.max(...xs)) : null });
const kinds = allKinds();

const running = within(marks.board, marks['map end']);
const settled = within(marks.settle, marks.end);
const memory = {
  avg: mb(avg(running.map((s) => s.total))),
  peak: mb(Math.max(...samples.map((s) => s.total))),
  settled: mb(avg(settled.map((s) => s.total))),
  byProcess: Object.fromEntries(
    kinds.map((k) => [k, { avg: mb(avg(running.map((s) => s.kinds[k] ?? 0))), peak: mb(Math.max(...samples.map((s) => s.kinds[k] ?? 0))), settled: mb(avg(settled.map((s) => s.kinds[k] ?? 0))) }]),
  ),
};
const cpuIn = (from, to) => {
  const w = within(from + 1000, to);
  return Object.fromEntries(kinds.map((k) => [k, round(avg(w.map((s) => s.cpu[k] ?? 0)))]).filter(([, v]) => v > 0));
};
const longIn = (field, from, to) =>
  Object.fromEntries(
    Object.entries(pages).map(([name, p]) => {
      const lt = p[field].filter(([t]) => t >= from && t <= to).map(([, d]) => d);
      return [name, { count: lt.length, totalMs: Math.round(lt.reduce((a, b) => a + b, 0)), maxMs: lt.length ? Math.round(Math.max(...lt)) : 0 }];
    }),
  );
const lagIn = (page, from, to) => dist(pages[page].lags.filter(([t]) => t >= from && t <= to).map(([, l]) => l));
const phases = { board: [marks.board, marks['board end']], map: [marks.map, marks['map end']] };
const perPhase = (fn) => Object.fromEntries(Object.entries(phases).map(([name, [from, to]]) => [name, fn(from, to)]));

const summary = {
  scenario: 'agents',
  agents: N,
  /** Launch until the workbench shows. */
  startupMs: ready - launched,
  busySeconds: BUSY_S,
  phaseSeconds: PHASE_MS / 1000,
  allWorking: { board: workingBoard, map: workingMap },
  rampSeconds: round((marks['all sent'] - marks.start) / 1000),
  memoryMB: memory,
  cpuPercent: { ...perPhase(cpuIn), settled: cpuIn(marks.settle, marks.end) },
  longTasks: perPhase((from, to) => longIn('longTasks', from, to)),
  longAnimationFrames: perPhase((from, to) => longIn('longFrames', from, to)),
  /** Main thread of each renderer, per second: busy, script, layout and style ms, and how many layouts and style passes. */
  rendererPerSecond: { board: boardRates, map: mapRates },
  inputLatencyMs: { board: dist(typingBoard), map: dist(typingMap) },
  viewLagMs: { chat: lagIn('chat', marks.board, marks['map end']), board: lagIn('tasks', marks.board, marks['board end']) },
  processes: { count: processCount, kinds: Object.fromEntries([...new Set(seenKinds.values())].map((k) => [k, [...seenKinds.values()].filter((v) => v === k).length])) },
  savedStateKB: stateFile,
  ...(opts.profile ? { profiles: profileReport } : {}),
};
writeFileSync(`${dir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(`${dir}/samples.json`, JSON.stringify({ marks, samples }));
console.log(JSON.stringify(summary, null, 2));
