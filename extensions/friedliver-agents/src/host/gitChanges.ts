// "Review My Changes": the working tree's changes as one request to an agent.
import path from 'node:path';
import * as git from '@friedliver/main/workspace/git';
import { fence } from './editorPrompt';

/** Characters of diff a review request carries (~10k tokens); over it, a --stat and each file's diff cut short. */
export const MAX_DIFF_CHARS = 40_000;
/** Files listed by name in a review request. */
export const MAX_LISTED_FILES = 200;

/** Lockfiles: generated, long, and nothing to review line by line. */
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'Gemfile.lock', 'poetry.lock', 'composer.lock', 'go.sum', 'Pipfile.lock', 'uv.lock'];
/** Left out of a review's diff (git pathspec globs): lockfiles, minified and source-map files, built output in dist/. */
export const DIFF_EXCLUDE = [...LOCKFILES.map((f) => `**/${f}`), '**/*.min.js', '**/*.min.css', '**/*.map', '**/dist/**'];

/** Whether a changed file is one DIFF_EXCLUDE leaves out (by path, `/`-separated, relative to the repository). */
export function excludedFromDiff(file: string): boolean {
  const p = file.split(path.sep).join('/');
  const name = p.slice(p.lastIndexOf('/') + 1);
  return LOCKFILES.includes(name) || /\.min\.(js|css)$|\.map$/.test(name) || /(^|\/)dist\//.test(p);
}

export interface WorkingChanges {
  root: string;
  /** Null on a detached HEAD. */
  branch: string | null;
  files: git.GitFile[];
  diff: string;
  /** The diff was cut short (or too big to read at all). */
  truncated: boolean;
  /** Over the cap: `git diff --stat` of every file, and `diff` holds each file's start. */
  stat?: string;
  /** Changed files left out of the diff (DIFF_EXCLUDE). */
  skipped?: string[];
}

/**
 * Staged and unstaged changes of the repository `folder` is in, with every
 * changed file listed (untracked ones too). Null when it isn't a git
 * repository; no `files` when nothing changed. Lockfiles, minified and built
 * files are named but not diffed. A diff over `maxChars` becomes a `--stat`
 * plus each file's diff cut short, within `maxChars` in all.
 */
export async function collectChanges(folder: string, maxChars = MAX_DIFF_CHARS): Promise<WorkingChanges | null> {
  const status = await git.status(folder);
  if (!status) return null;
  const skipped = status.files.filter((f) => f.status !== 'U' && excludedFromDiff(f.path)).map((f) => f.path);
  const base = { root: status.root, branch: status.branch, files: status.files, ...(skipped.length ? { skipped } : {}) };
  if (!status.files.length) return { ...base, diff: '', truncated: false };
  let diff = '';
  let truncated = false;
  try {
    diff = await git.workingDiff(status.root, { exclude: DIFF_EXCLUDE });
  } catch (err) {
    // Bigger than git's output buffer: the summary and the files' names, and the agent reads them.
    if (!/maxBuffer/i.test(String(err))) throw err;
    truncated = true;
  }
  if (!truncated && diff.length <= maxChars) return { ...base, diff, truncated };
  let stat = (await git.workingDiff(status.root, { exclude: DIFF_EXCLUDE, stat: true }).catch(() => '')).trimEnd();
  if (stat.length > maxChars / 2) stat = cutAtLine(stat, Math.floor(maxChars / 2));
  return { ...base, stat, diff: diff ? shortenDiff(diff, maxChars - stat.length) : '', truncated: true };
}

function cutAtLine(text: string, max: number): string {
  const cut = text.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf('\n'), 0));
}

/** Each file's diff from its start, the room shared fairly (a small file whole, the rest alike), all within `budget`. */
export function shortenDiff(diff: string, budget: number): string {
  const files = diff.split(/^(?=diff --git )/m).filter(Boolean);
  const NOTE = 80;
  const order = files.map((f, n) => ({ f, n })).sort((a, b) => a.f.length - b.f.length);
  const out: string[] = new Array<string>(files.length).fill('');
  let left = Math.max(0, budget);
  order.forEach(({ f, n }, k) => {
    const share = Math.floor(left / (order.length - k));
    if (f.length <= share) {
      out[n] = f;
    } else if (share > NOTE + 40) {
      const kept = cutAtLine(f, share - NOTE);
      const more = f.slice(kept.length).split('\n').filter(Boolean).length;
      out[n] = `${kept}\n… ${more} more line${more === 1 ? '' : 's'} of this file's diff left out\n`;
    }
    left -= out[n].length;
  });
  return out.join('').trimEnd();
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
  if (changes.stat) parts.push(`Summary (git diff --stat):\n${fence(changes.stat)}`);
  if (changes.diff) parts.push(`Diff (staged and unstaged, against the last commit${changes.stat ? ", each file's cut short" : ''}):\n${fence(changes.diff, 'diff')}`);
  if (changes.truncated) {
    parts.push(
      changes.stat !== undefined
        ? `[The diff is too big to send whole${changes.diff ? `: about ${Math.round(changes.diff.length / 1000)} KB of it is above, the start of each file's` : ''}. Read the files in the summary for the rest.]`
        : `[The diff is cut off${changes.diff ? ` after ${Math.round(changes.diff.length / 1000)} KB` : ''}. Read the remaining files yourself.]`,
    );
  }
  if (changes.skipped?.length) {
    const n = changes.skipped.length;
    parts.push(`[Not in the diff: ${n} lockfile${n === 1 ? '' : 's'}, minified or built file${n === 1 ? '' : 's'} (${changes.skipped.slice(0, 10).join(', ')}${n > 10 ? ', …' : ''}). Read them only if they matter.]`);
  }
  return parts.join('\n\n');
}
