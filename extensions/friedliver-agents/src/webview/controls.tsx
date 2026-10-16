// The chat's session controls (approval level, model, effort, the agent's own
// modes), the usage meter, and the cards that show what an agent asks to do
// and what its tools did. Shared by the chat view and the Agent Manager.
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { DiffLine } from '../shared/diff';
import { AGENT_FACES, waitingItems, type AgentKey, type ChatView, type Item } from '../shared/model';
import { describeRule, ruleCandidates } from '../shared/rules';
import {
  APPROVAL_HINTS,
  APPROVAL_LEVELS,
  APPROVAL_NAMES,
  choiceName,
  formatCost,
  formatTokens,
  modeClass,
  modeFor,
  modeOption,
  optionGroups,
  optionKey,
  planToggle,
  planning,
  reportedMode,
  usagePercent,
  type AgentDefaults,
  type ApprovalLevel,
  type ChatSession,
  type SessionOption,
  type Usage,
} from '../shared/session';
import { ESCALATING, OPTION_KINDS, denyOption, primaryOption, type PermissionDetail, type ProposedFile, type ToolOut } from '../shared/tools';
import { Dot, Glyph, Icon, Markdown, Popover, basename, memo, send } from './common';

type Permission = Extract<Item, { kind: 'permission' }>;
type Tool = Extract<Item, { kind: 'tool' }>;

const LEVEL_TONE: Record<ApprovalLevel, string> = { ask: 'quiet', edits: 'edits', full: 'full' };

type ControlsProps = { chat: ChatView; compact?: boolean };

/** Approval level, model and effort, as chips under the message box. Drawn again only when they change, not per streamed chunk. */
export const SessionControls = memo(
  SessionControlsView,
  (a: ControlsProps, b: ControlsProps) =>
    a.compact === b.compact &&
    a.chat.id === b.chat.id &&
    a.chat.session === b.chat.session &&
    a.chat.approval === b.chat.approval &&
    a.chat.label === b.chat.label &&
    a.chat.agent === b.chat.agent,
);

function SessionControlsView({ chat, compact }: ControlsProps) {
  const session = chat.session;
  const { model, effort, modelConfig, other } = optionGroups(session);
  const later = session && !session.live ? ` Applies when ${chat.label} starts.` : '';
  return (
    <span class="session-controls">
      <ApprovalMenu chat={chat} compact={compact} />
      {model && <OptionMenu chat={chat} option={model} extra={[...modelConfig, ...other]} icon="model" later={later} />}
      {!model && (modelConfig.length > 0 || other.length > 0) && <OptionMenu chat={chat} option={[...modelConfig, ...other][0]} extra={[...modelConfig, ...other].slice(1)} icon="model" later={later} />}
      {effort && <OptionMenu chat={chat} option={effort} extra={[]} icon="gauge" later={later} />}
    </span>
  );
}

/**
 * FriedLiver's levels (Ask, Auto-accept edits, Full auto), Plan, and the
 * agent's own modes. The chip reads the level; its color, the mode the agent
 * reports, so a mode FriedLiver didn't choose can't go unseen.
 */
export function ApprovalMenu({ chat, compact }: { chat: ChatView; compact?: boolean }) {
  const level = chat.approval ?? 'ask';
  const mode = modeOption(chat.session);
  const reported = reportedMode(chat.session);
  const plan = planToggle(chat.session);
  const inPlan = planning(chat.session);
  const name = inPlan ? 'Plan' : APPROVAL_NAMES[level];
  const agent = AGENT_FACES[chat.agent].name;
  const title = `${name}: ${inPlan ? 'plans first, changes nothing' : APPROVAL_HINTS[level]}.${reported ? ` ${agent}'s mode: ${reported.name}.` : ''} Shift+Tab switches.`;
  const tone = inPlan ? 'plan' : reported?.tone === 'full' || reported?.tone === 'auto' ? reported.tone : LEVEL_TONE[level];
  return (
    <Popover
      label="How much the agent may do without asking"
      title={title}
      buttonClass="chip-btn approval-chip"
      class="chip-pop"
      trigger={
        <>
          <span class="chip-tone" data-tone={tone} aria-hidden="true" />
          <Icon name={level === 'full' && !inPlan ? 'bolt' : 'shield'} />
          {!compact && <span class="chip-text">{name}</span>}
          <Icon name="chevron" />
        </>
      }
    >
      {(close) => (
        <>
          <div class="pop-title" aria-hidden="true">
            How much {chat.label} may do without asking
          </div>
          {APPROVAL_LEVELS.map((l) => {
            const agentMode = modeFor(chat.agent, mode, l);
            const modeName = mode?.choices.find((c) => c.value === agentMode)?.name;
            return (
              <button
                key={l}
                role="menuitemradio"
                aria-checked={!inPlan && level === l}
                class={l === 'full' ? 'menu-full' : undefined}
                onClick={() => {
                  close();
                  send({ type: 'approval', chatId: chat.id, level: l });
                }}
              >
                <span class="menu-check" aria-hidden="true">
                  {!inPlan && level === l && <Icon name="check" />}
                </span>
                <span class="menu-label">{APPROVAL_NAMES[l]}</span>
                <span class="menu-sub">{modeName ? `${agent}: ${modeName}` : APPROVAL_HINTS[l]}</span>
              </button>
            );
          })}
          {plan && (
            <button
              role="menuitemcheckbox"
              aria-checked={inPlan}
              onClick={() => {
                close();
                send({ type: 'plan', chatId: chat.id, on: !inPlan });
              }}
            >
              <span class="menu-check" aria-hidden="true">
                {inPlan && <Icon name="check" />}
              </span>
              <span class="menu-label">Plan first</span>
              <span class="menu-sub">Plans and asks before it changes anything</span>
            </button>
          )}
          {mode && mode.type === 'select' && mode.choices.length > 0 && (
            <>
              <div class="pop-title" aria-hidden="true">
                {agent}'s own modes
              </div>
              {mode.choices.map((c) => {
                const cls = modeClass(c);
                return (
                  <button
                    key={c.value}
                    role="menuitemradio"
                    aria-checked={mode.current === c.value}
                    title={c.description}
                    class={cls === 'full' || cls === 'auto' ? 'menu-full' : undefined}
                    onClick={() => {
                      close();
                      send({ type: 'setOption', chatId: chat.id, optionId: mode.id, value: c.value });
                    }}
                  >
                    <span class="menu-check" aria-hidden="true">
                      {mode.current === c.value && <Icon name="check" />}
                    </span>
                    <span class="menu-label">{c.name}</span>
                    {c.description && <span class="menu-sub">{c.description}</span>}
                  </button>
                );
              })}
            </>
          )}
        </>
      )}
    </Popover>
  );
}

/** One setting as a chip (Model, Effort), with related ones (Fast mode) in the same menu. */
function OptionMenu({ chat, option, extra, icon, later }: { chat: ChatView; option: SessionOption; extra: SessionOption[]; icon: 'model' | 'gauge'; later: string }) {
  const current = choiceName(option) ?? '';
  const on = extra.filter((o) => (o.type === 'boolean' ? o.current === true : /^on$/i.test(String(o.current))));
  return (
    <Popover
      label={option.name}
      title={`${option.name}: ${current}${on.length ? ` · ${on.map((o) => o.name).join(', ')}` : ''}.${later}`}
      buttonClass="chip-btn"
      class="chip-pop"
      trigger={
        <>
          <Icon name={icon} />
          <span class="chip-text">{current}</span>
          {on.length > 0 && <Icon name="bolt" />}
          <Icon name="chevron" />
        </>
      }
    >
      {(close) => (
        <div class="pop-scroll">
          <OptionChoices chat={chat} option={option} close={close} />
          {extra.map((o) => (
            <div key={o.id} class="pop-section">
              <OptionChoices chat={chat} option={o} close={close} titled />
            </div>
          ))}
        </div>
      )}
    </Popover>
  );
}

function OptionChoices({ chat, option, close, titled }: { chat: ChatView; option: SessionOption; close(refocus?: boolean): void; titled?: boolean }) {
  const set = (value: string | boolean) => {
    close();
    send({ type: 'setOption', chatId: chat.id, optionId: option.id, value });
  };
  if (option.type === 'boolean') {
    return (
      <button role="menuitemcheckbox" aria-checked={option.current === true} title={option.description} onClick={() => set(option.current !== true)}>
        <span class="menu-check" aria-hidden="true">
          {option.current === true && <Icon name="check" />}
        </span>
        <span class="menu-label">{option.name}</span>
        {option.description && <span class="menu-sub">{option.description}</span>}
      </button>
    );
  }
  const rows: ComponentChildren[] = [];
  let group: string | undefined;
  for (const c of option.choices) {
    if (c.group && c.group !== group && !titled) {
      rows.push(
        <div key={`g:${c.group}`} class="pop-group" aria-hidden="true">
          {c.group}
        </div>,
      );
    }
    group = c.group;
    rows.push(
      <button key={c.value} role="menuitemradio" aria-checked={option.current === c.value} title={c.description} onClick={() => set(c.value)}>
        <span class="menu-check" aria-hidden="true">
          {option.current === c.value && <Icon name="check" />}
        </span>
        <span class="menu-label">{c.name}</span>
        {c.description && <span class="menu-sub">{c.description}</span>}
      </button>,
    );
  }
  return (
    <>
      <div class="pop-title" aria-hidden="true" title={option.description}>
        {option.name}
      </div>
      {rows}
    </>
  );
}

/** How full the agent's context is, and what the session cost, when the agent says. */
export const UsageMeter = memo(function UsageMeter({ usage, compact }: { usage?: Usage; compact?: boolean }) {
  if (!usage) return null;
  const pct = usagePercent(usage);
  const level = pct >= 90 ? 'high' : pct >= 75 ? 'warn' : undefined;
  const cost = usage.cost ? formatCost(usage.cost) : '';
  const title = `Context: ${formatTokens(usage.used)} of ${formatTokens(usage.size)} tokens (${pct}%)${cost ? ` · ${cost} so far` : ''}${level ? '. Nearly full: /compact or a new chat clears it.' : ''}`;
  return (
    <span class="usage" data-level={level} title={title} role="img" aria-label={title}>
      <span class="usage-bar" aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </span>
      {!compact && <span>{pct}%</span>}
      {!compact && cost && <span class="usage-cost">{cost}</span>}
    </span>
  );
});

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
          <pre class="cmdline">
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
      {item.options.map((o) => {
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
          <Icon name={/^(no|reject|deny|cancel|stopped)/i.test(item.answer) ? 'close' : 'check'} /> {item.title}{' '}
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
        <Glyph agent={chat.agent} size="sm" /> {chat.label} asks
        {item.toolKind && <span class="tag">{KIND_WORDS[item.toolKind] ?? item.toolKind}</span>}
      </div>
      <div class="ask-body">{item.title}</div>
      <PermissionDetailView detail={item.detail} requestId={item.requestId} open />
      <div class="actions">
        <PermissionOptions item={item} />
        {command && item.toolKind === 'execute' && <AlwaysAllow line={command} target={{ requestId: item.requestId }} />}
      </div>
      {deny && (
        <div class="hint keys" aria-hidden="true">
          Ctrl+Enter {primaryOption(item.options) ? 'yes' : ''} · Ctrl+Shift+Backspace no · Alt+1–{Math.min(9, item.options.length)} picks
        </div>
      )}
    </section>
  );
}

const KIND_WORDS: Record<string, string> = { execute: 'command', edit: 'edit', switch_mode: 'plan', read: 'read', fetch: 'web', delete: 'delete', move: 'move', search: 'search', think: 'think' };

/** What a tool call did: its diffs and output, and its input on request. Failed calls open by themselves. */
export function ToolDetails({ tool }: { tool: Tool }) {
  const [showInput, setShowInput] = useState(false);
  const out = (tool.out ?? []).filter((o): o is Exclude<ToolOut, { t: 'terminal' }> => o.t !== 'terminal');
  return (
    <div class="tool-out">
      {out.map((o, n) =>
        o.t === 'diff' ? (
          <div key={n} class="file-change">
            <div class="file-line">
              <button class="ref" title={o.path} onClick={() => send({ type: 'openFile', path: o.path })}>
                {basename(o.path)}
              </button>
              <span class="stats">
                <span class="plus">+{o.added}</span> <span class="minus">−{o.removed}</span>
              </span>
            </div>
            {o.lines.length > 0 && <DiffView lines={o.lines} more={o.more} />}
          </div>
        ) : (
          <pre key={n} class="output tool-text">
            {o.text}
          </pre>
        ),
      )}
      {tool.input && (
        <>
          <button class="link sm-link" aria-expanded={showInput} onClick={() => setShowInput(!showInput)}>
            {showInput ? 'Hide input' : 'Show input'}
          </button>
          {showInput && <pre class="output tool-text">{tool.input}</pre>}
        </>
      )}
    </div>
  );
}

export const hasDetails = (t: Tool) => !!t.input || !!t.out?.some((o) => o.t !== 'terminal');

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
    <div class="edits-bar" role="group" aria-label="Edits waiting">
      <Icon name="diff" />
      <span>
        {waiting} edit{waiting === 1 ? '' : 's'} waiting
      </span>
      <span class="spacer" />
      <button class="sm" title="Accept these and the rest of this turn's edits (Ctrl+Alt+Shift+Y)" onClick={() => send({ type: 'reviewAll', chatId: chat.id, action: 'accept' })}>
        <Icon name="check" /> Accept all
      </button>
      <button class="ghost danger sm" title="Reject these and the rest of this turn's edits" onClick={() => send({ type: 'reviewAll', chatId: chat.id, action: 'reject' })}>
        Reject all
      </button>
    </div>
  );
}

/** The first thing the chat waits on, as the actions a shortcut takes. */
export function waitingActions(chat: ChatView): { approve(): void; deny(): void; pick(n: number): void } | null {
  for (const i of waitingItems(chat.items)) {
    if (i.kind === 'permission' && !i.answer) {
      const answer = (o?: { optionId: string }) => o && send({ type: 'permission', requestId: i.requestId, optionId: o.optionId });
      return { approve: () => answer(primaryOption(i.options)), deny: () => answer(denyOption(i.options)), pick: (n) => answer(i.options[n]) };
    }
    if (i.kind === 'review' && i.state === 'pending') {
      return { approve: () => send({ type: 'review', reviewId: i.reviewId, action: 'accept' }), deny: () => send({ type: 'review', reviewId: i.reviewId, action: 'reject' }), pick: () => {} };
    }
    if (i.kind === 'command' && i.state === 'awaiting') {
      return { approve: () => send({ type: 'command', commandId: i.commandId, approve: true }), deny: () => send({ type: 'command', commandId: i.commandId, approve: false }), pick: () => {} };
    }
    if (i.kind === 'question' && i.state === 'awaiting') {
      const only = i.fields.length === 1 && i.fields[0].type === 'choice' ? i.fields[0] : undefined;
      return {
        approve: () => {},
        deny: () => send({ type: 'answerQuestion', requestId: i.requestId, action: 'decline' }),
        pick: (n) => only?.options?.[n] && send({ type: 'answerQuestion', requestId: i.requestId, action: 'accept', values: { [only.key]: only.options[n].value } }),
      };
    }
    if (i.kind === 'bridge' && i.state === 'awaiting') {
      return { approve: () => send({ type: 'bridge', requestId: i.requestId, answer: 'allow' }), deny: () => send({ type: 'bridge', requestId: i.requestId, answer: 'deny' }), pick: () => {} };
    }
  }
  return null;
}

/**
 * Keys for the waiting decision: Ctrl/Cmd+Enter says the loud yes,
 * Ctrl/Cmd+Shift+Backspace says no, Alt+1–9 picks an agent's option. Only
 * while the message box is empty, so typing is never taken over.
 */
export function decisionKey(e: KeyboardEvent, chat: ChatView, composerEmpty: boolean): boolean {
  if (!composerEmpty) return false;
  const actions = waitingActions(chat);
  if (!actions) return false;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && e.key === 'Enter') actions.approve();
  else if (mod && e.shiftKey && e.key === 'Backspace') actions.deny();
  else if (e.altKey && !mod && /^Digit[1-9]$/.test(e.code)) actions.pick(Number(e.code.slice(5)) - 1);
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
        <Glyph agent={chat.agent} size="sm" /> {chat.label} asks you
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
