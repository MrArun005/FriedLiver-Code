// The Decision Inbox: everything any agent waits on, in every open chat, as one keyboard queue,
// in risk lanes (Careful, Review, Routine) so what can hurt is looked at first.
// Plain data and pure functions; the Agent Manager draws it (webview/inbox.tsx). Every answer is
// one of the messages the chat's own cards send, so it takes the same path through the host, with
// the same checks (an option the agent offered, a grant the request offered, the origin again).
import { approvalOf } from './approval';
import { DecisionTargets, KEY_GRACE_MS } from './decisionTarget';
import type { WebviewMessage } from './messages';
import { BRIDGE_TIMEOUT_MS, bridgeTitle, decisionOf, shortCommand, waitingItems, type AppState, type ChatView, type Item } from './model';
import { siteOrigin } from './permissions';
import { oneClickQuestion, recommended } from './questions';
import { RISK_ORDER, type RiskTone } from './risk';
import { denyOption, primaryOption } from './tools';
import { openChats } from './view';

export type Waiting = Extract<Item, { kind: 'permission' | 'review' | 'command' | 'bridge' | 'question' }>;

/** What the entry asks, for its icon and words. */
export type InboxKind = 'command' | 'edit' | 'review' | 'browser' | 'agent' | 'memory' | 'question' | 'permission';

export interface InboxEntry {
  /** The request's own id: requestId, reviewId or commandId. */
  id: string;
  chatId: string;
  kind: InboxKind;
  title: string;
  /** When it arrived (the host's clock). */
  at?: number;
  /** When it stops waiting on its own: requests through the FriedLiver tools give up after ten minutes. */
  timeoutAt?: number;
  item: Waiting;
  /** Entries with the same key ask the very same thing of the same target, and may be answered together. */
  same?: string;
  /** Its lane: careful, review or routine (a question is review). */
  risk: RiskTone;
}

export interface InboxLane {
  tone: RiskTone;
  entries: InboxEntry[];
}

export interface Inbox {
  /** Careful, then Review, then Routine; only lanes with something in them. Oldest first in each. */
  lanes: InboxLane[];
  /** The lanes' entries in order: what j and k walk. */
  entries: InboxEntry[];
}

function kindOf(i: Waiting): InboxKind {
  if (i.kind === 'permission') return i.toolKind === 'execute' || i.detail?.command ? 'command' : i.toolKind === 'edit' || i.detail?.files?.length ? 'edit' : 'permission';
  if (i.kind === 'bridge') return 'browser' in i.target ? 'browser' : 'memory' in i.target ? 'memory' : 'agent';
  return i.kind;
}

/** The site a browser request acts on: the page it opens, or the open page's origin the host recorded. Unknown: never batched. */
export function browserOrigin(i: Extract<Item, { kind: 'bridge' }>): string | undefined {
  if (!('browser' in i.target)) return undefined;
  return i.tool === 'browser_open' ? siteOrigin(i.text) : i.always ? siteOrigin(i.always) : undefined;
}

/**
 * What makes two requests the same: the exact command text in the same folder, or the same browser
 * action with the same text on the same site. Anything else (edits, questions, messages) is never batched.
 */
export function sameKey(chat: ChatView, i: Waiting): string | undefined {
  if (i.kind === 'command') return `run\0${i.commandLine}\0${i.cwd}`;
  if (i.kind === 'permission') {
    const cmd = i.detail?.command;
    if (!cmd || i.detail?.files?.length || !primaryOption(i.options) || !denyOption(i.options)) return undefined;
    return `run\0${cmd.line}\0${cmd.cwd ?? chat.cwd}`;
  }
  if (i.kind === 'bridge') {
    const origin = browserOrigin(i);
    return origin ? `site\0${i.tool}\0${i.text}\0${origin}` : undefined;
  }
  return undefined;
}

/** A row's words under its chat's header: a bridge request without the chat's own topic, a command as "Run …". */
function rowTitle(state: Pick<AppState, 'chats'>, chat: ChatView, i: Waiting, title: string): string {
  if (i.kind === 'bridge') return bridgeTitle(state, chat, i, true);
  const line = i.kind === 'permission' ? i.detail?.command?.line : undefined;
  return line && i.kind === 'permission' && line.trim() === i.title.trim() ? `Run ${shortCommand(line)}` : title;
}

const isWaitingKind = (i: Item): i is Waiting => i.kind === 'permission' || i.kind === 'review' || i.kind === 'command' || i.kind === 'bridge' || i.kind === 'question';

/** Every request waiting in an open chat, in risk lanes, oldest first in each. Read-only chats ask nothing, so they are left out. */
export function inbox(state: Pick<AppState, 'chats'>): Inbox {
  const all: { entry: InboxEntry; n: number }[] = [];
  for (const chat of openChats(state.chats)) {
    if (chat.readOnly) continue;
    for (const item of waitingItems(chat.items)) {
      const d = isWaitingKind(item) ? decisionOf(state, chat, item) : undefined;
      if (!d || !isWaitingKind(item)) continue;
      const same = sameKey(chat, item);
      const entry: InboxEntry = {
        id: d.id,
        chatId: chat.id,
        kind: kindOf(item),
        title: rowTitle(state, chat, item, d.title),
        item,
        ...(item.at !== undefined ? { at: item.at } : {}),
        ...(item.kind === 'bridge' && item.at !== undefined ? { timeoutAt: item.at + BRIDGE_TIMEOUT_MS } : {}),
        ...(same ? { same } : {}),
        risk: item.kind === 'question' ? 'review' : approvalOf(item, chat, state).risk.tone,
      };
      all.push({ entry, n: all.length });
    }
  }
  // Oldest first; without a time (an older saved state), in the order the chats hold them.
  all.sort((a, b) => (a.entry.at ?? 0) - (b.entry.at ?? 0) || a.n - b.n);
  const lanes = (['careful', 'review', 'routine'] as const)
    .map((tone) => ({ tone, entries: all.filter((x) => x.entry.risk === tone).map((x) => x.entry) }))
    .filter((l) => l.entries.length);
  return { lanes, entries: lanes.flatMap((l) => l.entries) };
}

/** The entries that ask exactly what `entry` asks, `entry` among them, in queue order. */
export function identical(entries: readonly InboxEntry[], entry: InboxEntry): InboxEntry[] {
  return entry.same ? entries.filter((e) => e.same === entry.same) : [entry];
}

/** What "Allow all N" may answer together: identical requests, and only routine ones. Careful and review are one at a time. */
export function batchable(entries: readonly InboxEntry[], entry: InboxEntry): InboxEntry[] {
  const same = identical(entries, entry);
  return entry.risk === 'routine' && same.length >= 2 && same.every((e) => e.risk === 'routine') ? same : [entry];
}

export { RISK_ORDER };

// ---- Answers: the messages the chat's own cards send ----

export interface InboxChoice {
  label: string;
  message: WebviewMessage;
}

export interface InboxActions {
  /** A question's options, numbered 1–9 as on its card. */
  choices: InboxChoice[];
  /** The one-time yes (Allow once, Accept). */
  allow?: WebviewMessage;
  /** No (Deny, Reject, Skip). */
  deny?: WebviewMessage;
  /** Enter: allow (with the card's scope, held when careful), or open where answering needs reading first. */
  primary: 'allow' | 'open' | WebviewMessage;
  /** The edit's diff in the editor (reviews, and permission requests that change files). */
  diff?: WebviewMessage;
}

export function entryActions(entry: InboxEntry, state?: Pick<AppState, 'chats'>): InboxActions {
  const i = entry.item;
  if (i.kind === 'question') {
    // A single choice answers here, Claude's pick first, as on its card; anything else is answered in the chat.
    const field = oneClickQuestion(i.fields);
    const options = (field?.options ?? []).map((o) => ({ o, ...recommended(o.title) })).sort((a, b) => Number(b.recommended) - Number(a.recommended));
    return {
      choices: field ? options.map(({ o, label }) => ({ label, message: { type: 'answerQuestion', requestId: i.requestId, action: 'accept', values: { [field.key]: o.value } } })) : [],
      deny: { type: 'answerQuestion', requestId: i.requestId, action: 'decline' },
      primary: 'open',
    };
  }
  const chat = state?.chats.find((c) => c.id === entry.chatId) ?? { agent: 'claude' as const, label: '', cwd: '' };
  const a = approvalOf(i, chat, state);
  const file = i.kind === 'permission' ? i.detail?.files?.find((f) => f.full) : undefined;
  const diff: WebviewMessage | undefined =
    i.kind === 'review' ? { type: 'review', reviewId: i.reviewId, action: 'open' } : file && i.kind === 'permission' ? { type: 'permissionDiff', requestId: i.requestId, path: file.path } : undefined;
  return {
    choices: [],
    ...(a.allow.once ? { allow: a.allow.once } : {}),
    ...(a.deny ? { deny: a.deny } : {}),
    // A review's Enter opens its diff (the inbox has only its size); a plan opens the chat to be read; no plain yes, the chat too.
    primary: i.kind === 'review' ? diff! : !a.allow.once || (i.kind === 'permission' && i.detail?.plan) ? 'open' : 'allow',
    ...(diff ? { diff } : {}),
  };
}

/** The answers "Allow all N" sends: each entry's own one-time yes or no. Never a remembered scope. */
export function batchMessages(entries: readonly InboxEntry[], answer: 'allow' | 'deny'): WebviewMessage[] {
  return entries.flatMap((e) => entryActions(e)[answer] ?? []);
}

// ---- The selected entry ----

/**
 * The entry the keys act on, under the chat's frozen-target rule (shared/decisionTarget.ts): it stays
 * put while it waits, whatever arrives; it changes when you move or click, or when it is answered (then
 * the oldest still waiting); every change starts the grace period.
 */
export class InboxSelection {
  private readonly targets = new DecisionTargets();

  selected(entries: readonly InboxEntry[], now: number): InboxEntry | undefined {
    const id = this.targets.target('inbox', entries.map((e) => e.id), now)?.id;
    return entries.find((e) => e.id === id);
  }

  choose(id: string, entries: readonly InboxEntry[], now: number): void {
    this.targets.choose('inbox', id, entries.map((e) => e.id), now);
  }

  /** j/k: the next or previous entry in the queue, stopping at its ends. */
  move(by: 1 | -1, entries: readonly InboxEntry[], now: number): void {
    const at = entries.indexOf(this.selected(entries, now)!);
    const next = entries[Math.max(0, Math.min(entries.length - 1, at + by))];
    if (next) this.choose(next.id, entries, now);
  }

  armed(entries: readonly InboxEntry[], now: number): boolean {
    return this.targets.armed('inbox', entries.map((e) => e.id), now);
  }
}

export { KEY_GRACE_MS };

// ---- Keys ----

export type InboxCommand =
  | { do: 'move'; by: 1 | -1 }
  | { do: 'send'; messages: WebviewMessage[] }
  /** Allow the selected request the way its card says: its scope, held when careful. */
  | { do: 'allow' }
  /** The next scope on its card. */
  | { do: 'scope' }
  /** Put the cursor in "Or tell … instead". */
  | { do: 'reply' }
  /** Open the chat at the request. */
  | { do: 'open' }
  /** Leave the inbox (nothing selected). */
  | { do: 'close' }
  /** Ask to confirm allowing every identical routine request. */
  | { do: 'batch' }
  /** An answer key while the selection is new (the grace period): it does nothing. */
  | { do: 'wait' };

export interface InboxKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * What a key does to the selected entry. j/k (or the arrows) move; Enter (or a) allows with the card's
 * scope, held for a careful request; Esc (or d) denies; Tab moves the scope; Shift+Enter (or b) asks
 * to allow every identical routine request; Cmd/Ctrl+D opens the full diff; r replies instead; o opens
 * the chat; 1–9 answer a question. `armed` is false for the grace period after the selection
 * changed: an answer key then does nothing, so a key already on its way can't answer a request you
 * haven't seen. null: not the inbox's key.
 */
export function inboxKey(e: InboxKeyEvent, entry: InboxEntry | undefined, armed: boolean, entries: readonly InboxEntry[] = []): InboxCommand | null {
  const answer = (c: InboxCommand): InboxCommand => (armed ? c : { do: 'wait' });
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'd') {
    const diff = entry && entryActions(entry).diff;
    return diff ? { do: 'send', messages: [diff] } : null;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'j' || e.key === 'ArrowDown') return { do: 'move', by: 1 };
  if (e.key === 'k' || e.key === 'ArrowUp') return { do: 'move', by: -1 };
  if (!entry) return e.key === 'Escape' ? { do: 'close' } : null;
  if (e.key === 'o') return { do: 'open' };
  if (e.key === 'r' && entry.item.kind !== 'question') return { do: 'reply' };
  const actions = entryActions(entry);
  if (e.key === 'Tab' && !e.shiftKey) return entry.item.kind === 'question' ? null : { do: 'scope' };
  if ((e.key === 'Enter' && e.shiftKey) || e.key === 'b') return batchable(entries, entry).length >= 2 ? answer({ do: 'batch' }) : null;
  if (e.key === 'Enter') {
    if (actions.primary === 'open') return { do: 'open' };
    return answer(actions.primary === 'allow' ? { do: 'allow' } : { do: 'send', messages: [actions.primary] });
  }
  if (e.key === 'a') return actions.allow ? answer({ do: 'allow' }) : null;
  if (e.key === 'Escape' || e.key === 'd') return actions.deny ? answer({ do: 'send', messages: [actions.deny] }) : null;
  if (/^[1-9]$/.test(e.key)) {
    const m = actions.choices[Number(e.key) - 1]?.message;
    return m ? answer({ do: 'send', messages: [m] }) : null;
  }
  return null;
}

/** Keys while "Allow all N" asks to confirm: Enter or a allows them all once, d denies them all, Esc goes back. */
export function confirmKey(e: InboxKeyEvent, armed: boolean): 'allow' | 'deny' | 'cancel' | 'wait' | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'Escape') return 'cancel';
  const answer = e.key === 'Enter' || e.key === 'a' ? 'allow' : e.key === 'd' ? 'deny' : null;
  return answer && (armed ? answer : 'wait');
}

// ---- What was answered lately ----

export interface Answered {
  id: string;
  chatId: string;
  kind: InboxKind;
  title: string;
  /** "Yes", "Denied", "Answered: Redis". */
  outcome: string;
  /** Yes, or no. */
  allowed: boolean;
  at?: number;
}

function outcome(i: Waiting): { text: string; allowed: boolean } | undefined {
  if (i.kind === 'permission') return i.answer && !i.auto ? { text: i.answer, allowed: !/^(no|reject|deny|cancel|stopped)/i.test(i.answer) } : undefined;
  if (i.kind === 'review') return i.state !== 'pending' && !i.auto ? { text: i.state === 'accepted' ? 'Accepted' : 'Rejected', allowed: i.state === 'accepted' } : undefined;
  if (i.kind === 'command') return i.state !== 'awaiting' && !i.auto ? { text: i.state === 'denied' ? 'Denied' : 'Ran', allowed: i.state !== 'denied' } : undefined;
  if (i.kind === 'bridge') return i.state !== 'awaiting' && !i.auto ? { text: i.state === 'allowed' ? 'Allowed' : 'Denied', allowed: i.state === 'allowed' } : undefined;
  return i.state !== 'awaiting' ? { text: i.state === 'answered' ? `Answered${i.summary ? `: ${i.summary}` : ''}` : 'Skipped', allowed: i.state === 'answered' } : undefined;
}

/** The requests you answered lately (not the ones a rule or an approval level answered), newest first. History only: nothing here can be undone. */
export function answered(state: Pick<AppState, 'chats'>, limit = 8): Answered[] {
  const out: Answered[] = [];
  for (const chat of openChats(state.chats)) {
    if (chat.readOnly) continue;
    for (const i of chat.items) {
      if (!isWaitingKind(i)) continue;
      const o = outcome(i);
      const d = o && decisionOf(state, chat, i);
      if (!o || !d) continue;
      out.push({ id: d.id, chatId: chat.id, kind: kindOf(i), title: rowTitle(state, chat, i, d.title), outcome: o.text, allowed: o.allowed, ...(i.at !== undefined ? { at: i.at } : {}) });
    }
  }
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, limit);
}
