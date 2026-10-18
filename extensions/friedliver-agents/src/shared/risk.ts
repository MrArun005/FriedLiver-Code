// How much care a request needs before you say yes: routine (looks, runs the project's own checks),
// review (changes something you can undo or see), careful (loses work, history, data or money, or
// touches secrets). The tone picks the card's weight, its inbox lane, and whether Allow is a
// press-and-hold. Pure: the webviews draw it, the host uses it to keep careful requests one at a
// time (no rule, no "this chat", no notification button answers them).
//
// ponytail: pattern lists, not a shell parser. They catch the common destructive forms; anything they
// don't recognise is "review", never "routine", so a miss costs a click, not safety.

export type RiskTone = 'routine' | 'review' | 'careful';

export interface Risk {
  tone: RiskTone;
  /** The chip: what kind of thing this is, in two to four words. */
  label: string;
  /** What would be lost or changed, one line each (careful requests). */
  consequences: string[];
  /** A safer way to get the same thing done, when there is a well-known one. */
  safer?: string;
  /** Why only "once" is offered, when the request itself rules out remembering it. */
  lock?: string;
  /** A force push: the remote, branch and local ref to compare (the host lists the commits it would drop). */
  push?: ForcePush;
}

/** The commits a force push would drop from the remote branch, as of the last fetch (the host lists them with git). */
export interface DroppedCommits {
  /** origin/main */
  ref: string;
  commits: { hash: string; subject: string; author: string }[];
  /** Beyond the ones listed. */
  more: number;
}

export const CAREFUL_LOCK = 'Careful requests are allowed one at a time, never remembered.';
const SECRETS_LOCK = '.env*, .git/ and ~/.ssh always ask, every time.';
const SENSITIVE_LOCK = 'Dot-files and agent instructions always ask, every time.';

// ---- Commands ----

/** The line's commands: split at ; && || | and newlines, each as words with quotes dropped. */
function segments(line: string): string[][] {
  return line
    .split(/\|\||&&|[;|\n]/)
    .map((s) =>
      s
        .trim()
        .replace(/["']/g, '')
        .split(/\s+/)
        .filter(Boolean),
    )
    .filter((w) => w.length > 0);
}

/** The program and its words after `sudo`, `env X=y`, `command`, `time`, `nohup` and variable assignments. */
function program(words: string[]): { words: string[]; sudo: boolean } {
  let i = 0;
  let sudo = false;
  while (i < words.length) {
    const w = words[i];
    if (w === 'sudo' || w === 'doas') sudo = true;
    else if (!(w === 'env' || w === 'command' || w === 'time' || w === 'nohup' || w === 'exec' || /^[A-Za-z_]\w*=/.test(w))) break;
    i++;
    if (sudo && words[i]?.startsWith('-')) i++;
  }
  return { words: words.slice(i).map((w, n) => (n === 0 ? w.replace(/^.*\//, '') : w)), sudo };
}

/** Short flags (-rf) as letters, long flags (--force) as words. */
function flags(words: string[]): { short: string; long: string[] } {
  const short = words.filter((w) => /^-[A-Za-z]+$/.test(w)).map((w) => w.slice(1)).join('');
  const long = words.filter((w) => w.startsWith('--')).map((w) => w.slice(2).split('=')[0]);
  return { short, long };
}

/** git's subcommand, past -C <dir>, -c <k=v> and other global flags. */
function gitSub(words: string[]): { sub: string; args: string[] } {
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) i += words[i] === '-C' || words[i] === '-c' ? 2 : 1;
  return { sub: words[i] ?? '', args: words.slice(i + 1) };
}

export interface ForcePush {
  remote: string;
  /** The branch on the remote it overwrites; undefined: the current branch's name. */
  dst?: string;
  /** What it pushes; undefined: HEAD. */
  src?: string;
}

const REF = /^[A-Za-z0-9._/-]+$/;
const safeRef = (r: string | undefined) => r === undefined || (REF.test(r) && !r.startsWith('-') && !r.includes('..') && r.length <= 200);

/** `git push --force [remote] [src:dst]`: what it would overwrite, or undefined for any other line. */
export function forcePush(line: string): ForcePush | undefined {
  for (const s of segments(line)) {
    const { words } = program(s);
    if (words[0] !== 'git') continue;
    const { sub, args } = gitSub(words);
    if (sub !== 'push') continue;
    const f = flags(args);
    const positional = args.filter((a) => !a.startsWith('-'));
    const plusRef = positional.slice(1).some((p) => p.startsWith('+'));
    const leaseOnly = f.long.includes('force-with-lease') && !f.long.includes('force') && !f.short.includes('f');
    if (!(f.long.includes('force') || f.short.includes('f') || plusRef) || leaseOnly) continue;
    const remote = positional[0] ?? 'origin';
    const spec = positional[1]?.replace(/^\+/, '');
    const [src, dst] = spec?.includes(':') ? spec.split(':', 2) : [spec, spec];
    const push = { remote, ...(dst ? { dst: dst.replace(/^refs\/heads\//, '') } : {}), ...(src ? { src } : {}) };
    return safeRef(push.remote) && safeRef(push.dst) && safeRef(push.src) ? push : { remote: 'origin' };
  }
  return undefined;
}

const READ_ONLY = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'ag', 'which', 'echo', 'file', 'stat', 'du', 'df', 'tree', 'less', 'whoami', 'date', 'diff', 'type', 'printenv', 'uname', 'sort', 'uniq', 'cut', 'jq']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'blame', 'rev-parse', 'ls-files', 'grep', 'describe', 'shortlog', 'reflog', 'remote', 'branch', 'tag', 'fetch', 'config']);
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const SCRIPTS = /^(test|t|lint|build|typecheck|check|format:check|tsc|vitest|jest)(:|$)/;
const TOOLS = new Set(['vitest', 'jest', 'tsc', 'eslint', 'pytest', 'mocha', 'ruff', 'mypy']);

/** A routine command: one that only looks, or runs the project's own tests, lint or build. */
function routine(words: string[]): 'Read-only' | 'Runs project scripts' | undefined {
  const [p, a = '', b = ''] = words;
  const f = flags(words);
  if (READ_ONLY.has(p)) return 'Read-only';
  if (p === 'find') return words.some((w) => /^-(delete|exec|execdir|ok|fprint)/.test(w)) ? undefined : 'Read-only';
  if (p === 'git') {
    const { sub, args } = gitSub(words);
    if (!GIT_READ.has(sub)) return undefined;
    const g = flags(args);
    // branch/tag/remote/config only when listing.
    if ((sub === 'branch' || sub === 'tag') && args.some((x) => !x.startsWith('-'))) return undefined;
    if (sub === 'branch' && /[dDmMcC]/.test(g.short)) return undefined;
    if (sub === 'remote' && args.some((x) => !x.startsWith('-'))) return undefined;
    if (sub === 'config' && !(g.long.includes('get') || g.long.includes('list') || g.short.includes('l'))) return undefined;
    return 'Read-only';
  }
  if (RUNNERS.has(p)) return SCRIPTS.test(a) || (a === 'run' && SCRIPTS.test(b)) ? 'Runs project scripts' : undefined;
  if (p === 'npx' || p === 'bunx') return TOOLS.has(a) ? 'Runs project scripts' : undefined;
  if (TOOLS.has(p)) return 'Runs project scripts';
  if (p === 'go' || p === 'cargo') return /^(test|vet|build|check|clippy|fmt)$/.test(a) && !(p === 'go' && a === 'fmt') ? 'Runs project scripts' : undefined;
  if (p === 'make') return /^(test|check|lint)$/.test(a) ? 'Runs project scripts' : undefined;
  if (p === 'node' || p === 'python' || p === 'python3') return f.long.includes('version') || f.short === 'v' || f.short === 'V' ? 'Read-only' : undefined;
  return undefined;
}

interface Hit {
  label: string;
  consequences: string[];
  safer?: string;
}

/** The first destructive thing a command does, in words. */
function carefulCommand(line: string): Hit | undefined {
  // Whole-line patterns first: they span the pipes the segments are split at.
  if (/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|fish|dash|python3?|node|perl|ruby)\b/i.test(line)) {
    return { label: 'Runs a script from the internet', consequences: ['Runs code downloaded from the internet, unseen, with your permissions'], safer: 'Download the script, read it, then run it' };
  }
  const sql = /\b(drop\s+(table|database|schema|collection)|truncate\s+(table\s+)?[\w."`]+)\b/i.exec(line) ?? /\bdelete\s+from\s+[\w."`]+(?![^;'"]*\bwhere\b)/i.exec(line);
  if (sql) return { label: 'Deletes data', consequences: [`${sql[0].replace(/\s+/g, ' ').trim()}: the rows are gone, with no undo here`], safer: 'Take a backup or dump first' };
  for (const s of segments(line)) {
    const { words, sudo } = program(s);
    const [p] = words;
    const f = flags(words.slice(1));
    const operands = words.slice(1).filter((w) => !w.startsWith('-'));
    const what = operands.length ? operands.slice(0, 3).join(' ') + (operands.length > 3 ? ' …' : '') : 'the files named';
    if (p === 'git') {
      const { sub, args } = gitSub(words);
      const g = flags(args);
      const push = forcePush(s.join(' '));
      if (push) {
        const lease = s.join(' ').replace(/\s--force(?=\s|$)|\s-f(?=\s|$)/, ' --force-with-lease');
        return {
          label: 'Rewrites shared history',
          consequences: [`Overwrites ${push.remote}/${push.dst ?? 'the current branch'} with your branch: commits only on the remote are lost`, "Other people's work on that branch would be lost"],
          ...(lease !== s.join(' ') ? { safer: lease } : {}),
        };
      }
      if (sub === 'reset' && g.long.includes('hard')) return { label: 'Discards uncommitted work', consequences: ['Uncommitted changes to tracked files are thrown away'], safer: 'git stash first, so the changes can come back' };
      if (sub === 'clean' && (g.short.includes('f') || g.long.includes('force'))) return { label: 'Deletes untracked files', consequences: ['Files git doesn’t track are deleted for good'], safer: `git clean -n${g.short.includes('d') ? 'd' : ''} to see the list first` };
      if (sub === 'branch' && (g.short.includes('D') || (g.long.includes('delete') && g.long.includes('force')))) return { label: 'Deletes a branch', consequences: ['Deletes the branch even if its commits aren’t merged anywhere'], safer: 'git branch -d refuses unmerged branches' };
      if ((sub === 'checkout' || sub === 'restore') && args.includes('.') && !args.includes('--staged')) return { label: 'Discards uncommitted work', consequences: ['Uncommitted changes in these files are thrown away'], safer: 'git stash first' };
    }
    if (p === 'rm' && (/[rR]/.test(f.short) || f.long.includes('recursive'))) return { label: 'Deletes files for good', consequences: [`Deletes ${what} and everything inside, skipping the Trash`] };
    if (p === 'find' && words.some((w) => w === '-delete' || ((w === '-exec' || w === '-execdir') && /^rm$/.test(words[words.indexOf(w) + 1] ?? '')))) return { label: 'Deletes files for good', consequences: ['Deletes every file the search matches, skipping the Trash'], safer: 'Run the find without -delete to see the list first' };
    if ((p === 'chmod' || p === 'chown' || p === 'chgrp') && (f.short.includes('R') || f.long.includes('recursive'))) return { label: 'Changes permissions recursively', consequences: [`Changes ${p === 'chmod' ? 'permissions' : 'ownership'} of ${what} and everything below it`] };
    if (p === 'dd' && words.some((w) => w.startsWith('of='))) return { label: 'Overwrites a disk or file', consequences: [`Writes raw bytes over ${words.find((w) => w.startsWith('of='))!.slice(3)}`] };
    if (p?.startsWith('mkfs')) return { label: 'Formats a disk', consequences: ['Erases everything on the device'] };
    if (p === 'terraform' && words[1] === 'destroy') return { label: 'Destroys infrastructure', consequences: ['Deletes every resource this configuration manages'], safer: 'terraform plan -destroy to see what goes first' };
    if (p === 'kubectl' && words[1] === 'delete') return { label: 'Deletes cluster resources', consequences: [`Deletes ${operands.slice(1).join(' ') || 'the named resources'} from the cluster`] };
    if (sudo) return { label: 'Runs as administrator', consequences: ['Runs with full rights over this machine'] };
  }
  return undefined;
}

/** How careful to be with a command line. */
export function commandRisk(line: string): Risk {
  const hit = carefulCommand(line);
  if (hit) {
    const push = forcePush(line);
    return { tone: 'careful', ...hit, lock: CAREFUL_LOCK, ...(push ? { push } : {}) };
  }
  const segs = segments(line);
  // Writing a file through a redirect is never routine (2>&1 and >/dev/null are only plumbing).
  const writes = /(^|[^0-9&>])>{1,2}(?!\s*&|\s*\/dev\/null)/.test(line.replace(/\d?>&\d/g, ''));
  const kinds = segs.map((s) => routine(program(s).words));
  if (segs.length && !writes && !line.includes('<<') && kinds.every(Boolean)) {
    return { tone: 'routine', label: kinds.includes('Runs project scripts') ? 'Runs project scripts' : 'Read-only', consequences: [] };
  }
  const words = program(segs[0] ?? []).words;
  const p = words[0];
  const label =
    p === 'git' && gitSub(words).sub === 'push'
      ? 'Pushes to a remote'
      : (RUNNERS.has(p) && /^(i|install|add|ci|remove|uninstall)$/.test(words[1] ?? '')) || p === 'pip' || p === 'brew'
        ? 'Installs packages'
        : p === 'rm' || p === 'mv' || writes
          ? 'Changes files'
          : 'Runs a command';
  return { tone: 'review', label, consequences: [] };
}

// ---- Files ----

const SECRET_NAME = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.netrc|\.npmrc|\.pypirc|credentials(\.json)?)$/i;
const SECRET_DIR = /^\.(ssh|aws|gnupg|kube|docker)$/i;
const AGENT_FILES = new Set(['claude.md', 'claude.local.md', 'agents.md', 'agents.override.md', 'gemini.md', 'copilot-instructions.md']);

/**
 * What a path is, for a write: secrets, keys and .git are careful; any other dot-file or dot-folder
 * (workflows, editor tasks, hooks, agent settings) and the agents' instruction files are sensitive
 * (once only, as host/permissions.ts never remembers a write there). Undefined: an ordinary file.
 */
export function sensitivePath(file: string): { careful: boolean; label: string } | undefined {
  const parts = file.split(/[\\/]/).filter(Boolean);
  const name = (parts.at(-1) ?? '').normalize('NFC').toLowerCase();
  if (parts.some((p) => p === '.git')) return { careful: true, label: 'Git internals' };
  if (SECRET_NAME.test(name)) return { careful: true, label: name.startsWith('.env') ? 'Secrets file' : 'Keys and credentials' };
  if (parts.some((p) => SECRET_DIR.test(p))) return { careful: true, label: 'Keys and credentials' };
  if (AGENT_FILES.has(name)) return { careful: false, label: 'Agent instructions' };
  if (name.endsWith('.code-workspace') || parts.some((p) => p.startsWith('.') || /[.\s]$/.test(p))) return { careful: false, label: parts.some((p) => p === '.github') ? 'Runs in CI' : 'Hidden config' };
  return undefined;
}

const within = (dir: string | undefined, file: string) => !!dir && (file === dir || file.startsWith(dir.endsWith('/') ? dir : `${dir}/`));

/** How careful to be with changing (or reading) these files. */
export function filesRisk(files: string[], access: 'read' | 'write', cwd?: string): Risk {
  const hits = files.map(sensitivePath);
  const careful = hits.find((h) => h?.careful);
  if (access === 'read') {
    return careful ? { tone: 'review', label: careful.label === 'Secrets file' ? 'Reads a secrets file' : `Reads ${careful.label.toLowerCase()}`, consequences: [] } : { tone: 'routine', label: 'Reads files', consequences: [] };
  }
  if (careful) {
    return {
      tone: 'careful',
      label: careful.label,
      consequences: [careful.label === 'Git internals' ? 'Git runs its config and hooks as programs; a change there never shows in a diff' : 'Changes a file that holds secrets or keys'],
      lock: SECRETS_LOCK,
    };
  }
  const sensitive = hits.find(Boolean);
  if (sensitive) return { tone: 'review', label: sensitive.label, consequences: [], lock: SENSITIVE_LOCK };
  const outside = cwd !== undefined && files.some((f) => !within(cwd, f));
  return { tone: 'review', label: outside ? 'Outside the project' : 'Inside the repo', consequences: [] };
}

// ---- The browser ----

const BUY = /\b(place[-_\s]?order|buy|purchase|pay|checkout|check[-_\s]?out|subscribe|donate|transfer|send[-_\s]?money|confirm[-_\s]?(order|payment))\b/i;
const SUBMIT = /\b(submit|send|delete|remove|confirm|sign[-_\s]?up|register|publish|post|apply)\b|type=["']?submit/i;

/** How careful to be with a browser action: `text` is the element (selector or its words) or what it types. */
export function browserRisk(tool: string, text: string, origin?: string): Risk {
  const where = origin ? ` on ${origin.replace(/^https?:\/\//, '')}` : '';
  if (tool === 'browser_open' || tool === 'browser_back' || tool === 'browser_reload') return { tone: 'routine', label: tool === 'browser_open' ? 'Opens a page' : 'Navigates', consequences: [] };
  if (tool === 'browser_click' && BUY.test(text)) {
    return { tone: 'careful', label: 'Places an order or pays', consequences: [`Can place a real order or payment${where}`, 'Money spent or orders sent can’t be taken back from here'], lock: CAREFUL_LOCK };
  }
  if (tool === 'browser_click' && SUBMIT.test(text)) {
    return { tone: 'careful', label: 'Submits a form', consequences: [`Sends what the page holds${where}, as you`], lock: CAREFUL_LOCK };
  }
  return { tone: 'review', label: tool === 'browser_type' ? 'Types into a page' : 'Clicks on a page', consequences: [] };
}

// ---- Between agents ----

export function agentToolRisk(tool: string): Risk {
  const label = tool === 'remember' ? 'Adds to project memory' : tool === 'read_chat' ? 'Reads another chat' : tool === 'send_to_chat' ? 'Messages another chat' : 'Shares chat context';
  return { tone: 'review', label, consequences: [] };
}

export const RISK_ORDER: Record<RiskTone, number> = { careful: 0, review: 1, routine: 2 };
