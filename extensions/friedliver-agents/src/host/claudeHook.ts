// Claude Code's permission asks in the companion. While friedliver.companion.claudeCode is on, FriedLiver
// adds one PermissionRequest hook to ~/.claude/settings.json: an `mcp_tool` hook that calls the unlisted
// friedliver_permission_request tool on the friedliver-browser server Claude Code already runs
// (externalBrowser.ts), so no program, shell or secret is involved. The hook only tells: FriedLiver
// answers `{}`, the ask stays with Claude Code's own prompt, and the companion's card says what is asked
// and takes you there. The card goes when the session's transcript records a tool result (you answered),
// on a click, or after a while. The entry is there only while FriedLiver runs: with the server gone,
// Claude Code would report a hook error on every ask.
import { closeSync, openSync, readSync, statSync, unwatchFile, watchFile, type Stats } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PERMISSION_HOOK_TOOL } from '../bridge/protocol';
import { DISGUISE } from '../remote/actions';
import { tilde } from '../shared/approval';
import { readConfig, SERVER_NAME, writeConfig } from './externalBrowser';

export const HOOK_EVENT = 'PermissionRequest';

/** Asks answered in Claude Code's panel only: plans and mode switches need reading, questions need answers. */
const LEAVE = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode']);
const MAX_DETAIL = 4000;
/** Bytes of new transcript read per change. */
const MAX_READ = 1024 * 1024;

/**
 * The hook group FriedLiver adds: every tool, through the friedliver-browser server. `${…}` is Claude
 * Code's substitution from the hook's input (an object comes as its JSON).
 */
export function hookEntry() {
  return {
    matcher: '*',
    hooks: [
      {
        type: 'mcp_tool',
        server: SERVER_NAME,
        tool: PERMISSION_HOOK_TOOL,
        input: { tool: '${tool_name}', input: '${tool_input}', cwd: '${cwd}', transcript: '${transcript_path}' },
        timeout: 30,
      },
    ],
  };
}

/** A group FriedLiver wrote: only hooks calling its tool on its server. Anyone else's is theirs. */
export function isOurHook(group: unknown): boolean {
  if (typeof group !== 'object' || group === null) return false;
  const hooks = (group as { hooks?: unknown }).hooks;
  return (
    Array.isArray(hooks) &&
    hooks.length > 0 &&
    hooks.every((h: unknown) => typeof h === 'object' && h !== null && (h as Record<string, unknown>).type === 'mcp_tool' && (h as Record<string, unknown>).server === SERVER_NAME && (h as Record<string, unknown>).tool === PERMISSION_HOOK_TOOL)
  );
}

/** The PermissionRequest list, or a throw when it is something FriedLiver can't edit safely. */
async function readHooks(file: string) {
  const { config, exists } = await readConfig(file, 'hooks');
  const hooks = (config.hooks ?? {}) as Record<string, unknown>;
  const list = hooks[HOOK_EVENT];
  if (list !== undefined && !Array.isArray(list)) throw new Error(`hooks.${HOOK_EVENT} in ${file} is not a list; left it alone.`);
  return { config, exists, hooks, list: (list ?? []) as unknown[] };
}

/** Adds or updates our hook group, touching nothing else. 'unchanged' when it already says this. */
export async function registerHook(file: string): Promise<'added' | 'updated' | 'unchanged'> {
  const { config, exists, hooks, list } = await readHooks(file);
  const want = hookEntry();
  const ours = list.filter(isOurHook);
  if (ours.length === 1 && JSON.stringify(ours[0]) === JSON.stringify(want)) return 'unchanged';
  if (!exists) await mkdir(path.dirname(file), { recursive: true });
  await writeConfig(file, { ...config, hooks: { ...hooks, [HOOK_EVENT]: [...list.filter((g) => !isOurHook(g)), want] } }, exists);
  return ours.length ? 'updated' : 'added';
}

/** Removes our hook group (and an emptied list), nothing else; true when removed. A file without it is not written. */
export async function unregisterHook(file: string): Promise<boolean> {
  const { config, exists, hooks, list } = await readHooks(file);
  if (!exists || !list.some(isOurHook)) return false;
  const others = list.filter((g) => !isOurHook(g));
  const rest = { ...hooks };
  if (others.length) rest[HOOK_EVENT] = others;
  else delete rest[HOOK_EVENT];
  const next = { ...config };
  if (Object.keys(rest).length) next.hooks = rest;
  else delete next.hooks;
  await writeConfig(file, next, exists);
  return true;
}

/** Control, bidi and zero-width characters spelled out, so what the card shows reads as it runs. */
const visible = (s: string) => s.replace(new RegExp(DISGUISE.source, 'gu'), (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`);
const clip = (s: string) => (s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL - 1)}…` : s);

/**
 * The card's words for an ask ("Run a command?" and the command), or undefined for asks left to Claude
 * Code's panel alone. `inputJson` is the tool's input as the hook passed it.
 */
export function hookAsk(toolName: string, inputJson: string): { question: string; detail?: string } | undefined {
  if (LEAVE.has(toolName)) return undefined;
  let input: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(inputJson);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: the question alone.
  }
  const str = (key: string) => {
    const v = input[key];
    return typeof v === 'string' && v.trim() ? v : undefined;
  };
  const file = (key: string) => {
    const p = str(key);
    return p && tilde(p);
  };
  const words = (question: string, ...lines: (string | undefined)[]) => {
    const detail = lines.filter((l): l is string => !!l).join('\n');
    return detail ? { question, detail: clip(visible(detail)) } : { question };
  };
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return words('Run a command?', str('command'));
    case 'Edit':
    case 'MultiEdit':
      return words('Edit a file?', file('file_path'));
    case 'Write':
      return words('Write a file?', file('file_path'));
    case 'NotebookEdit':
      return words('Edit a notebook?', file('notebook_path'));
    case 'Read':
      return words('Read a file?', file('file_path'));
    case 'Glob':
    case 'Grep':
      return words('Search files?', str('pattern'), file('path'));
    case 'WebFetch':
      return words('Fetch a web page?', str('url'));
    case 'WebSearch':
      return words('Search the web?', str('query'));
  }
  const json = Object.keys(input).length ? JSON.stringify(input, null, 1) : undefined;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return words(mcp ? `Use ${mcp[2]} (${mcp[1]})?` : `Use ${toolName}?`, json);
}

/**
 * Calls `answered` once the transcript gets a tool result written after now (the ask was answered in
 * Claude Code, either way); returns the stop. Undefined for a path that isn't a Claude Code transcript
 * under `<home>/.claude/projects`, which is then never read.
 */
export function watchAnswered(transcript: string, home: string, answered: () => void, intervalMs = 1000): (() => void) | undefined {
  const root = path.join(home, '.claude', 'projects') + path.sep;
  const file = path.resolve(transcript);
  if (!path.isAbsolute(transcript) || !file.startsWith(root) || path.extname(file) !== '.jsonl') return undefined;
  let offset: number | undefined;
  const listener = (cur: Stats) => {
    if (offset === undefined || cur.size < offset) offset = cur.size;
    if (cur.size === offset) return;
    const length = Math.min(cur.size - offset, MAX_READ);
    const buf = Buffer.alloc(length);
    let fd: number | undefined;
    try {
      fd = openSync(file, 'r');
      readSync(fd, buf, 0, length, offset);
    } catch {
      return;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    offset += length;
    if (!buf.toString('utf8').includes('"tool_result"')) return;
    stop();
    answered();
  };
  const stop = () => unwatchFile(file, listener);
  watchFile(file, { interval: intervalMs, persistent: false }, listener);
  // The size now: only what comes after the ask counts.
  try {
    offset = statSync(file).size;
  } catch {
    offset = 0;
  }
  return stop;
}
