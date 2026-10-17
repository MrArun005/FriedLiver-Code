// A local, keyword-ranked index of one workspace folder, for the index_* tools:
// the file list, a regex outline of each file, its imports, and an inverted
// token index ranked with BM25. Plain Node, no vscode, so it is testable; the
// editor side (projectIndexHost.ts) feeds it files and watches for changes.
// ponytail: keywords only. Semantic embeddings would go beside the token index if keyword search falls short.
import { execFile, spawn } from 'node:child_process';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export const INDEX_LIMITS = {
  /** Files larger than this are not indexed. */
  fileBytes: 1024 * 1024,
  /** Distinct tokens kept per file. */
  tokensPerFile: 4000,
  /** Results any tool returns at most. */
  results: 50,
  /** Characters in any tool's answer. */
  output: 20_000,
  /** Characters of one snippet line. */
  line: 200,
};

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.hg', '.svn', 'out', '.next', '__pycache__', '.venv', 'venv', 'target', 'build', 'coverage']);
const SECRET =
  /^(\.env(\..*)?|.*\.pem|.*\.key|id_(rsa|dsa|ecdsa|ed25519).*|.*\.p12|.*\.pfx|\.npmrc|\.netrc|\.pypirc|\.git-credentials|credentials.*|.*\.tfstate.*|.*\.tfvars|secrets\..*|.*\.keystore|.*\.jks|service-account.*\.json)$/i;

/** Whether a file must never be indexed because it likely holds secrets. */
export const isSecret = (file: string): boolean => SECRET.test(path.basename(file));

/** A file in a skipped or hidden (dot) directory, which the full build's walk never enters. */
export const inSkippedDir = (rel: string): boolean => rel.split('/').slice(0, -1).some((d) => SKIP_DIRS.has(d) || d.startsWith('.'));

/** A minimal glob (`**`, `*`, `?`, `{a,b}`) as a regex over a /-separated relative path, for files.exclude. */
export function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  // Like files.exclude, a pattern that names a folder excludes what is in it.
  return new RegExp(`^${re}(?:/.*)?$`);
}

/** Identifier-aware tokens: `getUserName` gives getusername, get, user, name. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const word of text.match(/[A-Za-z_$][\w$]*|\d{2,}/g) ?? []) {
    if (word.length > 64) continue;
    const lower = word.toLowerCase();
    if (lower.length >= 2) out.push(lower);
    const parts = word
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_$]+/);
    if (parts.length > 1) for (const p of parts) if (p.length >= 2) out.push(p.toLowerCase());
  }
  return out;
}

export interface Sym {
  name: string;
  kind: string;
  line: number;
}

const OUTLINE: [RegExp, RegExp[]][] = [
  [
    /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/,
    [
      /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function)\*?\s+([\w$]+)/,
      /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|enum|type|namespace)\s+([\w$]+)/,
      /^\s*(?:export\s+)?(const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*=>/,
      /^\s*(?:export\s+)(const|let)\s+([\w$]+)/,
      /^\s+(?:(?:public|private|protected|static|readonly|async|get|set|override)\s+)*(method)?([\w$]+)\s*\([^)]*\)\s*(?::[^={]+)?\{\s*$/,
    ],
  ],
  [/\.py$/, [/^\s*(?:async\s+)?(def|class)\s+(\w+)/]],
  [/\.go$/, [/^(func)\s+(?:\([^)]*\)\s*)?(\w+)/, /^(type)\s+(\w+)/]],
  [/\.(java|kt|cs|scala)$/, [/^\s*(?:[\w@<>]+\s+)*(class|interface|enum|record|object)\s+(\w+)/, /^\s+(?:(?:public|private|protected|static|final|override|suspend|fun|async|virtual|abstract)\s+)+(?:[\w<>[\],.?]+\s+)?(method)?(\w+)\s*\(/]],
  [/\.rs$/, [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|mod|type)\s+(\w+)/]],
  [/\.rb$/, [/^\s*(def|class|module)\s+(?:self\.)?([\w?!]+)/]],
  [/\.(c|h|cc|cpp|hpp)$/, [/^(?:[\w*&<>:]+\s+)+\**(method)?([A-Za-z_]\w*)\s*\([^;]*$/, /^\s*(struct|class|enum)\s+(\w+)\s*\{/]],
];
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'new', 'constructor']);

/** A regex outline of a file: its functions, classes and the like with 1-based lines. */
export function outline(file: string, text: string): Sym[] {
  const rules = OUTLINE.find(([ext]) => ext.test(file))?.[1];
  if (!rules) return [];
  const out: Sym[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < 2000; i++) {
    for (const re of rules) {
      const m = re.exec(lines[i]);
      if (m && m[2] && !KEYWORDS.has(m[2])) {
        out.push({ name: m[2], kind: m[1] ?? 'method', line: i + 1 });
        break;
      }
    }
  }
  return out;
}

/** The raw import specifiers of a file (TS/JS, Python, Go, Java/Kotlin). */
export function imports(file: string, text: string): string[] {
  const out = new Set<string>();
  const add = (re: RegExp, g = 1) => {
    for (const m of text.matchAll(re)) if (m[g]) out.add(m[g]);
  };
  if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(file)) {
    add(/(?:from|import)\s*['"]([^'"\n]+)['"]/g);
    add(/(?:require|import)\(\s*['"]([^'"\n]+)['"]\s*\)/g);
  } else if (file.endsWith('.py')) {
    add(/^\s*from\s+([.\w]+)\s+import/gm);
    add(/^\s*import\s+([\w.]+)/gm);
  } else if (file.endsWith('.go')) {
    add(/^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm);
    for (const block of text.matchAll(/^import\s*\(([\s\S]*?)\)/gm)) for (const m of block[1].matchAll(/"([^"]+)"/g)) out.add(m[1]);
  } else if (/\.(java|kt|scala)$/.test(file)) add(/^\s*import\s+(?:static\s+)?([\w.]+)/gm);
  return [...out].slice(0, 200);
}

interface Doc {
  rel: string;
  mtime: number;
  size: number;
  len: number;
  tokens: Map<string, number>;
  symbols: Sym[];
  imports: string[];
}

/** What one file costs the index, roughly, in bytes. */
const cost = (d: Doc) => 200 + d.rel.length * 2 + d.tokens.size * 40 + d.symbols.length * 60 + d.imports.length * 60;

export interface IndexOptions {
  maxFiles: number;
  maxBytes: number;
  /** files.exclude patterns, relative to the folder. */
  exclude?: string[];
}

/** The index of one workspace folder. */
export class ProjectIndex {
  private readonly docs = new Map<string, Doc>();
  private readonly postings = new Map<string, Map<string, number>>();
  private totalLen = 0;
  private bytes = 0;
  private readonly exclude: RegExp[];
  /** Set once a cap stopped files from being indexed. */
  capped = false;
  private rootReal?: string;

  constructor(
    readonly root: string,
    private readonly options: IndexOptions,
  ) {
    this.exclude = (options.exclude ?? []).map(globToRegex);
  }

  get size(): number {
    return this.docs.size;
  }

  /** Whether a folder-relative path may be indexed at all, by name alone. */
  allowed(rel: string): boolean {
    if (!rel || rel.startsWith('../') || path.isAbsolute(rel) || rel.split('/').includes('..')) return false;
    return !isSecret(rel) && !inSkippedDir(rel) && !this.exclude.some((re) => re.test(rel));
  }

  /**
   * Changed files from the watcher, through the same filters as the full build: name rules here,
   * .gitignore by `git check-ignore` (in a git folder), then update(). Ignored files are dropped.
   */
  async updateMany(rels: string[]): Promise<void> {
    const norm = rels.map((r) => r.split(path.sep).join('/'));
    const ignored = await this.ignored(norm.filter((r) => this.allowed(r)));
    for (const rel of norm) {
      if (ignored.has(rel)) this.remove(rel);
      else await this.update(rel);
    }
  }

  /** Which of `rels` git ignores; none outside a git folder. Fails closed: if git errors in a repo, all are ignored. */
  private ignored(rels: string[]): Promise<Set<string>> {
    if (!rels.length) return Promise.resolve(new Set());
    return new Promise((resolve) => {
      const child = spawn('git', ['check-ignore', '-z', '--stdin'], { cwd: this.root, stdio: ['pipe', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
      child.on('error', () => resolve(new Set()));
      // 0: some ignored, 1: none, 128: not a git folder (no .gitignore to respect).
      child.on('close', (code) => resolve(code === 0 || code === 1 ? new Set(out.split('\0').filter(Boolean)) : code === 128 ? new Set() : new Set(rels)));
      child.stdin.on('error', () => {});
      child.stdin.end(rels.join('\0') + '\0');
    });
  }

  /** Every file to index: git's list (tracked + untracked, .gitignore respected) or, outside git, a walk. */
  async list(): Promise<string[]> {
    const fromGit = await new Promise<string[] | null>((resolve) =>
      execFile('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: this.root, maxBuffer: 256 * 1024 * 1024 }, (err, out) =>
        resolve(err ? null : out.split('\0').filter(Boolean)),
      ),
    );
    const all = fromGit ?? (await this.walk());
    return all.filter((r) => this.allowed(r));
  }

  private async walk(): Promise<string[]> {
    const out: string[] = [];
    const visit = async (dir: string) => {
      if (out.length >= this.options.maxFiles * 2) return;
      const entries = await readdir(path.join(this.root, dir), { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        // Symlinks are never followed: isDirectory/isFile are false for them here.
        if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await visit(rel);
        else if (e.isFile()) out.push(rel);
      }
    };
    await visit('');
    return out;
  }

  /**
   * Whether `rel` may be read right now: allowed by name, a regular file (not a symlink) within the
   * size cap, and its real path inside the folder's real path. Checked before every read, since the
   * file can change after it was indexed.
   */
  private async check(rel: string): Promise<Stats | null> {
    if (!this.allowed(rel)) return null;
    const abs = path.join(this.root, rel);
    const st = await lstat(abs).catch(() => null);
    if (!st || !st.isFile() || st.size > INDEX_LIMITS.fileBytes) return null;
    // A symlinked directory on the way out of the folder: lstat sees only the last part.
    this.rootReal ??= await realpath(this.root).catch(() => this.root);
    const real = await realpath(abs).catch(() => null);
    return real && real.startsWith(this.rootReal + path.sep) ? st : null;
  }

  /** The text of an indexed file, re-checked first; drops the entry when anything is off. */
  async read(rel: string): Promise<string | null> {
    const text = (await this.check(rel)) ? await readText(path.join(this.root, rel)) : null;
    if (text === null) this.remove(rel);
    return text;
  }

  /**
   * Indexes (or re-indexes) one file, or drops it when it is gone, a symlink, outside the folder,
   * binary or too big. Returns false when a cap stopped it.
   */
  async update(rel: string): Promise<boolean> {
    rel = rel.split(path.sep).join('/');
    const st = await this.check(rel);
    if (!st) return this.remove(rel), true;
    const old = this.docs.get(rel);
    if (old && old.mtime === st.mtimeMs && old.size === st.size) return true;
    if (!old && this.docs.size >= this.options.maxFiles) return (this.capped = true), false;
    const text = await this.read(rel);
    if (text === null) return true;
    const tokens = new Map<string, number>();
    let len = 0;
    for (const t of tokenize(text)) {
      len++;
      if (tokens.has(t)) tokens.set(t, tokens.get(t)! + 1);
      else if (tokens.size < INDEX_LIMITS.tokensPerFile) tokens.set(t, 1);
    }
    for (const t of tokenize(rel)) tokens.set(t, (tokens.get(t) ?? 0) + 1);
    const doc: Doc = { rel, mtime: st.mtimeMs, size: st.size, len, tokens, symbols: outline(rel, text), imports: imports(rel, text) };
    this.remove(rel);
    if (this.bytes + cost(doc) > this.options.maxBytes) return (this.capped = true), false;
    this.add(doc);
    return true;
  }

  remove(rel: string): void {
    const doc = this.docs.get(rel);
    if (!doc) return;
    this.docs.delete(rel);
    this.totalLen -= doc.len;
    this.bytes -= cost(doc);
    for (const t of doc.tokens.keys()) {
      const p = this.postings.get(t);
      p?.delete(rel);
      if (p && p.size === 0) this.postings.delete(t);
    }
  }

  private add(doc: Doc): void {
    this.docs.set(doc.rel, doc);
    this.totalLen += doc.len;
    this.bytes += cost(doc);
    for (const [t, tf] of doc.tokens) {
      let p = this.postings.get(t);
      if (!p) this.postings.set(t, (p = new Map()));
      p.set(doc.rel, tf);
    }
  }

  /** Drops files that are no longer listed. */
  prune(keep: Set<string>): void {
    for (const rel of [...this.docs.keys()]) if (!keep.has(rel)) this.remove(rel);
  }

  /** Files ranked by BM25 over the query's tokens, boosted where a symbol or the path matches. */
  search(query: string, limit: number): { rel: string; score: number; symbols: Sym[] }[] {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return [];
    const n = this.docs.size;
    const avg = this.totalLen / Math.max(1, n) || 1;
    const scores = new Map<string, number>();
    for (const t of terms) {
      const p = this.postings.get(t);
      if (!p) continue;
      const idf = Math.log(1 + (n - p.size + 0.5) / (p.size + 0.5));
      for (const [rel, tf] of p) {
        const len = this.docs.get(rel)!.len;
        const s = (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * len) / avg));
        scores.set(rel, (scores.get(rel) ?? 0) + s);
      }
    }
    const lowerTerms = new Set(terms);
    const ranked = [...scores].map(([rel, score]) => {
      const symbols = this.docs.get(rel)!.symbols.filter((s) => lowerTerms.has(s.name.toLowerCase()) || tokenize(s.name).some((t) => lowerTerms.has(t)));
      const exact = symbols.some((s) => lowerTerms.has(s.name.toLowerCase()));
      return { rel, score: score + (exact ? 3 : 0) + Math.min(symbols.length, 3) * 0.5, symbols: symbols.slice(0, 5) };
    });
    ranked.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
    return ranked.slice(0, limit);
  }

  /** Definitions named `name` (case-insensitive), or starting with it when none are. */
  symbols(name: string, limit: number): { rel: string; sym: Sym }[] {
    const want = name.toLowerCase();
    const exact: { rel: string; sym: Sym }[] = [];
    const prefix: { rel: string; sym: Sym }[] = [];
    for (const doc of this.docs.values()) {
      for (const sym of doc.symbols) {
        const s = sym.name.toLowerCase();
        if (s === want) exact.push({ rel: doc.rel, sym });
        else if (s.startsWith(want) && prefix.length < limit) prefix.push({ rel: doc.rel, sym });
      }
    }
    return (exact.length ? exact : prefix).slice(0, limit);
  }

  outline(rel: string): Sym[] | undefined {
    return this.docs.get(rel)?.symbols;
  }

  has(rel: string): boolean {
    return this.docs.has(rel);
  }

  /** What `rel` imports (resolved to indexed files where possible) and the indexed files that import it. */
  related(rel: string): { imports: string[]; importedBy: string[] } | undefined {
    const doc = this.docs.get(rel);
    if (!doc) return undefined;
    const out = doc.imports.map((spec) => this.resolve(rel, spec) ?? `${spec} (external)`);
    const importedBy: string[] = [];
    for (const other of this.docs.values()) {
      if (other.rel !== rel && other.imports.some((spec) => this.resolve(other.rel, spec) === rel)) importedBy.push(other.rel);
    }
    return { imports: [...new Set(out)], importedBy };
  }

  private resolve(from: string, spec: string): string | undefined {
    const dir = path.posix.dirname(from);
    const tryAll = (base: string, exts: string[]) => exts.map((e) => path.posix.normalize(base + e)).find((p) => this.docs.has(p));
    if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(from)) {
      if (!spec.startsWith('.')) return undefined;
      const base = path.posix.join(dir, spec);
      const stripped = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
      const exts = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '/index.ts', '/index.tsx', '/index.js'];
      return tryAll(base, exts) ?? tryAll(stripped, exts);
    }
    if (from.endsWith('.py')) {
      const dots = /^\.*/.exec(spec)![0].length;
      const mod = spec.slice(dots).replace(/\./g, '/');
      const base = dots ? path.posix.join(dir, '../'.repeat(dots - 1), mod) : mod;
      return tryAll(base, ['.py', '/__init__.py']);
    }
    if (/\.(java|kt|scala)$/.test(from)) {
      const tail = spec.replace(/\./g, '/');
      for (const r of this.docs.keys()) if (/\.(java|kt|scala)$/.test(r) && r.replace(/\.\w+$/, '').endsWith(tail)) return r;
      return undefined;
    }
    if (from.endsWith('.go')) {
      for (const r of this.docs.keys()) {
        const d = path.posix.dirname(r);
        if (r.endsWith('.go') && d !== '.' && (spec === d || spec.endsWith(`/${d}`))) return d + '/';
      }
    }
    return undefined;
  }

  /** The index as plain JSON, to keep between sessions. */
  toJSON(): object {
    return { v: 1, docs: [...this.docs.values()].map((d) => ({ ...d, tokens: [...d.tokens] })) };
  }

  /** Takes back a saved index; files that changed since are refreshed by the next update(). */
  async load(saved: unknown): Promise<void> {
    const docs = (saved as { v?: number; docs?: unknown[] })?.v === 1 ? (saved as { docs: unknown[] }).docs : [];
    for (const raw of Array.isArray(docs) ? docs : []) {
      const d = raw as Doc & { tokens: [string, number][] };
      if (typeof d?.rel !== 'string' || !Array.isArray(d.tokens) || !Array.isArray(d.symbols) || !Array.isArray(d.imports)) continue;
      if (this.docs.size >= this.options.maxFiles) break;
      // The saved file may be stale or tampered with: an entry is used only if its file passes today's checks.
      if (!(await this.check(d.rel))) continue;
      this.add({ ...d, tokens: new Map(d.tokens) });
    }
  }

  /** Matching lines of an indexed file for a search result: up to `max`, each cut to INDEX_LIMITS.line. */
  async snippets(rel: string, query: string, max = 3): Promise<{ line: number; text: string }[]> {
    const text = await this.read(rel);
    return text === null ? [] : matchingLines(text, query, max);
  }
}

/**
 * A regular file's text, or null when it looks binary, is too big, or can't be read. Opened without
 * following a symlink and checked on the open handle, so a swap after check() reads nothing.
 */
async function readText(abs: string): Promise<string | null> {
  try {
    const fh = await open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size > INDEX_LIMITS.fileBytes) return null;
      const buf = Buffer.alloc(st.size);
      const { bytesRead } = await fh.read(buf, 0, st.size, 0);
      const data = buf.subarray(0, bytesRead);
      if (data.subarray(0, 8192).includes(0)) return null;
      return data.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

function matchingLines(text: string, query: string, max: number): { line: number; text: string }[] {
  const terms = [...new Set(query.toLowerCase().match(/[\w$]{2,}/g) ?? [])];
  // The lines holding the most distinct terms, earliest first among equals.
  const hits: { line: number; n: number }[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase();
    const n = terms.filter((t) => l.includes(t)).length;
    if (n) hits.push({ line: i, n });
  }
  hits.sort((a, b) => b.n - a.n || a.line - b.line);
  return hits
    .slice(0, max)
    .sort((a, b) => a.line - b.line)
    .map((h) => ({ line: h.line + 1, text: lines[h.line].trim().slice(0, INDEX_LIMITS.line) }));
}

export type IndexCall =
  | { tool: 'index_search'; query: string; limit?: number }
  | { tool: 'index_symbols'; name: string }
  | { tool: 'index_outline'; path: string }
  | { tool: 'index_related'; path: string };

const cap = (text: string) => (text.length > INDEX_LIMITS.output ? `${text.slice(0, INDEX_LIMITS.output)}\n… (cut at ${INDEX_LIMITS.output} characters)` : text);

/**
 * The answers to the index_* tools over every folder's index. Paths in and out are
 * relative to the folder; with more than one folder they start with its name.
 */
export async function answerIndex(indexes: ProjectIndex[], call: IndexCall, building: boolean): Promise<string> {
  if (!indexes.length) return 'No project index: no trusted workspace folder is open, or friedliver.index.enabled is off. Search the files another way.';
  const multi = indexes.length > 1;
  const shown = (ix: ProjectIndex, rel: string) => (multi ? `${path.basename(ix.root)}/${rel}` : rel);
  const note = building ? '(The index is still being built; results may be incomplete.)\n' : '';
  const find = (p: string): [ProjectIndex, string] | undefined => {
    const rel = p.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!multi) return indexes[0].has(rel) ? [indexes[0], rel] : undefined;
    for (const ix of indexes) {
      const name = path.basename(ix.root) + '/';
      if (rel.startsWith(name) && ix.has(rel.slice(name.length))) return [ix, rel.slice(name.length)];
    }
    return undefined;
  };
  const lineOf = (s: Sym) => `  ${s.kind} ${s.name}  (line ${s.line})`;
  const missing = `${call.tool === 'index_outline' || call.tool === 'index_related' ? call.path : ''} is not in the index (not a workspace-relative path, excluded, or not indexed yet).`;
  switch (call.tool) {
    case 'index_search': {
      const limit = Math.min(call.limit ?? 10, INDEX_LIMITS.results);
      const hits = indexes
        .flatMap((ix) => ix.search(call.query, limit).map((h) => ({ ...h, ix })))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      if (!hits.length) return `${note}No indexed file matches "${call.query}".`;
      const parts: string[] = [];
      for (const h of hits) {
        const lines = [`${shown(h.ix, h.rel)}  (score ${h.score.toFixed(2)})`];
        for (const s of h.symbols) lines.push(lineOf(s));
        for (const s of await h.ix.snippets(h.rel, call.query)) lines.push(`  ${s.line}: ${s.text}`);
        // The file failed its re-check and was dropped: say nothing about it.
        if (!h.ix.has(h.rel)) continue;
        parts.push(lines.join('\n'));
      }
      return parts.length ? cap(note + parts.join('\n\n')) : `${note}No indexed file matches "${call.query}".`;
    }
    case 'index_symbols': {
      const hits = indexes.flatMap((ix) => ix.symbols(call.name, INDEX_LIMITS.results).map((h) => ({ ...h, ix }))).slice(0, INDEX_LIMITS.results);
      if (!hits.length) return `${note}No definition named "${call.name}" in the index.`;
      return cap(note + hits.map((h) => `${shown(h.ix, h.rel)}:${h.sym.line}  ${h.sym.kind} ${h.sym.name}`).join('\n'));
    }
    case 'index_outline': {
      const at = find(call.path);
      if (!at) return missing;
      const syms = at[0].outline(at[1])!;
      return cap(syms.length ? `${call.path}\n${syms.map(lineOf).join('\n')}` : `${call.path} has no outline (no definitions found, or a language the outline doesn't read).`);
    }
    case 'index_related': {
      const at = find(call.path);
      if (!at) return missing;
      const r = at[0].related(at[1])!;
      const list = (xs: string[]) => (xs.length ? xs.slice(0, INDEX_LIMITS.results).map((x) => `  ${x}`).join('\n') : '  (none found)');
      const imp = r.imports.map((x) => (x.endsWith('(external)') ? x : shown(at[0], x)));
      return cap(`${call.path}\nImports:\n${list(imp)}\nImported by:\n${list(r.importedBy.map((x) => shown(at[0], x)))}`);
    }
  }
}
