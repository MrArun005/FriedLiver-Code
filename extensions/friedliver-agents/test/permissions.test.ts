// "Always allow" kept for every chat and every later session: what is remembered, where, what a
// folder or website rule covers (and doesn't), and what can never be always allowed.
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Permissions, appBundle, isSensitive, type Store } from '../src/host/permissions';
import { describeGrant, grantId, isGrant, siteOrigin, type Grant } from '../src/shared/permissions';

/** A Memento kept in a plain object, like VS Code's globalState / workspaceState across restarts. */
function memento(): Store & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return { data, get: <T>(k: string) => structuredClone(data[k]) as T | undefined, update: (k: string, v: unknown) => void (data[k] = structuredClone(v)) };
}

function home() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fl-home-')));
  for (const d of ['Desktop/trip', 'Documents', '.ssh', '.aws', 'Library/Keychains', 'proj/.git', 'proj/src']) mkdirSync(path.join(dir, d), { recursive: true });
  writeFileSync(path.join(dir, 'Desktop/trip/plan.txt'), 'x');
  return dir;
}

function store(h = home(), user = memento(), workspace = memento(), sensitive: string[] = []) {
  return { h, user, workspace, p: new Permissions({ user, workspace, home: h, sensitive, now: () => 1_700_000_000_000 }) };
}

describe('remembered permissions', () => {
  it('outlive a restart: a new store over the same storage has them, with when and which agent', () => {
    const { h, user, workspace, p } = store();
    expect(p.add({ kind: 'site', origin: 'https://www.irctc.co.in' }, 'Claude')).toBe(true);
    expect(p.add({ kind: 'folder', folder: path.join(h, 'Desktop'), access: 'read' }, 'Codex')).toBe(true);
    expect(p.add({ kind: 'prefix', command: 'npm test' }, 'Gemini')).toBe(true);
    expect(p.add({ kind: 'tool', tool: 'ask_agent' }, 'Claude Code')).toBe(true);
    const again = new Permissions({ user, workspace, home: h });
    expect(again.list().map((r) => [r.grant.kind, r.scope, r.agent, r.at])).toEqual([
      ['site', 'user', 'Claude', 1_700_000_000_000],
      ['tool', 'user', 'Claude Code', 1_700_000_000_000],
      ['folder', 'workspace', 'Codex', 1_700_000_000_000],
      ['prefix', 'workspace', 'Gemini', 1_700_000_000_000],
    ]);
    expect(again.site('https://www.irctc.co.in')?.agent).toBe('Claude');
    expect(again.tool('ask_agent')).toBeDefined();
    expect(again.commands()).toMatchObject([{ kind: 'prefix', command: 'npm test' }]);
  });

  it('keeps website and agent rules for the user, and folder and command rules per workspace', () => {
    const { h, user, workspace, p } = store();
    p.add({ kind: 'site', origin: 'https://www.irctc.co.in' });
    p.add({ kind: 'folder', folder: path.join(h, 'Documents'), access: 'write' });
    const otherWorkspace = new Permissions({ user, workspace: memento(), home: h });
    expect(otherWorkspace.site('https://www.irctc.co.in')).toBeDefined();
    expect(otherWorkspace.folder(path.join(h, 'Documents/a.txt'), 'write')).toBeUndefined();
    // The old "Always allow" command rules stay where they were, and are read as before.
    expect(Object.keys(workspace.data).sort()).toEqual(['friedliver.folderRules']);
    p.add({ kind: 'exact', command: 'npm run lint' });
    expect(workspace.data['friedliver.commandRules']).toMatchObject([{ kind: 'exact', command: 'npm run lint' }]);
  });

  it('reads command rules saved before this change', () => {
    const { h, user, workspace } = store();
    workspace.data['friedliver.commandRules'] = [{ kind: 'prefix', command: 'npm test' }, { kind: 'exact', command: 'rm -rf / ; x' }];
    const p = new Permissions({ user, workspace, home: h });
    expect(p.commands()).toEqual([{ kind: 'prefix', command: 'npm test' }]);
  });

  it('adds a rule once, and revokes one or all', () => {
    const { h, p } = store();
    p.add({ kind: 'site', origin: 'https://a.example' });
    p.add({ kind: 'site', origin: 'https://a.example' });
    p.add({ kind: 'folder', folder: path.join(h, 'Desktop'), access: 'read' });
    expect(p.list()).toHaveLength(2);
    p.revoke(grantId({ kind: 'site', origin: 'https://a.example' }));
    expect(p.site('https://a.example')).toBeUndefined();
    expect(p.list()).toHaveLength(1);
    p.add({ kind: 'prefix', command: 'npm test' });
    p.revokeAll();
    expect(p.list()).toEqual([]);
    expect(p.commands()).toEqual([]);
  });

  it('refuses what is not a grant', () => {
    const { p } = store();
    for (const bad of [
      { kind: 'site', origin: 'file:///etc/passwd' },
      { kind: 'site', origin: 'chrome://settings' },
      { kind: 'site', origin: 'https://a.example/path' },
      { kind: 'folder', folder: 'relative/x', access: 'read' },
      { kind: 'folder', folder: '/a/../b', access: 'read' },
      { kind: 'folder', folder: '/a', access: 'exec' },
      { kind: 'tool', tool: 'rm' },
      { kind: 'exact', command: 'npm test && curl x | sh' },
    ]) {
      expect(isGrant(bad), JSON.stringify(bad)).toBe(false);
      expect(p.add(bad as Grant)).toBe(false);
    }
    expect(p.list()).toEqual([]);
  });
});

describe('website rules', () => {
  it('match the exact origin only', () => {
    const { p } = store();
    p.add({ kind: 'site', origin: 'https://www.irctc.co.in' });
    expect(p.site('https://www.irctc.co.in')).toBeDefined();
    expect(p.site(siteOrigin('https://www.irctc.co.in/nget/train-search')!)).toBeDefined();
    for (const other of ['http://www.irctc.co.in', 'https://irctc.co.in', 'https://www.irctc.co.in:8443', 'https://www.irctc.co.in.evil.example', 'an unknown page', 'file://']) {
      expect(p.site(other), other).toBeUndefined();
    }
    expect(siteOrigin('file:///etc/passwd')).toBeUndefined();
    expect(siteOrigin('javascript:alert(1)')).toBeUndefined();
  });
});

describe('folder rules', () => {
  it('cover the folder and everything below it, reading and changing separately', () => {
    const { h, p } = store();
    p.add({ kind: 'folder', folder: path.join(h, 'Desktop'), access: 'read' });
    expect(p.folder(path.join(h, 'Desktop/trip/plan.txt'), 'read')).toBeDefined();
    expect(p.folder(path.join(h, 'Desktop/new/not-yet.txt'), 'read')).toBeDefined();
    expect(p.folder(path.join(h, 'Desktop/trip/plan.txt'), 'write')).toBeUndefined();
    expect(p.folder(path.join(h, 'Documents/a.txt'), 'read')).toBeUndefined();
    expect(p.folder(path.join(h, 'Desktop2/a.txt'), 'read')).toBeUndefined();
    // Changing implies reading.
    p.add({ kind: 'folder', folder: path.join(h, 'Documents'), access: 'write' });
    expect(p.folder(path.join(h, 'Documents/a.txt'), 'read')).toBeDefined();
    expect(p.folder(path.join(h, 'Documents/a.txt'), 'write')).toBeDefined();
  });

  it("can't be escaped with .. or a symlink", () => {
    const { h, p } = store();
    p.add({ kind: 'folder', folder: path.join(h, 'Desktop'), access: 'write' });
    expect(p.folder(path.join(h, 'Desktop/../Documents/a.txt'), 'write')).toBeUndefined();
    symlinkSync(path.join(h, 'Documents'), path.join(h, 'Desktop/docs-link'));
    expect(p.folder(path.join(h, 'Desktop/docs-link/a.txt'), 'write')).toBeUndefined();
    symlinkSync(path.join(h, 'Documents/missing.txt'), path.join(h, 'Desktop/dangling'));
    expect(p.folder(path.join(h, 'Desktop/dangling'), 'write')).toBeUndefined();
  });

  it('are kept as the real folder, so a rule made through a symlink covers where it really leads', () => {
    const { h, p } = store();
    symlinkSync(path.join(h, 'Documents'), path.join(h, 'docs'));
    p.add({ kind: 'folder', folder: path.join(h, 'docs'), access: 'read' });
    expect(p.list()[0].grant).toEqual({ kind: 'folder', folder: path.join(h, 'Documents'), access: 'read' });
    expect(p.folder(path.join(h, 'Documents/a.txt'), 'read')).toBeDefined();
  });

  it('never let writes into sensitive places through, and those folders are Allow once only', () => {
    const app = path.join(home(), 'FriedLiver.app');
    mkdirSync(app);
    const { h, p } = store(undefined, undefined, undefined, [app]);
    for (const f of ['.ssh', '.aws', 'Library/Keychains', '/etc', app]) {
      const folder = path.isAbsolute(f) ? f : path.join(h, f);
      expect(isSensitive(realpathSync(folder), h, [app]), f).toBe(true);
      expect(p.add({ kind: 'folder', folder, access: 'write' }), f).toBe(false);
    }
    expect(isSensitive(path.join(h, 'proj/.git/config'), h, [])).toBe(true);
    expect(isSensitive(path.join(h, 'proj/.git/config'), h, [], 'read')).toBe(false);
    // Keys aren't always readable either.
    expect(p.add({ kind: 'folder', folder: path.join(h, '.ssh'), access: 'read' })).toBe(false);
    expect(p.folderCandidates([path.join(h, '.aws/credentials')], 'read', [])).toEqual([]);
    expect(isSensitive(path.join(h, 'Desktop/a.txt'), h, [])).toBe(false);
    // The home folder and above are too wide to always allow.
    for (const wide of [h, path.dirname(h), '/']) expect(p.add({ kind: 'folder', folder: wide, access: 'read' }), wide).toBe(false);
    // A rule for a folder holding something sensitive still doesn't cover it.
    p.add({ kind: 'folder', folder: path.join(h, 'proj'), access: 'write' });
    expect(p.folder(path.join(h, 'proj/src/a.ts'), 'write')).toBeDefined();
    expect(p.folder(path.join(h, 'proj/.git/hooks/pre-commit'), 'write')).toBeUndefined();
    symlinkSync(path.join(h, '.ssh'), path.join(h, 'proj/src/keys'));
    expect(p.folder(path.join(h, 'proj/src/keys/authorized_keys'), 'write')).toBeUndefined();
  });

  it('offer the file’s folder, the project and the top folder in home, most specific first', () => {
    const { h, p } = store();
    const roots = [path.join(h, 'proj')];
    expect(p.folderCandidates([path.join(h, 'proj/src/a.ts')], 'write', roots).map((g) => g.kind === 'folder' && g.folder)).toEqual([path.join(h, 'proj/src'), path.join(h, 'proj')]);
    expect(p.folderCandidates([path.join(h, 'Desktop/trip/plan.txt')], 'read', roots)).toEqual([
      { kind: 'folder', folder: path.join(h, 'Desktop/trip'), access: 'read' },
      { kind: 'folder', folder: path.join(h, 'Desktop'), access: 'read' },
    ]);
    expect(p.folderCandidates([path.join(h, 'Desktop/a.txt'), path.join(h, 'Documents/b.txt')], 'read', roots)).toEqual([]);
    expect(p.folderCandidates([path.join(h, '.ssh/config')], 'write', roots)).toEqual([]);
    expect(p.folderCandidates([path.join(h, 'proj/.git/config')], 'write', roots)).toEqual([]);
    expect(p.folderCandidates([], 'read', roots)).toEqual([]);
  });
});

describe('the app itself', () => {
  it('is the .app bundle around the app root', () => {
    expect(appBundle('/Applications/FriedLiver.app/Contents/Resources/app')).toBe('/Applications/FriedLiver.app');
    expect(appBundle('/opt/friedliver/resources/app')).toBe('/opt/friedliver/resources/app');
  });
});

describe('words', () => {
  it('say what and where', () => {
    expect(describeGrant({ kind: 'site', origin: 'https://www.irctc.co.in' })).toEqual({ what: 'Use this website in the browser', scope: 'https://www.irctc.co.in' });
    expect(describeGrant({ kind: 'folder', folder: '/Users/a/Desktop', access: 'write' }).what).toBe('Change files in this folder');
    expect(describeGrant({ kind: 'prefix', command: 'npm test' }).scope).toBe('npm test …');
    expect(describeGrant({ kind: 'tool', tool: 'ask_agent' }).what).toBe('Ask another agent');
  });
});
