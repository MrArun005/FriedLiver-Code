import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  AGENT_FACES,
  AGENT_KEYS,
  age,
  boardColumn,
  decisions,
  lastReply,
  type AgentKey,
  type AppState,
  type BoardColumn,
  type ChatView,
} from '../shared/model';
import {
  COLUMN_TITLES,
  ago,
  cardLine,
  conflictText,
  conflictsOf,
  counts,
  defaultDir,
  excerpt,
  fanoutGroups,
  filterChats,
  keepPlan,
  linkBadges,
  matchesQuery,
  nextDecision,
  openChats,
  planProgress,
  sortChats,
  statusOf,
  type Badge,
  type CardLine,
  type FanoutGroup,
  type Progress,
  type Sort,
  type SortKey,
} from '../shared/view';
import { DOT_LABEL, Dot, Glyph, Icon, Kbd, Popover, isTyping, scrollBehavior, send, useHost, useNow, usePersisted } from './common';
import { AskMenu, HandoffMenu, PipeMenu } from './connect';
import { AgentMap } from './map';

type View = 'board' | 'list' | 'map';
const VIEWS: { id: View; title: string; icon: 'tasks' | 'list' | 'map' }[] = [
  { id: 'board', title: 'Board', icon: 'tasks' },
  { id: 'list', title: 'List', icon: 'list' },
  { id: 'map', title: 'Map', icon: 'map' },
];

const COLUMNS: { id: BoardColumn; empty: string }[] = [
  { id: 'needs-you', empty: 'Nothing waits for you.' },
  { id: 'working', empty: 'No agent is working.' },
  { id: 'done', empty: 'Finished tasks land here.' },
];

const open = (chatId: string) => send({ type: 'openChat', chatId });

/** Focus the card, row or node for a chat, and flash it so the eye finds it. */
function reveal(chatId: string) {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[data-nav="${CSS.escape(chatId)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    el.focus({ preventScroll: true });
    el.setAttribute('data-flash', '');
    setTimeout(() => el.removeAttribute('data-flash'), 1200);
  });
}

/** The Agent Manager: every chat as a task, by where it stands, in a list, or on a map of how they connect. */
function Manager() {
  const { state } = useHost();
  const now = useNow(15_000);
  const [view, setView] = usePersisted<View>('view', 'board');
  const [sort, setSort] = usePersisted<Sort>('sort', { key: 'status', dir: 'asc' });
  const [query, setQuery] = useState('');
  const [focusId, setFocusId] = useState<string>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const lastJump = useRef<string | undefined>(undefined);

  const shown = useMemo(() => filterChats(openChats(state.chats), query), [state, query]);
  const shownState = useMemo<AppState>(() => ({ ...state, chats: state.chats.filter((c) => c.archived || shown.includes(c)) }), [state, shown]);
  const waiting = useMemo(() => decisions({ chats: openChats(state.chats) }), [state]);
  const tally = counts(state);

  const jump = () => {
    const d = nextDecision(waiting, lastJump.current);
    if (!d) return;
    lastJump.current = d.id;
    const chat = state.chats.find((c) => c.id === d.chatId);
    if (chat && !matchesQuery(chat, query)) setQuery('');
    setFocusId(d.chatId);
    reveal(d.chatId);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('.popover') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(t)) {
        if (e.key === 'Escape' && t === search.current) {
          setQuery('');
          search.current?.blur();
        }
        return;
      }
      const onNav = !t || t === document.body || t.hasAttribute('data-nav');
      if (e.key === '/') {
        e.preventDefault();
        search.current?.focus();
      } else if (e.key === '1' || e.key === '2' || e.key === '3') {
        setView(VIEWS[Number(e.key) - 1].id);
      } else if (e.key === 'j' || (onNav && e.key === 'ArrowDown')) {
        e.preventDefault();
        move(1);
      } else if (e.key === 'k' || (onNav && e.key === 'ArrowUp')) {
        e.preventDefault();
        move(-1);
      } else if (onNav && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        moveColumn(e.key === 'ArrowRight' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const focusEl = (el: HTMLElement | undefined) => {
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest' });
  };
  const holds = (el: HTMLElement) => el === document.activeElement || el.contains(document.activeElement);
  const move = (delta: number) => {
    const all = [...document.querySelectorAll<HTMLElement>('#view [data-nav]')];
    const at = all.findIndex(holds);
    focusEl(all[at < 0 ? 0 : Math.max(0, Math.min(all.length - 1, at + delta))]);
  };
  const moveColumn = (delta: number) => {
    const cols = [...document.querySelectorAll<HTMLElement>('#view [data-column]')].map((c) => [...c.querySelectorAll<HTMLElement>('[data-nav]')]);
    const ci = cols.findIndex((c) => c.some(holds));
    if (ci < 0) return move(0);
    const row = cols[ci].findIndex(holds);
    for (let c = ci + delta; c >= 0 && c < cols.length; c += delta) {
      if (cols[c].length) return focusEl(cols[c][Math.min(row, cols[c].length - 1)]);
    }
  };

  const nav = { focusId, onFocus: setFocusId };
  return (
    <div class="manager">
      <header class="mgr-head">
        <div class="mgr-title">
          <h1>Agent Manager</h1>
          <div class="mgr-counts" aria-label="Tasks by status">
            <span class="count-item">
              <Dot state="needs-you" /> {tally.needsYou} need{tally.needsYou === 1 ? 's' : ''} you
            </span>
            <span class="count-item">
              <Dot state="working" /> {tally.working} working
            </span>
            <span class="count-item">
              <Dot state="done" /> {tally.done} done
            </span>
            {tally.archived > 0 && (
              <button
                class="link count-item"
                onClick={() => {
                  setHistoryOpen(true);
                  requestAnimationFrame(() => document.getElementById('history')?.scrollIntoView({ block: 'start', behavior: scrollBehavior() }));
                }}
              >
                <Icon name="history" /> {tally.archived} archived
              </button>
            )}
          </div>
        </div>
        <span class="spacer" />
        {waiting.length > 0 ? (
          <button class="pill loud" onClick={jump} title="Go to the next decision">
            <Dot state="needs-you" />
            {waiting.length} decision{waiting.length === 1 ? '' : 's'} waiting
          </button>
        ) : (
          <span class="pill quiet">
            <Icon name="check" /> Nothing waiting
          </span>
        )}
        <label class="search">
          <Icon name="search" />
          <input
            ref={search}
            type="search"
            value={query}
            placeholder="Search tasks, agents, branches"
            aria-label="Search tasks"
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          {!query && <Kbd>/</Kbd>}
        </label>
        <div class="seg views" role="tablist" aria-label="View">
          {VIEWS.map((v, i) => (
            <button
              key={v.id}
              role="tab"
              class="seg-item"
              aria-selected={view === v.id}
              aria-controls="view"
              tabIndex={view === v.id ? 0 : -1}
              title={`${v.title} (${i + 1})`}
              onClick={() => setView(v.id)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  const n = (i + (e.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length;
                  setView(VIEWS[n].id);
                  (e.currentTarget.parentElement?.children[n] as HTMLElement | undefined)?.focus();
                }
              }}
            >
              <Icon name={v.icon} /> {v.title}
            </button>
          ))}
        </div>
      </header>

      <NewTask />

      <div id="view" class="mgr-view" data-view={view} role="tabpanel" aria-label={VIEWS.find((v) => v.id === view)?.title}>
        {query && shown.length === 0 && <div class="empty-view">No task matches “{query}”.</div>}
        {!query && shown.length === 0 && (
          <div class="empty-view">
            <h2>{tally.archived ? 'No open tasks' : 'No tasks yet'}</h2>
            <p class="hint">Several agents on one task compare side by side.</p>
          </div>
        )}
        {view === 'board' && <Board state={state} chats={shown} now={now} {...nav} />}
        {view === 'list' && <List state={state} chats={shown} now={now} sort={sort} setSort={setSort} {...nav} />}
        {view === 'map' && <AgentMap state={shownState} now={now} {...nav} />}
      </div>

      <History chats={state.chats.filter((c) => c.archived)} now={now} open={historyOpen} setOpen={setHistoryOpen} />
    </div>
  );
}

function NewTask() {
  const [agents, setAgents] = usePersisted<AgentKey[]>('agents', ['claude']);
  const [worktree, setWorktree] = useState<boolean | null>(null);
  const [prompt, setPrompt] = useState('');
  const several = agents.length > 1;
  // On by default when several agents take the same task, so they can't clash.
  const own = worktree ?? several;
  const toggle = (a: AgentKey) => {
    const next = agents.includes(a) ? agents.filter((x) => x !== a) : AGENT_KEYS.filter((x) => x === a || agents.includes(x));
    if (next.length) setAgents(next);
  };
  const start = () => {
    const text = prompt.trim();
    if (!text) return;
    send(several ? { type: 'fanout', agents, prompt: text, worktree: own } : { type: 'createTask', agent: agents[0], prompt: text, worktree: own });
    setPrompt('');
    setWorktree(null);
  };
  return (
    <section class="new-task" aria-label="New task">
      <textarea
        value={prompt}
        rows={prompt.includes('\n') ? 3 : 1}
        placeholder={several ? `Describe a task for ${agents.length} agents to compare…` : 'Describe a task for an agent…'}
        aria-label="Task description"
        onInput={(e) => setPrompt(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            start();
          }
        }}
      />
      <div class="new-bar">
        <div class="agent-pick" role="group" aria-label="Agents">
          {AGENT_KEYS.map((a) => (
            <button key={a} type="button" class="agent-option" aria-pressed={agents.includes(a)} onClick={() => toggle(a)}>
              <Glyph agent={a} size="sm" /> {AGENT_FACES[a].name}
            </button>
          ))}
        </div>
        {several && <span class="hint">same task, {agents.length} agents</span>}
        <span class="spacer" />
        <label class="check" title="A separate git checkout on its own branch, so agents can't clash">
          <input type="checkbox" checked={own} onChange={(e) => setWorktree(e.currentTarget.checked)} /> Own worktree
        </label>
        <button class="primary" disabled={!prompt.trim()} onClick={start}>
          Start <Kbd>Ctrl ⏎</Kbd>
        </button>
      </div>
    </section>
  );
}

interface NavProps {
  focusId?: string;
  onFocus(id: string): void;
}

/** `chats` are the ones the search shows; `state` is everything, for links and shared files. */
function Board({ state, chats, now, focusId, onFocus }: { state: AppState; chats: ChatView[]; now: number } & NavProps) {
  if (!chats.length) return null;
  const groups = fanoutGroups(state).filter((g) => g.chats.some((c) => chats.includes(c)));
  const byColumn = (col: BoardColumn) => sortChats(chats, { key: 'activity', dir: 'asc' }).filter((c) => boardColumn(statusOf(c)) === col);
  const columns = COLUMNS.map((col) => ({ ...col, cards: byColumn(col.id) }));
  const first = chats.some((c) => c.id === focusId) ? focusId : columns.find((c) => c.cards.length)?.cards[0].id;
  return (
    <>
      {groups.map((g) => (
        <Compare key={g.id} group={g} now={now} />
      ))}
      <div class="columns">
        {columns.map((col) => (
          <section key={col.id} class="column" data-column={col.id} aria-label={COLUMN_TITLES[col.id]}>
            <h2 class="col-head">
              <Dot state={col.id} />
              {COLUMN_TITLES[col.id]}
              <span class="col-count">{col.cards.length}</span>
            </h2>
            {col.cards.length === 0 && <div class="column-empty">{col.empty}</div>}
            {col.cards.map((c) => (
              <Card key={c.id} chat={c} state={state} now={now} tabbable={c.id === first} onFocus={onFocus} />
            ))}
          </section>
        ))}
      </div>
    </>
  );
}

/** Inline answers to whatever the chat waits on, so most decisions take one click from the board. */
function Decide({ chat, line }: { chat: ChatView; line: CardLine }) {
  const d = line.decision;
  if (!d) return null;
  if (d.kind === 'review') {
    return (
      <div class="actions">
        <button class="decide sm" onClick={() => send({ type: 'review', reviewId: d.id, action: 'open' })}>
          Review edit
        </button>
        <button class="sm" onClick={() => send({ type: 'review', reviewId: d.id, action: 'accept' })}>
          <Icon name="check" /> Accept
        </button>
        <button class="ghost danger sm" onClick={() => send({ type: 'review', reviewId: d.id, action: 'reject' })}>
          Reject
        </button>
      </div>
    );
  }
  if (d.kind === 'command') {
    return (
      <div class="actions">
        <button class="decide sm" onClick={() => send({ type: 'command', commandId: d.id, approve: true })}>
          <Icon name="play" /> Run
        </button>
        <button class="ghost danger sm" onClick={() => send({ type: 'command', commandId: d.id, approve: false })}>
          Deny
        </button>
      </div>
    );
  }
  if (d.kind === 'bridge') {
    return (
      <div class="actions">
        <button class="decide sm" onClick={() => send({ type: 'bridge', requestId: d.id, answer: 'allow' })}>
          Allow
        </button>
        <button class="sm" onClick={() => send({ type: 'bridge', requestId: d.id, answer: 'allowChat' })}>
          Allow for this chat
        </button>
        <button class="ghost danger sm" onClick={() => send({ type: 'bridge', requestId: d.id, answer: 'deny' })}>
          Deny
        </button>
      </div>
    );
  }
  const item = chat.items.find((i) => i.kind === 'permission' && i.requestId === d.id);
  if (item?.kind !== 'permission') return null;
  const loud = item.options.find((o) => o.kind.startsWith('allow'));
  return (
    <div class="actions">
      {item.options.map((o) => (
        <button
          key={o.optionId}
          class={`sm ${o === loud ? 'decide' : o.kind.startsWith('reject') ? 'ghost danger' : ''}`}
          onClick={() => send({ type: 'permission', requestId: item.requestId, optionId: o.optionId })}
        >
          {o.name}
        </button>
      ))}
    </div>
  );
}

function Steps({ progress }: { progress: Progress }) {
  return (
    <div
      class="seg-bar"
      role="progressbar"
      aria-label="Plan"
      aria-valuemin={0}
      aria-valuemax={progress.steps.length}
      aria-valuenow={progress.done}
      aria-valuetext={`${progress.done} of ${progress.steps.length} steps done`}
    >
      {progress.steps.map((s, i) => (
        <i key={i} data-step={s} />
      ))}
    </div>
  );
}

const BADGE_ICON = { pipe: 'pipe', consult: 'ask', group: 'compare', handoff: 'handoff', origin: 'link' } as const;

function BadgeView({ badge }: { badge: Badge }) {
  const go = () => {
    if (badge.chatId) open(badge.chatId);
    else if (badge.group) document.getElementById(`group-${badge.group}`)?.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
  };
  return (
    <button class="badge" data-kind={badge.kind} onClick={go} title={badge.chatId ? 'Open that chat' : 'Compare them'}>
      <Icon name={BADGE_ICON[badge.kind]} />
      {badge.text}
    </button>
  );
}

function Card({ chat, state, now, tabbable, onFocus }: { chat: ChatView; state: AppState; now: number; tabbable: boolean; onFocus(id: string): void }) {
  const status = statusOf(chat);
  const line = cardLine(state, chat);
  const progress = status === 'working' || status === 'needs-you' ? planProgress(chat) : null;
  const badges = linkBadges(state, chat);
  const conflicts = conflictsOf(state, chat.id);
  const files = chat.files.length || chat.changedFiles;
  const canMerge = !!chat.branch && !chat.merged && !chat.busy;
  const archive = () => send({ type: 'archive', chatId: chat.id, archived: true });
  return (
    <article
      class="task-card"
      data-status={status}
      data-nav={chat.id}
      tabIndex={tabbable ? 0 : -1}
      aria-label={`${chat.label}: ${chat.title}. ${DOT_LABEL[status]}`}
      onFocus={(e) => e.target === e.currentTarget && onFocus(chat.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) open(chat.id);
      }}
    >
      <div class="card-top">
        <Glyph agent={chat.agent} />
        <span class="card-who">{chat.label}</span>
        <span class="sep">·</span>
        <span title="Started">{age(chat.createdAt, now)}</span>
        <span class="spacer" />
        {chat.merged && <span class="tag">merged</span>}
        {chat.branch && (
          <span class="chip" title={chat.cwd}>
            <Icon name="branch" />
            {chat.branch}
          </span>
        )}
      </div>
      <h3 class="card-title">
        <button class="title-btn" title={chat.title} onClick={() => open(chat.id)}>
          {chat.title}
        </button>
      </h3>
      <div class="card-state" data-decision={line.decision ? '' : undefined}>
        <Dot state={status} />
        <span class="card-state-text">{line.text}</span>
        {line.waiting > 1 && (
          <span class="tag loud" title={`${line.waiting} decisions waiting`}>
            +{line.waiting - 1}
          </span>
        )}
      </div>
      {line.code &&
        (line.bridge ? (
          <div class="card-quote">{line.code}</div>
        ) : (
          <code class="card-code">
            {line.decision?.kind === 'command' && <span class="prompt">$ </span>}
            {line.code}
          </code>
        ))}
      <Decide chat={chat} line={line} />
      {progress && <Steps progress={progress} />}
      {(files > 0 || chat.turns > 0 || badges.length > 0 || conflicts.length > 0) && (
        <div class="card-meta">
          {files > 0 && (
            <span class="meta-item">
              <Icon name="file" /> {files} file{files === 1 ? '' : 's'}
            </span>
          )}
          {chat.turns > 0 && (
            <span class="meta-item">
              {chat.turns} turn{chat.turns === 1 ? '' : 's'}
            </span>
          )}
          {conflicts.slice(0, 2).map((c) => (
            <span key={c.file} class="badge conflict" title={`Changed here and in ${c.others.map((o) => o.label).join(', ')}: they clash when merged`}>
              <Icon name="diff" />
              {conflictText(c)}
            </span>
          ))}
          {conflicts.length > 2 && <span class="badge conflict">+{conflicts.length - 2} more shared</span>}
          {badges.map((b) => (
            <BadgeView key={b.text} badge={b} />
          ))}
        </div>
      )}
      <div class="card-actions">
        {chat.busy && (
          <button class="ghost danger sm" onClick={() => send({ type: 'stop', chatId: chat.id })}>
            <Icon name="stop" /> Stop
          </button>
        )}
        {canMerge && !line.decision && (
          <button class="sm" onClick={() => send({ type: 'merge', chatId: chat.id })}>
            <Icon name="merge" /> Merge
          </button>
        )}
        <HandoffMenu chat={chat} />
        <AskMenu chat={chat} />
        <PipeMenu chat={chat} state={state} />
        <span class="spacer" />
        {(files > 0 || chat.branch) && (
          <button class="ghost icon-btn sm" title="Changes" aria-label="Changes" onClick={() => send({ type: 'viewChanges', chatId: chat.id })}>
            <Icon name="diff" />
          </button>
        )}
        <button class="ghost icon-btn sm" title="Open chat" aria-label="Open chat" onClick={() => open(chat.id)}>
          <Icon name="open" />
        </button>
        <Popover label={`More for ${chat.label}`} title="More" align="end" buttonClass="ghost icon-btn sm" trigger={<Icon name="more" />}>
          {(close) => (
            <>
              <button
                role="menuitem"
                onClick={() => {
                  close();
                  send({ type: 'viewChanges', chatId: chat.id });
                }}
              >
                <Icon name="diff" /> Changes
              </button>
              {canMerge && (
                <button
                  role="menuitem"
                  onClick={() => {
                    close();
                    send({ type: 'merge', chatId: chat.id });
                  }}
                >
                  <Icon name="merge" /> Merge into main
                </button>
              )}
              {chat.branch && !chat.busy && (
                <button
                  role="menuitem"
                  class="danger"
                  onClick={() => {
                    close();
                    send({ type: 'removeWorktree', chatId: chat.id });
                  }}
                >
                  <Icon name="trash" /> Delete worktree
                </button>
              )}
              <button
                role="menuitem"
                onClick={() => {
                  close(false);
                  archive();
                }}
              >
                <Icon name="archive" /> Archive
              </button>
            </>
          )}
        </Popover>
      </div>
    </article>
  );
}

/** One column per chat of a fan-out: how far each got, what it said, and keep the best. */
function Compare({ group, now }: { group: FanoutGroup; now: number }) {
  const [collapsed, setCollapsed] = usePersisted<boolean>(`compare:${group.id}`, false);
  const keep = (id: string) => {
    const plan = keepPlan(group, id);
    if (plan.merge) send({ type: 'merge', chatId: plan.merge });
    for (const other of plan.archive) send({ type: 'archive', chatId: other, archived: true });
  };
  return (
    <section class="compare" id={`group-${group.id}`} aria-label={`Compare: ${group.title}`}>
      <header class="compare-head">
        <Icon name="compare" />
        <h2>Compare</h2>
        <span class="compare-title" title={group.title}>
          {group.title}
        </span>
        <span class="hint">{group.chats.length} agents, same task</span>
        <span class="spacer" />
        <button class="ghost sm" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </header>
      {!collapsed && (
        <div class="compare-grid" style={{ gridTemplateColumns: `repeat(${group.chats.length}, minmax(0, 1fr))` }}>
          {group.chats.map((c) => {
            const status = statusOf(c);
            const reply = excerpt(lastReply(c), 220);
            return (
              <article key={c.id} class="compare-col" data-status={status}>
                <div class="compare-top">
                  <Glyph agent={c.agent} />
                  <button class="title-btn" onClick={() => open(c.id)}>
                    {c.label}
                  </button>
                  <Dot state={status} />
                  <span class="hint">{DOT_LABEL[status]}</span>
                  <span class="spacer" />
                  <span class="compare-stats">
                    {c.turns} turn{c.turns === 1 ? '' : 's'} · {c.files.length} file{c.files.length === 1 ? '' : 's'} · {ago(c.lastActivity, now)}
                  </span>
                </div>
                <p class="compare-reply">{reply || <span class="hint">No reply yet.</span>}</p>
                <div class="actions">
                  <button class="ghost sm" onClick={() => send({ type: 'viewChanges', chatId: c.id })}>
                    <Icon name="diff" /> Changes
                  </button>
                  <span class="spacer" />
                  <button class="sm" disabled={c.busy} title={c.busy ? 'Still working' : c.branch ? 'Merge this one, archive the others' : 'Archive the others'} onClick={() => keep(c.id)}>
                    <Icon name="keep" /> Keep this one
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

const SORT_COLUMNS: { key: SortKey; title: string }[] = [
  { key: 'status', title: 'Status' },
  { key: 'agent', title: 'Agent' },
  { key: 'task', title: 'Task' },
  { key: 'activity', title: 'Activity' },
  { key: 'files', title: 'Files' },
  { key: 'age', title: 'Age' },
];

/** Every chat as a dense, sortable row: for fifteen agents and more. */
function List({ state, chats, now, sort, setSort, focusId, onFocus }: { state: AppState; chats: ChatView[]; now: number; sort: Sort; setSort(s: Sort): void } & NavProps) {
  const rows = sortChats(chats, sort);
  const roving = rows.some((c) => c.id === focusId) ? focusId : rows[0]?.id;
  if (!rows.length) return null;
  return (
    <div class="table-wrap">
      <table class="chat-table">
        <thead>
          <tr>
            {SORT_COLUMNS.map((col) => {
              const on = sort.key === col.key;
              return (
                <th key={col.key} class={`c-${col.key}`} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined} scope="col">
                  <button class="th-btn" onClick={() => setSort(on ? { key: col.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key: col.key, dir: defaultDir(col.key) })}>
                    {col.title}
                    <span class="sort-mark" data-on={on ? sort.dir : undefined} aria-hidden="true">
                      <Icon name="chevron" />
                    </span>
                  </button>
                </th>
              );
            })}
            <th class="c-act" scope="col">
              <span class="sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const status = statusOf(c);
            const line = cardLine(state, c);
            const conflicts = conflictsOf(state, c.id);
            const badges = linkBadges(state, c);
            return (
              <tr
                key={c.id}
                data-status={status}
                data-nav={c.id}
                tabIndex={c.id === roving ? 0 : -1}
                aria-label={`${c.label}: ${c.title}. ${DOT_LABEL[status]}`}
                onFocus={(e) => e.target === e.currentTarget && onFocus(c.id)}
                onClick={(e) => !(e.target as HTMLElement).closest('button') && open(c.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.target === e.currentTarget) open(c.id);
                }}
              >
                <td class="c-status">
                  <span class="cell-status">
                    <Dot state={status} /> {DOT_LABEL[status]}
                  </span>
                </td>
                <td class="c-agent">
                  <span class="cell-agent">
                    <Glyph agent={c.agent} size="sm" /> {c.label}
                  </span>
                </td>
                <td class="c-task">
                  <div class="cell-title">
                    <span class="cell-title-text" title={c.title}>
                      {c.title}
                    </span>
                    {c.branch && (
                      <span class="chip">
                        <Icon name="branch" />
                        {c.branch}
                      </span>
                    )}
                  </div>
                  <div class="cell-line" data-decision={line.decision ? '' : undefined}>
                    <span class="cell-line-text">{line.code ? `${line.text}: ${line.code}` : line.text}</span>
                    {badges.map((b) => (
                      <span key={b.text} class="mini-badge" data-kind={b.kind}>
                        {b.text}
                      </span>
                    ))}
                  </div>
                </td>
                <td class="c-activity num">{ago(c.lastActivity, now)}</td>
                <td class="c-files num">
                  {c.files.length || '–'}
                  {conflicts.length > 0 && (
                    <span class="conflict-mark" title={conflicts.map(conflictText).join('\n')} aria-label={`${conflicts.length} shared with other chats`}>
                      <Icon name="diff" />
                    </span>
                  )}
                </td>
                <td class="c-age num">{age(c.createdAt, now)}</td>
                <td class="c-act">
                  <RowDecision chat={c} line={line} />
                  <button class="ghost icon-btn sm" title="Open chat" aria-label={`Open ${c.label}`} onClick={() => open(c.id)}>
                    <Icon name="open" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The loud answer only; the rest is in the chat. */
function RowDecision({ chat, line }: { chat: ChatView; line: CardLine }) {
  const d = line.decision;
  if (!d) {
    return chat.busy ? (
      <button class="ghost danger sm" onClick={() => send({ type: 'stop', chatId: chat.id })}>
        <Icon name="stop" /> Stop
      </button>
    ) : null;
  }
  if (d.kind === 'review') {
    return (
      <button class="decide sm" onClick={() => send({ type: 'review', reviewId: d.id, action: 'open' })}>
        Review
      </button>
    );
  }
  if (d.kind === 'command') {
    return (
      <button class="decide sm" onClick={() => send({ type: 'command', commandId: d.id, approve: true })}>
        <Icon name="play" /> Run
      </button>
    );
  }
  if (d.kind === 'bridge') {
    return (
      <button class="decide sm" onClick={() => send({ type: 'bridge', requestId: d.id, answer: 'allow' })}>
        Allow
      </button>
    );
  }
  return (
    <button class="decide sm" onClick={() => open(chat.id)}>
      Answer
    </button>
  );
}

/** Archived chats: kept for their history, out of the way. */
function History({ chats, now, open: isOpen, setOpen }: { chats: ChatView[]; now: number; open: boolean; setOpen(v: boolean): void }) {
  if (!chats.length) return null;
  const sorted = sortChats(chats, { key: 'activity', dir: 'asc' });
  return (
    <section class="history" id="history" aria-label="History">
      <button class="history-toggle" aria-expanded={isOpen} aria-controls="history-list" onClick={() => setOpen(!isOpen)}>
        <span class="chev" data-open={isOpen ? '' : undefined}>
          <Icon name="chevron" />
        </span>
        History
        <span class="col-count">{chats.length} archived</span>
      </button>
      {isOpen && (
        <ul class="history-list" id="history-list">
          {sorted.map((c) => (
            <li key={c.id} class="history-row">
              <Glyph agent={c.agent} size="sm" />
              <span class="history-label">{c.label}</span>
              <button class="title-btn history-title" title={c.title} onClick={() => open(c.id)}>
                {c.title}
              </button>
              <span class="hint num">{age(c.createdAt, now)}</span>
              <button class="ghost sm" onClick={() => send({ type: 'archive', chatId: c.id, archived: false })}>
                <Icon name="unarchive" /> Unarchive
              </button>
              <button class="ghost danger sm" onClick={() => send({ type: 'removeChat', chatId: c.id })}>
                <Icon name="trash" /> Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

render(<Manager />, document.getElementById('root')!);
