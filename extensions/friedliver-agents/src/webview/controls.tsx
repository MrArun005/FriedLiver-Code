// The chat's session controls (approval level, model, effort, the agent's own
// modes), the usage meter, and the cards that show what an agent asks to do
// and what its tools did. Shared by the chat view and the Agent Manager.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { DiffLine } from '../shared/diff';
import { AGENT_FACES, waitingItems, type AgentKey, type ChatView, type Item } from '../shared/model';
import { describeRule, ruleCandidates } from '../shared/rules';
import {
  optionKey,
  reportedMode,
  type AgentDefaults,
  type ChatSession,
} from '../shared/session';
import { DecisionTargets } from '../shared/decisionTarget';
import { questionGroups, recommended, type QuestionField } from '../shared/questions';
import { ESCALATING, OPTION_KINDS, denyOption, primaryOption, type PermissionDetail, type ProposedFile } from '../shared/tools';
import { ClampedText, Dot, Glyph, Icon, Markdown, Popover, StepLabel, basename, longTitle, send } from './common';

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


/** The mode the agent says it is in, loud when it runs without asking. */
export function ModeBadge({ session, agent }: { session?: ChatSession; agent: AgentKey }) {
  const mode = reportedMode(session);
  if (!mode) return null;
  return (
    <span class="mode-badge" data-tone={mode.tone} title={`${AGENT_FACES[agent].name} reports its mode: ${mode.name}`}>
      {mode.name}
    </span>
  );
}

/** Full auto, on every surface that shows the chat. */
export function AutoBadge({ chat, short }: { chat: Pick<ChatView, 'approval'>; short?: boolean }) {
  if (chat.approval !== 'full') return null;
  return (
    <span class="auto-badge" title="Auto: edits and commands go through without asking">
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
          {file.isNew && <span class="tag">new</span>}
          <span class="stats">
            <span class="plus">+{file.added}</span> <span class="minus">−{file.removed}</span>
          </span>
        </button>
        {requestId && file.full && (
          <button class="ghost sm" title="See the whole file with this change, read-only" onClick={() => send({ type: 'permissionDiff', requestId, path: file.path })}>
            Open diff
          </button>
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
            <button key={l} class="ref" title={l} onClick={() => send({ type: 'openFile', path: l })}>
              {basename(l)}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Buttons for an agent's options: the first plain one-time allow is the loud one; mode changes never are. */
export function PermissionOptions({ item, compact }: { item: Permission; compact?: boolean }) {
  const primary = primaryOption(item.options);
  return (
    <>
      {item.options.map((o, i) => {
        const escalates = ESCALATING.test(o.name) || o.kind === 'allow_always';
        const cls = o === primary ? 'decide' : o.kind.startsWith('reject') ? 'ghost danger' : escalates ? 'escalate' : '';
        const always = o.kind.endsWith('_always') && !/always|again|don['’]t ask/i.test(o.name);
        return (
          <button
            key={o.optionId}
            class={`sm ${cls}`}
            title={`${OPTION_KINDS[o.kind] ?? o.kind}${escalates && o.kind.startsWith('allow') ? `. ${ESCALATING.test(o.name) ? 'Changes how the agent asks from now on.' : ''}` : ''}${o === primary && !compact ? ' (Ctrl+Enter)' : ''}`}
            onClick={() => send({ type: 'permission', requestId: item.requestId, optionId: o.optionId })}
          >
            {!compact && i < 9 && <span class="opt-num">{i + 1}.</span>}
            {o.name}
            {always && <span class="tag">always</span>}
          </button>
        );
      })}
    </>
  );
}

/** "Always allow" for a command: the exact line, or the program and its subcommand. Never for chained lines. */
export function AlwaysAllow({ line, target }: { line: string; target: { requestId: string } | { commandId: string } }) {
  const rules = ruleCandidates(line);
  if (!rules.length) return null;
  return (
    <Popover label="Always allow" title="Run this without asking from now on, in this workspace" buttonClass="link always-allow" trigger={<>Always allow…</>}>
      {(close) => (
        <>
          <div class="pop-title" aria-hidden="true">
            Run without asking in this workspace
          </div>
          {rules.map((rule) => (
            <button
              key={rule.kind}
              role="menuitem"
              onClick={() => {
                close();
                send({ type: 'allowAlways', ...target, rule });
              }}
            >
              <span class="menu-label mono">{describeRule(rule)}</span>
              <span class="menu-sub">{rule.kind === 'exact' ? 'this exact command' : 'and anything after it'}</span>
            </button>
          ))}
        </>
      )}
    </Popover>
  );
}

/** A permission request: what it would do, and the agent's own answers. */
export function PermissionCard({ item, chat }: { item: Permission; chat: ChatView }) {
  if (item.answer) {
    return (
      <div class="answered-block">
        <div class="answered">
          <Icon name={/^(no|reject|deny|cancel|stopped)/i.test(item.answer) ? 'close' : 'check'} />{' '}
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
  const command = item.detail?.command?.line;
  const deny = denyOption(item.options);
  return (
    <section class="ask" id={`item-${item.requestId}`} aria-label={`${chat.label} asks`} {...chooseOn(chat, item.requestId)}>
      <div class="ask-head">
        <Dot state="needs-you" />
        Needs your OK
        {item.toolKind && <span class="tag">{KIND_WORDS[item.toolKind] ?? item.toolKind}</span>}
      </div>
      {/* The command shows in full below; a title that only repeats it says what it is instead. */}
      <div class="ask-body">
        {command && command.trim() === item.title.trim() ? 'Run this command' : longTitle(item.title) ? <StepLabel title={item.title} toolKind={item.toolKind} cmd={item.detail?.command} /> : item.title}
      </div>
      <PermissionDetailView detail={item.detail} requestId={item.requestId} open />
      <div class="actions">
        <PermissionOptions item={item} />
        {command && item.toolKind === 'execute' && <AlwaysAllow line={command} target={{ requestId: item.requestId }} />}
      </div>
      {deny && <KeyHint chat={chat} id={item.requestId} n={item.options.length} yes={!!primaryOption(item.options)} />}
    </section>
  );
}

const KIND_WORDS: Record<string, string> = { execute: 'command', edit: 'edit', switch_mode: 'plan', read: 'read', fetch: 'web', delete: 'delete', move: 'move', search: 'search', think: 'think' };

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
            <span class="tag">
              <Icon name="queue" /> queued{q.images ? ` · ${q.images} image${q.images === 1 ? '' : 's'}` : ''}
            </span>
            <span class="spacer" />
            {now && (
              <button class="ghost sm" title={chat.busy ? `Give it to ${chat.label} while it works` : 'Send it now'} onClick={() => send({ type: 'steer', chatId: chat.id, id: q.id })}>
                <Icon name="send" /> {now}
              </button>
            )}
            <button class="ghost icon-btn sm" title="Don't send" aria-label="Remove from the queue" onClick={() => send({ type: 'unqueue', chatId: chat.id, id: q.id })}>
              <Icon name="close" />
            </button>
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
      <button class="sm" title="Accept these and the rest of this turn's edits (Ctrl+Alt+Shift+Y)" onClick={() => send({ type: 'reviewAll', chatId: chat.id, action: 'accept' })}>
        Accept all
      </button>
      <button class="sm" title="Reject these and the rest of this turn's edits" onClick={() => send({ type: 'reviewAll', chatId: chat.id, action: 'reject' })}>
        Reject all
      </button>
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

const MAC = /Mac/.test(navigator.platform);

/** Where the keys act: the hint shows on that card only. `n` options are numbered 1–n. */
export function KeyHint({ chat, id, n, yes = true, no = 'no' }: { chat: ChatView; id: string; n: number; yes?: boolean; no?: string }) {
  // Always laid out, shown only on the marked card: marking another card never moves anything under the pointer.
  const on = useDecisionTarget(chat) === id;
  return (
    <div class="hint keys" data-on={on ? '' : undefined} aria-hidden="true">
      Press 1–{Math.min(9, n)} to choose{yes ? ` · ${MAC ? '⌘↩' : 'Ctrl+Enter'} yes` : ''} · {MAC ? '⌘⇧⌫' : 'Ctrl+Shift+Backspace'} {no}
    </div>
  );
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
      const order = ['allow', 'allowChat', 'deny'] as const;
      return { approve: () => answer('allow'), deny: () => answer('deny'), pick: (n) => (order[n] ? (answer(order[n]), true) : false) };
    }
  }
  return null;
}

/**
 * Keys for the waiting decision: Ctrl/Cmd+Enter says the loud yes,
 * Ctrl/Cmd+Shift+Backspace says no, 1–9 (or Alt+1–9) picks an agent's option. Only
 * while the message box is empty, so typing is never taken over.
 */
export function decisionKey(e: KeyboardEvent, chat: ChatView, composerEmpty: boolean): boolean {
  if (!composerEmpty) return false;
  const actions = waitingActions(chat);
  if (!actions) return false;
  const mod = e.ctrlKey || e.metaKey;
  // A digit is the character typed (any layout), or Alt+digit by its key position (macOS turns Alt+1 into ¡).
  const digit = !mod && /^[1-9]$/.test(e.key) ? Number(e.key) : !mod && e.altKey && /^Digit[1-9]$/.test(e.code) ? Number(e.code.slice(5)) : 0;
  const kind = mod && !e.shiftKey && e.key === 'Enter' ? 'approve' : mod && e.shiftKey && e.key === 'Backspace' ? 'deny' : digit ? 'pick' : null;
  if (!kind) return false;
  // While a decision waits, the key is for it, never typed. Just after the marked card changed, it does nothing.
  e.preventDefault();
  if (!targets.armed(chat.id, waitingIds(chat), Date.now())) return true;
  if (kind === 'approve') actions.approve();
  else if (kind === 'deny') actions.deny();
  else actions.pick(digit - 1);
  return true;
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
          <span key={agent} class="task-options" role="group" aria-label={`${AGENT_FACES[agent].name} settings`}>
            {agents.length > 1 && <Glyph agent={agent} size="sm" />}
            {pick.map((o) => {
              const key = optionKey(o);
              const value = String(choices[agent]?.[key] ?? defaults[agent]?.chosen[key] ?? o.current);
              return (
                <Popover
                  key={o.id}
                  label={`${o.name} for ${AGENT_FACES[agent].name}`}
                  title={`${AGENT_FACES[agent].name} ${o.name}: ${o.choices.find((c) => c.value === value)?.name ?? value}`}
                  buttonClass="mini-select"
                  trigger={
                    <>
                      <span class="chip-text">{o.choices.find((c) => c.value === value)?.name ?? value}</span>
                      <Icon name="chevron" />
                    </>
                  }
                >
                  {(close) =>
                    o.choices.map((c) => (
                      <button
                        key={c.value}
                        role="menuitemradio"
                        aria-checked={c.value === value}
                        data-value={c.value}
                        title={c.description}
                        onClick={() => {
                          close();
                          onChange(agent, key, c.value);
                        }}
                      >
                        <span class="grow">{c.name}</span>
                        {c.value === value && <Icon name="check" />}
                      </button>
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
        <Icon name={item.state === 'answered' ? 'check' : 'close'} /> {item.state === 'answered' ? `Answered: ${item.summary ?? 'sent'}` : 'Skipped'}
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
    <section class="ask question" id={`item-${item.requestId}`} aria-label={`${chat.label} asks you`} {...chooseOn(chat, item.requestId)} onKeyDown={onCardKey}>
      <div class="q-head">
        <span class="chip q-chip">{g.field.title}</span>
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
              <button
                key={o.value}
                type="button"
                class="q-opt"
                role={g.field.type === 'multi' ? 'checkbox' : 'option'}
                aria-checked={g.field.type === 'multi' ? picked(o.value) : undefined}
                aria-selected={g.field.type === 'multi' ? undefined : picked(o.value)}
                data-picked={picked(o.value) ? '' : undefined}
                onMouseEnter={() => setActive(n)}
                onFocus={() => setActive(n)}
                onClick={() => pick(o.value)}
              >
                {g.field.type === 'multi' ? <span class="q-check">{picked(o.value) && <Icon name="check" />}</span> : <span class="q-num">{n < 9 ? n + 1 : ''}</span>}
                <span class="q-opt-text">
                  <span class="q-opt-label">
                    {label}
                    {rec && <span class="tag q-rec">Recommended</span>}
                  </span>
                  {o.description && <span class="q-opt-desc">{o.description}</span>}
                </span>
              </button>
            ))}
            {g.other &&
              (other === null ? (
                <button type="button" class="q-opt q-opt-other" role={g.field.type === 'multi' ? 'button' : 'option'} onClick={() => setOther('')}>
                  <span class="q-num">{options.length < 9 ? options.length + 1 : ''}</span>
                  <span class="q-opt-text">
                    <span class="q-opt-label">Other…</span>
                  </span>
                </button>
              ) : (
                <div class="q-other">
                  <input
                    type="text"
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
          <button type="button" class="ghost sm" onClick={() => (setStep(step - 1), setOther(null), setActive(0))}>
            Back
          </button>
        )}
        <span class="spacer" />
        <button type="button" class="ghost sm" onClick={skip} title="Esc">
          Skip
        </button>
        {(!last || g.field.type !== 'choice') && (
          <button type="button" class="primary sm" onClick={() => next(values)}>
            {last ? 'Submit' : 'Next'}
          </button>
        )}
      </div>
      <KeyHint chat={chat} id={item.requestId} n={options.length + (g.other ? 1 : 0)} yes={false} no="skip" />
    </section>
  );
}

const isTypingIn = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

/** A question that isn't a choice: a text, number or yes/no field. */
function FieldInput({ field, value, onChange }: { field: QuestionField; value: Values[string] | undefined; onChange(v: Values[string] | undefined): void }) {
  if (field.type === 'boolean')
    return (
      <label class="check">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.currentTarget.checked)} /> Yes
      </label>
    );
  if (field.type === 'number')
    return (
      <input
        class="q-input"
        type="number"
        aria-label={field.title}
        value={String(value ?? '')}
        onInput={(e) => onChange(e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))}
      />
    );
  return (
    <input class="q-input" type="text" aria-label={field.title} value={String(value ?? '')} maxLength={10_000} onInput={(e) => onChange(e.currentTarget.value)} />
  );
}
