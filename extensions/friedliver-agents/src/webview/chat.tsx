import { render } from 'preact';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Attachment } from '../shared/messages';
import {
  AGENT_FACES,
  AGENT_KEYS,
  boardColumn,
  bridgeTitle,
  fileConflicts,
  formatDuration,
  parseMention,
  shortCommand,
  type AppState,
  type BridgeItem,
  type ChatView,
  type CommandItem,
  type FileConflict,
  type Item,
  type LinkItem,
  type ReviewItem,
} from '../shared/model';
import {
  applyMention,
  clip,
  linkBadges,
  mentionOptions,
  mentionQuery,
  mentionedAgent,
  openChats,
  recentChats,
  relativePath,
  switcherGroups,
  statusOf,
} from '../shared/view';
import { DOT_LABEL, Dot, Glyph, Icon, Markdown, Popover, basename, send, useHost, useWidth } from './common';
import { AskMenu, HandoffMenu, PipeMenu } from './connect';

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|bmp|svg\+xml)$/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

type Select = (chatId: string) => void;

function App() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [reveal, setReveal] = useState<{ id: string; n: number } | null>(null);
  const { state, selected, setSelected } = useHost((m) => {
    if (m.type === 'attached') setAttachments((list) => [...list, ...m.images].slice(0, 10));
    if (m.type === 'reveal') setReveal((r) => ({ id: m.id, n: (r?.n ?? 0) + 1 }));
  });
  // The selected chat even when archived (opened from History); otherwise the newest open one.
  const chat = state.chats.find((c) => c.id === selected) ?? openChats(state.chats).at(-1);

  const select = (chatId: string) => {
    setSelected(chatId);
    send({ type: 'select', chatId });
  };

  return (
    <div class="chat-app">
      <Switcher state={state} active={chat?.id} onSelect={select} />
      {chat ? (
        <>
          <ChatHeader chat={chat} state={state} onSelect={select} />
          <Transcript chat={chat} state={state} reveal={reveal} onSelect={select} />
          <Composer chat={chat} attachments={attachments} setAttachments={setAttachments} />
        </>
      ) : (
        <Empty />
      )}
    </div>
  );
}

/** Recent chats as tabs, and every open chat one click away in "All chats", for fifteen agents and more. */
function Switcher({ state, active, onSelect }: { state: AppState; active?: string; onSelect: Select }) {
  const width = useWidth();
  const strip = recentChats(state.chats, active, Math.max(1, Math.min(6, Math.floor((width - 140) / 128))));
  const open = openChats(state.chats);
  const needs = open.filter((c) => boardColumn(statusOf(c)) === 'needs-you').length;
  return (
    <div class="switcher">
      <div class="tabs" role="tablist" aria-label="Recent chats">
        {strip.map((c) => (
          <button key={c.id} role="tab" class="tab" aria-selected={c.id === active} title={`${c.label}: ${c.title}`} onClick={() => onSelect(c.id)}>
            <Glyph agent={c.agent} size="sm" />
            <span class="tab-title">{c.title}</span>
            <Dot state={statusOf(c)} />
          </button>
        ))}
      </div>
      <Popover
        kind="dialog"
        label="All chats"
        title="All chats"
        align="end"
        buttonClass="ghost sm all-btn"
        trigger={
          <>
            <Icon name="grid" />
            <span class="all-count">{open.length}</span>
            {needs > 0 && (
              <span class="count loud" aria-label={`${needs} need you`}>
                {needs}
              </span>
            )}
          </>
        }
      >
        {(close) => (
          <AllChats
            state={state}
            active={active}
            onPick={(id) => {
              close(false);
              onSelect(id);
            }}
          />
        )}
      </Popover>
      <Popover label="New chat with" title="New chat" align="end" buttonClass="ghost icon-btn" trigger={<Icon name="plus" />}>
        {(close) => (
          <>
            <div class="pop-title" aria-hidden="true">New chat with</div>
            {AGENT_KEYS.map((agent) => (
              <button
                key={agent}
                role="menuitem"
                onClick={() => {
                  close(false);
                  send({ type: 'newChat', agent });
                }}
              >
                <Glyph agent={agent} size="sm" />
                <span class="grow">{AGENT_FACES[agent].name}</span>
                {agent === 'demo' && <span class="hint">offline</span>}
              </button>
            ))}
          </>
        )}
      </Popover>
      <button class="ghost icon-btn" aria-label="Agent Manager" title="Agent Manager" onClick={() => send({ type: 'openTasks' })}>
        <Icon name="tasks" />
      </button>
    </div>
  );
}

function AllChats({ state, active, onPick }: { state: AppState; active?: string; onPick: Select }) {
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const listId = useId();
  const groups = switcherGroups(state.chats, query);
  const flat = groups.flatMap((g) => g.chats);
  const current = flat[Math.min(at, flat.length - 1)];
  const archived = state.chats.filter((c) => c.archived).length;
  useEffect(() => {
    if (current) document.getElementById(`${listId}-${current.id}`)?.scrollIntoView({ block: 'nearest' });
  }, [current?.id]);
  return (
    <div class="all-chats">
      <label class="search">
        <Icon name="search" />
        <input
          type="search"
          aria-controls={listId}
          aria-activedescendant={current ? `${listId}-${current.id}` : undefined}
          aria-label="Search chats"
          placeholder="Search chats"
          value={query}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setAt(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const n = flat.length || 1;
              setAt((a) => (Math.min(a, n - 1) + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
            } else if (e.key === 'Enter' && current) {
              e.preventDefault();
              onPick(current.id);
            }
          }}
        />
      </label>
      <div class="all-list" id={listId} role="listbox" aria-label="Chats">
        {groups.map((g) => (
          <div key={g.column} role="group" aria-label={g.title}>
            <div class="pop-group" aria-hidden="true">
              <Dot state={g.column} />
              {g.title}
              <span class="col-count">{g.chats.length}</span>
            </div>
            {g.chats.map((c) => (
              <div
                key={c.id}
                id={`${listId}-${c.id}`}
                role="option"
                class="pick-row"
                aria-selected={c === current}
                data-open={c.id === active ? '' : undefined}
                onClick={() => onPick(c.id)}
                onMouseMove={() => setAt(flat.indexOf(c))}
              >
                <Glyph agent={c.agent} size="sm" />
                <span class="pick-title">{c.title}</span>
                <span class="pick-label">{c.label}</span>
                <Dot state={statusOf(c)} />
              </div>
            ))}
          </div>
        ))}
        {!flat.length && <div class="pop-empty">{query ? 'No chat matches.' : 'No open chats.'}</div>}
      </div>
      <div class="pop-foot">
        <button class="ghost sm" onClick={() => send({ type: 'openTasks' })}>
          <Icon name="tasks" /> Agent Manager
        </button>
        <span class="spacer" />
        {archived > 0 && <span class="hint">{archived} archived</span>}
      </div>
    </div>
  );
}

/** The open chat: who and what, its connections, and the actions that join it to other agents. */
function ChatHeader({ chat, state, onSelect }: { chat: ChatView; state: AppState; onSelect: Select }) {
  const compact = useWidth() < 640;
  const status = statusOf(chat);
  const parent = chat.origin && state.chats.find((c) => c.id === chat.origin!.chatId);
  // The banner covers where this chat came from; chips cover the rest.
  const chips = linkBadges(state, chat).filter((b) => !(b.kind === 'origin' && b.chatId === parent?.id));
  return (
    <>
      <header class="chat-head">
        <Glyph agent={chat.agent} />
        <div class="chat-head-text">
          <div class="chat-head-title" title={chat.title}>
            {chat.title}
          </div>
          <div class="chat-head-sub">
            <span>{chat.label}</span>
            <span class="sep">·</span>
            <Dot state={status} />
            <span>{DOT_LABEL[status]}</span>
            {chat.branch && (
              <span class="chip" title={chat.cwd}>
                <Icon name="branch" />
                {chat.branch}
              </span>
            )}
            {chat.merged && <span class="tag">merged</span>}
          </div>
        </div>
        <div class="chat-head-actions">
          <HandoffMenu chat={chat} compact={compact} />
          <AskMenu chat={chat} compact={compact} />
          <PipeMenu chat={chat} state={state} compact={compact} />
          <button
            class="ghost icon-btn sm"
            title={chat.archived ? 'Unarchive' : 'Archive'}
            aria-label={chat.archived ? 'Unarchive' : 'Archive'}
            onClick={() => send({ type: 'archive', chatId: chat.id, archived: !chat.archived })}
          >
            <Icon name={chat.archived ? 'unarchive' : 'archive'} />
          </button>
        </div>
      </header>
      {chat.origin && parent && (
        <div class="origin-banner" data-kind={chat.origin.kind}>
          <Icon name={chat.origin.kind === 'handoff' ? 'handoff' : 'ask'} />
          <span>{chat.origin.kind === 'handoff' ? 'Continues' : 'Asked by'}</span>
          <button class="link-chip" title={parent.title} onClick={() => onSelect(parent.id)}>
            <Glyph agent={parent.agent} size="sm" />
            {parent.label}
          </button>
          <span class="origin-title">{parent.title}</span>
          {chat.origin.by === 'agent' && <span class="tag">by agent</span>}
        </div>
      )}
      {(chips.length > 0 || chat.archived) && (
        <div class="link-strip">
          {chat.archived && <span class="tag">archived</span>}
          {chips.map((b) => (
            <span key={b.text} class="badge" data-kind={b.kind}>
              <button class="badge-btn" onClick={() => (b.chatId ? onSelect(b.chatId) : send({ type: 'openTasks' }))} title={b.chatId ? 'Open that chat' : 'Compare in the Agent Manager'}>
                <Icon name={b.kind === 'pipe' ? 'pipe' : b.kind === 'consult' ? 'ask' : b.kind === 'group' ? 'compare' : 'handoff'} />
                {b.text}
              </button>
              {b.linkId && (
                <button class="badge-x" aria-label={`Stop: ${b.text}`} title="Stop the pipe" onClick={() => send({ type: 'unlink', linkId: b.linkId! })}>
                  <Icon name="close" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function Empty() {
  return (
    <div class="empty">
      <h2>Start a chat</h2>
      <div class="pick">
        {AGENT_KEYS.map((agent) => (
          <button key={agent} class="pick-agent" onClick={() => send({ type: 'newChat', agent })}>
            <Glyph agent={agent} size="lg" />
            <span>{AGENT_FACES[agent].name}</span>
            {agent === 'demo' && <span class="hint">offline</span>}
          </button>
        ))}
      </div>
      <p class="hint">
        No sign-in yet? <strong>Demo</strong>, then <code>tour</code> or <code>project</code>.
      </p>
    </div>
  );
}

type Group = { kind: 'steps'; items: Extract<Item, { kind: 'tool' }>[]; at: number } | { kind: 'one'; item: Item; at: number };

/** Consecutive tool calls read as one timeline of steps. */
function group(items: Item[]): Group[] {
  const out: Group[] = [];
  items.forEach((item, at) => {
    const last = out.at(-1);
    if (item.kind === 'tool' && last?.kind === 'steps') last.items.push(item);
    else if (item.kind === 'tool') out.push({ kind: 'steps', items: [item], at });
    else out.push({ kind: 'one', item, at });
  });
  return out;
}

function Transcript({ chat, state, reveal, onSelect }: { chat: ChatView; state: AppState; reveal: { id: string; n: number } | null; onSelect: Select }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  });
  useEffect(() => {
    stick.current = true;
  }, [chat.id]);
  useEffect(() => {
    if (!reveal) return;
    const el = document.getElementById(`item-${reveal.id}`);
    el?.scrollIntoView({ block: 'center' });
    el?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [reveal]);
  const lastChanges = chat.items.map((i) => i.kind).lastIndexOf('changes');
  const waiting = new Set(chat.items.flatMap((i) => (i.kind === 'permission' && !i.answer && i.toolCallId ? [i.toolCallId] : [])));
  const conflicts = fileConflicts(state).filter((f) => f.chats.includes(chat.id));

  return (
    <div
      class="transcript"
      ref={box}
      aria-live="polite"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {group(chat.items).map((g) =>
        g.kind === 'steps' ? (
          <Steps key={g.at} tools={g.items} waiting={waiting} />
        ) : (
          <ItemView key={g.at} item={g.item} chat={chat} state={state} conflicts={conflicts} onSelect={onSelect} canUndo={g.at === lastChanges && !chat.busy} />
        ),
      )}
      {chat.busy && !chat.items.some(isWaiting) && (
        <div class="working">
          <Dot state="working" /> {chat.label} is working…
        </div>
      )}
    </div>
  );
}

const isWaiting = (i: Item) =>
  (i.kind === 'permission' && !i.answer) ||
  (i.kind === 'review' && i.state === 'pending') ||
  (i.kind === 'command' && i.state === 'awaiting') ||
  (i.kind === 'bridge' && i.state === 'awaiting');

const TOOL_STATE: Record<string, string> = { completed: 'done', in_progress: 'working', failed: 'error', pending: 'next' };
const PLAN_STATE: Record<string, string> = { completed: 'done', in_progress: 'working', pending: 'next' };

function Steps({ tools, waiting }: { tools: Extract<Item, { kind: 'tool' }>[]; waiting: Set<string> }) {
  return (
    <ol class="steps" aria-label="Steps">
      {tools.map((t) => {
        const state = waiting.has(t.id) ? 'needs-you' : (TOOL_STATE[t.status ?? 'pending'] ?? 'next');
        return (
          <li key={t.id} data-state={state}>
            <Dot state={state} />
            <span class="step-title">{t.title}</span>
            {t.toolKind && <span class="tag">{t.toolKind}</span>}
            {t.locations.slice(0, 3).map((l) => (
              <button key={l} class="ref" title={l} onClick={() => send({ type: 'openFile', path: l })}>
                {basename(l)}
              </button>
            ))}
          </li>
        );
      })}
    </ol>
  );
}

function ItemView({
  item,
  chat,
  state,
  conflicts,
  onSelect,
  canUndo,
}: {
  item: Item;
  chat: ChatView;
  state: AppState;
  conflicts: FileConflict[];
  onSelect: Select;
  canUndo: boolean;
}) {
  switch (item.kind) {
    case 'user':
      return (
        <div class="bubble">
          {item.text && <div class="bubble-text">{item.text}</div>}
          {item.images.length > 0 && (
            <div class="thumbs">
              {item.images.map((id) => {
                const img = state.images.find((i) => i.id === id);
                return img ? <img key={id} src={img.src} alt={img.title} /> : null;
              })}
            </div>
          )}
        </div>
      );
    case 'agent':
      return (
        <div class="prose">
          <Markdown text={item.text} />
        </div>
      );
    case 'thought':
      return (
        <details class="thought">
          <summary>Thinking</summary>
          <div class="thought-text">{item.text}</div>
        </details>
      );
    case 'tool':
      return null; // Rendered in Steps.
    case 'plan': {
      const doneCount = item.entries.filter((e) => e.status === 'completed').length;
      const current = item.entries.findIndex((e) => e.status !== 'completed');
      return (
        <section class="card plan" aria-label="Plan">
          <div class="card-head">
            <span>Plan</span>
            <span class="hint">{current < 0 ? `All ${item.entries.length} steps done` : `Step ${current + 1} of ${item.entries.length}`}</span>
          </div>
          <ol class="steps">
            {item.entries.map((e, i) => {
              const s = PLAN_STATE[e.status] ?? 'next';
              return (
                <li key={i} data-state={s}>
                  <Dot state={s} />
                  <span class="step-title">{e.content}</span>
                </li>
              );
            })}
          </ol>
          <div class="seg-bar" role="progressbar" aria-label="Plan" aria-valuemin={0} aria-valuemax={item.entries.length} aria-valuenow={doneCount}>
            {item.entries.map((e, i) => (
              <i key={i} data-step={e.status === 'completed' ? 'done' : i === current ? 'working' : 'next'} />
            ))}
          </div>
        </section>
      );
    }
    case 'permission':
      if (item.answer) {
        return (
          <div class="answered">
            <Icon name="check" /> {item.title} <span class="hint">· {item.answer}</span>
          </div>
        );
      }
      return (
        <section class="ask" id={`item-${item.requestId}`} aria-label="The agent asks">
          <div class="ask-head">
            <Dot state="needs-you" />
            <Glyph agent={chat.agent} size="sm" /> {chat.label} asks
          </div>
          <div class="ask-body">{item.title}</div>
          <div class="actions">
            {item.options.map((o, i) => (
              <button
                key={o.optionId}
                class={`sm ${o.kind.startsWith('allow') && i === item.options.findIndex((x) => x.kind.startsWith('allow')) ? 'decide' : o.kind.startsWith('reject') ? 'ghost danger' : ''}`}
                onClick={() => send({ type: 'permission', requestId: item.requestId, optionId: o.optionId })}
              >
                {o.name}
              </button>
            ))}
          </div>
        </section>
      );
    case 'review':
      return <Review item={item} chat={chat} state={state} conflicts={conflicts} />;
    case 'command':
      return <Command item={item} chat={chat} />;
    case 'notice':
      return (
        <div class="notice" data-tone={item.tone} role={item.tone === 'error' ? 'alert' : undefined}>
          <div>{item.text}</div>
          {item.detail && <code class="detail">{item.detail}</code>}
          {item.actions && (
            <div class="actions">
              {item.actions.map((a) => (
                <button key={a.label} class="sm" onClick={() => send({ type: 'notice', chatId: chat.id, action: a })}>
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      );
    case 'changes':
      return (
        <section class="card changes" data-undone={item.undone ? 'true' : undefined}>
          <div class="card-head">
            <span>{item.undone ? 'Turn undone' : `Changed ${item.files.length} file${item.files.length === 1 ? '' : 's'}`}</span>
          </div>
          <div class="files">
            {item.files.map((f) => (
              <button key={f} class="ref" title={f} onClick={() => send({ type: 'openFile', path: f })}>
                {basename(f)}
              </button>
            ))}
          </div>
          {!item.undone && (
            <div class="actions">
              {canUndo && (
                <button class="sm" onClick={() => send({ type: 'undo', chatId: chat.id, turnId: item.turnId })}>
                  <Icon name="undo" /> Undo this turn
                </button>
              )}
              <button class="ghost sm" onClick={() => send({ type: 'viewChanges', chatId: chat.id })}>
                <Icon name="diff" /> Changes
              </button>
            </div>
          )}
        </section>
      );
    case 'link':
      return <LinkView item={item} chat={chat} state={state} onSelect={onSelect} />;
    case 'bridge':
      return <BridgeView item={item} chat={chat} state={state} onSelect={onSelect} />;
  }
}

const LINK_HEAD: Record<LinkItem['role'], (label: string) => string> = {
  asked: (l) => `Asked ${l}`,
  reply: (l) => `${l} replied`,
  consulted: (l) => `Asked by ${l}`,
  'handoff-from': (l) => `Continues ${l}`,
  'handoff-to': (l) => `Handed off to ${l}`,
  'piped-in': (l) => `From ${l}`,
  'piped-out': (l) => `Sent to ${l}`,
};
const LINK_ICON = { asked: 'ask', reply: 'ask', consulted: 'ask', 'handoff-from': 'handoff', 'handoff-to': 'handoff', 'piped-in': 'pipe', 'piped-out': 'pipe' } as const;
/** Words the other agent wrote read as its prose; words sent to it read as a quote. */
const LINK_PROSE = new Set<LinkItem['role']>(['reply', 'handoff-from', 'piped-in', 'consulted']);

/** A message that crossed between two chats, with the other agent's face and a way there. */
function LinkView({ item, chat, state, onSelect }: { item: LinkItem; chat: ChatView; state: AppState; onSelect: Select }) {
  const other = state.chats.find((c) => c.id === item.chatId);
  const long = item.text.length > 700 || item.text.split('\n').length > 12;
  const [expanded, setExpanded] = useState(!long);
  return (
    <section class="link-card" data-role={item.role} aria-label={LINK_HEAD[item.role](item.label)}>
      <div class="link-head">
        <Icon name={LINK_ICON[item.role]} />
        <Glyph agent={item.agent} size="sm" />
        <span class="link-title">{LINK_HEAD[item.role](item.label)}</span>
        {item.role.startsWith('piped') && <span class="tag">pipe</span>}
        {item.by === 'agent' && <span class="tag">by agent</span>}
        <span class="spacer" />
        {other && other.id !== chat.id && (
          <button class="ghost sm" onClick={() => onSelect(other.id)}>
            Open <Icon name="open" />
          </button>
        )}
      </div>
      {item.text && (
        <div class={`link-body ${expanded ? '' : 'clamped'}`}>
          {LINK_PROSE.has(item.role) ? <Markdown text={item.text} /> : <div class="quote">{item.text}</div>}
        </div>
      )}
      {(long || item.role === 'reply') && (
        <div class="actions">
          {item.role === 'reply' && (
            <button
              class="sm"
              disabled={!other}
              title={other ? `Give this answer to ${chat.label} as a message` : 'That chat is gone'}
              onClick={() => send({ type: 'forward', fromChatId: item.chatId, toChatId: chat.id })}
            >
              <Icon name="send" /> Send to {chat.label}
            </button>
          )}
          {long && (
            <button class="ghost sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Show less' : 'Show all'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

const BRIDGE_TOOL: Record<BridgeItem['tool'], string> = { ask_agent: 'Question', send_to_chat: 'Message', read_chat: 'Read the transcript' };

/** An agent asks to reach another agent or chat through the FriedLiver tools: a decision. */
function BridgeView({ item, chat, state, onSelect }: { item: BridgeItem; chat: ChatView; state: AppState; onSelect: Select }) {
  const title = bridgeTitle(state, chat, item);
  const target = 'chatId' in item.target ? state.chats.find((c) => c.id === (item.target as { chatId: string }).chatId) : undefined;
  const targetAgent = 'agent' in item.target ? item.target.agent : target?.agent;
  if (item.state !== 'awaiting') {
    return (
      <div class="answered">
        <Icon name={item.state === 'allowed' ? 'check' : 'close'} /> {title} <span class="hint">· {item.state === 'allowed' ? 'allowed' : 'denied'}</span>
      </div>
    );
  }
  return (
    <section class="ask bridge" id={`item-${item.requestId}`} aria-label={title}>
      <div class="ask-head">
        <Dot state="needs-you" />
        <Glyph agent={chat.agent} size="sm" />
        <span>{title}</span>
        {targetAgent && (
          <>
            <Icon name="handoff" />
            <Glyph agent={targetAgent} size="sm" />
          </>
        )}
      </div>
      {target && (
        <button class="link-chip" onClick={() => onSelect(target.id)} title={target.title}>
          <Glyph agent={target.agent} size="sm" />
          {target.label}
          <span class="hint">{clip(target.title, 40)}</span>
        </button>
      )}
      {item.text && (
        <div class="bridge-text">
          <div class="bridge-label">{BRIDGE_TOOL[item.tool]}</div>
          {item.text}
        </div>
      )}
      <div class="actions">
        <button class="decide sm" onClick={() => send({ type: 'bridge', requestId: item.requestId, answer: 'allow' })}>
          Allow
        </button>
        <button class="sm" title="Allow this and later requests from this chat" onClick={() => send({ type: 'bridge', requestId: item.requestId, answer: 'allowChat' })}>
          Allow for this chat
        </button>
        <button class="ghost danger sm" onClick={() => send({ type: 'bridge', requestId: item.requestId, answer: 'deny' })}>
          Deny
        </button>
      </div>
    </section>
  );
}

function Stats({ item }: { item: ReviewItem }) {
  return (
    <span class="stats">
      <span class="plus">+{item.added}</span> <span class="minus">−{item.removed}</span>
    </span>
  );
}

/** "also in Codex 2" when another open chat changed the same file. */
function ConflictChip({ item, chat, state, conflicts }: { item: ReviewItem; chat: ChatView; state: AppState; conflicts: FileConflict[] }) {
  const file = relativePath(chat.cwd, item.path);
  const hit = conflicts.find((f) => f.file === file);
  if (!hit) return null;
  const others = hit.chats.filter((id) => id !== chat.id).flatMap((id) => state.chats.find((c) => c.id === id)?.label ?? []);
  return (
    <span class="badge conflict" title={`${file} is changed in ${others.join(', ')} too: they clash when merged`}>
      <Icon name="diff" />
      also in {others.join(', ')}
    </span>
  );
}

function Review({ item, chat, state, conflicts }: { item: ReviewItem; chat: ChatView; state: AppState; conflicts: FileConflict[] }) {
  const name = basename(item.path);
  if (item.state !== 'pending') {
    return (
      <div class="answered">
        <Icon name={item.state === 'accepted' ? 'check' : 'close'} /> {item.state === 'accepted' ? 'Accepted' : 'Rejected'} edit to{' '}
        <button class="link" title={item.path} onClick={() => send({ type: 'openFile', path: item.path })}>
          {name}
        </button>{' '}
        <Stats item={item} />
        <ConflictChip item={item} chat={chat} state={state} conflicts={conflicts} />
      </div>
    );
  }
  return (
    <section class="ask" id={`item-${item.reviewId}`} aria-label="Edit to review">
      <div class="ask-head">
        <Dot state="needs-you" />
        <Glyph agent={chat.agent} size="sm" /> {item.isNew ? 'New file to review' : 'Edit to review'}
      </div>
      <div class="file-line">
        <button class="file-row" title={`${item.path}: open the diff`} onClick={() => send({ type: 'review', reviewId: item.reviewId, action: 'open' })}>
          <Icon name="file" /> <span class="file-name">{name}</span> <Stats item={item} />
        </button>
        <ConflictChip item={item} chat={chat} state={state} conflicts={conflicts} />
      </div>
      <div class="actions">
        <button class="decide sm" onClick={() => send({ type: 'review', reviewId: item.reviewId, action: 'accept' })}>
          <Icon name="check" /> Accept
        </button>
        <button class="ghost danger sm" onClick={() => send({ type: 'review', reviewId: item.reviewId, action: 'reject' })}>
          Reject
        </button>
        <button class="ghost sm" onClick={() => send({ type: 'review', reviewId: item.reviewId, action: 'open' })}>
          Open diff
        </button>
      </div>
    </section>
  );
}

const COMMAND_STATE: Record<CommandItem['state'], string> = { awaiting: 'needs-you', running: 'working', denied: 'idle', exited: 'done' };

function Command({ item, chat }: { item: CommandItem; chat: ChatView }) {
  if (item.state === 'awaiting') {
    return (
      <section class="ask" id={`item-${item.commandId}`} aria-label="Command to approve">
        <div class="ask-head">
          <Dot state="needs-you" />
          <Glyph agent={chat.agent} size="sm" /> {chat.label} wants to run a command
        </div>
        <pre class="cmdline">
          <span class="prompt">$ </span>
          {item.commandLine}
        </pre>
        <div class="hint mono" title={item.cwd}>
          in {item.cwd}
        </div>
        {item.outside && <div class="warn">This folder is outside the workspace.</div>}
        <div class="actions">
          <button class="decide sm" onClick={() => send({ type: 'command', commandId: item.commandId, approve: true })}>
            <Icon name="play" /> Run
          </button>
          <button class="ghost danger sm" onClick={() => send({ type: 'command', commandId: item.commandId, approve: false })}>
            Deny
          </button>
        </div>
      </section>
    );
  }
  const failed = item.state === 'exited' && item.exitCode !== 0;
  const meta =
    item.state === 'denied'
      ? 'denied'
      : item.state === 'running'
        ? 'running…'
        : `exit ${item.exitCode ?? '?'}${item.durationMs !== undefined ? ` · ${formatDuration(item.durationMs)}` : ''}`;
  return (
    <section class="command" id={`item-${item.commandId}`} data-failed={failed ? '' : undefined}>
      <div class="command-head">
        <Dot state={failed ? 'error' : COMMAND_STATE[item.state]} />
        <code class="command-line" title={item.commandLine}>
          <span class="prompt">$ </span>
          {shortCommand(item.commandLine, 200)}
        </code>
        <span class="hint">{meta}</span>
      </div>
      {item.output && <pre class="output">{item.output}</pre>}
    </section>
  );
}

function Composer({ chat, attachments, setAttachments }: { chat: ChatView; attachments: Attachment[]; setAttachments(fn: (a: Attachment[]) => Attachment[]): void }) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [shut, setShut] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  useEffect(() => area.current?.focus(), [chat.id]);

  // "@" at the very start picks an agent to ask; the answer comes back into this chat.
  const query = shut ? null : mentionQuery(text, caret);
  const options = query === null ? [] : mentionOptions(query);
  const picking = options.length > 0;
  const picked = options[Math.min(pick, options.length - 1)];
  const asking = mentionedAgent(text);
  const question = parseMention(text);

  const reset = () => {
    setText('');
    setCaret(0);
    setAttachments(() => []);
  };
  const submit = () => {
    if (asking) {
      if (!question) return;
      // Images go with an ordinary message; the host reads the leading @ there too.
      if (attachments.length) send({ type: 'send', chatId: chat.id, text: text.trim(), images: attachments });
      else send({ type: 'consult', chatId: chat.id, agent: question.agent, text: question.text });
      reset();
      return;
    }
    if (chat.busy || (!text.trim() && attachments.length === 0)) return;
    send({ type: 'send', chatId: chat.id, text: text.trim(), images: attachments });
    reset();
  };
  const choose = (o: (typeof options)[number]) => {
    const next = applyMention(text, o);
    // Write the field now, not on the next render, so keys typed right after land after the mention.
    if (area.current) {
      area.current.value = next.text;
      area.current.setSelectionRange(next.caret, next.caret);
    }
    setText(next.text);
    setCaret(next.caret);
  };
  const track = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length);

  const addFiles = (files: File[]) => {
    for (const file of files) {
      if (!IMAGE_TYPES.test(file.type) || file.size > MAX_IMAGE_BYTES) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        setAttachments((list) => [...list, { name: file.name || 'pasted image', mimeType: file.type, data: url.slice(url.indexOf(',') + 1) }].slice(0, 10));
      };
      reader.readAsDataURL(file);
    }
  };

  const canSend = asking ? !!question : !chat.busy && (!!text.trim() || attachments.length > 0);
  return (
    <div
      class="composer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length) {
          e.preventDefault();
          addFiles(files);
        }
      }}
    >
      {picking && (
        <div class="mention-menu" id={listId} role="listbox" aria-label="Ask an agent">
          {options.map((o) => (
            <div
              key={o.agent}
              id={`${listId}-${o.agent}`}
              role="option"
              class="pick-row"
              aria-selected={o === picked}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(o);
              }}
              onMouseMove={() => setPick(options.indexOf(o))}
            >
              <Glyph agent={o.agent} size="sm" />
              <span class="pick-title">{o.name}</span>
              <span class="pick-label">@{o.insert}</span>
            </div>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div class="thumbs">
          {attachments.map((a, i) => (
            <button key={i} class="thumb" title={`Remove ${a.name}`} onClick={() => setAttachments((list) => list.filter((_, n) => n !== i))}>
              <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name} />
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={area}
        value={text}
        rows={2}
        aria-label={`Message ${chat.label}`}
        aria-autocomplete="list"
        aria-controls={picking ? listId : undefined}
        aria-activedescendant={picking && picked ? `${listId}-${picked.agent}` : undefined}
        placeholder={`Message ${chat.label} · @ asks another agent`}
        onInput={(e) => {
          setText(e.currentTarget.value);
          track(e.currentTarget);
          setShut(false);
          setPick(0);
        }}
        onKeyUp={(e) => !['ArrowUp', 'ArrowDown'].includes(e.key) && track(e.currentTarget)}
        onClick={(e) => track(e.currentTarget)}
        onBlur={() => setShut(true)}
        onFocus={() => setShut(false)}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData?.items ?? [])
            .filter((i) => i.kind === 'file')
            .map((i) => i.getAsFile())
            .filter((f): f is File => f !== null && f.type.startsWith('image/'));
          if (files.length) {
            e.preventDefault();
            addFiles(files);
          }
        }}
        onKeyDown={(e) => {
          if (picking && picked) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setPick((p) => (Math.min(p, options.length - 1) + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
              return;
            }
            if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
              e.preventDefault();
              choose(picked);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setShut(true);
              return;
            }
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div class="composer-bar">
        <button class="ghost icon-btn" aria-label="Attach images" title="Attach images" onClick={() => send({ type: 'attach' })}>
          <Icon name="attach" />
        </button>
        <span class="composer-agent">
          {asking ? (
            <>
              <Icon name="ask" /> <Glyph agent={asking} size="sm" /> {AGENT_FACES[asking].name} · reply comes back here
            </>
          ) : (
            <>
              <Glyph agent={chat.agent} size="sm" /> {chat.label}
            </>
          )}
        </span>
        <span class="spacer" />
        {chat.busy && (
          <button class="ghost danger sm" onClick={() => send({ type: 'stop', chatId: chat.id })}>
            <Icon name="stop" /> Stop
          </button>
        )}
        {(!chat.busy || asking) && (
          <button class="primary sm" onClick={submit} disabled={!canSend}>
            <Icon name={asking ? 'ask' : 'send'} /> {asking ? `Ask ${AGENT_FACES[asking].name}` : 'Send'}
          </button>
        )}
      </div>
    </div>
  );
}

render(<App />, document.getElementById('root')!);
