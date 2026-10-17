import { Fragment, render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  AGENT_FACES,
  AGENT_KEYS,
  age,
  decisions,
  fileConflicts,
  lastReply,
  type AgentKey,
  type AppState,
  type ChatView,
  type ChatStatus,
} from '../shared/model';
import {
  STATUS_TITLES,
  agentName,
  ago,
  cardModel,
  claudeColumn,
  claudeSubagents,
  conflictText,
  counts,
  defaultDir,
  excerpt,
  fanoutGroups,
  filterChats,
  filterClaudeSessions,
  keepPlan,
  matchesQuery,
  nextDecision,
  openChats,
  subagents,
  sortChats,
  statusOf,
  type Badge,
  type CardLine,
  type CardModel,
  type FanoutGroup,
  type Progress,
  type Sort,
  type SortKey,
  type Subagent,
} from '../shared/view';
import type { ClaudeSession, TaskChoices } from '../shared/messages';
import { APPROVAL_HINTS, APPROVAL_LEVELS, APPROVAL_NAMES, reportedMode, type AgentDefaults, type ApprovalLevel } from '../shared/session';
import { DOT_LABEL, Dot, Glyph, Icon, Kbd, LiveState, Popover, isTyping, memo, radioKeys, scrollBehavior, send, useHost, useNow, usePersisted, useSettledOrder } from './common';
import { AskMenu, HandoffMenu, PipeMenu } from './connect';
import { AutoBadge, ModeBadge, PermissionOptions, TaskOptions } from './controls';
import { AgentMap } from './map';

type View = 'board' | 'list' | 'map';
const VIEWS: { id: View; title: string; icon: 'tasks' | 'list' | 'map' }[] = [
  { id: 'board', title: 'Board', icon: 'tasks' },
  { id: 'list', title: 'List', icon: 'list' },
  { id: 'map', title: 'Map', icon: 'map' },
];

/** Problem and Idle show only when a chat is in them. */
const COLUMNS: { id: ChatStatus; empty?: string }[] = [
  { id: 'needs-you', empty: 'Nothing waits for you.' },
  { id: 'working', empty: 'No agent is working.' },
  { id: 'error' },
  { id: 'idle' },
  { id: 'done', empty: 'Finished tasks land here.' },
];

const open = (chatId: string) => send({ type: 'openChat', chatId });
/** Opens the chat that launched a subagent, scrolled to its tool call. */
const openSub = (chatId: string, item: string) => send({ type: 'openChat', chatId, item });
const SUB_DOT = { working: 'working', done: 'done', failed: 'error' } as const;
const SUB_LABEL = { working: 'Working', done: 'Done', failed: 'Failed' } as const;
const toolCount = (n: number) => (n ? `${n} tool${n === 1 ? '' : 's'}` : '');

/** A chat's subagents, as small cards under its own: not chats, so no composer and nothing to save. */
function Subagents({ chat }: { chat: ChatView }) {
  return <SubCards label={`Subagents of ${chat.label}`} subs={subagents(chat)} onOpen={(id) => openSub(chat.id, id)} />;
}

/** `onOpen` (optional): a FriedLiver chat's subagent opens its card in the chat; an outside session's has nowhere to go but resuming that session, so it is just shown. */
function SubCards({ label, subs, onOpen }: { label: string; subs: Subagent[]; onOpen?(id: string): void }) {
  if (!subs.length) return null;
  return (
    <ul class="sub-cards" aria-label={label}>
      {subs.map((s) => (
        <li key={s.id}>
          {onOpen ? (
            <button class="sub-card" data-status={SUB_DOT[s.state]} title={s.title} onClick={() => onOpen(s.id)}>
              <SubCardBody s={s} />
            </button>
          ) : (
            <div class="sub-card static" data-status={SUB_DOT[s.state]} title={s.title}>
              <SubCardBody s={s} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function SubCardBody({ s }: { s: Subagent }) {
  return (
    <>
      <Dot state={SUB_DOT[s.state]} />
      <span class="sub-title">{s.title}</span>
      <span class="hint">{[SUB_LABEL[s.state], toolCount(s.tools)].filter(Boolean).join(' · ')}</span>
    </>
  );
}

const openClaude = (sessionId: string) => send({ type: 'openClaudeSession', sessionId });
const OUTSIDE_TIP = 'Started outside FriedLiver (the claude CLI or the Claude Code extension). FriedLiver only reads it until you open it here.';
const openTip = (col: 'working' | 'done') =>
  col === 'working' ? 'Continue it in a FriedLiver chat. It is still running elsewhere: stop it there first, or the two will interleave.' : 'Continue it in a FriedLiver chat';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A Claude Code session from outside FriedLiver: read-only, with its subagents under it. */
function ClaudeCard({ session: s, now }: { session: ClaudeSession; now: number }) {
  const col = claudeColumn(s, now);
  return (
    <>
      <article class="task-card cc-card" data-status={col} aria-label={`Claude Code session: ${s.title}. ${DOT_LABEL[col]}`}>
        <div class="card-top">
          <Glyph agent="claude" />
          <span class="tag" title={OUTSIDE_TIP}>
            Claude Code
          </span>
          <span class="sep">·</span>
          <span title="Last activity">{ago(s.lastActivity, now)}</span>
        </div>
        <h3 class="card-title">
          <button class="title-btn" title={s.title} onClick={() => openClaude(s.id)}>
            {s.title}
          </button>
        </h3>
        <div class="card-state">
          <Dot state={col} />
          <span class="card-state-text">{col === 'working' ? 'Working outside FriedLiver' : 'Started outside FriedLiver'}</span>
        </div>
        <div class="card-meta">
          <span class="meta-item">{plural(s.messages, 'message')}</span>
        </div>
        <div class="card-actions">
          <span class="spacer" />
          <button class="sm" title={openTip(col)} onClick={() => openClaude(s.id)}>
            <Icon name="open" /> Open in FriedLiver
          </button>
        </div>
      </article>
      <SubCards label={`Subagents of ${s.title}`} subs={claudeSubagents(s, now)} />
    </>
  );
}

/** The same sessions as a row and its subagents' rows, for the List. */
function ClaudeRows({ session: s, now }: { session: ClaudeSession; now: number }) {
  const col = claudeColumn(s, now);
  return (
    <>
      <tr data-status={col} class="cc-row" onClick={(e) => !(e.target as HTMLElement).closest('button') && openClaude(s.id)}>
        <td class="c-status">
          <span class="cell-status">
            <Dot state={col} /> {DOT_LABEL[col]}
          </span>
        </td>
        <td class="c-agent">
          <span class="tag" title={OUTSIDE_TIP}>
            Claude Code
          </span>
        </td>
        <td class="c-task">
          <div class="cell-title">
            <span class="cell-title-text" title={s.title}>
              {s.title}
            </span>
          </div>
        </td>
        <td class="c-activity num">{ago(s.lastActivity, now)}</td>
        <td class="c-files num">{plural(s.messages, 'message')}</td>
        <td class="c-age num" />
        <td class="c-act">
          <button class="ghost icon-btn sm" title={openTip(col)} aria-label={`Open ${s.title} in FriedLiver`} onClick={() => openClaude(s.id)}>
            <Icon name="open" />
          </button>
        </td>
      </tr>
      {claudeSubagents(s, now).map((sub) => (
        <tr key={sub.id} class="sub-row static" data-status={SUB_DOT[sub.state]}>
          <td class="c-status">
            <span class="cell-status">
              <Dot state={SUB_DOT[sub.state]} /> {SUB_LABEL[sub.state]}
            </span>
          </td>
          <td class="c-agent">
            <span class="hint">subagent</span>
          </td>
          <td class="c-task">
            <div class="cell-title">
              <span class="cell-title-text" title={sub.title}>
                ↳ {sub.title}
              </span>
            </div>
          </td>
          <td class="c-activity num" />
          <td class="c-files num" />
          <td class="c-age num" />
          <td class="c-act" />
        </tr>
      ))}
    </>
  );
}

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
  const [defaults, setDefaults] = useState<Partial<Record<AgentKey, AgentDefaults>>>({});
  const [claude, setClaude] = useState<ClaudeSession[]>([]);
  const { state } = useHost((m) => {
    if (m.type === 'snapshot' && m.defaults) setDefaults(m.defaults);
    if (m.type === 'defaults') setDefaults(m.defaults);
    if (m.type === 'claudeSessions') setClaude(m.sessions);
  });
  const now = useNow(15_000);
  const [view, setView] = usePersisted<View>('view', 'board');
  const [sort, setSort] = usePersisted<Sort>('sort', { key: 'status', dir: 'asc' });
  const [query, setQuery] = useState('');
  const [focusId, setFocusId] = useState<string>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const lastJump = useRef<string | undefined>(undefined);

  const shown = useMemo(() => filterChats(openChats(state.chats), query), [state, query]);
  const outside = useMemo(() => filterClaudeSessions(claude.filter((s) => !s.archived), query), [claude, query]);
  const oldOutside = useMemo(() => claude.filter((s) => s.archived), [claude]);
  const shownState = useMemo<AppState>(() => ({ ...state, chats: state.chats.filter((c) => c.archived || shown.includes(c)) }), [state, shown]);
  const waiting = useMemo(() => decisions({ chats: openChats(state.chats) }), [state]);
  const tally = { ...counts(state) };
  tally.archived += oldOutside.length;

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
    <LiveState.Provider value={state}>
      <div class="manager">
        <header class="mgr-head">
          <div class="mgr-title">
            <h1>Agent Manager</h1>
            <div class="mgr-counts" aria-label="Tasks by status">
              <span class="count-item">
                <Dot state="needs-you" /> {tally.needsYou} need{tally.needsYou === 1 ? 's' : ''} you
              </span>
              <span class="count-item">
                <Dot state="working" still={tally.working === 0} /> {tally.working} working
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

        <NewTask defaults={defaults} />

        <div id="view" class="mgr-view" data-view={view} role="tabpanel" aria-label={VIEWS.find((v) => v.id === view)?.title}>
          {query && shown.length === 0 && outside.length === 0 && <div class="empty-view">No task matches “{query}”.</div>}
          {!query && shown.length === 0 && outside.length === 0 && (
            <div class="empty-view">
              <h2>{tally.archived ? 'No open tasks' : 'No tasks yet'}</h2>
              <p class="hint">Several agents on one task compare side by side.</p>
            </div>
          )}
          {view === 'board' && <Board state={state} chats={shown} outside={outside} now={now} {...nav} />}
          {view === 'list' && <List state={state} chats={shown} outside={outside} now={now} sort={sort} setSort={setSort} {...nav} />}
          {view === 'map' && <AgentMap state={shownState} outside={outside} now={now} {...nav} />}
        </div>

        <History chats={state.chats.filter((c) => c.archived)} outside={oldOutside} now={now} open={historyOpen} setOpen={setHistoryOpen} />
      </div>
    </LiveState.Provider>
  );
}

function NewTask({ defaults }: { defaults: Partial<Record<AgentKey, AgentDefaults>> }) {
  const [agents, setAgents] = usePersisted<AgentKey[]>('agents', ['claude']);
  const [worktree, setWorktree] = useState<boolean | null>(null);
  const [prompt, setPrompt] = useState('');
  // Model and effort per agent, and how much the task may do without asking; Full auto is confirmed by the editor.
  const [choices, setChoices] = useState<TaskChoices>({});
  const [approval, setApproval] = useState<ApprovalLevel>('ask');
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
    const picked = Object.fromEntries(Object.entries(choices).filter(([a]) => agents.includes(a as AgentKey))) as TaskChoices;
    const extras = { ...(Object.keys(picked).length ? { choices: picked } : {}), ...(approval !== 'ask' ? { approval } : {}) };
    send(several ? { type: 'fanout', agents, prompt: text, worktree: own, ...extras } : { type: 'createTask', agent: agents[0], prompt: text, worktree: own, ...extras });
    setPrompt('');
    setWorktree(null);
    setApproval('ask');
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
          // Enter starts it, as in a chat; Shift+Enter adds a line.
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
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
        <TaskOptions agents={agents} defaults={defaults} choices={choices} onChange={(agent, key, value) => setChoices((c) => ({ ...c, [agent]: { ...c[agent], [key]: value } }))} />
        <span class="spacer" />
        <div class="seg approval-seg" role="radiogroup" aria-label="Without asking" onKeyDown={radioKeys}>
          {APPROVAL_LEVELS.map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              class="seg-item"
              data-level={l}
              aria-checked={approval === l}
              tabIndex={approval === l ? 0 : -1}
              title={`${APPROVAL_NAMES[l]}: ${APPROVAL_HINTS[l]}${l === 'full' ? '. Asks once to confirm.' : ''}`}
              onClick={() => setApproval(l)}
            >
              {l === 'full' && <Icon name="bolt" />}
              {l === 'ask' ? 'Ask' : l === 'edits' ? 'Edits' : 'Full auto'}
            </button>
          ))}
        </div>
        <label class="check" title="A separate git checkout on its own branch, so agents can't clash">
          <input type="checkbox" checked={own} onChange={(e) => setWorktree(e.currentTarget.checked)} /> Own worktree
        </label>
        <button class="primary" disabled={!prompt.trim()} onClick={start}>
          Start <Kbd>⏎</Kbd>
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
function Board({ state, chats, outside, now, focusId, onFocus }: { state: AppState; chats: ChatView[]; outside: ClaudeSession[]; now: number } & NavProps) {
  const sorted = useSettledOrder(sortChats(chats, { key: 'activity', dir: 'asc' }), 'activity');
  if (!chats.length && !outside.length) return null;
  const groups = fanoutGroups(state).filter((g) => g.chats.some((c) => chats.includes(c)));
  const conflicts = fileConflicts(state);
  const models = new Map(chats.map((c) => [c.id, cardModel(state, c, now, conflicts)]));
  const columns = COLUMNS.map((col) => ({
    ...col,
    cards: sorted.filter((c) => models.get(c.id)!.status === col.id),
    outside: outside.filter((s) => claudeColumn(s, now) === col.id),
  })).filter((col) => col.empty || col.cards.length > 0);
  const first = chats.some((c) => c.id === focusId) ? focusId : columns.find((c) => c.cards.length)?.cards[0].id;
  return (
    <>
      {groups.map((g) => (
        <Compare key={g.id} group={g} now={now} />
      ))}
      <div class="columns" style={{ '--cols': columns.length }}>
        {columns.map((col) => (
          <section key={col.id} class="column" data-column={col.id} aria-label={STATUS_TITLES[col.id]}>
            <h2 class="col-head">
              <Dot state={col.id} still={col.cards.length === 0} />
              {STATUS_TITLES[col.id]}
              <span class="col-count">{col.cards.length + col.outside.length}</span>
            </h2>
            {col.cards.length + col.outside.length === 0 && <div class="column-empty">{col.empty}</div>}
            {col.cards.map((c) => (
              <Fragment key={c.id}>
                <Card chat={c} model={models.get(c.id)!} tabbable={c.id === first} onFocus={onFocus} />
                <Subagents chat={c} />
              </Fragment>
            ))}
            {col.outside.map((s) => (
              <ClaudeCard key={s.id} session={s} now={now} />
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
  if (d.kind === 'question') {
    return (
      <div class="actions">
        <button class="decide sm" onClick={() => open(chat.id)}>
          Answer
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
  // A diff or a plan needs reading: the chat shows it in full.
  const read = !!item.detail?.plan || (item.detail?.files?.length ?? 0) > 0;
  return (
    <div class="actions">
      {read && (
        <button class="sm" onClick={() => open(chat.id)}>
          {item.detail?.plan ? 'Read the plan' : 'See the diff'}
        </button>
      )}
      <PermissionOptions item={item} compact />
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
    <button class="badge" data-kind={badge.kind} onClick={go} title={`${badge.text}: ${badge.chatId ? 'open that chat' : 'compare them'}`}>
      <Icon name={BADGE_ICON[badge.kind]} />
      <span class="badge-text">{badge.text}</span>
    </button>
  );
}

interface CardProps {
  chat: ChatView;
  model: CardModel;
  tabbable: boolean;
  onFocus(id: string): void;
}

/** A card draws again only when what it shows changed, not on every chunk its agent streams. */
const Card = memo(CardView, (a: CardProps, b: CardProps) => a.model.key === b.model.key && a.tabbable === b.tabbable && a.onFocus === b.onFocus);

function CardView({ chat, model, tabbable, onFocus }: CardProps) {
  const { status, line, progress, badges, conflicts } = model;
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
        <span class="card-who" title={chat.label}>
          {agentName(chat.agent)}
        </span>
        <span class="sep">·</span>
        <span title="Started">{model.age}</span>
        <span class="spacer" />
        <AutoBadge chat={chat} short />
        {(reportedMode(chat.session)?.tone === 'full' || reportedMode(chat.session)?.tone === 'auto') && chat.approval !== 'full' && <ModeBadge session={chat.session} agent={chat.agent} />}
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
            <span key={c.file} class="badge conflict" title={`${conflictText(c)}\nChanged here and in ${c.others.map((o) => `${o.title} (${o.label})`).join(', ')}: they clash when merged`}>
              <Icon name="diff" />
              <span class="badge-text">{conflictText(c)}</span>
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
        <PipeMenu chat={chat} />
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
              <button
                role="menuitem"
                onClick={() => {
                  close();
                  send({ type: 'renameChat', chatId: chat.id });
                }}
              >
                <Icon name="rename" /> Rename chat
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
function List({
  state,
  chats,
  outside,
  now,
  sort,
  setSort,
  focusId,
  onFocus,
}: { state: AppState; chats: ChatView[]; outside: ClaudeSession[]; now: number; sort: Sort; setSort(s: Sort): void } & NavProps) {
  const rows = useSettledOrder(sortChats(chats, sort), `${sort.key}:${sort.dir}`);
  // Sorted by status, the rows fall into the same groups as the board, each under its header.
  const grouped = sort.key === 'status';
  const roving = rows.some((c) => c.id === focusId) ? focusId : rows[0]?.id;
  if (!rows.length && !outside.length) return null;
  const conflicts = fileConflicts(state);
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
          {rows.map((c, n) => (
            <Fragment key={c.id}>
              {grouped && (n === 0 || statusOf(rows[n - 1]) !== statusOf(c)) && (
                <tr class="group-row">
                  <th colSpan={SORT_COLUMNS.length + 1} scope="rowgroup">
                    <Dot state={statusOf(c)} still />
                    {STATUS_TITLES[statusOf(c)]}
                    <span class="col-count">{rows.filter((r) => statusOf(r) === statusOf(c)).length}</span>
                  </th>
                </tr>
              )}
              <Row chat={c} model={cardModel(state, c, now, conflicts)} activity={ago(c.lastActivity, now)} tabbable={c.id === roving} onFocus={onFocus} />
              {subagents(c).map((sub) => (
                <tr key={sub.id} class="sub-row" data-status={SUB_DOT[sub.state]} onClick={(e) => !(e.target as HTMLElement).closest('button') && openSub(c.id, sub.id)}>
                  <td class="c-status">
                    <span class="cell-status">
                      <Dot state={SUB_DOT[sub.state]} /> {SUB_LABEL[sub.state]}
                    </span>
                  </td>
                  <td class="c-agent">
                    <span class="hint">subagent</span>
                  </td>
                  <td class="c-task">
                    <div class="cell-title">
                      <span class="cell-title-text" title={sub.title}>
                        ↳ {sub.title}
                      </span>
                    </div>
                  </td>
                  <td class="c-activity num" />
                  <td class="c-files num">{toolCount(sub.tools)}</td>
                  <td class="c-age num" />
                  <td class="c-act">
                    <button class="ghost icon-btn sm" title="Show in chat" aria-label={`Show ${sub.title} in ${c.label}`} onClick={() => openSub(c.id, sub.id)}>
                      <Icon name="open" />
                    </button>
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
          {outside.map((s) => (
            <ClaudeRows key={s.id} session={s} now={now} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface RowProps extends CardProps {
  /** "3s ago". */
  activity: string;
}

/** Like the cards: a row draws again only when what it shows changed. */
const Row = memo(RowView, (a: RowProps, b: RowProps) => a.model.key === b.model.key && a.activity === b.activity && a.tabbable === b.tabbable && a.onFocus === b.onFocus);

function RowView({ chat: c, model, activity, tabbable, onFocus }: RowProps) {
  const { status, line, conflicts, badges } = model;
  return (
    <tr
      data-status={status}
      data-nav={c.id}
      tabIndex={tabbable ? 0 : -1}
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
          <Glyph agent={c.agent} size="sm" /> <span title={c.label}>{agentName(c.agent)}</span>
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
      <td class="c-activity num">{activity}</td>
      <td class="c-files num">
        {c.files.length || '–'}
        {conflicts.length > 0 && (
          <span class="conflict-mark" title={conflicts.map(conflictText).join('\n')} aria-label={`${conflicts.length} shared with other chats`}>
            <Icon name="diff" />
          </span>
        )}
      </td>
      <td class="c-age num">{model.age}</td>
      <td class="c-act">
        <RowDecision chat={c} line={line} />
        <button class="ghost icon-btn sm" title="Open chat" aria-label={`Open ${c.label}`} onClick={() => open(c.id)}>
          <Icon name="open" />
        </button>
      </td>
    </tr>
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
function History({ chats, outside, now, open: isOpen, setOpen }: { chats: ChatView[]; outside: ClaudeSession[]; now: number; open: boolean; setOpen(v: boolean): void }) {
  if (!chats.length && !outside.length) return null;
  const sorted = sortChats(chats, { key: 'activity', dir: 'asc' });
  return (
    <section class="history" id="history" aria-label="History">
      <button class="history-toggle" aria-expanded={isOpen} aria-controls="history-list" onClick={() => setOpen(!isOpen)}>
        <span class="chev" data-open={isOpen ? '' : undefined}>
          <Icon name="chevron" />
        </span>
        History
        <span class="col-count">{chats.length + outside.length} archived</span>
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
          {outside.map((s) => (
            <li key={s.id} class="history-row">
              <Glyph agent="claude" size="sm" />
              <span class="tag history-label" title={OUTSIDE_TIP}>
                Claude Code
              </span>
              <button class="title-btn history-title" title={s.title} onClick={() => openClaude(s.id)}>
                {s.title}
              </button>
              <span class="hint num">{ago(s.lastActivity, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

render(<Manager />, document.getElementById('root')!);
