// FriedLiver's ACP adapter for Google's Antigravity CLI (`agy`), which has no ACP mode of its own.
// One agy process per turn in its documented headless stream-json mode (agy.ts); the session's
// later turns continue agy's conversation with --conversation. FriedLiver starts this file
// (dist/agy-acp.js) with the editor's own Node; FRIEDLIVER_AGY is the agy binary core.ts found.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
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
  isAgyMode,
  needsSignIn,
  parseEvent,
  parseModels,
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
}

interface Session {
  cwd: string;
  mode: AgyMode;
  model: string;
  effort: string;
  models: AgyChoice[];
  /** Read only: agy's workspace, an empty folder of this session's own, so its file tools can't reach the project. */
  scratch?: string;
  /** agy's conversation per workspace (the project, the scratch folder): a conversation may belong to its folder. */
  conversations: Map<string, string>;
  running?: { child: ChildProcess; cancelled: boolean };
}

const CALL_TIMEOUT_MS = 30_000;
const MAX_STDERR = 40;

/** Read-only sessions' empty folders, removed when the adapter exits. */
const scratchDirs = new Set<string>();
process.once('exit', () => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

export function agyAgent(opts: AgyAdapterOptions): acp.AgentApp {
  const sessions = new Map<string, Session>();
  const env = { ...(opts.env ?? process.env) };
  // Not for agy: what started this adapter as Node.
  delete env.ELECTRON_RUN_AS_NODE;
  const run = (args: string[], cwd: string) =>
    spawn(opts.command, [...(opts.baseArgs ?? []), ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });

  /** A short agy call (`models`, `--version`) with nothing on stdin. */
  async function call(args: string[], cwd: string): Promise<{ code: number | null; out: string; err: string }> {
    const child = run(args, cwd);
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

  async function turn(s: Session, sessionId: string, text: string, notify: (u: acp.SessionUpdate) => Promise<void>): Promise<acp.StopReason> {
    if (s.mode === 'read-only' && !s.scratch) scratchDirs.add((s.scratch = await mkdtemp(path.join(os.tmpdir(), 'friedliver-agy-'))));
    const where = s.mode === 'read-only' && s.scratch ? s.scratch : s.cwd;
    const seen = (id: unknown) => typeof id === 'string' && id && s.conversations.set(where, id);
    try {
      const child = run(turnArgs({ mode: s.mode, model: s.model, effort: s.effort, conversationId: s.conversations.get(where) }, opts.extraArgs), where);
      // agy may exit before it reads stdin (a refused flag): that is its answer, not the adapter's crash.
      child.stdin?.on('error', () => {});
      const running = { child, cancelled: false };
      s.running = running;
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
      let said = false;
      const tools = new Set<string>();
      const lines = createInterface({ input: child.stdout! });
      for await (const line of lines) {
        const e = parseEvent(line);
        if (!e) continue;
        if (e.event === 'init') {
          // The prompt only after agy started its turn: before that it may be asking for a sign-in code.
          child.stdin?.write(userLine(text));
          seen((e as { conversation_id?: unknown }).conversation_id);
        } else if (e.event === 'step_update') {
          const st = stepOf(e);
          seen(st.conversation_id);
          if (st.text_delta && st.step_type !== 'user_input' && st.step_type !== 'tool') {
            said = true;
            await notify({ sessionUpdate: st.step_type === 'thinking' ? 'agent_thought_chunk' : 'agent_message_chunk', content: { type: 'text', text: st.text_delta } });
          }
          if (st.step_type === 'tool') {
            const name = st.tool_info?.name ?? st.tool_name ?? 'tool';
            const toolCallId = `agy-${s.conversations.get(where) ?? sessionId}-${st.step_index ?? tools.size}`;
            if (!tools.has(toolCallId)) {
              tools.add(toolCallId);
              const locations = toolPaths(st.tool_info?.parameters, s.cwd).map((p) => ({ path: p }));
              await notify({ sessionUpdate: 'tool_call', toolCallId, title: name, kind: toolKind(name), status: 'in_progress', rawInput: st.tool_info?.parameters, ...(locations.length ? { locations } : {}) });
            }
            if (st.state === 'DONE') {
              const failed = st.tool_info?.error != null;
              const out = textOf(failed ? st.tool_info?.error : st.tool_info?.output);
              await notify({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status: failed ? 'failed' : 'completed',
                ...(out ? { content: [{ type: 'content', content: { type: 'text', text: out } }] } : {}),
              });
            }
          }
        } else if (e.event === 'result') {
          result = (e as { result?: typeof result }).result ?? (e as typeof result);
          seen(result?.conversation_id);
          child.stdin?.end();
        }
      }
      await exited.catch(() => null);
      if (running.cancelled) return 'cancelled';
      const why = result?.error ?? stderr.join('\n');
      if (signIn || needsSignIn(why)) throw acp.RequestError.authRequired(undefined, 'Antigravity needs a sign-in: run `agy` in a terminal.');
      const stop = stopReasonOf(result?.status);
      if (stop === 'error') throw new acp.RequestError(-32603, 'Internal error', { details: why.trim().slice(0, 4000) || 'agy stopped without an answer.' });
      if (!said && result?.response) await notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: result.response } });
      return stop;
    } finally {
      s.running = undefined;
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
      const models = await listModels(params.cwd);
      const settings = opts.settingsFile ? await readFile(opts.settingsFile, 'utf8').catch(() => undefined) : undefined;
      const sessionId = randomUUID();
      // Read only until FriedLiver sets the chat's level: the safe start.
      const s: Session = { cwd: params.cwd, mode: 'read-only', model: settingsModel(settings, models) ?? AGY_DEFAULT, effort: AGY_DEFAULT, models, conversations: new Map() };
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
      return { stopReason: await turn(s, params.sessionId, text, notify) };
    });
}
