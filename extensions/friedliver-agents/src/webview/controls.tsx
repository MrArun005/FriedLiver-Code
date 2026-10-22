// The chat's session controls (approval level, model, effort, the agent's own
// modes), the usage meter, and the cards that show what an agent asks to do
// and what its tools did. Shared by the chat view and the Agent Manager.
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { batchMessages, batchable, inbox } from '../shared/inbox';
import type { DiffLine } from '../shared/diff';
import { agentFace, EXPIRED, waitingItems, type AgentKey, type AppState, type ChatView, type Item } from '../shared/model';
import { approvalOf, type Approvable } from '../shared/approval';
import { ApprovalCard, cardKeys } from './approval';
import {
  defaultChoices,
  optionKey,
  reportedMode,
  type AgentDefaults,
  type ChatSession,
} from '../shared/session';
import { DecisionTargets } from '../shared/decisionTarget';
import { questionGroups, recommended, type QuestionField } from '../shared/questions';
import { denyOption, primaryOption, type PermissionDetail, type ProposedFile } from '../shared/tools';
import { ClampedText, LiveState, Glyph, Icon, Markdown, Popover, StepLabel, basename, longTitle, send } from './common';
import { agentName } from '../shared/names';
import { Button, Checkbox, ChoiceRow, FileRef, IconButton, Input, MenuItem, Pill, selectTrigger } from './ui';

type Permission = Extract<Item, { kind: 'permission' }>;







const samplesByChat = new Map<string, { turns: number; samples: number[] }>();

/**
 * The context used after each finished turn of a chat, seen by this webview
 * (it starts over when the view reloads). The same array until a turn ends.
 */
export function usageSamples(chat: Pick<ChatView, 'id' | 'turns' | 'session'>): number[] {
  const used = chat.session?.usage?.used;
  const seen = samplesByChat.get(chat.id) ?? { turns: chat.turns, samples: chat.turns > 0 && used !== undefined ? [used] : [] };
  if (chat.turns !== seen.turns && used !== undefined) {
    seen.turns = chat.turns;
    seen.samples = [...seen.samples, used].slice(-6);
  }
  samplesByChat.set(chat.id, seen);
  return seen.samples;
}


/** A reported mode's pill tone: plan the info blue, the modes that don't ask the error red. */
const MODE_TONES: Record<string, 'info' | 'error' | 'muted'> = { plan: 'info', auto: 'error', full: 'error', edits: 'muted' };

/** The mode the agent says it is in, loud when it runs without asking. */
export function ModeBadge({ session, agent }: { session?: ChatSession; agent: AgentKey }) {
  const mode = reportedMode(session);
  if (!mode) return null;
  return (
    <span class="fl-pill mode-badge" data-tone={MODE_TONES[mode.tone] ?? "muted"} title={`${agentFace(agent).name} reports its mode: ${mode.name}`}>
      {mode.name}
    </span>
  );
}

/** Full auto, on every surface that shows the chat. */
export function AutoBadge({ chat, short }: { chat: Pick<ChatView, 'approval'>; short?: boolean }) {
  if (chat.approval !== 'full') return null;
  return (
    <span class="fl-pill auto-badge" data-tone="error" title="Auto: edits and commands go through without asking">
      <Icon name="bolt" />
      {!short && 'Auto'}
    </span>
  );
}

// ---- What is asked, and what tools did ----

export function DiffView({ lines, more }: { lines: DiffLine[]; more?: number }) {
  return (
    <div class="diff" role="group" aria-label="Changed lines">
      {lines.map((l, n) => (
        <div key={n} class="dl" data-op={l.op === '+' ? 'add' : l.op === '-' ? 'del' : 'ctx'}>
          <span class="dl-op" aria-hidden="true">
            {l.op}
          </span>
          <span class="dl-text">{l.text || ' '}</span>
        </div>
      ))}
      {!!more && <div class="dl dl-more">… {more} more changed line{more === 1 ? '' : 's'}</div>}
    </div>
  );
}

function FileChange({ file, requestId, open: startOpen }: { file: ProposedFile; requestId?: string; open: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <div class="file-change">
      <div class="file-line">
        <button class="file-row" aria-expanded={open} title={file.path} onClick={() => setOpen(!open)}>
          <Icon name="file" /> <span class="file-name">{basename(file.path)}</span>
          {file.isNew && <span class="fl-pill" data-tone="muted">new</span>}
          <span class="stats">
            <span class="plus">+{file.added}</span> <span class="minus">−{file.removed}</span>
          </span>
        </button>
        {requestId && file.full && (
          <Button variant="quiet" size="sm" title="See the whole file with this change, read-only" onClick={() => send({ type: 'permissionDiff', requestId, path: file.path })}>
            Open diff
          </Button>
        )}
      </div>
      {open && file.lines.length > 0 && <DiffView lines={file.lines} more={file.more} />}
    </div>
  );
}

/** The diff, the command and its folder, the plan: what saying yes would do. */
export function PermissionDetailView({ detail, requestId, open }: { detail?: PermissionDetail; requestId?: string; open: boolean }) {
  if (!detail) return null;
  return (
    <>
      {detail.command && (
        <>
          <pre class={`cmdline${detail.command.line.includes('\n') ? ' lines' : ''}`}>
            <span class="prompt">$ </span>
            {detail.command.line}
          </pre>
          {detail.command.cwd && (
            <div class="hint mono" title={detail.command.cwd}>
              in {detail.command.cwd}
            </div>
          )}
        </>
      )}
      {detail.files?.map((f) => <FileChange key={f.path} file={f} requestId={requestId} open={open && (detail.files?.length ?? 0) <= 3} />)}
      {detail.plan && (
        <div class="plan-text">
          <Markdown text={detail.plan} />
        </div>
      )}
      {detail.text && <div class="quote ask-text">{detail.text}</div>}
      {detail.locations && detail.locations.length > 0 && (
        <div class="files">
          {detail.locations.map((l) => (
            <FileRef key={l} path={l} onOpen={() => send({ type: 'openFile', path: l })} />
          ))}
        </div>
      )}
    </>
  );
}

/** A permission request: what it would do, and the agent's own answers. */
export function PermissionCard({ item, chat }: { item: Permission; chat: ChatView }) {
  if (item.answer) {
    return (
      <div class="answered-block">
        <div class="answered">
          <Icon name={item.expired ? 'clock' : /^(no|reject|deny|cancel|stopped)/i.test(item.answer) ? 'close' : 'check'} />{' '}
          {longTitle(item.title) ? <StepLabel title={item.title} toolKind={item.toolKind} cmd={item.detail?.command} /> : item.title}{' '}
          <span class="hint">
            · {item.answer}
            {item.auto ? ` · ${item.auto}` : ''}
          </span>
        </div>
        {item.detail?.files && item.detail.files.length > 0 && (
          <div class="answered-files">
            <PermissionDetailView detail={{ files: item.detail.files }} requestId={item.requestId} open={false} />
          </div>
        )}
      </div>
    );
  }
  return <WaitingCard item={item} chat={chat} />;
}

/** A request waiting in the chat at its weight, ringed when the keys act on it; a routine one offers Allow all for its identical twins. */
export function WaitingCard({ item, chat, state }: { item: Approvable; chat: ChatView; state?: Pick<AppState, 'chats'> }) {
  const id = decisionId(item)!;
  const on = useDecisionTarget(chat) === id;
  const live = useContext(LiveState);
  const batch = useMemo(() => {
    const box = inbox(live);
    const entry = box.entries.find((e) => e.id === id);
    const same = entry ? batchable(box.entries, entry) : [];
    return same.length >= 2 ? { count: same.length, chats: new Set(same.map((e) => e.chatId)).size, messages: batchMessages(same, 'allow') } : undefined;
  }, [live, id]);
  return <ApprovalCard item={item} chat={chat} state={state ?? live} on={on} batch={batch} frame={chooseOn(chat, id)} />;
}


/** Messages waiting for the agent to finish; Send now joins the running turn where the agent allows it. */
export function QueueList({ chat }: { chat: ChatView }) {
  if (!chat.queue?.length) return null;
  const now = chat.busy ? (chat.session?.steering ? 'Send now' : undefined) : 'Send';
  return (
    <>
      {chat.queue.map((q) => (
        <div key={q.id} class="bubble queued" aria-label="Queued message">
          {q.text && <ClampedText text={q.text} />}
          <div class="queued-bar">
            <span class="fl-pill" data-tone="muted">
              <Icon name="queue" /> queued{q.images ? ` · ${q.images} image${q.images === 1 ? '' : 's'}` : ''}
            </span>
            <span class="spacer" />
            {now && (
              <Button variant="quiet" icon="send" size="sm" title={chat.busy ? `Give it to ${agentName(chat.agent)} while it works` : 'Send it now'} onClick={() => send({ type: 'steer', chatId: chat.id, id: q.id })}>
                {now}
              </Button>
            )}
            <IconButton icon="close" label="Remove from the queue" muted size="sm" title="Don't send" onClick={() => send({ type: 'unqueue', chatId: chat.id, id: q.id })} />
          </div>
        </div>
      ))}
    </>
  );
}

/** Edits waiting in a busy chat: decide them, and the rest of the turn's, at once. */
export function EditsBar({ chat }: { chat: ChatView }) {
  if (!chat.busy) return null;
  const waiting = waitingItems(chat.items).filter((i) => i.kind === 'review' || (i.kind === 'permission' && (i.toolKind === 'edit' || !!i.detail?.files?.length))).length;
  if (!waiting || !chat.busy) return null;
  return (
    <div class="banner edits-bar" role="group" aria-label="Edits waiting">
      <span class="banner-text">
        {waiting} edit{waiting === 1 ? '' : 's'} waiting
      </span>
      <span class="spacer" />
      <Button size="sm" title="Accept these and the rest of this turn's edits (Ctrl+Alt+Shift+Y)" onClick={() => send({ type: 'reviewAll', chatId: chat.id, action: 'accept' })}>
        Accept all
      </Button>
      <Button size="sm" title="Reject these and the rest of this turn's edits" onClick={() => send({ type: 'reviewAll', chatId: chat.id, action: 'reject' })}>
        Reject all
      </Button>
    </div>
  );
}

// ---- Which card the decision keys act on ----

/** A waiting item's id, as its card's element id carries it (item-<id>). */
export function decisionId(i: Item): string | undefined {
  if (i.kind === 'permission' && !i.answer) return i.requestId;
  if (i.kind === 'review' && i.state === 'pending') return i.reviewId;
  if (i.kind === 'command' && i.state === 'awaiting') return i.commandId;
  if ((i.kind === 'question' || i.kind === 'bridge') && i.state === 'awaiting') return i.requestId;
  return undefined;
}

/** Per chat, the card the keys act on (shared/decisionTarget.ts: marked card only, never retargeted by an arrival). */
const targets = new DecisionTargets();
const targetWatchers = new Set<() => void>();
const lastShown = new Map<string, string | undefined>();

const waitingIds = (chat: ChatView): string[] => waitingItems(chat.items).flatMap((i) => decisionId(i) ?? []);

/** The card the keys act on: the one marked on screen (oldest waiting until you pick another). */
export function decisionTarget(chat: ChatView): Item | undefined {
  const id = targets.target(chat.id, waitingIds(chat), Date.now())?.id;
  return id === undefined ? undefined : waitingItems(chat.items).find((i) => decisionId(i) === id);
}

/** Redraws the cards when the marked card changed (it was answered, or another was chosen). */
export function syncDecisionTarget(chat: ChatView): void {
  const id = targets.target(chat.id, waitingIds(chat), Date.now())?.id;
  if (lastShown.get(chat.id) === id) return;
  lastShown.set(chat.id, id);
  for (const w of targetWatchers) w();
}

/** You clicked or focused a card: the keys act on it (after the grace period) while it waits. */
export function chooseDecision(chat: ChatView, id: string): void {
  targets.choose(chat.id, id, waitingIds(chat), Date.now());
  syncDecisionTarget(chat);
}

export function useDecisionTarget(chat: ChatView): string | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    const w = () => bump((n) => n + 1);
    targetWatchers.add(w);
    return () => void targetWatchers.delete(w);
  }, []);
  const target = decisionTarget(chat);
  return target && decisionId(target);
}


/** A decision card's frame: clicking or focusing in it makes it the one the keys act on. */
export function chooseOn(chat: ChatView, id: string) {
  return { onMouseDown: () => chooseDecision(chat, id), onFocusIn: () => chooseDecision(chat, id) };
}

/** The card the keys act on, as the actions a shortcut takes. */
export function waitingActions(chat: ChatView): { approve(): void; deny(): void; pick(n: number): boolean } | null {
  const target = decisionTarget(chat);
  for (const i of target ? [target] : []) {
    if (i.kind === 'permission' && !i.answer) {
      const answer = (o?: { optionId: string }) => o && send({ type: 'permission', requestId: i.requestId, optionId: o.optionId });
      return { approve: () => answer(primaryOption(i.options)), deny: () => answer(denyOption(i.options)), pick: (n) => (i.options[n] ? (answer(i.options[n]), true) : false) };
    }
    if (i.kind === 'review' && i.state === 'pending') {
      const accept = () => send({ type: 'review', reviewId: i.reviewId, action: 'accept' });
      const reject = () => send({ type: 'review', reviewId: i.reviewId, action: 'reject' });
      return { approve: accept, deny: reject, pick: (n) => (n === 0 ? (accept(), true) : n === 1 ? (reject(), true) : false) };
    }
    if (i.kind === 'command' && i.state === 'awaiting') {
      const run = (approve: boolean) => send({ type: 'command', commandId: i.commandId, approve });
      return { approve: () => run(true), deny: () => run(false), pick: (n) => (n === 0 ? (run(true), true) : n === 1 ? (run(false), true) : false) };
    }
    if (i.kind === 'question' && i.state === 'awaiting') {
      // The card on screen knows its step: 1–9 pick there, Ctrl/Cmd+Enter confirms it.
      const card = () => questionKeys.get(i.requestId);
      return {
        approve: () => card()?.confirm(),
        deny: () => send({ type: 'answerQuestion', requestId: i.requestId, action: 'decline' }),
        pick: (n) => card()?.pick(n) ?? false,
      };
    }
    if (i.kind === 'bridge' && i.state === 'awaiting') {
      const answer = (a: 'allow' | 'allowChat' | 'deny') => send({ type: 'bridge', requestId: i.requestId, answer: a });
      const order = i.once ? (['allow', 'deny'] as const) : (['allow', 'allowChat', 'deny'] as const);
      return { approve: () => answer('allow'), deny: () => answer('deny'), pick: (n) => (order[n] ? (answer(order[n]), true) : false) };
    }
  }
  return null;
}

/**
 * Keys for the waiting decision, only while the message box is empty so typing is never taken over:
 * Enter (or Ctrl/Cmd+Enter) allows with the card's scope, and a careful request only while held;
 * Esc (or Ctrl/Cmd+Shift+Backspace) says no; Tab moves the scope; Ctrl/Cmd+D opens the full diff.
 * A question keeps 1–9 to pick and Ctrl/Cmd+Enter to confirm.
 */
export function decisionKey(e: KeyboardEvent, chat: ChatView, composerEmpty: boolean): boolean {
  if (!composerEmpty || e.isComposing) return false;
  const target = decisionTarget(chat);
  const actions = waitingActions(chat);
  if (!target || !actions) return false;
  const id = decisionId(target)!;
  const card = cardKeys.get(id);
  const question = target.kind === 'question';
  const mod = e.ctrlKey || e.metaKey;
  // A digit is the character typed (any layout), or Alt+digit by its key position (macOS turns Alt+1 into ¡).
  const digit = question && !mod && /^[1-9]$/.test(e.key) ? Number(e.key) : question && !mod && e.altKey && /^Digit[1-9]$/.test(e.code) ? Number(e.code.slice(5)) : 0;
  const kind =
    e.key === 'Enter' && e.shiftKey && !mod && !e.altKey && card && !question
      ? 'batch'
      : e.key === 'Enter' && !e.shiftKey && !e.altKey && (mod || !question)
      ? 'approve'
      : (e.key === 'Escape' && !mod && !e.shiftKey && !e.altKey) || (mod && e.shiftKey && e.key === 'Backspace')
        ? 'deny'
        : e.key === 'Tab' && !e.shiftKey && !mod && !e.altKey && card
          ? 'scope'
          : mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'd' && card
            ? 'diff'
            : digit
              ? 'pick'
              : null;
  if (!kind) return false;
  // While a decision waits, the key is for it, never typed.
  e.preventDefault();
  if (kind === 'scope') return card!.cycle(), true;
  if (kind === 'diff') return card!.diff(), true;
  // A held Enter repeats: the hold is already running (or the request was already answered).
  if (e.repeat) return true;
  // Just after the marked card changed, the answer keys do nothing.
  if (!targets.armed(chat.id, waitingIds(chat), Date.now())) return true;
  if (kind === 'batch') card!.batch();
  else if (kind === 'approve') {
    if (card && !question) card.press();
    // Without its card on screen, only what isn't careful: a careful request is allowed by holding on its card.
    else if (question || !approvalOf(target as Approvable, chat).hold) actions.approve();
  } else if (kind === 'deny') {
    if (card && !question) card.deny();
    else actions.deny();
  }
  else actions.pick(digit - 1);
  return true;
}

/** Enter let go: a hold not yet done drains back. */
export function decisionKeyUp(e: KeyboardEvent, chat: ChatView): void {
  if (e.key !== 'Enter') return;
  const target = decisionTarget(chat);
  const id = target && decisionId(target);
  if (id) cardKeys.get(id)?.release();
}

// ---- The Agent Manager's new task ----

/** Model and effort per agent for a new task, from each agent's last session, keyed like the host remembers them. */
export function TaskOptions({
  agents,
  defaults,
  choices,
  onChange,
}: {
  agents: AgentKey[];
  defaults: Partial<Record<AgentKey, AgentDefaults>>;
  choices: Partial<Record<AgentKey, Record<string, string | boolean>>>;
  onChange(agent: AgentKey, key: string, value: string): void;
}) {
  return (
    <>
      {agents.map((agent) => {
        const known = defaults[agent]?.options ?? [];
        const pick = known.filter((o) => (o.category === 'model' || o.category === 'thought_level') && o.type === 'select' && o.choices.length > 0);
        if (!pick.length) return null;
        return (
          <span key={agent} class="task-options" role="group" aria-label={`${agentFace(agent).name} settings`}>
            {agents.length > 1 && <Glyph agent={agent} size="sm" />}
            {pick.map((o) => {
              const key = optionKey(o);
              const value = String(choices[agent]?.[key] ?? defaultChoices(defaults[agent])[key] ?? o.current);
              return (
                <Popover
                  key={o.id}
                  label={`${o.name} for ${agentFace(agent).name}`}
                  title={`${agentFace(agent).name} ${o.name}: ${o.choices.find((c) => c.value === value)?.name ?? value}`}
                  buttonClass="fl-select fl-select--sm"
                  trigger={selectTrigger(o.choices.find((c) => c.value === value)?.name ?? value)}
                >
                  {(close) =>
                    o.choices.map((c) => (
                      <MenuItem
                        key={c.value}
                        label={c.name}
                        checked={c.value === value}
                        value={c.value}
                        title={c.description}
                        onSelect={() => {
                          close();
                          onChange(agent, key, c.value);
                        }}
                      />
                    ))
                  }
                </Popover>
              );
            })}
          </span>
        );
      })}
    </>
  );
}

// ---- Questions the agent asks as a form ----

type Question = Extract<Item, { kind: 'question' }>;
type Values = Record<string, string | number | boolean | string[]>;

/** What the decision keys do to the question card on screen: set while it is shown, by its request id. */
const questionKeys = new Map<string, { pick(n: number): boolean; confirm(): void }>();

/**
 * An agent's question, Claude Code style: one question at a time ("1 of 3", Back/Next), each a header chip,
 * the question, and its options as full-width numbered rows with their descriptions. One choice answers on
 * click; several picks submit; "Other…" opens a box (Enter sends, Esc closes); an option's preview shows
 * beside the list (under it when narrow). Answered, it folds to one muted line.
 */
export function QuestionCard({ item, chat }: { item: Question; chat: ChatView }) {
  const groups = useMemo(() => questionGroups(item.fields), [item.fields]);
  const on = useDecisionTarget(chat) === item.requestId;
  const [values, setValues] = useState<Values>({});
  const [step, setStep] = useState(0);
  const [other, setOther] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const otherBox = useRef<HTMLInputElement>(null);
  // "Other…" opens its box focused.
  const otherOpen = other !== null;
  useLayoutEffect(() => {
    if (otherOpen) otherBox.current?.focus();
  }, [otherOpen]);
  const g = groups[Math.min(step, groups.length - 1)];
  const choice = g?.field.type === 'choice' || g?.field.type === 'multi';
  // Claude's pick first, its "(Recommended)" shown as a tag.
  const options = useMemo(
    () => (g?.field.options ?? []).map((o) => ({ o, ...recommended(o.title) })).sort((a, b) => Number(b.recommended) - Number(a.recommended)),
    [g],
  );
  const last = step >= groups.length - 1;
  const submit = (v: Values) => send({ type: 'answerQuestion', requestId: item.requestId, action: 'accept', values: v });
  const skip = () => send({ type: 'answerQuestion', requestId: item.requestId, action: 'decline' });
  const next = (v: Values) => {
    if (last) return submit(v);
    setValues(v);
    setStep(step + 1);
    setOther(null);
    setActive(0);
  };
  const without = (v: Values, ...keys: (string | undefined)[]) => Object.fromEntries(Object.entries(v).filter(([k]) => !keys.includes(k))) as Values;
  const picked = (value: string) => (g.field.type === 'multi' ? Array.isArray(values[g.field.key]) && (values[g.field.key] as string[]).includes(value) : values[g.field.key] === value);
  // One choice answers (or moves on) at once; a multi-select toggles.
  const pick = (value: string) => {
    if (g.field.type === 'multi') {
      const now = (Array.isArray(values[g.field.key]) ? (values[g.field.key] as string[]) : []).filter((x) => x !== value);
      setValues({ ...without(values, g.field.key), ...(picked(value) ? (now.length ? { [g.field.key]: now } : {}) : { [g.field.key]: [...now, value] }) });
      return;
    }
    next({ ...without(values, g.other?.key), [g.field.key]: value });
  };
  const sendOther = (typed: string) => {
    if (!typed.trim() || !g.other) return;
    next({ ...(g.field.type === 'multi' ? values : without(values, g.field.key)), [g.other.key]: typed.trim() });
  };
  useEffect(() => {
    if (item.state !== 'awaiting' || !g) return;
    questionKeys.set(item.requestId, {
      pick: (n) => {
        const o = options[n];
        if (o) pick(o.o.value);
        else if (n === options.length && g.other) setOther('');
        return !!o || (n === options.length && !!g.other);
      },
      confirm: () => next(values),
    });
    return () => void questionKeys.delete(item.requestId);
  });
  if (item.state !== 'awaiting') {
    return (
      <div class="answered q-answered">
        <Icon name={item.expired ? 'clock' : item.state === 'answered' ? 'check' : 'close'} /> {item.expired ? `Question · ${EXPIRED}` : item.state === 'answered' ? `Answered: ${item.summary ?? 'sent'}` : 'Skipped'}
      </div>
    );
  }
  if (!g) return null;
  const preview = options[active]?.o.preview ?? options.find((x) => picked(x.o.value))?.o.preview;
  const hasPreview = options.some((x) => x.o.preview);
  const question = groups.length > 1 ? (g.field.description ?? item.message) : item.message;
  const rows = () => [...(list.current?.querySelectorAll<HTMLElement>('.q-opt') ?? [])];
  const onListKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const all = rows();
    const at = all.indexOf(document.activeElement as HTMLElement);
    all[(at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
  };
  const onCardKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || isTypingIn(e.target)) return;
    e.preventDefault();
    skip();
  };
  return (
    <section class="fl-card fl-card--bare apv question" data-enter="" data-focus={on ? '' : undefined} id={`item-${item.requestId}`} aria-label={`${agentName(chat.agent)} asks you`} {...chooseOn(chat, item.requestId)} onKeyDown={onCardKey}>
      <div class="q-head">
        <Pill class="q-chip">{g.field.title}</Pill>
        {groups.length > 1 && (
          <span class="q-step" aria-live="polite">
            {step + 1} of {groups.length}
          </span>
        )}
      </div>
      <div class="q-question">
        <Markdown text={question} />
      </div>
      <div class={`q-body${hasPreview ? ' with-preview' : ''}`}>
        {choice ? (
          <div class="q-options" ref={list} role={g.field.type === 'multi' ? 'group' : 'listbox'} aria-label={g.field.title} onKeyDown={onListKey}>
            {options.map(({ o, label, recommended: rec }, n) => (
              <ChoiceRow
                key={o.value}
                class="q-opt"
                multi={g.field.type === 'multi'}
                selected={picked(o.value)}
                data-picked={picked(o.value) ? '' : undefined}
                onMouseEnter={() => setActive(n)}
                onFocus={() => setActive(n)}
                onPick={() => pick(o.value)}
                label={
                  <>
                    {label}{' '}
                    {rec && (
                      <Pill tone="info" class="q-rec">
                        Recommended
                      </Pill>
                    )}
                  </>
                }
                desc={o.description}
                kbd={n < 9 ? String(n + 1) : undefined}
              />
            ))}
            {g.other &&
              (other === null ? (
                <ChoiceRow action class="q-opt q-opt-other" multi={g.field.type === 'multi'} selected={false} label="Other…" kbd={options.length < 9 ? String(options.length + 1) : undefined} onPick={() => setOther('')} />
              ) : (
                <div class="q-other">
                  <Input
                    value={other}
                    placeholder="Type your answer, then Enter"
                    aria-label={`Other answer to ${g.field.title}`}
                    maxLength={10_000}
                    ref={otherBox}
                    onInput={(e) => setOther(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        sendOther(other);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        setOther(null);
                      }
                    }}
                  />
                </div>
              ))}
          </div>
        ) : (
          <FieldInput field={g.field} value={values[g.field.key]} onChange={(v) => setValues(v === undefined || v === '' ? without(values, g.field.key) : { ...values, [g.field.key]: v })} />
        )}
        {hasPreview && (
          <div class="q-preview" aria-label="Preview">
            {preview ? <pre class="code">{preview}</pre> : <span class="hint">No preview for this option</span>}
          </div>
        )}
      </div>
      <div class="q-foot">
        {step > 0 && (
          <Button variant="quiet" onClick={() => (setStep(step - 1), setOther(null), setActive(0))}>
            Back
          </Button>
        )}
        <span class="spacer" />
        <Button variant="quiet" kbd="Esc" onClick={skip}>
          Skip
        </Button>
        {(!last || g.field.type !== 'choice') && (
          <Button variant={on ? 'brand' : 'secondary'} kbd="⌘⏎" onClick={() => next(values)}>
            {last ? 'Submit' : 'Next'}
          </Button>
        )}
      </div>
    </section>
  );
}

const isTypingIn = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

/** A question that isn't a choice: a text, number or yes/no field. */
function FieldInput({ field, value, onChange }: { field: QuestionField; value: Values[string] | undefined; onChange(v: Values[string] | undefined): void }) {
  if (field.type === 'boolean')
    return (
      <Checkbox checked={value === true} onChange={onChange}>
        Yes
      </Checkbox>
    );
  if (field.type === 'number')
    return (
      <Input
        class="q-input"
        type="number"
        aria-label={field.title}
        value={String(value ?? '')}
        onInput={(e) => onChange(e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))}
      />
    );
  return (
    <Input class="q-input" aria-label={field.title} value={String(value ?? '')} maxLength={10_000} onInput={(e) => onChange(e.currentTarget.value)} />
  );
}
