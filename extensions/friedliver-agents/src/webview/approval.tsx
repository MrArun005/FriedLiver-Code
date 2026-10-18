// Approvals, drawn the same in the chat, on Agent Manager cards and in the Inbox (shared/approval.ts
// is the model). Two weights, by risk:
// - Routine: one sentence row (C): the verb and target, a "once ▾" scope token, Deny and Allow; with
//   friedliver.approvals.autoRoutineSeconds on, a draining countdown you can stop.
// - Review and careful: a compact card (A): one header row (who, verb, mono target, risk chip, then
//   Deny and the split button "Allow once ⏎ │ ▾", whose menu names the exact rule for Once, This chat
//   and Always), the preview under it. A sensitive path gets a plain "Allow once" and a lock line. A
//   careful request is red-toned, lists what would be lost and a safer way, is once only, and allows
//   on a press-and-hold.
// Drawn with the design system's components (src/webview/ui, COMPONENTS.md): Button, SplitButton, the hold
// Button, Segmented, Pill, Countdown, MenuItem and the Card classes.
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { SCOPES, SCOPE_NAMES, allowMessage, approvalOf, commandLine, nextScope, primaryLabel, scopeRule, type Approvable, type Approval, type Scope } from '../shared/approval';
import { Hold } from '../shared/hold';
import type { WebviewMessage } from '../shared/messages';
import { AGENT_FACES, type AppState, type ChatView } from '../shared/model';
import { siteOrigin } from '../shared/permissions';
import { relativePath } from '../shared/view';
import { CopyButton, Glyph, Icon, Markdown, Popover, basename, send, useNow, type IconName } from './common';
import { DiffView } from './controls';
import { Button, Countdown as Drain, Kbd, MenuItem, MenuSep, MenuTitle, Pill, Segmented, SplitButton, cx, type Variant } from './ui';

/** What the decision keys do to a request on screen, by its id: set while it is shown. */
export interface CardKeys {
  /** Enter down: allow with the chosen scope, or start the hold. */
  press(): void;
  /** Enter up: a hold not yet done drains back. */
  release(): void;
  /** Tab: the next scope that can be chosen. */
  cycle(): void;
  /** Cmd/Ctrl+D: the full diff, where there is one. */
  diff(): boolean;
  /** Esc: stops a countdown first, then says no. */
  deny(): void;
  /** Shift+Enter: allow every identical routine request (false: there is no batch). */
  batch(): boolean;
}
export const cardKeys = new Map<string, CardKeys>();

const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const MOD = MAC ? '⌘' : 'Ctrl+';

/** `code` in a rule set in mono; the rest as text. */
function Ticks({ text }: { text: string }) {
  return <>{text.split('`').map((part, n) => (n % 2 ? <code key={n}>{part}</code> : part))}</>;
}

function diffMessage(item: Approvable): WebviewMessage | undefined {
  if (item.kind === 'review') return { type: 'review', reviewId: item.reviewId, action: 'open' };
  const f = item.kind === 'permission' ? item.detail?.files?.find((x) => x.full) : undefined;
  return f && item.kind === 'permission' ? { type: 'permissionDiff', requestId: item.requestId, path: f.path } : undefined;
}

function kindIcon(item: Approvable): IconName {
  if (item.kind === 'command' || (item.kind === 'permission' && item.detail?.command)) return 'terminal';
  if (item.kind === 'review' || (item.kind === 'permission' && item.detail?.files?.length)) return 'file';
  if (item.kind === 'permission') return item.detail?.plan ? 'plan' : item.detail?.url ? 'globe' : 'shield';
  if ('browser' in item.target) return item.tool === 'browser_click' || item.tool === 'browser_type' ? 'pointer' : 'globe';
  return 'memory' in item.target ? 'plan' : 'handoff';
}

export interface ApprovalCardProps {
  item: Approvable;
  chat: ChatView;
  state?: Pick<AppState, 'chats'>;
  /** The request the keys act on: the orange ring and the one brand button. */
  on?: boolean;
  /** Header row only (an Agent Manager card), whatever the risk. */
  compact?: boolean;
  /** Identical routine requests that "Allow all" answers together, this one among them (2 or more). */
  batch?: { count: number; chats: number; messages: WebviewMessage[] };
  /** Under the card in the Inbox: "Or tell … instead". */
  children?: ComponentChildren;
  /** Extra attributes for the frame (chooseOn in the chat). */
  frame?: Record<string, unknown>;
}

/** One request waiting for you, at its weight. */
export function ApprovalCard(props: ApprovalCardProps) {
  const { item, chat, state, on, compact, batch, children, frame } = props;
  const a = useMemo(() => approvalOf(item, chat, state), [item, chat, state]);
  const [scope, setScope] = useState<Scope>('once');
  const [holding, setHolding] = useState(false);
  // A scope the request no longer offers falls back to Once.
  const current: Scope = scope !== 'once' && !allowMessage(a, scope) ? 'once' : scope;
  const allowRef = useRef<(s?: Scope, grant?: number) => void>(() => {});
  allowRef.current = (s = current, grant = 0) => {
    const m = allowMessage(a, s, grant);
    if (m) send(m);
  };
  const hold = useRef<Hold>(undefined);
  hold.current ??= new Hold(() => {
    setHolding(false);
    allowRef.current('once');
  });
  const start = () => {
    if (a.allow.once && hold.current!.start()) setHolding(true);
  };
  const release = () => {
    hold.current!.release();
    setHolding(false);
  };
  useEffect(() => () => hold.current?.release(), []);
  const autoAt = (item.kind === 'permission' || item.kind === 'command') && !a.hold && a.risk.tone === 'routine' ? item.autoAt : undefined;
  const stopAuto = () => send({ type: 'stopAuto', id: a.id });

  const diff = diffMessage(item);
  const keys: CardKeys = {
    press: () => (a.hold ? start() : allowRef.current()),
    release,
    cycle: () => setScope((s) => nextScope(a, s)),
    diff: () => (diff ? (send(diff), true) : false),
    deny: () => (autoAt ? stopAuto() : a.deny && send(a.deny)),
    batch: () => (batch && a.risk.tone === 'routine' ? (batch.messages.forEach(send), true) : false),
  };
  const keysRef = useRef(keys);
  keysRef.current = keys;
  useEffect(() => {
    const k: CardKeys = {
      press: () => keysRef.current.press(),
      release: () => keysRef.current.release(),
      cycle: () => keysRef.current.cycle(),
      diff: () => keysRef.current.diff(),
      deny: () => keysRef.current.deny(),
      batch: () => keysRef.current.batch(),
    };
    cardKeys.set(a.id, k);
    return () => void (cardKeys.get(a.id) === k && cardKeys.delete(a.id));
  }, [a.id]);

  const what = <What a={a} item={item} chat={chat} withChip={a.risk.tone !== 'routine' || !!compact} />;
  const deny = a.deny && (
    <Button variant="quiet" kbd="Esc" onClick={() => send(a.deny!)}>
      {item.kind === 'review' ? 'Reject' : 'Deny'}
    </Button>
  );
  // The request the keys act on gets the one brand button; the others a secondary one.
  const primary: Variant = on ? 'brand' : 'secondary';

  // Routine: one sentence row, with the scope as a token.
  if (a.risk.tone === 'routine' && !compact) {
    return (
      <section class="fl-card fl-card--ghost fl-card--bare apv apv-row" data-enter="" id={`item-${a.id}`} data-risk="routine" data-focus={on ? '' : undefined} aria-label={`${AGENT_FACES[chat.agent].name}: ${a.verb} ${a.target}`.trim()} {...frame}>
        <div class="apv-hd">
          {what}
          <span class="apv-act">
            {autoAt ? (
              <>
                <Button variant="quiet" kbd="Esc" onClick={stopAuto}>
                  Stop
                </Button>
                <Button variant={primary} kbd="⏎" onClick={() => allowRef.current('once')}>
                  Allow now
                </Button>
              </>
            ) : (
              <>
                <ScopeToken a={a} item={item} chat={chat} scope={current} setScope={setScope} />
                {deny}
                <Button variant={primary} kbd="⏎" onClick={() => allowRef.current()}>
                  {a.yes}
                </Button>
              </>
            )}
          </span>
        </div>
        {autoAt && <Countdown at={autoAt} />}
        {batch && !autoAt && <Batch a={a} batch={batch} />}
        {children}
      </section>
    );
  }

  // Review and careful: the compact card.
  const offered = SCOPES.filter((s) => s !== 'once' && allowMessage(a, s));
  return (
    <section
      class="fl-card fl-card--bare apv"
      data-enter=""
      id={`item-${a.id}`}
      data-risk={a.risk.tone}
      data-tone={a.risk.tone === 'careful' ? 'careful' : undefined}
      data-focus={on ? '' : undefined}
      data-compact={compact ? '' : undefined}
      aria-label={`${AGENT_FACES[chat.agent].name}: ${a.verb} ${a.target}`.trim()}
      {...frame}
    >
      <div class="apv-hd">
        {what}
        <span class="apv-act">
          {a.hold && (
            <Pill icon="lock" title={a.risk.lock} class="apv-once">
              once only
            </Pill>
          )}
          {a.others.length > 0 && (
            <Popover label="Other answers" title="The agent's other answers" buttonClass="fl-btn fl-btn--quiet fl-btn--icon fl-btn--muted" align="end" trigger={<Icon name="more" />}>
              {(close) => a.others.map((o) => <MenuItem key={o.label} label={o.label} onSelect={() => (close(), send(o.message))} />)}
            </Popover>
          )}
          {deny}
          {a.hold
            ? a.allow.once && (
                <Button
                  variant="danger"
                  class="fl-btn--hold"
                  data-holding={holding ? '' : undefined}
                  aria-label={`Press and hold to ${a.yes.toLowerCase()}`}
                  onPointerDown={(e) => e.button === 0 && start()}
                  onPointerUp={release}
                  onPointerLeave={release}
                  onPointerCancel={release}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (!e.repeat) start();
                  }}
                  onKeyUp={(e) => (e.key === 'Enter' || e.key === ' ') && release()}
                >
                  <span>
                    Hold <Kbd inline>⏎</Kbd> to {a.yes.toLowerCase()}
                  </span>
                </Button>
              )
            : a.allow.once &&
              (offered.length ? (
                <SplitAllow a={a} item={item} chat={chat} tone={primary} scope={current} allow={(s, g) => allowRef.current(s, g)} />
              ) : (
                <Button variant={primary} kbd="⏎" onClick={() => allowRef.current('once')}>
                  {primaryLabel(a, 'once')}
                </Button>
              ))}
        </span>
      </div>
      {!compact && <Preview a={a} item={item} chat={chat} state={state} diff={diff} />}
      {compact && a.risk.consequences.length > 0 && <Risks a={a} />}
      {a.risk.lock && !a.hold && (
        <div class="apv-lock">
          <Icon name="lock" />
          {a.risk.lock}
        </div>
      )}
      {children}
    </section>
  );
}

/** The kind icon, who, the verb, the target in mono, where, and the risk chip (or, on a routine row, its words). */
function What({ a, item, chat, withChip }: { a: Approval; item: Approvable; chat: ChatView; withChip: boolean }) {
  const full = item.kind === 'command' ? item.commandLine : item.kind === 'permission' ? (item.detail?.command?.line ?? item.title) : a.target;
  const targetAgent = item.kind === 'bridge' && 'agent' in item.target ? item.target.agent : undefined;
  return (
    <span class="apv-what">
      <span class="apv-kind" aria-hidden="true">
        <Icon name={kindIcon(item)} size={14} />
      </span>
      <Glyph agent={chat.agent} size="sm" />
      {targetAgent && (
        <>
          <Icon name="chevron" size={12} />
          <Glyph agent={targetAgent} size="sm" />
        </>
      )}
      {a.verb && <span class="apv-verb">{a.verb}</span>}
      <span class={`apv-tg${a.mono ? ' mono' : ''}`} title={full}>
        {a.target}
      </span>
      {a.where && <span class="apv-wh">{a.where}</span>}
      {withChip ? (
        <Pill tone={a.risk.tone} dot={!(a.risk.lock && a.risk.tone !== 'careful')} icon={a.risk.lock && a.risk.tone !== 'careful' ? 'lock' : undefined} title={a.risk.lock}>
          {a.risk.label}
        </Pill>
      ) : (
        <span class="apv-label">· {a.risk.label.toLowerCase()}</span>
      )}
    </span>
  );
}

/** "Allow once ⏎ │ ▾": the label repeats the scope Tab chose; the menu allows with any scope, each naming its exact rule. */
function SplitAllow({ a, item, chat, tone, scope, allow }: { a: Approval; item: Approvable; chat: ChatView; tone: Variant; scope: Scope; allow(scope: Scope, grant?: number): void }) {
  const rows: { scope: Scope; grant: number; rule?: string; why?: string }[] = [
    { scope: 'once', grant: 0, rule: scopeRule(a, item, chat, 'once') },
    { scope: 'chat', grant: 0, rule: scopeRule(a, item, chat, 'chat'), why: a.locked.chat },
    ...(a.grants.length > 1 && !a.locked.always
      ? a.grants.map((_, n) => ({ scope: 'always' as const, grant: n, rule: scopeRule(a, item, chat, 'always', n) }))
      : [{ scope: 'always' as const, grant: 0, rule: scopeRule(a, item, chat, 'always'), why: a.locked.always }]),
  ];
  return (
    <SplitButton
      variant={tone}
      kbd="⏎"
      onClick={() => allow(scope)}
      menu={(triggerClass) => (
        <Popover label="Allow" title="Once, for this chat or always (Tab picks the default)" buttonClass={cx(triggerClass, 'fl-split-caret')} align="end" trigger={<Icon name="chevronDown" />}>
          {(close) => (
            <>
              <MenuTitle>Allow</MenuTitle>
              {rows.map((r) => (
                <MenuItem
                  key={`${r.scope}${r.grant}`}
                  class="apv-scope-row"
                  checked={r.scope === scope && r.grant === 0}
                  disabled={!r.rule}
                  title={r.why}
                  label={
                    <>
                      {r.scope === 'chat' ? 'For this chat' : SCOPE_NAMES[r.scope]} {!r.rule && <Icon name="lock" size={12} />}
                    </>
                  }
                  desc={r.rule ? <Ticks text={r.rule} /> : r.why}
                  onSelect={() => (close(), allow(r.scope, r.grant))}
                />
              ))}
              <MenuSep />
              <MenuItem label="Manage permissions…" onSelect={() => (close(), send({ type: 'managePermissions' }))} />
            </>
          )}
        </Popover>
      )}
    >
      {primaryLabel(a, scope)}
    </SplitButton>
  );
}

/** C's "once ▾" token: three choices and what the chosen one remembers. Choosing sets the scope; Allow uses it. */
function ScopeToken({ a, item, chat, scope, setScope }: { a: Approval; item: Approvable; chat: ChatView; scope: Scope; setScope(s: Scope): void }) {
  if (!allowMessage(a, 'chat') && !allowMessage(a, 'always')) {
    return (
      <Pill icon="lock" title={a.risk.lock ?? a.locked.always} class="apv-once">
        once only
      </Pill>
    );
  }
  return (
    <Popover
      label="Remember this"
      title="Remember: once, for this chat or always (Tab cycles)"
      kind="dialog"
      align="end"
      buttonClass="fl-btn fl-btn--sm fl-btn--secondary apv-token"
      trigger={
        <>
          {scope === 'chat' ? 'for this chat' : scope}
          <Icon name="chevronDown" />
        </>
      }
    >
      {() => (
        <div class="apv-scope-pop">
          <div class="apv-scope-head">
            <span>Remember this</span>
            <span>
              <kbd>Tab</kbd> cycles
            </span>
          </div>
          <Segmented
            label="Remember"
            block
            value={scope}
            onChange={setScope}
            options={SCOPES.map((s) => {
              const ok = !!allowMessage(a, s);
              return { value: s, label: SCOPE_NAMES[s], icon: ok ? undefined : 'lock', disabled: !ok, title: ok ? undefined : a.locked[s as 'chat' | 'always'] };
            })}
          />
          <div class="apv-scope-rule">
            <Ticks text={scopeRule(a, item, chat, scope) ?? ''} />
          </div>
        </div>
      )}
    </Popover>
  );
}

/** "Auto-allows in 6s · your setting", with a bar that drains linearly. */
function Countdown({ at }: { at: number }) {
  const now = useNow(250);
  const left = Math.max(0, Math.ceil((at - now) / 1000));
  const total = useRef(Math.max(at - Date.now(), 1)).current;
  return (
    <div class="apv-auto" aria-live="off">
      <Icon name="clock" size={12} />
      Auto-allows in {left}s · your setting for routine requests
      <span class="apv-auto-bar">
        <Drain seconds={total / 1000} label={`Auto-allows in ${left}s`} />
      </span>
    </div>
  );
}

/** "2 more routine requests · npm test in 3 chats · Allow all 3 ⇧⏎". */
function Batch({ a, batch }: { a: Approval; batch: NonNullable<ApprovalCardProps['batch']> }) {
  return (
    <div class="apv-batch">
      <Icon name="layers" size={14} />
      <span class="apv-batch-text">
        <b>
          {batch.count - 1} more routine request{batch.count === 2 ? '' : 's'}
        </b>{' '}
        · <code>{a.target}</code> in {batch.chats} chat{batch.chats === 1 ? '' : 's'}
      </span>
      <Button size="sm" kbd="⇧⏎" onClick={() => batch.messages.forEach(send)}>
        Allow all {batch.count}
      </Button>
    </div>
  );
}

function Risks({ a }: { a: Approval }) {
  return (
    <ul class="apv-risks">
      {a.risk.consequences.map((c) => (
        <li key={c}>{c}</li>
      ))}
      {a.risk.safer && (
        <li data-safer="">
          Safer: <code>{a.risk.safer}</code>
        </li>
      )}
    </ul>
  );
}

/** What saying yes would do: the command, the diff, the site and element, the message and what it shares. */
function Preview({ a, item, chat, state, diff }: { a: Approval; item: Approvable; chat: ChatView; state?: Pick<AppState, 'chats'>; diff?: WebviewMessage }) {
  const line = commandLine(item);
  const why = item.kind === 'permission' ? item.detail?.text : undefined;
  const dropped = item.kind === 'permission' ? item.detail?.dropped : item.kind === 'command' ? item.dropped : undefined;
  return (
    <div class="apv-bd">
      {why && <div class="apv-why">“{why.length > 300 ? `${why.slice(0, 299)}…` : why}”</div>}
      {line !== undefined && (
        <div class="apv-pre">
          <pre>
            <span class="prompt" aria-hidden="true">
              ${' '}
            </span>
            {line}
          </pre>
          <CopyButton text={line} label="Copy the command" />
        </div>
      )}
      {item.kind === 'command' && item.outside && <div class="apv-warn">This folder is outside the workspace.</div>}
      {item.kind === 'permission' && item.detail?.files?.map((f, n) => <MiniDiff key={f.path} file={f} chat={chat} open={n < 3} diff={n === 0 ? diff : undefined} requestId={item.requestId} />)}
      {item.kind === 'review' && (
        <div class="apv-diff">
          <div class="apv-dh">
            <span class="mono">{relativePath(chat.cwd, item.path)}</span>
            <span class="stats">
              <span class="plus">+{item.added}</span> <span class="minus">−{item.removed}</span>
            </span>
            <span class="spacer" />
            <Button variant="quiet" size="sm" kbd={`${MOD}D`} onClick={() => send({ type: 'review', reviewId: item.reviewId, action: 'open' })}>
              Open the diff
            </Button>
          </div>
        </div>
      )}
      {item.kind === 'permission' && item.detail?.plan && (
        <div class="apv-plan">
          <Markdown text={item.detail.plan} />
        </div>
      )}
      {item.kind === 'permission' && !item.detail?.files?.length && (item.detail?.locations?.length ?? 0) > 1 && (
        <div class="apv-files">
          {item.detail!.locations!.map((l) => (
            <button key={l} type="button" class="ref" title={l} onClick={() => send({ type: 'openFile', path: l })}>
              {basename(l)}
            </button>
          ))}
        </div>
      )}
      {item.kind === 'bridge' && <BridgePreview item={item} a={a} state={state} />}
      {a.risk.consequences.length > 0 && <Risks a={a} />}
      {dropped && dropped.commits.length > 0 && (
        <div class="apv-commits" aria-label={`Commits that would be dropped from ${dropped.ref}`}>
          <div class="apv-dh">
            <span class="mono">{dropped.ref}</span> commits that would be dropped
          </div>
          {dropped.commits.map((c) => (
            <div key={c.hash} class="apv-commit">
              <span class="mono apv-hash">{c.hash}</span>
              <span class="mono apv-subj">− {c.subject}</span>
              <span class="apv-author">· {c.author}</span>
            </div>
          ))}
          {dropped.more > 0 && <div class="apv-more-lines">and {dropped.more} more</div>}
        </div>
      )}
    </div>
  );
}

type ProposedFile = NonNullable<NonNullable<Extract<Approvable, { kind: 'permission' }>['detail']>['files']>[number];

function MiniDiff({ file, chat, open: startOpen, diff, requestId }: { file: ProposedFile; chat: ChatView; open: boolean; diff?: WebviewMessage; requestId: string }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <div class="apv-diff">
      <div class="apv-dh">
        <Button variant="text" truncate class="apv-file mono" aria-expanded={open} title={file.path} onClick={() => setOpen(!open)}>
          {relativePath(chat.cwd, file.path)}
        </Button>
        {file.isNew && <Pill>new</Pill>}
        <span class="stats">
          <span class="plus">+{file.added}</span> <span class="minus">−{file.removed}</span>
        </span>
        <span class="spacer" />
        {file.full && (
          <Button variant="quiet" size="sm" kbd={diff ? `${MOD}D` : undefined} title="The whole file with this change, read-only" onClick={() => send(diff ?? { type: 'permissionDiff', requestId, path: file.path })}>
            Full diff
          </Button>
        )}
      </div>
      {open && file.lines.length > 0 && <DiffView lines={file.lines} more={file.more} />}
    </div>
  );
}

function BridgePreview({ item, a, state }: { item: Extract<Approvable, { kind: 'bridge' }>; a: Approval; state?: Pick<AppState, 'chats'> }) {
  if ('browser' in item.target) {
    const origin = item.tool === 'browser_open' ? siteOrigin(item.text) : item.always ? siteOrigin(item.always) : undefined;
    const url = item.tool === 'browser_open' ? item.text : origin;
    const hostName = url?.replace(/^https?:\/\//, '') ?? 'the open page';
    const [h, ...rest] = hostName.split('/');
    return (
      <div class="apv-site">
        <span class="apv-fav" aria-hidden="true">
          {(h.replace(/^www\./, '')[0] ?? '?').toUpperCase()}
        </span>
        <span class="mono apv-url">
          {h}
          {rest.length > 0 && <span class="apv-path">/{rest.join('/')}</span>}
        </span>
        {item.tool !== 'browser_open' && item.text && (
          <span class="mono apv-el" title={item.text}>
            <Icon name="pointer" size={12} />
            {item.text}
          </span>
        )}
      </div>
    );
  }
  const other = 'chatId' in item.target ? state?.chats.find((c) => c.id === (item.target as { chatId: string }).chatId) : undefined;
  return (
    <div class="apv-msg">
      {other && (
        <div class="apv-to">
          to <Glyph agent={other.agent} size="sm" /> {other.label} · {other.title}
        </div>
      )}
      {item.text && (
        <div class="apv-text">
          <Icon name="ask" size={14} />
          <span>{item.text}</span>
        </div>
      )}
      {a.shares && (
        <div class="apv-shares">
          {item.tool === 'read_chat' ? 'Reads' : 'Shares'}
          {a.shares.map((s) => (
            <Pill key={s}>{s}</Pill>
          ))}
        </div>
      )}
    </div>
  );
}
