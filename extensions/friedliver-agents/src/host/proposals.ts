// What a permission request would write. Agents send diffs in different
// shapes: a whole new file (oldText null), Claude's Edit (old_string →
// new_string), Codex's hunks with context, Gemini's whole old and new file.
// Applied to the file on disk they give the whole proposed file, which the
// permission card shows as a diff and "Open diff" shows in the diff editor.
import type * as acp from '@agentclientprotocol/sdk';
import { diffPreview } from '../shared/diff';
import type { ProposedFile } from '../shared/tools';

export type DiffEntry = acp.Diff & { type: 'diff' };

export interface Proposal {
  path: string;
  /** The file on disk now; null when it doesn't exist. */
  before: string | null;
  /** The whole file after the change, when it could be built. */
  after?: string;
  /** The agent's diffs for the file. */
  entries: DiffEntry[];
}

/** The diffs in a tool call's content, grouped by file, in order. */
export function diffsByFile(content: acp.ToolCallContent[] | null | undefined): Map<string, DiffEntry[]> {
  const out = new Map<string, DiffEntry[]>();
  for (const c of content ?? []) {
    if (c?.type !== 'diff' || typeof c.path !== 'string' || !c.path) continue;
    out.set(c.path, [...(out.get(c.path) ?? []), c]);
  }
  return out;
}

/**
 * The whole new file from the file on disk and the agent's diffs, or undefined
 * when a snippet isn't in the file (it changed meanwhile, or the agent's diff
 * is against something else). `replaceAll` follows Claude's Edit `replace_all`.
 */
export function applyDiffs(before: string | null, entries: DiffEntry[], replaceAll = false): string | undefined {
  let text = before;
  for (const e of entries) {
    const next = typeof e.newText === 'string' ? e.newText : '';
    if (e.oldText == null) {
      text = next;
      continue;
    }
    if (text === null) {
      if (e.oldText !== '') return undefined;
      text = next;
      continue;
    }
    if (e.oldText === text) {
      text = next;
    } else if (e.oldText && text.includes(e.oldText)) {
      text = replaceAll ? text.split(e.oldText).join(next) : text.replace(e.oldText, () => next);
    } else if (e.oldText === '' && text === '') {
      text = next;
    } else {
      return undefined;
    }
  }
  return text ?? undefined;
}

/** How a proposal reads on the card: against the file when FriedLiver built it, else the agent's own snippets. */
export function proposedFile(path: string, before: string | null, entries: DiffEntry[], after: string | undefined): ProposedFile {
  if (after !== undefined) {
    const p = diffPreview(before ?? '', after);
    return { path, ...p, isNew: before === null, full: true };
  }
  let added = 0;
  let removed = 0;
  const lines: ProposedFile['lines'] = [];
  let more = 0;
  for (const e of entries) {
    const p = diffPreview(e.oldText ?? '', e.newText ?? '');
    added += p.added;
    removed += p.removed;
    if (lines.length) lines.push({ op: ' ', text: '…' });
    lines.push(...p.lines);
    more += p.more;
  }
  return { path, added, removed, lines: lines.slice(0, 60), more: more + Math.max(0, lines.length - 60), isNew: entries.every((e) => e.oldText == null), full: false };
}
