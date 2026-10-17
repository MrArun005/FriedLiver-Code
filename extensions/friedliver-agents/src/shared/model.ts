// State shared by the extension host and its webviews. The host owns it and
// sends every action to the webviews, which fold it with the same reducer.
import type * as acp from '@agentclientprotocol/sdk';
import { applySessionUpdate, isSessionUpdate, type ApprovalLevel, type ChatSession } from './session';
import type { QuestionField } from './questions';
import { appendOutput, claudeMeta, streamedOutput, toolInput, toolOut, type PermissionDetail, type ToolOut } from './tools';
import { stepFacts, withRawOutput, type StepFacts } from './steps';

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
  /** The host looks the install command up from the agent; a webview never supplies it. */
  | { label: string; do: 'install'; agent: AgentKey };

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
  /** Ran without asking, and why: "Full auto", or the "Always allow" rule that covers it. */
  auto?: string;
}

export interface ReviewItem {
  kind: 'review';
  reviewId: string;
  path: string;
  added: number;
  removed: number;
  isNew: boolean;
  state: 'pending' | 'accepted' | 'rejected';
  /** Decided without the diff editor, and why: "Auto-accept edits", "Approved above". */
  auto?: string;
}

// ---- Connections between chats ----

/**
 * How two chats are joined:
 * - handoff: `to` continues `from`'s work with another agent, starting from its transcript.
 * - consult: `from` asked `to` a question; the reply comes back into `from`.
 * - pipe: each finished turn of `from` goes to `to` as a message, while `active`.
 */
export type LinkKind = 'handoff' | 'consult' | 'pipe';

export interface ChatLink {
  id: string;
  kind: LinkKind;
  from: string;
  to: string;
  /** The user made it, or an agent did through the FriedLiver tools (after the user allowed it). */
  by: 'user' | 'agent';
  createdAt: number;
  /** Pipes: forwarding is on. Others are always active. */
  active: boolean;
  /** Messages carried over this link so far. */
  count: number;
}

/** Chats an agent may start through the FriedLiver tools, counted from a chat the user started. */
export const MAX_LINK_DEPTH = 2;

/** What an agent asked to do with another chat or agent through the FriedLiver tools. */
export type BridgeTool = 'ask_agent' | 'send_to_chat' | 'read_chat';

export interface BridgeItem {
  kind: 'bridge';
  requestId: string;
  tool: BridgeTool;
  /** Another agent (a new consultation) or an existing chat. */
  target: { agent: AgentKey } | { chatId: string };
  /** The question or message; empty for read_chat. */
  text: string;
  state: 'awaiting' | 'allowed' | 'denied';
}

/**
 * A message that crossed a link, shown in both chats:
 * - asked / reply: this chat consulted `chatId`, and its answer.
 * - consulted: this chat was started by `chatId` to answer a question.
 * - handoff-from / handoff-to: this chat continues `chatId`, or was continued in it.
 * - piped-in / piped-out: a turn forwarded from or to `chatId`.
 */
export interface LinkItem {
  kind: 'link';
  linkId: string;
  role: 'asked' | 'reply' | 'consulted' | 'handoff-from' | 'handoff-to' | 'piped-in' | 'piped-out';
  /** The other chat. */
  chatId: string;
  /** The other chat's agent and label, kept so the item reads right after that chat is gone. */
  agent: AgentKey;
  label: string;
  text: string;
  by: 'user' | 'agent';
}

/**
 * Code a message is about: lines of a file, 1-based and inclusive. The path is
 * absolute, like a review's. Chats show it as a chip that opens the lines.
 */
export interface CodeRef {
  path: string;
  startLine: number;
  endLine: number;
}

export type Item =
  /** `refs` (optional, added with the editor commands) is the code the message points at. */
  | { kind: 'user'; text: string; images: string[]; refs?: CodeRef[] }
  | { kind: 'agent'; text: string }
  | { kind: 'thought'; text: string }
  /**
   * `out` and `input` (optional): what the tool did (diffs, output) and its input, cut short.
   * `tool` and `parent` (optional): Claude's tool name, and the subagent (Task/Agent) call this one ran inside.
   * The StepFacts (optional): the command it runs, what for, its exit code and duration.
   */
  | ({ kind: 'tool'; id: string; title: string; toolKind?: string; status?: string; locations: string[]; out?: ToolOut[]; input?: string; tool?: string; parent?: string } & StepFacts)
  | { kind: 'plan'; entries: { content: string; status: string }[] }
  /**
   * `toolKind` and `detail` (optional) say what is being approved: the diff, the command, the plan.
   * `auto` says FriedLiver answered it under the chat's approval level or a rule.
   */
  | { kind: 'permission'; requestId: string; toolCallId?: string; title: string; options: PermissionOption[]; answer?: string; toolKind?: string; detail?: PermissionDetail; auto?: string }
  | ReviewItem
  | CommandItem
  | { kind: 'notice'; text: string; tone: 'info' | 'error'; detail?: string; actions?: NoticeAction[] }
  | { kind: 'changes'; turnId: string; files: string[]; undone?: boolean }
  | LinkItem
  | BridgeItem
  | QuestionItem;

/** A question the agent asks as a small form (ACP elicitation), e.g. Claude's AskUserQuestion. */
export interface QuestionItem {
  kind: 'question';
  requestId: string;
  message: string;
  fields: QuestionField[];
  state: 'awaiting' | 'answered' | 'declined';
  /** The answer, in one line, once given. */
  summary?: string;
}

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
  /** Set when another chat started this one: a hand-off or a consultation. */
  origin?: { kind: 'handoff' | 'consult'; chatId: string; by: 'user' | 'agent' };
  /** Chats started together with the same task on several agents, to compare. */
  group?: string;
  /** Hops from a chat the user started; agents can't start chats past MAX_LINK_DEPTH. */
  depth: number;
  /** Files the agents proposed or made changes to, relative to `cwd`, with forward slashes. */
  files: string[];
  /** When the agent last sent anything, for "active 3s ago" and sorting. */
  lastActivity: number;
  /** Finished turns. */
  turns: number;
  /** Put away: kept for its history, hidden from the board and the tab bar. */
  archived?: boolean;
  /** What the agent's session offers (model, effort, modes, commands) and reports (mode, usage). */
  session?: ChatSession;
  /** FriedLiver's approval level for the chat; Ask when unset. */
  approval?: ApprovalLevel;
  /** Messages sent while the agent worked, in order: each goes when the turn before it ends. */
  queue?: QueuedMessage[];
}

export interface QueuedMessage {
  id: string;
  text: string;
  images: number;
  refs?: number;
}

export interface AppState {
  chats: ChatView[];
  images: ImageItem[];
  links: ChatLink[];
}

export const EMPTY_STATE: AppState = { chats: [], images: [], links: [] };

/** `at` is the host's clock, so every webview folds the same state. */
export type Action =
  | { t: 'created'; chat: ChatView }
  | { t: 'closed'; chatId: string }
  | { t: 'items'; chatId: string; items: Item[]; at?: number }
  | { t: 'update'; chatId: string; update: acp.SessionUpdate; at?: number }
  | { t: 'busy'; chatId: string; busy: boolean; at?: number }
  | { t: 'title'; chatId: string; title: string }
  | { t: 'permissionAnswered'; requestId: string; answer: string; auto?: string }
  | { t: 'review'; reviewId: string; state: ReviewItem['state']; auto?: string }
  | { t: 'command'; commandId: string; patch: Partial<Omit<CommandItem, 'kind' | 'commandId' | 'output'>> }
  | { t: 'commandOutput'; commandId: string; data: string }
  | { t: 'changes'; chatId: string; turnId: string; files: string[] }
  | { t: 'undone'; chatId: string; turnId: string }
  | { t: 'worktree'; chatId: string; branch?: string; merged?: boolean }
  | { t: 'image'; image: ImageItem }
  | { t: 'link'; link: ChatLink }
  | { t: 'linkPatch'; linkId: string; patch: Partial<Pick<ChatLink, 'active' | 'count'>> }
  | { t: 'unlink'; linkId: string }
  | { t: 'bridge'; requestId: string; state: BridgeItem['state'] }
  | { t: 'question'; requestId: string; state: QuestionItem['state']; summary?: string }
  /** Files a turn proposed or changed, relative to the chat's cwd; merged into `files`. */
  | { t: 'files'; chatId: string; files: string[] }
  | { t: 'archive'; chatId: string; archived: boolean }
  /** The chat's session as the agent started or reloaded it; undefined forgets it. */
  | { t: 'session'; chatId: string; session: ChatSession | undefined }
  | { t: 'approval'; chatId: string; level: ApprovalLevel }
  | { t: 'queue'; chatId: string; queue: QueuedMessage[] }
  /** The whole state at once: chats restored after a reload. */
  | { t: 'restore'; state: AppState };

/** Command output kept in the transcript; the agent still gets its full output through ACP. */
export const MAX_COMMAND_OUTPUT = 64 * 1024;
const MAX_IMAGES = 100;
/** Characters of data: URIs kept for the Images view, newest first; the newest image always stays. */
export const MAX_IMAGE_CHARS = 64 * 1024 * 1024;
/** One agent message or thought stops growing here, so a runaway agent can't fill the editor's memory. */
export const MAX_ITEM_TEXT = 512 * 1024;
/** Transcript items kept per chat. Past it the oldest replies and steps go; nothing that waits for you does. */
export const MAX_ITEMS = 2000;

export function reduce(state: AppState, action: Action): AppState {
  switch (action.t) {
    case 'created':
      return { ...state, chats: [...state.chats, action.chat] };
    case 'closed':
      return {
        ...state,
        chats: state.chats.filter((c) => c.id !== action.chatId),
        links: state.links.filter((l) => l.from !== action.chatId && l.to !== action.chatId),
      };
    case 'items':
      return editChat(state, action.chatId, (c) => ({ ...c, items: capItems([...c.items, ...action.items]), lastActivity: action.at ?? c.lastActivity }));
    case 'update':
      if (isSessionUpdate(action.update)) {
        const update = action.update;
        return editChat(state, action.chatId, (c) => ({ ...c, session: applySessionUpdate(c.session, update) }));
      }
      return editChat(state, action.chatId, (c) => ({ ...c, items: capItems(applyUpdate(c.items, action.update, action.at)), lastActivity: action.at ?? c.lastActivity }));
    case 'busy':
      return editChat(state, action.chatId, (c) => ({
        ...c,
        busy: action.busy,
        turns: c.busy && !action.busy ? c.turns + 1 : c.turns,
        lastActivity: action.at ?? c.lastActivity,
      }));
    case 'title':
      return editChat(state, action.chatId, (c) => ({ ...c, title: action.title }));
    case 'permissionAnswered':
      return editItems(state, (i) =>
        i.kind === 'permission' && i.requestId === action.requestId ? { ...i, answer: action.answer, ...(action.auto ? { auto: action.auto } : {}) } : i,
      );
    case 'review':
      return editItems(state, (i) => (i.kind === 'review' && i.reviewId === action.reviewId ? { ...i, state: action.state, ...(action.auto ? { auto: action.auto } : {}) } : i));
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
      return { ...state, images: capImages([...state.images, action.image].slice(-MAX_IMAGES)) };
    case 'link':
      if (state.links.some((l) => l.id === action.link.id)) return state;
      return { ...state, links: [...state.links, action.link] };
    case 'linkPatch':
      return { ...state, links: state.links.map((l) => (l.id === action.linkId ? { ...l, ...action.patch } : l)) };
    case 'unlink':
      return { ...state, links: state.links.filter((l) => l.id !== action.linkId) };
    case 'bridge':
      return editItems(state, (i) => (i.kind === 'bridge' && i.requestId === action.requestId ? { ...i, state: action.state } : i));
    case 'question':
      return editItems(state, (i) => (i.kind === 'question' && i.requestId === action.requestId ? { ...i, state: action.state, ...(action.summary ? { summary: action.summary } : {}) } : i));
    case 'files':
      return editChat(state, action.chatId, (c) => {
        const files = [...new Set([...c.files, ...action.files])];
        return files.length === c.files.length ? c : { ...c, files };
      });
    case 'archive':
      return editChat(state, action.chatId, (c) => ({ ...c, archived: action.archived || undefined }));
    case 'session':
      return editChat(state, action.chatId, (c) => ({ ...c, session: action.session }));
    case 'approval':
      return editChat(state, action.chatId, (c) => ({ ...c, approval: action.level === 'ask' ? undefined : action.level }));
    case 'queue':
      return editChat(state, action.chatId, (c) => ({ ...c, queue: action.queue.length ? action.queue : undefined }));
    case 'restore':
      return action.state;
  }
}

const CUT_OFF = '\n\n[FriedLiver stopped showing this reply here: it is over 512 KB.]';

function capText(text: string): string {
  return text.length <= MAX_ITEM_TEXT ? text : text.slice(0, MAX_ITEM_TEXT) + CUT_OFF;
}

/** Drops the oldest images until the rest fit in MAX_IMAGE_CHARS: a hundred screenshots can be a gigabyte. */
function capImages(images: ImageItem[]): ImageItem[] {
  let chars = 0;
  for (let n = images.length - 1; n >= 0; n--) {
    chars += images[n].src.length;
    if (chars > MAX_IMAGE_CHARS && n < images.length - 1) return images.slice(n + 1);
  }
  return images;
}

const DROPPABLE = new Set<Item['kind']>(['agent', 'thought', 'tool', 'plan', 'notice']);

/** Drops the oldest replies, steps, plans and notices once a chat holds more than MAX_ITEMS. */
function capItems(items: Item[]): Item[] {
  let excess = items.length - MAX_ITEMS;
  if (excess <= 0) return items;
  const drop = new Set<number>();
  for (let n = 0; n < items.length && excess > 0; n++) {
    if (DROPPABLE.has(items[n].kind)) {
      drop.add(n);
      excess--;
    }
  }
  return drop.size ? items.filter((_, n) => !drop.has(n)) : items;
}

function editChat(state: AppState, chatId: string, fn: (c: ChatView) => ChatView): AppState {
  return { ...state, chats: state.chats.map((c) => (c.id === chatId ? fn(c) : c)) };
}

/**
 * Edits the items `fn` changes, in whichever chat holds them. Only those chats
 * and their item lists are copied: command output streams in many times a
 * second, and copying every transcript for each piece kept all three
 * processes busy. Nothing changed, the same state comes back.
 */
function editItems(state: AppState, fn: (i: Item) => Item): AppState {
  let chats: ChatView[] | undefined;
  state.chats.forEach((c, n) => {
    let items: Item[] | undefined;
    for (let k = 0; k < c.items.length; k++) {
      const next = fn(c.items[k]);
      if (next !== c.items[k]) (items ??= c.items.slice())[k] = next;
    }
    if (items) (chats ??= state.chats.slice())[n] = { ...c, items };
  });
  return chats ? { ...state, chats } : state;
}

/** Folds one ACP session update into a transcript. `at`: the host's clock for the update, for how long a tool step ran. */
export function applyUpdate(items: Item[], update: acp.SessionUpdate, at?: number): Item[] {
  const last = items.at(-1);
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      if (update.content.type !== 'text') return items;
      const kind = update.sessionUpdate === 'agent_message_chunk' ? 'agent' : 'thought';
      if (last?.kind === kind) {
        if (last.text.length > MAX_ITEM_TEXT) return items; // Already cut off.
        return [...items.slice(0, -1), { kind, text: capText(last.text + update.content.text) }];
      }
      return [...items, { kind, text: capText(update.content.text) }];
    }
    case 'tool_call': {
      const streamed = streamedOutput(update._meta);
      const out = toolOut(update.content);
      const input = toolInput(update.rawInput);
      const tool: Item = {
        kind: 'tool',
        id: update.toolCallId,
        title: update.title,
        toolKind: update.kind,
        status: update.status,
        locations: (update.locations ?? []).map((l) => l.path),
        ...(out || streamed ? { out: streamed ? appendOutput(out, streamed) : out } : {}),
        ...(input ? { input } : {}),
        ...claudeMeta(update._meta),
      };
      const raw = withRawOutput(tool.out, update.rawOutput);
      if (raw) tool.out = raw;
      const n = items.findIndex((i) => i.kind === 'tool' && i.id === update.toolCallId);
      const prev = n < 0 ? undefined : (items[n] as Extract<Item, { kind: 'tool' }>);
      Object.assign(tool, stepFacts(update, prev, at));
      return n < 0 ? [...items, tool] : items.map((i, k) => (k === n ? tool : i));
    }
    case 'tool_call_update': {
      // Content replaces what the tool showed; output streamed in _meta adds to it.
      const out = update.content ? toolOut(update.content) : undefined;
      const streamed = streamedOutput(update._meta);
      const input = update.rawInput !== undefined ? toolInput(update.rawInput) : undefined;
      return items.map((i) => {
        if (i.kind !== 'tool' || i.id !== update.toolCallId) return i;
        let next = update.content ? out : i.out;
        if (streamed) next = appendOutput(next, streamed);
        return {
          ...i,
          title: update.title ?? i.title,
          toolKind: update.kind ?? i.toolKind,
          status: update.status ?? i.status,
          locations: update.locations ? update.locations.map((l) => l.path) : i.locations,
          out: withRawOutput(next, update.rawOutput),
          input: input ?? i.input,
          ...claudeMeta(update._meta),
          ...stepFacts(update, i, at),
        };
      });
    }
    case 'notice': {
      // An agent's short notice, e.g. "Auto mode unavailable".
      const severity = update.severity === 'error' ? 'error' : 'info';
      const title = typeof update.title === 'string' ? update.title.slice(0, 500) : '';
      if (!title) return items;
      const description = typeof update.description === 'string' ? update.description.slice(0, 2000) : undefined;
      return [...items, { kind: 'notice', tone: severity, text: description ? `${title}: ${description}` : title }];
    }
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
  kind: 'permission' | 'review' | 'command' | 'bridge' | 'question';
  /** requestId, reviewId or commandId. */
  id: string;
  title: string;
}

/** A question, edit, command or tool request that waits for the user's answer. */
export function isWaiting(i: Item): boolean {
  return (
    (i.kind === 'permission' && !i.answer) ||
    (i.kind === 'review' && i.state === 'pending') ||
    (i.kind === 'command' && i.state === 'awaiting') ||
    (i.kind === 'bridge' && i.state === 'awaiting') ||
    (i.kind === 'question' && i.state === 'awaiting')
  );
}

const waitingCache = new WeakMap<Item[], Item[]>();

/**
 * The items of a transcript that wait for the user, in order. Cached per item
 * list: the reducer makes a new list whenever an item changes, so a chat that
 * didn't change isn't scanned again on every update of another one.
 */
export function waitingItems(items: Item[]): Item[] {
  let waiting = waitingCache.get(items);
  if (!waiting) {
    waiting = items.filter(isWaiting);
    waitingCache.set(items, waiting);
  }
  return waiting;
}

/** Everything the agents are waiting on the user for, oldest chat first. */
export function decisions(state: Pick<AppState, 'chats'>): Decision[] {
  const out: Decision[] = [];
  for (const chat of state.chats) {
    for (const i of waitingItems(chat.items)) {
      if (i.kind === 'permission') out.push({ chatId: chat.id, kind: 'permission', id: i.requestId, title: i.title });
      else if (i.kind === 'review') out.push({ chatId: chat.id, kind: 'review', id: i.reviewId, title: `Review edit to ${basename(i.path)}` });
      else if (i.kind === 'command') out.push({ chatId: chat.id, kind: 'command', id: i.commandId, title: `Run ${shortCommand(i.commandLine)}` });
      else if (i.kind === 'bridge') out.push({ chatId: chat.id, kind: 'bridge', id: i.requestId, title: bridgeTitle(state, chat, i) });
      else if (i.kind === 'question') out.push({ chatId: chat.id, kind: 'question', id: i.requestId, title: `Answer: ${i.message.slice(0, 80)}` });
    }
  }
  return out;
}

/** "Claude 2 wants to ask Gemini", "Claude 2 wants to read Codex 3". */
export function bridgeTitle(state: Pick<AppState, 'chats'>, chat: ChatView, item: BridgeItem): string {
  const target = 'agent' in item.target ? AGENT_FACES[item.target.agent].name : (state.chats.find((c) => c.id === (item.target as { chatId: string }).chatId)?.label ?? 'another chat');
  const verb = item.tool === 'ask_agent' ? 'ask' : item.tool === 'send_to_chat' ? 'message' : 'read';
  return `${chat.label} wants to ${verb} ${target}`;
}

/** Links that start or end at a chat. */
export function linksOf(state: Pick<AppState, 'links'>, chatId: string): ChatLink[] {
  return state.links.filter((l) => l.from === chatId || l.to === chatId);
}

export interface FileConflict {
  /** Relative to each chat's cwd. */
  file: string;
  chats: string[];
}

/**
 * Files that more than one open chat proposed or made changes to. Paths are
 * compared relative to each chat's folder, so two worktrees editing the same
 * file count too: their branches will clash when merged.
 */
export function fileConflicts(state: Pick<AppState, 'chats'>): FileConflict[] {
  const byFile = new Map<string, string[]>();
  for (const chat of state.chats) {
    if (chat.archived || chat.merged) continue;
    for (const f of chat.files) byFile.set(f, [...(byFile.get(f) ?? []), chat.id]);
  }
  return [...byFile].filter(([, chats]) => chats.length > 1).map(([file, chats]) => ({ file, chats }));
}

/** Names people type after @ to reach an agent. */
export const MENTIONS: Record<string, AgentKey> = {
  claude: 'claude',
  codex: 'codex',
  gpt: 'codex',
  chatgpt: 'codex',
  openai: 'codex',
  gemini: 'gemini',
  google: 'gemini',
  demo: 'demo',
};

/** "@gemini review this" → ask Gemini "review this". Only a mention at the very start counts. */
export function parseMention(text: string): { agent: AgentKey; text: string } | null {
  const m = text.match(/^\s*@([a-z]+)\b[\s,:]*([\s\S]*)$/i);
  const agent = m && MENTIONS[m[1].toLowerCase()];
  return agent && m[2].trim() ? { agent, text: m[2].trim() } : null;
}

/** A chat's text from the agent's last turn: its message chunks after the last message it was given. */
/** A message the chat's agent was given: one the user typed, or one that came over a link. */
function givenToAgent(i: Item): boolean {
  return i.kind === 'user' || (i.kind === 'link' && (i.role === 'piped-in' || i.role === 'consulted' || i.role === 'handoff-from'));
}

export function lastReply(chat: ChatView): string {
  const given = chat.items.map(givenToAgent);
  return chat.items
    .slice(given.lastIndexOf(true) + 1)
    .flatMap((i) => (i.kind === 'agent' ? [i.text] : []))
    .join('\n\n')
    .trim();
}

export function chatStatus(chat: ChatView): ChatStatus {
  if (waitingItems(chat.items).length > 0) return 'needs-you';
  if (chat.busy) return 'working';
  const last = chat.items.at(-1);
  if (last?.kind === 'notice' && last.tone === 'error') return 'error';
  // A consulted, piped or handed-off chat may never get a message from the user.
  return chat.turns > 0 || chat.items.some(givenToAgent) ? 'done' : 'idle';
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
  const waiting = decisions({ chats: [chat] })[0];
  if (waiting) {
    const item = chat.items.find(
      (i) =>
        (i.kind === 'review' && i.reviewId === waiting.id) ||
        (i.kind === 'command' && i.commandId === waiting.id) ||
        (i.kind === 'permission' && i.requestId === waiting.id),
    );
    if (item?.kind === 'review') return { text: `Edit to review: ${basename(item.path)} +${item.added} −${item.removed}`, decision: waiting };
    if (item?.kind === 'command') return { text: 'Wants to run a command', code: item.commandLine, decision: waiting };
    if (item?.kind === 'permission') {
      const files = item.detail?.files?.map((f) => basename(f.path)).join(', ');
      return { text: `Asks: ${item.title}`, code: item.detail?.command?.line ?? files, decision: waiting };
    }
    if (waiting.kind === 'bridge') return { text: waiting.title, decision: waiting };
    if (waiting.kind === 'question') return { text: `Asks you: ${waiting.title.slice(8)}`, decision: waiting };
  }
  if (!chat.busy && chat.session?.starting) return { text: `Starting ${AGENT_FACES[chat.agent].name}…` };
  const status = chatStatus(chat);
  if (status === 'working') {
    const plan = chat.items.findLast((i) => i.kind === 'plan');
    if (plan?.kind === 'plan' && plan.entries.length) {
      const at = plan.entries.findIndex((e) => e.status !== 'completed');
      if (at >= 0) return { text: `Step ${at + 1} of ${plan.entries.length}: ${plan.entries[at].content}` };
    }
    const tool = chat.items.findLast((i) => i.kind === 'tool');
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
