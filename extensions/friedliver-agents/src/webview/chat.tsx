import { render } from 'preact';
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { LIMITS, type Attachment, type HostMessage } from '../shared/messages';
import { spliceDictation, type DictationState, type Segment } from '../shared/dictation';
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
  commandLabel,
  tabAfterClose,
  openTab,
  closeTab,
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
import { ClampedText, CopyButton, itemKey, useNow, DOT_LABEL, Dot, Glyph, Icon, ImageThumb, LiveState, Markdown, Popover, basename, isTyping, memo, send, useHost, usePersisted } from './common';
import { AskMenu, PipeTargets } from './connect';
import { AlwaysAllow, AutoBadge, KeyHint, chooseOn, syncDecisionTarget, usageSamples, EditsBar, PermissionCard, QuestionCard, QueueList, decisionKey } from './controls';
import { Steps } from './steps';
import { TextSize } from './textSize';
import { chatImages } from '../shared/stepImages';
import { RunningAgents, SubagentCard } from './subagents';
import { AgentMap, AttachmentChip, ComposerPills, ModeButton, ModelMenu, ModesMenu, SlashMenu, currentMode, type ComposerMenu } from './composerMenus';
import { RefChip, RefList, refsOf, sameRef } from './refs';
import { agentOverride } from '../shared/session';

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|bmp|svg\+xml)$/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** The mic button: dictation through the app's macOS speech helper (host/dictation.ts). */
const MAC = document.body.dataset.platform === 'darwin';
/** This webview is the side bar's chat list, not a chat tab. */
const LIST = document.body.dataset.view === 'list';

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
  // The tabs, as a browser keeps them: the chats opened in this window, in the order they were opened.
  // Closing one takes only the tab away; the chat goes on, in the Chats list and the Agent Manager.
  // A window from before this kept no tabs: the recent chats it showed become its tabs.
  const [saved, setTabs] = usePersisted<string[] | null>('openTabs', null);
  const tabs = (saved ?? (state.chats.length ? recentChats(state.chats, selected, 6).map((c) => c.id) : [])).filter((id) => state.chats.some((c) => c.id === id));
  // Opening a chat (a new one, or from the list, a notification, a card, the Agent Manager) adds its tab at the end.
  useEffect(() => {
    if (selected && state.chats.some((c) => c.id === selected) && !tabs.includes(selected)) setTabs(openTab(tabs, selected));
    else if (saved === null && tabs.length) setTabs(tabs);
  }, [selected, state.chats.length]);
  // The selected chat when it has a tab (archived ones too, opened from History); otherwise the last tab.
  const chat = state.chats.find((c) => c.id === selected) ?? state.chats.find((c) => c.id === tabs.at(-1));
  shown.current = chat?.id;

  const select = useCallback((chatId: string) => {
    setSelected(chatId);
    send({ type: 'select', chatId });
  }, []);
  const close = (chatId: string) => {
    const next = tabAfterClose(tabs, chatId, chat?.id);
    setTabs(closeTab(tabs, chatId));
    if (next && next !== chat?.id) select(next);
    else if (!next) setSelected(undefined);
  };
  const closeActive = useRef(() => {});
  closeActive.current = () => chat && close(chat.id);
  useEffect(() => {
    // Cmd/Ctrl+W closes the open chat's tab; caught before the webview forwards it, so the editor's own tab stays.
    const onKey = (e: KeyboardEvent) => {
      if (!(IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'w') return;
      e.preventDefault();
      e.stopPropagation();
      closeActive.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const conflicts = chat ? fileConflicts(state).filter((f) => f.chats.includes(chat.id)) : [];
  // Wide (the chat in the editor area): the chat list stays open beside it. Narrow: tabs and a dropdown.

  if (LIST) {
    // The side bar's chat list (its own activity-bar view): picking a chat opens it in the chat tab.
    return (
      <LiveState.Provider value={state}>
        <aside class="chat-side chat-list-view" aria-label="Chats">
          <AllChats state={state} active={chat?.id} onPick={(chatId) => send({ type: 'openChat', chatId })} />
        </aside>
      </LiveState.Provider>
    );
  }

  return (
    <LiveState.Provider value={state}>
      <div class="chat-app">
        <TextSize />
        <Switcher state={state} active={chat?.id} onSelect={select} tabs={tabs} onClose={close} />
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
            <Composer
              key={chat.id}
              chat={chat}
              attachments={attachments[chat.id] ?? []}
              setAttachments={(fn) => setAttachments((all) => ({ ...all, [chat.id]: fn(all[chat.id] ?? []) }))}
              refs={refs[chat.id] ?? []}
              setRefs={(fn) => setRefs((all) => ({ ...all, [chat.id]: fn(all[chat.id] ?? []) }))}
              focusTick={focusTick}
              found={found?.chatId === chat.id ? found : null}
              linked={state.chats.filter((c) => c.origin?.chatId === chat.id && !c.archived)}
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
function Switcher({ state, active, onSelect, tabs, onClose }: { state: AppState; active?: string; onSelect: Select; tabs: string[]; onClose(chatId: string): void }) {
  const strip = tabs.flatMap((id) => state.chats.find((c) => c.id === id) ?? []);
  const shortcut = IS_MAC ? '⌘W' : 'Ctrl+W';
  // More tabs than fit: the strip scrolls sideways, its edges fade, and the open tab stays in view.
  const box = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setOver(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs.length]);
  // After the tab is in the strip: a chat opened from the list or a notification gets its new tab shown.
  useEffect(() => {
    box.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, tabs.length]);
  // A tablist: one Tab stop; ←/→/Home/End move between tabs, Enter or Space opens one, Delete closes it.
  const focusable = active && strip.some((c) => c.id === active) ? active : strip[0]?.id;
  const onKeys = (e: KeyboardEvent) => {
    const all = [...(box.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const go = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: all.length - 1 }[e.key];
    if (go !== undefined) {
      e.preventDefault();
      all[(go + all.length) % all.length]?.focus();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      const id = all[at].dataset.chat!;
      const next = all[at + 1] ?? all[at - 1];
      onClose(id);
      requestAnimationFrame(() => next?.isConnected && next.focus());
    }
  };
  const open = openChats(state.chats);
  const needs = open.filter((c) => boardColumn(statusOf(c)) === 'needs-you').length;
  return (
    <div class="switcher">
      <div class="tabs" ref={box} role="tablist" aria-label="Open chats" data-overflow={over ? '' : undefined} onKeyDown={onKeys}>
        {strip.map((c) => (
          <span key={c.id} class="tab-wrap" role="presentation" data-active={c.id === active ? '' : undefined}>
            <button
              role="tab"
              class="tab"
              data-chat={c.id}
              tabIndex={c.id === focusable ? 0 : -1}
              aria-keyshortcuts="Delete"
              aria-selected={c.id === active}
              title={`${c.title} (${c.label})`}
              onClick={() => onSelect(c.id)}
              onAuxClick={(e) => e.button === 1 && (e.preventDefault(), onClose(c.id))}
            >
              <Glyph agent={c.agent} size="sm" />
              <span class="tab-title">{c.title}</span>
              <AutoBadge chat={c} short />
              <Dot state={statusOf(c)} />
            </button>
            {/* For the pointer; the keyboard closes the focused tab with Delete, so it is no Tab stop of its own. */}
            <button type="button" class="tab-close" tabIndex={-1} aria-hidden="true" title={`Close tab (${shortcut} · Delete)`} onClick={() => onClose(c.id)}>
              <Icon name="close" size={12} />
            </button>
          </span>
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
  // The banner covers where this chat came from, and a handoff has its card in the transcript; chips cover the rest.
  const chips = linkBadges(state, chat).filter((b) => !(b.kind === 'origin' && b.chatId === parent?.id) && b.kind !== 'handoff');
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
            {chat.session?.rules?.length ? (
              <span class="chip" title={`Shared rules this session got:\n${chat.session.rules.join('\n')}`}>
                Rules · {chat.session.rules.length} file{chat.session.rules.length === 1 ? '' : 's'}
              </span>
            ) : null}
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
                <button role="menuitem" onClick={() => (close(), send({ type: 'openRules' }))}>
                  Rules…
                </button>
                <button
                  role="menuitem"
                  disabled={chat.busy}
                  onClick={() => {
                    close();
                    send({ type: 'rewind', chatId: chat.id });
                  }}
                >
                  <Icon name="history" /> Checkpoints…
                </button>
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

/** The ids a notification can reveal an item by (its element is item-<id>). */
function revealIds(i: Item): string[] {
  const ids: unknown[] = [i.kind === 'tool' ? i.id : undefined, (i as { requestId?: string }).requestId, (i as { reviewId?: string }).reviewId, (i as { commandId?: string }).commandId];
  return ids.filter((x): x is string => typeof x === 'string');
}

/** Groups shown at first, and added each time you scroll up to the earliest one shown. */
const WINDOW = 120;

function TranscriptView({ chat, state, roster, conflicts, conflictKey, reveal, onSelect }: TranscriptProps) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Only the newest groups are in the page; scrolling up to the first one shown brings earlier ones in.
  const [limit, setLimit] = useState(WINDOW);
  useEffect(() => {
    stick.current = true;
    setLimit(WINDOW);
  }, [chat.id]);
  const { items, approvals } = useMemo(() => foldApprovals(chat.items), [chat.items]);
  // The marked decision card moves on when it is answered: its hint and outline follow.
  useEffect(() => syncDecisionTarget(chat), [chat.items]);
  const groups = useMemo(() => {
    // Keys that stay with their items (common.tsx keyItems), unique in this list.
    const seen = new Set<string>();
    return transcriptGroups(items).map((g) => {
      const first = g.kind === 'steps' ? g.items[0] : g.item;
      let key = String(itemKey(first));
      if (seen.has(key)) key = `${key}:${g.at}`;
      seen.add(key);
      return { ...g, key };
    });
  }, [items]);
  const shownFrom = Math.max(0, groups.length - limit);
  const shown = shownFrom ? groups.slice(shownFrom) : groups;
  // Keep the reading position when earlier groups come in above it.
  const anchor = useRef<{ height: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (anchor.current) {
      el.scrollTop = anchor.current.top + (el.scrollHeight - anchor.current.height);
      anchor.current = null;
    } else if (stick.current) el.scrollTop = el.scrollHeight;
  });
  const more = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = more.current;
    if (!el || !box.current) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting || !box.current) return;
        anchor.current = { height: box.current.scrollHeight, top: box.current.scrollTop };
        setLimit((n) => n + WINDOW);
      },
      { root: box.current, rootMargin: '400px 0px 0px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shownFrom > 0, chat.id]);
  useEffect(() => {
    if (!reveal) return;
    const at = groups.findIndex((g) => (g.kind === 'steps' ? g.items : g.kind === 'subagent' ? [g.item, ...g.steps] : [g.item]).some((i) => revealIds(i).includes(reveal.id)));
    if (at >= 0 && at < shownFrom) {
      setLimit(groups.length - at + 10);
      return;
    }
    const el = document.getElementById(`item-${reveal.id}`);
    el?.scrollIntoView({ block: 'center' });
    el?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [reveal, shownFrom]);
  const lastChanges = items.map((i) => i.kind).lastIndexOf('changes');
  const waiting = new Set(chat.items.flatMap((i) => (i.kind === 'permission' && !i.answer && i.toolCallId ? [i.toolCallId] : [])));
  const waitingKey = [...waiting].join('\n');
  const waitingNow = waitingItems(chat.items).length > 0;

  const asks = groups.flatMap((g) => (g.kind === 'one' && g.item.kind === 'user' && g.item.text.trim() ? [{ key: g.key, text: g.item.text, at: g.at }] : []));
  const jump = asks.length >= 2;
  // The message whose turn you are reading, once it has scrolled out of view: its copy sticks at the top.
  // An IntersectionObserver tells which messages have gone above the view; nothing reads boxes on scroll.
  const [past, setPast] = useState<string | undefined>();
  useEffect(() => {
    const root = box.current;
    if (!root) return;
    const above = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) above.set(e.target.id.slice(4), !e.isIntersecting && e.boundingClientRect.bottom <= (e.rootBounds?.top ?? 0) + 1);
        const ids = [...root.querySelectorAll<HTMLElement>('.user-msg')].map((m) => m.id.slice(4));
        setPast(ids.filter((id) => above.get(id)).at(-1));
      },
      { root },
    );
    for (const m of root.querySelectorAll('.user-msg')) io.observe(m);
    return () => io.disconnect();
  }, [asks.length, shownFrom, chat.id]);
  const pastText = past === undefined ? undefined : asks.find((a) => a.key === past)?.text;
  const seen = useInView(box, jump ? asks.filter((a) => a.at >= (groups[shownFrom]?.at ?? 0)).map((a) => `msg-${a.key}`) : []);
  const show = (key: string, expand?: boolean) => {
    const go = () => (expand ? openMessage(key) : scrollToMessage(key));
    if (document.getElementById(`msg-${key}`)) go();
    else {
      setLimit(groups.length);
      requestAnimationFrame(go);
    }
  };
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
      {shownFrom > 0 && <div ref={more} class="transcript-more" aria-hidden="true" />}
      {shown.map((g) =>
        g.kind === 'subagent' ? (
          <SubagentCard key={g.key} chat={chat} item={g.item} steps={g.steps} />
        ) : g.kind === 'steps' ? (
          <Steps key={g.key} tools={g.items} approvals={approvals} waiting={waiting} waitingKey={waitingKey} busy={chat.busy} chatId={chat.id} cwd={chat.cwd} />
        ) : (
          <TranscriptItem
            key={g.key}
            item={g.item}
            chat={chat}
            state={state}
            roster={roster}
            conflicts={conflicts}
            conflictKey={conflictKey}
            onSelect={onSelect}
            canUndo={g.at === lastChanges && !chat.busy}
            live={chat.busy && g.at === items.length - 1}
            msgKey={g.key}
          />
        ),
      )}
      <QueueList chat={chat} />
      {chat.busy && !waitingNow && (
        <div class="working" role="status">
          <span class="spinner" aria-hidden="true" /> Working…
        </div>
      )}
      {/* Read out what matters, not every streamed word. */}
      <div class="sr" aria-live="polite">
        {waitingNow ? `${chat.label} needs your decision` : chat.busy ? '' : chat.turns ? `${chat.label} finished` : ''}
      </div>
    </div>
      {pastText && (
        <div class="sticky-prompt" aria-label="Your message for this turn">
          <div class="bubble">
            <ClampedText text={pastText} onMore={() => show(past!, true)} />
          </div>
        </div>
      )}
      {jump && (
        <nav class="jump-list" aria-label="In this chat">
          <b>In this chat</b>
          {asks.map((a) => (
            <button key={a.key} class="jump-item" title={a.text} aria-current={(seen ?? `msg-${asks[0].key}`) === `msg-${a.key}` ? 'true' : undefined} onClick={() => show(a.key)}>
              {clip(a.text, 60)}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

/** Puts your message at the top of the transcript. */
function scrollToMessage(key: string) {
  document.getElementById(`msg-${key}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/** Scrolls to your message and opens it in full there (the sticky copy never grows). */
function openMessage(key: string) {
  const msg = document.getElementById(`msg-${key}`);
  msg?.querySelector('.bubble-text')?.dispatchEvent(new CustomEvent('expand'));
  msg?.scrollIntoView({ block: 'start' });
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
  /** Its stable key (keyItems), for the "In this chat" list and the sticky copy. */
  msgKey: string;
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
    a.msgKey === b.msgKey &&
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

function ItemView({ item, chat, state, conflicts, onSelect, canUndo, live, msgKey }: ItemProps) {
  switch (item.kind) {
    case 'user':
      return (
        <div class="user-msg" id={`msg-${msgKey}`}>
          {/* Not a button: it holds Show more and reference buttons (QA F19). */}
          <div class="bubble">
            {item.text && <ClampedText text={item.text} />}
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
          {item.checkpoint && !chat.busy && (
            <button
              type="button"
              class="ghost icon-btn sm rewind-btn"
              title="Rewind to here"
              aria-label="Rewind to here"
              onClick={() => send({ type: 'rewind', chatId: chat.id, turnId: item.checkpoint })}
            >
              <Icon name="history" />
            </button>
          )}
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
        <details class="tl thought">
          <summary>
            Thinking
            <Icon name="chevron" />
          </summary>
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
          <ol class="plan-steps">
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
  remember: 'Fact',
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
    <section class="ask bridge" id={`item-${item.requestId}`} aria-label={title} {...chooseOn(chat, item.requestId)}>
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
          <span class="opt-num">1.</span>Allow
        </button>
        <button class="sm" title="Allow this and later requests from this chat" onClick={() => send({ type: 'bridge', requestId: item.requestId, answer: 'allowChat' })}>
          <span class="opt-num">2.</span>Allow for this chat
        </button>
        <button class="ghost danger sm" onClick={() => send({ type: 'bridge', requestId: item.requestId, answer: 'deny' })}>
          <span class="opt-num">3.</span>Deny
        </button>
      </div>
      <KeyHint chat={chat} id={item.requestId} n={3} />
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
    <section class="ask" id={`item-${item.reviewId}`} aria-label="Edit to review" {...chooseOn(chat, item.reviewId)}>
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
          <span class="opt-num">1.</span>Accept
        </button>
        <button class="ghost danger sm" onClick={() => send({ type: 'review', reviewId: item.reviewId, action: 'reject' })}>
          <span class="opt-num">2.</span>Reject
        </button>
        <button class="ghost sm" onClick={() => send({ type: 'review', reviewId: item.reviewId, action: 'open' })}>
          Open diff
        </button>
      </div>
      <KeyHint chat={chat} id={item.reviewId} n={2} />
    </section>
  );
}

const COMMAND_STATE: Record<CommandItem['state'], string> = { awaiting: 'needs-you', running: 'working', denied: 'idle', exited: 'done' };

function Command({ item, chat }: { item: CommandItem; chat: ChatView }) {
  if (item.state === 'awaiting') {
    return (
      <section class="ask" id={`item-${item.commandId}`} aria-label="Command to approve" {...chooseOn(chat, item.commandId)}>
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
            <span class="opt-num">1.</span>Run
          </button>
          <button class="ghost danger sm" onClick={() => send({ type: 'command', commandId: item.commandId, approve: false })}>
            <span class="opt-num">2.</span>Deny
          </button>
          {!item.outside && <AlwaysAllow line={item.commandLine} target={{ commandId: item.commandId }} />}
        </div>
        <KeyHint chat={chat} id={item.commandId} n={2} />
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
  linked,
}: {
  linked: ChatView[];
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
    : slashes.map((c) => ({ key: c.name, title: commandLabel(c), label: c.description, choose: () => insert({ text: `/${c.name} `, caret: c.name.length + 2 }) }));
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
  const hint = commands.find((c) => c.hint && text === `/${c.name} `)?.hint ?? (chat.busy && text.trim() ? 'Sends after this turn · Esc stops' : undefined);

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
  const [micHint, setMicHint] = useState(false);
  // The mic: what the host's helper hears goes into the box at the caret, each partial replacing the last.
  const [mic, setMic] = useState<DictationState>('idle');
  const spoken = useRef<Segment | null>(null);
  const latestInsert = useRef(insert);
  latestInsert.current = insert;
  const dictate = (on: boolean) => {
    if (on) {
      const el = area.current;
      const start = el?.selectionStart ?? text.length;
      spoken.current = { start, len: (el?.selectionEnd ?? start) - start };
      setMicHint(false);
      setMic('listening');
      el?.focus();
    } else {
      setMic((m) => (m === 'idle' ? m : 'stopping'));
    }
    send({ type: 'dictate', chatId: chat.id, on });
  };
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as HostMessage;
      if (m?.type !== 'dictation' || m.chatId !== chat.id) return;
      if ('text' in m) {
        if (!spoken.current) return;
        const next = spliceDictation(area.current?.value ?? '', spoken.current, m.text, m.final, LIMITS.text);
        spoken.current = next.seg;
        latestInsert.current(next);
        return;
      }
      if (m.state === 'idle' || m.state === 'fallback') spoken.current = null;
      setMic(m.state === 'fallback' ? 'idle' : m.state);
      if (m.state === 'fallback') setMicHint(true);
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      // Another chat, or the view closed: the helper stops.
      if (spoken.current) send({ type: 'dictate', chatId: chat.id, on: false });
    };
  }, [chat.id]);
  useEffect(() => {
    if (mic !== 'listening') return;
    // Esc stops listening (before the box's own Esc, which would stop the agent's turn).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      dictate(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mic]);
  const [openMenu, setMenu] = useState<ComposerMenu>(null);
  const closeMenu = useCallback(() => {
    setMenu(null);
    area.current?.focus();
  }, []);
  useEffect(() => {
    if (!openMenu || openMenu === 'agents') return;
    // A click outside the menu and its buttons closes it.
    const outside = (e: MouseEvent) => {
      const t = e.target as Element;
      if (!t.closest?.('.cc-menu, .cc-pill, .cc-mode, .cc-slash-btn')) setMenu(null);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [openMenu]);
  const samples = usageSamples(chat);
  const queueing = chat.busy && !asking;
  // Busy with nothing typed: the send button stops the turn, as in Claude Code.
  const stopping = chat.busy && !asking && empty;
  const override = agentOverride(chat.approval ?? 'ask', chat.session);
  return (
    <div class="composer-dock">
      <div class="composer-col">
        <div class="banners">
          <EditsBar chat={chat} />
          <RunningAgents chat={chat} />
          {micHint && (
            <div class="banner mic-hint" role="status">
              <span class="banner-text">Press Fn twice to dictate</span>
              <a href="#" onClick={(e) => (e.preventDefault(), send({ type: 'dictationSettings' }))}>
                Dictation settings
              </a>
            </div>
          )}
        </div>
        <div
          class="composer"
          data-mode={override ? 'full' : currentMode(chat)}
          data-menu={openMenu ?? undefined}
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
            <div class="cc-menu cc-typeahead mention-menu" id={listId} role="listbox" aria-label={mentions.length ? 'Ask an agent' : slashes.length ? 'Commands' : 'Files'}>
              {menu.map((o) => (
                <div
                  key={o.key}
                  id={`${listId}-${o.key}`}
                  role="option"
                  class="cc-item pick-row"
                  aria-selected={o === picked}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    o.choose();
                  }}
                  onMouseMove={() => setPick(menu.indexOf(o))}
                >
                  {o.agent && <Glyph agent={o.agent} size="sm" />}
                  <span class="cc-item-name">{o.title}</span>
                  <span class="cc-item-value">{o.label}</span>
                </div>
              ))}
              {slashes.length > 0 && !agentCommands.length && !chat.session?.live && (
                <div class="cc-item pick-row" aria-disabled="true">
                  <span class="cc-item-value">Agent is starting…</span>
                </div>
              )}
            </div>
          )}
          {(attachments.length > 0 || refs.length > 0) && (
            <div class="cc-chips">
              {attachments.map((a, i) => (
                <AttachmentChip key={i} a={a} onRemove={() => setAttachments((list) => list.filter((_, n) => n !== i))} />
              ))}
              {refs.map((r) => (
                <RefChip key={`${r.path}:${r.startLine}-${r.endLine}`} codeRef={r} cwd={chat.cwd} onRemove={() => setRefs((list) => list.filter((x) => !sameRef(x, r)))} />
              ))}
            </div>
          )}
          <div class="cc-input">
            <textarea
              ref={area}
              value={text}
              rows={1}
              aria-label={`Message ${chat.label}`}
              aria-autocomplete="list"
              aria-controls={picking ? listId : undefined}
              aria-activedescendant={picking && picked ? `${listId}-${picked.key}` : undefined}
              placeholder={chat.session?.starting && !chat.busy ? 'Starting…' : 'Message…'}
              onInput={(e) => {
                // Typing takes the box back from the mic.
                if (spoken.current) {
                  spoken.current = null;
                  dictate(false);
                }
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
            {MAC && (
              <button
                type="button"
                class="cc-mic mic-btn"
                data-state={mic === 'idle' ? undefined : mic}
                aria-pressed={mic !== 'idle'}
                aria-label={mic === 'idle' ? 'Dictate' : 'Stop dictating'}
                title={mic === 'listening' ? 'Listening… click to stop' : mic === 'stopping' ? 'Finishing…' : 'Dictate'}
                onClick={() => dictate(mic === 'idle')}
              >
                <Icon name="mic" />
              </button>
            )}
          </div>
          {openMenu === 'model' && <ModelMenu chat={chat} close={closeMenu} />}
          {openMenu === 'modes' && <ModesMenu chat={chat} close={closeMenu} />}
          {openMenu === 'slash' && (
            <SlashMenu
              chat={chat}
              close={closeMenu}
              openModel={() => setMenu('model')}
              mention={() => insert({ text: `${text}${text && !/\s$/.test(text) ? ' ' : ''}#`, caret: text.length + (text && !/\s$/.test(text) ? 2 : 1) })}
              command={(name, run) => (run ? send({ type: 'send', chatId: chat.id, text: `/${name}`, images: [] }) : insert({ text: `/${name} `, caret: name.length + 2 }))}
            />
          )}
          <div class="composer-bar">
            <button type="button" class="cc-icon-btn attach-btn" aria-label="Attach images" title="Attach images" onClick={() => send({ type: 'attach', chatId: chat.id })}>
              <Icon name="plus" size={20} />
            </button>
            <ComposerPills chat={chat} linked={linked} samples={samples} open={setMenu} />
            {asking && (
              <span class="composer-hint composer-agent">
                <Glyph agent={asking} size="sm" /> {AGENT_FACES[asking].name} · reply comes back here
              </span>
            )}
            {hint && <span class="composer-hint">{hint}</span>}
            <span class="spacer" />
            <ModeButton chat={chat} open={setMenu} />
            <button
              class="primary send-btn"
              onClick={stopping ? () => send({ type: 'stop', chatId: chat.id }) : submit}
              disabled={!stopping && !canSend}
              data-stop={stopping ? '' : undefined}
              aria-label={stopping ? 'Stop' : asking ? `Ask ${AGENT_FACES[asking].name}` : queueing ? 'Queue' : 'Send'}
              title={stopping ? 'Stop (Esc in an empty message box)' : asking ? `Ask ${AGENT_FACES[asking].name}` : queueing ? `Sends when ${chat.label} finishes this turn` : 'Send (Enter)'}
            >
              <Icon name={stopping ? 'stop' : asking ? 'ask' : queueing ? 'queue' : 'up'} size={stopping ? 16 : 20} />
            </button>
          </div>
        </div>
      </div>
      {openMenu === 'agents' && <AgentMap chat={chat} linked={linked} close={closeMenu} />}
    </div>
  );
}

render(<App />, document.getElementById('root')!);
