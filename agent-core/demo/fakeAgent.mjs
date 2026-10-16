#!/usr/bin/env node
// A tiny ACP agent for tests. What it does depends on the prompt text:
//   "edit <path>"     asks permission with a diff, then writes <path>
//   "run"             runs a command in a client terminal and reports its output
//   "read-image <p>"  reports a read tool call on an image file
//   "wait"            keeps working until cancelled
//   "tour"            the UI demo: a plan, a file read, an edit, a command and an image
//   "project"         builds calc/, runs its tests, fixes the failing one, reruns, runs the app
//   "ask <agent> <q>" asks another agent through the session's FriedLiver tools (MCP) and
//                     replies "<Agent> says: <answer>"; "ask demo hello" needs no sign-in
//   "chats"           lists FriedLiver's chats through the same tools
//   an editor request (Edit with Agent, Review My Changes): see editorRequests.mjs
//   "busy <s> [stamp]" works like a busy real agent for <s> seconds, for stress tests
//                     (scripts/stress-demo.mjs): markdown in small chunks, four a second,
//                     with lists and code blocks; tool calls and their updates; a plan; a
//                     file read now and then. Never asks for anything. "stamp" ends each
//                     sentence and the plan's current step with `t=<ms since epoch>`.
//   anything else     echoes the text back in two chunks
// Only the last text block is read as one of these, so context a client puts
// in front of the message (a hand-off, a consultation) is echoed but ignored.
// FAKE_AGENT_LOAD_SESSION=1 makes it offer session/load (it remembers nothing, so
// a reloaded chat just carries on).
// FAKE_AGENT_START_MCP=1 makes it start each session's MCP servers (the FriedLiver tools)
// when the session starts and keep them running, as real agents do, instead of only
// for a tool call; the stress test uses it to count their memory.
// FAKE_AGENT_AUTH=1 makes session/new require authenticate("fake-login") first;
// that browser-style sign-in prints a sign-in link to stderr, like Gemini's.
// --require-login makes it need a terminal login instead, like Claude's: the
// client runs this script with --cli, which asks for Enter and saves a marker.
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { editorRequest, handleEditorRequest } from './editorRequests.mjs';

const LOGIN_MARKER = process.env.FAKE_AGENT_LOGIN_MARKER ?? path.join(os.tmpdir(), 'friedliver-demo-login');

if (process.argv.includes('--cli')) {
  // Stands in for `claude /login`: a terminal program that signs you in and exits.
  process.stdout.write('Demo login (stands in for `claude /login`).\r\n');
  process.stdout.write('A real CLI opens your browser here. Press Enter to approve… ');
  createInterface({ input: process.stdin }).once('line', () => {
    writeFileSync(LOGIN_MARKER, new Date().toISOString());
    process.stdout.write('\r\nSigned in. You can close this terminal.\r\n');
    process.exit(0);
  });
} else {
  serve();
}

function serve() {
const needsAuth = process.env.FAKE_AGENT_AUTH === '1';
const needsTerminalLogin = process.argv.includes('--require-login');
if (process.argv.includes('--logout')) rmSync(LOGIN_MARKER, { force: true });
const images = process.env.FAKE_AGENT_IMAGES !== '0';
const loadSession = process.env.FAKE_AGENT_LOAD_SESSION === '1';
let authenticated = false;
let nextSession = 1;
const cancels = new Map();
const sessionCwd = new Map();
const sessionMcp = new Map();
const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', demo: 'Demo' };

const say = (client, sessionId, text) =>
  client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  });

const tool = (client, sessionId, update) =>
  client.notify(acp.methods.client.session.update, { sessionId, update });

async function edit(client, sessionId, path) {
  await tool(client, sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'edit-1',
    title: `Edit ${path}`,
    kind: 'edit',
    status: 'pending',
    locations: [{ path }],
    content: [{ type: 'diff', path, oldText: null, newText: 'edited by fake agent\n' }],
  });
  const answer = await client.request(acp.methods.client.session.requestPermission, {
    sessionId,
    toolCall: { toolCallId: 'edit-1', title: `Edit ${path}`, kind: 'edit' },
    options: [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  });
  const allowed = answer.outcome.outcome === 'selected' && answer.outcome.optionId === 'allow';
  if (allowed) {
    await client.request(acp.methods.client.fs.writeTextFile, { sessionId, path, content: 'edited by fake agent\n' });
  }
  await tool(client, sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: allowed ? 'completed' : 'failed' });
  await say(client, sessionId, allowed ? 'Edited.' : 'Skipped the edit.');
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Stands in for a screenshot the agent took.
const SCREENSHOT = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300">
  <rect width="480" height="300" rx="10" fill="#1e1e1e"/>
  <rect width="480" height="28" rx="10" fill="#323233"/>
  <circle cx="18" cy="14" r="5" fill="#f48771"/><circle cx="36" cy="14" r="5" fill="#d7ba7d"/><circle cx="54" cy="14" r="5" fill="#4ec9b0"/>
  <rect x="16" y="48" width="200" height="10" rx="3" fill="#3794ff"/>
  <rect x="16" y="70" width="320" height="8" rx="3" fill="#555"/><rect x="16" y="88" width="280" height="8" rx="3" fill="#555"/>
  <rect x="16" y="106" width="300" height="8" rx="3" fill="#555"/>
  <rect x="16" y="140" width="448" height="140" rx="6" fill="#252526" stroke="#3c3c3c"/>
  <text x="240" y="218" font-family="sans-serif" font-size="18" fill="#d4d4d4" text-anchor="middle">Screenshot from the demo agent</text>
</svg>`,
).toString('base64');

async function tour(client, sessionId) {
  const cwd = sessionCwd.get(sessionId) ?? process.cwd();
  const notes = `${cwd}/NOTES.md`;
  const steps = ['Look around the project', 'Add a NOTES.md file', 'Run a quick check', 'Share a screenshot'];
  const plan = (done) =>
    tool(client, sessionId, {
      sessionUpdate: 'plan',
      entries: steps.map((content, i) => ({
        content,
        priority: 'medium',
        status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending',
      })),
    });

  await say(client, sessionId, "Hi! I'm the **demo agent**. I run offline, so you can try FriedLiver without signing in.\n\n");
  await plan(0);
  await pause(300);
  await tool(client, sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'tour-read',
    title: 'List the project files',
    kind: 'read',
    status: 'completed',
    locations: [{ path: cwd }],
  });
  await plan(1);
  await say(client, sessionId, 'Next I want to add a notes file. You review the diff before anything is written.\n\n');
  const before = await client
    .request(acp.methods.client.fs.readTextFile, { sessionId, path: notes })
    .then((r) => r.content)
    .catch(() => null);
  const after = `${before ?? '# Notes\n'}\n- ${new Date().toISOString().slice(0, 10)}: FriedLiver demo agent was here.\n`;
  try {
    await client.request(acp.methods.client.fs.writeTextFile, { sessionId, path: notes, content: after });
    await say(client, sessionId, '`NOTES.md` saved.\n\n');
  } catch {
    await say(client, sessionId, 'You rejected the edit, so nothing was written.\n\n');
  }
  await plan(2);
  await run(client, sessionId);
  await plan(3);
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/svg+xml', data: SCREENSHOT } },
  });
  await plan(4);
  await say(client, sessionId, '\n\nThat\'s the tour: a plan, a reviewed edit, an approved command, and an image in the panel on the right.');
}

/** Runs a shell command through the client and returns its exit code and output, or null if denied. */
async function shell(client, sessionId, toolCallId, title, command, cwd) {
  await tool(client, sessionId, { sessionUpdate: 'tool_call', toolCallId, title, kind: 'execute', status: 'pending' });
  let terminalId;
  try {
    ({ terminalId } = await client.request(acp.methods.client.terminal.create, { sessionId, command, cwd }));
  } catch {
    await tool(client, sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' });
    return null;
  }
  await tool(client, sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress', content: [{ type: 'terminal', terminalId }] });
  const exit = await client.request(acp.methods.client.terminal.waitForExit, { sessionId, terminalId });
  const { output } = await client.request(acp.methods.client.terminal.output, { sessionId, terminalId });
  await client.request(acp.methods.client.terminal.release, { sessionId, terminalId });
  await tool(client, sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: exit.exitCode === 0 ? 'completed' : 'failed' });
  return { code: exit.exitCode, output };
}

const CALC_FILES = {
  'package.json': `${JSON.stringify(
    { name: 'calc', version: '1.0.0', type: 'module', scripts: { test: 'node --test', start: 'node src/cli.js' } },
    null,
    2,
  )}\n`,
  'src/calc.js': `export const add = (a, b) => a + b;
export const subtract = (a, b) => a - b;
export const multiply = (a, b) => a + b;
`,
  'src/cli.js': `import { add, multiply, subtract } from './calc.js';

const ops = { '+': add, '-': subtract, '*': multiply };
const [, a, op, b] = (process.argv[2] ?? '').match(/^(-?\\d+)([+*-])(-?\\d+)$/) ?? [];
if (!op) {
  console.error('Usage: npm start -- 6*7');
  process.exit(1);
}
console.log(\`\${a} \${op} \${b} = \${ops[op](Number(a), Number(b))}\`);
`,
  'test/calc.test.js': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add, multiply, subtract } from '../src/calc.js';

test('add', () => assert.equal(add(2, 3), 5));
test('subtract', () => assert.equal(subtract(5, 3), 2));
test('multiply', () => assert.equal(multiply(6, 7), 42));
`,
};

async function project(client, sessionId) {
  const cwd = sessionCwd.get(sessionId) ?? process.cwd();
  const dir = `${cwd}/calc`;
  const steps = ['Create a small calculator project', 'Run its tests', 'Fix what fails', 'Run the tests again', 'Run the app'];
  const plan = (done) =>
    tool(client, sessionId, {
      sessionUpdate: 'plan',
      entries: steps.map((content, i) => ({ content, priority: 'medium', status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending' })),
    });
  const write = async (rel, content) => {
    try {
      await client.request(acp.methods.client.fs.writeTextFile, { sessionId, path: `${dir}/${rel}`, content });
      return true;
    } catch {
      return false;
    }
  };

  await say(client, sessionId, "I'll build a tiny calculator with tests in `calc/`, run the tests, fix whatever fails, and run it.\n\n");
  await plan(0);
  for (const [rel, content] of Object.entries(CALC_FILES)) {
    if (!(await write(rel, content))) {
      await say(client, sessionId, `You rejected \`calc/${rel}\`, so I stopped there.`);
      return;
    }
  }
  await plan(1);
  const first = await shell(client, sessionId, 'test-1', 'npm test', 'npm test', dir);
  if (!first) return say(client, sessionId, 'You denied `npm test`, so I stopped.');
  if (first.code === 0) {
    await say(client, sessionId, 'All tests passed on the first run.\n\n');
  } else {
    const failing = [...first.output.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    await say(client, sessionId, `Tests failed: ${failing.length ? failing.map((f) => `\`${f}\``).join(', ') : 'see the output'}. \`multiply\` adds instead of multiplying. Fixing it.\n\n`);
    await plan(2);
    if (!(await write('src/calc.js', CALC_FILES['src/calc.js'].replace('export const multiply = (a, b) => a + b;', 'export const multiply = (a, b) => a * b;')))) {
      return say(client, sessionId, 'You rejected the fix, so the test still fails.');
    }
    await plan(3);
    const second = await shell(client, sessionId, 'test-2', 'npm test', 'npm test', dir);
    if (!second) return say(client, sessionId, 'You denied the second test run.');
    await say(client, sessionId, second.code === 0 ? 'All 3 tests pass now.\n\n' : 'Tests still fail; check the commands panel.\n\n');
  }
  await plan(4);
  // Unquoted on purpose: '…' is literal in cmd.exe, and sh leaves an unmatched glob as is.
  const app = await shell(client, sessionId, 'start', 'npm start -- 6*7', 'npm start -- 6*7', dir);
  const result = app?.output.match(/^-?\d+ [+*-] -?\d+ = -?\d+$/m)?.[0];
  await plan(5);
  await say(client, sessionId, result ? `The app works: \`${result}\`.` : 'The app did not print a result; check the commands panel.');
}

/**
 * A minimal MCP client over stdio, enough to call one tool: initialize, the
 * initialized notification, tools/call. Hand-written so this agent needs no
 * MCP package.
 */
function mcpClient(server) {
  const env = { ...process.env };
  for (const v of server.env ?? []) env[v.name] = v.value;
  const child = spawn(server.command, server.args ?? [], { env, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const waiting = new Map();
  let nextId = 1;
  let buffer = '';
  const failAll = (err) => {
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
  };
  child.once('error', (err) => failAll(err));
  child.once('exit', () => failAll(new Error('The FriedLiver tools stopped.')));
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const w = msg.id !== undefined && waiting.get(msg.id);
      if (!w) continue;
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message));
      else w.resolve(msg.result);
    }
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        waiting.set(id, { resolve, reject });
        send({ id, method, params });
      }),
    notify: (method, params) => send({ method, params }),
    close: () => {
      child.stdin.end();
      child.kill();
    },
  };
}

const startMcp = process.env.FAKE_AGENT_START_MCP === '1';
/** MCP servers started with their session, kept for as long as this agent runs. */
const runningMcp = [];

/** Starts an MCP server and lists its tools, the way an agent does when a session starts. */
function keepMcp(server) {
  const mcp = mcpClient(server);
  runningMcp.push(mcp);
  mcp
    .request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-agent', version: '0.0.0' } })
    .then(() => {
      mcp.notify('notifications/initialized');
      return mcp.request('tools/list', {});
    })
    .catch(() => {});
}

/** Calls one of the session's FriedLiver tools and returns its text; a tool error throws. */
async function useTool(sessionId, name, args) {
  const server = (sessionMcp.get(sessionId) ?? []).find((s) => s.name === 'friedliver' && typeof s.command === 'string');
  if (!server) throw new Error('This session has no FriedLiver tools.');
  const mcp = mcpClient(server);
  const stop = new Promise((_, reject) => cancels.set(sessionId, () => reject(new Error('cancelled'))));
  stop.catch(() => {});
  try {
    await Promise.race([mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-agent', version: '0.0.0' } }), stop]);
    mcp.notify('notifications/initialized');
    const result = await Promise.race([mcp.request('tools/call', { name, arguments: args }), stop]);
    const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (result.isError) throw new Error(text || 'The tool failed.');
    return text;
  } finally {
    cancels.delete(sessionId);
    mcp.close();
  }
}

async function ask(client, sessionId, agent, question) {
  const name = AGENT_NAMES[agent] ?? agent;
  try {
    const answer = await useTool(sessionId, 'ask_agent', { agent, prompt: question });
    await say(client, sessionId, `${name} says: ${answer}`);
  } catch (err) {
    if (err.message === 'cancelled') return 'cancelled';
    await say(client, sessionId, `Couldn't ask ${name}: ${err.message}`);
  }
  return 'end_turn';
}

const BUSY_CHUNK_MS = 250;
const BUSY_STEPS = ['Read the code', 'Find what to change', 'Write the change', 'Add tests', 'Run the checks', 'Sum up'];
const BUSY_FILES = ['package.json', 'README.md', 'src/format.ts', 'src/index.ts', 'test/format.test.ts'];
const BUSY_TOOLS = [
  { kind: 'read', title: (f) => `Read ${f}` },
  { kind: 'search', title: (f) => `Search for callers of ${path.basename(f).replace(/\..*$/, '')}` },
  { kind: 'think', title: () => 'Check the edge cases' },
];
const BUSY_SENTENCES = [
  'The price formatter takes cents and returns a string with two decimals.',
  'Negative amounts lose their sign before the dollar mark, so refunds print as charges.',
  'I will keep the public signature and change only the body.',
  'Rounding stays half-up, which is what the invoices expect.',
  'The tests cover zero, one cent, large amounts and negative values.',
  'Nothing else in the project calls this helper with fractions of a cent.',
  'The change is small, so the diff should be easy to review.',
  'Next I check the callers to make sure none of them depends on the old output.',
];
const BUSY_LISTS = [
  ['Keep `formatCents` exported under the same name', 'Put the sign in front of the dollar mark', 'Leave the rounding alone'],
  ['`formatCents(0)` is `$0.00`', '`formatCents(-150)` is `-$1.50`', '`formatCents(123456)` is `$1234.56`'],
];
const BUSY_CODE = [
  '```ts',
  'export function formatCents(cents: number): string {',
  "  const sign = cents < 0 ? '-' : '';",
  '  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;',
  '}',
  '```',
];

/**
 * What a busy agent streams: a heading, two paragraphs, a list and a code
 * block, again and again, in chunks of three to five words (code a line at a
 * time). The same sequence every time. `end` marks a sentence's last chunk;
 * `block` a chunk inside a list or code block, which no tool call interrupts.
 */
function* busyChunks() {
  for (let round = 0; ; round++) {
    yield { text: `${round ? '\n' : ''}### Part ${round + 1}\n\n` };
    for (let s = 0; s < 6; s++) {
      const words = BUSY_SENTENCES[(round * 6 + s) % BUSY_SENTENCES.length].split(' ');
      for (let w = 0, n = 0; w < words.length; n++) {
        const size = 3 + (n % 3);
        const end = w + size >= words.length;
        yield { text: words.slice(w, w + size).join(' ') + (end ? '' : ' '), end };
        w += size;
      }
      yield { text: s === 2 || s === 5 ? '\n\n' : ' ' };
    }
    for (const line of BUSY_LISTS[round % BUSY_LISTS.length]) yield { text: `- ${line}\n`, block: true };
    yield { text: '\n' };
    for (const [i, line] of BUSY_CODE.entries()) yield { text: `${line}\n`, block: i < BUSY_CODE.length - 1 };
  }
}

/** "busy <seconds>": streams, calls tools, keeps a plan and reads files until the time is up or the turn is cancelled. */
async function busy(client, sessionId, seconds, stamp) {
  const cwd = sessionCwd.get(sessionId) ?? process.cwd();
  const start = Date.now();
  const end = start + seconds * 1000;
  let cancelled = false;
  let wake = () => {};
  cancels.set(sessionId, () => {
    cancelled = true;
    wake();
  });
  // Stop wakes the loop at once; the timer, a quarter second at most, then resolves nothing.
  const sleepUntil = (at) =>
    new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, at - Date.now()));
      wake = resolve;
    });
  const stamped = () => (stamp ? ` \`t=${Date.now()}\`` : '');
  const plan = (current) =>
    tool(client, sessionId, {
      sessionUpdate: 'plan',
      entries: BUSY_STEPS.map((content, i) => ({
        content: i === current ? `${content}${stamped()}` : content,
        priority: 'medium',
        status: i < current ? 'completed' : i === current ? 'in_progress' : 'pending',
      })),
    });
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `Planning ${BUSY_STEPS.length} steps for about ${seconds} s.` } },
  });
  const chunks = busyChunks();
  /** Tool calls in progress: the tick each completes on, and what it found. */
  const open = new Map();
  let step = -1;
  let nextTool = 5;
  let tools = 0;
  let reads = 0;
  try {
    for (let tick = 0; !cancelled && Date.now() < end; tick++) {
      const due = Math.min(BUSY_STEPS.length - 1, Math.floor(((Date.now() - start) / (seconds * 1000)) * BUSY_STEPS.length));
      if (due !== step) await plan((step = due));
      const chunk = chunks.next().value;
      await say(client, sessionId, chunk.end ? `${chunk.text}${stamped()}` : chunk.text);
      // A tool call about every 2.5 s, between blocks: pending, in progress, and completed a second later.
      if (tick >= nextTool && !chunk.block) {
        nextTool = tick + 10;
        const file = BUSY_FILES[tools % BUSY_FILES.length];
        const kind = BUSY_TOOLS[tools % BUSY_TOOLS.length];
        const toolCallId = `busy-${tools++}`;
        const location = path.join(cwd, file);
        await tool(client, sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: kind.title(file),
          kind: kind.kind,
          status: 'pending',
          locations: kind.kind === 'read' ? [{ path: location }] : [],
        });
        await tool(client, sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' });
        let found;
        // Every other read goes through the client, as real agents read open files.
        if (kind.kind === 'read' && reads++ % 2 === 0) {
          found = await client
            .request(acp.methods.client.fs.readTextFile, { sessionId, path: location })
            .then((r) => `${r.content.split('\n').length} lines`)
            .catch(() => 'not found');
        }
        open.set(toolCallId, { at: tick + 4, found });
      }
      for (const [toolCallId, { at, found }] of open) {
        if (tick < at) continue;
        open.delete(toolCallId);
        const content = found ? [{ type: 'content', content: { type: 'text', text: found } }] : undefined;
        await tool(client, sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', ...(content ? { content } : {}) });
      }
      await sleepUntil(start + (tick + 1) * BUSY_CHUNK_MS);
    }
    for (const toolCallId of open.keys()) {
      await tool(client, sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: cancelled ? 'failed' : 'completed' });
    }
    if (cancelled) return 'cancelled';
    await plan(BUSY_STEPS.length);
    await say(client, sessionId, `\n\nDone after ${seconds} s: ${tools} tool calls, ${Math.ceil(reads / 2)} files read.`);
    return 'end_turn';
  } finally {
    cancels.delete(sessionId);
  }
}

async function run(client, sessionId) {
  let terminalId;
  try {
    ({ terminalId } = await client.request(acp.methods.client.terminal.create, {
      sessionId,
      command: process.execPath,
      args: ['-e', "console.log('hello from terminal')"],
      // Inside FriedLiver this agent runs on Electron's binary; make the command run as Node too.
      env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
    }));
  } catch {
    await say(client, sessionId, 'You denied the command, so I skipped it.');
    return;
  }
  await tool(client, sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'run-1',
    title: 'Run node',
    kind: 'execute',
    status: 'in_progress',
    content: [{ type: 'terminal', terminalId }],
  });
  const exit = await client.request(acp.methods.client.terminal.waitForExit, { sessionId, terminalId });
  const { output } = await client.request(acp.methods.client.terminal.output, { sessionId, terminalId });
  await client.request(acp.methods.client.terminal.release, { sessionId, terminalId });
  await tool(client, sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'run-1', status: 'completed' });
  await say(client, sessionId, `exit ${exit.exitCode}: ${output.trim()}`);
}

acp
  .agent({ name: 'fake-agent' })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession, promptCapabilities: { image: images } },
    authMethods: needsTerminalLogin
      ? [{ id: 'demo-login', name: 'Log in with Demo', description: 'Run the demo login in the terminal', type: 'terminal', args: ['--cli'] }]
      : needsAuth
        ? [{ id: 'fake-login', name: 'Fake login' }]
        : [],
    agentInfo: { name: 'fake-agent', version: '0.0.0' },
  }))
  .onRequest(acp.methods.agent.authenticate, async ({ params }) => {
    if (params.methodId !== 'fake-login') throw acp.RequestError.invalidParams();
    process.stderr.write('Open https://accounts.google.com/o/oauth2/v2/auth?client_id=demo to sign in\n');
    await new Promise((r) => setTimeout(r, 300));
    authenticated = true;
    return {};
  })
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    if (needsAuth && !authenticated) throw acp.RequestError.authRequired();
    if (needsTerminalLogin && !existsSync(LOGIN_MARKER)) throw acp.RequestError.authRequired();
    const sessionId = `fake-session-${nextSession++}`;
    sessionCwd.set(sessionId, params.cwd);
    sessionMcp.set(sessionId, params.mcpServers ?? []);
    if (startMcp) for (const server of params.mcpServers ?? []) if (typeof server.command === 'string') keepMcp(server);
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.load, ({ params }) => {
    if (!loadSession) throw acp.RequestError.methodNotFound('session/load');
    sessionCwd.set(params.sessionId, params.cwd);
    sessionMcp.set(params.sessionId, params.mcpServers ?? []);
    return {};
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    cancels.get(params.sessionId)?.();
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const { sessionId } = params;
    const texts = params.prompt.filter((b) => b.type === 'text').map((b) => b.text);
    const text = texts.join(' ');
    // What to do comes from the last text block; earlier ones are context.
    const command = texts.at(-1) ?? '';
    const imageCount = params.prompt.filter((b) => b.type === 'image').length;
    const asked = command.match(/^ask (\w+) ([\s\S]+)$/);

    if (command === 'wait') {
      await new Promise((resolve) => cancels.set(sessionId, resolve));
      cancels.delete(sessionId);
      return { stopReason: 'cancelled' };
    }
    if (asked) return { stopReason: await ask(client, sessionId, asked[1], asked[2]) };
    const fromEditor = editorRequest(texts);
    if (fromEditor) {
      await handleEditorRequest(fromEditor, command, {
        cwd: sessionCwd.get(sessionId) ?? process.cwd(),
        read: (p) => client.request(acp.methods.client.fs.readTextFile, { sessionId, path: p }).then((r) => r.content),
        write: (p, content) => client.request(acp.methods.client.fs.writeTextFile, { sessionId, path: p, content }),
        say: (t) => say(client, sessionId, t),
      });
      return { stopReason: 'end_turn' };
    }
    const busyFor = command.match(/^busy\s+(\d+(?:\.\d+)?)(\s+stamp)?\s*$/);
    if (busyFor) return { stopReason: await busy(client, sessionId, Math.min(Number(busyFor[1]), 3600), !!busyFor[2]) };
    if (command === 'chats') {
      try {
        await say(client, sessionId, await useTool(sessionId, 'list_chats', {}));
      } catch (err) {
        await say(client, sessionId, `Couldn't list chats: ${err.message}`);
      }
    } else if (command === 'tour') await tour(client, sessionId);
    else if (command === 'project') await project(client, sessionId);
    else if (command.startsWith('edit ')) await edit(client, sessionId, command.slice(5));
    else if (command === 'run') await run(client, sessionId);
    else if (command.startsWith('read-image ')) {
      const path = command.slice(11);
      await tool(client, sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'read-1',
        title: `Read ${path}`,
        kind: 'read',
        status: 'completed',
        locations: [{ path }],
      });
    } else {
      await say(client, sessionId, 'You said: ');
      await say(client, sessionId, `${text}${imageCount ? ` (+${imageCount} image)` : ''}`);
    }
    return { stopReason: 'end_turn' };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));

// The client is gone (it closed our stdin): the MCP servers kept for its sessions go too.
if (startMcp) {
  process.stdin.once('end', () => {
    for (const mcp of runningMcp) mcp.close();
    process.exit(0);
  });
}
}
