// The Decision Inbox, the Agent Manager's fifth view: every request any agent waits on as one
// keyboard queue in risk lanes (Careful, Review, Routine), the oldest first in each, each row naming
// its chat; beside it the request's own card and "Or tell … instead".
// The logic is shared/inbox.ts; every answer is a message the chat's own cards send.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  InboxSelection,
  KEY_GRACE_MS,
  answered,
  batchable,
  browserOrigin,
  confirmKey,
  entryActions,
  inbox,
  inboxKey,
  type InboxEntry,
  type InboxKind,
} from '../shared/inbox';
import type { WebviewMessage } from '../shared/messages';
import { AGENT_FACES, age, formatDuration, type AppState, type ChatView } from '../shared/model';
import { oneClickQuestion, recommended } from '../shared/questions';
import { Glyph, Icon, Markdown, isTyping, send, type IconName } from './common';
import { ApprovalCard, cardKeys } from './approval';
import { Button, ChoiceRow, Pill, Textarea } from './ui';

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
  const reply = useRef<HTMLTextAreaElement>(null);
  const selected = selection.selected(box.entries, Date.now());
  const same = selected ? batchable(box.entries, selected) : [];
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
      if (e.defaultPrevented || isTyping(e.target) || (e.target as HTMLElement | null)?.closest?.('.fl-menu')) return;
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
      else if (command.do === 'batch' && selected) setConfirm({ ids: same.map((x) => x.id), at });
      else if (command.do === 'send') sendAll(command.messages);
      else if (command.do === 'allow' && selected && !e.repeat) cardKeys.get(selected.id)?.press();
      else if (command.do === 'scope' && selected) cardKeys.get(selected.id)?.cycle();
      else if (command.do === 'reply') reply.current?.focus();
    };
    // Enter let go: a hold not yet done drains back.
    const onUp = (e: KeyboardEvent) => e.key === 'Enter' && selected && cardKeys.get(selected.id)?.release();
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onUp);
    };
  });

  if (!box.entries.length && !leaving.length) return <Empty history={history} chats={chats} now={now} />;

  // The lanes, with the rows still folding away kept where they were.
  const lanes = (['careful', 'review', 'routine'] as const)
    .map((tone) => ({ tone, rows: [...box.entries, ...leaving].filter((r) => r.risk === tone).sort((a, b) => (a.at ?? 0) - (b.at ?? 0)) }))
    .filter((l) => l.rows.length);
  return (
    <div class="inbox">
      <div class="inbox-list" ref={list} role="listbox" aria-label="Waiting for you" aria-activedescendant={selected ? `inbox-${selected.id}` : undefined} tabIndex={0}>
        {lanes.map((lane) => {
          const waiting = lane.rows.filter((r) => !leaving.includes(r)).length;
          return (
            <div key={lane.tone} role="group" aria-label={LANE[lane.tone]} class="inbox-lane" data-tone={lane.tone}>
              <div class="inbox-lane-head" aria-hidden="true">
                <span class="inbox-lane-dot" />
                {LANE[lane.tone]}
                {waiting > 0 && <span class="col-count">{waiting}</span>}
              </div>
              {lane.rows.map((e) => {
                const chat = chats.get(e.chatId);
                return chat ? <Row key={e.id} entry={e} chat={chat} now={now} on={e.id === selected?.id} leaving={leaving.includes(e)} onPick={() => choose(e.id)} /> : null;
              })}
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
          reply={reply}
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

const LANE: Record<InboxEntry['risk'], string> = { careful: 'Careful', review: 'Review', routine: 'Routine' };

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
      <span class="inbox-chat">{chat.title}</span>
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
  reply: { current: HTMLTextAreaElement | null };
  onBatch(): void;
  onCancel(): void;
  onAnswerAll(answer: 'allow' | 'deny'): void;
}

/** The request's card (the same one the chat shows), and beside it "Or tell … instead". */
function Detail({ entry: e, chat, state, now, same, confirming, reply, onBatch, onCancel, onAnswerAll }: DetailProps) {
  const i = e.item;
  const left = timeLeft(e, now);
  return (
    <section class="inbox-detail" aria-label={`${KIND[e.kind].label}: ${e.title}`} aria-live="polite">
      <header class="inbox-detail-head">
        <span class="inbox-kind" data-tone={e.risk}>
          <Icon name={KIND[e.kind].icon} size={16} />
        </span>
        <h2 class="inbox-detail-title">{e.title}</h2>
        <span class="spacer" />
        <Button variant="quiet" iconEnd="open" class="inbox-open" title="See it in its chat (o)" onClick={() => openAt(e)}>
          Open in chat
        </Button>
      </header>
      <div class="inbox-meta">
        <Glyph agent={chat.agent} size="sm" />
        <span title={chat.label}>{AGENT_FACES[chat.agent].name}</span>
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
      <div class="inbox-body">
        <div class="inbox-main">
          {i.kind === 'question' ? <QuestionWhat entry={e} /> : <ApprovalCard item={i} chat={chat} state={state} on />}
          {confirming.length >= 2 ? (
            <Confirm entries={confirming} state={state} now={now} onAnswer={onAnswerAll} onCancel={onCancel} />
          ) : (
            same.length >= 2 && (
              <div class="apv-batch">
                <Icon name="layers" size={14} />
                <span class="apv-batch-text">
                  <b>
                    {same.length - 1} more routine request{same.length === 2 ? '' : 's'}
                  </b>{' '}
                  · the same in {new Set(same.map((x) => x.chatId)).size} chats
                </span>
                <Button size="sm" kbd="⇧⏎" onClick={onBatch}>
                  Allow all {same.length}
                </Button>
              </div>
            )
          )}
        </div>
        {i.kind !== 'question' && <Reply entry={e} chat={chat} box={reply} />}
      </div>
      <Keys entry={e} confirming={confirming.length >= 2} batch={same.length >= 2} />
    </section>
  );
}

/** "Or tell Claude instead": denies the request and sends the message to its chat. */
function Reply({ entry, chat, box }: { entry: InboxEntry; chat: ChatView; box: { current: HTMLTextAreaElement | null } }) {
  const [text, setText] = useState('');
  const deny = entryActions(entry).deny;
  const go = () => {
    const t = text.trim();
    if (!t) return;
    if (deny) send(deny);
    send({ type: 'send', chatId: chat.id, text: t, images: [] });
    setText('');
  };
  return (
    <aside class="inbox-reply" aria-label={`Or tell ${AGENT_FACES[chat.agent].name} instead`}>
      <label class="inbox-reply-label" for={`reply-${entry.id}`}>
        Or tell {AGENT_FACES[chat.agent].name} instead
      </label>
      <Textarea
        id={`reply-${entry.id}`}
        ref={box}
        rows={3}
        value={text}
        maxLength={10_000}
        placeholder="What to do instead… (denies and sends)"
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            go();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
      <Button disabled={!text.trim()} kbd={MAC ? '⌘⏎' : 'Ctrl+⏎'} onClick={go}>
        Send and deny
      </Button>
    </aside>
  );
}

const MAC = /Mac/.test(navigator.platform);

function QuestionWhat({ entry: e }: { entry: InboxEntry }) {
  const i = e.item;
  if (i.kind !== 'question') return null;
  const actions = entryActions(e);
  const field = oneClickQuestion(i.fields);
  const options = (field?.options ?? []).map((o) => ({ o, ...recommended(o.title) })).sort((a, b) => Number(b.recommended) - Number(a.recommended));
  return (
    <div class="fl-card apv inbox-question">
      <div class="q-question">
        <Markdown text={i.message} />
      </div>
      {field ? (
        <div class="q-options" role="listbox" aria-label={field.title}>
          {options.map(({ o, label, recommended: rec }, n) => (
            <ChoiceRow
              key={o.value}
              class="q-opt"
              selected={false}
              onPick={() => send(actions.choices[n].message)}
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
        </div>
      ) : (
        <div class="hint">
          {i.fields.length} question{i.fields.length === 1 ? '' : 's'} to answer in the chat: {i.fields.map((f) => f.title).join(', ')}.
        </div>
      )}
      <div class="q-foot">
        <span class="spacer" />
        <Button variant="quiet" kbd="Esc" onClick={() => actions.deny && send(actions.deny)}>
          Skip
        </Button>
        <Button kbd="⏎" onClick={() => openAt(e)}>
          Answer in the chat
        </Button>
      </div>
    </div>
  );
}

/** "Allow all N": the requests it answers, by chat, before anything happens. Once each, never remembered. */
function Confirm({ entries, state, now, onAnswer, onCancel }: { entries: InboxEntry[]; state: AppState; now: number; onAnswer(a: 'allow' | 'deny'): void; onCancel(): void }) {
  return (
    <div class="inbox-confirm" role="group" aria-label={`Answer ${entries.length} identical requests`}>
      <div class="inbox-confirm-head">Allow these {entries.length} identical routine requests, once each?</div>
      <ul class="inbox-confirm-list">
        {entries.map((e) => {
          const chat = state.chats.find((c) => c.id === e.chatId);
          const where = e.item.kind === 'command' ? e.item.cwd : e.item.kind === 'permission' ? (e.item.detail?.command?.cwd ?? chat?.cwd) : e.item.kind === 'bridge' ? browserOrigin(e.item) : undefined;
          return (
            <li key={e.id}>
              {chat && <Glyph agent={chat.agent} size="sm" />}
              <span class="inbox-confirm-chat" title={chat?.label}>
                {chat ? `${AGENT_FACES[chat.agent].name} · ${chat.title}` : e.chatId}
              </span>
              {where && <span class="hint mono inbox-confirm-where">{where}</span>}
              {e.at !== undefined && <span class="inbox-age">{age(e.at, now)}</span>}
            </li>
          );
        })}
      </ul>
      <div class="inbox-confirm-actions">
        <Button variant="quiet" kbd="Esc" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="quiet" kbd="d" onClick={() => onAnswer('deny')}>
          Deny all {entries.length}
        </Button>
        <Button variant="brand" kbd="⏎" onClick={() => onAnswer('allow')}>
          Allow all {entries.length} once
        </Button>
      </div>
    </div>
  );
}

/** One short line of hints, in place of a legend. */
function Keys({ entry, confirming, batch }: { entry: InboxEntry; confirming: boolean; batch: boolean }) {
  const question = entry.item.kind === 'question';
  const parts: [string[], string][] = confirming
    ? [
        [['⏎'], 'allow all'],
        [['d'], 'deny all'],
        [['Esc'], 'back'],
      ]
    : [
        [['J', 'K'], 'move'],
        [['⏎'], question ? 'answer in chat' : entry.risk === 'careful' ? 'hold to allow' : entry.kind === 'review' ? 'open diff' : 'allow'],
        [['Esc'], question ? 'skip' : 'deny'],
        ...(question ? [] : ([[['Tab'], 'scope'], [['R'], 'reply']] as [string[], string][])),
        ...(batch ? ([[['⇧⏎'], 'allow all']] as [string[], string][]) : []),
        [['O'], 'open in chat'],
      ];
  return (
    <div class="inbox-keys" aria-hidden="true">
      {parts.map(([keys, what], x) => (
        <span key={x} class="inbox-key">
          {keys.map((k) => (
            <kbd key={k}>{k}</kbd>
          ))}{' '}
          {what}
        </span>
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
