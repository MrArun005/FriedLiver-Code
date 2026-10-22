import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { agentFace, EMPTY_STATE, EXPIRED, isStoredAgentKey, MAX_USAGE_LOG, type TurnUsage, type AppState, type ChatLink, type ChatView, type Item } from '../shared/model';
import type { ChatSession, SessionOption } from '../shared/session';
import { savedDiscussion } from '../shared/discuss';

/** What the next window needs to bring a chat back. Never API keys or bridge tokens. */
export interface SavedChat {
  agent: ChatView['agent'];
  cwd: string;
  /** The agent's session, reloaded when the agent supports it. */
  sessionId?: string;
  worktree?: { path: string; branch: string; repo: string; title: string };
  /** A hand-off's context that no message has carried yet. */
  preamble?: string;
  /** Session settings the user chose in the chat (optionKey → value), applied again when it continues. */
  choices?: Record<string, string | boolean>;
}

export interface SavedState {
  version: 1;
  state: AppState;
  chats: Record<string, SavedChat>;
  /** Where the core's ids continue, so new ones never match restored ones. */
  nextId: number;
  chatCount: Partial<Record<ChatView['agent'], number>>;
}

export const SAVE_LIMITS = {
  items: 400,
  output: 8 * 1024,
  /** Characters of one message; a chat can hold replies of up to 512 KB. */
  text: 32 * 1024,
  bytes: 8 * 1024 * 1024,
};

const STOPPED = 'Stopped when the window closed';

/**
 * The state as it goes to disk: recent items only, short command output, no
 * images (they are large and the Images view starts empty anyway). If it is
 * still too big, the oldest archived chats go first, then the oldest others.
 */
export function trimForSave(saved: SavedState, limit = SAVE_LIMITS.bytes): SavedState {
  let chats = saved.state.chats.map(trimChat);
  const size = new Map(chats.map((c) => [c.id, savedJson(c).length + JSON.stringify(saved.chats[c.id] ?? {}).length]));
  let total = [...size.values()].reduce((a, b) => a + b, 0);
  const byAge = (a: ChatView, b: ChatView) => a.lastActivity - b.lastActivity;
  const order = [...chats.filter((c) => c.archived).sort(byAge), ...chats.filter((c) => !c.archived).sort(byAge)];
  const dropped = new Set<string>();
  for (const c of order) {
    if (total <= limit) break;
    dropped.add(c.id);
    total -= size.get(c.id)!;
  }
  chats = chats.filter((c) => !dropped.has(c.id));
  const kept = new Set(chats.map((c) => c.id));
  return {
    ...saved,
    state: { chats, images: [], links: saved.state.links.filter((l) => kept.has(l.from) && kept.has(l.to)) },
    chats: Object.fromEntries(Object.entries(saved.chats).filter(([id]) => kept.has(id))),
  };
}

/**
 * What saveText writes: JSON.stringify(trimForSave(saved)). Chats that didn't
 * change since the last save reuse their JSON, so a save while agents stream
 * turns only the chats that changed into text, not every transcript again.
 */
export function saveText(saved: SavedState, limit = SAVE_LIMITS.bytes): string {
  const trimmed = trimForSave(saved, limit);
  const json = JSON.stringify({ ...trimmed, state: { ...trimmed.state, chats: [CHATS] } });
  // The marker is the first string in the file: only numbers come before it.
  return json.replace(JSON.stringify([CHATS]), () => `[${trimmed.state.chats.map(savedJson).join(',')}]`);
}

const CHATS = '\u0000friedliver:chats\u0000';

/** Trimmed chats, by the chat they were trimmed from, and their JSON, by the trimmed chat. */
const trimmedCache = new WeakMap<ChatView, ChatView>();
const jsonCache = new WeakMap<ChatView, string>();

function savedJson(trimmed: ChatView): string {
  let json = jsonCache.get(trimmed);
  if (json === undefined) {
    json = JSON.stringify(trimmed);
    jsonCache.set(trimmed, json);
  }
  return json;
}

/** A chat as it is saved; the same object for the same chat, so its JSON is made once. */
function trimChat(chat: ChatView): ChatView {
  let trimmed = trimmedCache.get(chat);
  if (!trimmed) {
    trimmed = trimItems(chat);
    trimmedCache.set(chat, trimmed);
  }
  return trimmed;
}

function trimItems(chat: ChatView): ChatView {
  const items = chat.items.slice(-SAVE_LIMITS.items).map((i): Item => {
    if (i.kind === 'command' && i.output.length > SAVE_LIMITS.output) return { ...i, output: i.output.slice(-SAVE_LIMITS.output) };
    if (i.kind === 'user' && i.images.length) i = { ...i, images: [] };
    if ((i.kind === 'user' || i.kind === 'agent' || i.kind === 'thought' || i.kind === 'link') && i.text.length > SAVE_LIMITS.text) {
      return { ...i, text: `${i.text.slice(0, SAVE_LIMITS.text)}\n\n[Shortened when saved.]` };
    }
    return i;
  });
  return { ...chat, items };
}

/**
 * Nothing restored is waiting any more: the agent that asked is gone. Open
 * questions, reviews, commands and tool requests are closed as stopped, and
 * chats that were busy say so.
 */
export function settleRestored(state: AppState): AppState {
  const chats = state.chats.map((chat) => {
    let stopped = chat.busy;
    const items = chat.items.map((i): Item => {
      // Still waiting: nobody decided it, so it says it expired, never "Rejected" or "Denied", and the Inbox doesn't list it as your answer.
      if (i.kind === 'permission' && !i.answer) {
        stopped = true;
        return { ...i, answer: EXPIRED, expired: true };
      }
      if (i.kind === 'review' && i.state === 'pending') {
        stopped = true;
        return { ...i, state: 'rejected', expired: true };
      }
      if (i.kind === 'command' && i.state === 'awaiting') {
        stopped = true;
        return { ...i, state: 'denied', expired: true };
      }
      if (i.kind === 'command' && i.state === 'running') {
        stopped = true;
        return { ...i, state: 'exited', exitCode: null };
      }
      if (i.kind === 'question' && i.state === 'awaiting') {
        stopped = true;
        return { ...i, state: 'declined', expired: true };
      }
      if (i.kind === 'bridge' && i.state === 'awaiting') {
        stopped = true;
        return { ...i, state: 'denied', expired: true };
      }
      return i;
    });
    if (stopped) items.push({ kind: 'notice', tone: 'info', text: `${STOPPED}.` });
    // The agent process is gone; queued messages went with the window; Full auto asks again.
    return {
      ...chat,
      busy: false,
      items,
      session: chat.session && { ...chat.session, live: false, starting: undefined, usage: undefined },
      approval: chat.approval === 'full' ? undefined : chat.approval,
      queue: undefined,
    };
  });
  return { ...state, chats };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const ID = /^[\w.:-]{1,128}$/;
const str = (v: unknown): v is string => typeof v === 'string';
const ITEM_KINDS = new Set(['user', 'agent', 'thought', 'tool', 'plan', 'permission', 'review', 'command', 'notice', 'changes', 'link', 'bridge', 'question', 'discussion']);

/** A saved file read back, or null when it isn't one. Chats that don't make sense are left out. */
export function parseSaved(raw: unknown): SavedState | null {
  if (!isObj(raw) || raw.version !== 1 || !isObj(raw.state) || !isObj(raw.chats) || !Array.isArray(raw.state.chats)) return null;
  const host = raw.chats;
  const chats: ChatView[] = [];
  const saved: Record<string, SavedChat> = {};
  for (const c of raw.state.chats as unknown[]) {
    if (!isObj(c) || !str(c.id) || !ID.test(c.id) || !isStoredAgentKey(c.agent) || !str(c.cwd) || !Array.isArray(c.items)) continue;
    if (chats.some((x) => x.id === c.id)) continue;
    const h = host[c.id];
    if (!isObj(h) || h.agent !== c.agent || h.cwd !== c.cwd) continue;
    const createdAt = num(c.createdAt, Date.now());
    chats.push({
      id: c.id,
      agent: c.agent,
      // Older versions numbered it ("Claude 9"); a chat is named by its topic now, so only the agent's name stays.
      label: agentFace(c.agent).name,
      title: str(c.title) ? c.title : 'Untitled task',
      titlePinned: c.titlePinned === true || undefined,
      cwd: c.cwd,
      branch: str(c.branch) ? c.branch : undefined,
      merged: c.merged === true || undefined,
      createdAt,
      busy: c.busy === true,
      changedFiles: num(c.changedFiles, 0),
      items: savedItems(c.items as unknown[]),
      origin: isObj(c.origin) && (c.origin.kind === 'handoff' || c.origin.kind === 'consult') && str(c.origin.chatId) && (c.origin.by === 'user' || c.origin.by === 'agent')
        ? { kind: c.origin.kind, chatId: c.origin.chatId, by: c.origin.by }
        : undefined,
      group: str(c.group) ? c.group : undefined,
      depth: num(c.depth, 0),
      files: Array.isArray(c.files) ? c.files.filter(str) : [],
      lastActivity: num(c.lastActivity, createdAt),
      turns: num(c.turns, 0),
      archived: c.archived === true || undefined,
      starred: c.starred === true || undefined,
      session: savedSession(c.session),
      usageLog: savedUsageLog(c.usageLog),
      // Full auto is never restored: a reopened chat asks again.
      approval: c.approval === 'edits' ? 'edits' : undefined,
    });
    const wt = h.worktree;
    saved[c.id] = {
      agent: c.agent,
      cwd: c.cwd,
      sessionId: str(h.sessionId) ? h.sessionId : undefined,
      worktree: isObj(wt) && str(wt.path) && str(wt.branch) && str(wt.repo) && str(wt.title) ? { path: wt.path, branch: wt.branch, repo: wt.repo, title: wt.title } : undefined,
      preamble: str(h.preamble) ? h.preamble : undefined,
      choices: savedChoices(h.choices),
    };
  }
  const ids = new Set(chats.map((c) => c.id));
  const links = (Array.isArray(raw.state.links) ? raw.state.links : []).filter(
    (l): l is ChatLink => isObj(l) && str(l.id) && (l.kind === 'handoff' || l.kind === 'consult' || l.kind === 'pipe') && ids.has(l.from as string) && ids.has(l.to as string),
  );
  const count: SavedState['chatCount'] = {};
  if (isObj(raw.chatCount)) for (const [k, v] of Object.entries(raw.chatCount)) if (isStoredAgentKey(k)) count[k] = num(v, 0);
  return { version: 1, state: { ...EMPTY_STATE, chats, links }, chats: saved, nextId: num(raw.nextId, 1), chatCount: count };
}

/** Items of the kinds there are; a discussion is checked field by field, and one still going ends there. */
function savedItems(raw: unknown[]): Item[] {
  const items = raw.filter((i): i is Obj => isObj(i) && ITEM_KINDS.has(i.kind as string));
  return items.flatMap((i, n) => (i.kind === 'discussion' ? (savedDiscussion(i, items.length - n - 1) ?? []) : [i as unknown as Item]));
}

function savedChoices(v: unknown): Record<string, string | boolean> | undefined {
  if (!isObj(v)) return undefined;
  const entries = Object.entries(v).filter(([k, x]) => k.length <= 128 && (typeof x === 'boolean' || (typeof x === 'string' && x.length <= 256)));
  return entries.length ? (Object.fromEntries(entries.slice(0, 16)) as Record<string, string | boolean>) : undefined;
}

/** A saved session's settings, shown until the agent starts again; the rest is dropped. */
function savedSession(v: unknown): ChatSession | undefined {
  if (!isObj(v) || !Array.isArray(v.options)) return undefined;
  const options = (v.options as unknown[]).filter(
    (o): o is SessionOption =>
      isObj(o) && str(o.id) && str(o.name) && (o.type === 'select' || o.type === 'boolean') && (typeof o.current === 'string' || typeof o.current === 'boolean') && Array.isArray(o.choices) && (o.via === 'option' || o.via === 'mode' || o.via === 'model'),
  );
  const commands = (Array.isArray(v.commands) ? v.commands : []).filter((c): c is ChatSession['commands'][number] => isObj(c) && str(c.name) && str(c.description));
  return { options: options.slice(0, 32), commands: commands.slice(0, 200), live: false };
}

/** A chat's per-turn token log as saved: only well-formed turns, the newest MAX_USAGE_LOG. */
function savedUsageLog(v: unknown): TurnUsage[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const n = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  const log = v
    .filter((t): t is Obj => isObj(t) && [t.at, t.input, t.output, t.cacheRead, t.cacheWrite].every(n))
    .slice(-MAX_USAGE_LOG)
    .map((t): TurnUsage => {
      const ctx = isObj(t.context) && n(t.context.used) && n(t.context.size) ? { used: t.context.used as number, size: t.context.size as number } : undefined;
      const cost = isObj(t.cost) && n(t.cost.amount) && str(t.cost.currency) ? { amount: t.cost.amount as number, currency: t.cost.currency.slice(0, 8) } : undefined;
      return { at: t.at as number, input: t.input as number, output: t.output as number, cacheRead: t.cacheRead as number, cacheWrite: t.cacheWrite as number, ...(ctx ? { context: ctx } : {}), ...(cost ? { cost } : {}) };
    });
  return log.length ? log : undefined;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * The chats file in the editor's storage for this workspace. Saves are
 * debounced, written to a temporary file and renamed into place, so a crash
 * mid-write leaves the previous save intact.
 */
export class StateFile {
  private timer?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    readonly file: string,
    private readonly read: () => SavedState,
    private readonly log?: (line: string) => void,
    private readonly delayMs = 1000,
  ) {}

  async load(): Promise<SavedState | null> {
    try {
      return parseSaved(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log?.(`Couldn't read saved chats: ${String(err)}`);
      return null;
    }
  }

  schedule(): void {
    if (this.stopped) return;
    this.timer ??= setTimeout(() => void this.flush(), this.delayMs);
  }

  /** Writes now, after any write already under way. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped) return this.writing;
    const json = saveText(this.read());
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await writeFile(tmp, json, 'utf8');
        await rename(tmp, this.file);
      } catch (err) {
        this.log?.(`Couldn't save chats: ${String(err)}`);
      }
    });
    return this.writing;
  }

  /** No more saves, e.g. once the core starts shutting down and cancels what was running. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Stops saving and deletes the file, when the user turns restoring off. */
  async clear(): Promise<void> {
    this.stop();
    await this.writing;
    await rm(this.file, { force: true });
  }
}
