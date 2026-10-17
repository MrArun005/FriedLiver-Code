// Inline edit (Ctrl/Cmd+I): the agent proposes replacement text for the
// selection and never touches the file; FriedLiver applies it only when the
// user accepts. Plain text and the core, no VS Code, so it is easy to test.
// The editor glue is in inlineEditor.ts.
import { lastReply, type AgentKey, type Item } from '../shared/model';
import type { AgentCore } from './core';
import { fence, formatLines, promptPath, splitLines, textOf, type Span } from './editorPrompt';

/** Lines before and after the selection the agent sees. */
export const INLINE_AROUND = 80;
export const INLINE_LIMITS = {
  /** Characters of the selection itself. Longer selections are refused, not cut: the reply replaces all of it. */
  selection: 40_000,
  /** Characters of each side's surrounding context. */
  around: 12_000,
  /** Characters kept of one context line. */
  line: 400,
};

export const INLINE_MARK = '[FriedLiver] Inline edit';

export interface InlineRequest {
  cwd: string;
  file: string;
  languageId: string;
  text: string;
  span: Span;
  /** The previous proposal and what the user said about it, for Retry with a follow-up. */
  previous?: { replacement: string; followUp: string };
}

const isEmpty = (s: Span) => s.start.line === s.end.line && s.start.character === s.end.character;
const clip = (l: string) => (l.length > INLINE_LIMITS.line ? `${l.slice(0, INLINE_LIMITS.line)} [… line cut]` : l);

/** Lines kept within `max` characters, dropping from the far end (`fromStart`: the start is far). */
export function capLines(lines: string[], max: number, fromStart: boolean): string[] {
  const out: string[] = [];
  let size = 0;
  const ordered = fromStart ? [...lines].reverse() : lines;
  for (const l of ordered) {
    const c = clip(l);
    if (size + c.length + 1 > max) break;
    out.push(c);
    size += c.length + 1;
  }
  return fromStart ? out.reverse() : out;
}

/** The context the agent gets in front of the instruction. Throws when the selection is too long to replace whole. */
export function inlinePrompt(req: InlineRequest): string {
  const lines = splitLines(req.text);
  const { start, end } = req.span;
  const selected = textOf(lines, req.span);
  if (selected.length > INLINE_LIMITS.selection) throw new Error(`The selection is too long for an inline edit (${selected.length} characters, at most ${INLINE_LIMITS.selection}). Select less, or use Edit with Agent.`);
  const cursor = isEmpty(req.span);
  const before = capLines(lines.slice(Math.max(0, start.line - INLINE_AROUND), start.line), INLINE_LIMITS.around, true);
  const after = capLines(lines.slice(end.line + 1, end.line + 1 + INLINE_AROUND), INLINE_LIMITS.around, false);
  const where = cursor ? `the cursor at ${start.line + 1}:${start.character + 1}` : `the selection from ${start.line + 1}:${start.character + 1} to ${end.line + 1}:${end.character + 1}`;
  const parts = [
    [
      INLINE_MARK,
      `Propose ${cursor ? 'code to insert at the cursor' : 'a replacement for the selected code'} that does what the user asks; their instruction follows.`,
      'Do NOT write, edit or create any file and do not run commands: FriedLiver applies your text itself if the user accepts it.',
      `Reply with exactly one fenced code block holding ${cursor ? 'only the code to insert' : 'only the new code for the selection, nothing before or after it'}, keeping its indentation. A short sentence outside the block is fine.`,
    ].join('\n'),
    [`File: ${promptPath(req.cwd, req.file)}`, `Language: ${req.languageId}`, `Where: ${where}`].join('\n'),
    `Line ${start.line + 1} up to the ${cursor ? 'cursor' : 'selection'}: ${fence(clip(lines[start.line]?.slice(0, start.character) ?? ''), req.languageId)}`,
  ];
  if (before.length) parts.push(`Before it (lines ${formatLines({ startLine: start.line - before.length + 1, endLine: start.line })}):\n${fence(before.join('\n'), req.languageId)}`);
  if (!cursor) parts.push(`Selected code:\n${fence(selected, req.languageId)}`);
  parts.push(`Rest of line ${end.line + 1} after it: ${fence(clip(lines[end.line]?.slice(end.character) ?? ''), req.languageId)}`);
  if (after.length) parts.push(`After it (lines ${formatLines({ startLine: end.line + 2, endLine: end.line + 1 + after.length })}):\n${fence(after.join('\n'), req.languageId)}`);
  if (req.previous) parts.push(`Your last proposal, which the user wants changed:\n${fence(req.previous.replacement, req.languageId)}\nTheir follow-up: ${req.previous.followUp}`);
  return parts.join('\n\n');
}

/**
 * The replacement in an agent's reply: the last complete fenced block (the
 * final answer when it showed drafts), or, while streaming, an unclosed one.
 * With no fence at all, the whole reply when `bare` is true, else undefined.
 */
export function parseReplacement(reply: string, bare = true): string | undefined {
  const fenceRe = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\1?[ \t]*\2[`~]*[ \t]*$/gm;
  let last: string | undefined;
  for (const m of reply.matchAll(fenceRe)) last = m[3].replace(/\n$/, '');
  if (last !== undefined) return last;
  const open = reply.match(/^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*)$/m);
  if (open) return open[2].replace(/\n$/, '');
  return bare && reply.trim() ? reply.replace(/^\n+|\n+$/g, '') : undefined;
}

/** The document with only the span replaced: what Accept produces. */
export function applyReplacement(text: string, span: Span, replacement: string): string {
  const starts = [0, ...[...text.matchAll(/\n/g)].map((m) => m.index + 1)];
  const offset = (p: Span['start']) => (starts[p.line] ?? text.length) + p.character;
  return text.slice(0, offset(span.start)) + replacement + text.slice(offset(span.end));
}

export interface InlineRun {
  /** Resolves with the proposal, or an error the user should see; undefined when cancelled. */
  done: Promise<{ replacement?: string; reply: string; error?: string } | undefined>;
  cancel(): void;
}

/**
 * One throwaway chat: send the prompt, refuse anything the agent tries to do
 * (writes, commands, permissions, questions), parse its reply, remove the chat.
 * `onText` gets each partial proposal for a streaming preview.
 */
export function runInline(core: AgentCore, agent: AgentKey, context: string, instruction: string, onText?: (partial: string) => void, owned?: Set<string>): InlineRun {
  let cancelled = false;
  let chatId: string | undefined;
  let unsubscribe = () => {};
  const refuse = (items: Item[]) => {
    for (const i of items) {
      if (i.kind === 'review' && i.state === 'pending') core.decideReview(i.reviewId, false);
      else if (i.kind === 'permission' && !i.answer) core.answerPermission(i.requestId, null);
      else if (i.kind === 'command') core.decideCommand(i.commandId, false);
      else if (i.kind === 'bridge') core.answerBridge(i.requestId, 'deny');
      else if (i.kind === 'question') core.answerQuestion(i.requestId, 'decline');
    }
  };
  const done = (async () => {
    try {
      // Ask level: no write can go through without a review, and refuse() rejects every review.
      const chat = await core.createChat(agent, { title: 'Inline edit', approval: 'ask' });
      chatId = chat.id;
      owned?.add(chat.id);
      unsubscribe = core.onAction((action) => {
        if ((action.t !== 'items' && action.t !== 'update') || action.chatId !== chatId) return;
        if (action.t === 'items') refuse(action.items);
        const now = core.chat(chat.id);
        const partial = now && parseReplacement(lastReply(now), false);
        if (partial !== undefined && !cancelled) onText?.(partial);
      });
      if (cancelled) return undefined;
      await core.send(chat.id, instruction, [], { context, title: instruction });
      if (cancelled) return undefined;
      const after = core.chat(chat.id);
      const reply = after ? lastReply(after) : '';
      const at = after ? after.items.map((i) => i.kind).lastIndexOf('user') : -1;
      const error = after?.items.slice(at + 1).filter((i) => i.kind === 'notice' && i.tone === 'error').at(-1);
      const replacement = parseReplacement(reply);
      if (error?.kind === 'notice' && replacement === undefined) return { reply, error: error.text };
      if (replacement === undefined) return { reply, error: 'The agent proposed no code.' };
      return { replacement, reply };
    } finally {
      unsubscribe();
      if (chatId) {
        await core.removeChat(chatId).catch(() => {});
        owned?.delete(chatId);
      }
    }
  })();
  return {
    done,
    cancel: () => {
      cancelled = true;
      if (chatId) void core.cancel(chatId).catch(() => {});
    },
  };
}
