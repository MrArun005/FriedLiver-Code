// Per-turn checkpoints that don't depend on how an agent writes. Claude and
// Codex edit files themselves (not through FriedLiver), so a turn's changes are
// found by snapshotting the git working tree when the turn starts and ends
// (git.snapshot, a temporary index). Outside git, the core falls back to the
// before-content it saw in permission diffs and FriedLiver's own writes (TurnLog).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as git from '@friedliver/main/workspace/git';

interface Turn {
  turnId: string;
  root: string;
  before: string;
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

const KEEP = 20;
/** A repository whose snapshot takes longer than this gets none from then on, so turns don't wait on it. */
const SLOW_MS = 4_000;

export class Checkpoints {
  private readonly turns = new Map<string, Turn[]>();
  /** Chats whose turn is running, by repository. */
  private readonly running = new Map<string, Set<string>>();
  private readonly roots = new Map<string, string>();
  /** Repositories too slow (or broken) to snapshot; FriedLiver's own record still covers its writes there. */
  private readonly skipped = new Set<string>();

  constructor(private readonly log?: (line: string) => void) {}

  /** Snapshots the chat's repository before a turn. Resolves either way; a folder outside git gets none. */
  async begin(chatId: string, cwd: string, turnId: string): Promise<void> {
    const root = await this.rootOf(cwd);
    if (!root || this.skipped.has(root)) return;
    const others = this.running.get(root) ?? new Set<string>();
    this.running.set(root, others);
    const started = Date.now();
    try {
      const before = await git.snapshot(root);
      this.checkSpeed(root, started);
      const list = this.turns.get(chatId) ?? [];
      const shared = others.size > 0;
      // The chats already running share the repository with this one now, too.
      for (const id of others) {
        const t = this.turns.get(id)?.at(-1);
        if (t && t.root === root && !t.after) t.shared = true;
      }
      others.add(chatId);
      list.push({ turnId, root, before, files: [], shared });
      if (list.length > KEEP) list.shift();
      this.turns.set(chatId, list);
    } catch (err) {
      this.skipped.add(root);
      this.log?.(`No turn checkpoints in ${root} from now on: ${String(err)}`);
    }
  }

  private checkSpeed(root: string, started: number): void {
    const ms = Date.now() - started;
    if (ms <= SLOW_MS) return;
    this.skipped.add(root);
    this.log?.(`No turn checkpoints in ${root} from now on: a snapshot took ${Math.round(ms / 100) / 10} s (untracked folders that aren't in .gitignore make it slow).`);
  }

  /**
   * The files the turn changed, as absolute paths. When another chat worked in
   * the same repository meanwhile, only files this chat said it touched
   * (`reported`) count, since the snapshot can't tell the two apart.
   */
  async end(chatId: string, turnId: string, reported: Set<string>): Promise<string[]> {
    const turn = this.turns.get(chatId)?.at(-1);
    if (!turn || turn.turnId !== turnId) return [];
    this.running.get(turn.root)?.delete(chatId);
    try {
      const started = Date.now();
      turn.after = await git.snapshot(turn.root);
      this.checkSpeed(turn.root, started);
      const changed = await git.changedBetween(turn.root, turn.before, turn.after);
      const files = changed.map((c) => path.join(turn.root, c.path));
      turn.files = turn.shared ? files.filter((f) => reported.has(f)) : files;
    } catch (err) {
      this.log?.(`Couldn't read what the turn changed: ${String(err)}`);
      turn.files = [];
    }
    return turn.files;
  }

  /** Whether a turn has a checkpoint covering `file`. */
  covers(chatId: string, turnId: string, file: string): boolean {
    const turn = this.turns.get(chatId)?.find((t) => t.turnId === turnId);
    return !!turn?.files.includes(file);
  }

  /**
   * Puts back the files the turn changed. A file changed again since the turn
   * ended (by you or another chat) is left as it is and listed in `kept`.
   */
  async undo(chatId: string, turnId: string, io: UndoFiles): Promise<{ restored: string[]; kept: string[] }> {
    const list = this.turns.get(chatId) ?? [];
    const turn = list.at(-1);
    if (!turn || turn.turnId !== turnId || !turn.after) return { restored: [], kept: [] };
    const restored: string[] = [];
    const kept: string[] = [];
    for (const file of turn.files) {
      const rel = path.relative(turn.root, file).split(path.sep).join('/');
      const [then, now] = await Promise.all([git.blobAt(turn.root, turn.after, rel), readFile(file).catch(() => null)]);
      if (!sameBytes(then, now)) {
        kept.push(file);
        continue;
      }
      const before = await git.blobAt(turn.root, turn.before, rel);
      if (before === null) await io.remove(file);
      else await io.write(file, before);
      restored.push(file);
    }
    list.pop();
    return { restored, kept };
  }

  /** What `file` held before the oldest kept turn of the chat that changed it; null if that turn created it. */
  async firstBefore(chatId: string, file: string): Promise<Buffer | null | undefined> {
    const turn = this.turns.get(chatId)?.find((t) => t.files.includes(file));
    if (!turn) return undefined;
    return git.blobAt(turn.root, turn.before, path.relative(turn.root, file).split(path.sep).join('/'));
  }

  forget(chatId: string): void {
    this.turns.delete(chatId);
    for (const set of this.running.values()) set.delete(chatId);
  }

  /** Only found roots are kept: a folder may become a repository later. */
  private async rootOf(cwd: string): Promise<string | null> {
    const known = this.roots.get(cwd);
    if (known) return known;
    const root = await git.repoRoot(cwd);
    if (root) this.roots.set(cwd, root);
    return root;
  }
}

function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}
