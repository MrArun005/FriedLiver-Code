// Per-turn checkpoints that don't depend on how an agent writes. Claude and
// Codex edit files themselves (not through FriedLiver), so a turn's changes are
// found by snapshotting the working folder when the turn starts and ends.
// In git: a tree built in a temporary index (git.snapshot), kept reachable as a
// commit under the private refs/friedliver/checkpoints/<chat>/<n>, so the
// user's HEAD, index, branches and stash never change. Outside git: file
// manifests with content-addressed copies in global storage (dirSnapshots.ts).
// Any kept turn can be rewound to (rewind); undo is a rewind of the last turn.
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as git from '@friedliver/main/workspace/git';
import { diffLines } from '../shared/diff';
import { DirSnapshots } from './dirSnapshots';

interface Turn {
  turnId: string;
  /** Per chat, from 1: the ref's last part. */
  n: number;
  at: number;
  root: string;
  kind: 'git' | 'dir';
  before: string;
  /** The commit keeping `before` (git). */
  beforeCommit?: string;
  after?: string;
  /** Absolute paths that changed, once the turn ended. */
  files: string[];
  /** Another chat worked in the same repository during this turn. */
  shared: boolean;
}

export interface UndoFiles {
  write(file: string, content: Buffer): Promise<void>;
  remove(file: string): Promise<void>;
}

export interface CheckpointInfo {
  turnId: string;
  at: number;
  files: string[];
}

export interface RewindFile {
  file: string;
  added: number;
  removed: number;
  /** Changed since the agent's last turn (by you, or something else): asks before it's overwritten. */
  conflict: boolean;
}

export interface RewindPlan {
  turnId: string;
  files: RewindFile[];
  added: number;
  removed: number;
}

export interface CheckpointOptions {
  log?: (line: string) => void;
  /** Where the index and non-git snapshots live (global storage). Without it, git checkpoints only, in memory. */
  dir?: string;
  /** Checkpoints older than this are pruned. */
  maxAgeMs?: number;
  /** Total bytes non-git snapshots may take; the oldest go first. */
  maxBytes?: number;
  now?: () => number;
  /** Turns whose checkpoints went (rewound, pruned, forgotten). */
  onGone?: (chatId: string, turnIds: string[]) => void;
}

const KEEP = 100;
const DAY = 86_400_000;
/** A repository whose snapshot takes longer than this gets none from then on, so turns don't wait on it. */
const SLOW_MS = 4_000;

export class Checkpoints {
  private turns = new Map<string, Turn[]>();
  /** Chats whose turn is running, by repository. */
  private readonly running = new Map<string, Set<string>>();
  /** Folders too slow (or broken) to snapshot; FriedLiver's own record still covers its writes there. */
  private readonly skipped = new Set<string>();
  private readonly files?: DirSnapshots;
  private readonly log?: (line: string) => void;
  private readonly now: () => number;

  constructor(private readonly opts: CheckpointOptions = {}) {
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
    if (opts.dir) this.files = new DirSnapshots(path.join(opts.dir, 'files'));
  }

  /** Brings back checkpoints saved by an earlier window, then prunes old ones. */
  async load(): Promise<void> {
    if (!this.opts.dir) return;
    try {
      const saved = JSON.parse(await readFile(this.indexPath(), 'utf8')) as { version: 1; chats: Record<string, Turn[]> };
      if (saved.version === 1) this.turns = new Map(Object.entries(saved.chats).map(([id, list]) => [id, list.filter((t) => t.after)]));
    } catch {
      // None yet.
    }
    await this.prune();
  }

  /** Snapshots the chat's folder before a turn. Resolves either way: true when the turn has a checkpoint. */
  async begin(chatId: string, cwd: string, turnId: string): Promise<boolean> {
    const repo = await git.repoRoot(cwd);
    const root = repo ?? path.resolve(cwd);
    const kind = repo ? 'git' : 'dir';
    if (this.skipped.has(root) || (kind === 'dir' && !this.files)) return false;
    const others = this.running.get(root) ?? new Set<string>();
    this.running.set(root, others);
    const started = this.now();
    try {
      const before = await this.snapshot(kind, root);
      this.checkSpeed(root, started);
      const list = this.turns.get(chatId) ?? [];
      const n = (list.at(-1)?.n ?? 0) + 1;
      const turn: Turn = { turnId, n, at: this.now(), root, kind, before, files: [], shared: others.size > 0 };
      if (kind === 'git') turn.beforeCommit = await git.keepSnapshot(root, this.ref(chatId, n), before);
      // The chats already running share the folder with this one now, too.
      for (const id of others) {
        const t = this.turns.get(id)?.at(-1);
        if (t && t.root === root && !t.after) t.shared = true;
      }
      others.add(chatId);
      list.push(turn);
      this.turns.set(chatId, list);
      if (list.length > KEEP) await this.drop(chatId, list.splice(0, list.length - KEEP));
      return true;
    } catch (err) {
      this.skipped.add(root);
      this.log?.(`No turn checkpoints in ${root} from now on: ${String(err)}`);
      return false;
    }
  }

  private snapshot(kind: Turn['kind'], root: string): Promise<string> {
    return kind === 'git' ? git.snapshot(root) : this.files!.snapshot(root);
  }

  private checkSpeed(root: string, started: number): void {
    const ms = this.now() - started;
    if (ms <= SLOW_MS) return;
    this.skipped.add(root);
    this.log?.(`No turn checkpoints in ${root} from now on: a snapshot took ${Math.round(ms / 100) / 10} s (untracked folders that aren't in .gitignore make it slow).`);
  }

  /**
   * The files the turn changed, as absolute paths. When another chat worked in
   * the same folder meanwhile, only files this chat said it touched
   * (`reported`) count, since the snapshot can't tell the two apart.
   */
  async end(chatId: string, turnId: string, reported: Set<string>): Promise<string[]> {
    const list = this.turns.get(chatId);
    const turn = list?.at(-1);
    if (!list || !turn || turn.turnId !== turnId) return [];
    this.running.get(turn.root)?.delete(chatId);
    try {
      const started = this.now();
      turn.after = await this.snapshot(turn.kind, turn.root);
      this.checkSpeed(turn.root, started);
      if (turn.kind === 'git') await git.keepSnapshot(turn.root, this.ref(chatId, turn.n), turn.after, turn.beforeCommit);
      const changed = turn.kind === 'git' ? (await git.changedBetween(turn.root, turn.before, turn.after)).map((c) => c.path) : await this.files!.changedBetween(turn.before, turn.after);
      const files = changed.map((c) => path.join(turn.root, c));
      turn.files = turn.shared ? files.filter((f) => reported.has(f)) : files;
    } catch (err) {
      this.log?.(`Couldn't read what the turn changed: ${String(err)}`);
      turn.files = [];
    }
    if (!turn.after) {
      list.pop();
      this.opts.onGone?.(chatId, [turn.turnId]);
    }
    await this.prune();
    return turn.files;
  }

  /** Whether a turn has a checkpoint covering `file`. */
  covers(chatId: string, turnId: string, file: string): boolean {
    const turn = this.turns.get(chatId)?.find((t) => t.turnId === turnId);
    return !!turn?.files.includes(file);
  }

  /** The chat's kept checkpoints, oldest first. */
  list(chatId: string): CheckpointInfo[] {
    return (this.turns.get(chatId) ?? []).filter((t) => t.after).map((t) => ({ turnId: t.turnId, at: t.at, files: t.files }));
  }

  has(chatId: string, turnId: string): boolean {
    return !!this.turns.get(chatId)?.some((t) => t.turnId === turnId && t.after);
  }

  /** What rewinding to the start of `turnId` would change, file by file. */
  async plan(chatId: string, turnId: string): Promise<RewindPlan> {
    const { turn, files, last } = this.span(chatId, turnId);
    const out: RewindFile[] = [];
    for (const file of files) {
      const rel = relOf(turn.root, file);
      const [target, expected, now] = await Promise.all([this.blob(turn, turn.before, rel), this.blob(last, last.after!, rel), readFile(file).catch(() => null)]);
      if (sameBytes(target, now)) continue;
      let added = 0;
      let removed = 0;
      for (const l of diffLines(now?.toString('utf8'), target?.toString('utf8'))) {
        if (l.op === '+') added++;
        else if (l.op === '-') removed++;
      }
      out.push({ file, added, removed, conflict: !sameBytes(expected, now) });
    }
    return { turnId, files: out, added: out.reduce((s, f) => s + f.added, 0), removed: out.reduce((s, f) => s + f.removed, 0) };
  }

  /**
   * Puts the files the turns from `turnId` on changed back as they were before
   * it, and forgets those turns. A file changed since the agent's last turn
   * (`plan` marks it a conflict) is only overwritten when `useCheckpoint` says
   * so; otherwise it is left as it is and listed in `kept`. Paths outside the
   * folder, or through a symlink, are refused.
   */
  async rewind(chatId: string, turnId: string, io: UndoFiles, useCheckpoint: (file: string) => boolean = () => false): Promise<{ restored: string[]; kept: string[]; turnIds: string[] }> {
    const { turn, files, last, from } = this.span(chatId, turnId);
    const restored: string[] = [];
    const kept: string[] = [];
    const writes: { file: string; target: string; before: Buffer | null }[] = [];
    // Every path is checked before the first write, so a refused one leaves nothing half-restored.
    for (const file of files) {
      const rel = relOf(turn.root, file);
      const [expected, now] = await Promise.all([this.blob(last, last.after!, rel), readFile(file).catch(() => null)]);
      if (!sameBytes(expected, now) && !useCheckpoint(file)) {
        kept.push(file);
        continue;
      }
      const target = await safeTarget(turn.root, rel);
      const before = await this.blob(turn, turn.before, rel);
      if (!sameBytes(before, now)) writes.push({ file, target, before });
    }
    for (const { file, target, before } of writes) {
      if (before === null) await io.remove(target);
      else await io.write(target, before);
      restored.push(file);
    }
    const list = this.turns.get(chatId)!;
    const gone = list.splice(from);
    await this.drop(chatId, gone);
    await this.save();
    return { restored, kept, turnIds: gone.map((t) => t.turnId) };
  }

  /** Undoes the chat's latest turn; files changed since it are left alone. */
  async undo(chatId: string, turnId: string, io: UndoFiles): Promise<{ restored: string[]; kept: string[] }> {
    const turn = this.turns.get(chatId)?.at(-1);
    if (!turn || turn.turnId !== turnId || !turn.after) return { restored: [], kept: [] };
    return this.rewind(chatId, turnId, io);
  }

  /** What `file` held before the oldest kept turn of the chat that changed it; null if that turn created it. */
  async firstBefore(chatId: string, file: string): Promise<Buffer | null | undefined> {
    const turn = this.turns.get(chatId)?.find((t) => t.files.includes(file));
    if (!turn) return undefined;
    return this.blob(turn, turn.before, relOf(turn.root, file));
  }

  /** Deletes the chat's checkpoints (refs and stored files). */
  async forget(chatId: string): Promise<void> {
    for (const set of this.running.values()) set.delete(chatId);
    const list = this.turns.get(chatId);
    this.turns.delete(chatId);
    if (list) await this.drop(chatId, list);
    await this.save();
  }

  /** Drops checkpoints past their age, and the oldest non-git ones past the size cap. */
  async prune(): Promise<void> {
    const cutoff = this.now() - (this.opts.maxAgeMs ?? 14 * DAY);
    for (const [chatId, list] of this.turns) {
      const old = list.filter((t) => t.at < cutoff && t.after);
      if (!old.length) continue;
      this.turns.set(chatId, list.filter((t) => !old.includes(t)));
      await this.drop(chatId, old);
    }
    await this.capSize();
    await this.save();
  }

  private async capSize(): Promise<void> {
    if (!this.files) return;
    const max = this.opts.maxBytes ?? 512 * 1024 * 1024;
    while ((await this.files.bytes()) > max) {
      const oldest = [...this.turns].flatMap(([chatId, list]) => list.filter((t) => t.kind === 'dir' && t.after).map((t) => ({ chatId, t }))).sort((a, b) => a.t.at - b.t.at)[0];
      if (!oldest) return;
      const list = this.turns.get(oldest.chatId)!;
      // Later turns rewind through this one: they go with it.
      await this.drop(oldest.chatId, list.splice(0, list.indexOf(oldest.t) + 1));
      this.log?.('Pruned the oldest checkpoints to stay within the size limit.');
    }
  }

  /** The turn `turnId`, every file it and the turns after it changed, and the last ended turn. */
  private span(chatId: string, turnId: string): { turn: Turn; files: string[]; last: Turn; from: number } {
    const list = this.turns.get(chatId) ?? [];
    const from = list.findIndex((t) => t.turnId === turnId);
    const last = list.at(-1);
    if (from < 0 || !last?.after) throw new Error('That checkpoint is gone (pruned, or the turn is still running).');
    const later = list.slice(from);
    return { turn: list[from], files: [...new Set(later.flatMap((t) => t.files))].sort(), last, from };
  }

  private blob(turn: Turn, id: string, rel: string): Promise<Buffer | null> {
    return turn.kind === 'git' ? git.blobAt(turn.root, id, rel) : this.files!.blobAt(id, rel).catch(() => null);
  }

  private ref(chatId: string, n: number): string {
    return `${git.CHECKPOINT_REFS}${chatId.replace(/[^A-Za-z0-9_-]/g, '_')}/${n}`;
  }

  private async drop(chatId: string, gone: Turn[]): Promise<void> {
    if (gone.length) this.opts.onGone?.(chatId, gone.map((t) => t.turnId));
    const ids: string[] = [];
    for (const t of gone) {
      if (t.kind === 'git') await git.dropCheckpointRef(t.root, this.ref(chatId, t.n)).catch(() => {});
      else ids.push(t.before, ...(t.after ? [t.after] : []));
    }
    if (ids.length) await this.files?.drop(ids).catch(() => {});
  }

  private indexPath(): string {
    return path.join(this.opts.dir!, 'index.json');
  }

  private async save(): Promise<void> {
    if (!this.opts.dir) return;
    try {
      await mkdir(this.opts.dir, { recursive: true });
      const chats = Object.fromEntries([...this.turns].map(([id, list]) => [id, list.filter((t) => t.after)]));
      await writeFile(this.indexPath(), JSON.stringify({ version: 1, chats }));
    } catch (err) {
      this.log?.(`Couldn't save checkpoints: ${String(err)}`);
    }
  }
}

function relOf(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

/**
 * The absolute path to restore `rel` to, refusing anything outside `root` and
 * any path through a symlink (a folder on the way, or the file itself).
 */
export async function safeTarget(root: string, rel: string): Promise<string> {
  const target = path.resolve(root, rel);
  const inside = path.relative(root, target);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`${rel} is outside ${root}; not restored.`);
  let at = root;
  for (const part of inside.split(path.sep)) {
    at = path.join(at, part);
    const st = await lstat(at).catch(() => null);
    if (!st) break;
    if (st.isSymbolicLink()) throw new Error(`${rel} goes through a symlink; not restored.`);
  }
  return target;
}

function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}
