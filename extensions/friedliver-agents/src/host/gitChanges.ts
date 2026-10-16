// "Review My Changes": the working tree's changes as one request to an agent.
import path from 'node:path';
import * as git from '@friedliver/main/workspace/git';
import { fence } from './editorPrompt';

/** Characters of diff a review request carries; the agent reads the files for the rest. */
export const MAX_DIFF_CHARS = 150_000;
/** Files listed by name in a review request. */
export const MAX_LISTED_FILES = 200;

export interface WorkingChanges {
  root: string;
  /** Null on a detached HEAD. */
  branch: string | null;
  files: git.GitFile[];
  diff: string;
  /** The diff was cut short (or too big to read at all). */
  truncated: boolean;
}

/**
 * Staged and unstaged changes of the repository `folder` is in, with every
 * changed file listed (untracked ones too). Null when it isn't a git
 * repository; no `files` when nothing changed.
 */
export async function collectChanges(folder: string, maxChars = MAX_DIFF_CHARS): Promise<WorkingChanges | null> {
  const status = await git.status(folder);
  if (!status) return null;
  const base = { root: status.root, branch: status.branch, files: status.files };
  if (!status.files.length) return { ...base, diff: '', truncated: false };
  let diff = '';
  let truncated = false;
  try {
    diff = await git.workingDiff(status.root);
  } catch (err) {
    // Bigger than git's output buffer: list the files and let the agent read them.
    if (!/maxBuffer/i.test(String(err))) throw err;
    truncated = true;
  }
  if (diff.length > maxChars) {
    const cut = diff.slice(0, maxChars);
    diff = cut.slice(0, Math.max(cut.lastIndexOf('\n'), 0));
    truncated = true;
  }
  return { ...base, diff, truncated };
}

const STATUS_WORDS: Record<git.GitFile['status'], string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  U: 'new, untracked: not in the diff, read it if it matters',
  C: 'conflict',
};

export function branchName(changes: Pick<WorkingChanges, 'branch'>): string {
  return changes.branch ?? 'detached HEAD';
}

/** What the review chat shows as the user's message. */
export function reviewMessage(changes: WorkingChanges): string {
  const n = changes.files.length;
  return `Review my changes on ${branchName(changes)} (${n} file${n === 1 ? '' : 's'})`;
}

/** The context the agent gets: what to look for, the changed files and the diff. */
export function reviewPrompt(changes: WorkingChanges, cwd: string): string {
  const where = path.resolve(changes.root) === path.resolve(cwd) ? 'this repository' : `the repository at ${changes.root}`;
  const files = changes.files.slice(0, MAX_LISTED_FILES).map((f) => `- ${f.path} (${STATUS_WORDS[f.status]}${f.staged ? ', staged' : ''})`);
  if (changes.files.length > MAX_LISTED_FILES) files.push(`- … and ${changes.files.length - MAX_LISTED_FILES} more`);
  const parts = [
    [
      '[FriedLiver] Review request',
      `The user asks you to review their uncommitted changes in ${where}, on ${changes.branch ? `branch ${changes.branch}` : 'a detached HEAD'}. ` +
        'Read the diff below, and the files around it as you need. Point out bugs, missed edge cases, security problems, ' +
        'missing tests and anything unclear, most important first, each with its file and line. ' +
        "Don't change any files now: the user may ask you to fix things afterwards.",
    ].join('\n'),
    `Changed files (${changes.files.length}):\n${files.join('\n')}`,
  ];
  if (changes.diff) parts.push(`Diff (staged and unstaged, against the last commit):\n${fence(changes.diff, 'diff')}`);
  if (changes.truncated) parts.push(`[The diff is cut off${changes.diff ? ` after ${Math.round(changes.diff.length / 1000)} KB` : ''}. Read the remaining files yourself.]`);
  return parts.join('\n\n');
}
