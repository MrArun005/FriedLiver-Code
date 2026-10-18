// The chats as the phone shows them: a list by status, and one chat's
// transcript, compacted. No images, no thinking, no subagents' own steps
// (they count under the subagent), long text cut.
import path from 'node:path';
import { diffPreview } from '../shared/diff';
import { AGENT_FACES, bridgeTitle, decisions, waitingItems, type AgentKey, type AppState, type ChatView, type Item } from '../shared/model';
import { describeGrant, type Grant } from '../shared/permissions';
import { ESCALATING } from '../shared/tools';
import { openChats, statusGroups, statusOf, subagents } from '../shared/view';
import type { PhoneChat, PhoneItem, PhoneList, PhoneSummary } from './protocol';

const MAX_ITEMS = 120;
const MAX_TEXT = 12_000;
const MAX_OUTPUT = 1500;
const MAX_LINES = 40;

/** "Always allow changing files in src/remote", "Always allow https://example.com". */
function alwaysLabel(grant: Grant, rel: (p: string) => string): string {
  if (grant.kind === 'folder') return `Always allow ${grant.access === 'read' ? 'reading' : 'changing'} files in ${rel(grant.folder) || '.'}`;
  if (grant.kind === 'site') return `Always allow ${grant.origin}`;
  return `Always allow: ${describeGrant(grant).what}`;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const tail = (s: string, max: number) => (s.length > max ? `…${s.slice(-(max - 1))}` : s);

/** The chats a phone may see and act on: open, and not an inline edit's. */
export function phoneChats(state: Pick<AppState, 'chats'>, hidden: (chatId: string) => boolean = () => false): ChatView[] {
  return openChats(state.chats).filter((c) => !c.readOnly && !hidden(c.id));
}

export function summary(chat: ChatView): PhoneSummary {
  return {
    id: chat.id,
    agent: chat.agent,
    label: chat.label,
    title: chat.title,
    status: statusOf(chat),
    folder: chat.branch ?? path.basename(chat.cwd),
    busy: chat.busy,
    lastActivity: chat.lastActivity,
    waiting: waitingItems(chat.items).length,
    subagents: subagents(chat).filter((s) => s.state === 'working').length,
    approval: chat.approval ?? 'ask',
  };
}

export function phoneList(chats: ChatView[], agents: AgentKey[], folders: string[], now = Date.now()): PhoneList {
  return {
    groups: statusGroups(chats).map((g) => ({ status: g.status, title: g.title, chats: g.chats.map(summary) })),
    agents: agents.map((key) => ({ key, name: AGENT_FACES[key].name })),
    folders: folders.map((p) => ({ path: p, name: path.basename(p) || p })),
    now,
  };
}

/** A pending write's diff, for review cards: the editor knows the proposed text. */
export type ReviewText = (reviewId: string) => { before: string | null; proposed: string } | undefined;

export function phoneChat(state: Pick<AppState, 'chats'>, chat: ChatView, reviewText: ReviewText = () => undefined): PhoneChat {
  const rel = (p: string) => {
    const r = path.relative(chat.cwd, p);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p;
  };
  const titles = new Map(decisions({ chats: [chat] }).map((d) => [d.id, d.title]));
  const subagentCalls = new Set(subagents(chat).map((s) => s.id));
  const items: PhoneItem[] = [];
  for (const i of chat.items) {
    const item = phoneItem(state, chat, i, rel, titles, subagentCalls, reviewText);
    if (item) items.push(item);
  }
  // Answered and auto-answered cards stay small; waiting ones are never cut off.
  const keep = items.slice(-MAX_ITEMS);
  return {
    ...summary(chat),
    items: keep,
    earlier: items.length - keep.length,
    subagentList: subagents(chat),
    queued: chat.queue?.length ?? 0,
  };
}

function phoneItem(
  state: Pick<AppState, 'chats'>,
  chat: ChatView,
  i: Item,
  rel: (p: string) => string,
  titles: Map<string, string>,
  subagentCalls: Set<string>,
  reviewText: ReviewText,
): PhoneItem | null {
  switch (i.kind) {
    case 'user':
      return { k: 'user', text: clip(i.text, MAX_TEXT) };
    case 'agent':
      return { k: 'agent', text: clip(i.text, MAX_TEXT) };
    case 'tool':
      if (i.parent) return null;
      return { k: 'tool', id: i.id, title: clip(i.title, 200), ...(i.status ? { status: i.status } : {}), ...(subagentCalls.has(i.id) ? { subagent: true } : {}) };
    case 'plan':
      return { k: 'plan', entries: i.entries.slice(0, 30).map((e) => ({ content: clip(e.content, 300), status: e.status })) };
    case 'permission': {
      const d = i.detail;
      const always = [
        ...(d?.command && !i.answer ? [{ grant: { kind: 'exact' as const, command: d.command.line }, label: `Always allow ${clip(d.command.line, 60)}` }] : []),
        ...(!i.answer ? (d?.always ?? []).map((grant) => ({ grant, label: alwaysLabel(grant, rel) })) : []),
      ];
      return {
        k: 'permission',
        id: i.requestId,
        title: clip(i.title, 300),
        options: i.options.map((o) => ({ id: o.optionId, name: o.name, kind: o.kind, escalates: o.kind === 'allow_always' || ESCALATING.test(o.name) })),
        ...(i.answer ? { answer: i.answer } : {}),
        ...(i.auto ? { auto: i.auto } : {}),
        ...(d?.command ? { command: { line: clip(d.command.line, 4000), ...(d.command.cwd ? { cwd: rel(d.command.cwd) } : {}) } } : {}),
        ...(d?.files?.length
          ? { files: d.files.map((f) => ({ path: rel(f.path), added: f.added, removed: f.removed, isNew: f.isNew, lines: f.lines.slice(0, MAX_LINES), more: f.more + Math.max(0, f.lines.length - MAX_LINES) })) }
          : {}),
        ...(d?.plan ? { plan: clip(d.plan, MAX_TEXT) } : {}),
        ...(d?.text ? { text: clip(d.text, 2000) } : {}),
        ...(d?.url ? { url: d.url } : {}),
        always,
      };
    }
    case 'command':
      return {
        k: 'command',
        id: i.commandId,
        line: clip(i.commandLine, 4000),
        cwd: rel(i.cwd),
        state: i.state,
        outside: i.outside,
        output: tail(i.output, MAX_OUTPUT),
        ...(i.exitCode !== undefined ? { exitCode: i.exitCode } : {}),
        ...(i.auto ? { auto: i.auto } : {}),
      };
    case 'question':
      return { k: 'question', id: i.requestId, message: i.message, fields: i.fields, state: i.state, ...(i.summary ? { summary: i.summary } : {}) };
    case 'review': {
      const text = i.state === 'pending' ? reviewText(i.reviewId) : undefined;
      const preview = text ? diffPreview(text.before, text.proposed, MAX_LINES) : undefined;
      return {
        k: 'review',
        id: i.reviewId,
        file: { path: rel(i.path), added: i.added, removed: i.removed, isNew: i.isNew, lines: preview?.lines ?? [], more: preview?.more ?? 0 },
        state: i.state,
        ...(i.auto ? { auto: i.auto } : {}),
      };
    }
    case 'bridge':
      return {
        k: 'bridge',
        id: i.requestId,
        title: titles.get(i.requestId) ?? bridgeTitle(state, chat, i, true),
        text: clip(i.text, 2000),
        state: i.state,
        ...(i.always && i.state === 'awaiting' ? { always: i.always } : {}),
      };
    case 'notice':
      return { k: 'notice', text: clip(i.text, 2000), tone: i.tone };
    case 'changes':
      return { k: 'changes', files: i.files.length, ...(i.undone ? { undone: true } : {}) };
    case 'link':
      return { k: 'link', label: i.label, text: clip(i.text, 2000), role: i.role };
    default:
      return null;
  }
}
