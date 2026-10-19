import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_DIFF_CHARS, collectChanges, excludedFromDiff, reviewMessage, reviewPrompt } from '../src/host/gitChanges';
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

  it('over the cap, sends the --stat and each file\'s diff cut short at a line break, and says so', async () => {
    const dir = await gitRepo();
    await writeFile(path.join(dir, 'big.txt'), Array.from({ length: 2000 }, (_, n) => `line ${n}`).join('\n'));
    await writeFile(path.join(dir, 'other.txt'), Array.from({ length: 500 }, (_, n) => `other ${n}`).join('\n'));
    await writeFile(path.join(dir, 'small.txt'), 'tiny\n');
    git(dir, 'add', '.');
    const changes = (await collectChanges(dir, 3000))!;
    expect(changes.truncated).toBe(true);
    expect(changes.stat).toMatch(/big\.txt[\s\S]*other\.txt[\s\S]*small\.txt[\s\S]*3 files changed/);
    expect(changes.diff.length + changes.stat!.length).toBeLessThanOrEqual(3000);
    // Every file gets its start: the small one whole, the big ones cut with a count of what is left out.
    expect(changes.diff).toContain('+tiny');
    expect(changes.diff).toMatch(/\+line 0\n[\s\S]*… \d+ more lines of this file's diff left out/);
    expect(changes.diff).toMatch(/\+other 0\n[\s\S]*… \d+ more lines of this file's diff left out/);
    const prompt = reviewPrompt(changes, dir);
    expect(prompt).toContain('Summary (git diff --stat):');
    expect(prompt).toContain("each file's cut short");
    expect(prompt).toContain('Read the files in the summary for the rest.]');
    expect(MAX_DIFF_CHARS).toBe(40_000);
  });

  it('leaves lockfiles, minified and built files out of the diff, naming them', async () => {
    const dir = await gitRepo();
    await writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion": 3}\n');
    await mkdir(path.join(dir, 'dist'));
    await writeFile(path.join(dir, 'dist', 'app.js'), 'built();\n');
    await writeFile(path.join(dir, 'vendor.min.js'), 'min();\n');
    await writeFile(path.join(dir, 'src.ts'), 'export const real = 1;\n');
    git(dir, 'add', '.');
    const changes = (await collectChanges(dir))!;
    expect(changes.diff).toContain('+export const real = 1;');
    expect(changes.diff).not.toMatch(/lockfileVersion|built\(\)|min\(\)/);
    expect(changes.skipped?.sort()).toEqual(['dist/app.js', 'package-lock.json', 'vendor.min.js']);
    expect(reviewPrompt(changes, dir)).toContain('[Not in the diff: 3 lockfiles, minified or built files (');
    expect(excludedFromDiff('web/yarn.lock')).toBe(true);
    expect(excludedFromDiff('src/distance.ts')).toBe(false);
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
