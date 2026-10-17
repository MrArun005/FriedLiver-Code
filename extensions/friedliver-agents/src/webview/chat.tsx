import { render } from 'preact';
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Attachment } from '../shared/messages';
import {
  AGENT_FACES,
  AGENT_KEYS,
  boardColumn,
  bridgeTitle,
  fileConflicts,
  formatDuration,
  waitingItems,
  parseMention,
  shortCommand,
  type AgentKey,
  type AppState,
  type BridgeItem,
  type ChatView,
  type CodeRef,
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
  rosterKey,
  slashAction,
  slashMenu,
  switcherGroups,
  switcherMeta,
  transcriptGroups,
  statusOf,
} from '../shared/view';
import { applyFile, hashQuery, nextInCycle, slashOptions, slashQuery } from '../shared/session';
import { foldApprovals } from '../shared/steps';
import { CopyButton, useNow, DOT_LABEL, Dot, Glyph, Icon, ImageThumb, LiveState, Markdown, Popover, basename, isTyping, memo, send, useHost, usePersisted, useWidth } from './common';
import { AskMenu, PipeTargets } from './connect';
import { AlwaysAllow, AutoBadge, EditsBar, PermissionCard, QuestionCard, QueueList, SessionControls, UsageMeter, decisionKey } from './controls';
import { Steps } from './steps';
import { TextSize } from './textSize';
import { chatImages } from '../shared/stepImages';
import { RunningAgents, SubagentCard } from './subagents';
import { RefList, refsOf, sameRef } from './refs';

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|bmp|svg\+xml)$/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** The mic button: macOS dictation, which only the FriedLiver app on a Mac can start. */
const MAC = document.body.dataset.platform === 'darwin';
/** From this width the chat list sits beside the chat. */
const WIDE = 900;

type Select = (chatId: string) => void;

function App() {
  // Images and code references waiting in each chat's composer, so they go with that chat's next message only.
  const [attachments, setAttachments] = useState<Record<string, Attachment[]>>({});
  const [reveal, setReveal] = useState<{ id: string; n: number } | null>(null);
  const [refs, setRefs] = useState<Record<string, CodeRef[]>>({});
  const [focusTick, setFocusTick] = useState(0);
  const [found, setFound] = useState<{ chatId: string; query: string; files: string[] } | null>(null);
  const shown = useRef<string | undefined>(undefined);
  const { state, selected, setSelected } = useHost((m) => {
    if (m.type === 'foundFiles') setFound({ chatId: m.chatId, query: m.query, files: m.files });
    if (m.type === 'attached') {
      const to = m.chatId ?? shown.current;
      if (to) setAttachments((all) => ({ ...all, [to]: [...(all[to] ?? []), ...m.images].slice(0, 10) }));
    }
    if (m.type === 'reveal') setReveal((r) => ({ id: m.id, n: (r?.n ?? 0) + 1 }));
    if (m.type === 'addRef') {
      setRefs((all) => (all[m.chatId]?.some((r) => sameRef(r, m.ref)) ? all : { ...all, [m.chatId]: [...(all[m.chatId] ?? []), m.ref].slice(-10) }));
      setFocusTick((n) => n + 1);
    }
  });
  // The selected chat even when archived (opened from History); otherwise the newest open one.
  const chat = state.chats.find((c) => c.id === selected) ?? openChats(state.chats).at(-1);
  shown.current = chat?.id;

  const select = useCallback((chatId: string) => {
    setSelected(chatId);
    send({ type: 'select', chatId });
  }, []);
  const conflicts = chat ? fileConflicts(state).filter((f) => f.chats.includes(chat.id)) : [];
  // Wide (the chat in the editor area): the chat list stays open beside it. Narrow: tabs and a dropdown.
  const wide = useWidth() >= WIDE;

  return (
    <LiveState.Provider value={state}>
      <div class="chat-app" data-wide={wide ? '' : undefined}>
        <TextSize />
        {wide ? (
          <aside class="chat-side" aria-label="Chats">
            <AllChats state={state} active={chat?.id} onPick={select} newAgent={chat?.agent} />
          </aside>
        ) : (
          <Switcher state={state} active={chat?.id} onSelect={select} />
        )}
        <div class="chat-main">
        {chat ? (
          <>
            <ChatHeader chat={chat} state={state} onSelect={select} />
            <Transcript
              chat={chat}
              state={state}
              roster={rosterKey(state.chats)}
              conflicts={conflicts}
              conflictKey={JSON.stringify(conflicts)}
              reveal={reveal}
              onSelect={select}
            />
            <RunningAgents chat={chat} />
            <Composer
              key={chat.id}
              chat={chat}
              attachments={attachments[chat.id] ?? []}
              setAttachments={(fn) => setAttachments((all) => ({ ...all, [chat.id]: fn(all[chat.id] ?? []) }))}
              refs={refs[chat.id] ?? []}
              setRefs={(fn) => setRefs((all) => ({ ...all, [chat.id]: fn(all[chat.id] ?? []) }))}
              focusTick={focusTick}
              found={found?.chatId === chat.id ? found : null}
            />
          </>
        ) : (
          <Empty />
        )}
        </div>
      </div>
    </LiveState.Provider>
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
            <AutoBadge chat={c} short />
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

function AllChats({ state, active, onPick, newAgent }: { state: AppState; active?: string; onPick: Select; newAgent?: AgentKey }) {
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const listId = useId();
  const now = useNow(10_000);
  const groups = switcherGroups(state.chats, query);
  const flat = groups.flatMap((g) => g.chats);
  const current = flat[Math.min(at, flat.length - 1)];
  const archived = state.chats.filter((c) => c.archived).length;
  useEffect(() => {
    if (current) document.getElementById(`${listId}-${current.id}`)?.scrollIntoView({ block: 'nearest' });
  }, [current?.id]);
  return (
    <div class="all-chats">
      <button class="primary new-chat" onClick={() => send({ type: 'newChat', agent: newAgent ?? 'claude' })} title="New chat">
        <span>
          <Icon name="plus" /> New chat
        </span>
        <kbd>{IS_MAC ? '⌘N' : 'Ctrl+N'}</kbd>
      </button>
      <label class="search">
        <Icon name="search" />
        <input
          type="search"
          aria-controls={listId}
          aria-activedescendant={current ? `${listId}-${current.id}` : undefined}
          aria-label="Search chats"
          placeholder="Search chats…"
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
          <div key={g.status} role="group" aria-label={g.title}>
            <div class="pop-group" aria-hidden="true">
              {g.status === 'starred' ? <Icon name="star" /> : <Dot state={g.status} still />}
              {g.title}
              <span class="col-count">{g.chats.length}</span>
            </div>
            {g.chats.map((c) => (
              <div
                key={c.id}
                id={`${listId}-${c.id}`}
                role="option"
                class="pick-row chat-item"
                aria-selected={c === current}
                data-open={c.id === active ? '' : undefined}
                onClick={() => onPick(c.id)}
                onMouseMove={() => setAt(flat.indexOf(c))}
              >
                <span class="chat-item-text">
                  <span class="pick-title" title={`${c.title} (${c.label}) · ${switcherMeta(c, now)}`}>
                    {c.title}
                  </span>
                </span>
                <span class="chat-item-more" onClick={(e) => e.stopPropagation()}>
                  <Popover label={`More for ${c.title}`} title="More" align="end" buttonClass="ghost icon-btn sm" trigger={<Icon name="more" />}>
                    {(close) => (
                      <>
                        <button
                          role="menuitem"
                          onClick={() => {
                            close();
                            send({ type: 'renameChat', chatId: c.id });
                          }}
                        >
                          <Icon name="rename" /> Rename
                        </button>
                        <button
                          role="menuitem"
                          onClick={() => {
                            close();
                            send({ type: 'star', chatId: c.id, starred: !c.starred });
                          }}
                        >
                          <Icon name="star" /> {c.starred ? 'Unstar' : 'Star'}
                        </button>
                        <button
                          role="menuitem"
                          onClick={() => {
                            close();
                            send({ type: 'archive', chatId: c.id, archived: true });
                          }}
                        >
                          <Icon name="archive" /> Archive
                        </button>
                      </>
                    )}
                  </Popover>
                </span>
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

const IS_MAC = /Mac/.test(navigator.platform);

/** The open chat: who and what, its connections, and the actions that join it to other agents. */
function ChatHeader({ chat, state, onSelect }: { chat: ChatView; state: AppState; onSelect: Select }) {
  const status = statusOf(chat);
  const parent = chat.origin && state.chats.find((c) => c.id === chat.origin!.chatId);
  // The banner covers where this chat came from; chips cover the rest.
  const chips = linkBadges(state, chat).filter((b) => !(b.kind === 'origin' && b.chatId === parent?.id));
  const images = useMemo(() => chatImages(chat.items), [chat.items]);
  return (
    <>
      <header class="chat-head">
        <div class="chat-head-text">
          <div class="chat-head-row">
            <button class="chat-head-title" title={`${chat.title} (${chat.label}) · click to rename`} onClick={() => send({ type: 'renameChat', chatId: chat.id })}>
              {chat.title}
            </button>
            {chat.session?.starting && <span class="tag">Starting {AGENT_FACES[chat.agent].name}…</span>}
            {chat.branch && (
              <span class="chip" title={chat.cwd}>
                <Icon name="branch" />
                {chat.branch}
              </span>
            )}
            {chat.merged && <span class="tag">merged</span>}
          </div>
        </div>
        {images.length > 0 && (
          <Popover label="Images in this chat" title="Images in this chat" kind="dialog" align="end" buttonClass="chip-btn images-pill" trigger={<span class="chip-text">Images · {images.length}</span>}>
            {() => (
              <div class="image-strip">
                {images.map((img) => (
                  <ImageThumb key={img.path} path={img.path} title={img.title} />
                ))}
              </div>
            )}
          </Popover>
        )}
        <span class="status-pill" data-state={status}>
          {DOT_LABEL[status]}
        </span>
        <div class="chat-head-actions">
          <AskMenu chat={chat} compact />
          <button
            class="ghost icon-btn"
            title={chat.starred ? 'Unstar' : 'Star: keep it at the top of the list'}
            aria-label={chat.starred ? 'Unstar' : 'Star'}
            aria-pressed={!!chat.starred}
            onClick={() => send({ type: 'star', chatId: chat.id, starred: !chat.starred })}
          >
            <Icon name="star" />
          </button>
          <Popover label={`More for ${chat.title}`} title="More" align="end" buttonClass="ghost icon-btn" trigger={<Icon name="more" />}>
            {(close) => (
              <>
                <div class="pop-title" aria-hidden="true">Hand off to</div>
                {AGENT_KEYS.map((agent) => (
                  <button
                    key={agent}
                    role="menuitem"
                    onClick={() => {
                      close();
                      send({ type: 'handoff', chatId: chat.id, agent });
                    }}
                  >
                    <Glyph agent={agent} size="sm" />
                    <span class="grow">{AGENT_FACES[agent].name}</span>
                    {agent === chat.agent && <span class="hint">new chat</span>}
                  </button>
                ))}
                <PipeTargets chat={chat} close={close} />
                <div class="pop-sep" role="separator" />
                <button
                  role="menuitem"
                  onClick={() => {
                    close();
                    send({ type: 'archive', chatId: chat.id, archived: !chat.archived });
                  }}
                >
                  <Icon name={chat.archived ? 'unarchive' : 'archive'} /> {chat.archived ? 'Unarchive' : 'Archive'}
                </button>
              </>
            )}
          </Popover>
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
      <p class="hint">
        <button class="link" onClick={() => send({ type: 'otherAgents' })}>
          Get another agent extension…
        </button>
      </p>
    </div>
  );
}

interface TranscriptProps {
  chat: ChatView;
  /** For other chats' names, images and shared files; what the transcript reads of it is in `roster`, `conflictKey` and `state.images`. */
  state: AppState;
  roster: string;
  conflicts: FileConflict[];
  conflictKey: string;
  reveal: { id: string; n: number } | null;
  onSelect: Select;
}

/** Drawn again when this chat, or what it shows of the others, changed: not for every chunk another agent streams. */
const Transcript = memo(
  TranscriptView,
  (a: TranscriptProps, b: TranscriptProps) =>
    a.chat === b.chat &&
    a.roster === b.roster &&
    a.conflictKey === b.conflictKey &&
    a.state.images === b.state.images &&
    a.reveal === b.reveal &&
    a.onSelect === b.onSelect,
);

function TranscriptView({ chat, state, roster, conflicts, conflictKey, reveal, onSelect }: TranscriptProps) {
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
  const { items, approvals } = useMemo(() => foldApprovals(chat.items), [chat.items]);
  const lastChanges = items.map((i) => i.kind).lastIndexOf('changes');
  const waiting = new Set(chat.items.flatMap((i) => (i.kind === 'permission' && !i.answer && i.toolCallId ? [i.toolCallId] : [])));
  const waitingKey = [...waiting].join('\n');
  const waitingNow = waitingItems(chat.items).length > 0;

  const asks = items.flatMap((i, at) => (i.kind === 'user' && i.text.trim() ? [{ at, text: i.text }] : []));
  const jump = asks.length >= 2;
  const seen = useInView(box, jump ? asks.map((a) => `msg-${a.at}`) : []);
  return (
    <div class="transcript-wrap" data-jump={jump ? '' : undefined}>
    <div
      class="transcript"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {transcriptGroups(items).map((g) =>
        g.kind === 'subagent' ? (
          <SubagentCard key={g.at} chat={chat} item={g.item} steps={g.steps} />
        ) : g.kind === 'steps' ? (
          <Steps key={g.at} tools={g.items} approvals={approvals} waiting={waiting} waitingKey={waitingKey} busy={chat.busy} chatId={chat.id} cwd={chat.cwd} />
        ) : (
          <TranscriptItem
            key={g.at}
            item={g.item}
            chat={chat}
            state={state}
            roster={roster}
            conflicts={conflicts}
            conflictKey={conflictKey}
            onSelect={onSelect}
            canUndo={g.at === lastChanges && !chat.busy}
            live={chat.busy && g.at === items.length - 1}
            at={g.at}
          />
        ),
      )}
      <QueueList chat={chat} />
      {chat.busy && !waitingNow && (
        <div class="working">
          <Dot state="working" /> Working…
        </div>
      )}
      {/* Read out what matters, not every streamed word. */}
      <div class="sr" aria-live="polite">
        {waitingNow ? `${chat.label} needs your decision` : chat.busy ? '' : chat.turns ? `${chat.label} finished` : ''}
      </div>
    </div>
      {jump && (
        <nav class="jump-list" aria-label="In this chat">
          <b>In this chat</b>
          {asks.map((a) => (
            <button key={a.at} class="jump-item" title={a.text} aria-current={(seen ?? `msg-${asks[0].at}`) === `msg-${a.at}` ? 'true' : undefined} onClick={() => scrollToMessage(a.at)}>
              {clip(a.text, 60)}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

/** Puts your message at the top of the transcript. */
function scrollToMessage(at: number) {
  document.getElementById(`msg-${at}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/** The id, of `ids`, of the topmost element showing in `root`: the message you're reading. */
function useInView(root: { current: HTMLElement | null }, ids: string[]): string | undefined {
  const [seen, setSeen] = useState<string | undefined>();
  const key = ids.join(' ');
  useEffect(() => {
    if (!root.current || !ids.length) return;
    const showing = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) showing.add(e.target.id);
          else showing.delete(e.target.id);
        }
        // Showing now, else the last one scrolled past: what you're reading belongs to it.
        const top = root.current!.getBoundingClientRect().top;
        const past = ids.filter((id) => (document.getElementById(id)?.getBoundingClientRect().top ?? Infinity) <= top);
        setSeen(ids.find((id) => showing.has(id)) ?? past.at(-1) ?? ids[0]);
      },
      { root: root.current },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [key]);
  return seen;
}

const PLAN_STATE: Record<string, string> = { completed: 'done', in_progress: 'working', pending: 'next' };

interface ItemProps {
  item: Item;
  chat: ChatView;
  state: AppState;
  roster: string;
  conflicts: FileConflict[];
  conflictKey: string;
  onSelect: Select;
  canUndo: boolean;
  /** The reply still streams in: it isn't collapsed. */
  live?: boolean;
  /** Its index in the transcript, for the "In this chat" list. */
  at: number;
}

/**
 * One transcript item, drawn again only when it changed (the reducer keeps
 * items that didn't as the same objects), or what it shows of this chat or
 * the others did. While a reply streams, only its last item draws.
 */
const TranscriptItem = memo(
  ItemView,
  (a: ItemProps, b: ItemProps) =>
    a.item === b.item &&
    a.canUndo === b.canUndo &&
    a.at === b.at &&
    a.live === b.live &&
    a.chat.id === b.chat.id &&
    a.chat.label === b.chat.label &&
    a.chat.agent === b.chat.agent &&
    a.chat.cwd === b.chat.cwd &&
    a.chat.busy === b.chat.busy &&
    a.roster === b.roster &&
    a.conflictKey === b.conflictKey &&
    a.state.images === b.state.images &&
    a.onSelect === b.onSelect,
);

function ItemView({ item, chat, state, conflicts, onSelect, canUndo, live, at }: ItemProps) {
  switch (item.kind) {
    case 'user':
      return (
        <div class="user-msg" id={`msg-${at}`}>
          <div
            class="bubble"
            role="button"
            tabIndex={0}
            title="Scroll to the top"
            onClick={(e) => !(e.target as HTMLElement).closest('button, a') && scrollToMessage(at)}
            onKeyDown={(e) => e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), scrollToMessage(at))}
          >
            {item.text && <div class="bubble-text">{item.text}</div>}
            <RefList refs={refsOf(item)} cwd={chat.cwd} />
            {item.images.length > 0 && (
              <div class="thumbs">
                {item.images.map((id) => {
                  const img = state.images.find((i) => i.id === id);
                  return img ? <img key={id} src={img.src} alt={img.title} /> : null;
                })}
              </div>
            )}
          </div>
        </div>
      );
    case 'agent':
      return (
        <div class="prose">
          <Markdown key={chat.id} text={item.text} chatId={chat.id} cwd={chat.cwd} full={live} />
          <div class="msg-tools">
            <CopyButton text={item.text} label="Copy reply" />
          </div>
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
                  <Dot state={s} still={!chat.busy} />
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
      return <PermissionCard item={item} chat={chat} />;
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
    case 'question':
      return <QuestionCard item={item} chat={chat} />;
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
          {LINK_PROSE.has(item.role) ? <Markdown text={item.text} chatId={chat.id} cwd={chat.cwd} full /> : <div class="quote">{item.text}</div>}
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

const BRIDGE_TOOL: Record<BridgeItem['tool'], string> = {
  ask_agent: 'Question',
  send_to_chat: 'Message',
  read_chat: 'Read the transcript',
  browser_open: 'Open',
  browser_click: 'Click',
  browser_type: 'Type',
  browser_back: 'Back',
  browser_reload: 'Reload',
};

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
        {item.auto && <span class="hint">· {item.auto}</span>}
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
          <button class="decide sm" title="Run (Ctrl+Enter)" onClick={() => send({ type: 'command', commandId: item.commandId, approve: true })}>
            <Icon name="play" /> Run
          </button>
          <button class="ghost danger sm" title="Deny (Ctrl+Shift+Backspace)" onClick={() => send({ type: 'command', commandId: item.commandId, approve: false })}>
            Deny
          </button>
          {!item.outside && <AlwaysAllow line={item.commandLine} target={{ commandId: item.commandId }} />}
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
        {item.auto && <span class="tag" title="Ran without asking">{item.auto}</span>}
        <span class="hint">{meta}</span>
      </div>
      {item.output && <pre class="output">{item.output}</pre>}
    </section>
  );
}

/** Drafts kept per chat across reloads of the view: text only, the newest few chats. */
const MAX_DRAFTS = 30;

function Composer({
  chat,
  attachments,
  setAttachments,
  refs,
  setRefs,
  focusTick,
  found,
}: {
  chat: ChatView;
  attachments: Attachment[];
  setAttachments(fn: (a: Attachment[]) => Attachment[]): void;
  refs: CodeRef[];
  setRefs(fn: (r: CodeRef[]) => CodeRef[]): void;
  focusTick: number;
  /** Files the host found for the "#" picker. */
  found: { query: string; files: string[] } | null;
}) {
  const [drafts, setDrafts] = usePersisted<Record<string, string>>('drafts', {});
  const [text, setTextState] = useState(drafts[chat.id] ?? '');
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [shut, setShut] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const compact = useWidth() < 360;
  useEffect(() => area.current?.focus(), [chat.id, focusTick]);

  const setText = (value: string) => {
    setTextState(value);
    const rest = Object.fromEntries(Object.entries(drafts).filter(([id]) => id !== chat.id).slice(-(MAX_DRAFTS - 1)));
    setDrafts(value ? { ...rest, [chat.id]: value } : rest);
  };

  // "@" at the very start picks an agent to ask; the answer comes back into this chat.
  const query = shut ? null : mentionQuery(text, caret);
  const mentions = query === null ? [] : mentionOptions(query);
  // "/" at the very start picks one of the agent's own commands, or one of FriedLiver's.
  const state = useContext(LiveState);
  const agentCommands = chat.session?.commands ?? [];
  const commands = slashMenu(agentCommands);
  const slash = shut ? null : slashQuery(text, caret);
  const slashes = slash === null ? [] : slashOptions(commands, slash);
  const menu: { key: string; title: string; label: string; agent?: (typeof mentions)[number]['agent']; choose(): void }[] = mentions.length
    ? mentions.map((o) => ({ key: o.agent, title: o.name, label: `@${o.insert}`, agent: o.agent, choose: () => insert(applyMention(text, o)) }))
    : slashes.map((c) => ({ key: c.name, title: `/${c.name}`, label: c.hint ? `${c.description} · ${c.hint}` : c.description, choose: () => insert({ text: `/${c.name} `, caret: c.name.length + 2 }) }));
  // "#" names a workspace file; the agent gets it as a file, not only as words.
  const hash = shut || mentions.length || slashes.length ? null : hashQuery(text, caret);
  const asked = useRef('');
  useEffect(() => {
    if (!hash || asked.current === hash.query) return;
    const timer = setTimeout(() => {
      asked.current = hash.query;
      send({ type: 'findFiles', chatId: chat.id, query: hash.query });
    }, 120);
    return () => clearTimeout(timer);
  }, [hash?.query]);
  if (hash && found && found.query === hash.query) {
    for (const f of found.files) menu.push({ key: f, title: f.split('/').pop() ?? f, label: f, choose: () => insert(applyFile(text, hash, f)) });
  }
  const picking = menu.length > 0;
  const picked = menu[Math.min(pick, menu.length - 1)];
  const asking = mentionedAgent(text);
  const question = parseMention(text);
  const hint = commands.find((c) => c.hint && text === `/${c.name} `)?.hint;

  const reset = () => {
    setText('');
    setCaret(0);
    setAttachments(() => []);
    setRefs(() => []);
  };
  const withRefs = refs.length ? { refs } : {};
  const empty = !text.trim() && attachments.length === 0 && refs.length === 0;
  const submit = () => {
    if (asking) {
      if (!question) return;
      // Images go with an ordinary message; the host reads the leading @ there too.
      if (attachments.length || refs.length) send({ type: 'send', chatId: chat.id, text: text.trim(), images: attachments, ...withRefs });
      else send({ type: 'consult', chatId: chat.id, agent: question.agent, text: question.text });
      reset();
      return;
    }
    if (empty) return;
    const action = slashAction(text, chat, state.chats, agentCommands);
    if (action === 'incomplete') return;
    if (action) {
      send(action);
      reset();
      return;
    }
    // While the agent works, the message waits in the queue and goes when the turn ends.
    send({ type: 'send', chatId: chat.id, text: text.trim(), images: attachments, ...withRefs });
    reset();
  };
  function insert(next: { text: string; caret: number }) {
    // Write the field now, not on the next render, so keys typed right after land after the choice.
    if (area.current) {
      area.current.value = next.text;
      area.current.setSelectionRange(next.caret, next.caret);
    }
    setText(next.text);
    setCaret(next.caret);
  }
  const track = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length);
  const lastSent = () => [...chat.items].reverse().find((i): i is Extract<Item, { kind: 'user' }> => i.kind === 'user' && !!i.text)?.text;
  const cycle = () => {
    const next = nextInCycle(chat.approval ?? 'ask', chat.session);
    send('plan' in next ? { type: 'plan', chatId: chat.id, on: true } : { type: 'approval', chatId: chat.id, level: next.approval });
  };

  // The waiting decision's keys work from anywhere in the view, not only the message box.
  const live = useRef(chat);
  live.current = chat;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The box handles its own keys; other fields keep theirs.
      if (e.defaultPrevented || isTyping(e.target)) return;
      decisionKey(e, live.current, true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  const canSend = asking ? !!question : !empty;
  const queueing = chat.busy && !asking;
  return (
    <>
      <EditsBar chat={chat} />
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
          <div class="mention-menu" id={listId} role="listbox" aria-label={mentions.length ? 'Ask an agent' : slashes.length ? 'Commands' : 'Files'}>
            {menu.map((o) => (
              <div
                key={o.key}
                id={`${listId}-${o.key}`}
                role="option"
                class="pick-row"
                aria-selected={o === picked}
                onMouseDown={(e) => {
                  e.preventDefault();
                  o.choose();
                }}
                onMouseMove={() => setPick(menu.indexOf(o))}
              >
                {o.agent && <Glyph agent={o.agent} size="sm" />}
                <span class="pick-title">{o.title}</span>
                <span class="pick-label">{o.label}</span>
              </div>
            ))}
            {slashes.length > 0 && !agentCommands.length && !chat.session?.live && (
              <div class="pick-row" aria-disabled="true">
                <span class="pick-label">Agent is starting…</span>
              </div>
            )}
          </div>
        )}
        <RefList refs={refs} cwd={chat.cwd} onRemove={(r) => setRefs((list) => list.filter((x) => !sameRef(x, r)))} />
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
          aria-activedescendant={picking && picked ? `${listId}-${picked.key}` : undefined}
          placeholder={
            chat.busy
              ? 'Message…'
              : chat.session?.starting
                ? `Starting ${AGENT_FACES[chat.agent].name}…`
                : 'Message…   / commands  # files  @ another agent'
          }
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
                setPick((p) => (Math.min(p, menu.length - 1) + (e.key === 'ArrowDown' ? 1 : menu.length - 1)) % menu.length);
                return;
              }
              if ((e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
                e.preventDefault();
                picked.choose();
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setShut(true);
                return;
              }
            }
            if (decisionKey(e, chat, !text.trim())) return;
            if (e.key === 'Tab' && e.shiftKey) {
              // Shift+Tab, as in Claude Code: Ask → Auto-accept edits → Plan.
              e.preventDefault();
              cycle();
              return;
            }
            if (e.key === 'Escape' && !text && chat.busy) {
              e.preventDefault();
              send({ type: 'stop', chatId: chat.id });
              return;
            }
            if (e.key === 'ArrowUp' && !text) {
              const last = lastSent();
              if (last) {
                e.preventDefault();
                insert({ text: last, caret: last.length });
              }
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {chat.busy && text.trim() && <div class="composer-queued">Queued for after this turn · Esc stops</div>}
        <div class="composer-bar">
          <button class="chip-btn icon-btn" aria-label="Attach images" title="Attach images" onClick={() => send({ type: 'attach', chatId: chat.id })}>
            <Icon name="plus" />
          </button>
          {asking ? (
            <span class="composer-agent">
              <Icon name="ask" /> <Glyph agent={asking} size="sm" /> {AGENT_FACES[asking].name} · reply comes back here
            </span>
          ) : (
            <SessionControls chat={chat} compact={compact} />
          )}
          {hint && <span class="hint composer-hint">{hint}</span>}
          <span class="spacer" />
          <UsageMeter usage={chat.session?.usage} compact={compact} />
          {chat.busy && (
            <button class="ghost danger sm" title="Stop (Esc in an empty message box)" onClick={() => send({ type: 'stop', chatId: chat.id })}>
              <Icon name="stop" /> {!compact && 'Stop'}
            </button>
          )}
          {MAC && (
            <button
              class="chip-btn icon-btn mic-btn"
              aria-label="Dictate"
              title="Dictate (Fn Fn)"
              onClick={() => {
                area.current?.focus();
                send({ type: 'dictate' });
              }}
            >
              <Icon name="mic" />
            </button>
          )}
          <button
            class="primary send-btn"
            onClick={submit}
            disabled={!canSend}
            aria-label={asking ? `Ask ${AGENT_FACES[asking].name}` : queueing ? 'Queue' : 'Send'}
            title={asking ? `Ask ${AGENT_FACES[asking].name}` : queueing ? `Sends when ${chat.label} finishes this turn` : 'Send (Enter)'}
          >
            <Icon name={asking ? 'ask' : queueing ? 'queue' : 'up'} />
          </button>
        </div>
      </div>
    </>
  );
}

render(<App />, document.getElementById('root')!);
