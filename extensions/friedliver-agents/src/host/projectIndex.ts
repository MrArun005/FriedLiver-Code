// A local, keyword-ranked index of one workspace folder, for the index_* tools:
// the file list, a regex outline of each file, its imports, and an inverted
// token index ranked with BM25. Plain Node, no vscode, so it is testable; the
// editor side (projectIndexHost.ts) feeds it files and watches for changes.
// ponytail: keywords only. Semantic embeddings would go beside the token index if keyword search falls short.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MerkleTree } from './merkle';

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
  /** Paths index_changes lists at most. */
  changes: 200,
};

/** Files whose stat checks run at once. */
export const STAT_BATCH = 256;

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
  /** The file's mtime in nanoseconds, with its size the quick check before any read. */
  mtimeNs: string;
  size: number;
  /** SHA-256 of the content: the file's leaf in the Merkle tree. */
  hash: string;
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
  /** The git command; tests swap in a fake. */
  git?: string;
  /** Where to report a problem the user may want to know about. */
  log?: (message: string) => void;
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
  /** The Merkle tree of the indexed files: always exactly the docs, by content hash. */
  readonly tree = new MerkleTree();
  /** Files stat'ed, read, and re-indexed (read with new content). For tests and the bench. */
  readonly counts = { stat: 0, read: 0, reindex: 0 };

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
    // A new .git may turn the folder into a repo: decide again.
    if (norm.some((r) => r === '.git' || r.startsWith('.git/'))) this.isGit = undefined;
    const ok: string[] = [];
    const dirs = new Map<string, Promise<boolean>>();
    for (const r of norm) if (this.allowed(r) && (await this.plainDirs(r, dirs))) ok.push(r);
    const ignored = await this.ignored(ok);
    const keep = new Set(ok.filter((r) => !ignored.has(r)));
    for (const rel of norm) {
      if (keep.has(rel)) await this.update(rel);
      else this.remove(rel);
    }
  }

  /** Whether every directory above `rel` is a real directory of this repo: no symlink, no submodule or nested repo (a `.git` in it). */
  private async plainDirs(rel: string, seen: Map<string, Promise<boolean>>): Promise<boolean> {
    const parts = rel.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!seen.has(dir)) {
        const abs = path.join(this.root, dir);
        seen.set(
          dir,
          lstat(abs).then(
            async (st) => !st.isSymbolicLink() && !(await lstat(path.join(abs, '.git')).then(() => true, () => false)),
            () => true, // Gone: update() drops it.
          ),
        );
      }
      if (!(await seen.get(dir))) return false;
    }
    return true;
  }

  /** Whether the folder is in a git work tree; asked once, again when a .git appears. */
  private isGit?: Promise<boolean>;

  /**
   * Which of `rels` git ignores. Outside git none are (name rules only). In a repo, any exit
   * from check-ignore other than 0 (some ignored) or 1 (none) ignores the whole batch: fail closed.
   */
  private async ignored(rels: string[]): Promise<Set<string>> {
    if (!rels.length) return new Set();
    this.isGit ??= new Promise((resolve) =>
      execFile(this.git, ['rev-parse', '--is-inside-work-tree'], { cwd: this.root }, (err, out) => resolve(!err && out.trim() === 'true')),
    );
    if (!(await this.isGit)) return new Set();
    return new Promise((resolve) => {
      const child = spawn(this.git, ['check-ignore', '-z', '--stdin'], { cwd: this.root, stdio: ['pipe', 'pipe', 'ignore'] });
      let out = '';
      const closed = (why: string) => {
        this.options.log?.(`Project index: git check-ignore failed (${why}) in ${this.root}; skipped ${rels.length} changed file(s).`);
        resolve(new Set(rels));
      };
      child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
      child.on('error', (e) => closed(e.message));
      child.on('close', (code) => (code === 0 || code === 1 ? resolve(new Set(out.split('\0').filter(Boolean))) : closed(`exit ${code}`)));
      child.stdin.on('error', () => {});
      child.stdin.end(rels.join('\0') + '\0');
    });
  }

  private get git(): string {
    return this.options.git ?? 'git';
  }

  /** Every file to index: git's list (tracked + untracked, .gitignore respected) or, outside git, a walk. */
  async list(): Promise<string[]> {
    const fromGit = await new Promise<string[] | null>((resolve) =>
      execFile(this.git, ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: this.root, maxBuffer: 256 * 1024 * 1024 }, (err, out) =>
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
  private async check(rel: string): Promise<{ size: number; mtimeNs: string } | null> {
    if (!this.allowed(rel)) return null;
    const abs = path.join(this.root, rel);
    this.counts.stat++;
    const st = await lstat(abs, { bigint: true }).catch(() => null);
    if (!st || !st.isFile() || st.size > INDEX_LIMITS.fileBytes) return null;
    // A symlinked directory on the way out of the folder: lstat sees only the last part.
    this.rootReal ??= await realpath(this.root).catch(() => this.root);
    const real = await realpath(abs).catch(() => null);
    return real && real.startsWith(this.rootReal + path.sep) ? { size: Number(st.size), mtimeNs: st.mtimeNs.toString() } : null;
  }

  /** The text and content hash of an indexed file, re-checked first; drops the entry when anything is off. */
  private async readChecked(rel: string): Promise<{ text: string; hash: string } | null> {
    const got = (await this.check(rel)) ? (this.counts.read++, await readText(path.join(this.root, rel))) : null;
    if (got === null) this.remove(rel);
    return got;
  }

  /** The text of an indexed file, re-checked first; drops the entry when anything is off. */
  async read(rel: string): Promise<string | null> {
    return (await this.readChecked(rel))?.text ?? null;
  }

  /**
   * Indexes (or re-indexes) one file, or drops it when it is gone, a symlink, outside the folder,
   * binary or too big. Returns false when a cap stopped it.
   */
  async update(rel: string, checked?: Awaited<ReturnType<ProjectIndex['check']>>): Promise<boolean> {
    rel = rel.split(path.sep).join('/');
    const st = checked === undefined ? await this.check(rel) : checked;
    if (!st) return this.remove(rel), true;
    const old = this.docs.get(rel);
    if (old && old.mtimeNs === st.mtimeNs && old.size === st.size) return true;
    if (!old && this.docs.size >= this.options.maxFiles) return (this.capped = true), false;
    const got = await this.readChecked(rel);
    if (got === null) return true;
    // Stat changed, content did not (a checkout, a touch): keep the entry, note the new stat.
    if (old && old.hash === got.hash) {
      old.mtimeNs = st.mtimeNs;
      old.size = st.size;
      return true;
    }
    this.counts.reindex++;
    const text = got.text;
    const tokens = new Map<string, number>();
    let len = 0;
    for (const t of tokenize(text)) {
      len++;
      if (tokens.has(t)) tokens.set(t, tokens.get(t)! + 1);
      else if (tokens.size < INDEX_LIMITS.tokensPerFile) tokens.set(t, 1);
    }
    for (const t of tokenize(rel)) tokens.set(t, (tokens.get(t) ?? 0) + 1);
    const doc: Doc = { rel, mtimeNs: st.mtimeNs, size: st.size, hash: got.hash, len, tokens, symbols: outline(rel, text), imports: imports(rel, text) };
    this.remove(rel);
    if (this.bytes + cost(doc) > this.options.maxBytes) return (this.capped = true), false;
    this.add(doc);
    return true;
  }

  remove(rel: string): void {
    const doc = this.docs.get(rel);
    if (!doc) return;
    this.docs.delete(rel);
    this.tree.delete(rel);
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
    this.tree.set(doc.rel, doc.hash);
    this.totalLen += doc.len;
    this.bytes += cost(doc);
    for (const [t, tf] of doc.tokens) {
      let p = this.postings.get(t);
      if (!p) this.postings.set(t, (p = new Map()));
      p.set(doc.rel, tf);
    }
  }

  /**
   * update() for many files: their checks (lstat, realpath) run concurrently, then each is applied in
   * order, so caps hold exactly as one at a time. Stops at a cap; returns false then.
   */
  async updateBatch(rels: string[]): Promise<boolean> {
    const checked = await Promise.all(rels.map((r) => this.check(r.split(path.sep).join('/'))));
    for (let i = 0; i < rels.length; i++) if (!(await this.update(rels[i], checked[i])) && this.capped) return false;
    return true;
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

  /** The index as plain JSON, to keep between sessions: the docs (the tree's leaves) and the tree's kept roots. */
  toJSON(): object {
    return { v: 2, docs: [...this.docs.values()].map((d) => ({ ...d, tokens: [...d.tokens] })), merkle: this.tree };
  }

  /**
   * Takes back a saved index; files that changed since are refreshed by the next update(). Anything
   * not version 2 or not well formed is left out, so the next build reads those files again. The
   * last saved root becomes the tree's base: what "changed since the last open" compares with.
   */
  async load(saved: unknown): Promise<void> {
    const docs = (saved as { v?: number; docs?: unknown[] })?.v === 2 ? (saved as { docs: unknown[] }).docs : [];
    const ok = (Array.isArray(docs) ? docs : []).filter((raw): raw is Doc & { tokens: [string, number][] } => {
      const d = raw as Doc & { tokens: unknown };
      return (
        typeof d?.rel === 'string' &&
        Array.isArray(d.tokens) &&
        Array.isArray(d.symbols) &&
        Array.isArray(d.imports) &&
        typeof d.hash === 'string' &&
        /^[0-9a-f]{64}$/.test(d.hash) &&
        typeof d.mtimeNs === 'string' &&
        /^\d+$/.test(d.mtimeNs) &&
        typeof d.size === 'number'
      );
    });
    for (let i = 0; i < ok.length && this.docs.size < this.options.maxFiles; i += STAT_BATCH) {
      const batch = ok.slice(i, i + STAT_BATCH);
      // The saved file may be stale or tampered with: an entry is used only if its file passes today's checks.
      const passed = await Promise.all(batch.map((d) => this.check(d.rel)));
      for (let j = 0; j < batch.length && this.docs.size < this.options.maxFiles; j++) {
        if (passed[j] && !this.docs.has(batch[j].rel)) this.add({ ...batch[j], tokens: new Map(batch[j].tokens) });
      }
    }
    if (docs.length && this.tree.load((saved as { merkle?: unknown }).merkle)) this.tree.base = this.tree.history.at(-1);
  }

  /**
   * The files changed between a kept root (a full hash or a unique 8+ hex prefix; by default the
   * tree as the project was last opened) and now. Null when there is no such root.
   */
  changes(since?: string, cap: number = INDEX_LIMITS.changes): { from: string; changes: { path: string; change: 'A' | 'M' | 'D' }[]; total: number } | null {
    const from = since ? this.tree.resolve(since) : this.tree.base;
    const d = from ? this.tree.diff(from, cap) : null;
    return d && from ? { from, ...d } : null;
  }

  /** Matching lines of an indexed file for a search result: up to `max`, each cut to INDEX_LIMITS.line. */
  async snippets(rel: string, query: string, max = 3): Promise<{ line: number; text: string }[]> {
    const text = await this.read(rel);
    return text === null ? [] : matchingLines(text, query, max);
  }
}

/** Bytes per read, each fed to the hash as it arrives. */
const CHUNK = 64 * 1024;

/**
 * A regular file's text and the SHA-256 of exactly those bytes, or null when it looks binary, is too
 * big, or can't be read. Opened without following a symlink and checked on the open handle, so a
 * swap after check() reads nothing. Read in chunks, each hashed as it comes.
 */
async function readText(abs: string): Promise<{ text: string; hash: string } | null> {
  try {
    const fh = await open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size > INDEX_LIMITS.fileBytes) return null;
      const buf = Buffer.alloc(st.size);
      const hash = createHash('sha256');
      let off = 0;
      while (off < st.size) {
        const { bytesRead } = await fh.read(buf, off, Math.min(CHUNK, st.size - off), off);
        if (!bytesRead) break;
        hash.update(buf.subarray(off, off + bytesRead));
        off += bytesRead;
      }
      const data = buf.subarray(0, off);
      if (data.subarray(0, 8192).includes(0)) return null;
      return { text: data.toString('utf8'), hash: hash.digest('hex') };
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/**
 * Saves an index where only the user can read it: the folder 0700, the file 0600, written whole to
 * a temporary file and renamed over the old one, so a crash never leaves half a file.
 */
export async function saveIndexFile(file: string, ix: ProjectIndex): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  await rm(tmp, { force: true });
  await writeFile(tmp, JSON.stringify(ix), { mode: 0o600, flag: 'wx' });
  await rename(tmp, file);
}

/** A saved index as parsed JSON, or undefined when it is missing or not JSON; load() checks the rest. */
export const readIndexFile = (file: string): Promise<unknown> =>
  readFile(file, 'utf8')
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);

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
  | { tool: 'index_related'; path: string }
  | { tool: 'index_changes'; since?: string };

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
    case 'index_changes': {
      const id = (h: string) => h.slice(0, 12);
      const parts: string[] = [];
      for (const ix of indexes) {
        const r = ix.changes(call.since);
        const head = multi ? `${path.basename(ix.root)}: ` : '';
        if (!r) {
          if (!call.since) parts.push(`${head}No earlier project hash to compare with yet (the folder's first index). Now ${id(ix.tree.root())}.`);
          continue;
        }
        const from = r.from === ix.tree.base ? `${id(r.from)} (when the project was opened)` : id(r.from);
        const now = id(ix.tree.root());
        if (!r.total) {
          parts.push(`${head}Project hash ${now}, the same as ${r.from === ix.tree.base ? 'when the project was opened' : id(r.from)}. No files changed.`);
          continue;
        }
        const lines = r.changes.map((c) => `${c.change} ${shown(ix, c.path)}`);
        if (r.total > r.changes.length) lines.push(`… and ${r.total - r.changes.length} more`);
        parts.push(`${head}Project hash ${now}: ${r.total} file${r.total === 1 ? '' : 's'} changed since ${from} (A added, M modified, D deleted)\n${lines.join('\n')}`);
      }
      if (!parts.length) {
        const kept = indexes.flatMap((ix) => ix.tree.history.map((h) => (multi ? `${path.basename(ix.root)}: ` : '') + id(h)));
        return `No kept project hash starts with ${call.since}. Kept: ${kept.join(', ') || 'none'}.`;
      }
      return cap(note + parts.join('\n\n'));
    }
  }
}
