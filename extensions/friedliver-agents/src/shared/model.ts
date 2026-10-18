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
  /** The chat and tool step it came in, and when (the host's clock); optional, older states lack them. */
  chatId?: string;
  stepId?: string;
  at?: number;
}

/** What a button on a notice does; plain data, so it can cross into a webview. */
export type NoticeAction =
  | { label: string; do: 'retry' }
  | { label: string; do: 'signIn'; agent: AgentKey; methodId: string }
  | { label: string; do: 'apiKey'; agent: AgentKey }
  /** The host looks the install command up from the agent; a webview never supplies it. */
  | { label: string; do: 'install'; agent: AgentKey }
  /** Opens Agents & Accounts on the agent's card. */
  | { label: string; do: 'accounts'; agent: AgentKey };

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
  /** When it arrived (the host's clock); waiting items get it, for the Decision Inbox's ages. */
  at?: number;
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
  at?: number;
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

/** How long a request through the FriedLiver tools waits for you before it is refused on its own. */
export const BRIDGE_TIMEOUT_MS = 10 * 60_000;

/** Chats an agent may start through the FriedLiver tools, counted from a chat the user started. */
export const MAX_LINK_DEPTH = 2;

/** What an agent asked to do with another chat or agent through the FriedLiver tools. */
export type BridgeTool = 'ask_agent' | 'send_to_chat' | 'read_chat' | 'remember' | 'browser_open' | 'browser_click' | 'browser_type' | 'browser_back' | 'browser_reload';

export interface BridgeItem {
  kind: 'bridge';
  requestId: string;
  tool: BridgeTool;
  /** Another agent (a new consultation), an existing chat, or FriedLiver's browser. */
  target: { agent: AgentKey } | { chatId: string } | { browser: true } | { memory: true };
  /** The question or message; empty for read_chat. For the browser: the URL, the element, or what to type. */
  text: string;
  state: 'awaiting' | 'allowed' | 'denied';
  /** What "Always allow" would remember: the website's origin, or "in every chat" for an agent tool. Absent: not offered. */
  always?: string;
  /** Why it went ahead without asking: a remembered rule. */
  auto?: string;
  at?: number;
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
  /** `checkpoint` (optional): the turn this message started, when its files were snapshotted ("Rewind to here"). */
  | { kind: 'user'; text: string; images: string[]; refs?: CodeRef[]; at?: number; checkpoint?: string }
  /** `at` (optional, on user and agent messages): when it was sent or began, by the host's clock. */
  | { kind: 'agent'; text: string; at?: number }
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
  | { kind: 'permission'; requestId: string; toolCallId?: string; title: string; options: PermissionOption[]; answer?: string; toolKind?: string; detail?: PermissionDetail; auto?: string; at?: number }
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
  at?: number;
}

export interface ChatView {
  id: string;
  /** A read-only chat (inline edit): no tools, no file access, every request refused up front. */
  readOnly?: true;
  agent: AgentKey;
  /** Agent name, numbered when several chats use the same agent. */
  label: string;
  /** What the chat is about: the agent's session title, or your latest real request, shortened. */
  title: string;
  /** You renamed it: the title no longer follows the conversation. */
  titlePinned?: boolean;
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
  /** Starred: kept at the top of the chat list. */
  starred?: boolean;
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
  /** `pinned`: the user named it, and automatic titles stop. */
  | { t: 'title'; chatId: string; title: string; pinned?: boolean }
  | { t: 'permissionAnswered'; requestId: string; answer: string; auto?: string }
  | { t: 'review'; reviewId: string; state: ReviewItem['state']; auto?: string }
  | { t: 'command'; commandId: string; patch: Partial<Omit<CommandItem, 'kind' | 'commandId' | 'output'>> }
  | { t: 'commandOutput'; commandId: string; data: string }
  | { t: 'changes'; chatId: string; turnId: string; files: string[] }
  | { t: 'undone'; chatId: string; turnId: string }
  /** The latest message without one started turn `turnId`, which has a checkpoint. */
  | { t: 'checkpoint'; chatId: string; turnId: string }
  /** Checkpoints gone (pruned, or the chat put away): their messages lose "Rewind to here". */
  | { t: 'checkpointsGone'; chatId: string; turnIds?: string[] }
  /** Conversation rewound: the message that started `turnId` and everything after it go. */
  | { t: 'rewound'; chatId: string; turnId: string }
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
  | { t: 'star'; chatId: string; starred: boolean }
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

/** Items that keep when they arrived: your messages, and everything that waits for you. */
const STAMPED = new Set<Item['kind']>(['user', 'permission', 'review', 'command', 'bridge', 'question']);

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
      return editChat(state, action.chatId, (c) => ({
        ...c,
        items: capItems([...c.items, ...action.items.map((i) => (STAMPED.has(i.kind) && !('at' in i && i.at !== undefined) && action.at !== undefined ? ({ ...i, at: action.at } as Item) : i))]),
        lastActivity: action.at ?? c.lastActivity,
      }));
    case 'update':
      if (action.update.sessionUpdate === 'session_info_update') {
        const title = action.update.title?.trim();
        return title ? reduce(state, { t: 'title', chatId: action.chatId, title: titleFrom(title) }) : state;
      }
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
    case 'star':
      return editChat(state, action.chatId, (c) => ({ ...c, starred: action.starred || undefined }));
    case 'title':
      return editChat(state, action.chatId, (c) => (c.titlePinned && !action.pinned ? c : { ...c, title: action.title, ...(action.pinned ? { titlePinned: true } : {}) }));
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
    case 'checkpoint':
      return editChat(state, action.chatId, (c) => {
        const at = c.items.findLastIndex((i) => i.kind === 'user');
        const msg = c.items[at];
        // Only a message the agent hasn't answered yet: a consultation's turn has none of its own.
        if (msg?.kind !== 'user' || msg.checkpoint || c.items.slice(at).some((i) => i.kind === 'agent' || i.kind === 'changes')) return c;
        return { ...c, items: c.items.map((i, n) => (n === at ? { ...msg, checkpoint: action.turnId } : i)) };
      });
    case 'checkpointsGone':
      return editChat(state, action.chatId, (c) => ({
        ...c,
        items: c.items.map((i) => (i.kind === 'user' && i.checkpoint && (!action.turnIds || action.turnIds.includes(i.checkpoint)) ? { ...i, checkpoint: undefined } : i)),
      }));
    case 'rewound':
      return editChat(state, action.chatId, (c) => {
        const at = c.items.findIndex((i) => i.kind === 'user' && i.checkpoint === action.turnId);
        if (at < 0) return c;
        const items = c.items.slice(0, at);
        const gone = c.items.slice(at).reduce((n, i) => n + (i.kind === 'changes' && !i.undone ? i.files.length : 0), 0);
        return { ...c, items, changedFiles: Math.max(0, c.changedFiles - gone), turns: Math.max(0, c.turns - c.items.slice(at).filter((i) => i.kind === 'user').length) };
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
      // A subagent's own words (Claude's Task/Agent) belong to its card, which shows its result, not to this chat's reply.
      if (claudeMeta(update._meta).parent) return items;
      const kind = update.sessionUpdate === 'agent_message_chunk' ? 'agent' : 'thought';
      if (last?.kind === kind) {
        if (last.text.length > MAX_ITEM_TEXT) return items; // Already cut off.
        return [...items.slice(0, -1), { ...last, text: capText(last.text + update.content.text) }];
      }
      return [...items, { kind, text: capText(update.content.text), ...(kind === 'agent' && at !== undefined ? { at } : {}) }];
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

const ACK_WORDS = new Set(
  'hi hii hey hello yo sup thanks thank thx you ok okay k yes yep yeah yup no nope sure go ahead merge it do that this now please pls continue proceed sounds good great cool nice lgtm done fine alright right and then ship push perfect awesome'.split(' '),
);
const SHELL_LINE = /^(\$ |(npm|npx|pnpm|yarn|bun|git|cd|ls|brew|pip3?|curl|wget|sudo|node|python3?|docker|rm|mkdir|cat|claude|cargo|chmod|export|gh)\s)/;
const FILLER = /^((can|could|would|will) you\s+|please\s+|pls\s+|i (want|need) you to\s+|i('d| would) like you to\s+|let'?s\s+|now\s+|also\s+|and\s+)+/i;
const ARTICLES = new Set(['the', 'a', 'an']);
const TOPIC_WORDS = 6;

/**
 * A short topic for the chat from one of your messages: its first clause that
 * asks for something, at most six words, in sentence case. Null when the
 * message is a greeting, an acknowledgement ("ok", "go", "merge"), a slash
 * command or a shell command, so the title stays on the last real request.
 */
export function topicTitle(text: string): string | null {
  const t = text.trim().replace(/^@[a-z]+[\s,:]*/i, '');
  if (!t || t.startsWith('/') || SHELL_LINE.test(t)) return null;
  for (const clause of t.split(/[.!?\n,;:]+/)) {
    const words = clause.trim().replace(FILLER, '').trim().split(/\s+/).filter(Boolean);
    if (words.length < 3 || words.every((w) => ACK_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, '')))) continue;
    const kept = words.filter((w) => !ARTICLES.has(w.toLowerCase())).slice(0, TOPIC_WORDS);
    const title = kept.join(' ').replace(/[\s\p{P}]+$/u, '');
    return title.charAt(0).toUpperCase() + title.slice(1);
  }
  return null;
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
  return state.chats.flatMap((chat) => waitingItems(chat.items).flatMap((i) => decisionOf(state, chat, i) ?? []));
}

/** What an item asks of the user, as a decision: its id and a title, waiting or not; undefined for an item that never asks. */
export function decisionOf(state: Pick<AppState, 'chats'>, chat: ChatView, i: Item): Decision | undefined {
  if (i.kind === 'permission') return { chatId: chat.id, kind: 'permission', id: i.requestId, title: i.title };
  if (i.kind === 'review') return { chatId: chat.id, kind: 'review', id: i.reviewId, title: `Review edit to ${basename(i.path)}` };
  if (i.kind === 'command') return { chatId: chat.id, kind: 'command', id: i.commandId, title: `Run ${shortCommand(i.commandLine)}` };
  if (i.kind === 'bridge') return { chatId: chat.id, kind: 'bridge', id: i.requestId, title: bridgeTitle(state, chat, i) };
  if (i.kind === 'question') return { chatId: chat.id, kind: 'question', id: i.requestId, title: `Answer: ${i.message.slice(0, 80)}` };
  return undefined;
}

/** "Claude 2 wants to ask Gemini", "Claude 2 wants to read Codex 3". */
export const BROWSER_VERBS: Partial<Record<BridgeTool, string>> = {
  browser_open: 'open a page',
  browser_click: 'click',
  browser_type: 'type',
  browser_back: 'go back',
  browser_reload: 'reload the page',
};

/** A chat's topic in a sentence: quoted, cut to a phrase. */
export const topic = (title: string): string => `“${title.length > 40 ? `${title.slice(0, 39).trimEnd()}…` : title}”`;

/**
 * What an agent asks to do through the FriedLiver tools, chats named by their topic: across chats
 * ("“Fix formatCents” wants to message “Add tests”"), or on the chat's own card with `self` ("Wants to message “Add tests”").
 */
export function bridgeTitle(state: Pick<AppState, 'chats'>, chat: ChatView, item: BridgeItem, self = false): string {
  const wants = self ? 'Wants to' : `${topic(chat.title)} wants to`;
  if ('memory' in item.target) return `${wants} remember a fact for every agent`;
  if ('browser' in item.target) return `${wants} ${BROWSER_VERBS[item.tool] ?? 'use'} in the browser`;
  const other = 'chatId' in item.target ? state.chats.find((c) => c.id === (item.target as { chatId: string }).chatId) : undefined;
  const target = 'agent' in item.target ? AGENT_FACES[item.target.agent].name : other ? topic(other.title) : 'another chat';
  const verb = item.tool === 'ask_agent' ? 'ask' : item.tool === 'send_to_chat' ? 'message' : 'read';
  return `${wants} ${verb} ${target}`;
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
      const line = item.detail?.command?.line;
      // A permission titled with its own command says it once.
      if (line && line.trim() === item.title.trim()) return { text: 'Asks to run', code: line, decision: waiting };
      return { text: `Asks: ${item.title}`, code: line ?? files, decision: waiting };
    }
    if (waiting.kind === 'bridge') {
      const bridge = chat.items.find((i): i is BridgeItem => i.kind === 'bridge' && i.requestId === waiting.id);
      return { text: bridge ? bridgeTitle({ chats: [chat] }, chat, bridge, true) : waiting.title, decision: waiting };
    }
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
