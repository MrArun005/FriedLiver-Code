// One Claude Code subagent from outside FriedLiver, read from its own transcript for the Agent Manager's
// detail sheet (host/subagentDetail.ts reads it; webview/subagentDetail.tsx draws it). Read-only.
import type { Item } from './model';

export type SubagentTool = Extract<Item, { kind: 'tool' }> & { seq: number; rev: number };
/** What it said (or thought, when the transcript keeps it), condensed; `caller`: a message its caller sent it. */
export type SubagentNote = { kind: 'note'; id: string; seq: number; rev: number; text: string; thinking?: true; caller?: true };
export type SubagentEntry = SubagentTool | SubagentNote;

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SubagentFile {
  path: string;
  edits: number;
  reads: number;
}

export interface SubagentDetail {
  sessionId: string;
  /** The subagent's id in the session (its Agent call's tool-use id), as ClaudeSubagent.id. */
  id: string;
  /** The brief it was given, secrets taken out. */
  prompt: string;
  agentType?: string;
  model?: string;
  /** Its first and latest record, ms since the epoch. */
  startedAt?: number;
  lastAt?: number;
  usage: SubagentUsage;
  /**
   * Entries added or changed since the update the view last got (all of them when `reset`), oldest first.
   * The view keeps a window: entries older than `first` (a seq) are dropped.
   */
  entries: SubagentEntry[];
  reset: boolean;
  first: number;
  /** Entries it has had in all (steps and notes). */
  total: number;
  /** Files it changed or read, the most changed first. */
  files: SubagentFile[];
  filesMore: number;
  /** Its hand-back, or its last words when it stopped without one. */
  report?: string;
  /** A transcript too large to read whole: only its end was read, so totals count from there. */
  partial?: true;
}

/**
 * Who launched a subagent, as a labelled field: "Parent chat · <title>" or "Parent session · <title>". It used to be
 * composed as "of <title> (Claude Code, outside FriedLiver)", which read as a sentence cut off at the front.
 */
export function parentLine(p: { chat?: { title: string }; session?: { title: string } }): { label: string; title: string } | undefined {
  if (p.chat) return { label: 'Parent chat', title: p.chat.title };
  if (p.session) return { label: 'Parent session', title: p.session.title };
  return undefined;
}

/** The view's window of entries after an update: changed ones replaced in place, new ones added, old ones dropped. */
export function mergeEntries(prev: readonly SubagentEntry[], d: Pick<SubagentDetail, 'entries' | 'reset' | 'first'>): SubagentEntry[] {
  const base = d.reset ? [] : prev.filter((e) => e.seq >= d.first);
  if (!d.entries.length) return base.length === prev.length ? (prev as SubagentEntry[]) : base;
  const at = new Map(base.map((e, n) => [e.id, n]));
  const out = [...base];
  for (const e of d.entries) {
    const n = at.get(e.id);
    if (n === undefined) {
      at.set(e.id, out.length);
      out.push(e);
    } else out[n] = e;
  }
  return out.sort((a, b) => a.seq - b.seq);
}
