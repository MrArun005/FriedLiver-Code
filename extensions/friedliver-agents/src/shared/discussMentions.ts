// /discuss's @mentions: agents (@claude), models (@opus, @gpt-5.6-terra) and agent+model pairs
// (@claude/opus, @codex:gpt-5.6-luna), anywhere in the question and in any order. Models resolve
// against the models each agent reported (ids and display names); the composer's suggestions come
// from the same list. No I/O, so the webview, the host and the tests share it.
import { agentFace, mentioned, mentionWords, type AgentKey } from './model';
import { baseModel, byCategory, type ChatSession, type OptionChoice, type SessionOption } from './session';

/** Each agent's models as its sessions reported them. */
export type ModelCatalog = Partial<Record<AgentKey, OptionChoice[]>>;

/** Who a mention names: an agent on the model it starts with, or on `model` (an id the agent reported). */
export interface Who {
  agent: AgentKey;
  model?: string;
}

/** An @word in the text: `at` is the @'s index, `end` the index after the word. */
export interface Mention {
  at: number;
  end: number;
  word: string;
}

/** A way to settle a mention: what it inserts after the @, its full name ("Claude · Opus 4.5") and its own ("Opus 4.5"). */
export interface Choice extends Who {
  insert: string;
  label: string;
  name: string;
}

export type MentionProblem =
  /** It fits more than one model (or agent's model): the picker asks which. */
  | { kind: 'ambiguous'; mention: Mention; options: Choice[] }
  /** Nothing has that name; `suggestions` are the nearest names. */
  | { kind: 'unknown'; mention: Mention; suggestions: Choice[] };

export type Resolution = { ok: Who } | { ambiguous: Who[] } | { unknown: Who[] };

/** The catalog from the agents' cached options and every chat's session (the freshest list wins nothing: they merge). */
export function modelCatalog(defaults: Partial<Record<AgentKey, { options: SessionOption[] }>>, chats: { agent: AgentKey; session?: ChatSession }[]): ModelCatalog {
  const out: ModelCatalog = {};
  const add = (agent: AgentKey, o: SessionOption | undefined) => {
    if (!o || o.type !== 'select') return;
    const list = (out[agent] ??= []);
    for (const c of o.choices) if (!list.some((x) => x.value === c.value)) list.push(c);
  };
  for (const [agent, d] of Object.entries(defaults) as [AgentKey, { options: SessionOption[] }][]) add(agent, d?.options.find((o) => o.category === 'model'));
  for (const c of chats) add(c.agent, byCategory(c.session, 'model'));
  return out;
}

/** The model a chat's session is on now, if it reports one. */
export function currentModel(session: ChatSession | undefined): string | undefined {
  const o = byCategory(session, 'model');
  return o && typeof o.current === 'string' && o.current ? o.current : undefined;
}

/** Two ids for the same model ("opus" and "opus[1m]" are not; an id and itself with a context suffix are). */
export const sameModel = (a: string | undefined, b: string | undefined): boolean => !!a && !!b && (a === b || baseModel(a) === baseModel(b));

// ---- Finding them ----

/**
 * The text with code (fences, `spans`) and URLs blanked to spaces, same length: an @ in them is no mention.
 * An unclosed fence runs to the end.
 */
function quieted(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  return text
    .replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/\b[a-z][\w+.-]*:\/\/\S+|\bwww\.\S+/gi, blank);
}

/** An @ after the start, a space or an opening bracket/quote/comma (never inside a word: emails), then a name. */
const MENTION = /(^|[\s([{,;"'])@([A-Za-z][\w.-]*(?:[/:][\w.\-[\]/:+]+)?)/g;

/** The @mentions in `text` from index `from`, in order. */
export function scanMentions(text: string, from = 0): Mention[] {
  const plain = quieted(text);
  const out: Mention[] = [];
  MENTION.lastIndex = from;
  for (let m = MENTION.exec(plain); m; m = MENTION.exec(plain)) {
    if (m.index + m[1].length < from) continue;
    // A sentence's full stop or a dash after it isn't part of the name.
    const word = m[2].replace(/[.\-:]+$/, '');
    const at = m.index + m[1].length;
    out.push({ at, end: at + 1 + word.length, word });
  }
  return out;
}

// ---- Resolving them ----

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
/** The numbers in a model's id, to find the newest of a family: "claude-opus-4-5" → [4, 5]. */
const version = (c: OptionChoice) => (norm(c.value).match(/\d+/g) ?? []).map(Number);

function newer(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

/** Of several models one query fits, the newest when exactly one is newest; else all of them. */
function newestOf(list: OptionChoice[]): OptionChoice[] {
  if (list.length < 2) return list;
  const sorted = [...list].sort((a, b) => newer(version(b), version(a)));
  return newer(version(sorted[0]), version(sorted[1])) > 0 ? [sorted[0]] : list;
}

function fits(query: string, choices: OptionChoice[]): { exact: OptionChoice[]; loose: OptionChoice[] } {
  const q = norm(query);
  if (!q) return { exact: [], loose: [] };
  return {
    exact: choices.filter((c) => [c.value, baseModel(c.value), c.name].some((x) => norm(x) === q)),
    // A prefix of the id or the name, from the start or a word's start: "opus" fits "claude-opus-4-5" and "Opus 4.5".
    loose: choices.filter((c) => [c.value, c.name].some((x) => `-${norm(x)}`.includes(`-${q}`))),
  };
}

/** Edits from a to b, a swap of two neighbours counting as one ("opsu" is 1 from "opus"). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

/**
 * What `word` (the text after an @) names. An agent's name or alias wins; "agent/model" or "agent:model"
 * looks only at that agent's models; anything else is a model of any agent: an exact id or name first,
 * else a prefix ("opus" → the newest Opus that agent offers). More than one agent fitting is ambiguous.
 */
export function resolveMention(word: string, catalog: ModelCatalog): Resolution {
  const agent = mentioned(word);
  if (agent) return { ok: { agent } };
  const pair = /^([a-z][a-z0-9]*)[/:](.+)$/i.exec(word);
  const scoped = pair ? mentioned(pair[1]) : undefined;
  const query = scoped ? pair![2] : word;
  const pool = (scoped ? [[scoped, catalog[scoped] ?? []]] : Object.entries(catalog)) as [AgentKey, OptionChoice[]][];
  const exact = pool.map(([a, cs]) => [a, fits(query, cs).exact] as const).filter(([, cs]) => cs.length);
  const found = exact.length ? exact : pool.map(([a, cs]) => [a, fits(query, cs).loose] as const).filter(([, cs]) => cs.length);
  const options = found.flatMap(([a, cs]) => newestOf(cs).map((c) => ({ agent: a, model: c.value })));
  if (options.length === 1) return { ok: options[0] };
  if (options.length) return { ambiguous: options };
  // The nearest names: agents' (unless the agent was given) and models', a few typos away at most,
  // whole or from a word's start ("opsu" is near the "opus" in "claude-opus-4-5").
  const q = norm(query);
  const near: { who: Who; d: number; whole: number }[] = [];
  const score = (who: Who, names: string[]) => {
    const all = names.map(norm);
    const d = Math.min(...all.flatMap((x) => [x, ...[...x.matchAll(/-(?=[a-z])/g)].map((m) => x.slice(m.index + 1))].map((p) => Math.min(distance(q, p), distance(q, p.slice(0, q.length))))));
    near.push({ who, d, whole: Math.min(...all.map((x) => distance(q, x))) });
  };
  if (!scoped) for (const [w, a] of mentionWords()) score({ agent: a }, [w]);
  for (const [a, cs] of pool) for (const c of cs) score({ agent: a, model: c.value }, [c.value, c.name]);
  const max = Math.max(2, Math.floor(q.length / 3));
  const seen = new Set<string>();
  const unknown = near
    .filter((n) => n.d <= max)
    .sort((a, b) => a.d - b.d || a.whole - b.whole)
    .map((n) => n.who)
    .filter((w) => !seen.has(keyOf(w)) && !!seen.add(keyOf(w)))
    .slice(0, 3);
  return { unknown };
}

const keyOf = (w: Who) => (w.model ? `${w.agent}/${w.model}` : w.agent);

/**
 * What to type after the @ for `who`: the shortest of its family's name ("opus", when that is the newest
 * Opus), its name ("opus-4.1"), its id, that names it alone; else agent/id.
 */
export function insertFor(who: Who, catalog: ModelCatalog): string {
  if (!who.model) return who.agent;
  const name = norm(modelLabel(who.agent, catalog[who.agent]?.find((c) => c.value === who.model)?.name ?? ''));
  const words = [name.split('-')[0], name, who.model].filter((w) => /^[a-z][\w.-]*$/i.test(w));
  for (const word of [...words, `${who.agent}/${who.model}`]) {
    const r = resolveMention(word, catalog);
    if ('ok' in r && r.ok.agent === who.agent && r.ok.model === who.model) return word;
  }
  return `${who.agent}/${who.model}`;
}

/** A model's display name without its agent's name in front ("Gemini 3.1 Pro" → "3.1 Pro" under Gemini). */
export function modelLabel(agent: AgentKey, name: string): string {
  const brand = agentFace(agent)?.name ?? '';
  const rest = brand && name.toLowerCase().startsWith(`${brand.toLowerCase()} `) ? name.slice(brand.length).trim() : name;
  return rest || name;
}

/** "Claude · Opus 4.5", or "Claude" for an agent on its default model. */
export function whoLabel(who: Who, catalog: ModelCatalog): string {
  const agent = agentFace(who.agent)?.name ?? who.agent;
  if (!who.model) return agent;
  const name = catalog[who.agent]?.find((c) => c.value === who.model)?.name ?? who.model;
  return `${agent} · ${modelLabel(who.agent, name)}`;
}

export function choiceOf(who: Who, catalog: ModelCatalog): Choice {
  const label = whoLabel(who, catalog);
  return { ...who, insert: insertFor(who, catalog), label, name: who.model ? label.slice(label.indexOf(' · ') + 3) : label };
}

// ---- The question without them ----

/**
 * The text with the mentions taken out and the gaps tidied: a list of them ("@gemini, @codex and @opus:")
 * goes as one, with the comma or colon after it; the spaces around close up. Code is left as it is.
 */
export function withoutMentions(text: string, mentions: Mention[]): string {
  const runs: { at: number; end: number }[] = [];
  for (const m of mentions) {
    const last = runs.at(-1);
    if (last && /^[\s,;&]*(?:and\s+)?$/i.test(text.slice(last.end, m.at))) last.end = m.end;
    else runs.push({ at: m.at, end: m.end });
  }
  let out = text;
  for (const r of runs.reverse()) {
    const end = r.end + (/^[,;:]/.test(out.slice(r.end)) ? 1 : 0);
    const right = out.slice(end).replace(/^[ \t]+/, '');
    // "faster, @gemini?" → "faster?": a list comma before it goes when the sentence ends right after.
    const left = out
      .slice(0, r.at)
      .replace(/[ \t]+$/, '')
      .replace(/[,;]+$/, (c) => (!right || /^[\n?.!,;:]/.test(right) ? '' : c));
    const gap = left && right && !/\n$/.test(left) && !/^[\n?.!,;:)\]]/.test(right) ? ' ' : '';
    out = left + gap + right;
  }
  return out.replace(/^[\s:,;\-–—]+/, '').trimEnd();
}

// ---- The composer's suggestions ----

/** The @word the caret is in after "/discuss", with the text typed so far; null when there is none. */
export function discussMentionAt(text: string, caret: number): (Mention & { query: string }) | null {
  const head = /^\s*\/discuss\b/i.exec(text);
  if (!head || caret <= head[0].length) return null;
  const plain = quieted(text);
  // From the @ before the caret: it must be one scanMentions would read, or a bare @ just typed.
  const at = plain.lastIndexOf('@', caret - 1);
  if (at < head[0].length || (at > 0 && !/[\s([{,;"']/.test(plain[at - 1]))) return null;
  const typed = plain.slice(at + 1, caret);
  if (!/^(?:[A-Za-z][\w.-]*(?:[/:][\w.\-[\]/:+]*)?)?$/.test(typed)) return null;
  const rest = /^[\w.\-[\]/:+]*/.exec(plain.slice(caret))![0];
  return { at, end: caret + rest.length, word: typed + rest, query: typed };
}

/**
 * What the menu offers for `query`, grouped by agent in `agents`' order: the agent and all its models
 * when its name fits, else the models that fit; "agent/…" narrows to that agent's models.
 */
export function mentionSuggestions(query: string, catalog: ModelCatalog, agents: readonly AgentKey[], max = 40): Choice[] {
  const q = query.toLowerCase();
  const pair = /^([a-z][a-z0-9]*)[/:](.*)$/.exec(q);
  const scoped = pair ? mentioned(pair[1]) : undefined;
  const out: Choice[] = [];
  for (const agent of agents) {
    if (pair && scoped !== agent) continue;
    const words = mentionWords()
      .filter(([, a]) => a === agent)
      .map(([w]) => w);
    const named = !pair && words.some((w) => w.startsWith(q));
    const models = catalog[agent] ?? [];
    const mq = pair ? pair[2] : q;
    const shown = named || !mq ? models : models.filter((c) => `-${norm(c.value)}`.includes(`-${norm(mq)}`) || `-${norm(c.name)}`.includes(`-${norm(mq)}`));
    if (named || (pair && !mq)) out.push(choiceOf({ agent }, catalog));
    for (const c of shown) out.push(choiceOf({ agent, model: c.value }, catalog));
  }
  return out.slice(0, max);
}

/** Puts `insert` in place of the mention at `m`, with one space after it; the caret goes after the space. */
export function applyDiscussMention(text: string, m: Pick<Mention, 'at' | 'end'>, insert: string): { text: string; caret: number } {
  const after = text.slice(m.end);
  const head = `${text.slice(0, m.at)}@${insert}${/^\s/.test(after) ? '' : ' '}`;
  return { text: head + after, caret: head.length + (/^\s/.test(after) ? 1 : 0) };
}
