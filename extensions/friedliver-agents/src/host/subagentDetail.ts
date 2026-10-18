// What one Claude Code subagent from outside FriedLiver was asked, did and reported, read from its transcript
// (~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl) for the Agent Manager's detail sheet.
// Read-only. The file is read once and then only what was appended (claudeSessions' advance); what is kept is
// bounded: the last WINDOW entries, the in-flight calls, totals, and up to MAX_FILES file names.
import { lstat, open } from 'node:fs/promises';
import { diffPreview } from '../shared/diff';
import { redactSecrets } from '../shared/redact';
import { sensitivePath } from '../shared/risk';
import { cut } from '../shared/steps';
import type { SubagentDetail, SubagentEntry, SubagentFile, SubagentNote, SubagentTool, SubagentUsage } from '../shared/subagentDetail';
import { advance, findSubagent, type Block, type Line, type TailStore } from './claudeSessions';

/** Entries kept: the newest. */
export const WINDOW = 300;
const MAX_FILES = 500;
const FILES_SENT = 100;
const MAX_PROMPT = 100_000;
const MAX_REPORT = 100_000;
const MAX_NOTE = 2000;
const MAX_THOUGHT = 600;
const MAX_OUT = 2048;
const MAX_IN = 2048;
const MAX_DIFF_IN = 8192;
/** A transcript larger than this is read from this far before its end. */
export const MAX_READ = 32 * 1024 * 1024;
const HANDBACK = 'SubagentHandback';

const KIND: Record<string, string> = {
  Bash: 'execute',
  Read: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Grep: 'search',
  Glob: 'search',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
  Agent: 'think',
  Task: 'think',
  TodoWrite: 'think',
};
const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

type Msg = { id?: string; model?: string; usage?: Record<string, unknown>; content?: string | Block[] };

export interface DetailState {
  prompt?: string;
  promptCut?: boolean;
  model?: string;
  startedAt?: number;
  lastAt?: number;
  usage: SubagentUsage;
  /** The latest assistant message and what it added to `usage`: one message streams as several lines, each with its usage so far. */
  lastMsg?: { id: string; usage: SubagentUsage };
  entries: SubagentEntry[];
  seq: number;
  rev: number;
  /** Calls waiting for their result, by tool-use id. */
  pending: Map<string, SubagentTool>;
  /** Pending calls on a file that holds secrets: their output isn't kept. */
  secret: Set<string>;
  files: Map<string, SubagentFile>;
  filesMore: number;
  handback?: string;
  lastText?: string;
  /** The latest assistant message called no tool: it stopped talking. */
  quiet: boolean;
  partial: boolean;
}

export const newDetail = (partial = false): DetailState => ({
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  entries: [],
  seq: 0,
  rev: 0,
  pending: new Map(),
  secret: new Set(),
  files: new Map(),
  filesMore: 0,
  quiet: false,
  partial,
});

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: Block) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n') : '';
const tail = (t: string, max: number) => (t.length <= max ? t : `…\n${t.slice(-max)}`);

function push(s: DetailState, e: Omit<SubagentTool, 'seq' | 'rev'> | Omit<SubagentNote, 'seq' | 'rev'>): SubagentEntry {
  const entry = { ...e, seq: ++s.seq, rev: ++s.rev } as SubagentEntry;
  s.entries.push(entry);
  if (s.entries.length > WINDOW) s.entries.splice(0, s.entries.length - WINDOW);
  return entry;
}

function touch(s: DetailState, file: string, edit: boolean): void {
  let f = s.files.get(file);
  if (!f) {
    if (s.files.size >= MAX_FILES) {
      s.filesMore++;
      return;
    }
    f = { path: file, edits: 0, reads: 0 };
    s.files.set(file, f);
  }
  if (edit) f.edits++;
  else f.reads++;
}

export const HIDDEN = '(not shown: a file that holds secrets)';
const careful = (p: string) => !!p && !p.includes('\0') && !!sensitivePath(p.replace(/^['"]|['"]$/g, ''))?.careful;

/**
 * Whether a call touches a file that holds secrets (.env*, keys, ~/.ssh, .git…): its file, its search path, or, for a
 * command, any word of it that names one (`cat .env`, `--file=id_rsa`). Its contents then aren't shown, only the call.
 */
export function holdsSecrets(name: string, input: Record<string, unknown>): boolean {
  const file = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  if (file && careful(file)) return true;
  if (name !== 'Bash') return false;
  // ponytail: word scan, not a shell parser; a path built at run time ($HOME/.env via a variable) isn't seen.
  return (str(input.command) ?? '').slice(0, 64 * 1024).split(/[\s|;&<>()=,`]+/).some(careful);
}

/** A tool call as the chat's step rows show one: a title its verb reads from, a kind, the command, a diff, the input. */
function toolStep(b: Block, secret: boolean): Omit<SubagentTool, 'seq' | 'rev'> {
  const name = b.name ?? 'Tool';
  const input = (b.input ?? {}) as Record<string, unknown>;
  const file = str(input.file_path) ?? str(input.notebook_path);
  const base = { kind: 'tool' as const, id: b.id ?? '', tool: name, toolKind: KIND[name], status: 'in_progress', locations: file ? [file] : [] };
  const about = str(input.description);
  if (name === 'Bash') {
    const line = redactSecrets(str(input.command) ?? '');
    return { ...base, title: cut(line.replace(/\s+/g, ' '), 200), cmd: { line: cut(line, 4096), ...(line.length > 4096 ? { cut: true as const } : {}) }, ...(about ? { about: redactSecrets(about) } : {}) };
  }
  if (EDITS.has(name) && file && secret) return { ...base, title: `${name === 'Write' ? 'Write' : 'Edit'} ${file}`, out: [{ t: 'text', text: HIDDEN }] };
  if (EDITS.has(name) && file) {
    const old = name === 'Write' ? null : redactSecrets((str(input.old_string) ?? '').slice(0, MAX_DIFF_IN));
    const now = redactSecrets((str(input.new_string) ?? str(input.content) ?? str(input.new_source) ?? '').slice(0, MAX_DIFF_IN));
    const edits = name === 'MultiEdit' && Array.isArray(input.edits) ? input.edits.length : 0;
    const p = edits ? null : diffPreview(old, now);
    return {
      ...base,
      title: `${name === 'Write' ? 'Write' : 'Edit'} ${file}`,
      ...(p ? { out: [{ t: 'diff' as const, path: file, added: p.added, removed: p.removed, lines: p.lines, more: p.more, isNew: old === null }] } : { input: `${edits} edits` }),
    };
  }
  const title =
    name === 'Read' && file
      ? `Read ${file}`
      : name === 'Grep'
        ? `grep ${str(input.pattern) ?? ''}${str(input.path) ? ` ${input.path}` : ''}`
        : name === 'Glob'
          ? `Find ${str(input.pattern) ?? ''}`
          : name === 'WebFetch'
            ? `Fetch ${str(input.url) ?? ''}`
            : name === 'WebSearch'
              ? `Search ${str(input.query) ?? ''}`
              : (name === 'Agent' || name === 'Task') && about
                ? about
                : name;
  const shown = secret || name === 'Read' || name === 'Glob' || name === 'Grep' ? '' : redactSecrets(JSON.stringify(input, null, 2) ?? '');
  return { ...base, title: redactSecrets(cut(title, 300)), ...(shown && shown !== '{}' ? { input: cut(shown, MAX_IN) } : {}) };
}

function addUsage(s: DetailState, m: Msg): void {
  const u = m.usage;
  if (!u || typeof u !== 'object') return;
  const now: SubagentUsage = { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens) };
  const id = m.id ?? `anon-${s.seq}`;
  const was = s.lastMsg?.id === id ? s.lastMsg.usage : undefined;
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) s.usage[k] += now[k] - (was?.[k] ?? 0);
  s.lastMsg = { id, usage: now };
}

export function feedDetail(s: DetailState, o: Line): void {
  if ((o.type !== 'user' && o.type !== 'assistant') || !o.message) return;
  const m = o.message as Msg;
  const at = Date.parse(o.timestamp ?? '');
  if (!Number.isNaN(at)) {
    s.startedAt ??= at;
    s.lastAt = at;
  }
  const content = m.content;
  if (o.type === 'user') {
    if (o.isMeta) return;
    const said = typeof content === 'string' ? content : Array.isArray(content) && !content.some((b) => b.type === 'tool_result') ? textOf(content) : undefined;
    if (said !== undefined) {
      if (!said.trim() || said.trimStart().startsWith('<')) return;
      if (s.prompt === undefined && !s.partial) {
        s.promptCut = said.length > MAX_PROMPT;
        s.prompt = redactSecrets(said.slice(0, MAX_PROMPT));
      } else {
        // A message from its caller (SendMessage, a resume): it runs again, so the earlier report no longer stands.
        push(s, { kind: 'note', id: `n${s.seq + 1}`, text: redactSecrets(cut(said.trim(), MAX_NOTE)), caller: true });
        s.handback = undefined;
        s.lastText = undefined;
        s.quiet = false;
      }
      return;
    }
    for (const b of Array.isArray(content) ? content : []) {
      if (b.type !== 'tool_result' || !b.tool_use_id) continue;
      const step = s.pending.get(b.tool_use_id);
      if (!step) continue;
      s.pending.delete(b.tool_use_id);
      step.status = b.is_error ? 'failed' : 'completed';
      if (step.startedAt !== undefined && !Number.isNaN(at)) step.ms = Math.max(0, at - step.startedAt);
      if (s.secret.delete(b.tool_use_id)) step.out = [{ t: 'text', text: HIDDEN }];
      else {
        const text = redactSecrets(tail(textOf(b.content), MAX_OUT));
        // An edit's diff says what it did; its "updated successfully" line adds nothing unless it failed.
        if (text.trim() && (!step.out?.length || b.is_error)) step.out = [...(step.out ?? []), { t: 'text', text }];
      }
      step.rev = ++s.rev;
    }
    return;
  }
  addUsage(s, m);
  if (m.model && !m.model.startsWith('<')) s.model = m.model;
  const blocks = Array.isArray(content) ? content : [];
  let calls = 0;
  for (const b of blocks) {
    if (b.type === 'tool_use' && b.id) {
      calls++;
      const input = (b.input ?? {}) as Record<string, unknown>;
      if (b.name === HANDBACK) {
        s.handback = redactSecrets(str(input.message)?.slice(0, MAX_REPORT) ?? '');
        continue;
      }
      const secret = holdsSecrets(b.name ?? '', input);
      const step = push(s, toolStep(b, secret)) as SubagentTool;
      if (!Number.isNaN(at)) step.startedAt = at;
      s.pending.set(b.id, step);
      if (secret) s.secret.add(b.id);
      // ponytail: a call whose result never comes stays pending; capped so a crashed run can't grow it.
      if (s.pending.size > WINDOW) {
        const oldest = s.pending.keys().next().value!;
        s.pending.delete(oldest);
        s.secret.delete(oldest);
      }
      const file = step.locations[0];
      if (file) touch(s, file, EDITS.has(b.name ?? ''));
    } else if (b.type === 'text' && b.text?.trim()) {
      s.lastText = redactSecrets(b.text.slice(0, MAX_REPORT));
      push(s, { kind: 'note', id: `n${s.seq + 1}`, text: redactSecrets(cut(b.text.trim(), MAX_NOTE)) });
    } else if (b.type === 'thinking' && typeof (b as { thinking?: string }).thinking === 'string' && (b as { thinking: string }).thinking.trim()) {
      push(s, { kind: 'note', id: `n${s.seq + 1}`, text: redactSecrets(cut((b as { thinking: string }).thinking.trim(), MAX_THOUGHT)), thinking: true });
    }
  }
  // One message streams as one line per block: a text line then a tool line. Only a message that ends on words is quiet.
  if (blocks.length) s.quiet = calls === 0 && blocks.some((b) => b.type === 'text');
}

/** What the view gets: the totals, and the entries changed since `since` (a rev; 0 = all). */
export function detailView(s: DetailState, ids: { sessionId: string; id: string; agentType?: string }, since: number): SubagentDetail {
  const files = [...s.files.values()].sort((a, b) => b.edits - a.edits || b.reads - a.reads);
  const report = s.handback || (s.quiet ? s.lastText : undefined);
  return {
    sessionId: ids.sessionId,
    id: ids.id,
    prompt: s.prompt ?? '',
    ...(ids.agentType ? { agentType: ids.agentType } : {}),
    ...(s.model ? { model: s.model } : {}),
    ...(s.startedAt !== undefined ? { startedAt: s.startedAt } : {}),
    ...(s.lastAt !== undefined ? { lastAt: s.lastAt } : {}),
    usage: { ...s.usage },
    entries: since ? s.entries.filter((e) => e.rev > since) : [...s.entries],
    reset: since === 0,
    first: s.entries[0]?.seq ?? s.seq + 1,
    total: s.seq,
    files: files.slice(0, FILES_SENT),
    filesMore: s.filesMore + Math.max(0, files.length - FILES_SENT),
    ...(report ? { report } : {}),
    ...(s.partial ? { partial: true as const } : {}),
  };
}

/** The whole transcript's text, for tests and the harness. Lines that aren't JSON (a cut-off last line) are skipped. */
export function parseSubagentDetail(text: string): DetailState {
  const s = newDetail();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o: unknown = JSON.parse(line);
      if (o && typeof o === 'object') feedDetail(s, o as Line);
    } catch {
      // A line still being written.
    }
  }
  return s;
}

/** The brief on a transcript's first line, for one too large to read whole. */
async function firstPrompt(file: string): Promise<string> {
  const fh = await open(file, 'r').catch(() => null);
  if (!fh) return '';
  try {
    const buf = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const end = buf.subarray(0, bytesRead).indexOf(10);
    const s = newDetail();
    try {
      feedDetail(s, JSON.parse(buf.toString('utf8', 0, end < 0 ? bytesRead : end)) as Line);
    } catch {
      // Longer than the head read: no brief to show.
    }
    return s.prompt ?? '';
  } finally {
    await fh.close();
  }
}

/**
 * Follows one subagent's transcript while its detail is open: each read takes only what was appended, and
 * says what changed since the last one. One at a time per watcher; `stop` forgets the file.
 */
export class SubagentWatch {
  private readonly store: TailStore = new Map();
  /** The rev the view has; 0 before the first read. */
  private sent = 0;
  private size = -1;
  private agentType?: string;
  private reading?: Promise<SubagentDetail | null>;
  constructor(
    readonly sessionId: string,
    readonly id: string,
    private readonly maxRead = MAX_READ,
  ) {}

  /** The detail if anything changed since the last read (everything the first time), else null. */
  read(): Promise<SubagentDetail | null> {
    const run = (this.reading ?? Promise.resolve(null)).catch(() => null).then(() => this.readNow());
    this.reading = run;
    return run;
  }

  private async readNow(): Promise<SubagentDetail | null> {
    const found = await findSubagent(this.sessionId, this.id);
    if (!found) return null;
    this.agentType = found.meta.agentType;
    const st = await lstat(found.file).catch(() => null);
    if (!st?.isFile()) return null;
    if (this.sent && st.size === this.size) return null;
    const old = this.store.get(found.file);
    const big = st.size > this.maxRead;
    const s = await advance(found.file, st, () => newDetail(big), feedDetail, this.store, big ? st.size - this.maxRead : 0);
    // A file read again from the start (replaced, or shrank) starts the view over.
    if (old && this.store.get(found.file) !== old) this.sent = 0;
    if (s.partial && s.prompt === undefined) s.prompt = await firstPrompt(found.file);
    const view = detailView(s, { sessionId: this.sessionId, id: this.id, agentType: this.agentType }, Math.max(0, this.sent));
    // -1: the view has everything, which was nothing yet.
    this.sent = s.rev || -1;
    this.size = st.size;
    return view;
  }

  stop(): void {
    this.store.clear();
  }
}
