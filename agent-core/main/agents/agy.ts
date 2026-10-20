// Google's Antigravity CLI (`agy`) as an ACP agent: the pure half of agyAcp.ts.
//
// agy has no ACP mode (1.4.3: no --acp flag, no acp subcommand). It does have a documented
// headless mode (https://antigravity.google/docs/cli/headless/): `--output-format stream-json`
// prints NDJSON events (init, step_update…, result) and `--input-format stream-json` reads the
// prompt as {"event":"user",…} on stdin, so a prompt never sits in the process list. Headless
// agy can't stop to ask for approval: a tool that needs one is refused. So FriedLiver's levels
// become agy's own flags per turn (agyModeArgs), and Manual runs nothing. agy has no mode that
// enforces read only (its plan mode is an instruction, not a block), so none is offered.
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface AgyChoice {
  value: string;
  name: string;
  description?: string;
}

/** Why Manual runs nothing. */
export const MANUAL_REFUSAL =
  'Antigravity can’t ask before it edits or runs a command, so FriedLiver doesn’t run it in Manual. Switch this chat to Edit automatically (it edits files; commands are refused) or Auto.';

/**
 * FriedLiver's levels as agy runs them. Names and descriptions say what each does, so
 * FriedLiver's modeClass reads them right: manual is Manual, accept-edits is Edit
 * automatically, full is Auto. Nothing here reads as read-only or plan (readOnlyChoice).
 */
export const AGY_MODES: AgyChoice[] = [
  { value: 'manual', name: 'Manual', description: 'Runs nothing: agy can’t stop to ask inside FriedLiver' },
  { value: 'accept-edits', name: 'Accept edits', description: 'Edits files without asking; commands are refused unless allowed in agy’s own settings' },
  { value: 'full', name: 'Full access', description: 'Auto-approves all tool requests: edits and commands' },
];
export type AgyMode = 'manual' | 'accept-edits' | 'full';
export const isAgyMode = (v: unknown): v is AgyMode => AGY_MODES.some((m) => m.value === v);

/** The agy config folders it reads at a workspace's root (agy 1.4.3 docs: `.agents/`, or `.agent/`, `_agents/`, `_agent/`). */
const AGENT_DIRS = ['.agents', '.agent', '_agents', '_agent'];
/** In them, what can start programs or change agy's settings: MCP servers, hooks, plugins, settings. Rules, skills and workflows are text. */
const RISKY = ['mcp_config.json', 'hooks.json', 'plugins', 'settings.json'];

/**
 * A repository's agy config that could run code or change what agy may do, in `cwd` or a parent
 * up to the repository root. agy has no flag to ignore it, so FriedLiver won't start agy there.
 */
export function workspaceConfig(cwd: string): string[] {
  const found: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    for (const d of AGENT_DIRS) for (const f of RISKY) if (existsSync(path.join(dir, d, f))) found.push(path.join(dir, d, f));
    if (existsSync(path.join(dir, '.gemini', 'settings.json'))) found.push(path.join(dir, '.gemini', 'settings.json'));
    if (existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) return found;
  }
}

/** agy's own choice: no --model / --effort flag. */
export const AGY_DEFAULT = 'default';
export const AGY_EFFORTS: AgyChoice[] = [
  { value: AGY_DEFAULT, name: 'Default' },
  ...['low', 'medium', 'high', 'xhigh', 'max'].map((e) => ({ value: e, name: e === 'xhigh' ? 'Extra high' : e.charAt(0).toUpperCase() + e.slice(1) })),
];

/** Flags per level that runs (Manual runs nothing). agy's --sandbox restricts its terminal. */
export function agyModeArgs(mode: Exclude<AgyMode, 'manual'>): string[] {
  return mode === 'full' ? ['--dangerously-skip-permissions'] : ['--mode', 'accept-edits', '--sandbox'];
}

/** Flags FriedLiver sets itself, dropped from the user's extra arguments; `true`: takes a value. */
const OWNED: Record<string, boolean> = {
  '--dangerously-skip-permissions': false,
  '--sandbox': false,
  '--continue': false,
  '-c': false,
  '--mode': true,
  '--add-dir': true,
  '--model': true,
  '--effort': true,
  '--conversation': true,
  '--output-format': true,
  '--input-format': true,
  '--print': true,
  '--prompt': true,
  '-p': true,
  '--prompt-interactive': true,
  '-i': true,
  '--json-schema': true,
};

/** The user's extra arguments (friedliver.agents.antigravity.args) without any flag that would change what agy may do. */
export function extraArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const name = a.replace(/^-(-?[^=]+)=.*$/, '-$1');
    if (name in OWNED) {
      if (OWNED[name] && !a.includes('=')) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

export interface TurnChoices {
  mode: Exclude<AgyMode, 'manual'>;
  model: string;
  effort: string;
  /** agy's conversation, from the session's earlier turns. */
  conversationId?: string;
}

/** One turn's arguments: the user's extras, then FriedLiver's. The prompt goes on stdin. */
export function turnArgs(c: TurnChoices, extras: readonly string[] = []): string[] {
  return [
    ...extraArgs(extras),
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    // A "/" at the start of a message is text, never one of agy's own commands (/logout…).
    '--disable-slash-commands',
    ...agyModeArgs(c.mode),
    ...(c.model && c.model !== AGY_DEFAULT ? ['--model', c.model] : []),
    ...(c.effort && c.effort !== AGY_DEFAULT ? ['--effort', c.effort] : []),
    ...(c.conversationId ? ['--conversation', c.conversationId] : []),
  ];
}

/** The stdin line for one prompt. */
export const userLine = (text: string): string => `${JSON.stringify({ event: 'user', message: { content: text } })}\n`;

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const MAX_MODELS = 100;

/**
 * `agy models` as choices. Its output isn't documented, so this is forgiving: one model per
 * line; a header ("Fetching…", "Available models:") skipped; bullets and a current marker
 * ("*", "✓", "(current)", "(default)") stripped; "slug   Label" (two or more spaces) read
 * as value and name. agy takes the label for --model ("Gemini 3.1 Pro (High)") as well as a slug.
 */
export function parseModels(stdout: string): { choices: AgyChoice[]; current?: string } {
  const choices: AgyChoice[] = [];
  let current: string | undefined;
  for (const raw of stdout.split(/\r?\n/)) {
    let line = raw.replace(CONTROL, '').trim();
    if (!line || /^(fetching|available|loading|models?\b.*:$)/i.test(line) || line.endsWith(':') || line.length > 200) continue;
    let marked = false;
    line = line.replace(/^(?:[*>✓•●-]|\d+[.)])\s+/, (m) => ((marked ||= /[>✓●]/.test(m)), ''));
    line = line.replace(/\s*(?:\((?:current|default|selected)\)|✓)$/i, () => ((marked = true), '')).trim();
    if (!line) continue;
    const cols = line.split(/\s{2,}|\t/);
    const slug = cols.length > 1 && /^[\w.:/-]+$/.test(cols[0]);
    const choice: AgyChoice = slug ? { value: cols[0], name: cols.slice(1).join(' ') } : { value: line, name: line };
    if (choices.some((c) => c.value === choice.value)) continue;
    choices.push(choice);
    if (marked && !current) current = choice.value;
    if (choices.length >= MAX_MODELS) break;
  }
  return { choices, current };
}

/** The model in agy's own settings (~/.gemini/antigravity-cli/settings.json `model`), when it is one of the choices. Read only. */
export function settingsModel(settingsText: string | undefined, choices: AgyChoice[]): string | undefined {
  if (!settingsText) return undefined;
  try {
    const model = (JSON.parse(settingsText) as { model?: unknown }).model;
    const name = typeof model === 'string' ? model : (model as { name?: unknown } | null)?.name;
    if (typeof name !== 'string') return undefined;
    return choices.find((c) => c.value === name || c.name === name)?.value;
  } catch {
    return undefined;
  }
}

/** agy says it needs a sign-in (stderr or a result's error). */
export const needsSignIn = (text: string): boolean => /authentication (required|failed)|please sign in|not signed in|sign in to view/i.test(text);

// ---- stream-json events → ACP session updates ----

export interface StepUpdate {
  conversation_id?: string;
  step_index?: number;
  state?: string;
  step_type?: string;
  tool_name?: string;
  text_delta?: string;
  tool_info?: { name?: string; parameters?: unknown; output?: unknown; error?: unknown };
}

export interface AgyResult {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
}

export type AgyEvent = { event: 'init'; conversation_id?: string } | { event: 'step_update'; step_update: StepUpdate } | { event: 'result'; result: AgyResult } | { event: string };

/** One stdout line as an event; undefined for anything else (agy may print plain text too). */
export function parseEvent(line: string): AgyEvent | undefined {
  try {
    const v = JSON.parse(line) as unknown;
    return v && typeof v === 'object' && typeof (v as { event?: unknown }).event === 'string' ? (v as AgyEvent) : undefined;
  } catch {
    return undefined;
  }
}

/** A step_update's payload, whether it sits under `step_update` or on the event itself. */
export function stepOf(e: AgyEvent): StepUpdate {
  const nested = (e as { step_update?: unknown }).step_update;
  return (nested && typeof nested === 'object' ? nested : e) as StepUpdate;
}

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';

export function toolKind(name: string): ToolKind {
  if (/command|terminal|shell|exec|run/i.test(name)) return 'execute';
  if (/delete|remove/i.test(name)) return 'delete';
  if (/move|rename/i.test(name)) return 'move';
  if (/write|edit|replace|create|patch|insert/i.test(name)) return 'edit';
  if (/search|grep|find|glob|list/i.test(name)) return 'search';
  if (/url|fetch|browser|web/i.test(name)) return 'fetch';
  if (/view|read|open|cat/i.test(name)) return 'read';
  return 'other';
}

/** The files a tool names, for the step's locations. */
export function toolPaths(params: unknown, cwd: string): string[] {
  if (!params || typeof params !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (typeof v === 'string' && v && v.length < 4096 && /path|file/i.test(k) && !/[\0\r\n]/.test(v)) out.push(path.resolve(cwd, v));
  }
  return out.slice(0, 8);
}

const MAX_OUTPUT = 8000;
export const textOf = (v: unknown): string => {
  const s = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}…` : s;
};

/** How a result ends the turn; an error is thrown by the caller. */
export function stopReasonOf(status: string | undefined): 'end_turn' | 'cancelled' | 'error' {
  if (status === 'SUCCESS') return 'end_turn';
  if (status === 'CANCELED' || status === 'CANCELLED' || status === 'INTERRUPTED') return 'cancelled';
  return 'error';
}
