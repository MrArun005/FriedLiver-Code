import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
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
  await git(root, ['worktree', 'add', '-b', branch, wt]);
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
  await git(root, ['worktree', 'remove', '--force', wt.path]);
  await git(root, ['branch', '-D', wt.branch]).catch(() => '');
}
