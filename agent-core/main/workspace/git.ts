import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { findOnWindowsPath } from '../agents/processes';

const run = promisify(execFile);

/**
 * Git by absolute path on Windows: started by bare name with the repository as
 * its working folder, Windows would run a `git.exe` the repository contains.
 */
function gitProgram(): string {
  if (process.platform !== 'win32') return 'git';
  const found = findOnWindowsPath('git.exe');
  if (!found) throw new Error('Git is not installed (git.exe is not on PATH).');
  return found;
}

/**
 * A repository's own config can name an fsmonitor program, which status, add,
 * commit and merge would run. It only speeds git up, so FriedLiver's calls turn
 * it off. Hooks still run: committing and merging a task is meant to behave
 * like git does for you.
 */
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false'];

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, timeout?: number): Promise<string> {
  try {
    const { stdout } = await run(gitProgram(), [...SAFE_CONFIG, ...args], {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      ...(env ? { env: { ...process.env, ...env } } : {}),
      ...(timeout ? { timeout } : {}),
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error((e.stderr || e.message).trim(), { cause: err });
  }
}

export interface GitFile {
  /** Path relative to the repository root, with `/`. */
  path: string;
  /** One letter for the UI: M modified, A added, D deleted, R renamed, U untracked, C conflict. */
  status: 'M' | 'A' | 'D' | 'R' | 'U' | 'C';
  staged: boolean;
}

export interface GitStatus {
  root: string;
  branch: string | null;
  files: GitFile[];
}

export async function installed(): Promise<boolean> {
  try {
    await git(process.cwd(), ['--version']);
    return true;
  } catch {
    return false;
  }
}

export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    return path.resolve((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    return null;
  }
}

export async function status(cwd: string): Promise<GitStatus | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  // -z: NUL-separated, so paths with spaces or newlines parse safely.
  const out = await git(root, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']);
  const parts = out.split('\0');
  let branch: string | null = null;
  const files: GitFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    if (entry.startsWith('## ')) {
      const name = entry.slice(3).split('...')[0];
      branch = name.startsWith('No commits yet on ') ? name.slice('No commits yet on '.length) : name.startsWith('HEAD') ? null : name;
      continue;
    }
    const x = entry[0];
    const y = entry[1];
    const file = entry.slice(3);
    if (x === 'R' || x === 'C') i++; // The original path follows a rename.
    files.push({ path: file, status: letter(x, y), staged: x !== ' ' && x !== '?' });
  }
  return { root, branch, files };
}

function letter(x: string, y: string): GitFile['status'] {
  if (x === '?' && y === '?') return 'U';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'C';
  const c = x !== ' ' ? x : y;
  return c === 'A' || c === 'D' || c === 'R' ? c : 'M';
}

/** A file's content at HEAD, or null when it isn't committed. */
export async function headContent(root: string, relPath: string): Promise<string | null> {
  try {
    return await git(root, ['show', `HEAD:${relPath.split(path.sep).join('/')}`]);
  } catch {
    return null;
  }
}

/**
 * Staged and unstaged changes to tracked files, as one patch against HEAD (or,
 * before the first commit, what is staged followed by what isn't). External
 * diff programs and textconv filters stay off: a repository's config or
 * `.gitattributes` would otherwise run them. `exclude`: git pathspec globs left
 * out (lockfiles, built files); `stat`: a `--stat` summary instead of the patch.
 */
export async function workingDiff(root: string, options: { exclude?: readonly string[]; stat?: boolean } = {}): Promise<string> {
  const opts = ['--no-color', '--no-ext-diff', '--no-textconv', '-M', ...(options.stat ? ['--stat=200,160', '--stat-count=500'] : [])];
  const specs = options.exclude?.length ? ['.', ...options.exclude.map((g) => `:(exclude,glob)${g}`)] : [];
  const head = await git(root, ['rev-parse', '--verify', '-q', 'HEAD']).then(
    () => true,
    () => false,
  );
  if (head) return git(root, ['diff', ...opts, 'HEAD', '--', ...specs]);
  return (await git(root, ['diff', '--cached', ...opts, '--', ...specs])) + (await git(root, ['diff', ...opts, '--', ...specs]));
}

/** Stages everything and commits. Returns the short commit hash. */
export async function commitAll(root: string, message: string): Promise<string> {
  if (!message.trim()) throw new Error('Write a commit message first.');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', message]);
  return (await git(root, ['rev-parse', '--short', 'HEAD'])).trim();
}

export interface Worktree {
  path: string;
  branch: string;
}

/**
 * A separate checkout on its own branch, so a parallel agent can't trample the
 * main folder. Lives next to the repo (not inside it) so it never shows up in
 * the file tree, searches or `git status`.
 */
export async function createWorktree(root: string, name: string): Promise<Worktree> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
  const branch = `friedliver/${slug}-${Date.now().toString(36)}`;
  const dir = path.join(path.dirname(root), `.${path.basename(root)}-worktrees`);
  await mkdir(dir, { recursive: true });
  const wt = path.join(dir, branch.split('/')[1]);
  await git(root, ['worktree', 'add', '-b', branch, '--', wt]);
  return { path: wt, branch };
}

/** Commits the task's work in its worktree and merges the branch into the main checkout. */
export async function mergeWorktree(root: string, wt: Worktree, message: string): Promise<void> {
  const pending = await git(wt.path, ['status', '--porcelain']);
  if (pending.trim()) {
    await git(wt.path, ['add', '-A']);
    await git(wt.path, ['commit', '-m', message]);
  }
  await git(root, ['merge', '--no-ff', '-m', `Merge ${wt.branch}`, wt.branch]);
}

export async function removeWorktree(root: string, wt: Worktree): Promise<void> {
  await git(root, ['worktree', 'remove', '--force', '--', wt.path]);
  await git(root, ['branch', '-D', '--', wt.branch]).catch(() => '');
}

export interface WorktreeChange {
  /** Relative to the worktree (and the main checkout), with `/`. */
  path: string;
  status: 'A' | 'M' | 'D';
}

/**
 * What a task's worktree changed since it branched from the main checkout:
 * commits on its branch, uncommitted edits and new files. Commits made in the
 * main checkout since then don't count, so they don't show as reverted.
 */
export async function worktreeChanges(root: string, wt: Worktree): Promise<WorktreeChange[]> {
  const main = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const base = (await git(wt.path, ['merge-base', 'HEAD', main])).trim();
  const changes = new Map<string, WorktreeChange['status']>();
  // -z: NUL-separated "status\0path\0" pairs; --no-renames keeps one path per entry.
  const parts = (await git(wt.path, ['diff', '--name-status', '--no-renames', '-z', base, '--'])).split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const s = parts[i];
    if (s) changes.set(parts[i + 1], s === 'A' ? 'A' : s === 'D' ? 'D' : 'M');
  }
  for (const file of (await git(wt.path, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0')) {
    if (file) changes.set(file, 'A');
  }
  return [...changes].map(([p, status]) => ({ path: p, status })).sort((a, b) => a.path.localeCompare(b.path));
}

// ---- Checkpoints ----

/** How long a snapshot may take before the turn goes without one. */
const SNAPSHOT_TIMEOUT_MS = 8_000;

/**
 * The working tree as a git tree object: tracked and untracked files, minus
 * ignored ones. Built in a temporary index (a copy of the real one, so
 * unchanged files aren't hashed again), so the user's index, stash and
 * branches stay as they are; only unreachable objects are added, which git
 * prunes in time. Hooks don't run for these commands.
 */
export async function snapshot(root: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'friedliver-snap-'));
  const index = path.join(dir, 'index');
  try {
    const real = path.resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'])).trim());
    // The copy keeps the real index's mtime: git trusts an entry's stat only when the file is older
    // than the index, so a fresh mtime would hide a same-size edit made in the second it was staged.
    await copyFile(real, index)
      .then(async () => {
        const st = await stat(real);
        await utimes(index, st.atime, st.mtime);
      })
      .catch(() => {});
    const env = { GIT_INDEX_FILE: index };
    await git(root, ['add', '-A', '--', '.'], env, SNAPSHOT_TIMEOUT_MS);
    return (await git(root, ['write-tree'], env, SNAPSHOT_TIMEOUT_MS)).trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Files that differ between two snapshots, relative to the repository root with `/`. */
export async function changedBetween(root: string, before: string, after: string): Promise<WorktreeChange[]> {
  if (before === after) return [];
  const parts = (await git(root, ['diff-tree', '-r', '--no-renames', '--name-status', '-z', '--no-ext-diff', before, after, '--'])).split('\0');
  const out: WorktreeChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const s = parts[i];
    if (s) out.push({ path: parts[i + 1], status: s === 'A' ? 'A' : s === 'D' ? 'D' : 'M' });
  }
  return out;
}

/** A file's bytes in a snapshot, or null when the snapshot doesn't have it. */
export async function blobAt(root: string, tree: string, relPath: string): Promise<Buffer | null> {
  try {
    const { stdout } = await run(gitProgram(), [...SAFE_CONFIG, 'cat-file', 'blob', `${tree}:${relPath}`], {
      cwd: root,
      encoding: 'buffer',
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

/** Checkpoint commits need an identity and must never ask for a signature. */
const KEEP_ENV = {
  GIT_AUTHOR_NAME: 'FriedLiver',
  GIT_AUTHOR_EMAIL: 'checkpoints@friedliver.invalid',
  GIT_COMMITTER_NAME: 'FriedLiver',
  GIT_COMMITTER_EMAIL: 'checkpoints@friedliver.invalid',
};

/** Private namespace for checkpoint refs: never a branch, tag, HEAD, index or stash. */
export const CHECKPOINT_REFS = 'refs/friedliver/checkpoints/';

/**
 * Keeps a snapshot tree reachable under `ref` (inside CHECKPOINT_REFS) as a
 * commit, with `parent` (a commit) before it, so `git gc` doesn't prune it.
 * Only the ref moves: HEAD, the index, branches and the stash stay as they are.
 */
export async function keepSnapshot(root: string, ref: string, tree: string, parent?: string): Promise<string> {
  if (!ref.startsWith(CHECKPOINT_REFS)) throw new Error(`Not a checkpoint ref: ${ref}`);
  const args = ['-c', 'commit.gpgSign=false', 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'FriedLiver checkpoint'];
  const commit = (await git(root, args, KEEP_ENV)).trim();
  await git(root, ['update-ref', '--no-deref', ref, commit]);
  return commit;
}

/** Checkpoint refs under `prefix` (inside CHECKPOINT_REFS). */
export async function checkpointRefs(root: string, prefix = CHECKPOINT_REFS): Promise<string[]> {
  if (!prefix.startsWith(CHECKPOINT_REFS)) return [];
  return (await git(root, ['for-each-ref', '--format=%(refname)', prefix])).split('\n').filter(Boolean);
}

export async function dropCheckpointRef(root: string, ref: string): Promise<void> {
  if (!ref.startsWith(CHECKPOINT_REFS)) throw new Error(`Not a checkpoint ref: ${ref}`);
  await git(root, ['update-ref', '-d', ref]).catch(() => '');
}

/**
 * Config that could make a read-only git command run a program or reach the network, turned off: it
 * runs before the user has said yes, in a repository the agent works in. System and global config
 * aren't read (READ_ONLY_ENV), the repository is the workspace root's own .git folder (never one git
 * would discover: nested, bare or planted), and no network operation is allowed. Residual risk: the
 * repository's own config is still read for everything else, and git may gain new program-running
 * keys; the calls stay to rev-parse and log --format, which run none of the others (no diff, no
 * textconv, no hooks, no fetch).
 */
export const READ_ONLY_CONFIG = [
  '--no-pager',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.pager=cat',
  '-c', 'log.showSignature=false',
  '-c', 'gpg.program=false',
  '-c', 'gpg.ssh.program=false',
  '-c', 'gpg.x509.program=false',
  '-c', 'diff.external=',
  '-c', 'core.sshCommand=false',
  '-c', 'core.gitProxy=',
  '-c', 'credential.helper=',
  '-c', 'protocol.allow=never',
  '-c', 'safe.bareRepository=explicit',
  '-c', 'uploadpack.packObjectsHook=',
];
export const READ_ONLY_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_EXTERNAL_DIFF: '',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
};

/**
 * What a force push of `local` to `remote`/`branch` would drop: the commits the remote-tracking
 * branch has that `local` doesn't, newest first, as of the last fetch (nothing is fetched). `root` is
 * a workspace root: its own .git must be a real folder (not a file, as in a worktree, nor a link), and
 * git is pointed at exactly that (GIT_DIR, GIT_CEILING_DIRECTORIES). `branch` undefined: the current
 * branch's name. Null when any of that doesn't hold or there is no such tracking branch. Names are
 * passed as single arguments after checks, never through a shell, and never as options; git runs
 * with READ_ONLY_CONFIG and READ_ONLY_ENV, and a timeout.
 */
export async function remoteOnlyCommits(
  root: string,
  remote: string,
  branch: string | undefined,
  local = 'HEAD',
  max = 10,
): Promise<{ ref: string; commits: { hash: string; subject: string; author: string }[]; more: number } | null> {
  const ok = (r: string) => /^[A-Za-z0-9._/-]+$/.test(r) && !r.startsWith('-') && !r.includes('..') && r.length <= 200;
  if (![remote, local].every(ok) || !path.isAbsolute(root)) return null;
  const gitDir = path.join(root, '.git');
  const info = await lstat(gitDir).catch(() => null);
  if (!info?.isDirectory()) return null;
  const env = { ...READ_ONLY_ENV, GIT_DIR: gitDir, GIT_WORK_TREE: root, GIT_CEILING_DIRECTORIES: path.dirname(root) };
  const run = (args: string[]) => git(root, [...READ_ONLY_CONFIG, ...args], env, 5000);
  const name = branch ?? (await run(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  if (!name || name === 'HEAD' || !ok(name)) return null;
  const tracking = `refs/remotes/${remote}/${name}`;
  if (!(await run(['rev-parse', '--verify', '--quiet', `${tracking}^{commit}`]).catch(() => ''))) return null;
  const out = await run(['log', '--no-color', '--no-show-signature', '--no-ext-diff', '--format=%h%x1f%s%x1f%an', tracking, '--not', local, '--']).catch(() => null);
  if (out === null) return null;
  const lines = out.split('\n').filter(Boolean);
  const commits = lines.slice(0, max).map((l) => {
    const [hash = '', subject = '', author = ''] = l.split('\x1f');
    return { hash, subject: subject.slice(0, 200), author: author.slice(0, 80) };
  });
  return { ref: `${remote}/${name}`, commits, more: Math.max(0, lines.length - max) };
}
