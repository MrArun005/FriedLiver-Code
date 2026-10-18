// Pure helpers for the agent views: search, sorting, badges, the agent map's
// layout and the @-mention picker. No DOM here, so all of it is unit tested.
import {
  AGENT_KEYS,
  age,
  boardColumn,
  bridgeTitle,
  chatStatus,
  decisions,
  fileConflicts,
  stateLine,
  type AgentKey,
  type AppState,
  type BoardColumn,
  type BridgeItem,
  type ChatLink,
  type ChatStatus,
  type ChatView,
  type Decision,
  type FileConflict,
  type Item,
  type LinkKind,
  type StateLine,
  MENTIONS,
} from './model';
import type { ClaudeSession, WebviewMessage } from './messages';
import type { SlashCommand } from './session';

import { agentName, chatTip } from './names';
export { agentName };

/** Shortens to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Plain one-paragraph text from markdown, for excerpts. */
export function excerpt(text: string, max: number): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_#>]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  return clip(plain, max);
}

/** "3s ago"; nothing yet reads "—". */
export function ago(at: number, now: number): string {
  return at > 0 ? `${age(at, now)} ago` : '—';
}

/**
 * chatStatus, except that a chat another chat started (a consultation, a
 * hand-off, a pipe's target) has no message of yours, so chatStatus reads it as
 * "not started" even after it answered: it is done once the agent has replied.
 */
export function statusOf(chat: ChatView): ChatStatus {
  const status = chatStatus(chat);
  return status === 'idle' && chat.items.some((i) => i.kind === 'agent') ? 'done' : status;
}

/** A subagent a chat launched (Claude's Task/Agent tool): a card under its chat, not a chat of its own. */
export interface Subagent {
  /** The tool call's id, to scroll the chat to. */
  id: string;
  title: string;
  /** `quiet`: no completion evidence, but nothing written for a long while (Claude Code sessions from outside FriedLiver). */
  state: 'working' | 'done' | 'failed' | 'quiet';
  /** Tool calls the subagent made, when the agent says which call they ran in. */
  tools: number;
  /** Its latest step's title. */
  last?: string;
  /** Its agent type and model, when its transcript says (Claude Code sessions from outside FriedLiver). */
  about?: string;
  /** Why it reads Quiet, e.g. "No activity for 32m", for its tooltip. */
  note?: string;
  /** When it started running, and how long it took once it ended. */
  startedAt?: number;
  ms?: number;
}

const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

/** The subagents in a chat's transcript; one still pending in a chat that stopped reads done. */
export function subagents(chat: ChatView): Subagent[] {
  const tools = chat.items.filter((i) => i.kind === 'tool');
  return tools
    .filter((t) => t.tool && SUBAGENT_TOOLS.has(t.tool))
    .map((t) => {
      const own = tools.filter((i) => i.parent === t.id);
      return {
        id: t.id,
        title: t.title,
        state: t.status === 'failed' ? 'failed' : chat.busy && (t.status === 'pending' || t.status === 'in_progress' || !t.status) ? 'working' : 'done',
        tools: own.length,
        ...(own.length ? { last: own.at(-1)!.title } : {}),
        ...(t.startedAt !== undefined ? { startedAt: t.startedAt } : {}),
        ...(t.ms !== undefined ? { ms: t.ms } : {}),
      };
    });
}

/**
 * What every surface lists of a chat's subagents: the running and failed ones, then the done ones, which
 * fold into one "N done · show" row (a node on the map) until opened. A session can run dozens.
 */
export function foldSubs(subs: Subagent[]): { live: Subagent[]; done: Subagent[] } {
  return { live: subs.filter((s) => s.state !== 'done'), done: subs.filter((s) => s.state === 'done') };
}

export const isSubagentCall = (t: Item): boolean => t.kind === 'tool' && !!t.tool && SUBAGENT_TOOLS.has(t.tool);

/** What a subagent answered: the text of its call's result. */
export function subagentAnswer(t: ToolItem): string | undefined {
  const text = (t.out ?? []).flatMap((o) => (o.t === 'text' ? [o.text] : [])).join('\n\n').trim();
  return text || undefined;
}

// ---- Claude Code sessions from outside FriedLiver ----

const CLAUDE_WORKING_MS = 2 * 60_000;

/** Working while its transcript changed in the last two minutes; Done otherwise. */
export function claudeColumn(s: ClaudeSession, now: number): 'working' | 'done' {
  return now - s.lastActivity < CLAUDE_WORKING_MS ? 'working' : 'done';
}

const SUB_FRESH_MS = 60_000;
// ponytail: a tool call that writes nothing for 30 min reads Quiet; raise it if long silent builds show up wrong.
const SUB_STALE_MS = 30 * 60_000;

const idleFor = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

/**
 * Its subagents as the Manager draws a chat's. A settled one is Done or Problem. An unsettled one with its own transcript
 * works while that changed in the last minute, or while a tool call is still in flight (for up to 30 minutes). One with no
 * transcript works while the session does. Otherwise it is Quiet: silent, but nothing says it finished.
 */
export function claudeSubagents(s: ClaudeSession, now: number): Subagent[] {
  const sessionWorking = claudeColumn(s, now) === 'working';
  return s.subagents.map((a) => {
    const quiet = a.lastActivity === undefined ? undefined : now - a.lastActivity;
    const working = !a.end && (quiet === undefined ? sessionWorking : quiet < SUB_FRESH_MS || (!a.idle && quiet < SUB_STALE_MS));
    // Done and Problem only on evidence: silence alone is Quiet.
    const state = working ? 'working' : a.end === 'failed' ? 'failed' : a.end === 'done' ? 'done' : 'quiet';
    return {
      id: a.id,
      title: a.title,
      state,
      ...(state === 'quiet' ? { note: `No activity for ${idleFor(quiet ?? now - s.lastActivity)}` } : {}),
      tools: a.tools ?? 0,
      ...(a.last ? { last: a.last } : {}),
      ...(a.agentType || a.model ? { about: [a.agentType, a.model].filter(Boolean).join(' · ') } : {}),
      ...(a.startedAt !== undefined ? { startedAt: a.startedAt } : {}),
      ...(!working && a.startedAt !== undefined && a.lastActivity !== undefined ? { ms: Math.max(0, a.lastActivity - a.startedAt) } : {}),
    };
  });
}

/** What the host knows of FriedLiver's chats: their views, and the agent session each continues. */
interface ChatSessions {
  state: { chats: ChatView[] };
  chats: Record<string, { sessionId?: string }>;
}

/** The FriedLiver chat that continues this agent session, if any. */
export function chatOfSession(saved: ChatSessions, sessionId: string): string | undefined {
  return Object.entries(saved.chats).find(([, c]) => c.sessionId === sessionId)?.[0];
}

/**
 * Ties each outside session to the FriedLiver chat that only resumed it: no turn run, none running. The reader lists
 * such a session only while something else (the Claude Code extension, the CLI) wrote to it last, so the chat holds none
 * of its work. The newest such chat wins; a chat that ran a turn keeps its own card.
 */
export function linkResumeChats(sessions: ClaudeSession[], saved: ChatSessions): ClaudeSession[] {
  const idle = new Map<string, string>();
  for (const c of saved.state.chats) {
    const sid = saved.chats[c.id]?.sessionId;
    if (sid && c.turns === 0 && !c.busy) idle.set(sid, c.id);
  }
  return sessions.map((s) => (idle.has(s.id) ? { ...s, chatId: idle.get(s.id) } : s));
}

/** The chats with their own card: a chat tied to an outside session shows in that session's card instead. Never removes one. */
export function withoutLinkedChats(chats: ChatView[], sessions: ClaudeSession[]): ChatView[] {
  const linked = new Set(sessions.flatMap((s) => (s.chatId ? [s.chatId] : [])));
  return linked.size ? chats.filter((c) => !linked.has(c.id)) : chats;
}

/** Every word of the query must appear in the title or "claude code". */
export function filterClaudeSessions(list: ClaudeSession[], query: string): ClaudeSession[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((s) => words.every((w) => `${s.title} claude code`.toLowerCase().includes(w)));
}

/** Chats on the board and in the tab strip: archived ones live in History. */
export function openChats(chats: ChatView[]): ChatView[] {
  return chats.filter((c) => !c.archived);
}

// ---- Search and sorting ----

/** Words people use for an agent besides its name. */
const AGENT_WORDS: Record<AgentKey, string> = {
  claude: 'claude',
  codex: 'codex gpt chatgpt openai',
  gemini: 'gemini google',
  demo: 'demo',
};

/** Every word of the query must appear in the title, agent, label or branch. */
export function matchesQuery(chat: ChatView, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [chat.title, chat.label, AGENT_WORDS[chat.agent], chat.branch ?? ''].join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function filterChats(chats: ChatView[], query: string): ChatView[] {
  return chats.filter((c) => matchesQuery(c, query));
}

export type SortKey = 'status' | 'agent' | 'task' | 'activity' | 'files' | 'age';
export interface Sort {
  key: SortKey;
  dir: 'asc' | 'desc';
}

/** STATUS_ORDER: waiting on you, working, failed, not started, done. */
const STATUS_RANK: Record<ChatStatus, number> = { 'needs-you': 0, working: 1, error: 2, idle: 3, done: 4 };
const AGENT_RANK = Object.fromEntries(AGENT_KEYS.map((a, i) => [a, i])) as Record<AgentKey, number>;
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** The direction a header click starts with: the useful end first. */
export function defaultDir(key: SortKey): Sort['dir'] {
  return key === 'files' ? 'desc' : 'asc';
}

/**
 * Sorted copy. Activity and age sort like the "3m" they show: ascending is the
 * most recent first. Ties fall back to the most recent activity, then the id,
 * so the order never flickers.
 */
export function sortChats(chats: ChatView[], sort: Sort): ChatView[] {
  const by: Record<SortKey, (a: ChatView, b: ChatView) => number> = {
    status: (a, b) => STATUS_RANK[statusOf(a)] - STATUS_RANK[statusOf(b)],
    agent: (a, b) => AGENT_RANK[a.agent] - AGENT_RANK[b.agent] || collator.compare(a.label, b.label),
    task: (a, b) => collator.compare(a.title, b.title),
    activity: (a, b) => b.lastActivity - a.lastActivity,
    files: (a, b) => a.files.length - b.files.length,
    age: (a, b) => b.createdAt - a.createdAt,
  };
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...chats].sort((a, b) => sign * by[sort.key](a, b) || b.lastActivity - a.lastActivity || collator.compare(a.id, b.id));
}

/** An order shown on screen: chat ids, the sort that made it, and when it last changed. */
export interface Settled {
  ids: string[];
  sort: string;
  at: number;
}

/**
 * The order to show for `next`, which moves at most every `ms`. Sorted by
 * activity, fifteen streaming agents reorder the board and the list many
 * times a second: cards jump away from the pointer, and every move lays out
 * and paints the whole column again. A chat added or gone, or another sort,
 * shows at once; so does a reorder after a quiet spell. `pending` means a
 * newer order waits, due at `order.at + ms`.
 */
export function settleOrder(prev: Settled | undefined, next: string[], sort: string, now: number, ms: number): { order: Settled; pending: boolean } {
  if (prev && prev.sort === sort && prev.ids.length === next.length && prev.ids.every((id, n) => id === next[n])) return { order: prev, pending: false };
  const sameSet = !!prev && prev.sort === sort && prev.ids.length === next.length && new Set([...prev.ids, ...next]).size === next.length;
  if (sameSet && now - prev.at < ms) return { order: prev, pending: true };
  return { order: { ids: next, sort, at: now }, pending: false };
}

export interface Counts {
  needsYou: number;
  working: number;
  done: number;
  archived: number;
  decisions: number;
}

export function counts(state: Pick<AppState, 'chats'>): Counts {
  const out: Counts = { needsYou: 0, working: 0, done: 0, archived: 0, decisions: 0 };
  for (const chat of state.chats) {
    if (chat.archived) {
      out.archived++;
      continue;
    }
    const col = boardColumn(statusOf(chat));
    if (col === 'needs-you') out.needsYou++;
    else if (col === 'working') out.working++;
    else out.done++;
  }
  out.decisions = decisions({ chats: openChats(state.chats) }).length;
  return out;
}

/** The decision after `current` (by id), wrapping around; the first when none is current. */
export function nextDecision(list: Decision[], current?: string): Decision | undefined {
  if (!list.length) return undefined;
  const at = list.findIndex((d) => d.id === current);
  return list[(at + 1) % list.length];
}

// ---- Cards ----

export interface CardLine extends StateLine {
  bridge?: BridgeItem;
  /** Decisions waiting in this chat, the shown one included. */
  waiting: number;
}

/** stateLine, plus an agent's request to reach another chat, which it doesn't know. */
export function cardLine(state: Pick<AppState, 'chats'>, chat: ChatView): CardLine {
  const all = decisions({ chats: [chat] });
  const first = all[0];
  if (first?.kind === 'bridge') {
    const item = chat.items.find((i): i is BridgeItem => i.kind === 'bridge' && i.requestId === first.id);
    if (item) return { text: bridgeTitle(state, chat, item, true), code: item.text || undefined, decision: first, bridge: item, waiting: all.length };
  }
  const line = stateLine(chat);
  if (line.text === 'Not started' && statusOf(chat) === 'done') return { text: 'Done', waiting: all.length };
  return { ...line, waiting: all.length };
}

export type StepState = 'done' | 'working' | 'next';

export interface Progress {
  steps: StepState[];
  done: number;
  /** 1-based step in progress; 0 when all are done. */
  current: number;
  currentText?: string;
}

/** The latest plan as a segmented bar. */
export function planProgress(chat: ChatView): Progress | null {
  const plan = chat.items.findLast((i) => i.kind === 'plan');
  if (plan?.kind !== 'plan' || !plan.entries.length) return null;
  const at = plan.entries.findIndex((e) => e.status !== 'completed');
  return {
    steps: plan.entries.map((e, i) => (e.status === 'completed' ? 'done' : i === at ? 'working' : 'next')),
    done: plan.entries.filter((e) => e.status === 'completed').length,
    current: at + 1,
    currentText: at >= 0 ? plan.entries[at].content : undefined,
  };
}

export interface Badge {
  kind: 'origin' | LinkKind | 'group';
  text: string;
  /** The other chat, to open. */
  chatId?: string;
  /** Pipes can be stopped from the badge. */
  linkId?: string;
  /** The other chat's label and topic, for the tooltip: the badge names it by topic only. */
  tip?: string;
  group?: string;
}

/** "from Fix formatCents", "Asking Gemini: Is the minus right?", "pipes to Add CSV export", "1 of 3 · compare": other chats by their topic. */
export function linkBadges(state: Pick<AppState, 'chats' | 'links'>, chat: ChatView): Badge[] {
  const byId = new Map(state.chats.map((c) => [c.id, c]));
  const out: Badge[] = [];
  const to = (other: ChatView, text: string, extra: Partial<Badge> & Pick<Badge, 'kind'>): Badge => ({ text, chatId: other.id, tip: chatTip(other), ...extra });
  const parent = chat.origin && byId.get(chat.origin.chatId);
  if (chat.origin && parent) out.push(to(parent, `${chat.origin.kind === 'handoff' ? 'from' : 'asked by'} ${parent.title}`, { kind: 'origin' }));
  for (const l of state.links) {
    if (l.from === chat.id) {
      const other = byId.get(l.to);
      if (!other) continue;
      // A consult's topic is the question itself: say who was asked, then the question.
      if (l.kind === 'consult') out.push(to(other, `${other.busy ? 'Asking' : 'Asked'} ${agentName(other.agent)}: ${other.title}`, { kind: 'consult' }));
      else if (l.kind === 'handoff') out.push(to(other, `handed to ${other.title}`, { kind: 'handoff' }));
      else out.push(to(other, l.active ? `pipes to ${other.title}` : `pipe to ${other.title} paused`, { kind: 'pipe', linkId: l.id }));
    } else if (l.to === chat.id && l.from !== chat.origin?.chatId) {
      const other = byId.get(l.from);
      if (!other) continue;
      if (l.kind === 'pipe') out.push(to(other, `piped from ${other.title}`, { kind: 'pipe', linkId: l.id }));
      else out.push(to(other, `${l.kind === 'handoff' ? 'from' : 'asked by'} ${other.title}`, { kind: 'origin' }));
    }
  }
  if (chat.group) {
    const members = groupMembers(state.chats, chat.group);
    const at = members.findIndex((c) => c.id === chat.id);
    if (members.length > 1 && at >= 0) out.push({ kind: 'group', text: `${at + 1} of ${members.length} · compare`, group: chat.group });
  }
  return out.filter((b, i) => out.findIndex((x) => x.text === b.text) === i);
}

export interface ChatConflict {
  file: string;
  others: ChatView[];
}

/** Files this chat changed that other open chats changed too. `all` is fileConflicts(state), when already at hand. */
export function conflictsOf(state: Pick<AppState, 'chats'>, chatId: string, all: FileConflict[] = fileConflicts(state)): ChatConflict[] {
  const byId = new Map(state.chats.map((c) => [c.id, c]));
  return all
    .filter((f) => f.chats.includes(chatId))
    .map((f) => ({ file: f.file, others: f.chats.filter((id) => id !== chatId).flatMap((id) => byId.get(id) ?? []) }));
}

/** "also in Add tests for formatCents: src/format.ts": the other chats by their topic. */
export function conflictText(c: ChatConflict): string {
  return `also in ${c.others.map((o) => o.title).join(', ')}: ${c.file}`;
}

/** A path relative to the chat's folder, with forward slashes, as `files` keeps them. */
export function relativePath(cwd: string, p: string): string {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const dir = norm(cwd);
  const file = norm(p);
  return dir && file.toLowerCase().startsWith(`${dir.toLowerCase()}/`) ? file.slice(dir.length + 1) : file;
}

/** What a task card shows, worked out once per update for every card. */
export interface CardModel {
  status: ChatStatus;
  line: CardLine;
  progress: Progress | null;
  badges: Badge[];
  conflicts: ChatConflict[];
  /** "3m": how long ago the task started. */
  age: string;
  /** Everything above and the chat's own fields the card shows, as one string: cards with equal keys look the same. */
  key: string;
}

/** `conflicts` is fileConflicts(state), worked out once for all the cards. */
export function cardModel(state: Pick<AppState, 'chats' | 'links'>, chat: ChatView, now: number, conflicts: FileConflict[] = fileConflicts(state)): CardModel {
  const status = statusOf(chat);
  const line = cardLine(state, chat);
  const progress = status === 'working' || status === 'needs-you' ? planProgress(chat) : null;
  const badges = linkBadges(state, chat);
  const shared = conflictsOf(state, chat.id, conflicts);
  const started = age(chat.createdAt, now);
  const key = JSON.stringify([
    chat.id,
    chat.agent,
    chat.label,
    chat.title,
    chat.cwd,
    chat.branch,
    chat.merged,
    chat.busy,
    chat.files.length,
    chat.changedFiles,
    chat.turns,
    status,
    started,
    line.text,
    line.code,
    line.decision?.kind,
    line.decision?.id,
    line.bridge?.requestId,
    line.waiting,
    progress,
    badges,
    shared.map((c) => [c.file, c.others.map((o) => [o.id, o.label])]),
  ]);
  return { status, line, progress, badges, conflicts: shared, age: started, key };
}

// ---- Fan-out groups ----

export function groupMembers(chats: ChatView[], group: string): ChatView[] {
  return chats
    .filter((c) => c.group === group && !c.archived)
    .sort((a, b) => a.createdAt - b.createdAt || AGENT_RANK[a.agent] - AGENT_RANK[b.agent] || collator.compare(a.label, b.label));
}

export interface FanoutGroup {
  id: string;
  title: string;
  chats: ChatView[];
}

/** The same task on several agents, still open, oldest first. */
export function fanoutGroups(state: Pick<AppState, 'chats'>): FanoutGroup[] {
  const ids = [...new Set(state.chats.flatMap((c) => (c.group && !c.archived ? [c.group] : [])))];
  return ids
    .map((id) => {
      const chats = groupMembers(state.chats, id);
      return { id, title: chats[0]?.title ?? '', chats };
    })
    .filter((g) => g.chats.length > 1)
    .sort((a, b) => a.chats[0].createdAt - b.chats[0].createdAt);
}

/** "Keep this one": merge it when it has a branch to merge, and put the others away. */
export function keepPlan(group: FanoutGroup, keepId: string): { merge?: string; archive: string[] } {
  const keep = group.chats.find((c) => c.id === keepId);
  return {
    merge: keep?.branch && !keep.merged ? keep.id : undefined,
    archive: group.chats.filter((c) => c.id !== keepId).map((c) => c.id),
  };
}

// ---- The chat switcher ----

/**
 * The strip of chat tabs: the `n` most recently active open chats, always with
 * the open one, shown in the order they were started so tabs don't jump about
 * while agents stream.
 */
export function recentChats(chats: ChatView[], activeId: string | undefined, n: number): ChatView[] {
  const open = openChats(chats);
  const recent = [...open].sort((a, b) => b.lastActivity - a.lastActivity || b.createdAt - a.createdAt).slice(0, Math.max(1, n));
  const active = open.find((c) => c.id === activeId);
  if (active && !recent.includes(active)) recent[recent.length - 1] = active;
  return recent.sort((a, b) => a.createdAt - b.createdAt || collator.compare(a.id, b.id));
}

/** What a fresh chat suggests: a few first messages, by agent (the demo's are the words it knows). */
export function starters(agent: AgentKey): string[] {
  if (agent === 'demo') return ['tour', 'project', 'help'];
  return ['Explain how this project is laid out', 'Find a failing test and fix it', 'Review my uncommitted changes', 'Plan a change before writing any code'];
}

/** The editor tab of a chat panel: the topic of the chat it shows (VS Code cuts it) and whose face is its icon. */
export function panelTitle(chat: ChatView | undefined): { title: string; agent?: AgentKey } {
  return chat ? { title: chat.title.trim() || 'New chat', agent: chat.agent } : { title: 'New chat' };
}

/** The chat tabs, as a browser keeps them: the chats you opened, in the order you opened them. */
export const openTab = (tabs: readonly string[], id: string): string[] => (tabs.includes(id) ? [...tabs] : [...tabs, id]);
/** Closing a tab takes it out; nothing takes its place. */
export const closeTab = (tabs: readonly string[], id: string): string[] => tabs.filter((t) => t !== id);

/** The tab to show after closing `closing` in `strip` (ids in order): the active one stays, else the right neighbour, else the left. */
export function tabAfterClose(strip: readonly string[], closing: string, active: string | undefined): string | undefined {
  if (active !== closing) return active;
  const at = strip.indexOf(closing);
  return strip[at + 1] ?? (at > 0 ? strip[at - 1] : undefined);
}

export const COLUMN_TITLES: Record<BoardColumn, string> = { 'needs-you': 'Needs you', working: 'Working', done: 'Done' };

/** The order chats are grouped in: what waits on you first, finished work last. */
export const STATUS_ORDER: ChatStatus[] = ['needs-you', 'working', 'error', 'idle', 'done'];
export const STATUS_TITLES: Record<ChatStatus, string> = { 'needs-you': 'Needs you', working: 'Working', error: 'Problem', idle: 'Idle', done: 'Done' };

export interface StatusGroup {
  status: ChatStatus;
  title: string;
  chats: ChatView[];
}

/** Chats by where they stand, in STATUS_ORDER, most recent activity first; empty groups only with `all`. */
export function statusGroups(chats: ChatView[], all = false): StatusGroup[] {
  const shown = sortChats(chats, { key: 'activity', dir: 'asc' });
  return STATUS_ORDER.map((status) => ({ status, title: STATUS_TITLES[status], chats: shown.filter((c) => statusOf(c) === status) })).filter((g) => all || g.chats.length > 0);
}

/** Open chats matching the query, grouped by status; starred ones first, in a group of their own. */
export function switcherGroups(chats: ChatView[], query: string): (StatusGroup | { status: 'starred'; title: string; chats: ChatView[] })[] {
  const shown = filterChats(openChats(chats), query);
  const starred = sortChats(shown.filter((c) => c.starred), { key: 'activity', dir: 'asc' });
  return [...(starred.length ? [{ status: 'starred' as const, title: 'Starred', chats: starred }] : []), ...statusGroups(shown.filter((c) => !c.starred))];
}

/** "Needs you · 42s ago" under a chat's title in the switcher. */
export function switcherMeta(chat: ChatView, now: number): string {
  return `${STATUS_TITLES[statusOf(chat)]} · ${ago(chat.lastActivity, now)}`;
}

// ---- The transcript ----

export type ToolItem = Extract<Item, { kind: 'tool' }>;
export type TranscriptGroup =
  | { kind: 'steps'; items: ToolItem[]; at: number }
  | { kind: 'one'; item: Item; at: number }
  /** A subagent's card, where it was spawned, with the steps it took. */
  | { kind: 'subagent'; item: ToolItem; steps: ToolItem[]; at: number };

/**
 * Consecutive tool calls read as one card of numbered steps; `at` is where each group starts.
 * A subagent (Claude's Task/Agent call) is a card of its own, and the steps it took go in it, not in the boxes around it.
 */
export function transcriptGroups(items: Item[]): TranscriptGroup[] {
  const out: TranscriptGroup[] = [];
  const cards = new Map<string, Extract<TranscriptGroup, { kind: 'subagent' }>>();
  items.forEach((item, at) => {
    const last = out.at(-1);
    const card = item.kind === 'tool' && item.parent ? cards.get(item.parent) : undefined;
    if (card) card.steps.push(item as ToolItem);
    else if (isSubagentCall(item)) {
      const g = { kind: 'subagent' as const, item: item as ToolItem, steps: [] as ToolItem[], at };
      cards.set(g.item.id, g);
      out.push(g);
    } else if (item.kind === 'tool' && last?.kind === 'steps') last.items.push(item);
    else if (item.kind === 'tool') out.push({ kind: 'steps', items: [item], at });
    else out.push({ kind: 'one', item, at });
  });
  return out;
}

/** A step box's heading: "Used the browser · 4 steps · 7s". */
export function stepsHeading(tools: ToolItem[]): string {
  const browser = tools.every((t) => /(^|__)browser_/.test(t.tool ?? t.title));
  const shell = tools.every((t) => !!t.cmd || t.toolKind === 'execute');
  const what = browser ? 'Used the browser' : shell ? 'Ran commands' : 'Used tools';
  const ms = tools.reduce((sum, t) => sum + (t.ms ?? 0), 0);
  return [what, `${tools.length} step${tools.length === 1 ? '' : 's'}`, ...(ms ? [shortDuration(ms)] : [])].join(' · ');
}

/** "340ms", "1s", "2m 5s": a step's time at a glance. */
export function shortDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ---- The map's hover card ----

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where a hover card goes, in viewport pixels: beside the node (right, else
 * left) so it never covers the node's column, else above or below it; always
 * inside the viewport, shrunk to fit a narrow one.
 */
export function tipPlace(node: Box, tip: { w: number; h: number }, view: { w: number; h: number }, gap = 12, margin = 4): { left: number; top: number; width: number; side: 'right' | 'left' | 'above' | 'below' } {
  const width = Math.min(tip.w, view.w - 2 * margin);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
  const sideTop = clamp(node.top - 6, margin, view.h - tip.h - margin);
  if (node.right + gap + width <= view.w - margin) return { left: node.right + gap, top: sideTop, width, side: 'right' };
  if (node.left - gap - width >= margin) return { left: node.left - gap - width, top: sideTop, width, side: 'left' };
  const left = clamp(node.left, margin, view.w - width - margin);
  if (node.top - gap - tip.h >= margin) return { left, top: node.top - gap - tip.h, width, side: 'above' };
  return { left, top: Math.max(margin, Math.min(node.bottom + gap, view.h - tip.h - margin)), width, side: 'below' };
}

// ---- @-mentions ----

export interface MentionOption {
  agent: AgentKey;
  /** What the picker shows. */
  name: string;
  /** What it inserts after the @. */
  insert: string;
  /** Every word that picks it, as parseMention reads them. */
  words: string[];
}

export const MENTION_OPTIONS: MentionOption[] = [
  { agent: 'claude', name: 'Claude', insert: 'claude', words: ['claude'] },
  { agent: 'codex', name: 'Codex', insert: 'codex', words: ['gpt', 'codex', 'chatgpt', 'openai'] },
  { agent: 'gemini', name: 'Gemini', insert: 'gemini', words: ['gemini', 'google'] },
  { agent: 'demo', name: 'Demo', insert: 'demo', words: ['demo'] },
];

/**
 * The word typed after an @ at the very start of the message, while the caret
 * is in it; null when the picker should stay shut.
 */
export function mentionQuery(text: string, caret: number): string | null {
  const m = text.match(/^(\s*)@([a-z]*)/i);
  if (!m) return null;
  const start = m[1].length + 1;
  return caret >= start && caret <= m[0].length ? m[2].toLowerCase() : null;
}

/** `shown`: the agents pickers offer (Demo only when turned on); typing @demo still works without the picker. */
export function mentionOptions(query: string, shown?: readonly AgentKey[]): MentionOption[] {
  const q = query.toLowerCase();
  return MENTION_OPTIONS.filter((o) => (!shown || shown.includes(o.agent)) && (o.words.some((w) => w.startsWith(q)) || o.name.toLowerCase().startsWith(q)));
}

/** Replaces the leading @word with the option's, followed by one space. */
export function applyMention(text: string, option: MentionOption): { text: string; caret: number } {
  const rest = text.replace(/^\s*@[a-z]*[\s,:]*/i, '');
  const head = `@${option.insert} `;
  return { text: head + rest, caret: head.length };
}

// ---- FriedLiver's own "/" commands ----

/** What every chat offers after "/", whatever its agent says. */
export const FRIEDLIVER_COMMANDS: SlashCommand[] = [
  { name: 'handoff', description: 'Continue this chat with another agent', hint: 'agent' },
  { name: 'ask', description: 'Ask another agent; the reply comes back here', hint: 'agent and question' },
  { name: 'pipe', description: "Pipe each reply to that agent's latest chat", hint: 'agent' },
  { name: 'review', description: "Review this chat's changes" },
  { name: 'new', description: 'Start a new chat', hint: 'agent (optional)' },
];

/** FriedLiver's commands, then the agent's: one list for the / button and a typed /. The agent's win a name both have. */
export function slashMenu(agentCommands: SlashCommand[]): SlashCommand[] {
  return [...FRIEDLIVER_COMMANDS.filter((f) => !agentCommands.some((c) => c.name === f.name)), ...agentCommands];
}

/** A command as the menus show it: its arguments in ‹›, not as a trailing word of the description. */
export const commandLabel = (c: SlashCommand): string => `/${c.name}${c.hint ? ` ‹${c.hint}›` : ''}`;

/**
 * The action a FriedLiver command typed in `chat` asks for, "incomplete" when it
 * still needs an agent or text, null when it isn't one (the agent gets it as typed).
 */
export function slashAction(text: string, chat: ChatView, chats: ChatView[], agentCommands: SlashCommand[]): WebviewMessage | 'incomplete' | null {
  const m = /^\/([a-z]+)(?:\s+([a-z]+))?[\s,:]*([\s\S]*)$/i.exec(text.trim());
  if (!m || !FRIEDLIVER_COMMANDS.some((c) => c.name === m[1]) || agentCommands.some((c) => c.name === m[1])) return null;
  const agent: AgentKey | undefined = m[2] ? MENTIONS[m[2].toLowerCase()] : undefined;
  const rest = m[3].trim();
  switch (m[1]) {
    case 'handoff':
      return agent ? { type: 'handoff', chatId: chat.id, agent } : 'incomplete';
    case 'ask':
      return agent && rest ? { type: 'consult', chatId: chat.id, agent, text: rest } : 'incomplete';
    case 'pipe': {
      const to = openChats(chats)
        .filter((c) => c.agent === agent && c.id !== chat.id)
        .sort((a, b) => b.lastActivity - a.lastActivity)[0];
      return to ? { type: 'pipe', from: chat.id, to: to.id } : 'incomplete';
    }
    case 'review':
      return { type: 'viewChanges', chatId: chat.id };
    default:
      return { type: 'newChat', agent: agent ?? chat.agent };
  }
}

/** The agent a leading @word names, even before the question is typed. */
export function mentionedAgent(text: string): AgentKey | null {
  const m = text.match(/^\s*@([a-z]+)(?![a-z])/i);
  if (!m) return null;
  const word = m[1].toLowerCase();
  return MENTION_OPTIONS.find((o) => o.words.includes(word))?.agent ?? null;
}

// ---- The agent map ----

/** Sizes in CSS pixels; the map scrolls rather than zooms. */
export const MAP = {
  pad: 16,
  youW: 84,
  youH: 30,
  trunkX: 58,
  laneX: 84,
  col0: 188,
  nodeW: 232,
  nodeH: 40,
  gutter: 84,
  row: 50,
  laneHead: 30,
  lanePad: 10,
  laneGap: 10,
  fileW: 188,
  fileH: 40,
  maxCol: 4,
} as const;

export interface MapNode {
  chat: ChatView;
  status: ChatStatus;
  lane: AgentKey;
  col: number;
  x: number;
  y: number;
  /** Center line, where edges attach. */
  cy: number;
  title: string;
}

/** A subagent on the map: in its chat's lane, on the row under it, one column right. */
export interface MapSub {
  /** `chatId:toolCallId`. */
  id: string;
  chatId: string;
  item: string;
  agent: AgentKey;
  state: Subagent['state'];
  title: string;
  x: number;
  y: number;
  cy: number;
  /** Of a Claude Code session from outside FriedLiver: `chatId` is `cc:<session id>`. */
  outside?: boolean;
  /** The folded done subagents of `chatId` (`item` is "done"): how many; a click opens them. */
  count?: number;
}

/** A Claude Code session from outside FriedLiver that has subagents, drawn so they have a parent. */
export interface MapOutside {
  /** The session id. */
  id: string;
  title: string;
  state: 'working' | 'done';
  x: number;
  y: number;
  cy: number;
}

export interface MapLane {
  /** The lane of Claude Code sessions from outside FriedLiver. */
  outside?: boolean;
  agent: AgentKey;
  y: number;
  h: number;
  chats: number;
  working: number;
  needsYou: number;
}

export interface MapEdge {
  id: string;
  kind: LinkKind | 'subagent';
  from: string;
  to: string;
  d: string;
  label: string;
  lx: number;
  ly: number;
  /** Messages are moving: a live pipe, or a consultant still answering. */
  flowing: boolean;
  by: ChatLink['by'];
}

export interface MapGroup {
  id: string;
  x: number;
  y1: number;
  y2: number;
  /** Where the line from You joins the bracket. */
  joinY: number;
  members: number[];
  size: number;
}

export interface MapConflict {
  file: string;
  chats: string[];
  x: number;
  y: number;
  /** One line per chat that changed the file. */
  lines: string[];
}

export interface MapColumn {
  x: number;
  title: string;
}

export interface MapLayout {
  width: number;
  height: number;
  you: { x: number; y: number };
  /** The line down from You and its branches to the chats you started. */
  trunk: { x: number; y1: number; y2: number };
  starts: string[];
  columns: MapColumn[];
  lanes: MapLane[];
  nodes: MapNode[];
  subs: MapSub[];
  outside: MapOutside[];
  edges: MapEdge[];
  groups: MapGroup[];
  conflicts: MapConflict[];
}

/**
 * Everything mapLayout reads, as one string: states with equal keys lay out
 * the same, so the map is laid out again only when a chat starts, stops,
 * changes status or files, or a link changes, not on every streamed chunk.
 */
export function mapKey(state: Pick<AppState, 'chats' | 'links'>, outside: ClaudeSession[] = [], now = 0): string {
  return JSON.stringify([
    mapSessions(outside).map((s) => [s.id, s.title, claudeColumn(s, now), claudeSubagents(s, now)]),
    openChats(state.chats).map((c) => [c.id, c.agent, c.label, c.title, c.createdAt, c.origin, c.group, c.merged, c.busy, statusOf(c), c.files, subagents(c)]),
    state.links,
  ]);
}

/** The chats' names and titles, as one string, for parts that show other chats by name. */
export function rosterKey(chats: ChatView[]): string {
  return JSON.stringify(chats.map((c) => [c.id, c.agent, c.label, c.title, c.archived]));
}

const COLUMN_TITLES_MAP = ['Started by you', '1 link away', '2 links away', '3 links away', '4 links away'];

/**
 * Where everything on the agent map goes. Lanes run across, one per agent;
 * columns count links from a chat you started. Every chat has a row of its own,
 * so an edge can run along its source's row and turn only in the gutter before
 * its target's column: no line ever crosses a node. Deterministic: the same
 * state draws the same map.
 */
/** Only outside sessions that launched subagents go on the map: the rest are on the board and the list. */
const mapSessions = (outside: ClaudeSession[]) => outside.filter((s) => s.subagents.length && !s.archived);

/** `expanded`: the chats (and `cc:<session id>`s) whose done subagents are shown one by one, not folded. */
export function mapLayout(state: Pick<AppState, 'chats' | 'links'>, outsideSessions: ClaudeSession[] = [], now = 0, expanded: ReadonlySet<string> = new Set()): MapLayout {
  const M = MAP;
  const chats = openChats(state.chats);
  const byId = new Map(chats.map((c) => [c.id, c]));

  // Columns: hops along `origin` back to a chat the user started.
  const cols = new Map<string, number>();
  const colOf = (c: ChatView, seen: Set<string> = new Set()): number => {
    const known = cols.get(c.id);
    if (known !== undefined) return known;
    const parent = c.origin ? byId.get(c.origin.chatId) : undefined;
    seen.add(c.id);
    const col = parent && !seen.has(parent.id) ? Math.min(colOf(parent, seen) + 1, M.maxCol) : 0;
    cols.set(c.id, col);
    return col;
  };
  const rootOf = (c: ChatView): ChatView => {
    const seen = new Set<string>();
    let cur = c;
    while (cur.origin && byId.has(cur.origin.chatId) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.origin.chatId)!;
    }
    return cur;
  };
  // Rows in a lane follow the flows they belong to, so related chats sit at like heights.
  const groupStart = new Map<string, number>();
  for (const c of chats) if (c.group) groupStart.set(c.group, Math.min(groupStart.get(c.group) ?? Infinity, c.createdAt));
  const flow = (c: ChatView): [number, string] => {
    const r = rootOf(c);
    return r.group ? [groupStart.get(r.group)!, r.group] : [r.createdAt, r.id];
  };
  const order = (a: ChatView, b: ChatView) => {
    const [fa, ka] = flow(a);
    const [fb, kb] = flow(b);
    return fa - fb || collator.compare(ka, kb) || colOf(a) - colOf(b) || a.createdAt - b.createdAt || collator.compare(a.id, b.id);
  };

  // Running and failed subagents, then the done ones: one by one when opened, else one node with their count.
  const fold = (parent: string, list: Subagent[]): (Subagent & { count?: number })[] => {
    const { live, done } = foldSubs(list);
    if (!done.length) return live;
    const open = expanded.has(parent);
    const toggle = { id: 'done', title: `${done.length} done · ${open ? 'hide' : 'show'}`, state: 'done' as const, tools: 0, count: done.length };
    return open ? [...live, ...done, toggle] : [...live, toggle];
  };
  const subsOf = new Map(chats.map((c) => [c.id, fold(c.id, subagents(c))]));
  const sessions = mapSessions(outsideSessions);
  const maxCol = chats.reduce((m, c) => Math.max(m, Math.min(colOf(c) + (subsOf.get(c.id)!.length ? 1 : 0), M.maxCol)), sessions.length ? 1 : 0);
  const colX = (col: number) => M.col0 + col * (M.nodeW + M.gutter);
  const nodesRight = colX(maxCol) + M.nodeW;

  const lanes: MapLane[] = [];
  const nodes: MapNode[] = [];
  const subs: MapSub[] = [];
  let y = M.pad + M.youH + 18;
  for (const agent of AGENT_KEYS) {
    const inLane = chats.filter((c) => c.agent === agent).sort(order);
    if (!inLane.length) continue;
    const top = y;
    let row = 0;
    for (const chat of inLane) {
      const ny = top + M.laneHead + row++ * M.row;
      nodes.push({ chat, status: statusOf(chat), lane: agent, col: colOf(chat), x: colX(colOf(chat)), y: ny, cy: ny + M.nodeH / 2, title: clip(chat.title, 27) });
      // Each subagent takes the next row, so its edge drops straight from its chat without crossing a node.
      for (const sub of subsOf.get(chat.id)!) {
        const sy = top + M.laneHead + row++ * M.row;
        const sx = colX(Math.min(colOf(chat) + 1, M.maxCol));
        subs.push({ id: `${chat.id}:${sub.id}`, chatId: chat.id, item: sub.id, agent, state: sub.state, title: clip(sub.title, 27), x: sx, y: sy, cy: sy + M.nodeH / 2, ...(sub.count ? { count: sub.count } : {}) });
      }
    }
    const h = M.laneHead + (row - 1) * M.row + M.nodeH + M.lanePad;
    const statuses = inLane.map((c) => boardColumn(statusOf(c)));
    lanes.push({ agent, y: top, h, chats: inLane.length, working: statuses.filter((s) => s === 'working').length, needsYou: statuses.filter((s) => s === 'needs-you').length });
    y = top + h + M.laneGap;
  }
  const outside: MapOutside[] = [];
  if (sessions.length) {
    const top = y;
    let row = 0;
    for (const s of sessions) {
      const ny = top + M.laneHead + row++ * M.row;
      outside.push({ id: s.id, title: clip(s.title, 27), state: claudeColumn(s, now), x: colX(0), y: ny, cy: ny + M.nodeH / 2 });
      for (const sub of fold(`cc:${s.id}`, claudeSubagents(s, now))) {
        const sy = top + M.laneHead + row++ * M.row;
        subs.push({ id: `cc:${s.id}:${sub.id}`, chatId: `cc:${s.id}`, item: sub.id, agent: 'claude', state: sub.state, title: clip(sub.title, 27), x: colX(1), y: sy, cy: sy + M.nodeH / 2, outside: true, ...(sub.count ? { count: sub.count } : {}) });
      }
    }
    const h = M.laneHead + (row - 1) * M.row + M.nodeH + M.lanePad;
    lanes.push({ agent: 'claude', outside: true, y: top, h, chats: sessions.length, working: outside.filter((o) => o.state === 'working').length, needsYou: 0 });
    y = top + h + M.laneGap;
  }
  const node = new Map(nodes.map((n) => [n.chat.id, n]));
  const anchor = new Map<string, { x: number; cy: number }>([...nodes.map((n) => [n.chat.id, n] as const), ...outside.map((o) => [`cc:${o.id}`, o] as const)]);

  // Links, plus an edge for any origin whose link is gone, so no chat floats.
  const links: ChatLink[] = state.links.filter((l) => node.has(l.from) && node.has(l.to) && l.from !== l.to);
  for (const c of chats) {
    if (c.origin && node.has(c.origin.chatId) && !links.some((l) => l.from === c.origin!.chatId && l.to === c.id)) {
      links.push({ id: `origin:${c.id}`, kind: c.origin.kind, from: c.origin.chatId, to: c.id, by: c.origin.by, createdAt: c.createdAt, active: true, count: 0 });
    }
  }

  // Shared files go in a column of their own, near the chats that changed them.
  const conflictList = fileConflicts({ chats }).filter((f) => f.chats.every((id) => node.has(id)));
  const filesX = nodesRight + M.gutter;
  const placed: { file: string; chats: string[]; y: number }[] = [];
  const firstRow = nodes.length ? Math.min(...nodes.map((n) => n.y)) : y;
  for (const f of conflictList
    .map((f) => ({ ...f, want: f.chats.reduce((s, id) => s + node.get(id)!.cy, 0) / f.chats.length - M.fileH / 2 }))
    .sort((a, b) => a.want - b.want || collator.compare(a.file, b.file))) {
    const prev = placed.at(-1);
    placed.push({ file: f.file, chats: f.chats, y: Math.max(f.want, firstRow, prev ? prev.y + M.fileH + 10 : -Infinity) });
  }

  // Ports: edges meeting one side of a node spread out, in the order of their other ends.
  type Side = 'l' | 'r';
  const ends = new Map<string, { id: string; other: number }[]>();
  const attach = (key: string, id: string, other: number) => ends.set(key, [...(ends.get(key) ?? []), { id, other }]);
  const routes = links.map((l) => {
    const a = node.get(l.from)!;
    const b = node.get(l.to)!;
    const shape = b.col > a.col ? 'forward' : b.col === a.col ? 'loop' : 'back';
    const fromSide: Side = shape === 'back' ? 'l' : 'r';
    const toSide: Side = shape === 'forward' ? 'l' : 'r';
    attach(`${a.chat.id}:${fromSide}`, l.id, b.cy);
    attach(`${b.chat.id}:${toSide}`, l.id, a.cy);
    return { l, a, b, shape, fromSide, toSide };
  });
  const conflictLines = placed.flatMap((f, fi) => f.chats.map((id) => ({ id: `file:${fi}:${id}`, chat: id, fi })));
  for (const c of conflictLines) {
    attach(`${c.chat}:r`, c.id, placed[c.fi].y + M.fileH / 2);
    attach(`file:${c.fi}`, c.id, node.get(c.chat)!.cy);
  }
  const port = (key: string, id: string) => {
    const list = [...(ends.get(key) ?? [])].sort((p, q) => p.other - q.other || collator.compare(p.id, q.id));
    const at = list.findIndex((p) => p.id === id);
    const step = Math.min(7, 26 / Math.max(1, list.length - 1));
    return (at - (list.length - 1) / 2) * step;
  };

  const r = (n: number) => Math.round(n * 10) / 10;
  const curve = (x0: number, y0: number, x1: number, y1: number) => {
    const m = (x0 + x1) / 2;
    return `C ${r(m)} ${r(y0)}, ${r(m)} ${r(y1)}, ${r(x1)} ${r(y1)}`;
  };

  const loops = new Map<number, number>();
  const edges: MapEdge[] = routes.map(({ l, a, b, shape, fromSide, toSide }) => {
    const ys = a.cy + port(`${a.chat.id}:${fromSide}`, l.id);
    const yt = b.cy + port(`${b.chat.id}:${toSide}`, l.id);
    let d: string;
    let lx: number;
    if (shape === 'forward') {
      // Along the source's own row, then turn in the gutter before the target.
      const xs = a.x + M.nodeW;
      const gx = b.x - M.gutter;
      d = `M ${r(xs)} ${r(ys)} ${gx > xs ? `L ${r(gx)} ${r(ys)} ` : ''}${curve(gx, ys, b.x, yt)}`;
      lx = (gx + b.x) / 2;
    } else if (shape === 'back') {
      const xs = a.x;
      const gx = b.x + M.nodeW + M.gutter;
      d = `M ${r(xs)} ${r(ys)} ${xs > gx ? `L ${r(gx)} ${r(ys)} ` : ''}${curve(gx, ys, b.x + M.nodeW, yt)}`;
      lx = (gx + b.x + M.nodeW) / 2;
    } else {
      // Same column: a loop out into the gutter on the right.
      const n = loops.get(a.col) ?? 0;
      loops.set(a.col, n + 1);
      const xs = a.x + M.nodeW;
      const k = Math.min(M.gutter - 14, 30 + n * 10);
      d = `M ${r(xs)} ${r(ys)} C ${r(xs + k)} ${r(ys)}, ${r(xs + k)} ${r(yt)}, ${r(xs)} ${r(yt)}`;
      lx = xs + k * 0.75;
    }
    const kind = l.kind === 'handoff' ? 'hand-off' : l.kind === 'consult' ? 'asks' : l.active ? 'pipe' : 'pipe · paused';
    const verb = l.by === 'agent' ? `agent ${kind}` : kind;
    return {
      id: l.id,
      kind: l.kind,
      from: l.from,
      to: l.to,
      d,
      label: l.count > 0 ? `${verb} · ${l.count}` : verb,
      lx,
      ly: (ys + yt) / 2,
      flowing: l.kind === 'pipe' ? l.active : l.kind === 'consult' && b.chat.busy,
      by: l.by,
    };
  });
  for (const sub of subs) {
    const a = anchor.get(sub.chatId)!;
    const xs = a.x + M.nodeW;
    const gx = Math.max(xs, sub.x - M.gutter);
    edges.push({
      id: `sub:${sub.id}`,
      kind: 'subagent',
      from: sub.chatId,
      to: sub.id,
      d: `M ${r(xs)} ${r(a.cy)} ${gx > xs ? `L ${r(gx)} ${r(a.cy)} ` : ''}${curve(gx, a.cy, sub.x, sub.cy)}`,
      label: 'subagent',
      lx: (gx + sub.x) / 2,
      ly: (a.cy + sub.cy) / 2,
      flowing: sub.state === 'working',
      by: 'agent',
    });
  }
  // Labels that would overlap step down until they don't.
  const labels: MapEdge[] = [];
  for (const e of [...edges].sort((p, q) => p.lx - q.lx || p.ly - q.ly)) {
    while (labels.some((o) => Math.abs(o.lx - e.lx) < 64 && Math.abs(o.ly - e.ly) < 18)) e.ly += 18;
    labels.push(e);
  }

  const conflicts: MapConflict[] = placed.map((f, fi) => {
    const cy = f.y + M.fileH / 2;
    return {
      file: f.file,
      chats: f.chats,
      x: filesX,
      y: f.y,
      lines: f.chats.map((id) => {
        const n = node.get(id)!;
        const lineId = `file:${fi}:${id}`;
        const ys = n.cy + port(`${id}:r`, lineId);
        const yt = cy + port(`file:${fi}`, lineId);
        const xs = n.x + M.nodeW;
        const gx = filesX - M.gutter;
        return `M ${r(xs)} ${r(ys)} ${gx > xs ? `L ${r(gx)} ${r(ys)} ` : ''}${curve(gx, ys, filesX, yt)}`;
      }),
    };
  });

  // Fan-out: one branch from You splits into the chats that got the same task.
  const groupIds = [...new Set(nodes.flatMap((n) => (n.chat.group && n.col === 0 ? [n.chat.group] : [])))]
    .map((id) => ({ id, members: nodes.filter((n) => n.chat.group === id && n.col === 0) }))
    .filter((g) => g.members.length > 1)
    .sort((p, q) => (groupStart.get(p.id) ?? 0) - (groupStart.get(q.id) ?? 0) || collator.compare(p.id, q.id));
  const grouped = new Set(groupIds.flatMap((g) => g.members.map((n) => n.chat.id)));
  const gaps = nodes.flatMap((n) => [n.y - (M.row - M.nodeH) / 2, n.y + M.nodeH + (M.row - M.nodeH) / 2]);
  const groups: MapGroup[] = groupIds.map((g, gi) => {
    const ys = g.members.map((n) => n.cy).sort((p, q) => p - q);
    const y1 = ys[0];
    const y2 = ys.at(-1)!;
    const mid = (y1 + y2) / 2;
    // Join between rows, so the branch never reads as one more chat's line.
    const joinY = gaps.filter((v) => v > y1 && v < y2).sort((p, q) => Math.abs(p - mid) - Math.abs(q - mid) || p - q)[0] ?? mid;
    return { id: g.id, x: M.col0 - 26 - gi * 12, y1, y2, joinY, members: ys, size: g.members.length };
  });

  const starts = [
    ...nodes.filter((n) => n.col === 0 && !grouped.has(n.chat.id)).map((n) => `M ${M.trunkX} ${r(n.cy)} H ${M.col0}`),
    ...groups.flatMap((g) => [`M ${M.trunkX} ${r(g.joinY)} H ${g.x}`, ...g.members.map((my) => `M ${g.x} ${r(my)} H ${M.col0}`)]),
  ];
  const branchYs = [...nodes.filter((n) => n.col === 0 && !grouped.has(n.chat.id)).map((n) => n.cy), ...groups.map((g) => g.joinY)];

  const columns: MapColumn[] = Array.from({ length: maxCol + 1 }, (_, c) => ({ x: colX(c), title: COLUMN_TITLES_MAP[c] }));
  if (placed.length) columns.push({ x: filesX, title: 'Shared files' });

  const contentBottom = Math.max(y - M.laneGap, ...placed.map((f) => f.y + M.fileH));
  return {
    width: (placed.length ? filesX + M.fileW : nodesRight + 40) + M.pad,
    height: contentBottom + M.pad,
    you: { x: M.pad, y: M.pad },
    trunk: { x: M.trunkX, y1: M.pad + M.youH, y2: branchYs.length ? Math.max(...branchYs) : M.pad + M.youH },
    starts,
    columns,
    lanes,
    nodes,
    subs,
    outside,
    edges,
    groups,
    conflicts,
  };
}

// ---- The composer's controls redraw only when what they show changes, not per streamed chunk. ----

type Controls = { chat: ChatView; samples?: number[]; bare?: boolean; compact?: boolean };

/** Mode icon and usage/settings button: the session, level, name and usage samples. */
export function sameControls<T extends Controls>(a: T, b: T): boolean {
  return (
    a.chat.id === b.chat.id &&
    a.chat.session === b.chat.session &&
    a.chat.approval === b.chat.approval &&
    a.chat.label === b.chat.label &&
    a.chat.agent === b.chat.agent &&
    a.samples === b.samples &&
    a.bare === b.bare &&
    a.compact === b.compact
  );
}

const agentsKey = (chat: ChatView, linked: ChatView[]) =>
  JSON.stringify([chat.id, chat.busy, subagents(chat).map((s) => [s.id, s.state, s.title, s.last, s.startedAt, s.ms]), linked.map((c) => [c.id, c.busy, c.label, c.title, c.createdAt, c.origin?.kind])]);

/** Agents button: its subagents' and linked chats' state, not the transcript text. */
export function sameAgents<T extends { chat: ChatView; linked: ChatView[] }>(a: T, b: T): boolean {
  return agentsKey(a.chat, a.linked) === agentsKey(b.chat, b.linked);
}
