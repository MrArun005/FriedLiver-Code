// Your characters from a git repository (friedliver.companion.repo), so they follow you to every
// machine: a shallow clone in the extension's storage, pulled at startup, every 6 hours and on
// "Update Characters". Git runs by absolute path with no shell, no hooks, no file:/ext: transports
// and no prompts: your credential helper (or ssh agent) answers, or it fails. FriedLiver never asks
// for or keeps a token. A failure never holds up an ask: the next source stands in.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PULL_EVERY_MS = 6 * 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 60_000;

/** https:// (no user or password in it), ssh://, or scp-style git@host:path. Nothing else (no file:, ext::, http:). */
export function repoUrlOk(url: string): boolean {
  if (/[\s\0]/.test(url) || url.startsWith('-')) return false;
  if (/^git@[\w.-]+:[\w./~-]+$/.test(url)) return true;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return !!u.hostname && !u.username && !u.password && u.pathname.length > 1;
    if (u.protocol === 'ssh:') return !!u.hostname && !u.password && u.pathname.length > 1;
  } catch {
    return false;
  }
  return false;
}

/** `<storage>/companion/<hash of the URL>`. */
export function repoDir(storage: string, url: string): string {
  return path.join(storage, 'companion', createHash('sha256').update(url).digest('hex').slice(0, 16));
}

/** Config for every call: hooks from an empty folder, no local or ext:: transports, no fsmonitor program. */
export function safeConfig(emptyHooks: string): string[] {
  return ['-c', `core.hooksPath=${emptyHooks}`, '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'core.fsmonitor=false'];
}

/**
 * Never a prompt: a credential helper or ssh agent answers, or git fails. ssh is put in batch mode only
 * when you haven't set it up yourself (GIT_SSH_COMMAND, GIT_SSH, or core.sshCommand in your git config).
 */
export function gitEnv(base: NodeJS.ProcessEnv = process.env, sshCommandConfigured = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  if (!base.GIT_SSH_COMMAND && !base.GIT_SSH && !sshCommandConfigured) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return env;
}

export function sshCommandArgs(emptyHooks: string): string[] {
  return [...safeConfig(emptyHooks), 'config', '--get', 'core.sshCommand'];
}

export function cloneArgs(url: string, dir: string, emptyHooks: string): string[] {
  return [...safeConfig(emptyHooks), 'clone', '--depth', '1', '--no-tags', '--single-branch', '--', url, dir];
}

export function pullArgs(emptyHooks: string): string[] {
  return [...safeConfig(emptyHooks), 'pull', '--ff-only', '--depth', '1', '--no-tags'];
}

export type RepoFailure = 'address' | 'sign-in' | 'offline' | 'git';

/** What went wrong, from git's words, for the message (one per kind per session). */
export function failureOf(err: unknown): RepoFailure {
  const e = err as { code?: unknown; stderr?: unknown; message?: unknown };
  if (e?.code === 'ENOENT') return 'git';
  const text = `${typeof e?.stderr === 'string' ? e.stderr : ''} ${typeof e?.message === 'string' ? e.message : ''}`;
  if (/could not resolve host|failed to connect|timed out|network is unreachable|connection (refused|reset)|ETIMEDOUT|SIGTERM/i.test(text)) return 'offline';
  if (/authentication|could not read (username|password)|permission denied|terminal prompts disabled|403|401|repository not found|not found/i.test(text)) return 'sign-in';
  return 'git';
}

const REASONS: Record<RepoFailure, string> = {
  address: 'only https://, ssh:// and git@ addresses are used',
  'sign-in': "git couldn't sign in (check your credential helper, gh auth or ssh key) or the repository doesn't exist",
  offline: "couldn't reach it (offline?)",
  git: 'git failed (is it installed?)',
};

/** Runs git without a shell; resolves to its output. */
export type RunGit = (file: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; timeout: number }) => Promise<string | void>;

const runGit: RunGit = (file, args, options) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { ...options, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(out))),
  );

export interface CharacterRepoOptions {
  /** The extension's globalStorage folder. */
  storage: () => string;
  /** Git's absolute path (agent-core's gitProgram). */
  git: () => string;
  warn: (message: string) => void;
  run?: RunGit;
}

export class CharacterRepo {
  private readonly reported = new Set<RepoFailure>();
  private inFlight: Promise<void> | undefined;

  constructor(private readonly o: CharacterRepoOptions) {}

  /** The clone to read characters from, when there is one. */
  dir(url: string | undefined): string | undefined {
    if (!url || !repoUrlOk(url)) return undefined;
    const dir = repoDir(this.o.storage(), url);
    return fs.existsSync(path.join(dir, '.git')) ? dir : undefined;
  }

  /** Clones (first time) or pulls. Never throws: a failure is said once per kind per session. */
  sync(url: string | undefined): Promise<void> {
    if (!url) return Promise.resolve();
    this.inFlight ??= this.syncNow(url).finally(() => (this.inFlight = undefined));
    return this.inFlight;
  }

  private async syncNow(url: string): Promise<void> {
    if (!repoUrlOk(url)) return this.fail(url, 'address');
    const run = this.o.run ?? runGit;
    const dir = repoDir(this.o.storage(), url);
    const hooks = path.join(this.o.storage(), 'companion', 'no-hooks');
    try {
      fs.mkdirSync(hooks, { recursive: true });
      const pulling = fs.existsSync(path.join(dir, '.git'));
      const cwd = pulling ? dir : path.join(this.o.storage(), 'companion');
      // Your own ssh setup wins: batch mode only when git has no ssh command of yours (exit 1 = none).
      const ssh = await run(this.o.git(), sshCommandArgs(hooks), { cwd, env: gitEnv(process.env, true), timeout: GIT_TIMEOUT_MS }).catch(() => '');
      const options = { cwd, env: gitEnv(process.env, !!(ssh || '').trim()), timeout: GIT_TIMEOUT_MS };
      if (pulling) {
        await run(this.o.git(), pullArgs(hooks), options);
      } else {
        fs.rmSync(dir, { recursive: true, force: true }); // a clone cut off half way
        await run(this.o.git(), cloneArgs(url, dir, hooks), options);
      }
    } catch (err) {
      this.fail(url, failureOf(err), err);
    }
  }

  private fail(url: string, kind: RepoFailure, err?: unknown): void {
    const detail = (err as { stderr?: unknown })?.stderr;
    if (this.reported.has(kind)) return;
    this.reported.add(kind);
    this.o.warn(`Couldn't update your characters from ${url}: ${REASONS[kind]}${typeof detail === 'string' && detail.trim() ? ` (${detail.trim().split('\n').at(-1)})` : ''}`);
  }
}
