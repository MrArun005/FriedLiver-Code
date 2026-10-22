import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inGitFolder, insideRoots, realPath, workspacePath } from '../src/host/paths';

/** Directory links: junctions on Windows, which need no special rights. */
function link(target: string, at: string, kind: 'dir' | 'file'): void {
  fs.symlinkSync(target, at, process.platform === 'win32' ? (kind === 'dir' ? 'junction' : 'file') : undefined);
}

function canSymlink(kind: 'dir' | 'file'): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-canlink-'));
  try {
    const target = path.join(dir, 'target');
    if (kind === 'dir') fs.mkdirSync(target);
    else fs.writeFileSync(target, '');
    link(target, path.join(dir, 'link'), kind);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const DIR_LINKS = canSymlink('dir');
const FILE_LINKS = canSymlink('file');

/** <tmp>/ws (the workspace) and <tmp>/outside, with secret.txt in outside. */
function layout() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fl-paths-')));
  const ws = path.join(base, 'ws');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.writeFileSync(path.join(ws, 'src', 'a.ts'), 'a');
  return { base, ws, outside };
}

describe('workspace containment with real symlinks', () => {
  it('allows ordinary files, new files and new folders inside the workspace', () => {
    const { ws } = layout();
    expect(insideRoots(path.join(ws, 'src', 'a.ts'), [ws])).toBe(path.join(ws, 'src', 'a.ts'));
    expect(insideRoots('src/new.ts', [ws])).toBe(path.join(ws, 'src', 'new.ts'));
    expect(insideRoots(path.join(ws, 'not', 'yet', 'there.txt'), [ws])).toBe(path.join(ws, 'not', 'yet', 'there.txt'));
  });

  it.skipIf(!DIR_LINKS)('a workspace opened through another name (a link; a Windows 8.3 name) holds paths under its real name', () => {
    const { base, ws, outside } = layout();
    const alias = path.join(base, 'alias');
    link(ws, alias, 'dir');
    expect(insideRoots(path.join(ws, 'src', 'a.ts'), [alias])).toBe(path.join(ws, 'src', 'a.ts'));
    expect(insideRoots(path.join(outside, 'secret.txt'), [alias])).toBeNull();
    expect(insideRoots(path.join(ws, '..', 'outside', 'secret.txt'), [alias])).toBeNull();
  });

  it.skipIf(!DIR_LINKS)('refuses a folder link that leads out of the workspace (a repo with keys -> ~/.ssh)', () => {
    const { ws, outside } = layout();
    link(outside, path.join(ws, 'keys'), 'dir');
    expect(insideRoots(path.join(ws, 'keys', 'secret.txt'), [ws])).toBeNull();
    expect(insideRoots('keys/secret.txt', [ws])).toBeNull();
    // New files and folders under the link would be created outside too.
    expect(insideRoots(path.join(ws, 'keys', 'new.txt'), [ws])).toBeNull();
    expect(insideRoots(path.join(ws, 'keys', 'deep', 'er', 'new.txt'), [ws])).toBeNull();
    expect(insideRoots(path.join(ws, 'keys'), [ws])).toBeNull();
  });

  it.skipIf(!FILE_LINKS)('refuses a file link to a file outside', () => {
    const { ws, outside } = layout();
    link(path.join(outside, 'secret.txt'), path.join(ws, 'notes.txt'), 'file');
    expect(insideRoots(path.join(ws, 'notes.txt'), [ws])).toBeNull();
  });

  it.skipIf(!FILE_LINKS)('refuses a dangling link whose target a write would create outside', () => {
    const { ws, outside } = layout();
    link(path.join(outside, 'created-by-write.txt'), path.join(ws, 'dangling'), 'file');
    expect(insideRoots(path.join(ws, 'dangling'), [ws])).toBeNull();
    expect(realPath(path.join(ws, 'dangling'))).toBe(path.join(outside, 'created-by-write.txt'));
  });

  it.skipIf(!DIR_LINKS)('refuses a dangling folder link with missing folders below it', () => {
    const { ws, outside } = layout();
    link(path.join(outside, 'not-yet'), path.join(ws, 'gone'), 'dir');
    expect(insideRoots(path.join(ws, 'gone', 'sub', 'x.txt'), [ws])).toBeNull();
  });

  it.skipIf(!DIR_LINKS)('allows links that stay inside, and a workspace opened through a link', () => {
    const { base, ws } = layout();
    link(path.join(ws, 'src'), path.join(ws, 'src-link'), 'dir');
    expect(insideRoots(path.join(ws, 'src-link', 'a.ts'), [ws])).toBe(path.join(ws, 'src-link', 'a.ts'));
    // Like macOS's /tmp -> /private/tmp: the root itself is reached through a link.
    const viaLink = path.join(base, 'ws-link');
    link(ws, viaLink, 'dir');
    expect(insideRoots(path.join(viaLink, 'src', 'a.ts'), [viaLink])).toBe(path.join(viaLink, 'src', 'a.ts'));
    expect(insideRoots(path.join(viaLink, 'src', 'new.ts'), [viaLink])).toBe(path.join(viaLink, 'src', 'new.ts'));
  });

  it.skipIf(!FILE_LINKS || process.platform === 'win32')('refuses a link loop', () => {
    const { ws } = layout();
    fs.symlinkSync(path.join(ws, 'b'), path.join(ws, 'a'));
    fs.symlinkSync(path.join(ws, 'a'), path.join(ws, 'b'));
    expect(insideRoots(path.join(ws, 'a'), [ws])).toBeNull();
  });

  it.skipIf(!DIR_LINKS)('lets a task worktree outside the folder count as a root of its own', () => {
    const { ws, outside } = layout();
    link(outside, path.join(ws, 'keys'), 'dir');
    expect(insideRoots(path.join(ws, 'keys', 'secret.txt'), [ws, outside])).toBe(path.join(ws, 'keys', 'secret.txt'));
  });
});

describe('.git folders', () => {
  const roots = ['/work/app'];
  it('spots a repository folder or a worktree pointer', () => {
    expect(inGitFolder('/work/app/.git/config', roots, path.posix)).toBe(true);
    expect(inGitFolder('/work/app/.git', roots, path.posix)).toBe(true);
    expect(inGitFolder('/work/app/vendor/lib/.GIT/hooks/pre-commit', roots, path.posix)).toBe(true);
    expect(inGitFolder('C:\\work\\app\\.git\\hooks\\post-checkout', ['C:\\work\\app'], path.win32)).toBe(true);
  });
  it('leaves everything else alone', () => {
    expect(inGitFolder('/work/app/.github/workflows/ci.yml', roots, path.posix)).toBe(false);
    expect(inGitFolder('/work/app/.gitignore', roots, path.posix)).toBe(false);
    expect(inGitFolder('/work/app/src/git.ts', roots, path.posix)).toBe(false);
  });
});

describe('workspacePath: where a request really points, for the countdown', () => {
  it('resolves relative paths against the chat folder, follows links, and fails closed', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fl-ws-')));
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fl-out-')));
    fs.mkdirSync(path.join(root, 'src'));
    fs.symlinkSync(outside, path.join(root, 'escape'));
    expect(workspacePath('src', root, [root])).toBe(path.join(root, 'src'));
    expect(workspacePath(path.join(root, 'src'), undefined, [root])).toBe(path.join(root, 'src'));
    expect(workspacePath('../outside', path.join(root, 'src'), [root])).toBe(path.join(root, 'outside'));
    expect(workspacePath(`../${path.basename(outside)}`, root, [root])).toBeNull();
    expect(workspacePath('../../etc', path.join(root, 'src'), [root])).toBeNull();
    // A relative path with nothing to resolve it against.
    expect(workspacePath('src', undefined, [root])).toBeNull();
    expect(workspacePath('src', 'relative/base', [root])).toBeNull();
    // A link inside the root that leads out of it.
    expect(workspacePath('escape', root, [root])).toBeNull();
    expect(workspacePath(path.join(root, 'escape', 'x'), root, [root])).toBeNull();
    expect(workspacePath(undefined, root, [root])).toBeNull();
  });
});
