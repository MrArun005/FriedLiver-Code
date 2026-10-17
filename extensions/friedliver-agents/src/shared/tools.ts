// What a tool call did, as the transcript keeps it: diffs and output text, cut
// short, never markup. And what a permission request asks to approve.
import type * as acp from '@agentclientprotocol/sdk';
import { diffPreview, type DiffLine } from './diff';

export type ToolOut =
  | { t: 'diff'; path: string; added: number; removed: number; lines: DiffLine[]; more: number; isNew: boolean }
  | { t: 'text'; text: string }
  /** A FriedLiver terminal: its command card shows the output. */
  | { t: 'terminal'; terminalId: string };

/** Output text one tool call keeps: the end, where errors and results are. */
export const MAX_TOOL_TEXT = 16 * 1024;
/** Characters of a tool's input kept for "Show input". */
export const MAX_TOOL_INPUT = 4 * 1024;
const MAX_DIFFS = 8;

function tail(text: string, max = MAX_TOOL_TEXT): string {
  return text.length <= max ? text : `…\n${text.slice(-max)}`;
}

/** A tool call's content as the transcript shows it, or undefined when it has none worth showing. */
export function toolOut(content: acp.ToolCallContent[] | null | undefined): ToolOut[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const out: ToolOut[] = [];
  let diffs = 0;
  for (const c of content) {
    if (c?.type === 'diff' && typeof c.path === 'string') {
      if (diffs++ >= MAX_DIFFS) continue;
      const p = diffPreview(c.oldText ?? null, typeof c.newText === 'string' ? c.newText : '');
      out.push({ t: 'diff', path: c.path, added: p.added, removed: p.removed, lines: p.lines, more: p.more, isNew: c.oldText == null });
    } else if (c?.type === 'terminal' && typeof c.terminalId === 'string') {
      out.push({ t: 'terminal', terminalId: c.terminalId });
    } else if (c?.type === 'content') {
      const block = c.content;
      const text = block?.type === 'text' ? block.text : block?.type === 'resource_link' ? block.uri : block?.type === 'resource' && 'text' in block.resource ? block.resource.text : undefined;
      if (typeof text === 'string' && text.trim()) out.push({ t: 'text', text: tail(text) });
    }
  }
  return out.length ? out : undefined;
}

/** Output an agent streams in `_meta` (Codex's `terminal_output_delta`, the `terminal_output` extension). */
export function streamedOutput(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const m = meta as Record<string, { data?: unknown } | undefined>;
  const data = m.terminal_output_delta?.data ?? m.terminal_output?.data;
  return typeof data === 'string' && data ? data : undefined;
}

/** What claude-agent-acp says in `_meta.claudeCode`: the tool's name, and the subagent call it ran in. */
export function claudeMeta(meta: unknown): { tool?: string; parent?: string } {
  const c = meta && typeof meta === 'object' ? (meta as { claudeCode?: unknown }).claudeCode : undefined;
  if (!c || typeof c !== 'object') return {};
  const { toolName, parentToolUseId } = c as Record<string, unknown>;
  return {
    ...(typeof toolName === 'string' && toolName ? { tool: toolName.slice(0, 128) } : {}),
    ...(typeof parentToolUseId === 'string' && parentToolUseId ? { parent: parentToolUseId.slice(0, 128) } : {}),
  };
}

/** Appends streamed output to a tool's text, keeping only the end. */
export function appendOutput(out: ToolOut[] | undefined, data: string): ToolOut[] {
  const list = out ? [...out] : [];
  const at = list.findIndex((o) => o.t === 'text');
  if (at < 0) return [...list, { t: 'text', text: tail(data) }];
  const prev = list[at] as Extract<ToolOut, { t: 'text' }>;
  list[at] = { t: 'text', text: tail(prev.text + data) };
  return list;
}

/** A tool's input, as indented JSON for "Show input", cut short. */
export function toolInput(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  let json: string;
  try {
    json = JSON.stringify(raw, null, 2);
  } catch {
    return undefined;
  }
  if (!json || json === '{}') return undefined;
  return json.length > MAX_TOOL_INPUT ? `${json.slice(0, MAX_TOOL_INPUT)}\n…` : json;
}

/** The command a tool runs, from its input: Claude's `command`, Codex's `command` (a string or argv). */
export function commandOf(rawInput: unknown): { line: string; cwd?: string } | undefined {
  if (!rawInput || typeof rawInput !== 'object') return undefined;
  const r = rawInput as Record<string, unknown>;
  const cmd = r.command ?? r.cmd;
  const line = typeof cmd === 'string' ? cmd : Array.isArray(cmd) && cmd.every((a) => typeof a === 'string') ? cmd.join(' ') : undefined;
  if (!line?.trim()) return undefined;
  return { line, cwd: typeof r.cwd === 'string' ? r.cwd : typeof r.workdir === 'string' ? r.workdir : undefined };
}

/** A plan to approve: Claude's ExitPlanMode and Codex's plan review carry it in `plan`. */
export function planOf(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== 'object') return undefined;
  const plan = (rawInput as Record<string, unknown>).plan;
  return typeof plan === 'string' && plan.trim() ? plan.slice(0, 64 * 1024) : undefined;
}

/** Option names that change the agent's mode or keep allowing: never picked for you, and never the loud button. */
export const ESCALATING = /bypass|auto mode|auto-accept|don['’]t ask again|always|full access|yolo|clear context/i;

/** What each kind of answer does, spelled out on its button. */
export const OPTION_KINDS: Record<string, string> = {
  allow_once: 'Allows this once',
  allow_always: 'Allows this and the same again later, without asking',
  reject_once: 'Says no this time',
  reject_always: 'Says no now and to the same again later',
};

/** The answer a shortcut or a notification gives for "yes": the first one-time allow that changes nothing else. */
export function primaryOption<T extends { kind: string; name: string }>(options: T[]): T | undefined {
  return options.find((o) => o.kind === 'allow_once' && !ESCALATING.test(o.name));
}

export function denyOption<T extends { kind: string }>(options: T[]): T | undefined {
  return options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind.startsWith('reject'));
}

/** One file a permission request would change, with the whole proposed text when FriedLiver could build it. */
export interface ProposedFile {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
  more: number;
  isNew: boolean;
  /** FriedLiver built the whole new file, so "Open diff" can show it against the file on disk. */
  full: boolean;
}

/** What a permission request asks to approve, shown on its card. */
export interface PermissionDetail {
  command?: { line: string; cwd?: string };
  files?: ProposedFile[];
  /** Markdown. */
  plan?: string;
  /** Other content the agent sent with the request, e.g. why. */
  text?: string;
  locations?: string[];
}
