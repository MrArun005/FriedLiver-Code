// FriedLiver's ACP adapter for Google's Antigravity CLI (`agy`), which has no ACP mode of its own.
// One agy process per turn in its documented headless stream-json mode (agy.ts); the session's
// later turns continue agy's conversation with --conversation. FriedLiver starts this file
// (dist/agy-acp.js) with the editor's own Node; FRIEDLIVER_AGY is the agy binary core.ts found.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, realpathSync, rmSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import {
  AGY_DEFAULT,
  AGY_EFFORTS,
  AGY_MODES,
  TALK_LIMITS,
  isAgyMode,
  isTalkMode,
  needCall,
  workspaceConfig,
  geminiFingerprint,
  needsSignIn,
  parseEvent,
  parseModels,
  parseNeeds,
  seatbeltProfile,
  talkPreamble,
  talkProfile,
  settingsModel,
  stepOf,
  stopReasonOf,
  textOf,
  toolKind,
  toolPaths,
  turnArgs,
  userLine,
  type AgyChoice,
  type AgyMode,
} from './agy';
import { killProcessTree } from './processes';

export interface AgyAdapterOptions {
  /** The agy program, and arguments before every call (a test runs a script with Node). */
  command: string;
  baseArgs?: string[];
  /** friedliver.agents.antigravity.args: extras for each turn, without the flags FriedLiver owns. */
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  /** agy's settings file, read only for its default model. */
  settingsFile?: string;
  /** Tests: another platform, home folder, or sandbox-exec; more the talk-only sandbox may read or write (Node's install, the fake agy's log). */
  platform?: NodeJS.Platform;
  home?: string;
  sandboxExec?: string;
  talkRead?: string[];
  talkWrite?: string[];
}

/** The FriedLiver tools server FriedLiver gives a session (stdio), from session/new. */
interface StdioServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Why Antigravity doesn't run off macOS. */
export const PLATFORM_REFUSAL =
  'Antigravity runs only on macOS in FriedLiver for now. agy has no way to turn off a repository’s own agy config (hooks, MCP servers, settings), so FriedLiver hides that config with macOS’s sandbox, and has no equal for this system yet.';

interface Session {
  cwd: string;
  /** The repository root git reported when the session started; the folder itself outside one. */
  root: string;
  mode: AgyMode;
  model: string;
  effort: string;
  models: AgyChoice[];
  /** agy's conversation per folder it ran in (the project, the talk-only folder): a conversation may belong to its folder. */
  conversations: Map<string, string>;
  /** Talk only: the session's own empty folder. */
  scratch?: string;
  /** FriedLiver's tools server for this session, which answers the index reads; started on first use. */
  bridge?: StdioServer;
  mcp?: ReturnType<typeof startMcp>;
  /** Why the session is over (config appeared in the workspace during a turn): every later prompt is refused with it. */
  ended?: string;
  running?: { child: ChildProcess; cancelled: boolean };
}

const CALL_TIMEOUT_MS = 30_000;
const MAX_STDERR = 40;
const internal = (details: string) => new acp.RequestError(-32603, 'Internal error', { details });

/** Talk-only folders and tools servers, removed and stopped when the adapter exits. */
const scratchDirs = new Set<string>();
const mcpChildren = new Set<ChildProcess>();
process.once('exit', () => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  for (const child of mcpChildren) child.kill();
});

/** Removes anything in a talk-only folder named like a config folder (a dot or underscore name). */
function emptyOfConfig(dir: string): void {
  for (const name of readdirSync(dir)) if (/^[._]/.test(name)) rmSync(path.join(dir, name), { recursive: true, force: true });
}

/** A minimal MCP client over stdio (one JSON-RPC message per line): initialize once, then tools/call. */
function startMcp(server: StdioServer) {
  const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  mcpChildren.add(child);
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  const failAll = (err: Error) => {
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
  };
  child.once('error', (err) => failAll(err));
  child.once('exit', () => (mcpChildren.delete(child), failAll(new Error('The FriedLiver tools stopped.'))));
  child.stdin?.on('error', () => {});
  createInterface({ input: child.stdout! }).on('line', (line) => {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    const w = msg.id !== undefined ? waiting.get(msg.id) : undefined;
    if (!w) return;
    waiting.delete(msg.id!);
    if (msg.error) w.reject(new Error(msg.error.message ?? 'The FriedLiver tools refused.'));
    else w.resolve(msg.result);
  });
  const send = (m: object) => child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  const request = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => (waiting.delete(id), reject(new Error(`${method} took too long.`))), CALL_TIMEOUT_MS);
      waiting.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      send({ id, method, params });
    });
  const ready = request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'friedliver-agy', version: '0' } }).then(() => send({ method: 'notifications/initialized' }));
  ready.catch(() => {});
  return { call: async (name: string, args: Record<string, unknown>) => (await ready, request('tools/call', { name, arguments: args })) };
}

/** The repository root, asked of git once; undefined outside a repository (or without git). */
function repoRoot(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 5000, windowsHide: true }, (err, out) => resolve(err ? undefined : out.trim() || undefined));
  });
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

export function agyAgent(opts: AgyAdapterOptions): acp.AgentApp {
  const sessions = new Map<string, Session>();
  const platform = opts.platform ?? process.platform;
  const home = real(opts.home ?? os.homedir());
  const env = { ...(opts.env ?? process.env) };
  // Not for agy: what started this adapter as Node.
  delete env.ELECTRON_RUN_AS_NODE;
  // Every agy process (and all it starts) in a sandbox: this one, which hides workspace config, in
  // the project; talkProfile's deny-by-default one in talk only. None off macOS (PLATFORM_REFUSAL).
  const editProfile = platform === 'darwin' ? seatbeltProfile(home) : undefined;
  const spawnAgy = (args: string[], cwd: string, profile: string | undefined) => {
    const argv = [...(opts.baseArgs ?? []), ...args];
    const [file, fileArgs] = profile ? [opts.sandboxExec ?? '/usr/bin/sandbox-exec', ['-p', profile, opts.command, ...argv]] : [opts.command, argv];
    return spawn(file, fileArgs, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: platform !== 'win32', windowsHide: true });
  };

  /** A short agy call (`models`, `--version`) with nothing on stdin. */
  async function call(args: string[], cwd: string): Promise<{ code: number | null; out: string; err: string }> {
    const child = spawnAgy(args, cwd, editProfile);
    child.stdin?.end();
    let out = '';
    let err = '';
    child.stdout?.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (err += d));
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (child.pid) killProcessTree(child.pid);
        reject(new Error(`\`agy ${args.join(' ')}\` did not answer in 30 s.`));
      }, CALL_TIMEOUT_MS);
      child.once('error', (e) => (clearTimeout(timer), reject(e)));
      child.once('exit', (c) => (clearTimeout(timer), resolve(c)));
    });
    return { code, out, err };
  }

  async function agyVersion(): Promise<string> {
    const r = await call(['--version'], os.tmpdir()).catch(() => undefined);
    return /^\d+(\.\d+)+\S*$/.exec(r?.out.trim() ?? '')?.[0] ?? 'unknown';
  }

  /** `agy models`: the list, and the sign-in check (it needs one). */
  async function listModels(cwd: string): Promise<AgyChoice[]> {
    const { code, out, err } = await call(['models'], cwd);
    if (needsSignIn(`${out}\n${err}`)) throw acp.RequestError.authRequired(undefined, 'Antigravity needs a sign-in: run `agy` in a terminal.');
    if (code !== 0) throw new acp.RequestError(-32603, 'Internal error', { details: (err || out).trim().slice(0, 2000) || `agy models exited with ${code}` });
    return parseModels(out).choices;
  }

  function configOptions(s: Session): acp.SessionConfigOption[] {
    const models = [{ value: AGY_DEFAULT, name: 'Default', description: 'agy’s own choice' }, ...s.models];
    return [
      { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: s.mode, options: AGY_MODES },
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: s.model, options: models },
      { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: s.effort, options: AGY_EFFORTS },
    ] as acp.SessionConfigOption[];
  }

  function sessionOf(id: string): Session {
    const s = sessions.get(id);
    if (!s) throw acp.RequestError.invalidParams(undefined, `Unknown session ${id}`);
    return s;
  }

  /**
   * One agy process: the prompt on stdin after its `init`, its steps as tool calls, its text
   * streamed as the reply or kept (talk only, where FriedLiver reads what it asks for first).
   */
  async function runAgy(
    s: Session,
    sessionId: string,
    run: { cwd: string; profile: string; text: string; stream: boolean; mode: AgyMode },
    notify: (u: acp.SessionUpdate) => Promise<void>,
  ): Promise<{ stop: acp.StopReason; reply: string }> {
    const conversationId = s.conversations.get(run.cwd);
    const seen = (id: unknown) => {
      if (typeof id === 'string' && id) s.conversations.set(run.cwd, id);
    };
    const child = spawnAgy(turnArgs({ mode: run.mode, model: s.model, effort: s.effort, conversationId }, opts.extraArgs), run.cwd, run.profile);
    // agy may exit before it reads stdin (a refused flag): that is its answer, not the adapter's crash.
    child.stdin?.on('error', () => {});
    const running = { child, cancelled: false };
    s.running = running;
    try {
      const stderr: string[] = [];
      let signIn = false;
      child.stderr?.setEncoding('utf8').on('data', (d: string) => {
        for (const line of d.split(/\r?\n/)) {
          if (!line) continue;
          stderr.push(line);
          if (stderr.length > MAX_STDERR) stderr.shift();
          // Unsigned, agy waits on stdin for a code: never let it read anything there.
          if (needsSignIn(line) && !signIn) {
            signIn = true;
            if (child.pid) killProcessTree(child.pid);
          }
        }
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      exited.catch(() => {});
      let result: { conversation_id?: string; status?: string; response?: string; error?: string } | undefined;
      let reply = '';
      const tools = new Set<string>();
      for await (const line of createInterface({ input: child.stdout! })) {
        const e = parseEvent(line);
        if (!e) continue;
        if (e.event === 'init') {
          // The prompt only after agy started its turn: before that it may be asking for a sign-in code.
          child.stdin?.write(userLine(run.text));
          seen((e as { conversation_id?: unknown }).conversation_id);
        } else if (e.event === 'step_update') {
          const st = stepOf(e);
          seen(st.conversation_id);
          if (st.text_delta && st.step_type !== 'user_input' && st.step_type !== 'tool') {
            if (st.step_type === 'thinking') await notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: st.text_delta } });
            else {
              reply += st.text_delta;
              if (run.stream) await notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: st.text_delta } });
            }
          }
          if (st.step_type === 'tool') {
            const name = st.tool_info?.name ?? st.tool_name ?? 'tool';
            const toolCallId = `agy-${s.conversations.get(run.cwd) ?? sessionId}-${st.step_index ?? tools.size}`;
            if (!tools.has(toolCallId)) {
              tools.add(toolCallId);
              const locations = toolPaths(st.tool_info?.parameters, run.cwd).map((p) => ({ path: p }));
              await notify({ sessionUpdate: 'tool_call', toolCallId, title: name, kind: toolKind(name), status: 'in_progress', rawInput: st.tool_info?.parameters, ...(locations.length ? { locations } : {}) });
            }
            if (st.state === 'DONE') {
              const failed = st.tool_info?.error != null;
              const out = textOf(failed ? st.tool_info?.error : st.tool_info?.output);
              await notify({ sessionUpdate: 'tool_call_update', toolCallId, status: failed ? 'failed' : 'completed', ...(out ? { content: [{ type: 'content', content: { type: 'text', text: out } }] } : {}) });
            }
          }
        } else if (e.event === 'result') {
          result = (e as { result?: typeof result }).result ?? (e as typeof result);
          seen(result?.conversation_id);
          child.stdin?.end();
        }
      }
      await exited.catch(() => null);
      if (running.cancelled) return { stop: 'cancelled', reply };
      const why = result?.error ?? stderr.join('\n');
      if (signIn || needsSignIn(why)) throw acp.RequestError.authRequired(undefined, 'Antigravity needs a sign-in: run `agy` in a terminal.');
      const stop = stopReasonOf(result?.status);
      if (stop === 'error') throw internal(why.trim().slice(0, 4000) || 'agy stopped without an answer.');
      if (!reply && result?.response) {
        reply = result.response;
        if (run.stream) await notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } });
      }
      return { stop, reply };
    } finally {
      s.running = undefined;
    }
  }

  /** Edit automatically and Auto: agy in the project, under the profile that hides workspace config. */
  async function editTurn(s: Session, sessionId: string, text: string, notify: (u: acp.SessionUpdate) => Promise<void>): Promise<acp.StopReason> {
    const named = (files: string[]) => files.map((f) => path.relative(s.cwd, f) || f).join(', ');
    // Defence in depth (the sandbox hides it from agy anyway): checked before every turn.
    const config = workspaceConfig(s.cwd, s.root);
    if (config.length) {
      throw internal(
        `Antigravity won’t run in this folder: it has agy config (${named(config)}), and only text rules and workflows are allowed there, since agy has no way to ignore the rest (MCP servers, hooks, plugins, skills, settings). Remove it, or use another agent here.`,
      );
    }
    const { stop } = await runAgy(s, sessionId, { cwd: s.cwd, profile: editProfile!, text, stream: true, mode: s.mode }, notify);
    // The sandbox stops agy writing config; something else may have (another agent, a script).
    const left = workspaceConfig(s.cwd, s.root);
    if (left.length) {
      s.ended = `agy config appeared in this folder during the turn (${named(left)}), so this session has ended. Check and remove those files, then start a new chat.`;
      throw internal(s.ended);
    }
    return stop;
  }

  /** One of FriedLiver's read-only index tools, through the session's FriedLiver tools server. */
  async function bridgeCall(s: Session, name: string, args: Record<string, unknown>): Promise<string> {
    if (!s.bridge) throw new Error('This chat has no project index (FriedLiver tools are off here).');
    s.mcp ??= startMcp(s.bridge);
    const result = (await s.mcp.call(name, args)) as { content?: { type?: string; text?: string }[]; isError?: boolean };
    const text = (result?.content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');
    if (result?.isError) throw new Error(text || `${name} failed`);
    return text;
  }

  /**
   * Talk only (Manual, Plan, /discuss, read-only chats): agy in the session's empty folder under
   * the deny-by-default profile, so it can read no project file, write nowhere but there, and
   * start nothing. FriedLiver gives it excerpts, then reads what it asks for (parseNeeds), within
   * TALK_LIMITS, and passes its last answer on.
   */
  async function talkTurn(s: Session, sessionId: string, text: string, notify: (u: acp.SessionUpdate) => Promise<void>, mode: 'read-only' | 'plan'): Promise<acp.StopReason> {
    if (!s.scratch) {
      s.scratch = real(await mkdtemp(path.join(os.tmpdir(), 'friedliver-agy-talk-')));
      scratchDirs.add(s.scratch);
    }
    const profile = talkProfile({ agy: real(opts.command), scratch: s.scratch, home, read: opts.talkRead?.map(real), write: opts.talkWrite?.map(real) });
    let budget = TALK_LIMITS.turnChars;
    const take = (out: string, cap: number) => {
      const t = out.length > cap ? `${out.slice(0, cap)}\n[cut: FriedLiver's read budget]` : out;
      budget -= t.length;
      return t;
    };
    let excerpts = '';
    if (s.bridge) excerpts = take(await bridgeCall(s, 'index_search', { query: text.slice(0, TALK_LIMITS.query), limit: 5, budget: 1500 }).catch(() => ''), TALK_LIMITS.startChars);
    let prompt = [talkPreamble(mode === 'plan'), ...(excerpts ? ['## Project excerpts (from FriedLiver’s index)', excerpts] : []), '## Message', text].join('\n\n');
    for (let round = 0; ; round++) {
      // The sandbox keeps agy from making a config folder in its own folder; anything there that could be one goes.
      emptyOfConfig(s.scratch);
      const { stop, reply } = await runAgy(s, sessionId, { cwd: s.scratch, profile, text: prompt, stream: false, mode }, notify);
      if (stop === 'cancelled') return stop;
      const { text: said, needs, refused } = parseNeeds(reply);
      if ((!needs.length && !refused.length) || round >= TALK_LIMITS.rounds) {
        const capped = needs.length ? '\n\n(FriedLiver’s reads for this turn are used up.)' : '';
        await notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: said + capped } });
        return stop;
      }
      if (said) await notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: said } });
      const answers: string[] = refused.map((why) => `Refused: ${why}.`);
      for (const [i, need] of needs.entries()) {
        const { name, args, title } = needCall(need);
        const toolCallId = `friedliver-read-${sessionId}-${round}-${i}`;
        await notify({ sessionUpdate: 'tool_call', toolCallId, title, kind: need.kind === 'search' ? 'search' : 'read', status: 'in_progress', rawInput: args });
        let out: string;
        let failed = false;
        if (budget <= 0) [out, failed] = ['Refused: FriedLiver’s read budget for this turn is used up.', true];
        else {
          try {
            out = take(await bridgeCall(s, name, args), Math.min(TALK_LIMITS.answerChars, budget));
          } catch (err) {
            [out, failed] = [`Couldn’t: ${(err as Error).message}`, true];
          }
        }
        await notify({ sessionUpdate: 'tool_call_update', toolCallId, status: failed ? 'failed' : 'completed', content: [{ type: 'content', content: { type: 'text', text: out } }] });
        answers.push(`### ${title}\n${out}`);
      }
      const left = TALK_LIMITS.rounds - round - 1;
      prompt = ["## FriedLiver's answers", ...answers, left ? `Answer now, or ask again (${left} more time${left === 1 ? '' : 's'}).` : 'Answer now: no more reads this turn.'].join('\n\n');
    }
  }

  /**
   * One turn. `readOnly` (FriedLiver's per-prompt `_meta`: a discussion, a read-only chat) makes it
   * talk only whatever the mode says. The user's own agy config is fingerprinted around every turn.
   */
  async function turn(s: Session, sessionId: string, text: string, notify: (u: acp.SessionUpdate) => Promise<void>, readOnly: boolean): Promise<acp.StopReason> {
    if (s.ended) throw internal(s.ended);
    const talk = readOnly ? (s.mode === 'plan' ? 'plan' : 'read-only') : isTalkMode(s.mode) ? s.mode : undefined;
    const before = geminiFingerprint(home);
    try {
      return talk ? await talkTurn(s, sessionId, text, notify, talk) : await editTurn(s, sessionId, text, notify);
    } finally {
      if (!s.ended && geminiFingerprint(home) !== before) {
        s.ended = 'Your agy config in ~/.gemini changed during the turn, so this session has ended. Check it, then start a new chat.';
        // eslint-disable-next-line no-unsafe-finally -- the change outranks the turn's own result
        throw internal(s.ended);
      }
    }
  }

  return acp
    .agent({ name: 'friedliver-agy' })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      // No images, no embedded files, no MCP servers: agy takes text on stdin and reads MCP only from its own config.
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, embeddedContext: false } },
      // Its sign-in is agy's own, in a terminal (Agents & Accounts runs `agy`).
      authMethods: [],
      // agy's version, so Agents & Accounts shows what is installed.
      agentInfo: { name: 'agy', version: await agyVersion() },
    }))
    .onRequest(acp.methods.agent.session.new, async ({ params }) => {
      if (!editProfile) throw internal(PLATFORM_REFUSAL);
      const cwd = real(params.cwd);
      // Resolved once: a repository can't move its own root later.
      const top = await repoRoot(cwd);
      const root = top ? real(top) : cwd;
      // The home folder holds the user's own ~/.gemini, which the sandbox must leave readable.
      if (cwd === home || root === home) throw internal('Antigravity won’t run in your home folder or a repository at its root, where your own agy config lives. Open a project folder.');
      const models = await listModels(cwd);
      const settings = opts.settingsFile ? await readFile(opts.settingsFile, 'utf8').catch(() => undefined) : undefined;
      const sessionId = randomUUID();
      const server = params.mcpServers.find((m): m is acp.McpServerStdio => m.name === 'friedliver' && 'command' in m && typeof m.command === 'string');
      const bridge = server ? { command: server.command, args: server.args ?? [], env: Object.fromEntries((server.env ?? []).map((v) => [v.name, v.value])) } : undefined;
      // Talk only until FriedLiver sets the chat's level: the safe start.
      const s: Session = { cwd, root, mode: 'read-only', model: settingsModel(settings, models) ?? AGY_DEFAULT, effort: AGY_DEFAULT, models, conversations: new Map(), bridge };
      sessions.set(sessionId, s);
      return { sessionId, configOptions: configOptions(s) };
    })
    .onRequest(acp.methods.agent.session.setMode, ({ params }) => {
      const s = sessionOf(params.sessionId);
      if (!isAgyMode(params.modeId)) throw acp.RequestError.invalidParams(undefined, `Unknown mode ${params.modeId}`);
      s.mode = params.modeId;
      return {};
    })
    .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
      const s = sessionOf(params.sessionId);
      const value = String(params.value);
      if (params.configId === 'mode') {
        if (!isAgyMode(value)) throw acp.RequestError.invalidParams(undefined, `Unknown mode ${value}`);
        s.mode = value;
      } else if (params.configId === 'model') {
        if (value !== AGY_DEFAULT && !s.models.some((m) => m.value === value)) throw acp.RequestError.invalidParams(undefined, `Unknown model ${value}`);
        s.model = value;
      } else if (params.configId === 'effort') {
        if (!AGY_EFFORTS.some((e) => e.value === value)) throw acp.RequestError.invalidParams(undefined, `Unknown effort ${value}`);
        s.effort = value;
      } else throw acp.RequestError.invalidParams(undefined, `Unknown option ${params.configId}`);
      return { configOptions: configOptions(s) };
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      const r = sessions.get(params.sessionId)?.running;
      if (!r) return;
      r.cancelled = true;
      if (r.child.pid) killProcessTree(r.child.pid);
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const s = sessionOf(params.sessionId);
      if (s.running) throw acp.RequestError.invalidRequest(undefined, 'A turn is already running in this session.');
      const text = params.prompt
        .map((b) => (b.type === 'text' ? b.text : b.type === 'resource_link' ? `@${b.uri.startsWith('file://') ? fileURLToPath(b.uri) : b.uri}` : ''))
        .filter(Boolean)
        .join('\n\n');
      const notify = (update: acp.SessionUpdate) => client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update });
      const readOnly = (params._meta as { friedliver?: { readOnly?: unknown } } | null | undefined)?.friedliver?.readOnly === true;
      return { stopReason: await turn(s, params.sessionId, text, notify, readOnly) };
    });
}
