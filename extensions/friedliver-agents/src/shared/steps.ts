// What a tool step says in one line, and what its details show. Agents name a
// step with whatever they have: Claude's shell steps are titled with the whole
// command, heredoc and all, which read as one long wrapped paragraph. Here a
// step gets a verb, a one-line summary, the file a heredoc writes and its
// output without the code fence the agent wrapped it in.
import type * as acp from '@agentclientprotocol/sdk';
import { parseMarkdown, type Block } from './markdown';
import type { Item } from './model';
import { appendOutput, commandOf, type ToolOut } from './tools';

/** Characters of a command a step keeps; a longer one is cut and can't be run from the chat. */
export const MAX_COMMAND = 64 * 1024;
/** Characters of a step's summary line before it is cut with an ellipsis. */
export const MAX_SUMMARY = 110;
/** Characters of the tooltip that holds the full title or command. */
const MAX_TOOLTIP = 2000;

/** The command a tool step runs, as the agent sent it. */
export interface StepCommand {
  line: string;
  cwd?: string;
  /** Longer than MAX_COMMAND: `line` is its start only. */
  cut?: true;
}

/** What a tool step's updates say beyond its title, kept on the transcript item. */
export interface StepFacts {
  cmd?: StepCommand;
  /** What the agent said the step is for (Claude's `description`). */
  about?: string;
  /** The command's exit code, when the agent said. */
  exit?: number;
  /** When it started running (the host's clock), for its duration. */
  startedAt?: number;
  /** How long it ran, once it ended, when its start was seen. */
  ms?: number;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The exit code an update reports: `_meta.terminal_exit`, or a raw output's `exitCode` / `exit_code`. */
function exitOf(update: { _meta?: unknown; rawOutput?: unknown }): number | undefined {
  const meta = update._meta as { terminal_exit?: { exit_code?: unknown } } | undefined;
  const fromMeta = num(meta?.terminal_exit?.exit_code);
  if (fromMeta !== undefined) return fromMeta;
  const raw = update.rawOutput;
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  return num(r.exitCode) ?? num(r.exit_code);
}

/**
 * A tool step's facts after `update`, from its `rawInput` (the command, its
 * folder, its description), its exit and its timing. `prev` is what the step
 * had; `at` the host's clock for the update, when known.
 */
export function stepFacts(update: acp.ToolCall | acp.ToolCallUpdate, prev: StepFacts | undefined, at: number | undefined): StepFacts {
  const out: StepFacts = {};
  const input = update.rawInput;
  const command = input !== undefined ? commandOf(input) : undefined;
  const argv = input && typeof input === 'object' ? ((input as Record<string, unknown>).command ?? (input as Record<string, unknown>).cmd) : undefined;
  if (command && Array.isArray(argv)) command.line = argvLine(argv as string[]);
  if (command) {
    const cut = command.line.length > MAX_COMMAND;
    out.cmd = { line: cut ? command.line.slice(0, MAX_COMMAND) : command.line, ...(command.cwd ? { cwd: command.cwd } : {}), ...(cut ? { cut: true } : {}) };
  } else if (prev?.cmd) out.cmd = prev.cmd;
  const about = input && typeof input === 'object' ? (input as Record<string, unknown>).description : undefined;
  if (typeof about === 'string' && about.trim()) out.about = about.trim().slice(0, 300);
  else if (prev?.about) out.about = prev.about;
  const exit = exitOf(update) ?? prev?.exit;
  if (exit !== undefined) out.exit = exit;
  // The duration counts from "in progress": before that a step may wait for your OK, or its input still streams.
  const startedAt = prev?.startedAt ?? (update.status === 'in_progress' && at !== undefined ? at : undefined);
  if (startedAt !== undefined) out.startedAt = startedAt;
  if (prev?.ms !== undefined) out.ms = prev.ms;
  else if (startedAt !== undefined && at !== undefined && (update.status === 'completed' || update.status === 'failed')) out.ms = Math.max(0, at - startedAt);
  return out;
}

/** A shell quote for one argument, when it needs one. */
function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** An argv as a line a shell runs the same way: `["bash", "-lc", "npm test"]` is `npm test`. */
export function argvLine(argv: string[]): string {
  const shell = argv[0]?.split(/[\\/]/).at(-1);
  if (argv.length === 3 && /^(?:ba|z|da|k)?sh$/.test(shell ?? '') && /^-l?c$/.test(argv[1])) return argv[2];
  return argv.map(quote).join(' ');
}

/**
 * The output text in a tool's raw output, as Codex-style agents report a command:
 * `formatted_output`, `aggregated_output` or `output`, else stdout and stderr.
 * Undefined when it has none, or isn't an object (a raw string may be anything).
 */
export function rawOutputText(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  const one = text(r.formatted_output) ?? text(r.aggregated_output) ?? text(r.output);
  if (one) return one;
  const both = [text(r.stdout), text(r.stderr)].filter(Boolean).join('\n');
  return both || undefined;
}

/** A tool's output with its raw output's text added when it shows no text of its own. */
export function withRawOutput(out: ToolOut[] | undefined, raw: unknown): ToolOut[] | undefined {
  if (out?.some((o) => o.t === 'text' || o.t === 'terminal')) return out;
  const text = rawOutputText(raw);
  return text ? appendOutput(out, text) : out;
}

// ---- Heredocs ----

export interface Heredoc {
  /** The line with `<<`, e.g. `cat << 'EOF' > README.md`. */
  head: string;
  delimiter: string;
  /** The heredoc's text, without its delimiter lines. */
  body: string;
  /** The file the heredoc goes into, when the head writes it (`cat > f`, `cat >> f`, `tee f`). */
  file?: string;
  append?: boolean;
  /** Commands before the head line and after the closing delimiter. */
  before: string;
  after: string;
  /** The closing delimiter came. */
  closed: boolean;
}

const HEREDOC = /(?<!<)<<(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][\w.-]*))/;
const REDIRECT = /(?<![\d&>])(>>?)\s*(?:"([^"\n]+)"|'([^'\n]+)'|([^\s|;&<>()]+))/;
const TEE = /\btee\s+(?:(-a|--append)\s+)?(?:"([^"\n]+)"|'([^'\n]+)'|([^\s|;&<>()-][^\s|;&<>()]*))/;

/** The first heredoc in a shell command, or undefined when it has none. */
export function heredocOf(command: string): Heredoc | undefined {
  const lines = command.split(/\r?\n/);
  const at = lines.findIndex((l) => HEREDOC.test(l));
  if (at < 0) return undefined;
  const head = lines[at];
  const m = head.match(HEREDOC)!;
  const delimiter = m[2] ?? m[3] ?? m[4];
  const tabs = m[1] === '-';
  let end = at + 1;
  while (end < lines.length && (tabs ? lines[end].replace(/^\t+/, '') : lines[end]).trimEnd() !== delimiter) end++;
  const closed = end < lines.length;
  const body = lines.slice(at + 1, end).map((l) => (tabs ? l.replace(/^\t+/, '') : l));
  const out: Heredoc = {
    head,
    delimiter,
    body: body.join('\n'),
    before: lines.slice(0, at).join('\n'),
    after: closed ? lines.slice(end + 1).join('\n') : '',
    closed,
  };
  const target = writeTarget(head);
  if (target) {
    out.file = target.file;
    if (target.append) out.append = true;
  }
  return out;
}

/** The file a heredoc's head line writes the text to: `cat > f << EOF`, `cat << EOF >> f`, `cat << EOF | tee f`. */
function writeTarget(head: string): { file: string; append: boolean } | undefined {
  const parts = head.split(/(?<!\|)\|(?!\|)/);
  const first = parts[0].replace(/^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)?/, '');
  const program = first.trim().split(/\s+/)[0];
  if (program === 'cat' && parts.length === 1) {
    const r = first.replace(HEREDOC, '').match(REDIRECT);
    if (r) return { file: r[2] ?? r[3] ?? r[4], append: r[1] === '>>' };
  }
  const tee = (program === 'tee' ? first : program === 'cat' && parts.length === 2 ? parts[1] : '').match(TEE);
  if (tee) return { file: tee[2] ?? tee[3] ?? tee[4], append: !!tee[1] };
  return undefined;
}

// ---- One-line summaries ----

export interface StepSummary {
  /** Run, Write, Edit, Read, Search, Fetch, Think… */
  verb: string;
  /** One line, cut with an ellipsis. */
  text: string;
  /** `text` is a command line, shown in the code font. */
  mono: boolean;
  /** The command's lines, or the lines a heredoc writes, when more than one. */
  lines?: number;
  /** The file a heredoc writes. */
  file?: string;
  /** The folder a leading `cd` moves to. */
  dir?: string;
  /** For the tooltip: the whole title or command, capped. */
  full: string;
}

const KIND_VERB: Record<string, string> = {
  execute: 'Run',
  edit: 'Edit',
  read: 'Read',
  search: 'Search',
  fetch: 'Fetch',
  think: 'Think',
  delete: 'Delete',
  move: 'Move',
  switch_mode: 'Plan',
  other: 'Tool',
};
/** Words a title may start with that say better what a step of that kind did. */
const TITLE_VERBS: Record<string, string[]> = {
  execute: ['run'],
  edit: ['edit', 'write', 'create', 'update', 'patch', 'apply'],
  read: ['read', 'list', 'view', 'open'],
  search: ['search', 'find', 'grep', 'glob'],
  fetch: ['fetch', 'search', 'get', 'download'],
  think: ['think', 'plan'],
  delete: ['delete', 'remove'],
  move: ['move', 'rename'],
};
const ANY_VERBS = new Set(Object.values(TITLE_VERBS).flat());

const capital = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/** Cuts `s` to `max` characters with an ellipsis. */
export function cut(s: string, max = MAX_SUMMARY): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
}

/** A command line with its paths shortened to their last part: `python3 /tmp/x/minidb.py` → `python3 minidb.py`. */
export function shortPaths(line: string): string {
  return line.replace(/(^|[\s=|<>(])(['"]?)(?:~|\.{1,2}|[A-Za-z]:)?(?:[\\/][^\s'"\\/|;&<>()]*)+[\\/]([^\s'"\\/|;&<>()]+)/g, '$1$2$3');
}

/** One line for a shell command: the program and its target, heredocs named by what they do. */
export function commandSummary(command: string, max = MAX_SUMMARY): Omit<StepSummary, 'verb' | 'full'> & { verb: 'Run' | 'Write' } {
  const lines = command.replace(/\s+$/, '').split(/\r?\n/);
  const count = lines.length > 1 ? lines.length : undefined;
  const doc = heredocOf(command);
  if (doc?.file && !doc.before.trim()) {
    const bodyLines = doc.body ? doc.body.split('\n').length : 0;
    const then = doc.after.split('\n').find((l) => l.trim());
    const name = basename(doc.file);
    const text = then ? `${name}, then ${shortPaths(then.trim())}` : name;
    return { verb: 'Write', text: cut(text, max), mono: false, lines: bodyLines || undefined, file: doc.file };
  }
  let first = (lines.find((l) => l.trim()) ?? '').trim();
  let dir: string | undefined;
  const cd = first.match(/^cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*(.+)$/);
  if (cd) {
    dir = cd[1].replace(/^["']|["']$/g, '');
    first = cd[2];
  }
  const text = shortPaths(first).replace(/<<(-?)\s*(['"])([^'"\s]+)\2/g, '<<$1 $3');
  return { verb: 'Run', text: cut(text, max), mono: true, lines: count, ...(dir ? { dir } : {}) };
}

/** A title without the code ticks some agents put around names: "Find `src` `*.ts`". */
function plainTitle(title: string): string {
  const t = title.trim();
  if (/^`[^`]+`$/.test(t)) return t.slice(1, -1);
  return t.replace(/`([^`\n]*)`/g, '$1');
}

/** A step that runs a shell command: an execute step, or one without a kind that has a command. */
export function isShell(step: { toolKind?: string; cmd?: StepCommand }): boolean {
  return step.toolKind === 'execute' || (!step.toolKind && !!step.cmd);
}

/** The verb and one-line summary for a tool step. */
export function stepSummary(step: { title: string; toolKind?: string; cmd?: StepCommand }, max = MAX_SUMMARY): StepSummary {
  const kind = step.toolKind ?? '';
  const command = isShell(step) ? (step.cmd?.line ?? plainTitle(step.title).replace(/^Run\s+/, '')) : undefined;
  if (command?.trim()) {
    const s = commandSummary(command, max);
    return { ...s, full: cut(command, MAX_TOOLTIP) };
  }
  const title = plainTitle(step.title).replace(/\s+/g, ' ');
  const full = cut(title, MAX_TOOLTIP);
  const word = title.match(/^([A-Za-z]+)\s+(\S.*)$/);
  const allowed = TITLE_VERBS[kind];
  if (word && (allowed ? allowed.includes(word[1].toLowerCase()) : !kind && ANY_VERBS.has(word[1].toLowerCase()))) {
    const verb = word[1].toLowerCase() === 'grep' ? KIND_VERB.search : capital(word[1]);
    const mono = word[1] === 'grep' || word[1] === 'rg';
    return { verb, text: cut(mono ? title : word[2], max), mono, full };
  }
  return { verb: KIND_VERB[kind] ?? 'Tool', text: cut(title, max), mono: false, full };
}

// ---- Output ----

/** Tool output as the details show it: a code fence the agent wrapped it in taken off, an "Exit code N" first line read. */
export function stepOutput(text: string): { text: string; lang?: string; exit?: number } {
  let body = text;
  let lang: string | undefined;
  const fence = body.match(/^\s*```([\w+-]*)[^\S\n]*\n([\s\S]*?)\n?```\s*$/);
  if (fence && !fence[2].includes('\n```')) {
    lang = fence[1] || undefined;
    body = fence[2];
  } else if (body.startsWith('…\n') && /\n```\s*$/.test(body) && !/(^|\n)```[\w+-]*[^\S\n]*\n/.test(body)) {
    // Output cut to its end lost the opening fence: drop the closing one.
    body = body.replace(/\n```\s*$/, '');
  }
  const exit = body.match(/^Exit code (\d+)(?:\n|$)/);
  if (exit) body = body.slice(exit[0].length);
  return { text: body, ...(lang ? { lang } : {}), ...(exit ? { exit: Number(exit[1]) } : {}) };
}

// ---- Running a shown command ----

/** Code block languages that are shell commands, with Run in terminal. */
export const SHELL_LANGS = new Set(['bash', 'sh', 'zsh', 'shell', 'console', 'shellsession', 'shell-session']);
/** Control characters (escape and the rest, C1 too) but tab and line ends: typed into a terminal, they act. */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/** Whether `text` can be typed into a terminal as it is. */
export function typeable(text: string): boolean {
  return text.trim().length > 0 && text.length <= MAX_COMMAND && !hasControl(text);
}

/**
 * What Run in terminal types for a code block: the code of a shell block, and
 * of a console block the lines after `$ ` (output lines left out). Undefined
 * for other languages and for code that can't be typed as it is.
 */
export function runnableCode(lang: string, code: string): string | undefined {
  const l = lang.toLowerCase();
  if (!SHELL_LANGS.has(l)) return undefined;
  const lines = code.replace(/\s+$/, '').split('\n');
  const prompted = lines.filter((x) => x.trim());
  const console = l === 'console' || l === 'shellsession' || l === 'shell-session';
  let out: string;
  if (console || (prompted.length && prompted.every((x) => /^\s*\$ /.test(x)))) {
    const cmds: string[] = [];
    let more = false;
    for (const x of lines) {
      const p = x.match(/^\s*\$ (.*)$/);
      if (p) cmds.push(p[1]);
      else if (more) cmds.push(x);
      else continue;
      more = cmds.at(-1)!.endsWith('\\');
    }
    out = cmds.join('\n');
  } else out = lines.join('\n');
  return typeable(out) ? out : undefined;
}

function shellBlocks(blocks: Block[]): Extract<Block, { t: 'pre' }>[] {
  return blocks.filter((b): b is Extract<Block, { t: 'pre' }> => b.t === 'pre' && SHELL_LANGS.has(b.lang.toLowerCase()));
}

/**
 * Whether the chat showed `command` in full where it offers Run in terminal: a
 * tool step's command (not cut), or a shell code block in a reply. The host
 * runs nothing else, whatever a webview asks.
 */
export function shownCommand(items: readonly Item[], command: string): boolean {
  if (!typeable(command)) return false;
  const firstLine = command.split('\n')[0];
  for (const i of items) {
    if (i.kind === 'tool' && isShell(i) && i.cmd && !i.cmd.cut && i.cmd.line === command) return true;
    const text = i.kind === 'agent' || i.kind === 'link' ? i.text : undefined;
    if (text?.includes(firstLine) && shellBlocks(parseMarkdown(text)).some((b) => runnableCode(b.lang, b.code) === command)) return true;
  }
  return false;
}

// ---- Paths ----

/**
 * `file` as an absolute path inside `folder`, or undefined when it is outside
 * (or under `~`). Relative paths resolve against the folder. Only decides
 * whether a path in the chat is offered as a link; the host checks again.
 */
export function inFolder(folder: string, file: string): string | undefined {
  if (!folder || !file || file.startsWith('~')) return undefined;
  const win = /^[A-Za-z]:[\\/]/.test(folder) || folder.includes('\\');
  const sep = win ? '\\' : '/';
  const absolute = win ? /^[A-Za-z]:[\\/]/.test(file) || file.startsWith('\\') : file.startsWith('/');
  const parts: string[] = [];
  for (const p of (absolute ? file : `${folder}${sep}${file}`).split(/[\\/]+/)) {
    if (p === '..') parts.pop();
    else if (p && p !== '.') parts.push(p);
  }
  const root = folder.split(/[\\/]+/).filter(Boolean);
  const same = (a: string, b: string) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (parts.length <= root.length || !root.every((r, n) => same(r, parts[n]))) return undefined;
  return win ? parts.join(sep) : `/${parts.join('/')}`;
}
