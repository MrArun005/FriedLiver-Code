// FriedLiver's own copies of the images agents read, take and make, so the Images view
// keeps showing them after a temp file is gone, and so "Done looking" can give the space
// back: the copies, and the temp originals agents and FriedLiver made, never your files.
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MAX_IMAGE_FILE_BYTES, THUMB_PX, readVetted, scaleHere, type Scaler } from './imageAccess';
import { pngSize } from './png';

const RASTER = /\.(png|jpe?g|gif|webp)$/i;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
/** A copy's file name: its content's sha256, `.p.png` for its preview. */
const COPY_NAME = /^[0-9a-f]{64}(\.p)?\.(png|jpg|gif|webp)$/;
/** The folders FriedLiver's screenshots go in (browserRules.ts, mkdtemp). */
const SHOTS_DIR = /^shots-[A-Za-z0-9]{6}$/;
/** Hidden gallery keys kept; past it the oldest are forgotten (their images would show again). */
const MAX_HIDDEN = 20_000;

/** Which file a path was, so a file swapped in under the same name is never mistaken for it. */
export interface Identity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
const idOf = (s: Identity): Identity => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs });

/** The identity of a raster image file at `file` itself: null for a symlink, a folder, or another kind of file. */
export async function identity(file: string): Promise<Identity | null> {
  if (!RASTER.test(file)) return null;
  const st = await lstat(file).catch(() => null);
  return st?.isFile() ? idOf(st) : null;
}

/**
 * `root`'s real path when deleting inside it is safe, else null. The root must be a real folder
 * (not a symlink: another user could pre-create /tmp/claude-<uid> as a link to your home), owned
 * by `uid`, writable by nobody else. Every folder above its real path must be owned by `uid` or
 * root, and sticky when others may write there (/tmp), so nobody else can rename or replace a
 * folder on the way. Checked again on every deletion, never cached.
 */
export async function trustedRoot(root: string, uid = process.getuid?.()): Promise<string | null> {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) return null;
  const own = await lstat(root).catch(() => null);
  if (!own || own.isSymbolicLink() || !own.isDirectory()) return null;
  // No uid (Windows): no owners or modes to check; the symlink check above still holds.
  if (uid === undefined) return realpath(root).catch(() => null);
  if (own.uid !== uid || (own.mode & 0o022) !== 0) return null;
  const real = await realpath(root).catch(() => null);
  if (!real) return null;
  // realpath may pass a system link above the root (macOS /tmp -> /private/tmp): the real path must be the same folder.
  const top = await lstat(real).catch(() => null);
  if (!top || top.ino !== own.ino || top.dev !== own.dev) return null;
  for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
    const st = await lstat(dir).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return null;
    if (st.uid !== uid && st.uid !== 0) return null;
    if ((st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0) return null;
    if (path.dirname(dir) === dir) return real;
  }
}

/** Whether `file` is strictly below `root` (both real paths). */
function below(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Deletes `file` only when every check holds: an absolute, normalised path (no `..`) to a
 * PNG, JPEG, GIF or WebP; its real folder (every symlink resolved) strictly inside one of
 * `roots`' real paths; not itself a symlink; and still the very file `expect` describes
 * (device, inode, size, modified time), so one swapped in since the user chose is left alone.
 */
// ponytail: the last lstat and the unlink are two calls (Node has no unlinkat on a held folder); a root
// passes trustedRoot only when nobody else can write in it or swap it, so nobody can swap in between.
// unlink never follows the last component, and identity() refuses a symlink there anyway.
export async function removeTemp(file: string, roots: readonly string[], expect: Identity, uid = process.getuid?.()): Promise<boolean> {
  if (typeof file !== 'string' || file.includes('\0') || !path.isAbsolute(file) || path.normalize(file) !== file || !RASTER.test(file)) return false;
  const dir = await realpath(path.dirname(file)).catch(() => null);
  if (!dir) return false;
  const real = path.join(dir, path.basename(file));
  const allowed = await Promise.all(roots.map((r) => trustedRoot(r, uid)));
  if (!allowed.some((r) => r && below(r, real))) return false;
  const now = await identity(real);
  if (!now || !same(now, expect)) return false;
  return unlink(real).then(
    () => true,
    () => false,
  );
}

/**
 * Deletes FriedLiver's own screenshots (in `base`'s shots-XXXXXX folders) older than
 * `maxAgeMs`, except those in `keep` (pinned). Returns how many went.
 */
export async function sweepOld(base: string, maxAgeMs: number, keep: ReadonlySet<string>, now = Date.now()): Promise<number> {
  let gone = 0;
  for (const name of await readdir(base).catch(() => [] as string[])) {
    const dir = path.join(base, name);
    if (!SHOTS_DIR.test(name) || !(await lstat(dir).catch(() => null))?.isDirectory()) continue;
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      const file = path.join(dir, f);
      const id = await identity(file);
      if (id && now - id.mtimeMs > maxAgeMs && !keep.has(file) && (await removeTemp(file, [dir], id))) gone++;
    }
  }
  return gone;
}

/** An image in the Images view: its key there, and its file when it has one. */
export interface GalleryRef {
  key: string;
  path?: string;
}

export interface Limits {
  capBytes: number;
  maxAgeMs: number;
}

export interface Copy {
  file: string;
  /** At most THUMB_PX on its longest side; only for a bigger PNG. */
  preview?: string;
}

interface Stored {
  ext: string;
  bytes: number;
  /** The preview's bytes; 0 for none. */
  preview: number;
  /** When it was copied, for the age limit. */
  at: number;
}

interface Index {
  v: 1;
  files: Record<string, Stored>;
  /** Which copy a path became, and the file it was then. */
  paths: Record<string, { hash: string; id: Identity }>;
  /** Pinned gallery keys and their files: kept through Done looking and eviction. */
  pinned: Record<string, string | null>;
  /** Gallery keys you were done looking at. */
  hidden: string[];
}

const empty = (): Index => ({ v: 1, files: {}, paths: {}, pinned: {}, hidden: [] });

export class ImageStore {
  private index = empty();
  private queue: Promise<unknown> = Promise.resolve();
  /** The last Done looking, until it is committed (deleted) or undone. */
  private pending?: { refs: GalleryRef[]; ids: Map<string, Identity> };
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly dir: string,
    private readonly opts: {
      /** The temp folders whose originals Done looking may delete: FriedLiver's screenshots, agents' temp folders. */
      tempRoots(): Promise<string[]>;
      scale?: Scaler;
      now?: () => number;
      onChange?: () => void;
    },
  ) {}

  private now = () => (this.opts.now ?? Date.now)();
  private file = (hash: string) => path.join(this.dir, `${hash}.${this.index.files[hash].ext}`);
  private previewFile = (hash: string) => path.join(this.dir, `${hash}.p.png`);

  /** One change at a time: copies, pins, deletions. */
  private run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Reads the index, and deletes copies it doesn't know (a crash between a copy and the index). */
  load(): Promise<void> {
    return this.run(async () => {
      try {
        const raw = JSON.parse(await readFile(path.join(this.dir, 'index.json'), 'utf8')) as Index;
        if (raw?.v === 1 && raw.files && raw.paths && raw.pinned && Array.isArray(raw.hidden)) this.index = raw;
      } catch {
        // None yet, or unreadable: start empty.
      }
      const known = new Set(Object.keys(this.index.files));
      for (const name of await readdir(this.dir).catch(() => [] as string[])) {
        const stray = name.endsWith('.tmp') || (COPY_NAME.test(name) && !known.has(name.slice(0, 64)));
        if (stray) await rm(path.join(this.dir, name), { force: true }).catch(() => {});
      }
    });
  }

  /** Writes the index now (also done by itself shortly after each change). */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.run(() => this.write('index.json', Buffer.from(JSON.stringify(this.index))));
  }

  private changed(): void {
    this.opts.onChange?.();
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush().catch(() => {}), 500);
    this.timer.unref?.();
  }

  /** Written aside and renamed, so a reader never sees half a file. */
  private async write(name: string, bytes: Buffer): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, name);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, file);
  }

  private out(hash: string): Copy {
    return { file: this.file(hash), ...(this.index.files[hash].preview ? { preview: this.previewFile(hash) } : {}) };
  }

  /**
   * The copy of the image at `file`: made now (after imageAccess's checks against `roots`)
   * when there is none or the file changed since; the old one when the file is gone.
   */
  ingest(file: string, roots: readonly string[]): Promise<Copy | null> {
    return this.run(async () => {
      const known = this.index.paths[file];
      const had = known && this.index.files[known.hash] ? known.hash : undefined;
      const st = await stat(file).catch(() => null);
      if (had && (!st || same(idOf(st), known.id))) return this.out(had);
      const v = st && (await readVetted(file, roots, MAX_IMAGE_FILE_BYTES));
      if (!v || !st) return had ? this.out(had) : null;
      const hash = createHash('sha256').update(v.bytes).digest('hex');
      if (!this.index.files[hash]) {
        const ext = EXT[v.type];
        await this.write(`${hash}.${ext}`, v.bytes);
        let preview = 0;
        const size = v.type === 'image/png' ? pngSize(v.bytes) : null;
        if (size && (size.width > THUMB_PX || size.height > THUMB_PX)) {
          // A PNG that can't be scaled (damaged, too big, too slow) keeps no preview; the view shows its name.
          const small = await (this.opts.scale ?? scaleHere)(v.bytes, THUMB_PX).catch(() => null);
          if (small && pngSize(small)) {
            await this.write(`${hash}.p.png`, small);
            preview = small.length;
          }
        }
        this.index.files[hash] = { ext, bytes: v.bytes.length, preview, at: this.now() };
      }
      this.index.paths[file] = { hash, id: idOf(st) };
      this.changed();
      return this.out(hash);
    });
  }

  /** Bytes the copies and previews take. */
  used(): number {
    return Object.values(this.index.files).reduce((n, f) => n + f.bytes + f.preview, 0);
  }

  pinned(): string[] {
    return Object.keys(this.index.pinned);
  }

  /** Hidden keys, the pending Done looking's too. */
  hidden(): string[] {
    return [...new Set([...this.index.hidden, ...(this.pending?.refs.map((r) => r.key) ?? [])])];
  }

  pin(ref: GalleryRef, on: boolean): Promise<void> {
    return this.run(async () => {
      if (on) this.index.pinned[ref.key] = ref.path ?? null;
      else delete this.index.pinned[ref.key];
      this.changed();
    });
  }

  /**
   * Done looking at `refs`: they hide now (pinned ones stay), and their files are deleted on
   * commit, unless undone first. A previous Done looking still pending is committed first.
   * `gallery` is every image the view has, to know what is still shown.
   */
  done(refs: readonly GalleryRef[], gallery: readonly GalleryRef[]): Promise<void> {
    return this.run(async () => {
      await this.commitNow(gallery);
      const mine = refs.filter((r) => !(r.key in this.index.pinned));
      const ids = new Map<string, Identity>();
      for (const r of mine) {
        // The file as it is now: only this file is deleted later.
        const id = r.path ? await identity(r.path) : null;
        if (r.path && id) ids.set(r.path, id);
      }
      this.pending = { refs: mine, ids };
      this.changed();
    });
  }

  undo(): void {
    if (!this.pending) return;
    this.pending = undefined;
    this.changed();
  }

  /** Deletes what the pending Done looking hid; see done(). */
  commit(gallery: readonly GalleryRef[]): Promise<{ copies: number; originals: number }> {
    return this.run(() => this.commitNow(gallery));
  }

  private async commitNow(gallery: readonly GalleryRef[]): Promise<{ copies: number; originals: number }> {
    const p = this.pending;
    if (!p) return { copies: 0, originals: 0 };
    this.pending = undefined;
    this.index.hidden = [...new Set([...this.index.hidden, ...p.refs.map((r) => r.key)])].slice(-MAX_HIDDEN);
    const hidden = new Set(this.index.hidden);
    // A file still shown somewhere (another chat, a pinned image) keeps its copy and its original.
    const live = new Set<string>();
    for (const g of gallery) if (g.path && (!hidden.has(g.key) || g.key in this.index.pinned)) live.add(g.path);
    for (const f of Object.values(this.index.pinned)) if (f) live.add(f);
    const liveCopies = new Set([...live].flatMap((f) => this.index.paths[f]?.hash ?? []));
    const temps = await this.opts.tempRoots();
    let copies = 0;
    let originals = 0;
    for (const r of p.refs) {
      if (!r.path || live.has(r.path)) continue;
      const hash = this.index.paths[r.path]?.hash;
      if (hash && this.index.files[hash] && !liveCopies.has(hash)) {
        await this.drop(hash);
        copies++;
      }
      delete this.index.paths[r.path];
      const id = p.ids.get(r.path);
      if (id && (await removeTemp(r.path, temps, id))) originals++;
    }
    this.changed();
    return { copies, originals };
  }

  /** The safety net: copies past the age limit go, then the oldest until under the cap. Pinned ones stay. */
  enforce(limits: Limits): Promise<number> {
    return this.run(async () => {
      const keep = new Set(Object.values(this.index.pinned).flatMap((f) => (f && this.index.paths[f]?.hash) || []));
      let used = this.used();
      let gone = 0;
      for (const [hash, f] of Object.entries(this.index.files).sort((a, b) => a[1].at - b[1].at)) {
        if (keep.has(hash) || (this.now() - f.at <= limits.maxAgeMs && used <= limits.capBytes)) continue;
        used -= f.bytes + f.preview;
        await this.drop(hash);
        gone++;
      }
      if (gone) this.changed();
      return gone;
    });
  }

  /** Pinned images' files, which the screenshot sweep keeps. */
  pinnedFiles(): Set<string> {
    return new Set(Object.values(this.index.pinned).flatMap((f) => f ?? []));
  }

  private async drop(hash: string): Promise<void> {
    await rm(this.file(hash), { force: true }).catch(() => {});
    await rm(this.previewFile(hash), { force: true }).catch(() => {});
    delete this.index.files[hash];
    for (const [f, seen] of Object.entries(this.index.paths)) if (seen.hash === hash) delete this.index.paths[f];
  }
}
