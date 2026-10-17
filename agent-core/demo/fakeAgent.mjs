#!/usr/bin/env node
// A tiny ACP agent for tests. What it does depends on the prompt text:
//   "edit <path>"     asks permission with a diff (in Ask mode), then writes <path> through the client
//   "run"             runs a command in a client terminal and reports its output
//   "native-edit <p>" edits <p> itself with node:fs, like Claude and Codex: a diff in the
//                     permission request (Ask mode) and in the tool call, no fs/write_text_file
//   "native-run"      runs a command itself, like Claude and Codex: no terminal/create, the output
//                     arrives in the tool call
//   "native-read <p>" / "native-fetch <url>"  a permission request to read a file or fetch a page,
//                     like Claude outside its folder and its WebFetch
//   "native-perm <kind> <json>"  a permission request of any kind with that rawInput (and `locations`)
//   "perm-edit <p>"   like Codex: a tool call with the diff, then a permission request that names
//                     only its toolCallId, then a native write
//   "perm-plan"       a plan approval (kind switch_mode, the plan in rawInput.plan), like Claude's
//                     ExitPlanMode and Codex's "Implement this plan?"
//   "plan"            switches to Plan mode, sends a plan, then asks as perm-plan does
//   "question"        asks a multiple-choice question as a form (elicitation/create), like
//                     Claude's AskUserQuestion, when the client takes forms
//   "ask-user [n]"    asks n questions (default 1) exactly as claude-agent-acp sends Claude's
//                     AskUserQuestion: question_<k> (oneOf, the pick marked "(Recommended)") and its
//                     free-text question_<k>_custom ("Other"), nothing required; says what came back
//   "session"         says the session id and the _meta its session/new or session/load carried
//   "links"           says which files the message linked (resource_link blocks)
//   "read-image <p>"  reports a read tool call on an image file
//   "wait"            keeps working until cancelled
//   "tour"            the UI demo: a plan, a file read, an edit, a command and an image
//   "project"         builds calc/, runs its tests, fixes the failing one, reruns, runs the app
//   "heavy"           like Claude building a small SQL engine in agent_heavy/: shell steps with long
//                     multi-line heredoc commands (SQL piped into a script, files written with
//                     cat << 'EOF' > file) and their output, then a plain-text summary with labels,
//                     ✓ lists under numbered items and file paths. Asks before each command in Ask
//                     mode; writes the two files its heredocs write; the program output is canned
//   "ask <agent> <q>" asks another agent through the session's FriedLiver tools (MCP) and
//                     replies "<Agent> says: <answer>"; "ask demo hello" needs no sign-in
//   "chats"           lists FriedLiver's chats through the same tools
//   "system"          says what session/new appended to its system prompt (_meta.systemPrompt.append,
//                     as claude-agent-acp takes it), or "no system prompt"
//   an editor request (Edit with Agent, Review My Changes): see editorRequests.mjs
//   "busy <s> [stamp]" works like a busy real agent for <s> seconds, for stress tests
//                     (scripts/stress-demo.mjs): markdown in small chunks, four a second,
//                     with lists and code blocks; tool calls and their updates; a plan; a
//                     file read now and then. Never asks for anything. "stamp" ends each
//                     sentence and the plan's current step with `t=<ms since epoch>`.
//   "/help", "/compact" slash commands (advertised in available_commands_update)
//   anything else     echoes the text back in two chunks, with the model and effort when they
//                     aren't the defaults: "You said: hi (demo-small · low)"
// Only the last text block is read as one of these, so context a client puts
// in front of the message (a hand-off, a consultation) is echoed but ignored.
// Sessions advertise config options like Claude's and Codex's: a mode (Ask, Accept edits,
// Plan, Full access), a model in two groups, an effort level that depends on the model
// ("thought_level") and a Fast toggle ("model_config"; boolean only for clients that say they
// take boolean options). session/set_mode, session/set_config_option and session/set_model work.
// Every turn ends with a usage_update. Steering (_session/steering) works while "wait" runs.
// FAKE_AGENT_LEGACY=1 sends only the older `modes` and Gemini's unstable `models`, and takes the
// model through session/set_model, as Gemini does.
// FAKE_AGENT_LOAD_SESSION=1 makes it offer session/load (it remembers nothing, so
// a reloaded chat just carries on).
// FAKE_AGENT_START_MCP=1 makes it start each session's MCP servers (the FriedLiver tools)
// when the session starts and keep them running, as real agents do, instead of only
// for a tool call; the stress test uses it to count their memory.
// It takes MCP servers over HTTP as well as stdio, as Claude's, Codex's and Gemini's
// adapters do; FAKE_AGENT_MCP_HTTP=0 makes it take stdio servers only.
// FAKE_AGENT_AUTH=1 makes session/new require authenticate("fake-login") first;
// that browser-style sign-in prints a sign-in link to stderr, like Gemini's. It
// then also offers `logout` and sends `_auth/status_update`, like Claude's and Codex's.
// --require-login makes it need a terminal login instead, like Claude's: the
// client runs this script with --cli, which asks for Enter and saves a marker.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { editorRequest, handleEditorRequest } from './editorRequests.mjs';

const systemAppend = new Map();
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
const httpMcp = process.env.FAKE_AGENT_MCP_HTTP !== '0';
let authenticated = false;
let nextSession = 1;
const cancels = new Map();
const sessionCwd = new Map();
const sessionMeta = new Map();
const sessionMcp = new Map();
const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', demo: 'Demo' };
const legacy = process.env.FAKE_AGENT_LEGACY === '1';
/** The client takes `type: "boolean"` config options (session.configOptions.boolean). */
let booleanOptions = false;
/** The client shows form questions (elicitation.form). */
let forms = false;
/** What each session's user chose: mode, model, effort, Fast, and the context used so far. */
const choices = new Map();
/** Steered messages waiting for a running "wait", per session. */
const steered = new Map();

// Shaped like Claude's and Codex's: ids FriedLiver doesn't know, names that say what they do.
const MODES = [
  { id: 'default', name: 'Ask', description: 'Asks before it edits a file or runs a command' },
  { id: 'acceptEdits', name: 'Accept edits', description: 'Edits files without asking; commands still ask' },
  { id: 'plan', name: 'Plan', description: 'Plans only and changes nothing' },
  { id: 'bypassPermissions', name: 'Full access', description: 'Never asks' },
];
const MODELS = [
  { id: 'demo-smart', name: 'Smart', description: 'Every effort level', group: 'thorough', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'demo-small', name: 'Small', description: 'Low and medium effort only', group: 'quick', efforts: ['low', 'medium'] },
];
const MODEL_GROUPS = [
  { group: 'thorough', name: 'Thorough' },
  { group: 'quick', name: 'Quick' },
];
const DEFAULTS = { mode: 'default', model: 'demo-smart', effort: 'medium', fast: false };
const COMMANDS = [
  { name: 'help', description: 'What the Demo agent can do' },
  { name: 'compact', description: 'Clear the context, so usage starts over' },
  { name: 'review', description: 'Pretend to review a file', input: { hint: 'file to review' } },
];
const HELP = [
  '`tour`, `project`, `heavy` (long shell steps and a plain-text summary, like Claude), `edit <path>`, `run`, `read-image <path>`, `wait`, `ask <agent> <question>`, `chats`,',
  '`native-edit <path>` and `native-run` (the agent acts itself, like Claude and Codex), `native-read <path>` and `native-fetch <url>` (it asks first), `perm-edit <path>` (a Codex-style',
  'permission that names only its tool call), `plan` and `perm-plan` (a plan to approve), `/compact`.',
].join(' ');

const capitalized = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const stateOf = (sessionId) => choices.get(sessionId) ?? { ...DEFAULTS, used: 0 };

function configOptions(state) {
  const model = MODELS.find((m) => m.id === state.model) ?? MODELS[0];
  const fast = { id: 'fast', name: 'Fast mode', description: 'Answers sooner', category: 'model_config' };
  return [
    {
      id: 'mode',
      name: 'Mode',
      description: 'When the Demo agent asks you',
      category: 'mode',
      type: 'select',
      currentValue: state.mode,
      options: MODES.map((m) => ({ value: m.id, name: m.name, description: m.description })),
    },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: state.model,
      options: MODEL_GROUPS.map((g) => ({
        group: g.group,
        name: g.name,
        options: MODELS.filter((m) => m.group === g.group).map((m) => ({ value: m.id, name: m.name, description: m.description })),
      })),
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: state.effort,
      options: model.efforts.map((e) => ({ value: e, name: capitalized(e) })),
    },
    booleanOptions
      ? { ...fast, type: 'boolean', currentValue: state.fast }
      : { ...fast, type: 'select', currentValue: state.fast ? 'on' : 'off', options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] },
  ];
}

const modeState = (state) => ({ currentModeId: state.mode, availableModes: MODES });
const modelState = (state) => ({ currentModelId: state.model, availableModels: MODELS.map((m) => ({ modelId: m.id, name: m.name, description: m.description })) });

/** What session/new and session/load answer with, besides the id. */
function sessionSetup(state) {
  return legacy ? { modes: modeState(state), models: modelState(state) } : { modes: modeState(state), configOptions: configOptions(state) };
}

function setModel(state, id) {
  const model = MODELS.find((m) => m.id === id);
  if (!model) throw acp.RequestError.invalidParams(undefined, `Unknown model ${id}`);
  state.model = id;
  // A model with fewer levels moves the effort, as Claude's and Codex's do.
  if (!model.efforts.includes(state.effort)) state.effort = model.efforts.includes('medium') ? 'medium' : model.efforts[0];
}

function setMode(state, id) {
  if (!MODES.some((m) => m.id === id)) throw acp.RequestError.invalidParams(undefined, `Unknown mode ${id}`);
  state.mode = id;
}

/** Commands and the starting usage, a moment after the session answer, as Gemini sends them. */
function announceSession(client, sessionId) {
  setTimeout(() => {
    void client.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS } }).catch(() => {});
  }, 0);
}

async function announceMode(client, sessionId, state) {
  await tool(client, sessionId, { sessionUpdate: 'current_mode_update', currentModeId: state.mode });
  if (!legacy) await tool(client, sessionId, { sessionUpdate: 'config_option_update', configOptions: configOptions(state) });
}

async function reportUsage(client, sessionId, state, text) {
  state.used = Math.min(200_000, state.used + 1500 + text.length * 4);
  await tool(client, sessionId, {
    sessionUpdate: 'usage_update',
    used: state.used,
    size: 200_000,
    cost: { amount: Math.round(state.used * 3) / 1_000_000, currency: 'USD' },
  });
}

/** Asks before a tool runs, in the modes that ask for that kind of tool. Resolves true when allowed. */
async function allowed(client, sessionId, kind, toolCall, options) {
  const { mode } = stateOf(sessionId);
  if (mode === 'bypassPermissions' || (mode === 'acceptEdits' && kind === 'edit')) return true;
  const answer = await client.request(acp.methods.client.session.requestPermission, { sessionId, toolCall, options });
  const chosen = answer.outcome.outcome === 'selected' ? options.find((o) => o.optionId === answer.outcome.optionId) : undefined;
  return chosen?.kind.startsWith('allow') ?? false;
}

const ASK_OPTIONS = [
  { optionId: 'allow', name: 'Yes', kind: 'allow_once' },
  { optionId: 'always', name: "Yes, and don't ask again for this session", kind: 'allow_always' },
  { optionId: 'reject', name: 'No', kind: 'reject_once' },
];

/** The proposal for <file>: a new file, or one line added after the first. */
function nativeChange(file, marker) {
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (before === null) return { before, after: `${marker}\n`, diff: { type: 'diff', path: file, oldText: null, newText: `${marker}\n` } };
  const first = before.split('\n')[0];
  const oldText = `${first}\n`;
  const newText = `${first}\n${marker}\n`;
  const after = before.includes(oldText) ? before.replace(oldText, newText) : `${before}${before.endsWith('\n') || !before ? '' : '\n'}${marker}\n`;
  return { before, after, diff: { type: 'diff', path: file, oldText: before.includes(oldText) ? oldText : before, newText: before.includes(oldText) ? newText : after } };
}

function writeNative(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

/** Like Claude's Edit tool: the diff in the tool call and in the permission request, then its own write. */
async function nativeEdit(client, sessionId, file) {
  if (stateOf(sessionId).mode === 'plan') return say(client, sessionId, "I'm in Plan mode, so I don't change files.");
  const change = nativeChange(file, 'edited by the demo agent itself');
  const call = { toolCallId: 'native-edit-1', title: `Edit ${path.basename(file)}`, kind: 'edit', locations: [{ path: file }], content: [change.diff] };
  await tool(client, sessionId, { sessionUpdate: 'tool_call', ...call, status: 'pending', rawInput: { file_path: file } });
  const ok = await allowed(client, sessionId, 'edit', { ...call, rawInput: { file_path: file } }, ASK_OPTIONS);
  if (ok) writeNative(file, change.after);
  await tool(client, sessionId, { sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: ok ? 'completed' : 'failed' });
  await say(client, sessionId, ok ? `Edited \`${path.basename(file)}\` myself, without the client's file access.` : 'You said no, so I left the file alone.');
}

/** Like Codex's apply_patch: a tool call with the diff, then a permission request with only its id. */
async function permEdit(client, sessionId, file) {
  if (stateOf(sessionId).mode === 'plan') return say(client, sessionId, "I'm in Plan mode, so I don't change files.");
  const change = nativeChange(file, 'patched by the demo agent');
  const toolCallId = 'perm-edit-1';
  await tool(client, sessionId, { sessionUpdate: 'tool_call', toolCallId, title: 'Edit files', kind: 'edit', status: 'pending', locations: [{ path: file }], content: [change.diff] });
  const ok = await allowed(client, sessionId, 'edit', { toolCallId }, [
    { optionId: 'approved', name: 'Yes', kind: 'allow_once' },
    { optionId: 'approved-for-session', name: "Yes, and don't ask again for these files", kind: 'allow_always' },
    { optionId: 'abort', name: 'No, and tell the agent what to do differently', kind: 'reject_once' },
  ]);
  if (ok) writeNative(file, change.after);
  await tool(client, sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: ok ? 'completed' : 'failed' });
  await say(client, sessionId, ok ? `Patched \`${path.basename(file)}\`.` : 'Not patched.');
}

/** Like Claude reading a file outside its folder, or its WebFetch: a permission request, nothing else. */
async function nativeAsk(client, sessionId, kind, target) {
  const toolCallId = `native-${kind}-1`;
  const call =
    kind === 'read'
      ? { toolCallId, title: `Read ${path.basename(target)}`, kind: 'read', locations: [{ path: target }], rawInput: { file_path: target } }
      : { toolCallId, title: `Fetch ${target}`, kind: 'fetch', rawInput: { url: target, prompt: 'Summarize the page' } };
  await tool(client, sessionId, { sessionUpdate: 'tool_call', ...call, status: 'pending' });
  const ok = await allowed(client, sessionId, kind, call, ASK_OPTIONS);
  await tool(client, sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: ok ? 'completed' : 'failed' });
  await say(client, sessionId, ok ? `Allowed to ${kind} ${target}.` : `Not allowed to ${kind} ${target}.`);
}

/**
 * "native-perm <kind> <json>": a permission request of that kind with the JSON as its rawInput,
 * and its `locations` (paths) as the tool call's, the way other agents' tools shape them.
 */
async function nativePerm(client, sessionId, args) {
  const space = args.indexOf(' ');
  const kind = args.slice(0, space);
  const { locations = [], ...rawInput } = JSON.parse(args.slice(space + 1));
  const toolCallId = 'native-perm-1';
  const call = { toolCallId, title: `${kind} ${JSON.stringify(rawInput)}`, kind, locations: locations.map((p) => ({ path: p })), rawInput };
  await tool(client, sessionId, { sessionUpdate: 'tool_call', ...call, status: 'pending' });
  const ok = await allowed(client, sessionId, kind, call, ASK_OPTIONS);
  await tool(client, sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: ok ? 'completed' : 'failed' });
  await say(client, sessionId, ok ? 'Allowed.' : 'Not allowed.');
}

/** Like Claude's Bash tool: asks (in Ask mode), runs the command itself, and reports its output in the tool call. */
async function nativeRun(client, sessionId) {
  const cwd = sessionCwd.get(sessionId) ?? process.cwd();
  const command = 'node --version';
  const toolCallId = 'native-run-1';
  const call = { toolCallId, title: command, kind: 'execute', rawInput: { command, description: 'Show the Node.js version' } };
  await tool(client, sessionId, { sessionUpdate: 'tool_call', ...call, status: 'pending' });
  if (!(await allowed(client, sessionId, 'execute', call, ASK_OPTIONS))) {
    await tool(client, sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' });
    return say(client, sessionId, 'You said no, so I skipped the command.');
  }
  await tool(client, sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' });
  const output = await new Promise((resolve) => {
    let out = '';
    const child = spawn(process.execPath, ['--version'], { cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ out, code }));
    child.on('error', (err) => resolve({ out: err.message, code: 127 }));
  });
  await tool(client, sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: output.code === 0 ? 'completed' : 'failed',
    content: [{ type: 'content', content: { type: 'text', text: output.out } }],
    rawOutput: { exitCode: output.code },
  });
  await say(client, sessionId, `Ran it myself: exit ${output.code}.`);
}

const HEAVY_USERS_SQL = [
  'CREATE TABLE users (id INT, email TEXT, age INT);',
  "INSERT INTO users VALUES (1, 'alice@example.com', 28);",
  "INSERT INTO users VALUES (2, 'bob@example.com', 35);",
  "INSERT INTO users VALUES (3, 'charlie@example.com', 25);",
  'SELECT * FROM users;',
  'SELECT email, age FROM users WHERE age > 26;',
  'SELECT COUNT(*) FROM users;',
  'SELECT AVG(age) FROM users;',
  "UPDATE users SET age = 30 WHERE email = 'alice@example.com';",
  'SELECT * FROM users ORDER BY age DESC;',
  'DELETE FROM users WHERE age < 30;',
  'SELECT COUNT(*) FROM users;',
  'exit',
].join('\n');
const HEAVY_USERS_OUT = [
  'OK: table users created',
  'OK: 3 rows inserted',
  '+----+---------------------+-----+',
  '| id | email               | age |',
  '+----+---------------------+-----+',
  '| 1  | alice@example.com   | 28  |',
  '| 2  | bob@example.com     | 35  |',
  '| 3  | charlie@example.com | 25  |',
  '+----+---------------------+-----+',
  '(3 rows)',
  '+---------------------+-----+',
  '| email               | age |',
  '+---------------------+-----+',
  '| alice@example.com   | 28  |',
  '| bob@example.com     | 35  |',
  '+---------------------+-----+',
  '(2 rows)',
  'COUNT(*) = 3',
  'AVG(age) = 29.33',
  'OK: 1 row updated',
  'OK: 1 row deleted',
  'COUNT(*) = 2',
  'Bye.',
].join('\n');
const HEAVY_DEMO_SQL = [
  '-- Advanced demo: GROUP BY + HAVING, aggregates, ORDER BY with LIMIT',
  'CREATE TABLE products (id INT, name TEXT, price INT, category TEXT);',
  'CREATE TABLE orders (id INT, product_id INT, qty INT, amount INT);',
  "INSERT INTO products VALUES (1, 'Laptop', 1000, 'Electronics');",
  "INSERT INTO products VALUES (2, 'Mouse', 25, 'Electronics');",
  "INSERT INTO products VALUES (3, 'Desk', 200, 'Furniture');",
  'INSERT INTO orders VALUES (1, 1, 2, 2000);',
  'INSERT INTO orders VALUES (2, 2, 5, 125);',
  'INSERT INTO orders VALUES (3, 3, 1, 200);',
  '-- Orders per product',
  'SELECT product_id, COUNT(*) FROM orders GROUP BY product_id;',
  '-- Top order by amount',
  'SELECT * FROM orders ORDER BY amount DESC LIMIT 1;',
  'SELECT SUM(amount) FROM orders;',
  'DROP TABLE products;',
  'DROP TABLE orders;',
].join('\n');
const HEAVY_README = [
  '# Mini SQL Database Engine',
  '',
  'A lightweight, stdlib-only SQL database in Python 3, with ASCII table output and an interactive REPL.',
  '',
  '## Features',
  '',
  '### DDL',
  '- `CREATE TABLE` with INT, TEXT and FLOAT columns',
  '- `DROP TABLE`',
  '',
  '### DML',
  '- `INSERT INTO` with type casting',
  '- `UPDATE` and `DELETE FROM` with an optional WHERE clause',
  '- `SELECT` with WHERE, ORDER BY, LIMIT, GROUP BY and HAVING',
  '- Aggregates: COUNT(*), SUM(), AVG(), MIN(), MAX()',
  '',
  '## Usage',
  '',
  '```bash',
  'python3 minidb.py test.sql   # run a script',
  'python3 minidb.py            # interactive REPL',
  '```',
  '',
].join('\n');

/**
 * "heavy": what a Claude turn building a small SQL engine looks like. Each step is Claude's Bash tool
 * as its adapter reports it: the command as the title and in rawInput with a description, asked
 * about in Ask mode, then its output in a ```console block. The heredoc writes write their files.
 */
async function heavy(client, sessionId) {
  const state = stateOf(sessionId);
  if (state.mode === 'plan') return say(client, sessionId, "I'm in Plan mode, so I don't run commands.");
  const cwd = sessionCwd.get(sessionId) ?? process.cwd();
  const dir = path.join(cwd, 'agent_heavy');
  let n = 0;
  /** One Bash step; `write` is [file, text] for a heredoc that writes a file. Resolves false when you said no. */
  const bash = async (command, description, output, write) => {
    const toolCallId = `heavy-${++n}`;
    const call = { toolCallId, title: command, kind: 'execute', rawInput: { command, description } };
    await tool(client, sessionId, { sessionUpdate: 'tool_call', ...call, status: 'pending', content: [{ type: 'content', content: { type: 'text', text: description } }] });
    if (!(await allowed(client, sessionId, 'execute', call, ASK_OPTIONS))) {
      await tool(client, sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'The user doesn\'t want to run this command.' } }] });
      return false;
    }
    await tool(client, sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' });
    await pause(250);
    if (write) writeNative(write[0], write[1]);
    await tool(client, sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed',
      ...(output ? { content: [{ type: 'content', content: { type: 'text', text: `\`\`\`console\n${output}\n\`\`\`` } }] } : {}),
    });
    return true;
  };
  await say(client, sessionId, "I'll run the engine's test script, try more queries through stdin, add an advanced demo and write the README.\n\n");
  const steps = [
    [`cd ${dir} && python3 minidb.py test.sql 2>&1`, 'Run the core test script', 'OK: 22 queries, 0 failures'],
    [`cat << 'EOF' | python3 ${dir}/minidb.py\n${HEAVY_USERS_SQL}\nEOF`, 'Try the engine with queries from stdin', HEAVY_USERS_OUT],
    [`ls -lh ${dir}/ && wc -l ${dir}/minidb.py ${dir}/test.sql`, 'List the files and count lines', `total 28K\n-rw-r--r-- 1 dev dev 21K minidb.py\n-rw-r--r-- 1 dev dev 1.9K test.sql\n  561 ${dir}/minidb.py\n   48 ${dir}/test.sql\n  609 total`],
    [
      `cat << 'EOF' > ${dir}/demo_advanced.sql\n${HEAVY_DEMO_SQL}\nEOF\npython3 ${dir}/minidb.py ${dir}/demo_advanced.sql`,
      'Write the advanced demo and run it',
      '+------------+----------+\n| product_id | COUNT(*) |\n+------------+----------+\n| 1          | 1        |\n| 2          | 1        |\n| 3          | 1        |\n+------------+----------+\n(3 rows)\nOK: 16 queries',
      [path.join(dir, 'demo_advanced.sql'), `${HEAVY_DEMO_SQL}\n`],
    ],
    [`cat << 'EOF' > ${dir}/README.md\n${HEAVY_README}EOF`, 'Write the README', '', [path.join(dir, 'README.md'), HEAVY_README]],
  ];
  for (const [command, description, output, write] of steps) {
    if (!(await bash(command, description, output, write))) return say(client, sessionId, 'You said no, so I stopped there.');
    await pause(150);
  }
  await say(
    client,
    sessionId,
    [
      `Done. The engine is tested and documented in ${dir}.`,
      '',
      'FEATURES IMPLEMENTED & VERIFIED:',
      '✓ DDL (Data Definition Language)',
      '  - CREATE TABLE (INT, TEXT, FLOAT types)',
      '  - DROP TABLE',
      '✓ DML (Data Manipulation Language)',
      '  - INSERT INTO with type casting',
      '  - UPDATE and DELETE with WHERE',
      '✓ SELECT with WHERE, ORDER BY, LIMIT, GROUP BY + HAVING',
      '✗ JOIN (simplified: shows order data only)',
      '',
      'TEST RESULTS:',
      '1. test.sql - Core features (22 queries)',
      '   ✓ CREATE TABLE × 2',
      '   ✓ INSERT × 8, UPDATE × 2, DELETE × 1',
      '2. demo_advanced.sql - GROUP BY, aggregates (16 queries)',
      '   ✓ All queries return the expected rows',
      '',
      'FILES:',
      `${dir}/minidb.py (561 lines) - Main implementation`,
      `${dir}/demo_advanced.sql - Advanced demo`,
      `${dir}/README.md:7 - Documentation, features from line 7`,
    ].join('\n'),
  );
}

const PLAN_TEXT = '## Plan\n\n1. Read `README.md`\n2. Add a **Usage** section\n3. Run the tests';

/** Like Claude's ExitPlanMode: the plan to approve, with a mode change in some answers. */
async function permPlan(client, sessionId) {
  const state = stateOf(sessionId);
  const options = [
    { optionId: 'exit-plan-accept-edits', name: 'Yes, and auto-accept edits', kind: 'allow_always' },
    { optionId: 'exit-plan-default', name: 'Yes, manually approve edits', kind: 'allow_once' },
    { optionId: 'reject', name: 'No, keep planning', kind: 'reject_once' },
  ];
  const toolCallId = 'perm-plan-1';
  await tool(client, sessionId, { sessionUpdate: 'tool_call', toolCallId, title: 'Ready to code?', kind: 'switch_mode', status: 'pending', rawInput: { plan: PLAN_TEXT } });
  const answer = await client.request(acp.methods.client.session.requestPermission, {
    sessionId,
    toolCall: { toolCallId, title: 'Ready to code?', kind: 'switch_mode', rawInput: { plan: PLAN_TEXT } },
    options,
  });
  const optionId = answer.outcome.outcome === 'selected' ? answer.outcome.optionId : 'reject';
  await tool(client, sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: optionId === 'reject' ? 'failed' : 'completed' });
  if (optionId === 'reject') return say(client, sessionId, 'Staying in Plan mode.');
  state.mode = optionId === 'exit-plan-accept-edits' ? 'acceptEdits' : 'default';
  await announceMode(client, sessionId, state);
  await say(client, sessionId, `Plan approved. Mode: ${MODES.find((m) => m.id === state.mode).name}.`);
}

async function planMode(client, sessionId) {
  const state = stateOf(sessionId);
  if (state.mode !== 'plan') {
    state.mode = 'plan';
    await announceMode(client, sessionId, state);
  }
  await tool(client, sessionId, {
    sessionUpdate: 'plan',
    entries: ['Read README.md', 'Add a Usage section', 'Run the tests'].map((content) => ({ content, priority: 'medium', status: 'pending' })),
  });
  await say(client, sessionId, "Here's my plan. Approve it to leave Plan mode.\n\n");
  await permPlan(client, sessionId);
}

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
  // Like Gemini in its Default mode: asks first (title only, the diff is on the tool call), then writes through the client.
  const ok = await allowed(client, sessionId, 'edit', { toolCallId: 'edit-1', title: `Edit ${path}`, kind: 'edit' }, [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ]);
  if (ok) {
    await client.request(acp.methods.client.fs.writeTextFile, { sessionId, path, content: 'edited by fake agent\n' });
  }
  await tool(client, sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: ok ? 'completed' : 'failed' });
  await say(client, sessionId, ok ? 'Edited.' : 'Skipped the edit.');
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
 * A minimal MCP client, enough to call one tool: initialize, the initialized
 * notification, tools/call. Hand-written so this agent needs no MCP package.
 */
function mcpClient(server) {
  return server.type === 'http' ? httpMcpClient(server) : stdioMcpClient(server);
}

/* global fetch, AbortController */
/** Over streamable HTTP: one POST per message; a reply comes back as JSON or as an event stream. */
function httpMcpClient(server) {
  const headers = Object.fromEntries((server.headers ?? []).map((h) => [h.name, h.value]));
  const inFlight = new Set();
  let nextId = 1;
  const post = async (message) => {
    const abort = new AbortController();
    inFlight.add(abort);
    try {
      const res = await fetch(server.url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', ...message }),
        signal: abort.signal,
      });
      if (res.status === 202) return undefined;
      if (!res.ok) throw new Error(`The FriedLiver tools answered HTTP ${res.status}.`);
      if (!(res.headers.get('content-type') ?? '').startsWith('text/event-stream')) return await res.json();
      // Events until the one that answers this request; progress notes are skipped.
      const text = await res.text();
      for (const block of text.split('\n\n')) {
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (!data) continue;
        const msg = JSON.parse(data);
        if (msg.id === message.id) return msg;
      }
      throw new Error('The FriedLiver tools sent no answer.');
    } finally {
      inFlight.delete(abort);
    }
  };
  return {
    request: async (method, params) => {
      const msg = await post({ id: nextId++, method, params });
      if (msg?.error) throw new Error(msg.error.message);
      return msg?.result;
    },
    notify: (method, params) => void post({ method, params }).catch(() => {}),
    close: () => {
      for (const abort of inFlight) abort.abort();
    },
  };
}

/** Over stdio: starts the server and speaks one JSON-RPC message per line. */
function stdioMcpClient(server) {
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
  const server = (sessionMcp.get(sessionId) ?? []).find((s) => s.name === 'friedliver' && (typeof s.command === 'string' || s.type === 'http'));
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
  .onRequest(acp.methods.agent.initialize, ({ params }) => {
    booleanOptions = params.clientCapabilities?.session?.configOptions?.boolean != null;
    forms = params.clientCapabilities?.elicitation?.form != null;
    return {
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession,
      promptCapabilities: { image: images },
      mcpCapabilities: { http: httpMcp },
      // Like Claude's and Codex's adapters: it signs out itself, and says which account it runs as.
      ...(needsAuth ? { auth: { logout: {} }, _meta: { authStatus: {} } } : {}),
    },
    authMethods: needsTerminalLogin
      ? [{ id: 'demo-login', name: 'Log in with Demo', description: 'Run the demo login in the terminal', type: 'terminal', args: ['--cli'] }]
      : needsAuth
        ? [{ id: 'fake-login', name: 'Fake login' }]
        : [],
    agentInfo: { name: 'fake-agent', version: '0.0.0' },
    // Like Claude's adapter: a message can join a running turn through _session/steering.
    _meta: { steering: { supported: true } },
    };
  })
  .onRequest(acp.methods.agent.authenticate, async ({ params, client }) => {
    if (params.methodId !== 'fake-login') throw acp.RequestError.invalidParams();
    process.stderr.write('Open https://accounts.google.com/o/oauth2/v2/auth?client_id=demo to sign in\n');
    await new Promise((r) => setTimeout(r, 300));
    authenticated = true;
    void client.notify('_auth/status_update', { authStatus: { kind: 'account', label: 'Demo account', account: { email: 'you@example.com', plan: 'demo' } } }).catch(() => {});
    return {};
  })
  .onRequest(acp.methods.agent.logout, ({ client }) => {
    authenticated = false;
    void client.notify('_auth/status_update', { authStatus: { kind: 'none', label: 'Not logged in' } }).catch(() => {});
    return {};
  })
  .onRequest(acp.methods.agent.session.new, ({ params, client }) => {
    if (needsAuth && !authenticated) throw acp.RequestError.authRequired();
    if (needsTerminalLogin && !existsSync(LOGIN_MARKER)) throw acp.RequestError.authRequired();
    const sessionId = `fake-session-${nextSession++}`;
    sessionCwd.set(sessionId, params.cwd);
    sessionMcp.set(sessionId, params.mcpServers ?? []);
    systemAppend.set(sessionId, params._meta?.systemPrompt?.append);
    sessionMeta.set(sessionId, params._meta);
    if (startMcp) for (const server of params.mcpServers ?? []) if (typeof server.command === 'string' || server.type === 'http') keepMcp(server);
    const state = { ...DEFAULTS, used: 0 };
    choices.set(sessionId, state);
    announceSession(client, sessionId);
    return { sessionId, ...sessionSetup(state) };
  })
  .onRequest(acp.methods.agent.session.load, ({ params, client }) => {
    if (!loadSession) throw acp.RequestError.methodNotFound('session/load');
    sessionCwd.set(params.sessionId, params.cwd);
    sessionMcp.set(params.sessionId, params.mcpServers ?? []);
    sessionMeta.set(params.sessionId, params._meta);
    const state = choices.get(params.sessionId) ?? { ...DEFAULTS, used: 0 };
    choices.set(params.sessionId, state);
    announceSession(client, params.sessionId);
    return sessionSetup(state);
  })
  .onRequest(acp.methods.agent.session.setMode, async ({ params, client }) => {
    const state = stateOf(params.sessionId);
    setMode(state, params.modeId);
    choices.set(params.sessionId, state);
    if (!legacy) await tool(client, params.sessionId, { sessionUpdate: 'config_option_update', configOptions: configOptions(state) });
    return {};
  })
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    if (legacy) throw acp.RequestError.methodNotFound('session/set_config_option');
    const state = stateOf(params.sessionId);
    const value = params.value;
    if (params.configId === 'mode') setMode(state, String(value));
    else if (params.configId === 'model') setModel(state, String(value));
    else if (params.configId === 'effort') {
      const model = MODELS.find((m) => m.id === state.model) ?? MODELS[0];
      if (!model.efforts.includes(String(value))) throw acp.RequestError.invalidParams(undefined, `${model.name} has no effort ${value}`);
      state.effort = String(value);
    } else if (params.configId === 'fast') {
      if (typeof value === 'boolean') state.fast = value;
      else if (value === 'on' || value === 'off') state.fast = value === 'on';
      else throw acp.RequestError.invalidParams(undefined, `Fast mode is on or off, not ${value}`);
    } else throw acp.RequestError.invalidParams(undefined, `Unknown option ${params.configId}`);
    choices.set(params.sessionId, state);
    return { configOptions: configOptions(state) };
  })
  // Gemini's unstable session/set_model, which SDK 1.8's types don't have.
  .onRequest('session/set_model', (raw) => raw, ({ params }) => {
    const state = stateOf(params.sessionId);
    setModel(state, String(params.modelId));
    choices.set(params.sessionId, state);
    return {};
  })
  .onRequest('_session/steering', (raw) => raw, ({ params }) => {
    const resolve = steered.get(params.sessionId);
    if (!resolve) return { outcome: 'promptRequired', reason: 'noRunningTurn' };
    const text = (params.prompt ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    resolve(text);
    return { outcome: 'steered' };
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
      // Works until cancelled, or until a steered message arrives, which it answers.
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Waiting until you stop me.' } },
      });
      const steer = await new Promise((resolve) => {
        cancels.set(sessionId, () => resolve(null));
        steered.set(sessionId, resolve);
      });
      cancels.delete(sessionId);
      steered.delete(sessionId);
      if (steer === null) return { stopReason: 'cancelled' };
      await say(client, sessionId, `Steered: ${steer}`);
      return { stopReason: 'end_turn' };
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
    else if (command === 'heavy') await heavy(client, sessionId);
    else if (command.startsWith('edit ')) await edit(client, sessionId, command.slice(5));
    else if (command.startsWith('native-edit ')) await nativeEdit(client, sessionId, path.resolve(sessionCwd.get(sessionId) ?? process.cwd(), command.slice(12).trim()));
    else if (command.startsWith('perm-edit ')) await permEdit(client, sessionId, path.resolve(sessionCwd.get(sessionId) ?? process.cwd(), command.slice(10).trim()));
    else if (command === 'native-run') await nativeRun(client, sessionId);
    else if (command.startsWith('native-read ')) await nativeAsk(client, sessionId, 'read', path.resolve(sessionCwd.get(sessionId) ?? process.cwd(), command.slice(12).trim()));
    else if (command.startsWith('native-fetch ')) await nativeAsk(client, sessionId, 'fetch', command.slice(13).trim());
    else if (command.startsWith('native-perm ')) await nativePerm(client, sessionId, command.slice(12).trim());
    else if (command === 'perm-plan') await permPlan(client, sessionId);
    else if (command === 'plan') await planMode(client, sessionId);
    else if (command === 'question') {
      if (!forms) await say(client, sessionId, "This client can't show questions as forms, so I'd ask in a message.");
      else {
        const answer = await client.request(acp.methods.client.elicitation.create, {
          mode: 'form',
          sessionId,
          message: 'Which database should the store use?',
          requestedSchema: {
            type: 'object',
            properties: {
              db: { type: 'string', title: 'Database', oneOf: [{ const: 'sqlite', title: 'SQLite', description: 'A file next to the app' }, { const: 'postgres', title: 'Postgres' }] },
              note: { type: 'string', title: 'Other', description: 'Anything to add (optional)' },
            },
            required: ['db'],
          },
        });
        await say(client, sessionId, answer.action === 'accept' ? `You picked ${answer.content?.db}${answer.content?.note ? ` (${answer.content.note})` : ''}.` : `You ${answer.action === 'decline' ? 'skipped' : 'cancelled'} the question.`);
      }
    } else if (command === 'ask-user' || command.startsWith('ask-user ')) {
      if (!forms) await say(client, sessionId, "This client can't show questions as forms, so I'd ask in a message.");
      else {
        const n = Math.max(1, Math.min(4, Number(command.slice(9)) || 1));
        const asks = [
          ['Store', 'Which store should the sessions use?', ['Redis (Recommended)', 'SQLite', 'Memory']],
          ['Cache', 'Which cache in front of it?', ['None', 'LRU']],
          ['Auth', 'Which auth method?', ['Cookies', 'Tokens']],
          ['Logs', 'Where do logs go?', ['stdout', 'File']],
        ].slice(0, n);
        const properties = {};
        asks.forEach(([header, question, options], k) => {
          properties[`question_${k}`] = { type: 'string', title: header, ...(n > 1 ? { description: question } : {}), oneOf: options.map((o) => ({ const: o, title: o, description: `${o.replace(/ \(Recommended\)$/, '')} because it fits` })) };
          properties[`question_${k}_custom`] = { type: 'string', title: 'Other', description: 'Type your own answer, or add a note to the option you chose above (optional).' };
        });
        const answer = await client.request(acp.methods.client.elicitation.create, {
          mode: 'form',
          sessionId,
          message: n > 1 ? 'Please answer the following questions.' : asks[0][1],
          requestedSchema: { type: 'object', properties },
        });
        const got = asks.map((_, k) => answer.content?.[`question_${k}_custom`] || answer.content?.[`question_${k}`] || '-');
        await say(client, sessionId, answer.action === 'accept' ? `You answered: ${got.join(', ')}.` : `You ${answer.action === 'decline' ? 'skipped' : 'cancelled'} the question.`);
      }
    } else if (command === 'session') {
      await say(client, sessionId, `Session ${sessionId}, meta ${JSON.stringify(sessionMeta.get(sessionId) ?? null)}`);
    } else if (command.startsWith('links')) {
      const links = params.prompt.filter((b) => b.type === 'resource_link').map((b) => b.name);
      await say(client, sessionId, links.length ? `Linked: ${links.join(', ')}` : 'No files linked.');
    }
    else if (command === '/help') await say(client, sessionId, HELP);
    else if (command === '/compact') {
      stateOf(sessionId).used = 0;
      await say(client, sessionId, 'Context cleared.');
    } else if (command.startsWith('/review')) await say(client, sessionId, `Reviewed ${command.slice(7).trim() || 'nothing'}: looks fine.`);
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
    } else if (command === 'system') {
      await say(client, sessionId, systemAppend.get(sessionId) ?? 'no system prompt');
    } else {
      const state = stateOf(sessionId);
      // The model and effort show when they aren't the defaults, so tests can see a choice arrive.
      const chosen = state.model !== DEFAULTS.model || state.effort !== DEFAULTS.effort || state.fast ? ` (${[state.model, state.effort, ...(state.fast ? ['fast'] : [])].join(' · ')})` : '';
      await say(client, sessionId, 'You said: ');
      await say(client, sessionId, `${text}${imageCount ? ` (+${imageCount} image)` : ''}${chosen}`);
    }
    if (choices.has(sessionId)) await reportUsage(client, sessionId, stateOf(sessionId), text);
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
