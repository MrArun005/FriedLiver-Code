// Claude Code sessions started outside FriedLiver (the `claude` CLI, the
// Claude Code extension), read from the transcripts Claude Code keeps at
// ~/.claude/projects/<folder with every non-alphanumeric char as '-'>/<session id>.jsonl.
// Read-only: FriedLiver never writes, moves or deletes these files.
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { OutsideImage, OutsideImages } from '../shared/gallery';
import type { ClaudeSession } from '../shared/messages';
import { humanTitle } from '../shared/stepImages';

const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
const TITLE_MAX = 80;
/** Bytes read from one transcript: its tail, where a long session's title and latest subagents are. */
const MAX_READ = 8 * 1024 * 1024;

export function encodeCwd(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9]/g, '-');
}

const GREETING = /^(hi|hii+|hey|hello|yo|sup|thanks|thank you|ok|okay|test|ping)\b[\s!.?]*$/i;
const SHELL = /^(\$ |(npm|npx|pnpm|yarn|bun|git|cd|ls|brew|pip3?|curl|wget|sudo|node|python3?|docker|rm|mkdir|cat|claude|code|make|go|cargo|chmod|export)\s)/;
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
/** A prompt worth naming a session after: not a greeting, a slash command or a pasted shell command. */
const titleWorthy = (t: string) => !GREETING.test(t.trim()) && !t.trim().startsWith('/') && !SHELL.test(t.trim());
const WEEK_MS = 7 * 86_400_000;

const clipTitle = (t: string) => {
  const one = t.replace(/\s+/g, ' ').trim();
  return one.length > TITLE_MAX ? `${one.slice(0, TITLE_MAX - 1)}…` : one;
};

type Block = { type?: string; text?: string; id?: string; name?: string; input?: { description?: unknown }; tool_use_id?: string };

/** What the Manager shows of one transcript. Lines that aren't JSON (a cut-off first line of a tail) are skipped. */
export function parseSession(text: string): Pick<ClaudeSession, 'title' | 'messages' | 'subagents'> & { trivial: boolean } {
  let custom = '';
  let auto = '';
  let anon = 0;
  let prompt = '';
  let messages = 0;
  let tools = false;
  let short = true;
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
        if (!prompt && titleWorthy(said)) prompt = said;
        if (words(said) > 4 && !GREETING.test(said.trim())) short = false;
      }
    } else if (o.type === 'assistant') {
      // One message streams as several lines with the same id.
      assistantIds.add(o.message.id ?? `anon-${anon++}`);
      for (const b of blocks) {
        if (b.type === 'tool_use') tools = true;
        if (b.type === 'tool_use' && b.id && b.name && SUBAGENT_TOOLS.has(b.name)) {
          subs.push({ id: b.id, title: typeof b.input?.description === 'string' ? clipTitle(b.input.description) : 'Subagent', done: false });
        }
      }
    }
  }
  return {
    // Empty when nothing names it; the lister falls back to the folder and date.
    title: clipTitle(custom || auto || prompt),
    // ponytail: word-count heuristic; "hi" + "which IDE is this" style chats with no tool use.
    trivial: !tools && messages <= 2 && short,
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
  /** Keep trivial sessions and don't archive idle ones (`friedliver.claudeSessions.showAll`). */
  showAll?: boolean;
  now?: number;
}

interface SessionFile {
  id: string;
  cwd: string;
  file: string;
  /** The session's own folder (subagents/ is in it). */
  dir: string;
  mtime: number;
  size: number;
}

/** The workspace folders' session transcripts, most recent first; links and folders outside ~/.claude/projects are left out. */
async function sessionFiles(home: string, folders: readonly string[], skip?: ReadonlySet<string>): Promise<SessionFile[]> {
  const base = path.join(home, '.claude', 'projects');
  const realBase = await realpath(base).catch(() => null);
  if (!realBase) return [];
  const found: SessionFile[] = [];
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
      if (st?.isFile()) found.push({ id: m[1], cwd, file, dir: path.join(real, m[1]), mtime: st.mtimeMs, size: st.size });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

/** The title and counts of a transcript, read from its tail, cached by its mtime and size. */
async function parsed(f: SessionFile): Promise<ReturnType<typeof parseSession> | null> {
  const key = `${f.mtime}:${f.size}`;
  let hit = cache.get(f.file);
  if (hit?.key !== key) {
    const text = await readTail(f.file, f.size).catch(() => null);
    if (text === null) return null;
    hit = { key, parsed: parseSession(text) };
    cache.set(f.file, hit);
  }
  return hit.parsed;
}

const fallbackTitle = (f: SessionFile) => `${path.basename(f.cwd) || f.cwd} · ${new Date(f.mtime).toISOString().slice(0, 10)}`;

/** The workspace folders' Claude Code sessions, most recent first. Missing folders and unreadable files are left out. */
export async function listClaudeSessions({ home, folders, skip, limit = 50, showAll = false, now = Date.now() }: ListOptions): Promise<ClaudeSession[]> {
  const out: ClaudeSession[] = [];
  for (const f of (await sessionFiles(home, folders, skip)).slice(0, limit)) {
    const hit = await parsed(f);
    if (!hit) continue;
    const { trivial, title, ...rest } = hit;
    if (trivial && !showAll) continue;
    out.push({
      id: f.id,
      cwd: f.cwd,
      lastActivity: f.mtime,
      ...rest,
      title: title || fallbackTitle(f),
      ...(!showAll && now - f.mtime > WEEK_MS ? { archived: true } : {}),
    });
  }
  // Archived ones last, so the board's newest-first order is unchanged.
  return [...out.filter((s) => !s.archived), ...out.filter((s) => s.archived)];
}

// ---- Images: what a session's Read and screenshot tools looked at ----

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg)$/i;
const SCREENSHOT_TOOL = /screenshot/i;
/** Where a screenshot tool says it saved the file: FriedLiver's browser, Playwright's link or its code. */
const SAVED = [/^Saved to (.+?\.(?:png|jpe?g|gif|webp))\. /m, /\]\(([^)\s]+?\.(?:png|jpe?g|gif|webp))\)/, /save it as (\S+?\.(?:png|jpe?g|gif|webp))\b/];
/** Bytes of a transcript read for images the first time; later reads take only what was appended. */
const MAX_SCAN = 64 * 1024 * 1024;

type Line = { timestamp?: string; message?: { content?: string | (Block & { input?: Record<string, unknown>; content?: unknown })[] } };

/**
 * Reads a transcript's lines for images, a piece at a time as it grows: a Read
 * of an image file, and the file a screenshot tool saved (from its input's
 * filename, or the path its result names). Relative paths are the session's
 * folder's. Each file once, the first time it shows.
 */
export class ImageScan {
  readonly images: OutsideImage[] = [];
  private readonly seen = new Set<string>();
  /** Screenshot calls waiting for their result: id → when. */
  private readonly pending = new Map<string, number>();
  constructor(private readonly cwd: string) {}

  feed(text: string): void {
    for (const line of text.split('\n')) {
      // Most lines are neither; a quick look first spares parsing them (some are megabytes of base64).
      const use = line.includes('"tool_use"');
      const result = !use && this.pending.size > 0 && line.includes('"tool_result"') && [...this.pending.keys()].some((id) => line.includes(id));
      if (!use && !result) continue;
      let o: Line;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const at = Date.parse(o.timestamp ?? '') || 0;
      const blocks = Array.isArray(o.message?.content) ? o.message.content : [];
      for (const b of blocks) {
        if (b.type === 'tool_use' && b.id && b.name) {
          const file = b.input?.file_path ?? b.input?.filename;
          if (b.name === 'Read' && typeof file === 'string') this.add(file, humanTitle(file), 'read', at);
          else if (SCREENSHOT_TOOL.test(b.name)) {
            if (typeof file === 'string') this.add(file, humanTitle(file), 'screenshot', at);
            else this.pending.set(b.id, at);
          }
        } else if (b.type === 'tool_result' && b.tool_use_id && this.pending.has(b.tool_use_id)) {
          const when = this.pending.get(b.tool_use_id)!;
          this.pending.delete(b.tool_use_id);
          const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c: Block) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n') : '';
          const file = SAVED.map((re) => re.exec(text)?.[1]).find(Boolean);
          const title = /^(Screenshot of .+)$/m.exec(text)?.[1] ?? /\[(Screenshot[^\]]*)\]/.exec(text)?.[1];
          if (file) this.add(file, title?.trim() || humanTitle(file), 'screenshot', when);
        }
      }
    }
  }

  private add(file: string, title: string, source: OutsideImage['source'], at: number): void {
    if (!IMAGE_FILE.test(file) || file.includes('\0')) return;
    const full = path.resolve(this.cwd, file);
    if (this.seen.has(full)) return;
    this.seen.add(full);
    this.images.push({ path: full, title: clipTitle(title), source, at });
  }
}

const scans = new Map<string, { size: number; mtime: number; offset: number; scan: ImageScan }>();

/** The images in one transcript file, reading only what it gained since last time (a file that shrank is read again). */
async function scanFile(file: string, cwd: string): Promise<OutsideImage[]> {
  const st = await lstat(file).catch(() => null);
  if (!st?.isFile()) return [];
  let s = scans.get(file);
  if (s && s.size === st.size && s.mtime === st.mtimeMs) return s.scan.images;
  if (!s || st.size < s.size) {
    s = { size: 0, mtime: 0, offset: Math.max(0, st.size - MAX_SCAN), scan: new ImageScan(cwd) };
    scans.set(file, s);
  }
  const fh = await open(file, 'r').catch(() => null);
  if (!fh) return s.scan.images;
  try {
    const len = st.size - s.offset;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, s.offset);
    // Only whole lines: the last may still be being written.
    const end = buf.lastIndexOf(0x0a, bytesRead - 1) + 1;
    s.scan.feed(buf.toString('utf8', 0, end));
    s.offset += end;
    s.size = st.size;
    s.mtime = st.mtimeMs;
  } finally {
    await fh.close();
  }
  return s.scan.images;
}

/**
 * The images the workspace folders' Claude Code sessions read or took, with
 * their subagents', per session, the most recent sessions first. Sessions
 * FriedLiver's own chats have (`skip`) are left out: those chats show them.
 */
export async function listClaudeImages({ home, folders, skip, limit = 50 }: Pick<ListOptions, 'home' | 'folders' | 'skip' | 'limit'>): Promise<OutsideImages[]> {
  const out: OutsideImages[] = [];
  for (const f of (await sessionFiles(home, folders, skip)).slice(0, limit)) {
    // Its subagents' transcripts, unless that folder is a link out of the session's own.
    const subDir = path.join(f.dir, 'subagents');
    const realSub = await realpath(subDir).catch(() => null);
    const subs = realSub === subDir ? await readdir(subDir).catch(() => [] as string[]) : [];
    const files = [f.file, ...subs.filter((n) => /^agent-[\w-]+\.jsonl$/.test(n)).map((n) => path.join(subDir, n))];
    const images: OutsideImage[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      for (const img of await scanFile(file, f.cwd)) {
        if (seen.has(img.path)) continue;
        seen.add(img.path);
        images.push(img);
      }
    }
    if (!images.length) continue;
    out.push({ id: f.id, cwd: f.cwd, title: (await parsed(f))?.title || fallbackTitle(f), images });
  }
  return out;
}
