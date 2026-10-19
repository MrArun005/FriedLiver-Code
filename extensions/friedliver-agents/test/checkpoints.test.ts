// Checkpoints and rewind, against real git repositories and plain folders.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Checkpoints, safeTarget, type UndoFiles } from '../src/host/checkpoints';
import { gitRepo } from './helpers';

const io: UndoFiles = {
  write: async (f, c) => {
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, c);
  },
  remove: (f) => rm(f, { force: true }),
};

const tmp = (p: string) => mkdtemp(path.join(os.tmpdir(), p));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** One agent turn: `edit` runs between the snapshots. */
async function turn(cp: Checkpoints, chat: string, cwd: string, id: string, edit: () => Promise<void>): Promise<string[]> {
  await cp.begin(chat, cwd, id);
  await edit();
  return cp.end(chat, id, new Set());
}

describe('Checkpoints', () => {
  it('rewinds several turns in git and keeps HEAD, index, stash and branches as they were', async () => {
    const repo = await gitRepo();
    const a = path.join(repo, 'a.txt');
    await writeFile(a, 'one\n');
    git(repo, 'add', 'a.txt');
    const head = git(repo, 'rev-parse', 'HEAD');
    const index = git(repo, 'ls-files', '-s');
    const branches = git(repo, 'branch', '-a');
    const cp = new Checkpoints({ dir: await tmp('fl-cp-') });

    expect(await turn(cp, 'chat-1', repo, 't1', () => writeFile(a, 'two\n'))).toEqual([a]);
    await turn(cp, 'chat-1', repo, 't2', async () => {
      await writeFile(a, 'three\n');
      await writeFile(path.join(repo, 'new.txt'), 'new\n');
    });

    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/friedliver/')).toBe('refs/friedliver/checkpoints/chat-1/1\nrefs/friedliver/checkpoints/chat-1/2');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'ls-files', '-s')).toBe(index);
    expect(git(repo, 'stash', 'list')).toBe('');
    expect(git(repo, 'branch', '-a')).toBe(branches);

    const plan = await cp.plan('chat-1', 't1');
    expect(plan.files.map((f) => path.basename(f.file))).toEqual(['a.txt', 'new.txt']);
    expect(plan.files.every((f) => !f.conflict)).toBe(true);
    expect(plan.added).toBe(1);
    expect(plan.removed).toBe(2);

    const done = await cp.rewind('chat-1', 't1', io);
    expect(done.kept).toEqual([]);
    expect(await readFile(a, 'utf8')).toBe('one\n');
    expect(existsSync(path.join(repo, 'new.txt'))).toBe(false);
    expect(cp.list('chat-1')).toEqual([]);
    expect(git(repo, 'for-each-ref', 'refs/friedliver/')).toBe('');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'ls-files', '-s')).toBe(index);
  });

  it('rewinds a folder outside git from its file snapshots', async () => {
    const dir = await tmp('fl-plain-');
    const store = await tmp('fl-cp-');
    const f = path.join(dir, 'sub', 'notes.md');
    await mkdir(path.dirname(f));
    await writeFile(f, 'before\n');
    const cp = new Checkpoints({ dir: store });
    expect(await turn(cp, 'c', dir, 't1', () => writeFile(f, 'after\n'))).toEqual([f]);
    await turn(cp, 'c', dir, 't2', () => writeFile(path.join(dir, 'made.txt'), 'x'));

    // A later window finds them.
    const again = new Checkpoints({ dir: store });
    await again.load();
    expect(again.list('c').map((c) => c.turnId)).toEqual(['t1', 't2']);
    const done = await again.rewind('c', 't1', io);
    expect(done.restored.sort()).toEqual([path.join(dir, 'made.txt'), f].sort());
    expect(await readFile(f, 'utf8')).toBe('before\n');
    expect(existsSync(path.join(dir, 'made.txt'))).toBe(false);
  });

  it("asks before overwriting a file you changed after the agent's turn", async () => {
    const repo = await gitRepo();
    const mine = path.join(repo, 'mine.txt');
    const theirs = path.join(repo, 'theirs.txt');
    const cp = new Checkpoints();
    await turn(cp, 'c', repo, 't1', async () => {
      await writeFile(mine, 'agent\n');
      await writeFile(theirs, 'agent\n');
    });
    await writeFile(mine, 'user edit\n');

    const plan = await cp.plan('c', 't1');
    expect(plan.files.map((f) => [path.basename(f.file), f.conflict])).toEqual([
      ['mine.txt', true],
      ['theirs.txt', false],
    ]);
    // Keep mine: the user's edit stays, the agent's other file goes.
    const kept = await cp.rewind('c', 't1', io, () => false);
    expect(kept.kept).toEqual([mine]);
    expect(await readFile(mine, 'utf8')).toBe('user edit\n');
    expect(existsSync(theirs)).toBe(false);
  });

  it('uses the checkpoint for a changed file when told to', async () => {
    const repo = await gitRepo();
    const f = path.join(repo, 'README.md');
    const cp = new Checkpoints();
    await turn(cp, 'c', repo, 't1', () => writeFile(f, 'agent\n'));
    await writeFile(f, 'user\n');
    const done = await cp.rewind('c', 't1', io, (file) => file === f);
    expect(done.restored).toEqual([f]);
    expect(await readFile(f, 'utf8')).toBe('# test\n');
  });

  it('refuses paths outside the folder and through symlinks', async () => {
    const dir = await tmp('fl-esc-');
    const outside = await tmp('fl-out-');
    await expect(safeTarget(dir, '../x')).rejects.toThrow(/outside/);
    await expect(safeTarget(dir, '/etc/passwd')).rejects.toThrow(/outside/);
    await symlink(outside, path.join(dir, 'link'));
    await expect(safeTarget(dir, 'link/x.txt')).rejects.toThrow(/symlink/);
    await expect(safeTarget(dir, 'ok/x.txt')).resolves.toBe(path.join(dir, 'ok', 'x.txt'));
  });

  it('never writes through a symlink that replaced a folder after the turn', async () => {
    const repo = await gitRepo();
    const outside = await tmp('fl-out-');
    await mkdir(path.join(repo, 'd'));
    await writeFile(path.join(repo, 'd', 'f.txt'), 'v1\n');
    const cp = new Checkpoints();
    await turn(cp, 'c', repo, 't1', () => writeFile(path.join(repo, 'd', 'f.txt'), 'v2\n'));
    await rm(path.join(repo, 'd'), { recursive: true });
    await symlink(outside, path.join(repo, 'd'));
    await expect(cp.rewind('c', 't1', io, () => true)).rejects.toThrow(/symlink/);
    expect(existsSync(path.join(outside, 'f.txt'))).toBe(false);
  });

  it('prunes old checkpoints, and a forgotten chat loses its refs and files', async () => {
    const repo = await gitRepo();
    const plain = await tmp('fl-plain-');
    const store = await tmp('fl-cp-');
    let now = 1_000_000;
    const cp = new Checkpoints({ dir: store, now: () => now, maxAgeMs: 1000 });
    await turn(cp, 'g', repo, 't1', () => writeFile(path.join(repo, 'x'), '1'));
    await turn(cp, 'p', plain, 't2', () => writeFile(path.join(plain, 'y'), 'some bytes'));
    now += 2000;
    await turn(cp, 'g', repo, 't3', () => writeFile(path.join(repo, 'x'), '2'));
    await cp.prune();
    expect(cp.list('g').map((c) => c.turnId)).toEqual(['t3']);
    expect(cp.list('p')).toEqual([]);
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/friedliver/')).toBe('refs/friedliver/checkpoints/g/2');
    await cp.forget('g');
    expect(git(repo, 'for-each-ref', 'refs/friedliver/')).toBe('');
  });

  it('drops the oldest folder snapshots past the size cap', async () => {
    const plain = await tmp('fl-plain-');
    let now = 1;
    const cp = new Checkpoints({ dir: await tmp('fl-cp-'), now: () => now++, maxBytes: 2500 });
    await turn(cp, 'p', plain, 't1', () => writeFile(path.join(plain, 'a'), 'a'.repeat(1000)));
    await turn(cp, 'p', plain, 't2', () => writeFile(path.join(plain, 'a'), 'b'.repeat(1000)));
    await turn(cp, 'p', plain, 't3', () => writeFile(path.join(plain, 'a'), 'c'.repeat(1000)));
    expect(cp.list('p').map((c) => c.turnId)).toEqual(['t3']);
  });
});
