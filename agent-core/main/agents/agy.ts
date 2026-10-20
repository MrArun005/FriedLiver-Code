// Google's Antigravity CLI (`agy`) as an ACP agent: the pure half of agyAcp.ts.
//
// agy has no ACP mode (1.4.3: no --acp flag, no acp subcommand). It does have a documented
// headless mode (https://antigravity.google/docs/cli/headless/): `--output-format stream-json`
// prints NDJSON events (init, step_update…, result) and `--input-format stream-json` reads the
// prompt as {"event":"user",…} on stdin, so a prompt never sits in the process list. Headless
// agy can't stop to ask for approval: a tool that needs one is refused. So FriedLiver's levels
// become agy's own flags per turn (agyModeArgs). Manual, Plan, /discuss and read-only chats are
// talk only: agy runs in an empty folder under a deny-by-default sandbox (talkProfile), and
// FriedLiver reads the project for it (parseNeeds) through its own index.
import { readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';

export interface AgyChoice {
  value: string;
  name: string;
  description?: string;
}

/**
 * FriedLiver's levels as agy runs them. Names and descriptions say what each does, so
 * FriedLiver's modeClass and readOnlyChoice read them right: read-only is Manual and every
 * read-only use, plan is Plan, accept-edits is Edit automatically, full is Auto.
 */
export const AGY_MODES: AgyChoice[] = [
  { value: 'read-only', name: 'Read only', description: 'Talk only: no files, commands or tools of its own; FriedLiver reads the project for it' },
  { value: 'plan', name: 'Plan', description: 'Talk only, planning: FriedLiver reads the project for it; nothing changes' },
  { value: 'accept-edits', name: 'Accept edits', description: 'Edits files without asking; commands are refused unless allowed in agy’s own settings' },
  { value: 'full', name: 'Full access', description: 'Auto-approves all tool requests: edits and commands' },
];
export type AgyMode = 'read-only' | 'plan' | 'accept-edits' | 'full';
export const isAgyMode = (v: unknown): v is AgyMode => AGY_MODES.some((m) => m.value === v);
export const isTalkMode = (m: AgyMode): m is 'read-only' | 'plan' => m === 'read-only' || m === 'plan';

/**
 * The workspace config agy reads. Sources: antigravity.google/docs/hooks ("`.agents/hooks.json`
 * at your project root"), docs/cli reference ("`.agents/`, `.agents/mcp_config.json`,
 * `.agents/skills/`, `.agents/rules/`: workspace customizations"; "`GEMINI.md` and `AGENTS.md`:
 * workspace rules"), and the agy 1.4.3 binary's own guide text ("`.agents/` (or `.agent/`,
 * `_agents/`, `_agent/`) at the root of" the workspace; "`<workspace_root>/{.agents,_agents,
 * .agent,_agent}/workflows.json`"; "Hooks run shell commands with your full permissions"). It
 * also keeps output under `<workspace>/.gemini/antigravity/`. Nothing documents a walk above the
 * workspace root, or a flag or variable that turns workspace config off (1.4.3 `--help` has
 * none). So FriedLiver's macOS sandbox (seatbeltProfile) hides all of them from agy, at any depth
 * and any case, and this check is defence in depth.
 */
const CONFIG_DIRS = new Set(['.agents', '.agent', '_agents', '_agent', '.gemini']);
/**
 * What may be in them: text only, by an allowlist, so anything new agy learns to load is refused
 * until it is listed here. Rules and workflows are markdown; agy's own artifacts and transcript
 * are its output. Paths are lower-cased, relative to the config folder.
 */
const TEXT_ONLY: Record<string, RegExp> = {
  agents: /^(rules|workflows)\/[^/]+(\/[^/]+)*\.md$/,
  gemini: /^antigravity\/(artifacts\/[^/]+(\/[^/]+)*|transcript\.jsonl)$/,
};
/** Files looked at per config folder; past it the folder counts as unsafe (a check that stops early proves nothing). */
const MAX_CONFIG_FILES = 500;

/** A config folder's entries that aren't plain text files on the allowlist (a symlink never is). */
function unsafeIn(dir: string, allowed: RegExp): string[] {
  const bad: string[] = [];
  let seen = 0;
  const walk = (rel: string): void => {
    for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (++seen > MAX_CONFIG_FILES) throw new Error('too many files');
      if (e.isDirectory()) walk(r);
      else if (!e.isFile() || !allowed.test(r.toLowerCase())) bad.push(path.join(dir, ...r.split('/')));
    }
  };
  try {
    walk('');
  } catch {
    return [dir];
  }
  return bad;
}

/**
 * Defence in depth, fail closed: anything in an agy config folder that isn't text on the
 * allowlist (MCP servers, hooks, plugins, skills, settings, symlinks, what agy may load next),
 * in `cwd` and its parents up to `root`, the repository root git reported once for the session.
 * When `root` isn't `cwd` or above it, `cwd` only: never a walk past it.
 */
export function workspaceConfig(cwd: string, root: string = cwd): string[] {
  const list = (dir: string): Dirent[] => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const start = path.resolve(cwd);
  const top = path.resolve(root);
  const inside = !path.relative(top, start).startsWith('..') && !path.isAbsolute(path.relative(top, start));
  const dirs = [start];
  if (inside) for (let dir = start; dir !== top; ) dirs.push((dir = path.dirname(dir)));
  const found: string[] = [];
  for (const dir of dirs) {
    for (const e of list(dir)) {
      const name = e.name.toLowerCase();
      if (!CONFIG_DIRS.has(name)) continue;
      const full = path.join(dir, e.name);
      if (!e.isDirectory()) found.push(full);
      else found.push(...unsafeIn(full, name === '.gemini' ? TEXT_ONLY.gemini : TEXT_ONLY.agents));
    }
  }
  return found;
}

/** What agy writes under ~/.gemini as it runs (its first run, 1.4.3): state, never config. Everything else there is read only to it. */
const AGY_STATE = [
  'antigravity-cli/brain',
  'antigravity-cli/builtin',
  'antigravity-cli/cache',
  'antigravity-cli/conversations',
  'antigravity-cli/crashes',
  'antigravity-cli/implicit',
  'antigravity-cli/log',
  'antigravity-cli/mcp',
  'antigravity-cli/plugin_data',
  'antigravity-cli/updater',
  'antigravity-cli/tmp',
  'antigravity-cli/cli.log',
  'antigravity-cli/conversation_summaries.db',
  'antigravity-cli/conversation_summaries.db-shm',
  'antigravity-cli/conversation_summaries.db-wal',
  'antigravity-cli/installation_id',
  'antigravity-cli/jetski_state.pbtxt',
  'antigravity-cli/last_check.timestamp',
  'config/.migrated',
  'config/projects',
  'jetski/brain',
];

/** A path for a sandbox profile string literal. */
const sbString = (p: string): string => {
  if (/["\\\0\r\n]/.test(p)) throw new Error(`Can't sandbox a path with quotes, backslashes or line breaks: ${p}`);
  return `"${p}"`;
};
/** A folder name matched in any case, for a sandbox regex: ".agents" → "[.][Aa][Gg]…". */
const anyCase = (name: string): string => [...name].map((c) => (/[a-z]/.test(c) ? `[${c.toUpperCase()}${c}]` : `[${c}]`)).join('');

/**
 * The macOS sandbox (sandbox-exec) every agy process runs in. agy and everything it starts can't
 * read or write any `.agents`/`.agent`/`_agents`/`_agent`/`.gemini` folder anywhere, in any case
 * (the OS turns workspace config off, since agy can't), except the user's own `~/.gemini`: read,
 * and written only where agy keeps its state, so a turn can't leave config (hooks, MCP servers,
 * settings, plugins, skills, rules) for the next one. `home` must be a real path (no symlinks).
 */
export function seatbeltProfile(home: string): string {
  const gemini = path.join(home, '.gemini');
  const configDir = `(^|/)(${['.agents', '.agent', '_agents', '_agent', '.gemini'].map(anyCase).join('|')})(/|$)`;
  return [
    '(version 1)',
    '(allow default)',
    // The last matching rule wins.
    `(deny file-read* file-write* (regex #"${configDir}"))`,
    `(allow file-read* (subpath ${sbString(gemini)}))`,
    `(deny file-write* (subpath ${sbString(gemini)}))`,
    `(allow file-write* ${AGY_STATE.map((p) => `(subpath ${sbString(path.join(gemini, p))})`).join(' ')})`,
  ].join('\n');
}

// ---- Talk only ----

/**
 * The system services agy 1.4.3 needs, found by running it under the profile: keychain
 * (`/usr/bin/security`, its sign-in), TLS trust, DNS, user lookup, logging, preferences.
 */
const TALK_SERVICES = [
  'com.apple.SecurityServer',
  'com.apple.securityd.xpc',
  'com.apple.trustd',
  'com.apple.trustd.agent',
  'com.apple.ocspd',
  'com.apple.dnssd.service',
  'com.apple.mDNSResponder',
  'com.apple.system.opendirectoryd.libinfo',
  'com.apple.system.opendirectoryd.membership',
  'com.apple.system.notification_center',
  'com.apple.logd',
  'com.apple.system.logger',
  'com.apple.diagnosticd',
  'com.apple.cfprefsd.daemon',
  'com.apple.cfprefsd.agent',
  'com.apple.SystemConfiguration.configd',
  'com.apple.SystemConfiguration.DNSConfiguration',
  'com.apple.networkd',
];

export interface TalkSandbox {
  /** The agy binary (a real path): the only program that may start, with /usr/bin/security for its keychain sign-in. */
  agy: string;
  /** The session's empty folder: agy's working folder, and the only place it may write besides its own state. */
  scratch: string;
  /** The user's real home folder. */
  home: string;
  /** Tests: more to read (Node's install, the fake agy) or write (its call log). */
  read?: string[];
  write?: string[];
}

/**
 * Talk only, deny by default: agy may start only itself and `security`; read only the system,
 * its own binary, `~/.gemini` (its settings and sign-in state) and the keychain, plus the empty
 * session folder; write only that folder and its own state under `~/.gemini`; reach the network
 * outbound (macOS profiles can't filter by host name) and its own localhost server. No project
 * file, no shell, no other program. All paths must be real paths.
 */
export function talkProfile(s: TalkSandbox): string {
  const sub = (paths: string[]) => paths.map((p) => `(subpath ${sbString(p)})`).join(' ');
  const gemini = path.join(s.home, '.gemini');
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    `(allow process-exec (literal ${sbString(s.agy)}) (literal "/usr/bin/security"))`,
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    `(allow mach-lookup (global-name ${TALK_SERVICES.map(sbString).join(' ')}))`,
    '(allow ipc-posix-shm-read-data ipc-posix-shm-read-metadata)',
    '(allow system-socket)',
    '(allow network-outbound)',
    '(allow network-bind network-inbound (local ip "localhost:*"))',
    '(allow file-read-metadata)',
    `(allow file-read* (literal "/") ${sub(['/usr/lib', '/usr/share', '/System', '/Library/Keychains', '/private/etc', '/private/var/db/timezone', '/dev'])} (literal "/usr/bin/security") (literal ${sbString(s.agy)}) ${sub([s.scratch, gemini, path.join(s.home, 'Library', 'Keychains'), ...(s.read ?? [])])})`,
    `(allow file-write* (literal "/dev/null") (literal "/dev/tty") ${sub([s.scratch, ...AGY_STATE.map((p) => path.join(gemini, p)), ...(s.write ?? [])])})`,
  ].join('\n');
}

/** How much FriedLiver reads for agy in one turn. */
export const TALK_LIMITS = {
  /** Times agy may ask for more before it must answer. */
  rounds: 3,
  /** Requests FriedLiver fulfils per round; the rest are refused. */
  needs: 5,
  /** Characters of one answer, and of all answers in a turn. */
  answerChars: 6000,
  turnChars: 24_000,
  /** Lines one read may span. */
  lines: 300,
  /** Characters of a search, and of the excerpts FriedLiver adds before agy's first look. */
  query: 200,
  startChars: 6000,
};

/** What agy is told in talk only. */
export function talkPreamble(plan: boolean): string {
  return [
    '[FriedLiver: talk only]',
    'You are answering inside FriedLiver. You cannot read files, run commands or use any tool here: they fail. FriedLiver reads the project for you.',
    ...(plan ? ['Plan only: outline the steps and the files they touch; change nothing.'] : []),
    `To see more, end your reply with one fenced block, and FriedLiver answers it (at most ${TALK_LIMITS.needs} items, ${TALK_LIMITS.rounds} times):`,
    '~~~need',
    '{"need":[{"read":"src/app.ts","lines":"1-120"},{"search":"refresh token"},{"outline":"src/app.ts"}]}',
    '~~~',
    'Paths are relative to the project folder. Otherwise answer in full, including any block the message asks for.',
  ].join('\n');
}

export type Need = { kind: 'read'; path: string; lines?: [number, number] } | { kind: 'search'; query: string } | { kind: 'outline'; path: string };

/** Mirrors projectIndex.ts isSecret: names FriedLiver never reads for an agent. */
const SECRET =
  /^(\.env(\..*)?|.*\.pem|.*\.key|id_(rsa|dsa|ecdsa|ed25519).*|.*\.p12|.*\.pfx|\.npmrc|\.netrc|\.pypirc|\.git-credentials|credentials.*|.*\.tfstate.*|.*\.tfvars|secrets\..*|.*\.keystore|.*\.jks|service-account.*\.json)$/i;

/** A project path as agy wrote it, made safe: relative, inside the project, no secrets. Else why not. */
export function safePath(raw: unknown): { path: string } | { refused: string } {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 512 || /[\0\r\n]/.test(raw)) return { refused: 'not a path' };
  const p = raw.trim().replace(/\\/g, '/');
  if (p.startsWith('/') || /^[a-z]:/i.test(p) || p.startsWith('~')) return { refused: `${raw}: not inside the project` };
  const norm = path.posix.normalize(p);
  if (norm === '..' || norm.startsWith('../')) return { refused: `${raw}: not inside the project` };
  if (norm.split('/').some((part) => SECRET.test(part) || /^\.(git|ssh|aws|gnupg)$/i.test(part))) return { refused: `${raw}: may hold secrets` };
  return { path: norm === '.' ? '' : norm };
}

/**
 * agy's reply split into what it said and what it asked FriedLiver to read (its last `need`
 * block, fenced with ~~~ or ```). At most `max` requests are kept; the rest, and anything
 * unsafe or malformed, come back in `refused`.
 */
export function parseNeeds(reply: string, max = TALK_LIMITS.needs): { text: string; needs: Need[]; refused: string[] } {
  const blocks = [...reply.matchAll(/(^|\n)(~~~|```)need[ \t]*\n([\s\S]*?)\n\2[ \t]*(?=\n|$)/g)];
  const last = blocks.at(-1);
  if (!last) return { text: reply, needs: [], refused: [] };
  const text = (reply.slice(0, last.index) + reply.slice(last.index! + last[0].length)).trim();
  let items: unknown;
  try {
    items = (JSON.parse(last[3]) as { need?: unknown }).need;
  } catch {
    return { text, needs: [], refused: ['the need block isn’t JSON'] };
  }
  if (!Array.isArray(items)) return { text, needs: [], refused: ['the need block has no "need" list'] };
  const needs: Need[] = [];
  const refused: string[] = [];
  for (const item of items) {
    if (needs.length >= max) {
      refused.push(`more than ${max} requests`);
      break;
    }
    const it = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    if (typeof it.search === 'string') {
      const q = it.search.trim().slice(0, TALK_LIMITS.query);
      if (q && !/[\0\r\n]/.test(q)) needs.push({ kind: 'search', query: q });
      else refused.push('an empty search');
      continue;
    }
    const target = it.read ?? it.outline;
    const safe = safePath(target);
    if ('refused' in safe) {
      refused.push(safe.refused);
      continue;
    }
    if (it.outline !== undefined) {
      needs.push({ kind: 'outline', path: safe.path });
      continue;
    }
    const m = typeof it.lines === 'string' ? /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(it.lines) : null;
    if (it.lines !== undefined && !m) {
      refused.push(`${safe.path}: lines must be like "1-120"`);
      continue;
    }
    if (m) {
      const a = Math.max(1, Number(m[1]));
      const b = Math.min(Number(m[2]), a + TALK_LIMITS.lines - 1);
      if (b < a) {
        refused.push(`${safe.path}: lines must be like "1-120"`);
        continue;
      }
      needs.push({ kind: 'read', path: safe.path, lines: [a, b] });
    } else needs.push({ kind: 'read', path: safe.path });
  }
  return { text, needs, refused };
}

/** A request as FriedLiver's read-only index tool call (bridge/mcp.ts). */
export function needCall(n: Need): { name: string; args: Record<string, unknown>; title: string } {
  if (n.kind === 'search') return { name: 'index_search', args: { query: n.query, limit: 5, budget: 1500 }, title: `Search the project: ${n.query}` };
  if (n.kind === 'outline') return { name: 'index_outline', args: { path: n.path }, title: `Outline ${n.path}` };
  return { name: 'index_read', args: { path: n.path, ...(n.lines ? { lines: n.lines } : {}) }, title: `Read ${n.path}${n.lines ? ` ${n.lines[0]}-${n.lines[1]}` : ''}` };
}

/** agy's own choice: no --model / --effort flag. */
export const AGY_DEFAULT = 'default';
export const AGY_EFFORTS: AgyChoice[] = [
  { value: AGY_DEFAULT, name: 'Default' },
  ...['low', 'medium', 'high', 'xhigh', 'max'].map((e) => ({ value: e, name: e === 'xhigh' ? 'Extra high' : e.charAt(0).toUpperCase() + e.slice(1) })),
];

/** Flags per level that runs (Manual runs nothing). agy's --sandbox restricts its terminal. */
export function agyModeArgs(mode: AgyMode): string[] {
  if (mode === 'full') return ['--dangerously-skip-permissions'];
  if (mode === 'accept-edits') return ['--mode', 'accept-edits', '--sandbox'];
  // Talk only: the OS sandbox is the guard; agy's own flags only keep it from trying.
  return [...(mode === 'plan' ? ['--mode', 'plan'] : []), '--sandbox'];
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
  mode: AgyMode;
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
