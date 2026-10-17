// The chat's session controls (approval level, model, effort, the agent's own
// modes), the usage meter, and the cards that show what an agent asks to do
// and what its tools did. Shared by the chat view and the Agent Manager.
import { useState } from 'preact/hooks';
import type { DiffLine } from '../shared/diff';
import { AGENT_FACES, waitingItems, type AgentKey, type ChatView, type Item } from '../shared/model';
import { describeRule, ruleCandidates } from '../shared/rules';
import {
  optionKey,
  reportedMode,
  type AgentDefaults,
  type ChatSession,
} from '../shared/session';
import { ESCALATING, OPTION_KINDS, denyOption, primaryOption, type PermissionDetail, type ProposedFile } from '../shared/tools';
import { Dot, Glyph, Icon, Markdown, Popover, StepLabel, basename, longTitle, send } from './common';

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
    <span class="auto-badge" title="Full auto: edits and commands go through without asking">
      <Icon name="bolt" />
      {!short && 'Full auto'}
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
    <Popover label="Always allow" title="Run this without asking from now on, in this workspace" buttonClass="ghost sm" trigger={<>Always allow…</>}>
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
    <section class="ask" id={`item-${item.requestId}`} aria-label={`${chat.label} asks`}>
      <div class="ask-head">
        <Dot state="needs-you" />
        Needs your OK
        {item.toolKind && <span class="tag">{KIND_WORDS[item.toolKind] ?? item.toolKind}</span>}
      </div>
      <div class="ask-body">{longTitle(item.title) ? <StepLabel title={item.title} toolKind={item.toolKind} cmd={item.detail?.command} /> : item.title}</div>
      <PermissionDetailView detail={item.detail} requestId={item.requestId} open />
      <div class="actions">
        <PermissionOptions item={item} />
        {command && item.toolKind === 'execute' && <AlwaysAllow line={command} target={{ requestId: item.requestId }} />}
      </div>
      {deny && (
        <div class="hint keys" aria-hidden="true">
          1–{Math.min(9, item.options.length)} picks · Ctrl+Enter {primaryOption(item.options) ? 'yes' : ''} · Ctrl+Shift+Backspace no
        </div>
      )}
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
          {q.text && <div class="bubble-text">{q.text}</div>}
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

/** The first thing the chat waits on, as the actions a shortcut takes. */
export function waitingActions(chat: ChatView): { approve(): void; deny(): void; pick(n: number): boolean } | null {
  for (const i of waitingItems(chat.items)) {
    if (i.kind === 'permission' && !i.answer) {
      const answer = (o?: { optionId: string }) => o && send({ type: 'permission', requestId: i.requestId, optionId: o.optionId });
      return { approve: () => answer(primaryOption(i.options)), deny: () => answer(denyOption(i.options)), pick: (n) => (i.options[n] ? (answer(i.options[n]), true) : false) };
    }
    if (i.kind === 'review' && i.state === 'pending') {
      return { approve: () => send({ type: 'review', reviewId: i.reviewId, action: 'accept' }), deny: () => send({ type: 'review', reviewId: i.reviewId, action: 'reject' }), pick: () => false };
    }
    if (i.kind === 'command' && i.state === 'awaiting') {
      return { approve: () => send({ type: 'command', commandId: i.commandId, approve: true }), deny: () => send({ type: 'command', commandId: i.commandId, approve: false }), pick: () => false };
    }
    if (i.kind === 'question' && i.state === 'awaiting') {
      const only = i.fields.length === 1 && i.fields[0].type === 'choice' ? i.fields[0] : undefined;
      return {
        approve: () => {},
        deny: () => send({ type: 'answerQuestion', requestId: i.requestId, action: 'decline' }),
        pick: (n) => {
          const choice = only?.options?.[n];
          if (!only || !choice) return false;
          send({ type: 'answerQuestion', requestId: i.requestId, action: 'accept', values: { [only.key]: choice.value } });
          return true;
        },
      };
    }
    if (i.kind === 'bridge' && i.state === 'awaiting') {
      return { approve: () => send({ type: 'bridge', requestId: i.requestId, answer: 'allow' }), deny: () => send({ type: 'bridge', requestId: i.requestId, answer: 'deny' }), pick: () => false };
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
  if (mod && !e.shiftKey && e.key === 'Enter') actions.approve();
  else if (mod && e.shiftKey && e.key === 'Backspace') actions.deny();
  else if (!mod && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
    // A digit with nothing to pick types as usual.
    if (!actions.pick(Number(e.code.slice(5)) - 1)) return false;
  }
  else return false;
  e.preventDefault();
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
                <select key={o.id} class="mini-select" aria-label={`${AGENT_FACES[agent].name} ${o.name}`} title={`${o.name} for ${AGENT_FACES[agent].name}`} value={value} onChange={(e) => onChange(agent, key, e.currentTarget.value)}>
                  {o.choices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.name}
                    </option>
                  ))}
                </select>
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

/** A question as a small form: choices as buttons, a box for anything typed. */
export function QuestionCard({ item, chat }: { item: Question; chat: ChatView }) {
  const [values, setValues] = useState<Values>({});
  if (item.state !== 'awaiting') {
    return (
      <div class="answered">
        <Icon name={item.state === 'answered' ? 'check' : 'close'} /> {item.message.split('\n')[0]}{' '}
        <span class="hint">· {item.state === 'answered' ? (item.summary ?? 'answered') : 'declined'}</span>
      </div>
    );
  }
  const set = (key: string, v: Values[string] | undefined) => setValues((all) => {
    const next = { ...all };
    if (v === undefined || v === '') delete next[key];
    else next[key] = v;
    return next;
  });
  const missing = item.fields.some((f) => f.required && values[f.key] === undefined);
  const answer = (v: Values) => send({ type: 'answerQuestion', requestId: item.requestId, action: 'accept', values: v });
  // One question with one set of choices answers with a click.
  const only = item.fields.length === 1 && item.fields[0].type === 'choice' ? item.fields[0] : undefined;
  return (
    <section class="ask question" id={`item-${item.requestId}`} aria-label={`${chat.label} asks you`}>
      <div class="ask-head">
        <Dot state="needs-you" />
        <Glyph agent={chat.agent} size="sm" /> {AGENT_FACES[chat.agent].name} asks you
      </div>
      <div class="ask-body">
        <Markdown text={item.message} />
      </div>
      {item.fields.map((f) => (
        <div key={f.key} class="q-field" role="group" aria-label={f.title}>
          {(item.fields.length > 1 || f.type !== 'choice') && (
            <div class="q-title">
              {f.title}
              {f.required && <span class="hint"> · needed</span>}
            </div>
          )}
          {f.description && <div class="hint">{f.description}</div>}
          {f.type === 'choice' && (
            <div class="actions">
              {f.options!.map((o, n) => (
                <button
                  key={o.value}
                  class={`sm ${values[f.key] === o.value ? 'decide' : ''}`}
                  aria-pressed={values[f.key] === o.value}
                  title={o.description ?? (only && n < 9 ? `Alt+${n + 1}` : undefined)}
                  onClick={() => (only ? answer({ [f.key]: o.value }) : set(f.key, values[f.key] === o.value ? undefined : o.value))}
                >
                  {o.title}
                </button>
              ))}
            </div>
          )}
          {f.type === 'multi' && (
            <div class="actions">
              {f.options!.map((o) => {
                const picked = Array.isArray(values[f.key]) && (values[f.key] as string[]).includes(o.value);
                return (
                  <label key={o.value} class="check" title={o.description}>
                    <input
                      type="checkbox"
                      checked={picked}
                      onChange={() => {
                        const list = (Array.isArray(values[f.key]) ? (values[f.key] as string[]) : []).filter((x) => x !== o.value);
                        set(f.key, picked ? list : [...list, o.value]);
                      }}
                    />{' '}
                    {o.title}
                  </label>
                );
              })}
            </div>
          )}
          {f.type === 'text' && <input class="q-input" type="text" value={String(values[f.key] ?? '')} maxLength={10_000} onInput={(e) => set(f.key, e.currentTarget.value)} />}
          {f.type === 'number' && <input class="q-input" type="number" value={String(values[f.key] ?? '')} onInput={(e) => set(f.key, e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))} />}
          {f.type === 'boolean' && (
            <label class="check">
              <input type="checkbox" checked={values[f.key] === true} onChange={(e) => set(f.key, e.currentTarget.checked)} /> Yes
            </label>
          )}
        </div>
      ))}
      <div class="actions">
        {(!only || item.fields.length > 1 || Object.keys(values).length > 0) && (
          <button class="decide sm" disabled={missing} onClick={() => answer(values)}>
            Answer
          </button>
        )}
        <button class="ghost danger sm" onClick={() => send({ type: 'answerQuestion', requestId: item.requestId, action: 'decline' })}>
          Skip
        </button>
      </div>
    </section>
  );
}
