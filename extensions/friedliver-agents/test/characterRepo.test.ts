// Characters from your own git repository: which addresses are used, how git is run (no hooks, no
// prompts, no local transports), the order of sources, and that a failure never holds up an ask.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CharacterRepo, cloneArgs, failureOf, gitEnv, pullArgs, repoDir, repoUrlOk, sshCommandArgs, type RunGit } from '../src/host/characterRepo';
import { characterFor } from '../src/host/companion';

const svg = (s: string) => `data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}`;

describe('repository addresses', () => {
  it('takes https://, ssh:// and git@ only, never a token in the address', () => {
    for (const ok of ['https://github.com/MrArun005/friedliver-characters', 'https://github.com/a/b.git', 'ssh://git@github.com/a/b.git', 'git@github.com:MrArun005/friedliver-characters.git']) expect(repoUrlOk(ok), ok).toBe(true);
    for (const bad of [
      'http://github.com/a/b',
      'file:///etc',
      '/Users/me/repo',
      'ext::sh -c touch% /tmp/pwned',
      'https://user:ghp_token@github.com/a/b',
      'https://ghp_token@github.com/a/b',
      '--upload-pack=touch /tmp/x',
      'https://github.com/',
      'git@github.com:a/b; rm -rf ~',
      '',
    ])
      expect(repoUrlOk(bad), bad).toBe(false);
  });

  it('clones into the extension storage under a hash of the address', () => {
    expect(repoDir('/s', 'https://github.com/a/b')).toMatch(/^\/s\/companion\/[0-9a-f]{16}$/);
    expect(repoDir('/s', 'https://github.com/a/b')).not.toBe(repoDir('/s', 'https://github.com/a/c'));
  });
});

describe('how git runs', () => {
  it('no hooks, no file: or ext:: transports, shallow, and the address after --', () => {
    const clone = cloneArgs('https://github.com/a/b', '/s/companion/x', '/s/companion/no-hooks');
    expect(clone).toEqual(expect.arrayContaining(['core.hooksPath=/s/companion/no-hooks', 'protocol.file.allow=never', 'protocol.ext.allow=never']));
    expect(clone.slice(clone.indexOf('clone'))).toEqual(['clone', '--depth', '1', '--no-tags', '--single-branch', '--', 'https://github.com/a/b', '/s/companion/x']);
    expect(pullArgs('/h')).toEqual(expect.arrayContaining(['core.hooksPath=/h', 'pull', '--ff-only']));
  });

  it('never prompts: no terminal prompt, no credential manager window, ssh in batch mode', () => {
    const env = gitEnv({ PATH: '/bin' });
    expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', PATH: '/bin' });
  });

  it("leaves your own ssh setup alone: GIT_SSH_COMMAND, GIT_SSH or core.sshCommand", () => {
    expect(gitEnv({ GIT_SSH_COMMAND: 'ssh -i k' }).GIT_SSH_COMMAND).toBe('ssh -i k');
    expect(gitEnv({ GIT_SSH: '/usr/bin/plink' })).not.toHaveProperty('GIT_SSH_COMMAND');
    expect(gitEnv({}, true)).not.toHaveProperty('GIT_SSH_COMMAND');
    expect(gitEnv({}, true).GIT_TERMINAL_PROMPT).toBe('0');
    expect(sshCommandArgs('/h')).toEqual(expect.arrayContaining(['core.hooksPath=/h', 'config', '--get', 'core.sshCommand']));
  });

  it('names what went wrong', () => {
    expect(failureOf({ code: 'ENOENT' })).toBe('git');
    expect(failureOf({ stderr: 'fatal: could not read Username for https://github.com: terminal prompts disabled' })).toBe('sign-in');
    expect(failureOf({ stderr: "fatal: unable to access: Could not resolve host: github.com" })).toBe('offline');
    expect(failureOf({ stderr: 'fatal: something else' })).toBe('git');
  });
});

describe('the clone', () => {
  const setup = (run: RunGit) => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-repo-'));
    const warnings: string[] = [];
    const calls: { args: string[]; cwd?: string; env: NodeJS.ProcessEnv; timeout: number }[] = [];
    const repo = new CharacterRepo({ storage: () => storage, git: () => '/usr/bin/git', warn: (m) => warnings.push(m), run: async (file, args, options) => { calls.push({ args, ...options }); return run(file, args, options); } });
    return { storage, warnings, calls, repo };
  };

  it('clones the first time, pulls after, git by absolute path with a 60 s limit', async () => {
    const t = setup(async (_file, args) => {
      if (args.includes('clone')) fs.mkdirSync(path.join(args.at(-1)!, '.git'), { recursive: true });
    });
    const url = 'https://github.com/MrArun005/friedliver-characters';
    expect(t.repo.dir(url)).toBeUndefined();
    await t.repo.sync(url);
    expect(t.repo.dir(url)).toBe(repoDir(t.storage, url));
    await t.repo.sync(url);
    expect(t.calls.map((c) => c.args.find((a) => a === 'clone' || a === 'pull' || a === 'config'))).toEqual(['config', 'clone', 'config', 'pull']);
    expect(t.calls[3].cwd).toBe(repoDir(t.storage, url));
    expect(t.calls[1].env.GIT_SSH_COMMAND).toBe(process.env.GIT_SSH_COMMAND || process.env.GIT_SSH ? process.env.GIT_SSH_COMMAND : 'ssh -o BatchMode=yes');
    expect(t.calls.every((c) => c.timeout === 60_000 && c.env.GIT_TERMINAL_PROMPT === '0')).toBe(true);
    expect(t.warnings).toEqual([]);
  });

  it('a core.sshCommand of yours keeps ssh as you set it up', async () => {
    const t = setup(async (_file, args) => (args.includes('config') ? 'ssh -i ~/.ssh/work\n' : undefined));
    await t.repo.sync('git@github.com:a/b.git');
    const clone = t.calls.find((c) => c.args.includes('clone'))!;
    expect(clone.env.GIT_SSH_COMMAND).toBe(process.env.GIT_SSH_COMMAND);
    expect(clone.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('a failure is said once per kind per session and never throws; a bad address never runs git', async () => {
    const t = setup(async (_file, args) => {
      if (args.includes('config')) throw Object.assign(new Error('exit 1'), { stderr: '' });
      throw Object.assign(new Error('Command failed'), { stderr: 'fatal: Authentication failed for https://github.com/a/b' });
    });
    await t.repo.sync('https://github.com/a/b');
    await t.repo.sync('https://github.com/a/b');
    await t.repo.sync('file:///etc');
    expect(t.calls.filter((c) => c.args.includes('clone'))).toHaveLength(2);
    expect(t.calls.some((c) => c.args.includes('file:///etc'))).toBe(false);
    expect(t.warnings).toHaveLength(2);
    expect(t.warnings[0]).toMatch(/^Couldn't update your characters from https:\/\/github.com\/a\/b: git couldn't sign in/);
    expect(t.warnings[1]).toMatch(/^Couldn't update your characters from file:\/\/\/etc: only https:\/\//);
    expect(t.repo.dir('https://github.com/a/b')).toBeUndefined();
  });
});

describe('the order of sources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-order-'));
  const dir = (name: string, files: Record<string, string>) => {
    const d = path.join(root, name);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(d, f), text);
    return d;
  };
  const builtinDir = dir('builtin', { 'jas.svg': '<svg>jas</svg>' });
  const folder = dir('folder', { 'claude.svg': '<svg>folder</svg>' });
  const repo = dir('repo', { 'claude.svg': '<svg>repo</svg>', 'claude-run.svg': '<svg>repo run</svg>', 'codex.svg': '<svg>repo codex</svg>' });
  const own = dir('own', { 'cat.svg': '<svg>own</svg>' });

  it('your characters entry, then the folder, then the repository, then the built-in', () => {
    const o = { builtinDir, folder, repoDir: repo, characters: { claude: path.join(own, 'cat.svg') } };
    expect(characterFor('claude', o)?.character).toBe(svg('<svg>own</svg>'));
    expect(characterFor('claude', { ...o, characters: undefined })?.character).toBe(svg('<svg>folder</svg>'));
    expect(characterFor('claude', { ...o, characters: undefined, folder: undefined })).toEqual({ character: svg('<svg>repo</svg>'), characterRun: svg('<svg>repo run</svg>') });
    expect(characterFor('claude', { builtinDir, folder: undefined, characters: undefined })?.character).toBe(svg('<svg>jas</svg>'));
  });

  it('a source that has nothing (or fails) passes to the next', () => {
    expect(characterFor('codex', { builtinDir, folder, repoDir: repo, characters: { codex: path.join(own, 'missing.png') } })?.character).toBe(svg('<svg>repo codex</svg>'));
    expect(characterFor('claude', { builtinDir, folder: undefined, repoDir: undefined, characters: undefined })?.character).toBe(svg('<svg>jas</svg>'));
  });
});
