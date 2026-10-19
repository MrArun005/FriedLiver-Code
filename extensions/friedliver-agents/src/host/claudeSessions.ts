// Claude Code sessions started outside FriedLiver (the `claude` CLI, the
// Claude Code extension), read from the transcripts Claude Code keeps at
// ~/.claude/projects/<folder with every non-alphanumeric char as '-'>/<session id>.jsonl,
// and their subagents at <session id>/subagents/agent-<agent id>.{jsonl,meta.json}.
// Read-only: FriedLiver never writes, moves or deletes these files.
//
// Transcripts grow to tens of MB, so each is read once and then only what was appended:
// a file's parse state is kept with the offset it got to.
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { OutsideImage, OutsideImages } from '../shared/gallery';
import type { ClaudeSession, ClaudeSubagent } from '../shared/messages';
import { humanTitle } from '../shared/stepImages';
import { claudeColumn, claudeSubagents } from '../shared/view';

const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const AGENT_META = /^agent-([0-9a-z]+)\.meta\.json$/i;
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
const HANDBACK = 'SubagentHandback';
const TITLE_MAX = 80;
const STEP_MAX = 80;
/** Bytes read at a time. */
const CHUNK = 1024 * 1024;
/** A longer line (a pasted image, a huge tool result) is skipped rather than held in memory. */
const MAX_LINE = 8 * 1024 * 1024;
/** Lines that start like this are API request logs: most of a transcript's bytes and nothing the Manager shows. */
const SKIP_PREFIX = Buffer.from('{"type":"api-request');

export function encodeCwd(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9]/g, '-');
}

const GREETING = /^(hi|hii+|hey|hello|yo|sup|thanks|thank you|ok|okay|test|ping)\b[\s!.?]*$/i;
const SHELL = /^(\$ |(npm|npx|pnpm|yarn|bun|git|cd|ls|brew|pip3?|curl|wget|sudo|node|python3?|docker|rm|mkdir|cat|claude|code|make|go|cargo|chmod|export)\s)/;
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
/** A prompt worth naming a session after: not a greeting, a slash command or a pasted shell command. */
const titleWorthy = (t: string) => !GREETING.test(t.trim()) && !t.trim().startsWith('/') && !SHELL.test(t.trim());
const WEEK_MS = 7 * 86_400_000;

const clipTo = (t: string, max: number) => {
  const one = t.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
const clipTitle = (t: string) => clipTo(t, TITLE_MAX);

export type Block = { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean; content?: unknown };
export type Line = {
  type?: string;
  cwd?: string;
  entrypoint?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  timestamp?: string;
  origin?: { kind?: string };
  aiTitle?: string;
  customTitle?: string;
  summary?: string;
  message?: { id?: string; content?: string | Block[] };
};

const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: Block) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('') : '';

const NOTICE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const tag = (body: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1]?.trim();

// ---- One session transcript ----

interface SessionState {
  /** The folder it started in, as its first record says. */
  cwd?: string;
  /** What ran it, per record: claude-vscode, cli, sdk-ts (FriedLiver's own chats), sdk-py, sdk-cli (`claude -p`)… */
  entrypoints: Set<string>;
  /** The entrypoint of its latest record that names one: who wrote to it last. */
  lastEntrypoint?: string;
  custom: string;
  auto: string;
  prompt: string;
  messages: number;
  anon: number;
  tools: boolean;
  short: boolean;
  assistantIds: Set<string>;
  subs: Map<string, { title: string; background: boolean; end?: 'done' | 'failed' }>;
  /** Background-task notices by task id (the agent id) and by tool-use id: the latest one's status and time. */
  notices: Map<string, { status: string; at: number }>;
}

const newSession = (): SessionState => ({
  entrypoints: new Set(),
  custom: '',
  auto: '',
  prompt: '',
  messages: 0,
  anon: 0,
  tools: false,
  short: true,
  assistantIds: new Set(),
  subs: new Map(),
  notices: new Map(),
});

function feedSession(s: SessionState, o: Line): void {
  if (s.cwd === undefined && typeof o.cwd === 'string') s.cwd = o.cwd;
  if (typeof o.entrypoint === 'string') {
    s.entrypoints.add(o.entrypoint);
    s.lastEntrypoint = o.entrypoint;
  }
  // The latest title wins: Claude Code appends a new one as the session goes on, and a name the user gave beats its own.
  if (o.type === 'custom-title' && typeof o.customTitle === 'string') s.custom = o.customTitle;
  else if (o.type === 'ai-title' && typeof o.aiTitle === 'string') s.auto = o.aiTitle;
  else if (o.type === 'summary' && typeof o.summary === 'string') s.auto = o.summary;
  if (o.isSidechain || o.isMeta || !o.message) return;
  const content = o.message.content;
  const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  if (o.type === 'user') {
    const text = textOf(content);
    if (text.includes('<task-notification>')) {
      const at = Date.parse(o.timestamp ?? '');
      for (const [, body] of text.matchAll(NOTICE)) {
        const status = tag(body, 'status');
        if (!status || Number.isNaN(at)) continue;
        for (const key of [tag(body, 'task-id'), tag(body, 'tool-use-id')]) if (key) s.notices.set(key, { status, at });
      }
    }
    // Claude Code's own notices about background tasks: not something the user said.
    if (o.origin?.kind === 'task-notification') return;
    const said = blocks.find((b) => b.type === 'text' && b.text && !b.text.startsWith('<'))?.text;
    for (const b of blocks) {
      const sub = b.type === 'tool_result' && b.tool_use_id ? s.subs.get(b.tool_use_id) : undefined;
      // A background agent's result only says it was launched.
      if (sub && !sub.background && !/^Async agent launched/.test(textOf(b.content))) sub.end = b.is_error ? 'failed' : 'done';
    }
    if (said) {
      s.messages++;
      if (!s.prompt && titleWorthy(said)) s.prompt = said;
      if (words(said) > 4 && !GREETING.test(said.trim())) s.short = false;
    }
  } else if (o.type === 'assistant') {
    // One message streams as several lines with the same id.
    s.assistantIds.add(o.message.id ?? `anon-${s.anon++}`);
    for (const b of blocks) {
      if (b.type === 'tool_use') s.tools = true;
      if (b.type === 'tool_use' && b.id && b.name && SUBAGENT_TOOLS.has(b.name)) {
        const d = b.input?.description;
        s.subs.set(b.id, { title: typeof d === 'string' ? clipTitle(d) : 'Subagent', background: b.input?.run_in_background === true });
      }
    }
  }
}

function summarize(s: SessionState) {
  return {
    // Empty when nothing names it; the lister falls back to the folder and date.
    title: clipTitle(s.custom || s.auto || s.prompt),
    // ponytail: word-count heuristic; "hi" + "which IDE is this" style chats with no tool use.
    trivial: !s.tools && s.messages <= 2 && s.short,
    // A headless run (a review hook on the Python SDK, `claude -p`): only SDK entrypoints, none of them FriedLiver's own
    // TypeScript one, whose chats a person types into. No entrypoint at all (older transcripts) counts as a person's.
    headless: s.entrypoints.size > 0 && [...s.entrypoints].every((e) => e.startsWith('sdk-') && e !== 'sdk-ts'),
    messages: s.messages + s.assistantIds.size,
  };
}

/** What the Manager shows of one transcript's text. Lines that aren't JSON (a cut-off line) are skipped. */
export function parseSession(text: string): Pick<ClaudeSession, 'title' | 'messages' | 'subagents'> & { trivial: boolean } {
  const s = newSession();
  for (const line of text.split('\n')) {
    const o = parseLine(line);
    if (o) feedSession(s, o);
  }
  return { ...summarize(s), subagents: [...s.subs].map(([id, a]) => ({ id, title: a.title, ...(a.end ? { end: a.end } : {}) })) };
}

function parseLine(line: string): Line | null {
  if (!line.trim()) return null;
  try {
    const o: unknown = JSON.parse(line);
    return o && typeof o === 'object' ? (o as Line) : null;
  } catch {
    return null;
  }
}

// ---- One subagent transcript ----

interface AgentState {
  startedAt?: number;
  lastAt?: number;
  tools: number;
  last?: string;
  idle: boolean;
  /** Its latest run ended with the hand-back; a new prompt (a resume) clears it. */
  handedBack: boolean;
}

const newAgent = (): AgentState => ({ tools: 0, idle: false, handedBack: false });

const STEP_KEYS = ['description', 'command', 'file_path', 'pattern', 'query', 'url', 'path', 'summary'];
function stepTitle(b: Block): string {
  const arg = STEP_KEYS.map((k) => b.input?.[k]).find((v): v is string => typeof v === 'string' && !!v.trim());
  return clipTo(arg ? `${b.name} · ${arg}` : (b.name ?? 'Tool'), STEP_MAX);
}

function feedAgent(a: AgentState, o: Line): void {
  const at = Date.parse(o.timestamp ?? '');
  if (!o.message || (o.type !== 'user' && o.type !== 'assistant')) return;
  if (!Number.isNaN(at)) {
    a.startedAt ??= at;
    a.lastAt = at;
  }
  const content = o.message.content;
  if (o.type === 'user') {
    a.idle = false;
    if (typeof content === 'string') a.handedBack = false;
    return;
  }
  const blocks = Array.isArray(content) ? content : [];
  const calls = blocks.filter((b) => b.type === 'tool_use');
  a.idle = calls.length === 0;
  for (const b of calls) {
    a.tools++;
    a.handedBack = b.name === HANDBACK;
    if (!a.handedBack) a.last = stepTitle(b);
  }
}

// ---- Reading only what was appended ----

export interface Tail<S> {
  ino: number;
  offset: number;
  /** The start of a line whose end hasn't been written yet. */
  rest: Buffer[];
  restLen: number;
  /** Inside a line longer than MAX_LINE, until its end. */
  skipping: boolean;
  state: S;
}

export type TailStore = Map<string, Tail<unknown>>;
const tails: TailStore = new Map();

/**
 * Feeds the lines appended to `file` since the last call into its state. A file that shrank or was replaced is read again
 * from the start, or from `start` (its first whole line after that byte) for a file too large to read whole.
 */
export async function advance<S>(
  file: string,
  st: { ino: number; size: number },
  init: () => S,
  feed: (s: S, o: Line) => void,
  store: TailStore = tails,
  start = 0,
): Promise<S> {
  let t = store.get(file) as Tail<S> | undefined;
  if (!t || t.ino !== st.ino || st.size < t.offset) {
    t = { ino: st.ino, offset: start, rest: [], restLen: 0, skipping: start > 0, state: init() };
    store.set(file, t as Tail<unknown>);
  }
  if (st.size === t.offset) return t.state;
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(CHUNK, st.size - t.offset));
    while (t.offset < st.size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, st.size - t.offset), t.offset);
      if (!bytesRead) break;
      t.offset += bytesRead;
      let from = 0;
      for (let nl = buf.indexOf(10, from); nl !== -1 && nl < bytesRead; nl = buf.indexOf(10, from)) {
        const piece = buf.subarray(from, nl);
        from = nl + 1;
        if (t.skipping) {
          t.skipping = false;
          continue;
        }
        const line = t.restLen ? Buffer.concat([...t.rest, piece]) : piece;
        t.rest = [];
        t.restLen = 0;
        if (line.subarray(0, SKIP_PREFIX.length).equals(SKIP_PREFIX)) continue;
        const o = parseLine(line.toString('utf8'));
        if (o) feed(t.state, o);
      }
      if (from < bytesRead && !t.skipping) {
        t.rest.push(Buffer.from(buf.subarray(from, bytesRead)));
        t.restLen += bytesRead - from;
        if (t.restLen > MAX_LINE) {
          t.rest = [];
          t.restLen = 0;
          t.skipping = true;
        }
      }
    }
  } finally {
    await fh.close();
  }
  return t.state;
}

const metas = new Map<string, { mtime: number; meta: AgentMeta }>();
export interface AgentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  model?: string;
}

async function readMeta(file: string, mtime: number): Promise<AgentMeta | null> {
  const hit = metas.get(file);
  if (hit?.mtime === mtime) return hit.meta;
  const meta = await readFile(file, 'utf8')
    .then((t) => JSON.parse(t) as unknown)
    .catch(() => null);
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as Record<string, unknown>;
  const str = (k: string) => (typeof m[k] === 'string' ? (m[k] as string) : undefined);
  const out = { agentType: str('agentType'), description: str('description'), toolUseId: str('toolUseId'), model: str('model') };
  metas.set(file, { mtime, meta: out });
  return out;
}

/** The session's subagents: its Agent/Task calls, joined with the agents in its subagents/ folder by tool-use id. */
async function sessionSubagents(dir: string, s: SessionState, touched: Set<string>): Promise<{ subs: ClaudeSubagent[]; lastActivity: number }> {
  const out = new Map<string, ClaudeSubagent>();
  for (const [id, a] of s.subs) out.set(id, { id, title: a.title, ...(a.end ? { end: a.end } : {}) });
  let lastActivity = 0;
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const m = AGENT_META.exec(name);
    if (!m) continue;
    const agentId = m[1];
    const metaFile = path.join(dir, name);
    const logFile = path.join(dir, `agent-${agentId}.jsonl`);
    const [mst, lst] = await Promise.all([lstat(metaFile).catch(() => null), lstat(logFile).catch(() => null)]);
    if (!mst?.isFile()) continue;
    const meta = await readMeta(metaFile, mst.mtimeMs);
    if (!meta) continue;
    const id = meta.toolUseId ?? agentId;
    const call = s.subs.get(id);
    const sub: ClaudeSubagent = out.get(id) ?? { id, title: clipTitle(meta.description ?? 'Subagent') };
    if (meta.agentType) sub.agentType = meta.agentType;
    if (meta.model) sub.model = meta.model;
    let lastAt = 0;
    if (lst?.isFile()) {
      touched.add(logFile);
      const a = await advance(logFile, lst, newAgent, feedAgent).catch(() => null);
      if (a) {
        lastAt = Math.max(a.lastAt ?? 0, lst.mtimeMs);
        lastActivity = Math.max(lastActivity, lastAt);
        Object.assign(sub, { lastActivity: lastAt, idle: a.idle, tools: a.tools }, a.startedAt !== undefined ? { startedAt: a.startedAt } : {}, a.last ? { last: a.last } : {});
        if (a.handedBack) sub.end = 'done';
      }
    }
    // A notice counts only when it came after the agent's last step: a resumed agent outlives the notice of its previous run.
    const notice = [s.notices.get(agentId), meta.toolUseId ? s.notices.get(meta.toolUseId) : undefined].filter((n) => !!n).sort((x, y) => y.at - x.at)[0];
    if (!sub.end && notice && notice.at >= (lastAt || 0)) sub.end = notice.status === 'completed' ? 'done' : 'failed';
    // A foreground call settles by its result (a background call's result never sets `end`).
    if (call?.end && !sub.end) sub.end = call.end;
    out.set(id, sub);
  }
  // Background calls whose agent has no transcript (older Claude Code): their notice is all there is.
  for (const [id, a] of s.subs) {
    const sub = out.get(id)!;
    const notice = s.notices.get(id);
    if (a.background && !sub.end && notice) sub.end = notice.status === 'completed' ? 'done' : 'failed';
  }
  return { subs: [...out.values()], lastActivity };
}

/**
 * A listed session's subagent's transcript, by the id the Manager knows it by (its Agent call's tool-use id, or its
 * agent id): only a session the last listing found, and only inside that session's own subagents/ folder.
 */
export async function findSubagent(sessionId: string, id: string): Promise<{ file: string; meta: AgentMeta } | null> {
  const f = listed.get(sessionId);
  if (!f || !/^[\w-]{1,128}$/.test(id)) return null;
  const dir = path.join(f.dir, sessionId, 'subagents');
  if ((await realpath(dir).catch(() => null)) !== dir) return null;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const m = AGENT_META.exec(name);
    if (!m) continue;
    const metaFile = path.join(dir, name);
    const st = await lstat(metaFile).catch(() => null);
    const meta = st?.isFile() ? await readMeta(metaFile, st.mtimeMs) : null;
    if (meta && (meta.toolUseId === id || m[1] === id)) return { file: path.join(dir, `agent-${m[1]}.jsonl`), meta };
  }
  return null;
}

export interface ListOptions {
  /** The current user's home; sessions are only read under its .claude/projects. */
  home: string;
  /** The workspace folders. None (a window with no folder): every project's sessions from the last week, grouped by project. */
  folders: readonly string[];
  /**
   * Session ids FriedLiver's own chats already have. Such a session is left out only while FriedLiver wrote to it last:
   * one a chat opened and the Claude Code extension or CLI then went on with is listed (the chat never shows that work).
   */
  skip?: ReadonlySet<string>;
  /** Sessions listed at most: 50 for a window's folders, 100 across every project. */
  limit?: number;
  /** Keep trivial and headless sessions and don't archive idle ones (`friedliver.claudeSessions.showAll`). */
  showAll?: boolean;
  now?: number;
  /** Gets a line per folder and per session saying what was read and why each is shown or hidden. */
  report?: string[];
}

let queue: Promise<unknown> = Promise.resolve();
/** Where the last listing found each session: its transcript and its (checked) project folder, for the images scan. */
const listed = new Map<string, { file: string; dir: string }>();

/**
 * The workspace folders' Claude Code sessions, most recent first. Missing folders and unreadable files are left out.
 * Calls run one at a time, since each picks up where the last one stopped reading.
 */
export function listClaudeSessions(opts: ListOptions): Promise<ClaudeSession[]> {
  const run = queue.then(() => list(opts));
  queue = run.catch(() => undefined);
  return run;
}

async function list({ home, folders, skip, limit, showAll = false, now = Date.now(), report }: ListOptions): Promise<ClaudeSession[]> {
  const base = path.join(home, '.claude', 'projects');
  const realBase = await realpath(base).catch(() => null);
  if (!realBase) {
    report?.push(`${base}: missing`);
    return [];
  }
  const all = folders.length === 0;
  const max = limit ?? (all ? 100 : 50);
  listed.clear();
  // With no folder, each project folder's own sessions say which folder they ran in (see below).
  const projects: { cwd?: string; dir: string }[] = all
    ? (await readdir(realBase).catch(() => [] as string[])).map((name) => ({ dir: path.join(realBase, name) }))
    : folders.map((cwd) => ({ cwd, dir: path.join(base, encodeCwd(cwd)) }));
  const found: { id: string; cwd?: string; dir: string; file: string; mtime: number; ino: number; size: number }[] = [];
  for (const { cwd, dir } of projects) {
    const real = await realpath(dir).catch(() => null);
    if (!real || path.dirname(real) !== realBase) {
      report?.push(`folder ${cwd}: ${real ? `project folder ${dir} links out of ${realBase}` : `no project folder (${dir})`}`);
      continue;
    }
    if (cwd) report?.push(`folder ${cwd}: ${real}`);
    const names = await readdir(real).catch(() => [] as string[]);
    for (const name of names) {
      const m = SESSION_FILE.exec(name);
      if (!m) continue;
      const file = path.join(real, name);
      const st = await lstat(file).catch(() => null);
      if (!st?.isFile()) {
        report?.push(`${m[1]}: hidden: not a plain file`);
        continue;
      }
      if (all && !showAll && now - st.mtimeMs > WEEK_MS) continue;
      found.push({ id: m[1], cwd, dir: real, file, mtime: st.mtimeMs, ino: st.ino, size: st.size });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const touched = new Set<string>();
  const out: ClaudeSession[] = [];
  // Counts only what it shows: headless runs can outnumber a person's sessions many times over.
  for (const f of found) {
    const hide = (why: string) => report?.push(`${f.id}: hidden: ${why}`);
    if (out.length >= max) {
      hide(`over the ${max}-session limit`);
      continue;
    }
    touched.add(f.file);
    let error = '';
    const state = await advance(f.file, f, newSession, feedSession).catch((e: unknown) => ((error = String(e)), null));
    if (!state) {
      hide(`unreadable (${error})`);
      continue;
    }
    // FriedLiver's chat shows it while FriedLiver (the TypeScript SDK) wrote to it last; no entrypoint at all is an older transcript.
    if (skip?.has(f.id) && (state.lastEntrypoint ?? 'sdk-ts') === 'sdk-ts') {
      hide('a FriedLiver chat drives it');
      continue;
    }
    // Only a folder whose name is this project folder's: resuming runs Claude Code there.
    const cwd = f.cwd ?? (state.cwd && encodeCwd(state.cwd) === path.basename(f.dir) ? state.cwd : undefined);
    if (!cwd) {
      hide(`its folder (${state.cwd ?? 'none recorded'}) doesn't match ${path.basename(f.dir)}`);
      continue;
    }
    const { trivial, headless, title, messages } = summarize(state);
    if (headless && !showAll) {
      hide(`headless run (${[...state.entrypoints].join(', ')})`);
      continue;
    }
    const { subs, lastActivity: agentsActive } = await sessionSubagents(path.join(f.dir, f.id, 'subagents'), state, touched);
    // A session that launched subagents is never trivial.
    if (trivial && !subs.length && !showAll) {
      hide('trivial (no tools, two short messages at most)');
      continue;
    }
    const lastActivity = Math.max(f.mtime, agentsActive);
    listed.set(f.id, { file: f.file, dir: f.dir });
    out.push({
      id: f.id,
      cwd,
      ...(all ? { project: path.basename(cwd) || cwd } : {}),
      lastActivity,
      messages,
      subagents: subs,
      title: title || `${path.basename(cwd) || cwd} · ${new Date(f.mtime).toISOString().slice(0, 10)}`,
      ...(!showAll && now - lastActivity > WEEK_MS ? { archived: true } : {}),
    });
    if (report) {
      const s = out[out.length - 1];
      const by: Record<string, number> = {};
      for (const a of claudeSubagents(s, now)) by[a.state] = (by[a.state] ?? 0) + 1;
      const counts = Object.entries(by).map(([k, n]) => `${n} ${k}`).join(', ');
      report.push(
        `${f.id} "${s.title}": shown${s.archived ? ' (archived: idle over a week)' : ''}, ${claudeColumn(s, now)}, ${f.size} bytes, last written by ${state.lastEntrypoint ?? 'unknown'}; ${subs.length} subagents${counts ? ` (${counts})` : ''}`,
      );
    }
  }
  // Forget files no longer listed, so memory follows what the Manager shows.
  for (const file of tails.keys()) if (!touched.has(file)) tails.delete(file);
  for (const file of metas.keys()) if (!touched.has(file.replace(/\.meta\.json$/, '.jsonl'))) metas.delete(file);
  if (all) {
    // By project, the most recently active project first; newest first within one (sort is stable).
    const rank = new Map<string, number>();
    for (const s of out) if (!rank.has(s.cwd)) rank.set(s.cwd, rank.size);
    out.sort((a, b) => rank.get(a.cwd)! - rank.get(b.cwd)!);
  }
  // Archived ones last, so the board's newest-first order is unchanged.
  return [...out.filter((s) => !s.archived), ...out.filter((s) => s.archived)];
}

// ---- Images: what a session's Read and screenshot tools looked at ----

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg)$/i;
const SCREENSHOT_TOOL = /screenshot/i;
/** Where a screenshot tool says it saved the file: FriedLiver's browser, Playwright's link or its code. */
const SAVED = [/^Saved to (.+?\.(?:png|jpe?g|gif|webp))\. /m, /\]\(([^)\s]+?\.(?:png|jpe?g|gif|webp))\)/, /save it as (\S+?\.(?:png|jpe?g|gif|webp))\b/];
/** Bytes of a transcript read for images the first time; later reads take only what was appended. */
const MAX_SCAN = 64 * 1024 * 1024;

type ImageLine = { timestamp?: string; message?: { content?: string | (Block & { input?: Record<string, unknown>; content?: unknown })[] } };

/**
 * Reads a transcript's lines for images, a piece at a time as it grows: a Read
 * of an image file, and the file a screenshot tool saved (from its input's
 * filename, or the path its result names). Relative paths are the session's
 * folder's. Each file once, the first time it shows.
 */
export class ImageScan {
  readonly images: OutsideImage[] = [];
  private readonly seen = new Set<string>();
  /** Screenshot calls waiting for their result: id → when. */
  private readonly pending = new Map<string, number>();
  constructor(private readonly cwd: string) {}

  feed(text: string): void {
    for (const line of text.split('\n')) {
      // Most lines are neither; a quick look first spares parsing them (some are megabytes of base64).
      const use = line.includes('"tool_use"');
      const result = !use && this.pending.size > 0 && line.includes('"tool_result"') && [...this.pending.keys()].some((id) => line.includes(id));
      if (!use && !result) continue;
      let o: ImageLine;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const at = Date.parse(o.timestamp ?? '') || 0;
      const blocks = Array.isArray(o.message?.content) ? o.message.content : [];
      for (const b of blocks) {
        if (b.type === 'tool_use' && b.id && b.name) {
          const file = b.input?.file_path ?? b.input?.filename;
          if (b.name === 'Read' && typeof file === 'string') this.add(file, humanTitle(file), 'read', at);
          else if (SCREENSHOT_TOOL.test(b.name)) {
            if (typeof file === 'string') this.add(file, humanTitle(file), 'screenshot', at);
            else this.pending.set(b.id, at);
          }
        } else if (b.type === 'tool_result' && b.tool_use_id && this.pending.has(b.tool_use_id)) {
          const when = this.pending.get(b.tool_use_id)!;
          this.pending.delete(b.tool_use_id);
          const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c: Block) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n') : '';
          const file = SAVED.map((re) => re.exec(text)?.[1]).find(Boolean);
          const title = /^(Screenshot of .+)$/m.exec(text)?.[1] ?? /\[(Screenshot[^\]]*)\]/.exec(text)?.[1];
          if (file) this.add(file, title?.trim() || humanTitle(file), 'screenshot', when);
        }
      }
    }
  }

  private add(file: string, title: string, source: OutsideImage['source'], at: number): void {
    if (!IMAGE_FILE.test(file) || file.includes('\0')) return;
    const full = path.resolve(this.cwd, file);
    if (this.seen.has(full)) return;
    this.seen.add(full);
    this.images.push({ path: full, title: clipTitle(title), source, at });
  }
}

const scans = new Map<string, { size: number; mtime: number; offset: number; scan: ImageScan }>();

/** The images in one transcript file, reading only what it gained since last time (a file that shrank is read again). */
async function scanFile(file: string, cwd: string): Promise<OutsideImage[]> {
  const st = await lstat(file).catch(() => null);
  if (!st?.isFile()) return [];
  let s = scans.get(file);
  if (s && s.size === st.size && s.mtime === st.mtimeMs) return s.scan.images;
  if (!s || st.size < s.size) {
    s = { size: 0, mtime: 0, offset: Math.max(0, st.size - MAX_SCAN), scan: new ImageScan(cwd) };
    scans.set(file, s);
  }
  const fh = await open(file, 'r').catch(() => null);
  if (!fh) return s.scan.images;
  try {
    // Refreshes overlap: another scan may have read on since this one's lstat, so read from where this one starts and
    // move the offset to where it got, never by what it read (which pushed it past the end of the file).
    const from = s.offset;
    const len = st.size - from;
    if (len <= 0) return s.scan.images;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, from);
    // Only whole lines: the last may still be being written.
    const end = buf.lastIndexOf(0x0a, bytesRead - 1) + 1;
    // ponytail: overlapping scans can feed the same lines twice; ImageScan keeps each image once.
    s.scan.feed(buf.toString('utf8', 0, end));
    s.offset = Math.max(s.offset, from + end);
    s.size = st.size;
    s.mtime = st.mtimeMs;
  } finally {
    await fh.close();
  }
  return s.scan.images;
}

/**
 * The images the workspace folders' Claude Code sessions read or took, with
 * their subagents', per session, the most recent sessions first. Sessions
 * FriedLiver's own chats have (`skip`) are left out: those chats show them.
 */
export async function listClaudeImages({ home, folders, skip, limit = 50 }: Pick<ListOptions, 'home' | 'folders' | 'skip' | 'limit'>): Promise<OutsideImages[]> {
  // The sessions the Manager lists (headless runs hidden), and the files that listing checked.
  const sessions = await listClaudeSessions({ home, folders, skip, limit });
  const out: OutsideImages[] = [];
  for (const s of sessions) {
    const f = listed.get(s.id);
    if (!f) continue;
    // Its subagents' transcripts, unless that folder is a link out of the session's own.
    const subDir = path.join(f.dir, s.id, 'subagents');
    const realSub = await realpath(subDir).catch(() => null);
    const subs = realSub === subDir ? await readdir(subDir).catch(() => [] as string[]) : [];
    const files = [f.file, ...subs.filter((n) => /^agent-[\w-]+\.jsonl$/.test(n)).map((n) => path.join(subDir, n))];
    const images: OutsideImage[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      for (const img of await scanFile(file, s.cwd)) {
        if (seen.has(img.path)) continue;
        seen.add(img.path);
        images.push(img);
      }
    }
    if (!images.length) continue;
    out.push({ id: s.id, cwd: s.cwd, title: s.title, images });
  }
  return out;
}
