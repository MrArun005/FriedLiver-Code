// The Decision Inbox, the Agent Manager's fifth view: every request any agent waits on as one
// keyboard queue, the oldest first and grouped by chat, and beside it exactly what answering does.
// The logic is shared/inbox.ts; every answer is a message the chat's own cards send.
import { Fragment } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  InboxSelection,
  KEY_GRACE_MS,
  answered,
  browserOrigin,
  confirmKey,
  entryActions,
  identical,
  inbox,
  inboxKey,
  type InboxEntry,
  type InboxKind,
} from '../shared/inbox';
import type { WebviewMessage } from '../shared/messages';
import { AGENT_FACES, age, basename, formatDuration, type AppState, type ChatView } from '../shared/model';
import { oneClickQuestion, recommended } from '../shared/questions';
import { Glyph, Icon, Markdown, StepLabel, isTyping, longTitle, send, type IconName } from './common';
import { AlwaysAllow, PermissionDetailView } from './controls';

const KIND: Record<InboxKind, { icon: IconName; label: string }> = {
  command: { icon: 'terminal', label: 'Run a command' },
  edit: { icon: 'diff', label: 'Change files' },
  review: { icon: 'diff', label: 'Review an edit' },
  browser: { icon: 'globe', label: 'Act in the browser' },
  agent: { icon: 'handoff', label: 'Reach another agent' },
  memory: { icon: 'plan', label: 'Remember a fact' },
  question: { icon: 'ask', label: 'Answer a question' },
  permission: { icon: 'shield', label: 'Allow a tool' },
};

const BROWSER_ACTION: Record<string, string> = { browser_open: 'Open', browser_click: 'Click', browser_type: 'Type', browser_back: 'Go back', browser_reload: 'Reload' };
/** How long an answered row takes to fold away. */
const LEAVE_MS = 200;

const openAt = (e: { chatId: string; id: string }) => send({ type: 'openChat', chatId: e.chatId, item: e.id });

export function Inbox({ state, now, onClose }: { state: AppState; now: number; onClose(): void }) {
  const box = useMemo(() => inbox(state), [state]);
  const history = useMemo(() => answered(state), [state]);
  const chats = useMemo(() => new Map(state.chats.map((c) => [c.id, c])), [state]);
  const selection = useRef(new InboxSelection()).current;
  const [, redraw] = useState(0);
  const [confirm, setConfirm] = useState<{ ids: string[]; at: number } | null>(null);
  const selected = selection.selected(box.entries, Date.now());
  const same = selected ? identical(box.entries, selected) : [];
  const confirming = confirm && selected && confirm.ids.includes(selected.id) ? same.filter((e) => confirm.ids.includes(e.id)) : [];

  // Answered rows fold away instead of vanishing; the selection has already moved on.
  const [leaving, setLeaving] = useState<InboxEntry[]>([]);
  const before = useRef<InboxEntry[]>(box.entries);
  useLayoutEffect(() => {
    const gone = before.current.filter((e) => !box.entries.some((x) => x.id === e.id));
    before.current = box.entries;
    if (!gone.length) return;
    setLeaving((l) => [...l, ...gone]);
    const timer = setTimeout(() => setLeaving((l) => l.filter((x) => !gone.includes(x))), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [box.entries]);

  // The confirmation is for the requests it listed: once fewer than two of them wait, it closes.
  useEffect(() => {
    if (confirm && confirming.length < 2) setConfirm(null);
  });

  // The selected row stays in sight.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) list.current?.querySelector(`[data-id="${CSS.escape(selected.id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected?.id]);

  const choose = (id: string) => {
    selection.choose(id, box.entries, Date.now());
    setConfirm(null);
    redraw((n) => n + 1);
  };
  const sendAll = (messages: WebviewMessage[]) => messages.forEach(send);

  // A layout effect: the keys work from the first frame the Inbox is on screen.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e.target) || (e.target as HTMLElement | null)?.closest?.('.popover')) return;
      const at = Date.now();
      if (confirming.length >= 2) {
        const answer = confirmKey(e, at - confirm!.at >= KEY_GRACE_MS && selection.armed(box.entries, at));
        if (!answer) return;
        e.preventDefault();
        if (answer === 'cancel') setConfirm(null);
        else if (answer !== 'wait') {
          sendAll(confirming.flatMap((x) => entryActions(x)[answer] ?? []));
          setConfirm(null);
        }
        return;
      }
      const command = inboxKey(e, selected, selection.armed(box.entries, at), box.entries);
      if (!command) return;
      e.preventDefault();
      if (command.do === 'move') {
        selection.move(command.by, box.entries, at);
        setConfirm(null);
        redraw((n) => n + 1);
      } else if (command.do === 'close') onClose();
      else if (command.do === 'open' && selected) openAt(selected);
      else if (command.do === 'batch' && selected) setConfirm({ ids: identical(box.entries, selected).map((x) => x.id), at });
      else if (command.do === 'send') sendAll(command.messages);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!box.entries.length && !leaving.length) return <Empty history={history} chats={chats} now={now} />;

  // The queue's groups, with the rows still folding away kept where they were.
  const rows = [...box.entries, ...leaving].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const order = [...new Set([...box.groups.map((g) => g.chat.id), ...rows.map((r) => r.chatId)])];
  return (
    <div class="inbox">
      <div class="inbox-list" ref={list} role="listbox" aria-label="Waiting for you" aria-activedescendant={selected ? `inbox-${selected.id}` : undefined} tabIndex={0}>
        {order.map((chatId) => {
          const chat = chats.get(chatId);
          const mine = rows.filter((r) => r.chatId === chatId);
          if (!chat || !mine.length) return null;
          const waiting = mine.filter((r) => !leaving.includes(r)).length;
          return (
            <div key={chatId} role="group" aria-label={chat.title} class="inbox-group">
              <div class="inbox-group-head" aria-hidden="true">
                <span class="inbox-topic" title={chat.title}>
                  {chat.title}
                </span>
                <span class="inbox-who">{chat.label}</span>
                {waiting > 0 && <span class="col-count">{waiting}</span>}
              </div>
              {mine.map((e) => (
                <Row key={e.id} entry={e} chat={chat} now={now} on={e.id === selected?.id} leaving={leaving.includes(e)} onPick={() => choose(e.id)} />
              ))}
            </div>
          );
        })}
      </div>
      {selected && chats.get(selected.chatId) && (
        <Detail
          key={selected.id}
          entry={selected}
          chat={chats.get(selected.chatId)!}
          state={state}
          now={now}
          same={same}
          confirming={confirming}
          onBatch={() => setConfirm({ ids: same.map((x) => x.id), at: Date.now() })}
          onCancel={() => setConfirm(null)}
          onAnswerAll={(answer) => {
            sendAll(confirming.flatMap((x) => entryActions(x)[answer] ?? []));
            setConfirm(null);
          }}
        />
      )}
    </div>
  );
}

function Row({ entry: e, chat, now, on, leaving, onPick }: { entry: InboxEntry; chat: ChatView; now: number; on: boolean; leaving: boolean; onPick(): void }) {
  return (
    <div
      id={`inbox-${e.id}`}
      data-id={e.id}
      role="option"
      aria-selected={on}
      class="inbox-row"
      data-leaving={leaving ? '' : undefined}
      title={`${e.title}\n${chat.title} · ${chat.label}`}
      onMouseDown={(ev) => (ev.preventDefault(), !leaving && onPick())}
    >
      <Glyph agent={chat.agent} size="sm" />
      <span class="inbox-kind" title={KIND[e.kind].label}>
        <Icon name={KIND[e.kind].icon} size={14} />
      </span>
      <span class="inbox-title">{e.title}</span>
      {e.at !== undefined && <span class="inbox-age">{age(e.at, now)}</span>}
    </div>
  );
}

function timeLeft(e: InboxEntry, now: number): string | undefined {
  if (e.timeoutAt === undefined) return undefined;
  const left = e.timeoutAt - now;
  return left > 60_000 ? `times out in ${Math.ceil(left / 60_000)}m` : left > 0 ? 'times out in under a minute' : 'timing out';
}

interface DetailProps {
  entry: InboxEntry;
  chat: ChatView;
  state: AppState;
  now: number;
  same: InboxEntry[];
  confirming: InboxEntry[];
  onBatch(): void;
  onCancel(): void;
  onAnswerAll(answer: 'allow' | 'deny'): void;
}

/** Exactly what answering does: the command and its folder, the diff, the site and the action, the question and its options. */
function Detail({ entry: e, chat, state, now, same, confirming, onBatch, onCancel, onAnswerAll }: DetailProps) {
  const actions = entryActions(e);
  const i = e.item;
  const left = timeLeft(e, now);
  const n = actions.choices.length;
  return (
    <section class="ask inbox-detail" aria-label={`${KIND[e.kind].label}: ${e.title}`} aria-live="polite">
      <header class="inbox-detail-head">
        <span class="inbox-kind">
          <Icon name={KIND[e.kind].icon} size={14} />
        </span>
        <span class="inbox-detail-kind">{KIND[e.kind].label}</span>
        <span class="spacer" />
        <button type="button" class="link inbox-open" title="See it in its chat (o)" onClick={() => openAt(e)}>
          Open in chat
        </button>
      </header>
      <div class="inbox-meta">
        <Glyph agent={chat.agent} size="sm" />
        <span>{chat.label}</span>
        <span class="sep">·</span>
        <span class="inbox-meta-topic" title={chat.title}>
          {chat.title}
        </span>
        {e.at !== undefined && (
          <>
            <span class="sep">·</span>
            <span>waiting {age(e.at, now)}</span>
          </>
        )}
        {left && (
          <>
            <span class="sep">·</span>
            <span class="inbox-timeout" title={`Refused on its own after ${formatDuration(e.timeoutAt! - (e.at ?? 0))} without an answer`}>
              {left}
            </span>
          </>
        )}
      </div>
      <div class="ask-body inbox-what">
        {i.kind === 'permission' && (
          <>
            {!(i.detail?.command && i.detail.command.line.trim() === i.title.trim()) && (
              <div class="inbox-ask">{longTitle(i.title) ? <StepLabel title={i.title} toolKind={i.toolKind} cmd={i.detail?.command} /> : i.title}</div>
            )}
            <PermissionDetailView detail={i.detail} requestId={i.requestId} open />
            {i.detail?.command && !i.detail.command.cwd && <div class="hint mono">in {chat.cwd}</div>}
          </>
        )}
        {i.kind === 'command' && (
          <>
            <pre class={`cmdline${i.commandLine.includes('\n') ? ' lines' : ''}`}>
              <span class="prompt">$ </span>
              {i.commandLine}
            </pre>
            <div class="hint mono" title={i.cwd}>
              in {i.cwd}
            </div>
            {i.outside && <div class="warn">This folder is outside the workspace.</div>}
          </>
        )}
        {i.kind === 'review' && (
          <div class="file-line">
            <button type="button" class="file-row" title={`${i.path}: open the diff`} onClick={() => send({ type: 'review', reviewId: i.reviewId, action: 'open' })}>
              <Icon name="file" /> <span class="file-name">{basename(i.path)}</span>
              {i.isNew && <span class="tag">new</span>}
              <span class="stats">
                <span class="plus">+{i.added}</span> <span class="minus">−{i.removed}</span>
              </span>
            </button>
            <span class="hint mono inbox-path" title={i.path}>
              {i.path}
            </span>
          </div>
        )}
        {i.kind === 'bridge' && <BridgeWhat entry={e} state={state} />}
        {i.kind === 'question' && <QuestionWhat entry={e} />}
      </div>

      {confirming.length >= 2 ? (
        <Confirm entries={confirming} state={state} now={now} onAnswer={onAnswerAll} onCancel={onCancel} />
      ) : (
        <>
          {n > 0 && (
            <div class="actions" role="group" aria-label="Answers">
              {actions.choices.slice(0, 9).map((c, k) => (
                <button key={k} type="button" class={`sm ${c.tone === 'decide' ? 'decide' : c.tone === 'escalate' ? 'escalate' : ''}`} onClick={() => send(c.message)}>
                  <span class="opt-num">{k + 1}.</span>
                  {c.label}
                </button>
              ))}
              {i.kind === 'permission' && actions.always && (
                <AlwaysAllow line={i.detail?.command?.line && i.toolKind === 'execute' ? i.detail.command.line : undefined} grants={i.detail?.always} target={{ requestId: i.requestId }} />
              )}
              {i.kind === 'command' && actions.always && <AlwaysAllow line={i.commandLine} target={{ commandId: i.commandId }} />}
              {i.kind === 'bridge' && actions.always && (
                <button type="button" class="link always-allow" title={`Don't ask again for ${actions.always.scope}: every chat, every agent, after restarts.`} onClick={() => send(actions.always!.message)}>
                  Always allow <span class="always-scope">{actions.always.scope}</span>
                </button>
              )}
            </div>
          )}
          {actions.diff && (
            <div class="inbox-more">
              <button type="button" class="sm" onClick={() => send(actions.diff!)}>
                <Icon name="diff" /> Open diff
              </button>
            </div>
          )}
          {same.length >= 2 && (
            <div class="inbox-batch">
              <span>
                {same.length} identical request{same.length === 1 ? '' : 's'} wait{same.length === 1 ? 's' : ''}
                {new Set(same.map((x) => x.chatId)).size > 1 ? ` in ${new Set(same.map((x) => x.chatId)).size} chats` : ''}
              </span>
              <span class="spacer" />
              <button type="button" class="sm" onClick={onBatch}>
                Apply to all {same.length} identical… <kbd>b</kbd>
              </button>
            </div>
          )}
        </>
      )}
      <Keys entry={e} n={n} confirming={confirming.length >= 2} batch={same.length >= 2} />
    </section>
  );
}

function BridgeWhat({ entry: e, state }: { entry: InboxEntry; state: AppState }) {
  const i = e.item;
  if (i.kind !== 'bridge') return null;
  if ('browser' in i.target) {
    const origin = browserOrigin(i);
    return (
      <div class="bridge-text">
        <div class="bridge-label">
          {BROWSER_ACTION[i.tool] ?? 'Use'}
          {origin && i.tool !== 'browser_open' ? ` on ${origin}` : ''}
        </div>
        {i.text || <span class="hint">{origin ? `the page at ${origin}` : 'the open page'}</span>}
      </div>
    );
  }
  const other = 'chatId' in i.target ? state.chats.find((c) => c.id === (i.target as { chatId: string }).chatId) : undefined;
  const agent = 'agent' in i.target ? i.target.agent : other?.agent;
  return (
    <>
      {agent && (
        <div class="inbox-target">
          <Icon name="handoff" size={14} />
          <Glyph agent={agent} size="sm" />
          <span>{other ? `${other.label} · ${other.title}` : `A new ${AGENT_FACES[agent].name} chat`}</span>
        </div>
      )}
      {i.text && (
        <div class="bridge-text">
          <div class="bridge-label">{i.tool === 'remember' ? 'Fact' : i.tool === 'ask_agent' ? 'Question' : i.tool === 'send_to_chat' ? 'Message' : 'Read the transcript'}</div>
          {i.text}
        </div>
      )}
    </>
  );
}

function QuestionWhat({ entry: e }: { entry: InboxEntry }) {
  const i = e.item;
  if (i.kind !== 'question') return null;
  const field = oneClickQuestion(i.fields);
  return (
    <>
      <div class="q-question">
        <Markdown text={i.message} />
      </div>
      {field ? (
        // The options with their descriptions; the numbered answers below pick them.
        <ul class="inbox-options">
          {(field.options ?? [])
            .map((o) => ({ o, ...recommended(o.title) }))
            .sort((a, b) => Number(b.recommended) - Number(a.recommended))
            .filter(({ o }) => o.description)
            .map(({ o, label }) => (
              <li key={o.value}>
                <span class="inbox-option">{label}</span> <span class="hint">{o.description}</span>
              </li>
            ))}
        </ul>
      ) : (
        <div class="hint">
          {i.fields.length} question{i.fields.length === 1 ? '' : 's'} to answer in the chat: {i.fields.map((f) => f.title).join(', ')}. Enter opens it.
        </div>
      )}
    </>
  );
}

/** "Apply to all N identical": the requests it answers, by chat, before anything happens. Never Always allow. */
function Confirm({ entries, state, now, onAnswer, onCancel }: { entries: InboxEntry[]; state: AppState; now: number; onAnswer(a: 'allow' | 'deny'): void; onCancel(): void }) {
  return (
    <div class="inbox-confirm" role="group" aria-label={`Answer ${entries.length} identical requests`}>
      <div class="inbox-confirm-head">Answer these {entries.length} identical requests once each?</div>
      <ul class="inbox-confirm-list">
        {entries.map((e) => {
          const chat = state.chats.find((c) => c.id === e.chatId);
          const where = e.item.kind === 'command' ? e.item.cwd : e.item.kind === 'permission' ? (e.item.detail?.command?.cwd ?? chat?.cwd) : e.item.kind === 'bridge' ? browserOrigin(e.item) : undefined;
          return (
            <li key={e.id}>
              {chat && <Glyph agent={chat.agent} size="sm" />}
              <span class="inbox-confirm-chat">{chat ? `${chat.label} · ${chat.title}` : e.chatId}</span>
              {where && <span class="hint mono inbox-confirm-where">{where}</span>}
              {e.at !== undefined && <span class="inbox-age">{age(e.at, now)}</span>}
            </li>
          );
        })}
      </ul>
      <div class="actions">
        <button type="button" class="sm decide" onClick={() => onAnswer('allow')}>
          Allow all {entries.length} once
        </button>
        <button type="button" class="sm" onClick={() => onAnswer('deny')}>
          Deny all {entries.length}
        </button>
        <button type="button" class="sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Keys({ entry, n, confirming, batch }: { entry: InboxEntry; n: number; confirming: boolean; batch: boolean }) {
  const a = entryActions(entry);
  const parts: [string, string][] = confirming
    ? [
        ['↩', 'allow all'],
        ['d', 'deny all'],
        ['esc', 'back'],
      ]
    : [
        ['j k', 'move'],
        ...(n ? [[n > 1 ? `1–${Math.min(9, n)}` : '1', 'choose'] as [string, string]] : []),
        ...(a.allow ? [['a', 'allow once'] as [string, string]] : []),
        ...(a.always ? [['A', 'always allow'] as [string, string]] : []),
        ...(a.deny ? [['d', entry.kind === 'question' ? 'skip' : 'deny'] as [string, string]] : []),
        ['↩', a.primary === 'open' ? 'open in chat' : entry.kind === 'review' ? 'open diff' : 'yes'],
        ['o', 'open in chat'],
        ...(batch ? [['b', 'all identical'] as [string, string]] : []),
        ['esc', 'close'],
      ];
  return (
    <div class="hint inbox-keys" aria-hidden="true">
      {parts.map(([k, what], x) => (
        <Fragment key={x}>
          {x > 0 && <span class="sep"> · </span>}
          <span class="inbox-key">
            <kbd>{k}</kbd> {what}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

function Empty({ history, chats, now }: { history: ReturnType<typeof answered>; chats: Map<string, ChatView>; now: number }) {
  return (
    <div class="inbox-empty">
      <div class="inbox-empty-head">
        <Icon name="check" size={20} />
        <div>
          <h2>Nothing waits for you</h2>
          <p class="hint">Commands, edits, browser actions, questions and requests between agents land here, from every chat, oldest first.</p>
        </div>
      </div>
      <section class="inbox-history" aria-label="Answered lately">
        <h3>Answered lately</h3>
        {history.length ? (
          <ul>
            {history.map((h) => {
              const chat = chats.get(h.chatId);
              return (
                <li key={h.id}>
                  <button type="button" class="inbox-history-row" title="Show it in its chat" onClick={() => openAt(h)}>
                    <span class="inbox-outcome" data-allowed={h.allowed ? '' : undefined}>
                      <Icon name={h.allowed ? 'check' : 'close'} size={14} />
                    </span>
                    {chat && <Glyph agent={chat.agent} size="sm" />}
                    <span class="inbox-kind">
                      <Icon name={KIND[h.kind].icon} size={14} />
                    </span>
                    <span class="inbox-title">{h.title}</span>
                    <span class="inbox-history-outcome">{h.outcome}</span>
                    <span class="inbox-history-topic">{chat?.title}</span>
                    {h.at !== undefined && <span class="inbox-age">{age(h.at, now)}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p class="hint">Nothing answered yet. Answers can't be undone from here; this is history only.</p>
        )}
      </section>
    </div>
  );
}
