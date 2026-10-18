// The agent map: every open chat as a node in its agent's lane, and every
// connection between chats (hand-offs, consultations, pipes, fan-outs, files
// two chats both changed) as an edge, so you can see how the agents are joined.
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { AGENT_FACES, basename, decisions, type AppState, type ChatView } from '../shared/model';
import type { ClaudeSession } from '../shared/messages';
import { MAP, ago, cardLine, claudeSubagents, linkBadges, mapKey, mapLayout, shortDuration, statusOf, subagentAnswer, turnsText, subagents, tipPlace, type MapEdge, type MapLayout, type MapNode, type MapSub, type ToolItem } from '../shared/view';
import { DOT_LABEL, Dot, Glyph, Icon, memo, send } from './common';
import { chatName, chatTip } from '../shared/names';
import { Button, IconButton } from './ui';

const TIP_W = 288;

export function AgentMap({ state, outside = [], now, focusId, onFocus }: { state: AppState; outside?: ClaudeSession[]; now: number; focusId?: string; onFocus(id: string): void }) {
  // Laid out again only when something the map shows changed, not for every streamed chunk.
  const key = mapKey(state, outside, now);
  // Chats whose done subagents are shown one by one; folded into one node by default.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggleDone = useCallback((parent: string) => setExpanded((e) => (e.has(parent) ? new Set([...e].filter((x) => x !== parent)) : new Set([...e, parent]))), []);
  const map = useMemo(() => mapLayout(state, outside, now, expanded), [key, expanded]);
  const [tip, setTip] = useState<string | null>(null);
  // A subagent you clicked: highlighted with its chat, its details beside the map. Never a jump to some chat.
  const [sel, setSel] = useState<string | null>(null);
  // The node that opened the detail panel, for focus to go back to when it closes.
  const opener = useRef<Element | null>(null);
  const pickSub = useCallback((id: string | null, from?: Element) => {
    if (id && from) opener.current = from;
    setSel(id);
  }, []);
  const closeSub = useCallback(() => {
    setSel(null);
    const back = opener.current;
    requestAnimationFrame(() => (back as HTMLElement | SVGElement | null)?.isConnected && (back as HTMLElement).focus({ preventScroll: true }));
  }, []);
  const waiting = decisions({ chats: state.chats.filter((c) => !c.archived) }).length;
  if (!map.nodes.length && !map.outside.length) return null;
  const selSub = map.subs.find((n) => n.id === sel);
  const tipNode = map.nodes.find((n) => n.chat.id === tip);
  // The layout may be older than this update: the tooltip reads the chat as it is now.
  const tipChat = tipNode && state.chats.find((c) => c.id === tipNode.chat.id);
  const roving = map.nodes.some((n) => n.chat.id === focusId) ? focusId! : (map.nodes[0]?.chat.id ?? '');

  return (
    <div class="map-wrap">
      <Legend still={!map.edges.some((e) => e.flowing)} working={map.nodes.some((n) => n.status === 'working')} />
      <div class="map-body">
      <div class="map-scroll">
        <div class="map-canvas" style={{ width: `${map.width}px`, height: `${map.height}px` }}>
          <MapCanvas map={map} tip={tip ?? sel} sel={sel} roving={roving} waiting={waiting} chats={state.chats} setTip={setTip} setSel={pickSub} onFocus={onFocus} toggleDone={toggleDone} />
          {tipNode && tipChat && <Tip node={tipNode} chat={tipChat} state={state} now={now} />}
        </div>
      </div>
      {selSub && <SubDetail sub={selSub} state={state} outside={outside} now={now} onClose={closeSub} />}
      </div>
    </div>
  );
}

interface CanvasProps {
  map: MapLayout;
  tip: string | null;
  roving: string;
  waiting: number;
  /** For the shared files' names of the chats; compared by layout, which changes with them. */
  chats: ChatView[];
  /** The subagent selected for the detail panel. */
  sel: string | null;
  setTip(id: string | null): void;
  /** `from`: the node clicked, for focus to go back to. */
  setSel(id: string | null, from?: Element): void;
  onFocus(id: string): void;
  /** Shows or folds a chat's done subagents. */
  toggleDone(parent: string): void;
}

/** The drawing itself: drawn again when the layout, the highlighted chat or the decision count changes. */
const MapCanvas = memo(
  MapCanvasView,
  (a: CanvasProps, b: CanvasProps) => a.map === b.map && a.tip === b.tip && a.sel === b.sel && a.roving === b.roving && a.waiting === b.waiting && a.setTip === b.setTip && a.onFocus === b.onFocus && a.toggleDone === b.toggleDone,
);

function MapCanvasView({ map, tip, sel, roving, waiting, chats, setTip, setSel, onFocus, toggleDone }: CanvasProps) {
  const lit = tip ? new Set([tip, ...map.edges.flatMap((e) => (e.from === tip || e.to === tip ? [e.id, e.from, e.to] : []))]) : null;
  return (
          <svg class="map" width={map.width} height={map.height} viewBox={`0 0 ${map.width} ${map.height}`} role="group" aria-label="Agent map" data-lit={lit ? '' : undefined}>
            <MapDefs />
            {map.lanes.map((lane) => (
              <g key={lane.outside ? 'outside' : lane.agent} class="map-lane" data-agent={lane.agent}>
                <rect x={MAP.laneX} y={lane.y} width={map.width - MAP.pad - MAP.laneX} height={lane.h} rx="12" />
                <SvgGlyph agent={lane.agent} x={MAP.col0} y={lane.y + 8} size={16} />
                <text class="lane-head" x={MAP.col0 + 23} y={lane.y + 20}>
                  <tspan class="lane-name">{lane.outside ? 'Claude Code · outside FriedLiver' : AGENT_FACES[lane.agent].name}</tspan>
                  <tspan class="lane-meta" dx="8">
                    {lane.chats}
                    {lane.working > 0 ? ` · ${lane.working} working` : ''}
                  </tspan>
                  {lane.needsYou > 0 && <tspan class="lane-meta loud">{` · ${lane.needsYou} need${lane.needsYou === 1 ? 's' : ''} you`}</tspan>}
                  {(lane.problem ?? 0) > 0 && <tspan class="lane-meta">{` · ${lane.problem} problem${lane.problem === 1 ? '' : 's'}`}</tspan>}
                </text>
              </g>
            ))}
            {map.columns.map((c) => (
              <text key={c.title} class="map-col-title" x={c.x} y={MAP.pad + 19}>
                {c.title}
              </text>
            ))}

            <path class="map-start" d={`M ${map.trunk.x} ${map.trunk.y1} V ${map.trunk.y2}`} />
            {map.starts.map((d) => (
              <path key={d} class="map-start" d={d} />
            ))}
            {map.groups.map((g) => (
              <g key={g.id} class="map-group">
                <path class="halo" d={bracket(g.x, g.y1, g.y2)} />
                <path class="bracket" d={bracket(g.x, g.y1, g.y2)} />
                <g transform={`translate(${g.x} ${g.joinY})`}>
                  <rect class="group-pill" x="-15" y="-9" width="30" height="18" rx="9" />
                  <text class="group-pill-text" y="3.5">
                    ×{g.size}
                  </text>
                </g>
              </g>
            ))}

            {map.conflicts.map((f) =>
              f.lines.map((d, i) => <path key={`${f.file}:${i}`} class={`map-file-line ${tip && f.chats.includes(tip) ? 'lit' : ''}`} d={d} />),
            )}
            {map.edges.map((e) => (
              <Edge key={e.id} edge={e} lit={!!lit?.has(e.id)} />
            ))}
            {map.edges.filter((e) => e.kind !== 'subagent').map((e) => (
              <EdgeLabel key={`${e.id}:label`} edge={e} lit={!!lit?.has(e.id)} />
            ))}

            <g class="map-you" transform={`translate(${map.you.x} ${map.you.y})`} aria-label={waiting ? `You: ${waiting} decisions waiting` : 'You'}>
              <rect width={MAP.youW} height={MAP.youH} rx={MAP.youH / 2} />
              <svg x="10" y="7" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 7.75a2.5 2.5 0 1 0 0-5a2.5 2.5 0 0 0 0 5zM3.25 13.25c.6-2.4 2.4-3.5 4.75-3.5s4.15 1.1 4.75 3.5" class="you-icon" />
              </svg>
              <text x="31" y="19.5">
                You
              </text>
              {waiting > 0 && (
                <g transform={`translate(${MAP.youW - 18} ${MAP.youH / 2})`}>
                  <circle r="9" class="you-badge" />
                  <text class="you-badge-text" y="3.5">
                    {waiting}
                  </text>
                </g>
              )}
            </g>

            {map.nodes.map((n) => (
              <Node
                key={n.chat.id}
                node={n}
                dim={!!lit && !lit.has(n.chat.id)}
                tabbable={n.chat.id === roving}
                onTip={setTip}
                onFocus={() => {
                  setTip(n.chat.id);
                  onFocus(n.chat.id);
                }}
              />
            ))}
            {map.outside.map((o) => (
              <g key={o.id} class={`map-node map-outside ${lit && !lit.has(`cc:${o.id}`) ? 'dim' : ''}`} data-status={o.state} data-agent="claude" transform={`translate(${o.x} ${o.y})`} aria-label={`Claude Code session outside FriedLiver: ${o.title}`}>
                <title>Started outside FriedLiver (the claude CLI or the Claude Code extension)</title>
                <rect class="box" width={MAP.nodeW} height={MAP.nodeH} rx="8" />
                <SvgGlyph agent="claude" x={10} y={10} size={20} />
                <text class="node-label" x="40" y="17">
                  {o.title}
                </text>
                <text class="node-title" x="40" y="31">
                  Claude Code · outside
                </text>
                <circle class="node-dot" data-state={o.state} cx={MAP.nodeW - 14} cy={MAP.nodeH / 2} r="4" />
              </g>
            ))}
            {map.subs.map((n) => {
              if (n.count) {
                const toggle = () => toggleDone(n.chatId);
                return (
                  <g
                    key={n.id}
                    class={`map-node map-sub map-fold ${lit && !lit.has(n.id) ? 'dim' : ''}`}
                    data-status="done"
                    transform={`translate(${n.x} ${n.y})`}
                    tabindex={0}
                    role="button"
                    aria-expanded={n.title.endsWith('hide')}
                    aria-label={`${n.count} done subagents: ${n.title.endsWith('hide') ? 'hide' : 'show'}`}
                    onClick={toggle}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggle();
                      }
                    }}
                  >
                    <rect class="box" width={MAP.nodeW} height={MAP.nodeH} rx="8" />
                    <circle class="node-dot" data-state="done" cx="18" cy={MAP.nodeH / 2} r="4" />
                    <text class="node-label" x="32" y={MAP.nodeH / 2 + 4}>
                      {n.title}
                    </text>
                  </g>
                );
              }
              const pick = (e: Event) => setSel(sel === n.id ? null : n.id, e.currentTarget as Element);
              return (
                <g
                  key={n.id}
                  class={`map-node map-sub ${lit && !lit.has(n.id) ? 'dim' : ''}`}
                  data-status={n.state === 'failed' ? 'error' : n.state === 'quiet' ? 'idle' : n.state}
                  data-agent={n.agent}
                  data-selected={sel === n.id ? '' : undefined}
                  transform={`translate(${n.x} ${n.y})`}
                  tabindex={0}
                  role="button"
                  aria-pressed={sel === n.id}
                  aria-label={`Subagent: ${n.title}`}
                  onClick={pick}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      pick(e);
                    }
                  }}
                >
                  {n.state === 'working' && <rect class="ring" x="-3.5" y="-3.5" width={MAP.nodeW + 7} height={MAP.nodeH + 7} rx="11" />}
                  <rect class="box" width={MAP.nodeW} height={MAP.nodeH} rx="8" />
                  <title>{`Subagent: ${n.title}`}</title>
                  <SvgGlyph agent={n.agent} x={10} y={10} size={20} />
                  <text class="node-label" x="40" y="17">
                    {n.title}
                  </text>
                  <text class="node-title" x="40" y="31">
                    {AGENT_FACES[n.agent].name}
                  </text>
                  <circle class="node-dot" data-state={n.state === 'failed' ? 'error' : n.state === 'quiet' ? 'idle' : n.state} cx={MAP.nodeW - 14} cy={MAP.nodeH / 2} r="4" />
                </g>
              );
            })}
            {map.conflicts.map((f) => (
              <g
                key={f.file}
                class="map-file"
                transform={`translate(${f.x} ${f.y})`}
                tabindex={-1}
                aria-label={`${f.file}, changed in ${f.chats.map((id) => { const c = chats.find((x) => x.id === id); return c ? chatName(c) : 'a closed chat'; }).join(' and ')}`}
              >
                <title>{f.file}</title>
                <rect width={MAP.fileW} height={MAP.fileH} rx="8" />
                <svg x="10" y="12" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4.5 2.5h4l3 3v8h-7zM8.5 2.5v3h3" class="file-icon" />
                </svg>
                <text class="file-name" x="32" y="17">
                  {basename(f.file).slice(0, 22)}
                </text>
                <text class="file-meta" x="32" y="31">
                  {f.chats.length} chats changed it
                </text>
              </g>
            ))}
          </svg>
  );
}

/** A bracket opening right: ticks at both ends, the spine between. */
function bracket(x: number, y1: number, y2: number): string {
  return `M ${x + 8} ${y1} H ${x + 4} Q ${x} ${y1} ${x} ${y1 + 4} V ${y2 - 4} Q ${x} ${y2} ${x + 4} ${y2} H ${x + 8}`;
}

function MapDefs() {
  return (
    <defs>
      <marker id="map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
        <path d="M1 1.5 9 5 1 8.5z" class="map-arrow" />
      </marker>
      <marker id="map-arrow-lit" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
        <path d="M1 1.5 9 5 1 8.5z" class="map-arrow lit" />
      </marker>
    </defs>
  );
}

function SvgGlyph({ agent, x, y, size }: { agent: MapNode['lane']; x: number; y: number; size: number }) {
  return (
    <g class="map-glyph" data-agent={agent} transform={`translate(${x} ${y})`} aria-hidden="true">
      <rect width={size} height={size} rx={size / 4} />
      <text x={size / 2} y={size / 2 + size * 0.19} style={{ fontSize: `${Math.round(size * 0.55)}px` }}>
        {AGENT_FACES[agent].letter}
      </text>
    </g>
  );
}

function Edge({ edge, lit }: { edge: MapEdge; lit: boolean }) {
  const marker = `url(#${lit ? 'map-arrow-lit' : 'map-arrow'})`;
  const cls = `edge ${edge.kind} ${lit ? 'lit' : ''}`;
  return (
    <g class={cls} data-by={edge.by}>
      {edge.kind === 'pipe' ? (
        <>
          <path class="pipe-outer" d={edge.d} marker-end={marker} />
          <path class="pipe-inner" d={edge.d} />
        </>
      ) : (
        <path class="line" d={edge.d} marker-end={marker} />
      )}
      {edge.flowing && <path class="flow" d={edge.d} />}
    </g>
  );
}

function EdgeLabel({ edge, lit }: { edge: MapEdge; lit: boolean }) {
  const w = edge.label.length * 6.1 + 16;
  return (
    <g class={`edge-label ${edge.kind} ${lit ? 'lit' : ''}`} transform={`translate(${edge.lx} ${edge.ly})`}>
      <rect x={-w / 2} y="-9" width={w} height="18" rx="9" />
      <text y="3.5">{edge.label}</text>
    </g>
  );
}

function Node({ node, dim, tabbable, onTip, onFocus }: { node: MapNode; dim: boolean; tabbable: boolean; onTip(id: string | null): void; onFocus(): void }) {
  const { chat, status } = node;
  const open = () => send({ type: 'openChat', chatId: chat.id });
  return (
    <g
      class={`map-node ${dim ? 'dim' : ''}`}
      data-status={status}
      data-agent={chat.agent}
      data-nav={chat.id}
      transform={`translate(${node.x} ${node.y})`}
      tabindex={tabbable ? 0 : -1}
      role="button"
      aria-label={`${chatTip(chat)}. ${DOT_LABEL[status] ?? status}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      onMouseEnter={() => onTip(chat.id)}
      onMouseLeave={() => onTip(null)}
      onFocus={onFocus}
      onBlur={() => onTip(null)}
    >
      {(status === 'working' || status === 'needs-you') && <rect class="ring" x="-3.5" y="-3.5" width={MAP.nodeW + 7} height={MAP.nodeH + 7} rx="11" />}
      <rect class="box" width={MAP.nodeW} height={MAP.nodeH} rx="8" />
      <SvgGlyph agent={chat.agent} x={10} y={10} size={20} />
      <title>{chatTip(chat)}</title>
      <text class="node-label" x="40" y="17">
        {node.title}
      </text>
      <text class="node-title" x="40" y="31">
        {AGENT_FACES[chat.agent].name}
      </text>
      <circle class="node-dot" data-state={status} cx={MAP.nodeW - 14} cy={MAP.nodeH / 2} r="4" />
      {chat.approval === 'full' && (
        <g class="node-auto" transform={`translate(${MAP.nodeW - 30} 4)`} aria-label="Auto">
          <title>Auto: edits and commands go through without asking</title>
          <rect width="22" height="12" rx="6" />
          <path d="M12.2 2.2 8.6 6.8h2.6L10.4 9.8l3.6-4.6h-2.6z" />
        </g>
      )}
    </g>
  );
}

/** Fixed to the viewport beside the hovered node (see tipPlace), so the map's scroll box never clips it. */
function Tip({ node, chat, state, now }: { node: MapNode; chat: ChatView; state: AppState; now: number }) {
  const status = statusOf(chat);
  const line = cardLine(state, chat);
  const badges = linkBadges(state, chat);
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = document.querySelector(`.map-node[data-nav="${CSS.escape(node.chat.id)}"] .box`)?.getBoundingClientRect();
    if (!anchor || !ref.current) return;
    setPlace(tipPlace(anchor, { w: TIP_W, h: ref.current.offsetHeight }, { w: window.innerWidth, h: window.innerHeight }));
  }, [node.chat.id, node.x, node.y]);
  return (
    <div
      ref={ref}
      class="map-tip"
      role="tooltip"
      style={place ? { left: `${place.left}px`, top: `${place.top}px`, width: `${place.width}px` } : { left: 0, top: 0, width: `${TIP_W}px`, visibility: 'hidden' }}
    >
      <div class="tip-head">
        <Glyph agent={chat.agent} size="sm" />
        <b title={chatTip(chat)}>{AGENT_FACES[chat.agent].name}</b>
        <span class="spacer" />
        <Dot state={status} />
        <span class="hint">{DOT_LABEL[status]}</span>
      </div>
      <div class="tip-title">{chat.title}</div>
      {chat.approval === 'full' && <div class="tip-line tip-auto">Auto: edits and commands go through without asking</div>}
      <div class="tip-line" data-decision={line.decision ? '' : undefined}>
        {line.text}
      </div>
      <div class="tip-meta">
        {chat.files.length} file{chat.files.length === 1 ? '' : 's'} · {turnsText(chat)} · active {ago(chat.lastActivity, now)}
      </div>
      {chat.branch && (
        <div>
          <span class="fl-pill" data-tone="muted">
            <Icon name="branch" />
            {chat.branch}
          </span>
        </div>
      )}
      {badges.length > 0 && (
        <div class="tip-badges">
          {badges.map((b) => (
            <span key={b.text} class="fl-pill" data-tone="muted">
              {b.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const SUB_LABEL = { working: 'Working', done: 'Done', failed: 'Problem', quiet: 'Quiet' } as const;

/** The selected subagent: what it is doing or did, beside the map. Opening its chat is a choice here, not what a click does. */
function SubDetail({ sub, state, outside, now, onClose }: { sub: MapSub; state: AppState; outside: ClaudeSession[]; now: number; onClose(): void }) {
  const chat = sub.outside ? undefined : state.chats.find((c) => c.id === sub.chatId);
  const session = sub.outside ? outside.find((s) => `cc:${s.id}` === sub.chatId) : undefined;
  const info = chat ? subagents(chat).find((s) => s.id === sub.item) : session && claudeSubagents(session, now).find((s) => s.id === sub.item);
  const call = chat?.items.find((i): i is ToolItem => i.kind === 'tool' && i.id === sub.item);
  const steps = chat ? chat.items.filter((i): i is ToolItem => i.kind === 'tool' && i.parent === sub.item) : [];
  const answer = call && subagentAnswer(call);
  const state_ = info?.state ?? sub.state;
  const ms = info?.ms ?? (info?.startedAt !== undefined ? Math.max(0, now - info.startedAt) : undefined);
  const box = useRef<HTMLDivElement>(null);
  // Opened: focus moves in without scrolling the page; Esc closes.
  useEffect(() => {
    box.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // Narrow, it is a bottom sheet: dragging its handle down closes it.
  const [drag, setDrag] = useState(0);
  const from = useRef<number | null>(null);
  return (
    <div
      class="map-detail"
      ref={box}
      tabIndex={-1}
      role="dialog"
      aria-label={`Subagent: ${info?.title ?? sub.title}`}
      style={drag > 0 ? { transform: `translateY(${drag}px)` } : undefined}
    >
      <div
        class="sheet-handle"
        aria-hidden="true"
        onPointerDown={(e) => {
          from.current = e.clientY;
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => from.current !== null && setDrag(Math.max(0, e.clientY - from.current))}
        onPointerUp={() => {
          from.current = null;
          if (drag > SHEET_CLOSE_PX) onClose();
          else setDrag(0);
        }}
      />
      <div class="tip-head">
        <Dot state={state_ === 'failed' ? 'error' : state_ === 'quiet' ? 'idle' : state_} />
        <b>Subagent</b>
        <span class="hint" title={info?.note}>{SUB_LABEL[state_]}{ms !== undefined ? ` · ${shortDuration(ms)}` : ''}</span>
        <span class="spacer" />
        <IconButton icon="close" label="Close" muted size="sm" title="Close" onClick={onClose} />
      </div>
      <div class="tip-title">{info?.title ?? sub.title}</div>
      <div class="tip-meta" title={chat ? chatTip(chat) : undefined}>of {chat ? chat.title : session ? `${session.title} (Claude Code, outside FriedLiver)` : 'its chat'}</div>
      {steps.length > 0 && (
        <ol class="map-detail-steps" aria-label="Steps">
          {steps.slice(-8).map((t) => (
            <li key={t.id} data-state={t.status}>
              {t.title}
            </li>
          ))}
        </ol>
      )}
      {answer && <div class="map-detail-answer">{answer.length > 600 ? `${answer.slice(0, 599)}…` : answer}</div>}
      {session && info?.about && <div class="tip-meta">{info.about}</div>}
      {session && info?.last && <div class="tip-line">Last step: {info.last}</div>}
      {!steps.length && !answer && !info?.last && <div class="tip-line">{session ? 'Its steps are in that session\'s transcript; FriedLiver lists only its title and state.' : 'No steps reported yet.'}</div>}
      {chat && (
        <Button variant="link" onClick={() => send({ type: 'openChat', chatId: chat.id, item: sub.item })}>
          Show in its chat
        </Button>
      )}
    </div>
  );
}

/** How far the bottom sheet is dragged down before it closes. */
const SHEET_CLOSE_PX = 80;

/** `still`: nothing on the map is live, so the "Live" sample doesn't move either; a moving dash repaints every frame. Its Working dot pulses while a chat works. */
function Legend({ still, working }: { still: boolean; working: boolean }) {
  const sample = (cls: string, extra?: ComponentChildren) => (
    <svg class="legend-sample" width="30" height="12" viewBox="0 0 30 12" aria-hidden="true">
      <g class={`edge ${cls}`}>{extra}</g>
    </svg>
  );
  return (
    <ul class="map-legend" aria-label="Legend" data-still={still ? '' : undefined}>
      <li>{sample('handoff', <path class="line" d="M1 6 H26" marker-end="url(#map-arrow)" />)}Hand-off</li>
      <li>{sample('consult', <path class="line" d="M1 6 H26" marker-end="url(#map-arrow)" />)}Consult</li>
      <li>
        {sample(
          'pipe',
          <>
            <path class="pipe-outer" d="M1 6 H26" marker-end="url(#map-arrow)" />
            <path class="pipe-inner" d="M1 6 H24" />
          </>,
        )}
        Pipe
      </li>
      <li>{sample('subagent', <path class="line" d="M1 6 H26" marker-end="url(#map-arrow)" />)}Subagent</li>
      <li>{sample('pipe', <path class="flow" d="M1 6 H29" />)}Live</li>
      <li>
        <svg class="legend-sample" width="14" height="16" viewBox="0 0 14 16" aria-hidden="true">
          <path class="legend-bracket" d={bracket(3, 2, 14)} />
        </svg>
        Fan-out
      </li>
      <li>
        <span class="legend-file" aria-hidden="true" />
        Shared file
      </li>
      <li class="legend-sep" aria-hidden="true" />
      {(['needs-you', 'working', 'done', 'error', 'idle'] as const).map((s) => (
        <li key={s}>
          <Dot state={s} still={!working} />
          {DOT_LABEL[s]}
        </li>
      ))}
    </ul>
  );
}
