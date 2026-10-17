// What a chat's agent session offers and reports (ACP config options, modes,
// models, slash commands, usage), and how FriedLiver's approval levels map onto
// each agent's own modes. Pure, so the host and the webviews agree.
import type * as acp from '@agentclientprotocol/sdk';
import type { AgentKey } from './model';

/** FriedLiver's own say over what an agent may do without asking, per chat. */
export type ApprovalLevel = 'ask' | 'edits' | 'full';
export const APPROVAL_LEVELS: ApprovalLevel[] = ['ask', 'edits', 'full'];
export const APPROVAL_NAMES: Record<ApprovalLevel, string> = { ask: 'Ask', edits: 'Auto-accept edits', full: 'Full auto' };
export const APPROVAL_HINTS: Record<ApprovalLevel, string> = {
  ask: 'Edits and commands wait for you',
  edits: 'Edits go through on their own; commands wait for you',
  full: 'Edits and commands go through without asking',
};

export function isApprovalLevel(v: unknown): v is ApprovalLevel {
  return v === 'ask' || v === 'edits' || v === 'full';
}

export interface OptionChoice {
  value: string;
  name: string;
  description?: string;
  /** The agent's group name, e.g. a model family. */
  group?: string;
}

/**
 * One of the session's settings: an ACP config option, or one FriedLiver made
 * from the older `modes` or Gemini's `models`. `via` says how it is set.
 */
export interface SessionOption {
  id: string;
  name: string;
  description?: string;
  /** mode, model, model_config, thought_level, or the agent's own. */
  category?: string;
  type: 'select' | 'boolean';
  current: string | boolean;
  choices: OptionChoice[];
  via: 'option' | 'mode' | 'model';
}

export interface SlashCommand {
  name: string;
  description: string;
  /** What to type after the command, e.g. "file to review". */
  hint?: string;
}

export interface Usage {
  /** Tokens in the context now, and how many fit. */
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
}

export interface ChatSession {
  /** In the agent's order, which is its priority order. */
  options: SessionOption[];
  commands: SlashCommand[];
  usage?: Usage;
  /** A message can join the running turn instead of waiting for it to end. */
  steering?: boolean;
  /** False for a session from an earlier window: its agent starts again with the next message. */
  live: boolean;
  /** The agent is starting this session now, before the chat's first message. */
  starting?: boolean;
  /** The adapter's name and version, from `initialize`. */
  agent?: { name: string; version: string };
  /** The shared rules files this session got when it started (sharedRules.ts). */
  rules?: string[];
}

const MAX_OPTIONS = 32;
const MAX_CHOICES = 200;
const MAX_COMMANDS = 200;
const MAX_TEXT = 300;

const text = (v: unknown, max = MAX_TEXT): string | undefined => (typeof v === 'string' && v ? (v.length > max ? `${v.slice(0, max - 1)}…` : v) : undefined);

function choicesOf(raw: unknown): OptionChoice[] {
  if (!Array.isArray(raw)) return [];
  const out: OptionChoice[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_CHOICES || !entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (Array.isArray(e.options)) {
      const group = text(e.name) ?? text(e.group);
      for (const o of choicesOf(e.options)) if (out.length < MAX_CHOICES) out.push({ ...o, group });
    } else if (typeof e.value === 'string' && e.value) {
      out.push({ value: e.value, name: text(e.name) ?? e.value, description: text(e.description) });
    }
  }
  return out;
}

function fromConfigOption(o: acp.SessionConfigOption): SessionOption | null {
  if (!o || typeof o.id !== 'string' || !o.id) return null;
  const base = { id: o.id, name: text(o.name) ?? o.id, description: text(o.description), category: text(o.category ?? undefined, 64), via: 'option' as const };
  if (o.type === 'boolean') return typeof o.currentValue === 'boolean' ? { ...base, type: 'boolean', current: o.currentValue, choices: [] } : null;
  if (o.type !== 'select' || typeof o.currentValue !== 'string') return null;
  return { ...base, type: 'select', current: o.currentValue, choices: choicesOf(o.options) };
}

export interface SessionSetupLike {
  configOptions?: acp.SessionConfigOption[] | null;
  modes?: acp.SessionModeState | null;
  models?: { currentModelId: string; availableModels: { modelId: string; name: string; description?: string | null }[] } | null;
}

/** Older-API settings as options: modes when no config option is a mode, Gemini's models when none is a model. */
function legacyOptions(setup: SessionSetupLike, options: SessionOption[]): SessionOption[] {
  const out: SessionOption[] = [];
  if (setup.modes && !options.some((o) => o.category === 'mode') && Array.isArray(setup.modes.availableModes)) {
    out.push({
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      current: String(setup.modes.currentModeId),
      choices: setup.modes.availableModes.slice(0, MAX_CHOICES).map((m) => ({ value: String(m.id), name: text(m.name) ?? String(m.id), description: text(m.description) })),
      via: 'mode',
    });
  }
  if (setup.models && !options.some((o) => o.category === 'model') && Array.isArray(setup.models.availableModels)) {
    out.push({
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      current: String(setup.models.currentModelId),
      choices: setup.models.availableModels.slice(0, MAX_CHOICES).map((m) => ({ value: String(m.modelId), name: text(m.name) ?? String(m.modelId), description: text(m.description) })),
      via: 'model',
    });
  }
  return out;
}

/**
 * The settings a session offers, as one list. Config options supersede modes
 * (ACP), so `modes` and `models` only fill in what the options don't cover.
 */
export function sessionOptions(setup: SessionSetupLike): SessionOption[] {
  const options = (Array.isArray(setup.configOptions) ? setup.configOptions : []).map(fromConfigOption).filter((o): o is SessionOption => o !== null);
  return [...legacyOptions(setup, options), ...options].slice(0, MAX_OPTIONS);
}

function commandsOf(list: acp.AvailableCommand[]): SlashCommand[] {
  return (Array.isArray(list) ? list : [])
    .filter((c) => c && typeof c.name === 'string' && /^[\w:.\-/]{1,80}$/.test(c.name))
    .slice(0, MAX_COMMANDS)
    .map((c) => ({ name: c.name.replace(/^\//, ''), description: text(c.description) ?? '', hint: text(c.input?.hint) }));
}

const SESSION_UPDATES = new Set(['config_option_update', 'current_mode_update', 'available_commands_update', 'usage_update']);

/** Updates that change the session, not the transcript. */
export function isSessionUpdate(update: acp.SessionUpdate): boolean {
  return SESSION_UPDATES.has(update.sessionUpdate);
}

export const EMPTY_SESSION: ChatSession = { options: [], commands: [], live: true };

/** Folds a session update (see isSessionUpdate) into the chat's session. */
export function applySessionUpdate(session: ChatSession | undefined, update: acp.SessionUpdate): ChatSession {
  const s = session ?? EMPTY_SESSION;
  switch (update.sessionUpdate) {
    case 'config_option_update': {
      const options = sessionOptions({ configOptions: update.configOptions });
      // Settings FriedLiver made from modes or models stay unless the options now cover them.
      const kept = s.options.filter((o) => o.via !== 'option' && !options.some((n) => n.category === o.category));
      return { ...s, options: [...kept, ...options].slice(0, MAX_OPTIONS) };
    }
    case 'current_mode_update':
      return { ...s, options: s.options.map((o) => (o.category === 'mode' && o.type === 'select' ? { ...o, current: String(update.currentModeId) } : o)) };
    case 'available_commands_update':
      return { ...s, commands: commandsOf(update.availableCommands) };
    case 'usage_update': {
      const used = Number(update.used);
      const size = Number(update.size);
      if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return s;
      const cost = update.cost && Number.isFinite(update.cost.amount) && typeof update.cost.currency === 'string' ? { amount: update.cost.amount, currency: update.cost.currency.slice(0, 8) } : undefined;
      return { ...s, usage: { used: Math.max(0, used), size, ...(cost ? { cost } : {}) } };
    }
    default:
      return s;
  }
}

// ---- Options by what they are ----

export const byCategory = (session: ChatSession | undefined, category: string) => session?.options.find((o) => o.category === category);

/** The session's mode setting: the agent's permission mode. */
export const modeOption = (session: ChatSession | undefined) => byCategory(session, 'mode');

/** Model, then effort ("thought_level"), then the model's switches such as Fast mode, then anything else. */
export function optionGroups(session: ChatSession | undefined): { model?: SessionOption; effort?: SessionOption; modelConfig: SessionOption[]; other: SessionOption[] } {
  const options = session?.options ?? [];
  const known = new Set(['mode', 'model', 'thought_level', 'model_config']);
  const plan = planToggle(session);
  return {
    model: options.find((o) => o.category === 'model'),
    effort: options.find((o) => o.category === 'thought_level'),
    modelConfig: options.filter((o) => o.category === 'model_config'),
    other: options.filter((o) => !known.has(o.category ?? '') && o !== plan?.option),
  };
}

/**
 * What remembers a choice for the agent's next sessions: the category for the
 * settings every agent shares (model, effort), the option's id for the rest.
 */
export function optionKey(o: Pick<SessionOption, 'id' | 'category'>): string {
  return o.category === 'model' || o.category === 'thought_level' ? o.category : `id:${o.id}`;
}

export function findByKey(session: ChatSession | undefined, key: string): SessionOption | undefined {
  return session?.options.find((o) => optionKey(o) === key);
}

/** A value the option offers. */
export function offers(o: SessionOption, value: string | boolean): boolean {
  if (o.type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'string' && o.choices.some((c) => c.value === value);
}

export function choiceName(o: SessionOption | undefined, value = o?.current): string | undefined {
  if (!o) return undefined;
  if (o.type === 'boolean') return value ? 'On' : 'Off';
  return o.choices.find((c) => c.value === value)?.name ?? (typeof value === 'string' ? value : undefined);
}

// ---- Modes ----

/**
 * What a mode lets the agent do, read from its id, name and description:
 * ask (asks first), edits (edits without asking), plan, auto (the agent
 * decides when to ask), full (never asks).
 */
export type ModeClass = 'ask' | 'edits' | 'plan' | 'auto' | 'full';

export function modeClass(c: Pick<OptionChoice, 'value' | 'name' | 'description'>): ModeClass | undefined {
  const all = `${c.value} ${c.name} ${c.description ?? ''}`;
  if (/bypass|full[ -]?access|\byolo\b|danger|never asks|accepts all|auto-approves all|unrestricted/i.test(all)) return 'full';
  if (/\bplan\b/i.test(`${c.value} ${c.name}`)) return 'plan';
  if (/auto[ -]?review|handles permission|potentially unsafe|^auto$/i.test(c.value) || /auto[ -]?review|handles permission|potentially unsafe/i.test(all) || /^auto$/i.test(c.name)) return 'auto';
  if (/accept[ -]?edits|auto[ -]?edit|workspace[ -]?(write|access)|edit (workspace )?files without|auto-approves edit/i.test(all)) return 'edits';
  if (/^(default|manual|ask|read-?only)$/i.test(c.value) || /^(default|manual|ask|read-?only)$/i.test(c.name) || /always ask|prompts for approval|requires approval|asks before/i.test(all)) return 'ask';
  return undefined;
}

/** How loud a reported mode is: escalated modes get color, so they can't go unseen. */
export const MODE_TONE: Record<ModeClass, 'quiet' | 'edits' | 'plan' | 'auto' | 'full'> = { ask: 'quiet', edits: 'edits', plan: 'plan', auto: 'auto', full: 'full' };

/**
 * The mode ids the current adapters advertise for FriedLiver's levels
 * (claude-agent-acp 0.93, codex-acp 2.2, gemini-cli 0.64). Only a tie-breaker:
 * modes are matched by what they say they do (modeClass) when an id is missing.
 */
const KNOWN_MODES: Partial<Record<AgentKey, Partial<Record<ApprovalLevel | 'plan', string[]>>>> = {
  claude: { ask: ['default'], edits: ['acceptEdits'], full: ['bypassPermissions', 'auto'], plan: ['plan'] },
  codex: { ask: ['read-only'], edits: ['workspace-write'], full: ['agent-full-access'] },
  // Gemini writes through FriedLiver, which shows each write as a diff to accept, so Ask
  // uses Auto Edit: one decision per edit, not Gemini's question and then the diff. Shell commands still ask.
  gemini: { ask: ['autoEdit'], edits: ['autoEdit'], full: ['yolo'], plan: ['plan'] },
};

/** Fallback order when no mode matches a level exactly. */
const LEVEL_CLASSES: Record<ApprovalLevel | 'plan', ModeClass[]> = { ask: ['ask'], edits: ['edits'], full: ['full', 'auto', 'edits'], plan: ['plan'] };

/** The agent's mode for a FriedLiver level, or undefined when it has none that fits. */
export function modeFor(agent: AgentKey, option: SessionOption | undefined, level: ApprovalLevel | 'plan'): string | undefined {
  if (!option || option.type !== 'select') return undefined;
  for (const id of KNOWN_MODES[agent]?.[level] ?? []) if (option.choices.some((c) => c.value === id)) return id;
  for (const cls of LEVEL_CLASSES[level]) {
    const hit = option.choices.find((c) => modeClass(c) === cls);
    if (hit) return hit.value;
  }
  return undefined;
}

/** The FriedLiver level an agent mode amounts to: plan and unknown modes have none. */
export function levelOfMode(agent: AgentKey, option: SessionOption | undefined, value: string): ApprovalLevel | undefined {
  const choice = option?.choices.find((c) => c.value === value);
  if (!choice) return undefined;
  for (const level of APPROVAL_LEVELS) if (KNOWN_MODES[agent]?.[level]?.[0] === value) return level;
  const cls = modeClass(choice);
  return cls === 'ask' || cls === 'edits' || cls === 'full' ? cls : cls === 'auto' ? 'full' : undefined;
}

/**
 * How the agent plans: a Plan entry in its modes (Claude, Gemini, the Demo), or
 * a separate option with a plan value (Codex's collaboration mode).
 */
export function planToggle(session: ChatSession | undefined): { option: SessionOption; on: string; off?: string } | undefined {
  const mode = modeOption(session);
  const inModes = mode?.type === 'select' ? mode.choices.find((c) => modeClass(c) === 'plan') : undefined;
  if (mode && inModes) return { option: mode, on: inModes.value };
  for (const o of session?.options ?? []) {
    if (o.type !== 'select' || o.category === 'mode' || !/collaboration|plan/i.test(`${o.id} ${o.category ?? ''}`)) continue;
    const on = o.choices.find((c) => /\bplan\b/i.test(`${c.value} ${c.name}`));
    const off = o.choices.find((c) => c !== on);
    if (on) return { option: o, on: on.value, off: off?.value };
  }
  return undefined;
}

export function planning(session: ChatSession | undefined): boolean {
  const plan = planToggle(session);
  return !!plan && plan.option.current === plan.on;
}

/** The mode the agent reports, and how loud it reads. */
export function reportedMode(session: ChatSession | undefined): { name: string; tone: (typeof MODE_TONE)[ModeClass]; cls?: ModeClass } | undefined {
  const mode = modeOption(session);
  if (!mode || mode.type !== 'select') return undefined;
  const choice = mode.choices.find((c) => c.value === mode.current);
  const cls = choice ? modeClass(choice) : undefined;
  return { name: choice?.name ?? String(mode.current), tone: cls ? MODE_TONE[cls] : 'quiet', cls };
}

const PERMISSIVE: Record<ModeClass, number> = { ask: 0, plan: 0, edits: 1, auto: 2, full: 3 };

/**
 * The agent's own mode when it is more permissive than FriedLiver's level (it
 * won't ask where the level says it would), so the mode button can't read
 * "Manual" while the agent bypasses permissions.
 */
export function agentOverride(level: ApprovalLevel, session: ChatSession | undefined): { name: string; tone: 'auto' | 'full'; cls: ModeClass } | undefined {
  const r = reportedMode(session);
  if (!r?.cls || (r.tone !== 'auto' && r.tone !== 'full')) return undefined;
  return PERMISSIVE[r.cls] > PERMISSIVE[level === 'ask' ? 'ask' : level === 'edits' ? 'edits' : 'full'] ? { name: r.name, tone: r.tone, cls: r.cls } : undefined;
}

/** What a new chat with an agent starts from: its last known options, and the user's last choices. */
export interface AgentDefaults {
  /** The options the agent's last session offered, so pickers show before a session starts. */
  options: SessionOption[];
  /** The commands the agent's last session offered, so "/" works before a session starts. */
  commands?: SlashCommand[];
  /** The user's last choice per optionKey. */
  chosen: Record<string, string | boolean>;
  /** Last level chosen for this agent; never Full auto. */
  approval?: Exclude<ApprovalLevel, 'full'>;
}

/** Shift+Tab, as in Claude Code: Ask → Auto-accept edits → Plan → Ask. Full auto is never one key away. */
export function nextInCycle(level: ApprovalLevel, session: ChatSession | undefined): { approval: ApprovalLevel } | { plan: true } {
  if (planning(session)) return { approval: 'ask' };
  if (level === 'ask') return { approval: 'edits' };
  if (level === 'edits' && planToggle(session)) return { plan: true };
  return { approval: 'ask' };
}

// ---- Usage ----

export function usagePercent(u: Usage): number {
  return Math.max(0, Math.min(100, Math.round((u.used / u.size) * 100)));
}

/**
 * Turns left before the context fills, from how much it grew per turn over the
 * last (up to) 5 turns: `samples` are the tokens used after each finished turn,
 * oldest first. Growth, not the total, so the fixed system prompt and tools
 * don't count. undefined below 2 samples; '>50' past 50. An estimate.
 */
export function turnsLeft(samples: number[], size: number): number | '>50' | undefined {
  if (samples.length < 2) return undefined;
  const recent = samples.slice(-6);
  const now = recent[recent.length - 1];
  const growth = (now - recent[0]) / (recent.length - 1);
  if (growth <= 0) return '>50';
  const left = Math.max(0, Math.round((size - now) / growth));
  return left > 50 ? '>50' : left;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Number((n / 1000).toFixed(1))}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatCost(c: NonNullable<Usage['cost']>): string {
  const amount = c.amount < 0.01 ? c.amount.toFixed(3) : c.amount.toFixed(2);
  return c.currency === 'USD' ? `$${amount}` : `${amount} ${c.currency}`;
}

// ---- Slash commands ----

/** The command being typed: "/" at the very start, before any space. */
export function slashQuery(textValue: string, caret: number): string | null {
  const m = /^\/([\w:.\-/]*)$/.exec(textValue.slice(0, caret));
  return m && !textValue.slice(caret).match(/^\S/) ? m[1] : null;
}

export function slashOptions(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = commands.filter((c) => !starts.includes(c) && c.name.toLowerCase().includes(q));
  return [...starts, ...contains];
}

// ---- "#" file references ----

/** The file being named: "#" after a space or at the start, up to the caret. */
export function hashQuery(textValue: string, caret: number): { query: string; start: number } | null {
  const before = textValue.slice(0, caret);
  const m = /(^|\s)#([\w./@+-]*)$/.exec(before);
  if (!m || textValue.slice(caret).match(/^[\w./@+-]/)) return null;
  return { query: m[2], start: before.length - m[2].length - 1 };
}

/** The text with "#query" replaced by "#path ". */
export function applyFile(textValue: string, at: { query: string; start: number }, file: string): { text: string; caret: number } {
  const insert = `#${file} `;
  const text = textValue.slice(0, at.start) + insert + textValue.slice(at.start + 1 + at.query.length);
  return { text, caret: at.start + insert.length };
}

/**
 * The most restrictive setting an agent advertises, for a read-only chat: a
 * "read-only" choice (Codex's preset) before a "plan" one (Claude, Gemini),
 * found by id or name in its mode-like options. Undefined when it offers none.
 */
export function readOnlyChoice(options: SessionOption[]): { option: SessionOption; value: string } | undefined {
  const modeLike = options.filter((o) => o.type === 'select' && (o.category === 'mode' || /\bmode\b|_mode\b|approval|sandbox|preset|permission/i.test(`${o.id} ${o.name}`)));
  for (const re of [/read[-_ ]?only/i, /\bplan\b/i]) {
    for (const o of modeLike) {
      const c = o.choices.find((ch) => re.test(ch.value) || re.test(ch.name));
      if (c) return { option: o, value: c.value };
    }
  }
  return undefined;
}

/** Claude's adapter (claude-agent-acp): no built-in tools at all, and the risky ones named as disallowed too. */
export const CLAUDE_READ_ONLY_META = {
  claudeCode: { options: { tools: [], disallowedTools: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch'] } },
};
