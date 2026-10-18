// What the /discuss card draws (COMPONENTS.md §2.30), worked out from a DiscussionItem with no I/O:
// the question's parts, the positions as they emerged, who holds what after each round, the moves and
// trends, B's stance meter, and the outcome every layout's conclusion shows. Old saved discussions
// (no side, reply or trend on their stances) degrade to what their prose and options allow.
import { speakerName, type DiscussTurn, type DiscussionItem, type Stance, type Trend } from './discuss';
import type { AgentKey } from './model';

// ---- The layout setting (friedliver.discuss.layout) ----

export const DISCUSS_LAYOUTS = ['board+meter', 'board', 'meter', 'timeline'] as const;
export type DiscussLayout = (typeof DISCUSS_LAYOUTS)[number];
export const DEFAULT_DISCUSS_LAYOUT: DiscussLayout = 'board+meter';

export const discussLayoutOf = (v: unknown): DiscussLayout => ((DISCUSS_LAYOUTS as readonly unknown[]).includes(v) ? (v as DiscussLayout) : DEFAULT_DISCUSS_LAYOUT);

/** The webview's current layout; open cards watch it, so a settings change redraws them at once. */
export const discussLayouts = (() => {
  let layout: DiscussLayout = DEFAULT_DISCUSS_LAYOUT;
  const watchers = new Set<() => void>();
  return {
    get: () => layout,
    set(v: unknown) {
      layout = discussLayoutOf(v);
      for (const wake of watchers) wake();
    },
    watch(wake: () => void) {
      watchers.add(wake);
      return () => void watchers.delete(wake);
    },
  };
})();

export type DiscussSection = 'bar' | 'points' | 'board' | 'meter' | 'steps' | 'rows' | 'thread' | 'outcome' | 'sides' | 'conclusion' | 'actions' | 'board-folded' | 'history';

/**
 * The card's parts, top to bottom, under the head and above the foot. Running: each layout its own
 * (A's board, B's meter and rows, C's thread; board+meter puts the meter under the board). Finished:
 * every layout uses C's conclusion; the meter layouts keep the meter under the headline and the
 * board layouts keep the board folded, for its last round.
 */
export function discussSections(layout: DiscussLayout, d: DiscussionItem): DiscussSection[] {
  const board = layout === 'board+meter' || layout === 'board';
  const meter = layout === 'board+meter' || layout === 'meter';
  if (d.state !== 'done') {
    if (layout === 'timeline') return ['thread'];
    if (layout === 'meter') return ['steps', 'meter', 'rows'];
    return ['bar', 'points', 'board', ...(meter ? (['meter'] as const) : [])];
  }
  const v = discussView(d);
  // The meter and the board only once someone took a position.
  const held = v.rounds.some((r) => Object.keys(r.holds).length > 0);
  const out: DiscussSection[] = ['outcome'];
  if (meter && held) out.push('meter');
  if (v.outcome?.sides.length) out.push('sides');
  out.push('conclusion', 'actions');
  if (board && held) out.push('board-folded');
  if (v.rounds.length) out.push('history');
  return out;
}

/** The inline field's hint: the round a point goes in before. */
export const pointPlaceholder = (d: Pick<DiscussionItem, 'round' | 'maxRounds'>): string =>
  d.round < d.maxRounds ? `Add a point. It goes in before round ${d.round + 1}.` : 'Add a point. It goes in before the summing up.';

// ---- The question ----

/** "Postgres or MySQL for X (a, b, c)?" → title "Postgres or MySQL for X?", context [a, b, c], options [Postgres, MySQL]. */
export function questionParts(question: string): { title: string; context: string[]; options?: string[] } {
  const lines = question
    .trim()
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  let title = lines[0] ?? '';
  const context = lines.slice(1);
  const m = /^(.*\S)\s*\(([^()]+)\)\s*([?.!]?)$/.exec(title);
  if (m) {
    title = m[1] + m[3];
    context.unshift(...m[2].split(/\s*[,;·]\s*/).filter(Boolean));
  }
  const options = optionsOf(title);
  return { title, context, ...(options ? { options } : {}) };
}

/** The options a question names ("A or B", "A, B or C", "A vs B"), each at most 3 words; none for an open question. */
function optionsOf(title: string): string[] | undefined {
  const t = title.replace(/[?.!]+$/, '').replace(/^(?:should (?:we|i) (?:use|pick|choose|go with)|use|pick|choose)\s+/i, '');
  const m = /^(.+?)\s+(?:or|vs\.?|versus)\s+(.+)$/i.exec(t);
  if (!m) return undefined;
  const last = m[2].replace(/\s+(?:for|to|in|on|as|with|when|at|because)\b.*$/i, '');
  const opts = [...m[1].split(/\s*,\s*/), last].map((o) => o.trim());
  return opts.length >= 2 && opts.every((o) => o && o.length <= 30 && o.split(/\s+/).length <= 3) ? opts : undefined;
}

// ---- The model ----

export interface TurnView {
  /** Its index in d.turns. */
  n: number;
  agent: AgentKey;
  round: number;
  /** Index into positions. */
  side?: number;
  /** 0..1 */
  confidence?: number;
  /** One line: the stance's position, else the turn's first sentence. */
  claim: string;
  body: string;
  re?: { agent: AgentKey; quote: string };
  failed?: true;
}

export interface RoundView {
  round: number;
  turns: TurnView[];
  /** What the user added before it. */
  points: DiscussTurn[];
  /** Who holds which position once the round is over (or so far, while it runs). */
  holds: Partial<Record<AgentKey, number>>;
  conf: Partial<Record<AgentKey, number>>;
  /** Agents whose position changed in this round. */
  moved: AgentKey[];
  /** "2 to 1", "split", "agreed"; empty when nobody holds a position. */
  tally: string;
  trend?: Trend;
  on?: string;
  label: string;
}

export interface Outcome {
  kind: 'agreed' | 'split' | 'none';
  headline: string;
  /** The question they still split on. */
  dispute?: string;
  sides: { position: string; agents: AgentKey[]; why: string }[];
  /** Agreed: "Claude and Codex, 85% sure each". */
  who?: string;
  whoAgents?: AgentKey[];
  /** The agreed list's label. */
  agreedLabel: string;
}

export interface DiscussView {
  title: string;
  context: string[];
  /** No options in the question: the positions are named as they emerge. */
  open: boolean;
  positions: string[];
  agents: AgentKey[];
  rounds: RoundView[];
  speaking?: AgentKey;
  /** Each agent's newest turn up to a round. */
  latest(agent: AgentKey, upTo?: number): TurnView | undefined;
  /** Agents who held a position at some point. */
  everHeld(position: number): AgentKey[];
  outcome?: Outcome;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?:;,\s]+$/, '').trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A free position cut to a column name: up to the first clause break, at most 32 characters. */
function shortName(position: string): string {
  const head = position.split(/[,:;(—–]|\s(?:because|so|since|but)\s/)[0].trim().replace(/[.!?]+$/, '');
  if (head.length <= 32) return head;
  return `${head.slice(0, 31).replace(/\s+\S*$/, '')}…`;
}

/** The position a stance holds: the option it names first, its own side, or (parsed only) its position cut short. */
function sideName(s: Stance | undefined, options: string[] | undefined): string | undefined {
  if (!s) return undefined;
  if (options)
    for (const text of [s.side, s.position]) {
      if (!text) continue;
      let best: { o: string; at: number } | undefined;
      for (const o of options) {
        const at = new RegExp(`(^|[^\\w])${esc(o)}([^\\w]|$)`, 'i').exec(text)?.index;
        if (at !== undefined && (!best || at < best.at)) best = { o, at };
      }
      if (best) return best.o;
    }
  if (s.side) return s.side;
  return s.parsed && s.position ? shortName(s.position) : undefined;
}

function firstSentence(text: string): string {
  const plain = text.replace(/[#*_`>]/g, '').trim();
  const m = /^[\s\S]*?[.!?](\s|$)/.exec(plain);
  return (m ? m[0] : plain).trim().slice(0, 200);
}

const names = (agents: AgentKey[]) => {
  const n = agents.map(speakerName);
  return n.length <= 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
};
const pct = (c: number) => `${Math.round(c * 100)}%`;
const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…`);

export function discussView(d: DiscussionItem): DiscussView {
  const { title, context, options } = questionParts(d.question);
  const agents = d.participants.map((p) => p.agent);
  const positions = [...(options ?? [])];
  const keys = positions.map(norm);
  const indexOf = (name: string) => {
    const k = norm(name);
    let i = keys.indexOf(k);
    if (i < 0) {
      i = positions.push(name) - 1;
      keys.push(k);
    }
    return i;
  };
  const turns: TurnView[] = [];
  d.turns.forEach((t, n) => {
    if (t.by === 'you') return;
    const s = t.failed ? undefined : t.stance;
    const name = sideName(s, options);
    turns.push({
      n,
      agent: t.by,
      round: t.round,
      ...(name ? { side: indexOf(name) } : {}),
      ...(s?.confidence !== undefined ? { confidence: s.confidence } : {}),
      claim: s?.parsed && s.position ? s.position : firstSentence(t.text),
      body: t.text,
      ...(s?.re ? { re: s.re } : {}),
      ...(t.failed ? { failed: true as const } : {}),
    });
  });
  const spokenRounds = turns.map((t) => t.round);
  const last = Math.max(d.state === 'done' ? 0 : d.round, ...spokenRounds, 0);
  const trends = new Map((d.conclusion?.rounds ?? []).map((r) => [r.round, r]));
  const rounds: RoundView[] = [];
  for (let r = 1; r <= last; r++) {
    const holds: RoundView['holds'] = {};
    const conf: RoundView['conf'] = {};
    for (const a of agents) {
      const t = turns.findLast((x) => x.agent === a && x.round <= r && x.side !== undefined);
      if (!t) continue;
      holds[a] = t.side;
      if (t.confidence !== undefined) conf[a] = t.confidence;
    }
    const prev = rounds[r - 2];
    const moved = prev ? agents.filter((a) => holds[a] !== undefined && prev.holds[a] !== undefined && holds[a] !== prev.holds[a]) : [];
    const points = d.turns.filter((t) => t.by === 'you' && (t.round === r || (r === last && t.round > last)));
    const given = trends.get(r);
    // Worked out only for a finished round: mid-round, the tally says enough.
    const settled = d.state === 'done' || r < d.round;
    const trend = given?.trend ?? (prev && settled ? trendOf(prev.holds, holds, moved.length) : undefined);
    const label =
      r === 1
        ? 'Opening positions'
        : points.length
          ? `You added: ${cut(points[0].text, 64)}`
          : moved.length
            ? `${names(moved)} moved over`
            : r === d.maxRounds
              ? 'Last round'
              : 'Replies';
    rounds.push({ round: r, turns: turns.filter((t) => t.round === r), points, holds, conf, moved, tally: tallyOf(holds), ...(trend ? { trend } : {}), ...(given?.on ? { on: given.on } : {}), label });
  }
  const view: DiscussView = {
    title,
    context,
    open: !options,
    positions,
    agents,
    rounds,
    ...(d.state !== 'done' && d.speaking ? { speaking: d.speaking } : {}),
    latest: (agent, upTo = Infinity) => turns.findLast((t) => t.agent === agent && t.round <= upTo),
    everHeld: (i) => agents.filter((a) => rounds.some((r) => r.holds[a] === i)),
  };
  if (d.state === 'done') view.outcome = outcomeOf(d, view);
  return view;
}

function tallyOf(holds: Partial<Record<AgentKey, number>>): string {
  const counts = new Map<number, number>();
  for (const i of Object.values(holds)) if (i !== undefined) counts.set(i, (counts.get(i) ?? 0) + 1);
  const sizes = [...counts.values()].sort((a, b) => b - a);
  const n = sizes.reduce((x, y) => x + y, 0);
  if (!sizes.length) return '';
  if (sizes.length === 1) return n >= 2 ? 'agreed' : '';
  if (sizes.length === 2 && sizes[0] === 1) return 'split';
  return sizes.join(' to ');
}

/** Without the summary's word for it: fewer camps or a bigger one is converging, the reverse diverging, no move stuck. */
function trendOf(before: Partial<Record<AgentKey, number>>, now: Partial<Record<AgentKey, number>>, moves: number): Trend | undefined {
  const shape = (h: Partial<Record<AgentKey, number>>) => {
    const counts = new Map<number, number>();
    for (const i of Object.values(h)) if (i !== undefined) counts.set(i, (counts.get(i) ?? 0) + 1);
    return { camps: counts.size, biggest: Math.max(0, ...counts.values()) };
  };
  const a = shape(before);
  const b = shape(now);
  if (!a.camps || !b.camps) return undefined;
  if (b.camps < a.camps || b.biggest > a.biggest) return 'converging';
  if (b.camps > a.camps || b.biggest < a.biggest) return 'diverging';
  return moves ? undefined : 'stuck';
}

function outcomeOf(d: DiscussionItem, v: DiscussView): Outcome {
  const c = d.conclusion;
  const final = v.rounds.at(-1)?.holds ?? {};
  const conf = v.rounds.at(-1)?.conf ?? {};
  const groups = v.positions.map((position, i) => ({ position, agents: v.agents.filter((a) => final[a] === i) })).filter((g) => g.agents.length);
  const dis = c?.disagreed ?? [];
  if (!d.turns.some((t) => t.by !== 'you' && !t.failed)) return { kind: 'none', headline: 'Nobody answered', sides: [], agreedLabel: 'They agree on' };
  if (!dis.length && (groups.length <= 1 || d.ended === 'agreed')) {
    const one = groups.length === 1 ? groups[0] : undefined;
    const who = one?.agents ?? v.agents;
    const sure = who.map((a) => conf[a]).filter((x): x is number => x !== undefined);
    const same = sure.length === who.length && sure.every((x) => x === sure[0]);
    const line = sure.length ? (same ? `${pct(sure[0])} sure each` : `${pct(Math.min(...sure))} to ${pct(Math.max(...sure))} sure`) : '';
    return { kind: 'agreed', headline: one ? `Agreed: ${one.position}` : 'Agreed', sides: [], who: `${names(who)}${line ? `, ${line}` : ''}`, whoAgents: who, agreedLabel: 'What they settled on' };
  }
  const point = dis[0];
  const caseOf = (agent: AgentKey) => point?.sides.find((s) => s.agent === agent)?.view;
  const sides =
    groups.length >= 2
      ? groups.map((g) => ({ ...g, why: g.agents.map(caseOf).find(Boolean) ?? v.latest(g.agents[0])?.claim ?? '' }))
      : (point?.sides ?? []).map((s) => ({ position: speakerName(s.agent), agents: [s.agent], why: s.view }));
  return {
    kind: 'split',
    headline: dis.length > 1 ? `Still split on ${dis.length} questions` : dis.length ? 'Still split on one question' : 'Still split',
    ...(point ? { dispute: point.point } : {}),
    sides,
    agreedLabel: 'They agree on',
  };
}

// ---- B's stance meter ----

export interface MeterLane {
  agent: AgentKey;
  /** 0..100 across the track: an end at full confidence, the middle unsure. */
  x: number;
  /** Earlier rounds' places, left behind as hollow dots. */
  trail: number[];
  speaking: boolean;
  /** Under the marker: "80% sure", "speaking…", or the third position's name. */
  label: string;
  side?: number;
}

/** The meter as of `round`: the two most-held positions are its ends; anything else sits in the middle. */
export function meterOf(v: DiscussView, round: number): { ends: [string, string]; endIndex: [number, number]; lanes: MeterLane[] } {
  const held = v.positions.map((_, i) => v.rounds.reduce((n, r) => n + Object.values(r.holds).filter((x) => x === i).length, 0));
  const top = v.positions
    .map((_, i) => i)
    .sort((a, b) => held[b] - held[a] || a - b)
    .slice(0, 2)
    .sort((a, b) => a - b);
  const endIndex: [number, number] = [top[0] ?? -1, top[1] ?? -1];
  const x = (side: number | undefined, c: number | undefined) => (side === endIndex[0] ? 50 - (c ?? 0.5) * 50 : side === endIndex[1] ? 50 + (c ?? 0.5) * 50 : 50);
  const lanes = v.agents.map((agent): MeterLane => {
    const hist = v.rounds.filter((r) => r.round <= round).map((r) => ({ side: r.holds[agent], c: r.conf[agent] }));
    const now = hist.at(-1);
    const at = x(now?.side, now?.c);
    const trail = [...new Set(hist.slice(0, -1).filter((h) => h.side !== undefined).map((h) => x(h.side, h.c)))].filter((p) => p !== at);
    const speaking = v.speaking === agent;
    const other = now?.side !== undefined && !endIndex.includes(now.side);
    return {
      agent,
      x: at,
      trail,
      speaking,
      label: speaking ? 'speaking…' : other ? v.positions[now.side!] : now?.c !== undefined ? `${pct(now.c)} sure` : now?.side === undefined ? 'no stance yet' : '',
      ...(now?.side !== undefined ? { side: now.side } : {}),
    };
  });
  return { ends: [v.positions[endIndex[0]] ?? '', v.positions[endIndex[1]] ?? ''], endIndex, lanes };
}
