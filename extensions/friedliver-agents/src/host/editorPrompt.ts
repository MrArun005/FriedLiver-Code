// What an agent gets when it is asked from the editor: an edit request about
// a selection, or code the user points at. Plain text, no VS Code, so the
// shapes are easy to test. The editor glue is in editor.ts.
import path from 'node:path';
import { MENTIONS, type AgentKey, type CodeRef } from '../shared/model';

/** Lines before and after the selection that go with an edit request. */
export const AROUND_LINES = 5;

export const PROMPT_LIMITS = {
  /** Characters of selected code an edit request or a reference carries; the agent reads the file for more. */
  code: 24_000,
  /** Characters kept of each line shown around the selection. */
  line: 400,
  /** Characters of all the references one message carries. */
  references: 48_000,
  /** Characters of a problem's message in a "Fix with Agent" instruction. */
  problem: 600,
};

/** A position as VS Code has it: 0-based line and character. */
export interface Pos {
  line: number;
  character: number;
}

export interface Span {
  start: Pos;
  end: Pos;
}

/** Where the code came from: what the user selected, or what FriedLiver took when nothing was selected. */
export type SpanKind = 'selection' | 'function' | 'line' | 'problem';

/**
 * The edit box's text: "@gemini make it async" is Gemini and "make it async".
 * Only mentions at the very start count; with several, the last one wins, so
 * what is left never starts with one (core.send would read that as asking
 * another agent).
 */
export function parseEditInput(text: string): { agent?: AgentKey; instruction: string } {
  let rest = text.trim();
  let agent: AgentKey | undefined;
  for (;;) {
    const m = rest.match(/^@([a-z]+)(?![\w-])[\s,:]*/i);
    const named = m ? MENTIONS[m[1].toLowerCase()] : undefined;
    if (!m || !named) break;
    agent = named;
    rest = rest.slice(m[0].length);
  }
  return { agent, instruction: rest.trim() };
}

/** The 1-based lines a span covers. A selection that ends at the start of a line doesn't take that line. */
export function lineSpan(span: Span): { startLine: number; endLine: number } {
  let end = span.end.line;
  if (span.end.character === 0 && end > span.start.line) end--;
  return { startLine: span.start.line + 1, endLine: Math.max(span.start.line, end) + 1 };
}

/** "12" or "12-18"; chips pass an en dash. */
export function formatLines(r: { startLine: number; endLine: number }, dash = '-'): string {
  return r.startLine === r.endLine ? `${r.startLine}` : `${r.startLine}${dash}${r.endLine}`;
}

/** How an agent working in `cwd` should see a file: relative with forward slashes, or absolute when it is outside. */
export function promptPath(cwd: string, file: string): string {
  const rel = path.relative(cwd, file);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return file;
  return rel.split(path.sep).join('/');
}

/** "format.ts:12–18", for chips, titles and the status bar. */
export function refLabel(ref: CodeRef): string {
  return `${path.basename(ref.path)}:${formatLines(ref, '–')}`;
}

/** A fenced code block whose fence is longer than any run of backticks in the code. */
export function fence(code: string, languageId = ''): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = '`'.repeat(longest + 1);
  const lang = languageId.replace(/[^\w+#.-]/g, '');
  return `${marks}${lang}\n${code.replace(/\r?\n$/, '')}\n${marks}`;
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** The text a span covers, from a document's lines. */
export function textOf(lines: readonly string[], span: Span): string {
  const { start, end } = span;
  if (start.line >= lines.length) return '';
  if (start.line === end.line) return (lines[start.line] ?? '').slice(start.character, end.character);
  const out = [(lines[start.line] ?? '').slice(start.character)];
  for (let n = start.line + 1; n < Math.min(end.line, lines.length); n++) out.push(lines[n]);
  if (end.line < lines.length) out.push(lines[end.line].slice(0, end.character));
  return out.join('\n');
}

/** Code cut to `max` characters at a line break, saying where it stopped. */
export function capCode(code: string, max: number, lastLine: number): string {
  if (code.length <= max) return code;
  const cut = code.slice(0, max);
  const at = cut.lastIndexOf('\n');
  const kept = at > 0 ? cut.slice(0, at) : cut;
  return `${kept}\n[… cut here: the code goes on to line ${lastLine}. Read the file for the rest.]`;
}

const clipLine = (line: string) => (line.length > PROMPT_LIMITS.line ? `${line.slice(0, PROMPT_LIMITS.line)} [… line cut]` : line);

export interface EditRequest {
  /** The agent's folder: paths are given relative to it. */
  cwd: string;
  /** Absolute path of the file. */
  file: string;
  languageId: string;
  /** The document's whole text. */
  text: string;
  span: Span;
  kind: SpanKind;
}

/** Marks an edit request; the Demo agent looks for it. */
export const EDIT_MARK = '[FriedLiver] Edit in the editor';
/** Marks code references sent with a message. */
export const REFS_MARK = '[FriedLiver] Code the user points at in the editor';

/**
 * The context in front of the user's instruction: which file, which lines,
 * the code and a few lines around it, and to change only what is asked.
 * The instruction itself goes after it, as the message.
 */
export function editPrompt(req: EditRequest): string {
  const lines = splitLines(req.text);
  const { startLine, endLine } = lineSpan(req.span);
  const where = formatLines({ startLine, endLine });
  const s = req.span;
  const about: Record<SpanKind, string> = {
    selection: `selected, from ${s.start.line + 1}:${s.start.character + 1} to ${s.end.line + 1}:${s.end.character + 1}`,
    function: 'the function around the cursor; nothing is selected',
    line: 'the line with the cursor; nothing is selected',
    problem: 'where the problem is',
  };
  const code = req.kind === 'selection' ? textOf(lines, req.span) : lines.slice(startLine - 1, endLine).join('\n');
  const parts = [
    [
      EDIT_MARK,
      'The user is looking at the code below in their editor and asks for a change; their message follows. ' +
        'Make the change by writing the file: FriedLiver shows the user your edit as a diff to accept or reject. ' +
        'Change only what they ask for, and only in this file, unless they say otherwise. Keep the rest of the file as it is. ' +
        'If the message is a question rather than a change, answer it without editing.',
    ].join('\n'),
    [`File: ${promptPath(req.cwd, req.file)}`, `Language: ${req.languageId}`, `Lines: ${where} (${about[req.kind]})`].join('\n'),
    `Code:\n${fence(capCode(code, PROMPT_LIMITS.code, endLine), req.languageId)}`,
  ];
  const before = lines.slice(Math.max(0, startLine - 1 - AROUND_LINES), startLine - 1);
  if (before.length) {
    const from = startLine - before.length;
    parts.push(`Before it (lines ${formatLines({ startLine: from, endLine: startLine - 1 })}):\n${fence(before.map(clipLine).join('\n'), req.languageId)}`);
  }
  const after = lines.slice(endLine, endLine + AROUND_LINES);
  // A file's last line break leaves an empty "line" that isn't worth showing.
  if (after.length && !(after.length === 1 && after[0] === '')) {
    parts.push(`After it (lines ${formatLines({ startLine: endLine + 1, endLine: endLine + after.length })}):\n${fence(after.map(clipLine).join('\n'), req.languageId)}`);
  }
  return parts.join('\n\n');
}

/** "Fix this error: … (ts 2322)", the instruction "Fix with Agent" sends. */
export function problemInstruction(problem: { severity: 'error' | 'warning'; message: string; source?: string; code?: string | number }): string {
  const message = problem.message.replace(/\s+/g, ' ').trim();
  const clipped = message.length > PROMPT_LIMITS.problem ? `${message.slice(0, PROMPT_LIMITS.problem)}…` : message;
  const origin = [problem.source, problem.code].filter((x) => x !== undefined && x !== '').join(' ');
  return `Fix this ${problem.severity}: ${clipped}${origin ? ` (${origin})` : ''}`;
}

/** One reference: "src/format.ts:12-18" over the code in a fence. */
export function referenceBlock(cwd: string, ref: CodeRef, code: string, languageId: string): string {
  return `${promptPath(cwd, ref.path)}:${formatLines(ref)}\n${fence(capCode(code, PROMPT_LIMITS.code, ref.endLine), languageId)}`;
}

/** The references a message carries, in front of the message, within PROMPT_LIMITS.references. */
export function referencesContext(blocks: string[]): string {
  const kept: string[] = [];
  let size = 0;
  for (const b of blocks) {
    if (kept.length && size + b.length > PROMPT_LIMITS.references) {
      kept.push(`[${blocks.length - kept.length} more reference${blocks.length - kept.length === 1 ? '' : 's'} left out: too long.]`);
      break;
    }
    kept.push(b);
    size += b.length;
  }
  return `${REFS_MARK}:\n\n${kept.join('\n\n')}`;
}
