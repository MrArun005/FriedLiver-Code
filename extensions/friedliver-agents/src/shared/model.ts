// State shared by the extension host and its webviews. The host owns it and
// sends every action to the webviews, which fold it with the same reducer.
import type * as acp from '@agentclientprotocol/sdk';

export const AGENT_KEYS = ['claude', 'codex', 'gemini', 'demo'] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

/** Every agent has a face: a letter on a tint of its hue. */
export const AGENT_FACES: Record<AgentKey, { letter: string; name: string }> = {
  claude: { letter: 'C', name: 'Claude' },
  codex: { letter: 'X', name: 'Codex' },
  gemini: { letter: 'G', name: 'Gemini' },
  demo: { letter: 'D', name: 'Demo' },
};

export function isAgentKey(value: unknown): value is AgentKey {
  return typeof value === 'string' && (AGENT_KEYS as readonly string[]).includes(value);
}

export interface ImageItem {
  id: string;
  /** A data: URI. */
  src: string;
  title: string;
  from: 'agent' | 'you';
}

/** What a button on a notice does; plain data, so it can cross into a webview. */
export type NoticeAction =
  | { label: string; do: 'retry' }
  | { label: string; do: 'signIn'; agent: AgentKey; methodId: string }
  | { label: string; do: 'apiKey'; agent: AgentKey }
  | { label: string; do: 'install'; command: string };

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export type CommandState = 'awaiting' | 'running' | 'denied' | 'exited';

export interface CommandItem {
  kind: 'command';
  commandId: string;
  commandLine: string;
  cwd: string;
  /** The command's folder is outside the workspace and the task's worktree. */
  outside: boolean;
  state: CommandState;
  output: string;
  exitCode?: number | null;
  startedAt?: number;
  durationMs?: number;
}

export interface ReviewItem {
  kind: 'review';
  reviewId: string;
  path: string;
  added: number;
  removed: number;
  isNew: boolean;
  state: 'pending' | 'accepted' | 'rejected';
}

export type Item =
  | { kind: 'user'; text: string; images: string[] }
  | { kind: 'agent'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; id: string; title: string; toolKind?: string; status?: string; locations: string[] }
  | { kind: 'plan'; entries: { content: string; status: string }[] }
  | { kind: 'permission'; requestId: string; toolCallId?: string; title: string; options: PermissionOption[]; answer?: string }
  | ReviewItem
  | CommandItem
  | { kind: 'notice'; text: string; tone: 'info' | 'error'; detail?: string; actions?: NoticeAction[] }
  | { kind: 'changes'; turnId: string; files: string[]; undone?: boolean };

export interface ChatView {
  id: string;
  agent: AgentKey;
  /** Agent name, numbered when several chats use the same agent. */
  label: string;
  /** What the task is about: the first message, shortened. */
  title: string;
  cwd: string;
  /** Set while the task has its own git worktree. */
  branch?: string;
  merged?: boolean;
  createdAt: number;
  busy: boolean;
  changedFiles: number;
  items: Item[];
}

export interface AppState {
  chats: ChatView[];
  images: ImageItem[];
}

export const EMPTY_STATE: AppState = { chats: [], images: [] };

export type Action =
  | { t: 'created'; chat: ChatView }
  | { t: 'closed'; chatId: string }
  | { t: 'items'; chatId: string; items: Item[] }
  | { t: 'update'; chatId: string; update: acp.SessionUpdate }
  | { t: 'busy'; chatId: string; busy: boolean }
  | { t: 'title'; chatId: string; title: string }
  | { t: 'permissionAnswered'; requestId: string; answer: string }
  | { t: 'review'; reviewId: string; state: ReviewItem['state'] }
  | { t: 'command'; commandId: string; patch: Partial<Omit<CommandItem, 'kind' | 'commandId' | 'output'>> }
  | { t: 'commandOutput'; commandId: string; data: string }
  | { t: 'changes'; chatId: string; turnId: string; files: string[] }
  | { t: 'undone'; chatId: string; turnId: string }
  | { t: 'worktree'; chatId: string; branch?: string; merged?: boolean }
  | { t: 'image'; image: ImageItem };

/** Command output kept in the transcript; the agent still gets its full output through ACP. */
export const MAX_COMMAND_OUTPUT = 64 * 1024;
const MAX_IMAGES = 100;

export function reduce(state: AppState, action: Action): AppState {
  switch (action.t) {
    case 'created':
      return { ...state, chats: [...state.chats, action.chat] };
    case 'closed':
      return { ...state, chats: state.chats.filter((c) => c.id !== action.chatId) };
    case 'items':
      return editChat(state, action.chatId, (c) => ({ ...c, items: [...c.items, ...action.items] }));
    case 'update':
      return editChat(state, action.chatId, (c) => ({ ...c, items: applyUpdate(c.items, action.update) }));
    case 'busy':
      return editChat(state, action.chatId, (c) => ({ ...c, busy: action.busy }));
    case 'title':
      return editChat(state, action.chatId, (c) => ({ ...c, title: action.title }));
    case 'permissionAnswered':
      return editItems(state, (i) => (i.kind === 'permission' && i.requestId === action.requestId ? { ...i, answer: action.answer } : i));
    case 'review':
      return editItems(state, (i) => (i.kind === 'review' && i.reviewId === action.reviewId ? { ...i, state: action.state } : i));
    case 'command':
      return editItems(state, (i) => (i.kind === 'command' && i.commandId === action.commandId ? { ...i, ...action.patch } : i));
    case 'commandOutput':
      return editItems(state, (i) =>
        i.kind === 'command' && i.commandId === action.commandId ? { ...i, output: (i.output + action.data).slice(-MAX_COMMAND_OUTPUT) } : i,
      );
    case 'changes':
      return editChat(state, action.chatId, (c) => ({
        ...c,
        changedFiles: c.changedFiles + action.files.length,
        items: [...c.items, { kind: 'changes', turnId: action.turnId, files: action.files }],
      }));
    case 'undone':
      return editChat(state, action.chatId, (c) => {
        const card = c.items.find((i) => i.kind === 'changes' && i.turnId === action.turnId);
        const undone = card?.kind === 'changes' && !card.undone ? card.files.length : 0;
        return {
          ...c,
          changedFiles: Math.max(0, c.changedFiles - undone),
          items: c.items.map((i) => (i.kind === 'changes' && i.turnId === action.turnId ? { ...i, undone: true } : i)),
        };
      });
    case 'worktree':
      return editChat(state, action.chatId, (c) => ({ ...c, branch: action.branch, merged: action.merged ?? c.merged }));
    case 'image':
      if (state.images.some((i) => i.id === action.image.id)) return state;
      return { ...state, images: [...state.images, action.image].slice(-MAX_IMAGES) };
  }
}

function editChat(state: AppState, chatId: string, fn: (c: ChatView) => ChatView): AppState {
  return { ...state, chats: state.chats.map((c) => (c.id === chatId ? fn(c) : c)) };
}

function editItems(state: AppState, fn: (i: Item) => Item): AppState {
  return {
    ...state,
    chats: state.chats.map((c) => {
      let changed = false;
      const items = c.items.map((i) => {
        const next = fn(i);
        if (next !== i) changed = true;
        return next;
      });
      return changed ? { ...c, items } : c;
    }),
  };
}

/** Folds one ACP session update into a transcript. */
export function applyUpdate(items: Item[], update: acp.SessionUpdate): Item[] {
  const last = items.at(-1);
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      if (update.content.type !== 'text') return items;
      const kind = update.sessionUpdate === 'agent_message_chunk' ? 'agent' : 'thought';
      if (last?.kind === kind) return [...items.slice(0, -1), { kind, text: last.text + update.content.text }];
      return [...items, { kind, text: update.content.text }];
    }
    case 'tool_call': {
      const tool: Item = {
        kind: 'tool',
        id: update.toolCallId,
        title: update.title,
        toolKind: update.kind,
        status: update.status,
        locations: (update.locations ?? []).map((l) => l.path),
      };
      const at = items.findIndex((i) => i.kind === 'tool' && i.id === update.toolCallId);
      return at < 0 ? [...items, tool] : items.map((i, n) => (n === at ? tool : i));
    }
    case 'tool_call_update':
      return items.map((i) =>
        i.kind === 'tool' && i.id === update.toolCallId
          ? {
              ...i,
              title: update.title ?? i.title,
              status: update.status ?? i.status,
              locations: update.locations ? update.locations.map((l) => l.path) : i.locations,
            }
          : i,
      );
    case 'plan': {
      const plan: Item = { kind: 'plan', entries: update.entries.map((e) => ({ content: e.content, status: e.status })) };
      // One live plan per turn: replace it in place until the user speaks again.
      const lastUser = items.map((i) => i.kind).lastIndexOf('user');
      const at = items.findIndex((i, n) => n > lastUser && i.kind === 'plan');
      return at < 0 ? [...items, plan] : items.map((i, n) => (n === at ? plan : i));
    }
    default:
      return items;
  }
}

/** One line from the first message, for tabs and cards. */
export function titleFrom(text: string): string {
  const line = text.split('\n')[0].trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'Untitled task';
}

export type ChatStatus = 'idle' | 'working' | 'needs-you' | 'done' | 'error';

export interface Decision {
  chatId: string;
  kind: 'permission' | 'review' | 'command';
  /** requestId, reviewId or commandId. */
  id: string;
  title: string;
}

/** Everything the agents are waiting on the user for, oldest chat first. */
export function decisions(state: AppState): Decision[] {
  const out: Decision[] = [];
  for (const chat of state.chats) {
    for (const i of chat.items) {
      if (i.kind === 'permission' && !i.answer) out.push({ chatId: chat.id, kind: 'permission', id: i.requestId, title: i.title });
      else if (i.kind === 'review' && i.state === 'pending') out.push({ chatId: chat.id, kind: 'review', id: i.reviewId, title: `Review edit to ${basename(i.path)}` });
      else if (i.kind === 'command' && i.state === 'awaiting') out.push({ chatId: chat.id, kind: 'command', id: i.commandId, title: `Run ${shortCommand(i.commandLine)}` });
    }
  }
  return out;
}

export function chatStatus(chat: ChatView): ChatStatus {
  if (decisions({ chats: [chat], images: [] }).length > 0) return 'needs-you';
  if (chat.busy) return 'working';
  const last = chat.items.at(-1);
  if (last?.kind === 'notice' && last.tone === 'error') return 'error';
  return chat.items.some((i) => i.kind === 'user') ? 'done' : 'idle';
}

export type BoardColumn = 'needs-you' | 'working' | 'done';

/** A failed task waits on the user too (sign in, install, retry). */
export function boardColumn(status: ChatStatus): BoardColumn {
  if (status === 'needs-you' || status === 'error') return 'needs-you';
  if (status === 'working') return 'working';
  return 'done';
}

export interface StateLine {
  text: string;
  /** A command line or file path shown under the text in code style. */
  code?: string;
  decision?: Decision;
}

/** What a task card says about where the task stands. */
export function stateLine(chat: ChatView): StateLine {
  const waiting = decisions({ chats: [chat], images: [] })[0];
  if (waiting) {
    const item = chat.items.find(
      (i) =>
        (i.kind === 'review' && i.reviewId === waiting.id) ||
        (i.kind === 'command' && i.commandId === waiting.id) ||
        (i.kind === 'permission' && i.requestId === waiting.id),
    );
    if (item?.kind === 'review') return { text: `Edit to review: ${basename(item.path)} +${item.added} −${item.removed}`, decision: waiting };
    if (item?.kind === 'command') return { text: 'Wants to run a command', code: item.commandLine, decision: waiting };
    if (item?.kind === 'permission') return { text: `Asks: ${item.title}`, decision: waiting };
  }
  const status = chatStatus(chat);
  if (status === 'working') {
    const plan = [...chat.items].reverse().find((i) => i.kind === 'plan');
    if (plan?.kind === 'plan' && plan.entries.length) {
      const at = plan.entries.findIndex((e) => e.status !== 'completed');
      if (at >= 0) return { text: `Step ${at + 1} of ${plan.entries.length}: ${plan.entries[at].content}` };
    }
    const tool = [...chat.items].reverse().find((i) => i.kind === 'tool');
    return { text: tool?.kind === 'tool' ? tool.title : 'Working…' };
  }
  if (status === 'error') {
    const last = chat.items.at(-1);
    return { text: last?.kind === 'notice' ? last.text : 'Something went wrong' };
  }
  if (status === 'done') {
    const files = chat.changedFiles;
    return { text: files ? `Done · ${files} file${files === 1 ? '' : 's'} changed` : 'Done' };
  }
  return { text: 'Not started' };
}

/** "3m", "2h", "5d": how long ago a task started. */
export function age(since: number, now: number): string {
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
}

/**
 * Lines added and removed between two texts, for "+a −b". Counts lines by
 * multiset rather than aligning them, which is exact for the usual edit and
 * cheap for large files.
 */
export function lineStats(before: string | null, after: string): { added: number; removed: number } {
  const split = (t: string) => (t === '' ? [] : t.replace(/\n$/, '').split('\n'));
  const counts = new Map<string, number>();
  for (const line of split(before ?? '')) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of split(after)) {
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of counts.values()) removed += n;
  return { added, removed };
}

/**
 * A command line short enough for a notification: programs given by absolute
 * path show by name (`/usr/local/bin/node -e …` reads `node -e …`).
 */
export function shortCommand(line: string, max = 80): string {
  const short = line.replace(/(^|\s)(['"]?)(?:[A-Za-z]:)?(?:[\\/][^\s'"\\/]*)+[\\/]([^\s'"\\/]+)/g, '$1$2$3');
  return short.length > max ? `${short.slice(0, max - 1)}…` : short;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
