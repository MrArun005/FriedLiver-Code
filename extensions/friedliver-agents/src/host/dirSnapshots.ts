// Checkpoints for folders outside git: a manifest of the folder's files, with
// each file's bytes kept once under its hash (unchanged files cost nothing on
// the next turn). Lives in the extension's global storage, size-capped.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Per file: its hash, or `skip` for a file too big to keep (left out of every restore). */
type Entry = { h: string; s: number; m: number } | { skip: true };
type Manifest = Record<string, Entry>;

export interface DirLimits {
  maxFiles: number;
  maxFileBytes: number;
}

const DEFAULTS: DirLimits = { maxFiles: 20_000, maxFileBytes: 8 * 1024 * 1024 };
/** Folders that are rebuilt, not written: never snapshotted. */
const SKIP_DIRS = new Set(['.git', 'node_modules']);

export class DirSnapshots {
  /** The latest manifest per folder, so unchanged files aren't hashed again. */
  private readonly last = new Map<string, Manifest>();
  private nextId = 1;

  constructor(
    private readonly dir: string,
    private readonly limits: DirLimits = DEFAULTS,
  ) {}

  /** Records the folder's files. Throws when the folder has more files than a snapshot takes. */
  async snapshot(root: string): Promise<string> {
    const prev = this.last.get(root) ?? {};
    const manifest: Manifest = {};
    let count = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const ent of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        // Symlinks are never followed (nor kept): only real files and folders.
        if (ent.isDirectory()) {
          if (!SKIP_DIRS.has(ent.name)) await walk(full);
          continue;
        }
        if (!ent.isFile()) continue;
        if (++count > this.limits.maxFiles) throw new Error(`more than ${this.limits.maxFiles} files`);
        const rel = path.relative(root, full).split(path.sep).join('/');
        const st = await stat(full);
        if (st.size > this.limits.maxFileBytes) {
          manifest[rel] = { skip: true };
          continue;
        }
        const old = prev[rel];
        if (old && !('skip' in old) && old.s === st.size && old.m === st.mtimeMs) {
          manifest[rel] = old;
          continue;
        }
        const bytes = await readFile(full);
        const h = createHash('sha256').update(bytes).digest('hex');
        await this.putBlob(h, bytes);
        manifest[rel] = { h, s: st.size, m: st.mtimeMs };
      }
    };
    await walk(root);
    this.last.set(root, manifest);
    const id = `snap-${Date.now().toString(36)}-${this.nextId++}`;
    await mkdir(path.join(this.dir, 'manifests'), { recursive: true });
    await writeFile(path.join(this.dir, 'manifests', `${id}.json`), JSON.stringify(manifest));
    return id;
  }

  /** Files whose content differs between two snapshots (skipped files never count). */
  async changedBetween(a: string, b: string): Promise<string[]> {
    const [ma, mb] = await Promise.all([this.manifest(a), this.manifest(b)]);
    const out: string[] = [];
    for (const rel of new Set([...Object.keys(ma), ...Object.keys(mb)])) {
      const x = ma[rel];
      const y = mb[rel];
      if ((x && 'skip' in x) || (y && 'skip' in y)) continue;
      if (x?.h !== y?.h) out.push(rel);
    }
    return out.sort();
  }

  async blobAt(id: string, rel: string): Promise<Buffer | null> {
    const e = (await this.manifest(id))[rel];
    if (!e || 'skip' in e) return null;
    return readFile(this.blobPath(e.h));
  }

  /** Forgets snapshots, then deletes file contents no kept snapshot names. */
  async drop(ids: string[]): Promise<void> {
    for (const id of ids) await rm(this.manifestPath(id), { force: true });
    const keep = new Set<string>();
    const names = await readdir(path.join(this.dir, 'manifests')).catch(() => [] as string[]);
    for (const name of names) {
      const m = await this.manifest(name.replace(/\.json$/, '')).catch(() => ({}) as Manifest);
      for (const e of Object.values(m)) if (!('skip' in e)) keep.add(e.h);
    }
    for (const h of await readdir(path.join(this.dir, 'blobs')).catch(() => [] as string[])) {
      if (!keep.has(h)) await rm(this.blobPath(h), { force: true });
    }
    this.last.clear();
  }

  /** Bytes the stored file contents take. */
  async bytes(): Promise<number> {
    let total = 0;
    for (const h of await readdir(path.join(this.dir, 'blobs')).catch(() => [] as string[])) total += (await stat(this.blobPath(h)).catch(() => ({ size: 0 }))).size;
    return total;
  }

  private async manifest(id: string): Promise<Manifest> {
    return JSON.parse(await readFile(this.manifestPath(id), 'utf8')) as Manifest;
  }

  private manifestPath(id: string): string {
    if (!/^snap-[a-z0-9-]+$/.test(id)) throw new Error(`Bad snapshot id ${id}`);
    return path.join(this.dir, 'manifests', `${id}.json`);
  }

  private blobPath(h: string): string {
    return path.join(this.dir, 'blobs', h);
  }

  private async putBlob(h: string, bytes: Buffer): Promise<void> {
    await mkdir(path.join(this.dir, 'blobs'), { recursive: true });
    await writeFile(this.blobPath(h), bytes, { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    });
  }
}
