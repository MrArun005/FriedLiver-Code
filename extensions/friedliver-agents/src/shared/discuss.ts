// /discuss: the agents of a chat talk a question through in turns and end with a conclusion.
// The data the card shows, how a turn's stance is read, and which transcript items it folds away.
// The host runs it (host/discuss.ts); this file has no I/O so both sides and the tests share it.
import { choiceOf, resolveMention, sameModel, scanMentions, withoutMentions, type MentionProblem, type ModelCatalog, type Who } from './discussMentions';
import { AGENT_FACES, MENTIONS, isAgentKey, type AgentKey, type Item } from './model';

/** Rounds when friedliver.discuss.maxRounds is unset, and its bounds. */
export const DISCUSS_ROUNDS = { default: 3, min: 1, max: 5 } as const;
/** Estimated tokens (sent and received) after which the discussion stops and is summed up. */
export const DISCUSS_BUDGET = { default: 60_000, min: 5_000, max: 500_000 } as const;
/** One turn's text as the card keeps it. */
export const MAX_TURN_TEXT = 8_000;

/** Where a speaker stands after a turn. `parsed` is false when FriedLiver had to guess it from the prose. */
export interface Stance {
  position: string;
  agree: string[];
  disagree: string[];
  /** 0..1, when the agent gave one. */
  confidence?: number;
  /** The position's short name (1 to 4 words), shared by everyone who holds it: the board's column, the meter's end. */
  side?: string;
  /** Whose point the turn mainly answers (a Speaker), and the words of theirs it answers. */
  re?: { agent: Speaker; quote: string };
  parsed: boolean;
}

export interface DiscussTurn {
  /** `you`: something the user put in between rounds. */
  by: Speaker | 'you';
  round: number;
  text: string;
  stance?: Stance;
  /** The agent couldn't answer: the text says why. */
  failed?: true;
}

export interface Conclusion {
  agreed: string[];
  disagreed: { point: string; sides: { agent: Speaker; view: string }[] }[];
  next: string;
  /** Who wrote it: the starting agent, or FriedLiver from the stances when that failed. */
  by: Speaker | 'friedliver';
  /** The participant the summary suggests should carry it out. */
  carryOut?: Speaker;
  /** How each round moved, from the summary; missing in older discussions (the card then works it out). */
  rounds?: RoundTrend[];
}

export type Trend = 'converging' | 'diverging' | 'stuck';
export interface RoundTrend {
  round: number;
  trend?: Trend;
  /** What it turned on, in a few words ("indexing"). */
  on?: string;
}

export type DiscussEnd = 'agreed' | 'rounds' | 'budget' | 'stopped' | 'failed';

/** A discussion, shown as one card in the chat that started it. */
export interface DiscussionItem {
  kind: 'discussion';
  id: string;
  question: string;
  /** In speaking order; the first is the chat that started it. `chatId` is set once the agent's chat is known. */
  participants: Participant[];
  maxRounds: number;
  /** The round being spoken (1-based); the last one spoken once it ended. */
  round: number;
  state: 'running' | 'summarizing' | 'done';
  ended?: DiscussEnd;
  /** Who is speaking now. */
  speaking?: Speaker;
  /** Points the user added while it runs, heard from the next round on (or by the summing up after the last). */
  points?: string[];
  turns: DiscussTurn[];
  tokens: number;
  budget: number;
  conclusion?: Conclusion;
  /** Transcript items after the card that the discussion's own turns made; fixed when it ends. */
  span?: number;
  /** Carried out with this participant. */
  carried?: Speaker;
  /** Continued in a newer card. */
  continued?: true;
  at?: number;
}

// ---- Who speaks ----

/**
 * A participant's key in a discussion: its agent ("claude"), or its agent and model ("claude/opus") when it
 * has one, so the same agent can take part twice on different models. Turns, stances, the conclusion and
 * the card name participants by it. Discussions saved before models were keyed by agent alone, which reads
 * back the same way.
 */
export type Speaker = string;

/** One who takes part: an agent, on `model` when it has one (`modelName`: how its agent names that model). */
export interface Participant {
  agent: AgentKey;
  model?: string;
  modelName?: string;
  chatId?: string;
}

export const speakerOf = (p: Pick<Participant, 'agent' | 'model'>): Speaker => (p.model ? `${p.agent}/${p.model}` : p.agent);
/** The agent of a speaker key: its face and logo. */
export const agentOf = (s: Speaker): AgentKey => s.slice(0, (s + '/').indexOf('/')) as AgentKey;
const fromKey = (s: Speaker): Participant => {
  const i = s.indexOf('/');
  return i < 0 ? { agent: s as AgentKey } : { agent: s.slice(0, i) as AgentKey, model: s.slice(i + 1) };
};

/** "Claude · Opus 4.5" for a participant on a model, "Claude" for one on its agent's default. */
export function participantName(p: Pick<Participant, 'agent' | 'model' | 'modelName'>): string {
  if (!p.model) return AGENT_FACES[p.agent]?.name ?? p.agent;
  return choiceOf({ agent: p.agent, model: p.model }, p.modelName ? { [p.agent]: [{ value: p.model, name: p.modelName }] } : {}).label;
}

/** The names of a discussion's participants by key; "You" for the user. */
export function namesOf(participants: readonly Participant[]): (s: Speaker | 'you') => string {
  const names = new Map(participants.map((p) => [speakerOf(p), participantName(p)]));
  return (s) => (s === 'you' ? 'You' : (names.get(s) ?? participantName(fromKey(s))));
}

/** A speaker's name without its discussion to hand: the agent's, with the model's id when it has one. */
export const speakerName = (s: Speaker | 'you'): string => (s === 'you' ? 'You' : participantName(fromKey(s)));

/**
 * The participant an agent named in its reply (replyTo, a conclusion's side or carryOut): by key, by name
 * ("Claude · Opus 4.5", punctuation aside), or by an agent's name when only one participant is that agent.
 */
export function speakerResolver(participants: readonly (Participant | Speaker)[]): (raw: string) => Speaker | undefined {
  const ps = participants.map((p) => (typeof p === 'string' ? fromKey(p) : p));
  const keys = ps.map(speakerOf);
  const name = namesOf(ps);
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
  return (raw) => {
    const r = raw.trim().replace(/^@/, '').toLowerCase();
    if (!r) return undefined;
    const known = keys.find((k) => k.toLowerCase() === r) ?? keys.find((k) => flat(name(k)) === flat(r));
    if (known) return known;
    const agent = MENTIONS[r];
    const of = agent ? keys.filter((k) => agentOf(k) === agent) : [];
    return of.length === 1 ? of[0] : undefined;
  };
}

/** Without participants to hand: an agent's name, as before models. */
const byAgentName = (raw: string): Speaker | undefined => MENTIONS[raw.trim().replace(/^@/, '').toLowerCase()];

// ---- The command ----

export interface DiscussPlan {
  /** Who joins the chat's own agent, in the order mentioned. */
  participants: Who[];
  question: string;
  /** Mentions that need a choice (ambiguous) or a fix (unknown): nothing is sent while there are any. */
  problems: MentionProblem[];
}

/**
 * "/discuss @gemini @codex Postgres or MySQL?", or with the mentions anywhere in the question and in any
 * order ("Postgres or MySQL? @opus @gemini"): agents, models (resolved against `catalog`, the models each
 * agent reported) and agent/model pairs. The question is the text without them; an @ in code, an email or a
 * URL is no mention. The chat's own agent always takes part, first, and sums up: mentioning it on no model or
 * on the model it is on adds nobody, mentioning it on another model adds that as another participant.
 * Null when it isn't /discuss; "incomplete" without another participant or a question.
 */
export function parseDiscuss(text: string, starter: AgentKey | Who, catalog: ModelCatalog = {}): DiscussPlan | 'incomplete' | null {
  const head = /^\s*\/discuss\b/i.exec(text);
  if (!head) return null;
  const self: Who = typeof starter === 'string' ? { agent: starter } : starter;
  const mentions = scanMentions(text, head[0].length);
  const participants: Who[] = [];
  const problems: MentionProblem[] = [];
  for (const mention of mentions) {
    const r = resolveMention(mention.word, catalog);
    if ('ambiguous' in r) problems.push({ kind: 'ambiguous', mention, options: r.ambiguous.map((w) => choiceOf(w, catalog)) });
    else if ('unknown' in r) problems.push({ kind: 'unknown', mention, suggestions: r.unknown.map((w) => choiceOf(w, catalog)) });
    else if (!(r.ok.agent === self.agent && (!r.ok.model || sameModel(r.ok.model, self.model))) && !participants.some((p) => speakerOf(p) === speakerOf(r.ok))) participants.push(r.ok);
  }
  const shift = head[0].length;
  const question = withoutMentions(text.slice(shift), mentions.map((m) => ({ ...m, at: m.at - shift, end: m.end - shift }))).trim();
  if (problems.length) return { participants, question, problems };
  return participants.length && question ? { participants, question, problems } : 'incomplete';
}

// ---- Stances ----

const asList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/;|\n/) : [])
    .map((x) => (typeof x === 'string' ? x.replace(/^[\s*•-]+/, '').trim() : ''))
    .filter((x) => x && !/^(none|n\/a|nothing|-)\.?$/i.test(x))
    .slice(0, 8)
    .map((x) => x.slice(0, 300));

/** 0..1 from 0.8, "0.8", "80%", 80 or "high"; undefined otherwise. */
export function confidenceOf(v: unknown): number | undefined {
  if (typeof v === 'string') {
    const word = { low: 0.3, medium: 0.6, moderate: 0.6, high: 0.85 }[v.trim().toLowerCase()];
    if (word !== undefined) return word;
    const m = /^\s*(\d+(?:\.\d+)?)\s*(%|\/\s*10)?\s*$/.exec(v);
    if (!m) return undefined;
    v = Number(m[1]) / (m[2] === '%' ? 100 : m[2] ? 10 : 1);
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  const n = v > 1 ? v / 100 : v;
  return n > 1 ? undefined : Math.round(n * 100) / 100;
}

function stanceFrom(o: unknown, who: (raw: string) => Speaker | undefined = byAgentName): Stance | undefined {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const r = o as Record<string, unknown>;
  if (!('agree' in r || 'disagree' in r || 'position' in r)) return undefined;
  const position = typeof r.position === 'string' ? r.position.trim().slice(0, 300) : '';
  const confidence = confidenceOf(r.confidence);
  const side = typeof r.side === 'string' ? r.side.trim().slice(0, 60) : '';
  const to = typeof r.replyTo === 'string' ? who(r.replyTo) : undefined;
  const quote = typeof r.quote === 'string' ? r.quote.trim().replace(/^["“”']+|["“”']+$/g, '').slice(0, 120) : '';
  return {
    position,
    agree: asList(r.agree),
    disagree: asList(r.disagree),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(side ? { side } : {}),
    ...(to && quote ? { re: { agent: to, quote } } : {}),
    parsed: true,
  };
}

/** Every top-level {...} in the text, last first, that parses as JSON. */
function jsonObjects(text: string): unknown[] {
  const out: unknown[] = [];
  for (let end = text.lastIndexOf('}'); end > 0 && out.length < 4; end = text.lastIndexOf('}', end - 1)) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      if (text[i] === '}') depth++;
      else if (text[i] === '{' && --depth === 0) {
        try {
          out.push(JSON.parse(text.slice(i, end + 1)));
          end = i;
        } catch {
          // Not JSON: look further back.
        }
        break;
      }
    }
  }
  return out;
}

const FENCE = /```[ \t]*(stance|json|conclusion)?[ \t]*\n([\s\S]*?)```/gi;
const LINE = /^\s*[*_]*\s*(position|side|agree(?:s|ment)?|disagree(?:s|ment)?|confidence)\s*[*_]*\s*:\s*[*_]*\s*(.*)$/i;

/**
 * The stance a turn ends with: a ```stance JSON block (asked for), any JSON object with its keys,
 * or "Agree: …" / "Disagree: …" / "Confidence: …" lines. Undefined when there is none.
 */
export function parseStance(text: string, who?: (raw: string) => Speaker | undefined): Stance | undefined {
  const fenced = [...text.matchAll(FENCE)].reverse();
  for (const f of fenced) {
    const s = jsonObjects(f[2])
      .map((o) => stanceFrom(o, who))
      .find(Boolean);
    if (s) return s;
  }
  const loose = jsonObjects(text)
    .map((o) => stanceFrom(o, who))
    .find(Boolean);
  if (loose) return loose;
  const fields: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = LINE.exec(line);
    if (m) fields[m[1].toLowerCase().replace(/(s|ment)$/, '')] = m[2].replace(/[*_]+$/, '').trim();
  }
  if (!('agree' in fields || 'disagree' in fields)) return undefined;
  const confidence = confidenceOf(fields.confidence);
  return { position: (fields.position ?? '').slice(0, 300), ...(fields.side ? { side: fields.side.slice(0, 60) } : {}), agree: asList(fields.agree ?? ''), disagree: asList(fields.disagree ?? ''), ...(confidence !== undefined ? { confidence } : {}), parsed: true };
}

/** A turn's stance, or one guessed from its first sentence (no points, not parsed) when it gave none. `who` reads its replyTo. */
export function stanceOf(text: string, who?: (raw: string) => Speaker | undefined): Stance {
  return parseStance(text, who) ?? { position: firstSentence(stripStance(text)), agree: [], disagree: [], parsed: false };
}

/** The turn's prose without the stance block it ended with. */
export function stripStance(text: string): string {
  return text
    .replace(/```[ \t]*stance[ \t]*\n[\s\S]*?(```|$)/gi, '')
    .trim();
}

function firstSentence(text: string): string {
  const plain = text.replace(/[#*_`>]/g, '').trim();
  const m = /^[\s\S]*?[.!?](\s|$)/.exec(plain);
  return (m ? m[0] : plain).trim().slice(0, 200);
}

/** Everyone who spoke in the round agrees: each gave a stance with nothing left to disagree with. */
export function allAgree(turns: DiscussTurn[], round: number): boolean {
  const spoken = turns.filter((t) => t.round === round && t.by !== 'you' && !t.failed);
  return spoken.length >= 2 && spoken.every((t) => t.stance?.parsed && t.stance.disagree.length === 0);
}

// ---- The conclusion ----

const TRENDS: Trend[] = ['converging', 'diverging', 'stuck'];

/** The summary the starting agent wrote: a ```conclusion (or any) JSON object with these keys. `participants` in full or by key. */
export function parseConclusion(text: string, by: Speaker, participants: readonly (Participant | Speaker)[]): Conclusion | undefined {
  const who = speakerResolver(participants);
  const fenced = [...text.matchAll(FENCE)].reverse().flatMap((f) => jsonObjects(f[2]));
  for (const o of [...fenced, ...jsonObjects(text)]) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    const r = o as Record<string, unknown>;
    if (typeof r.next !== 'string' || !r.next.trim()) continue;
    const disagreed = (Array.isArray(r.disagreed) ? r.disagreed : []).flatMap((d) => {
      if (!d || typeof d !== 'object') return [];
      const x = d as Record<string, unknown>;
      const point = typeof x.point === 'string' ? x.point.trim().slice(0, 300) : '';
      const sides = (Array.isArray(x.sides) ? x.sides : []).flatMap((s) => {
        const y = (s ?? {}) as Record<string, unknown>;
        const agent = typeof y.agent === 'string' ? who(y.agent) : undefined;
        const view = typeof y.view === 'string' ? y.view.trim().slice(0, 400) : '';
        return agent && view ? [{ agent, view }] : [];
      });
      return point ? [{ point, sides }] : [];
    });
    const carry = typeof r.carryOut === 'string' ? who(r.carryOut) : undefined;
    const rounds = (Array.isArray(r.rounds) ? r.rounds : []).slice(0, 40).flatMap((x): RoundTrend[] => {
      const y = (x ?? {}) as Record<string, unknown>;
      if (typeof y.round !== 'number' || !Number.isInteger(y.round) || y.round < 1) return [];
      const trend = TRENDS.find((t) => t === y.trend);
      const on = trend && typeof y.on === 'string' ? y.on.trim().slice(0, 60) : '';
      return [{ round: y.round, ...(trend ? { trend } : {}), ...(on ? { on } : {}) }];
    });
    return {
      agreed: asList(r.agreed),
      disagreed: disagreed.slice(0, 6),
      next: r.next.trim().slice(0, 600),
      by,
      ...(carry ? { carryOut: carry } : {}),
      ...(rounds.length ? { rounds } : {}),
    };
  }
  return undefined;
}

/** FriedLiver's own summary, from each agent's last stance, when the starting agent's failed or was stopped. */
export function fallbackConclusion(d: Pick<DiscussionItem, 'participants' | 'turns' | 'ended'>): Conclusion {
  const name = namesOf(d.participants);
  const last = new Map<Speaker, Stance>();
  for (const t of d.turns) if (t.by !== 'you' && t.stance) last.set(t.by, t.stance);
  const stances = [...last.entries()];
  const seen = new Set<string>();
  const agreed: string[] = [];
  for (const [, s] of stances)
    for (const p of s.agree)
      if (!seen.has(p.toLowerCase()) && agreed.length < 6) {
        seen.add(p.toLowerCase());
        agreed.push(p);
      }
  const disagreed: Conclusion['disagreed'] = [];
  for (const [agent, s] of stances)
    for (const p of s.disagree.slice(0, 2))
      disagreed.push({ point: `${name(agent)}: ${p}`, sides: stances.filter(([, o]) => o.position).map(([a, o]) => ({ agent: a, view: o.position })) });
  const starter = d.participants[0] && speakerOf(d.participants[0]);
  const lead = starter ? last.get(starter)?.position : undefined;
  const next = !stances.length
    ? 'Nobody answered. Ask again, or start the discussion with other agents.'
    : !disagreed.length && lead
      ? `Go with ${name(starter!)}'s position: ${lead}`
      : `Decide between the positions above${d.ended === 'stopped' ? ' (you stopped the discussion)' : ''}, or continue discussing.`;
  return { agreed, disagreed: disagreed.slice(0, 6), next, by: 'friedliver', ...(starter ? { carryOut: starter } : {}) };
}

/** What the agent that carries it out is told. */
export function carryOutText(d: Pick<DiscussionItem, 'question' | 'conclusion'>): string {
  const c = d.conclusion;
  const lines = [`Carry out what the discussion concluded. Ask before anything risky, as usual.`, ``, `Question: ${d.question}`];
  if (c?.agreed.length) lines.push('', 'Agreed:', ...c.agreed.map((a) => `- ${a}`));
  if (c?.disagreed.length) lines.push('', 'Still open (use your judgement, say what you chose):', ...c.disagreed.map((x) => `- ${x.point}`));
  if (c) lines.push('', `Recommended next step: ${c.next}`);
  return lines.join('\n');
}

// ---- The chat view ----

/** Items that wait for the user, or say something went wrong: they stay in the transcript during a discussion. */
const KEPT = new Set<Item['kind']>(['permission', 'review', 'command', 'question', 'bridge', 'notice', 'discussion']);

/**
 * The transcript without the discussions' own turns: the starting agent's replies, steps and the
 * prompts FriedLiver gave it fold into the card (its transcript). Anything waiting on you stays.
 */
export function withoutDiscussionTurns(items: Item[]): Item[] {
  if (!items.some((i) => i.kind === 'discussion')) return items;
  const out: Item[] = [];
  let hide = 0;
  for (const i of items) {
    if (i.kind === 'discussion') {
      out.push(i);
      hide = i.state === 'done' ? (i.span ?? 0) : Infinity;
      continue;
    }
    if (hide > 0) {
      hide--;
      if (!KEPT.has(i.kind)) continue;
    }
    out.push(i);
  }
  return out;
}

// ---- Saved state ----

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const nat = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);

function savedStance(v: unknown, speakers: Speaker[]): Stance | undefined {
  // Kept as `re: {agent, quote}` (a speaker key); read through the same checks as an agent's replyTo/quote.
  const re = ((v ?? {}) as { re?: { agent?: unknown; quote?: unknown } }).re;
  const s = stanceFrom(v && typeof v === 'object' && re && typeof re === 'object' ? { ...v, replyTo: re.agent, quote: re.quote } : v, (raw) => speakers.find((k) => k === raw));
  return s && { ...s, parsed: (v as Record<string, unknown>).parsed === true };
}

/**
 * A discussion read back from disk, or null. One that was still going when the window closed
 * ends there, summed up by FriedLiver: nothing is running it any more.
 */
export function savedDiscussion(raw: Record<string, unknown>, itemsAfter: number): DiscussionItem | null {
  if (typeof raw.id !== 'string' || !/^[\w.:-]{1,128}$/.test(raw.id) || typeof raw.question !== 'string') return null;
  const participants: Participant[] = [];
  for (const p of Array.isArray(raw.participants) ? raw.participants : []) {
    const r = (p ?? {}) as Record<string, unknown>;
    if (!isAgentKey(r.agent)) continue;
    const model = str(r.model, 128).trim();
    const modelName = model ? str(r.modelName, 80).trim() : '';
    const one: Participant = { agent: r.agent, ...(model ? { model } : {}), ...(modelName ? { modelName } : {}), ...(typeof r.chatId === 'string' ? { chatId: r.chatId } : {}) };
    if (!participants.some((x) => speakerOf(x) === speakerOf(one))) participants.push(one);
  }
  if (participants.length < 2) return null;
  const agents = participants.map(speakerOf);
  const turns: DiscussTurn[] = (Array.isArray(raw.turns) ? raw.turns : []).slice(0, 200).flatMap((t) => {
    const r = (t ?? {}) as Record<string, unknown>;
    if (!(r.by === 'you' || (typeof r.by === 'string' && agents.includes(r.by))) || typeof r.text !== 'string') return [];
    const stance = savedStance(r.stance, agents);
    return [{ by: r.by, round: nat(r.round, 1), text: r.text.slice(0, MAX_TURN_TEXT), ...(stance ? { stance } : {}), ...(r.failed === true ? { failed: true as const } : {}) }];
  });
  const ends: DiscussEnd[] = ['agreed', 'rounds', 'budget', 'stopped', 'failed'];
  const done = raw.state === 'done';
  const c = raw.conclusion as Record<string, unknown> | undefined;
  const conclusion = c && typeof c === 'object' ? parseConclusion(JSON.stringify(c), agents[0], participants) : undefined;
  const d: DiscussionItem = {
    kind: 'discussion',
    id: raw.id,
    question: str(raw.question, 4000),
    participants,
    maxRounds: Math.min(DISCUSS_ROUNDS.max * 4, Math.max(1, nat(raw.maxRounds, DISCUSS_ROUNDS.default))),
    round: Math.max(1, nat(raw.round, 1)),
    state: 'done',
    ended: done && ends.includes(raw.ended as DiscussEnd) ? (raw.ended as DiscussEnd) : 'stopped',
    turns,
    tokens: nat(raw.tokens, 0),
    budget: nat(raw.budget, DISCUSS_BUDGET.default),
    span: done ? Math.min(nat(raw.span, 0), itemsAfter) : itemsAfter,
    ...(typeof raw.at === 'number' ? { at: raw.at } : {}),
    ...(typeof raw.carried === 'string' && agents.includes(raw.carried) ? { carried: raw.carried } : {}),
    ...(raw.continued === true ? { continued: true as const } : {}),
  };
  d.conclusion = done && conclusion ? { ...conclusion, by: c?.by === 'friedliver' ? 'friedliver' : conclusion.by } : fallbackConclusion(d);
  return d;
}

// ---- The card's words ----

/** The card's state phrase (COMPONENTS.md §2.30). */
export function discussMeta(d: DiscussionItem): string {
  if (d.continued) return 'Continued below';
  const name = namesOf(d.participants);
  if (d.state === 'running') return `Round ${d.round} of ${d.maxRounds}${d.speaking ? ` · ${name(d.speaking)} is speaking` : ''}`;
  if (d.state === 'summarizing') return `Summing up · ${name(speakerOf(d.participants[0]))}`;
  const rounds = `${d.round} round${d.round === 1 ? '' : 's'}`;
  switch (d.ended) {
    case 'agreed':
      return `Agreed after ${rounds}`;
    case 'budget':
      return 'Token budget reached';
    case 'stopped':
      return 'Stopped';
    case 'failed':
      return 'Too few answers';
    default:
      return `Still split after ${rounds}`;
  }
}

/** The chat header's status while this chat's discussion runs: another agent may be speaking after the starter's turn ended. */
export function discussingLabel(items: Item[]): string | undefined {
  const d = items.findLast((i): i is DiscussionItem => i.kind === 'discussion');
  if (!d || d.continued || d.state === 'done') return undefined;
  const name = namesOf(d.participants);
  if (d.state === 'summarizing') return `Discussing · ${name(speakerOf(d.participants[0]))} summing up`;
  return d.speaking ? `Discussing · ${name(d.speaking)} speaking` : 'Discussing';
}

/** How far it got, 0..1: turns spoken of all the rounds' turns. */
export function discussProgress(d: DiscussionItem): number {
  if (d.state !== 'running') return 1;
  const spoken = d.turns.filter((t) => t.by !== 'you').length;
  return Math.min(1, spoken / Math.max(1, d.maxRounds * d.participants.length));
}
