// A Merkle tree over the project index's files (Cursor-style sync). A leaf is a
// file's content hash; a directory node is the hash of its sorted (name, child
// hash) pairs; the root is the project hash. Interior hashes are recomputed
// lazily: a change marks its ancestors dirty, root() recomputes only those.
// Snapshots keep the nodes of recent roots, content-addressed, so two roots
// diff by descending only into the subtrees whose hashes differ.
// Plain Node, no vscode; the leaves come from ProjectIndex, which owns every exclusion.
import { createHash } from 'node:crypto';

/** A directory entry: name, hash (a file's content, or a directory's node), and whether it is a directory. */
export type Entry = [name: string, hash: string, dir: boolean];
export type Change = { path: string; change: 'A' | 'M' | 'D' };

// ponytail: SHA-256 from node:crypto; no BLAKE3 dependency is present, and hashing is not the bottleneck next to reading.
export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

const HASH = /^[0-9a-f]{64}$/;
/** Roots kept for diffs, besides the base. */
const KEEP = 16;
/** Named roots kept besides the history (one per chat). */
const MAX_PINS = 64;

/** A directory node's hash. Entries are sorted by name; names hold no NUL and hashes are fixed-length, so the encoding is unambiguous. */
export function nodeHash(entries: Entry[]): string {
  return sha256(entries.map(([name, hash, dir]) => `${dir ? 'd' : 'f'} ${name}\0${hash}\n`).join(''));
}

const parentOf = (rel: string) => {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
};
const nameOf = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
/** A child's key in its directory: the name for a file, name + '/' for a directory. Sorting keys sorts entries. */
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class MerkleTree {
  /** Leaf: path → content hash. */
  private readonly files = new Map<string, string>();
  /** Directory → its children's keys. '' is the root. */
  private readonly kids = new Map<string, Set<string>>([['', new Set()]]);
  /** Directories whose hash is current. */
  private readonly clean = new Map<string, string>();
  /** Stored directory nodes of kept roots, by hash. */
  private readonly nodes = new Map<string, Entry[]>();
  /** Kept roots, oldest first. */
  history: string[] = [];
  /** A root kept whatever the history does: the tree as the project was last opened. */
  base?: string;
  /** Directory hashes computed; directory nodes compared by diff(). For tests. */
  hashed = 0;
  visits = 0;

  get size(): number {
    return this.files.size;
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  get(rel: string): string | undefined {
    return this.files.get(rel);
  }

  set(rel: string, hash: string): void {
    if (this.files.get(rel) === hash) return;
    this.files.set(rel, hash);
    let child = rel;
    let key = nameOf(rel);
    for (;;) {
      const dir = parentOf(child);
      let set = this.kids.get(dir);
      if (!set) this.kids.set(dir, (set = new Set()));
      set.add(key);
      this.clean.delete(dir);
      if (!dir) break;
      key = `${nameOf(dir)}/`;
      child = dir;
    }
  }

  delete(rel: string): void {
    if (!this.files.delete(rel)) return;
    let child = rel;
    let key = nameOf(rel);
    let emptied = true;
    for (;;) {
      const dir = parentOf(child);
      const set = this.kids.get(dir)!;
      if (emptied) set.delete(key);
      emptied = dir !== '' && set.size === 0;
      if (emptied) this.kids.delete(dir);
      this.clean.delete(dir);
      if (!dir) break;
      key = `${nameOf(dir)}/`;
      child = dir;
    }
  }

  /** The project hash. */
  root(): string {
    return this.dirHash('');
  }

  private entries(dir: string): Entry[] {
    return [...this.kids.get(dir)!].sort(byKey).map((k) =>
      k.endsWith('/') ? [k.slice(0, -1), this.dirHash(join(dir, k.slice(0, -1))), true] : [k, this.files.get(join(dir, k))!, false],
    );
  }

  private dirHash(dir: string): string {
    let h = this.clean.get(dir);
    if (h === undefined) {
      this.hashed++;
      this.clean.set(dir, (h = nodeHash(this.entries(dir))));
    }
    return h;
  }

  /** Keeps the current root and its nodes for later diffs, and returns it. */
  snapshot(): string {
    const root = this.store('');
    this.history = [...this.history.filter((r) => r !== root), root].slice(-KEEP);
    this.gc();
    return root;
  }

  /**
   * Keeps the current root under a name (a chat's last turn) apart from the history, which it
   * doesn't push out; at most MAX_PINS names, the oldest dropped. Not saved: pins live per window.
   */
  pin(key: string): string {
    const root = this.store('');
    this.pins.delete(key);
    this.pins.set(key, root);
    if (this.pins.size > MAX_PINS) this.pins.delete(this.pins.keys().next().value!);
    this.gc();
    return root;
  }

  readonly pins = new Map<string, string>();

  private store(dir: string): string {
    const h = this.dirHash(dir);
    // A stored node means its whole subtree is stored.
    if (this.nodes.has(h)) return h;
    const e = this.entries(dir);
    this.nodes.set(h, e);
    for (const [name, , isDir] of e) if (isDir) this.store(join(dir, name));
    return h;
  }

  private gc(): void {
    const live = new Set<string>();
    const mark = (h: string) => {
      if (live.has(h)) return;
      live.add(h);
      for (const [, child, dir] of this.nodes.get(h) ?? []) if (dir) mark(child);
    };
    for (const r of [...this.history, ...this.pins.values(), ...(this.base ? [this.base] : [])]) mark(r);
    for (const h of this.nodes.keys()) if (!live.has(h)) this.nodes.delete(h);
  }

  /** A kept root from its full hash or a unique prefix (8+ hex). */
  resolve(prefix: string): string | undefined {
    const p = prefix.toLowerCase();
    const hits = [...new Set([...this.history, ...(this.base ? [this.base] : []), this.root()])].filter((r) => r.startsWith(p));
    return hits.length === 1 ? hits[0] : undefined;
  }

  /**
   * The files that differ between a kept root and now, sorted by path, at most `cap` of them, and
   * the total. Null when `from` is not a kept root. Only subtrees whose hashes differ are visited.
   */
  diff(from: string, cap = Infinity): { changes: Change[]; total: number } | null {
    if (from !== this.root() && !this.nodes.has(from)) return null;
    const out: Change[] = [];
    let total = 0;
    const emit = (path: string, change: Change['change']) => {
      total++;
      if (out.length < cap) out.push({ path, change });
    };
    const allOld = (h: string, dir: string) => {
      for (const [name, child, isDir] of this.nodes.get(h)!) {
        if (isDir) allOld(child, join(dir, name));
        else emit(join(dir, name), 'D');
      }
    };
    const allNew = (dir: string) => {
      for (const [name, , isDir] of this.entries(dir)) {
        if (isDir) allNew(join(dir, name));
        else emit(join(dir, name), 'A');
      }
    };
    const walk = (old: Entry[], dir: string) => {
      this.visits++;
      const was = new Map(old.map((e) => [e[2] ? `${e[0]}/` : e[0], e]));
      const now = new Map(this.entries(dir).map((e) => [e[2] ? `${e[0]}/` : e[0], e]));
      for (const key of [...new Set([...was.keys(), ...now.keys()])].sort(byKey)) {
        const o = was.get(key);
        const n = now.get(key);
        const path = join(dir, (o ?? n)![0]);
        if (o && n) {
          if (o[1] === n[1]) continue;
          if (o[2]) walk(this.nodes.get(o[1])!, path);
          else emit(path, 'M');
        } else if (o) {
          if (o[2]) allOld(o[1], path);
          else emit(path, 'D');
        } else if (n![2]) allNew(path);
        else emit(path, 'A');
      }
    };
    if (from !== this.root()) walk(this.nodes.get(from)!, '');
    // Paths come out in key order per directory; sort them as whole paths.
    out.sort((a, b) => byKey(a.path, b.path));
    return { changes: out, total };
  }

  /** The kept roots and their nodes, to save. The leaves are saved by their owner. */
  toJSON(): object {
    return { v: 1, history: this.history, base: this.base, nodes: [...this.nodes] };
  }

  /**
   * Takes back saved roots and nodes. Every node must hash to its key and every kept root must be
   * stored; anything off drops the lot (diffs then start from now) and returns false.
   */
  load(saved: unknown): boolean {
    const s = saved as { v?: unknown; history?: unknown; base?: unknown; nodes?: unknown } | null;
    if (!s || typeof s !== 'object' || s.v !== 1 || !Array.isArray(s.history) || !Array.isArray(s.nodes)) return false;
    const nodes = new Map<string, Entry[]>();
    for (const raw of s.nodes) {
      if (!Array.isArray(raw) || typeof raw[0] !== 'string' || !Array.isArray(raw[1])) return false;
      const entries = raw[1] as unknown[];
      const ok = entries.every(
        (e) => Array.isArray(e) && e.length === 3 && typeof e[0] === 'string' && e[0] && !/[/\0]/.test(e[0]) && typeof e[1] === 'string' && HASH.test(e[1]) && typeof e[2] === 'boolean',
      );
      if (!ok || nodeHash(entries as Entry[]) !== raw[0]) return false;
      nodes.set(raw[0], entries as Entry[]);
    }
    // Closed: every directory a node names is stored too.
    for (const e of nodes.values()) if (e.some(([, h, dir]) => dir && !nodes.has(h))) return false;
    const roots = [...s.history, ...(s.base === undefined ? [] : [s.base])];
    if (!roots.every((r) => typeof r === 'string' && nodes.has(r))) return false;
    for (const [h, e] of nodes) this.nodes.set(h, e);
    this.history = (s.history as string[]).slice(-KEEP);
    this.base = s.base as string | undefined;
    return true;
  }
}
