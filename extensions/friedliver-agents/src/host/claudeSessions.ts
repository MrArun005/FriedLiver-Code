// Claude Code sessions started outside FriedLiver (the `claude` CLI, the
// Claude Code extension), read from the transcripts Claude Code keeps at
// ~/.claude/projects/<folder with every non-alphanumeric char as '-'>/<session id>.jsonl.
// Read-only: FriedLiver never writes, moves or deletes these files.
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ClaudeSession } from '../shared/messages';

const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
const TITLE_MAX = 80;
/** Bytes read from one transcript: its tail, where a long session's title and latest subagents are. */
const MAX_READ = 8 * 1024 * 1024;

export function encodeCwd(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9]/g, '-');
}

const clipTitle = (t: string) => {
  const one = t.replace(/\s+/g, ' ').trim();
  return one.length > TITLE_MAX ? `${one.slice(0, TITLE_MAX - 1)}…` : one;
};

type Block = { type?: string; text?: string; id?: string; name?: string; input?: { description?: unknown }; tool_use_id?: string };

/** What the Manager shows of one transcript. Lines that aren't JSON (a cut-off first line of a tail) are skipped. */
export function parseSession(text: string): Pick<ClaudeSession, 'title' | 'messages' | 'subagents'> {
  let custom = '';
  let auto = '';
  let anon = 0;
  let prompt = '';
  let messages = 0;
  const assistantIds = new Set<string>();
  const subs: ClaudeSession['subagents'] = [];
  const results = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: { type?: string; isMeta?: boolean; isSidechain?: boolean; aiTitle?: string; customTitle?: string; summary?: string; message?: { id?: string; content?: string | Block[] } };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    // The latest title wins: Claude Code appends a new one as the session goes on, and a name the user gave beats its own.
    if (o.type === 'custom-title' && typeof o.customTitle === 'string') custom = o.customTitle;
    else if (o.type === 'ai-title' && typeof o.aiTitle === 'string') auto = o.aiTitle;
    else if (o.type === 'summary' && typeof o.summary === 'string') auto = o.summary;
    if (o.isSidechain || o.isMeta || !o.message) continue;
    const content = o.message.content;
    const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    if (o.type === 'user') {
      for (const b of blocks) if (b.type === 'tool_result' && b.tool_use_id) results.add(b.tool_use_id);
      const said = blocks.find((b) => b.type === 'text' && b.text && !b.text.startsWith('<'))?.text;
      if (said) {
        messages++;
        prompt ||= said;
      }
    } else if (o.type === 'assistant') {
      // One message streams as several lines with the same id.
      assistantIds.add(o.message.id ?? `anon-${anon++}`);
      for (const b of blocks) {
        if (b.type === 'tool_use' && b.id && b.name && SUBAGENT_TOOLS.has(b.name)) {
          subs.push({ id: b.id, title: typeof b.input?.description === 'string' ? clipTitle(b.input.description) : 'Subagent', done: false });
        }
      }
    }
  }
  return {
    title: clipTitle(custom || auto || prompt) || 'Claude Code session',
    messages: messages + assistantIds.size,
    subagents: subs.map((s) => ({ ...s, done: results.has(s.id) })),
  };
}

async function readTail(file: string, size: number): Promise<string> {
  const fh = await open(file, 'r');
  try {
    const len = Math.min(size, MAX_READ);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

const cache = new Map<string, { key: string; parsed: ReturnType<typeof parseSession> }>();

export interface ListOptions {
  /** The current user's home; sessions are only read under its .claude/projects. */
  home: string;
  folders: readonly string[];
  /** Session ids FriedLiver's own chats already have. */
  skip?: ReadonlySet<string>;
  limit?: number;
}

/** The workspace folders' Claude Code sessions, most recent first. Missing folders and unreadable files are left out. */
export async function listClaudeSessions({ home, folders, skip, limit = 50 }: ListOptions): Promise<ClaudeSession[]> {
  const base = path.join(home, '.claude', 'projects');
  const realBase = await realpath(base).catch(() => null);
  if (!realBase) return [];
  const found: { id: string; cwd: string; file: string; mtime: number; size: number }[] = [];
  for (const cwd of folders) {
    const dir = path.join(base, encodeCwd(cwd));
    const real = await realpath(dir).catch(() => null);
    if (!real || path.dirname(real) !== realBase) continue;
    const names = await readdir(real).catch(() => [] as string[]);
    for (const name of names) {
      const m = SESSION_FILE.exec(name);
      if (!m || skip?.has(m[1])) continue;
      const file = path.join(real, name);
      const st = await lstat(file).catch(() => null);
      if (st?.isFile()) found.push({ id: m[1], cwd, file, mtime: st.mtimeMs, size: st.size });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const out: ClaudeSession[] = [];
  for (const f of found.slice(0, limit)) {
    const key = `${f.mtime}:${f.size}`;
    let hit = cache.get(f.file);
    if (hit?.key !== key) {
      const text = await readTail(f.file, f.size).catch(() => null);
      if (text === null) continue;
      hit = { key, parsed: parseSession(text) };
      cache.set(f.file, hit);
    }
    out.push({ id: f.id, cwd: f.cwd, lastActivity: f.mtime, ...hit.parsed });
  }
  return out;
}
