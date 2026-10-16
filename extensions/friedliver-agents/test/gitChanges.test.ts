import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectChanges, reviewMessage, reviewPrompt } from '../src/host/gitChanges';
import { gitRepo } from './helpers';

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

describe('Review My Changes: collecting the changes', () => {
  it('says when the folder is not a git repository', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fl-nogit-'));
    expect(await collectChanges(dir)).toBeNull();
  });

  it('finds nothing in a clean checkout', async () => {
    const dir = await gitRepo();
    expect(await collectChanges(dir)).toMatchObject({ branch: 'main', files: [], diff: '', truncated: false });
  });

  it('takes staged and unstaged changes, and lists untracked files', async () => {
    const dir = await gitRepo();
    await writeFile(path.join(dir, 'staged.ts'), 'export const staged = 1;\n');
    git(dir, 'add', 'staged.ts');
    await writeFile(path.join(dir, 'README.md'), '# test\n\nUnstaged line.\n');
    await writeFile(path.join(dir, 'notes.txt'), 'not added\n');

    const changes = (await collectChanges(path.join(dir)))!;
    expect(changes.root).toBe(path.resolve(dir));
    expect(changes.files.map((f) => [f.path, f.status, f.staged]).sort()).toEqual([
      ['README.md', 'M', false],
      ['notes.txt', 'U', false],
      ['staged.ts', 'A', true],
    ]);
    expect(changes.diff).toContain('+export const staged = 1;');
    expect(changes.diff).toContain('+Unstaged line.');
    expect(changes.diff).not.toContain('not added');
    expect(changes.truncated).toBe(false);

    const prompt = reviewPrompt(changes, dir);
    expect(prompt.startsWith('[FriedLiver] Review request\n')).toBe(true);
    expect(prompt).toContain('in this repository, on branch main');
    expect(prompt).toContain('- staged.ts (added, staged)');
    expect(prompt).toContain('- notes.txt (new, untracked: not in the diff, read it if it matters)');
    expect(prompt).toContain("Don't change any files now");
    expect(prompt).toMatch(/```diff\n[\s\S]*\+Unstaged line\.[\s\S]*\n```/);
    expect(reviewMessage(changes)).toBe('Review my changes on main (3 files)');
  });

  it('works before the first commit', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fl-unborn-'));
    git(dir, 'init', '-q', '-b', 'trunk');
    await writeFile(path.join(dir, 'a.txt'), 'first\n');
    git(dir, 'add', 'a.txt');
    await writeFile(path.join(dir, 'a.txt'), 'first\nsecond\n');
    const changes = (await collectChanges(dir))!;
    expect(changes.branch).toBe('trunk');
    expect(changes.diff).toContain('+first');
    expect(changes.diff).toContain('+second');
  });

  it('cuts a big diff at a line break and says so', async () => {
    const dir = await gitRepo();
    await writeFile(path.join(dir, 'big.txt'), Array.from({ length: 2000 }, (_, n) => `line ${n}`).join('\n'));
    git(dir, 'add', 'big.txt');
    const changes = (await collectChanges(dir, 1000))!;
    expect(changes.truncated).toBe(true);
    expect(changes.diff.length).toBeLessThanOrEqual(1000);
    expect(changes.diff.endsWith('\n')).toBe(false);
    expect(changes.diff.split('\n').at(-1)).toMatch(/^\+line \d+$/);
    expect(reviewPrompt(changes, dir)).toContain('[The diff is cut off after 1 KB. Read the remaining files yourself.]');
  });

  it('runs no external diff or textconv program a repository configures', async (ctx) => {
    if (process.platform === 'win32') return ctx.skip();
    const dir = await gitRepo();
    const marker = path.join(dir, 'ran');
    const script = path.join(dir, 'evil.sh');
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\ncat "$1" 2>/dev/null\n`);
    chmodSync(script, 0o755);
    git(dir, 'config', 'diff.external', script);
    git(dir, 'config', 'diff.evil.textconv', script);
    await writeFile(path.join(dir, '.gitattributes'), '*.md diff=evil\n');
    git(dir, 'add', '.gitattributes');
    git(dir, 'commit', '-q', '-m', 'attributes');
    await writeFile(path.join(dir, 'README.md'), '# changed\n');
    const changes = (await collectChanges(dir))!;
    expect(changes.diff).toContain('+# changed');
    expect(existsSync(marker)).toBe(false);
  });
});
