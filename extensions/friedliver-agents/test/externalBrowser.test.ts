import { lstat, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVER_NAME, claudeEntry, registerClaude, removeTokenFile, unregisterClaude, writeTokenFile } from '../src/host/externalBrowser';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'flx-'));
const T1 = 'a'.repeat(64);
const T2 = 'b'.repeat(64);
const E1 = claudeEntry('/app/FriedLiver', '/ext/dist/externalStdio.js', '/store/external/browser-token.json');
const E2 = claudeEntry('/app/FriedLiver', '/ext-0.2/dist/externalStdio.js', '/store/external/browser-token.json');

describe('the external token file', () => {
  it('is 0600 in a 0700 dir, a new launch replaces it, and it can be removed', async () => {
    const storage = await tmp();
    const first = await writeTokenFile(storage, 'http://127.0.0.1:1/mcp', T1);
    expect((await stat(first)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(first))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(first, 'utf8'))).toEqual({ url: 'http://127.0.0.1:1/mcp', token: T1, pid: process.pid });
    const second = await writeTokenFile(storage, 'http://127.0.0.1:2/mcp', T2);
    expect(second).toBe(first);
    expect(JSON.parse(await readFile(second, 'utf8')).token).toBe(T2);
    await removeTokenFile(storage);
    expect(await readdir(storage)).toEqual([]);
  });
});

describe("Claude Code's config", () => {
  const fixture = {
    numStartups: 42,
    projects: { '/w': { allowedTools: ['Bash'], mcpServers: { local: { command: 'x' } } } },
    mcpServers: { github: { type: 'http', url: 'https://api.github.com/mcp', headers: { Authorization: 'Bearer gh' } } },
    oauthAccount: { email: 'me@example.com' },
  };

  it('gets a stdio entry with no token or port in it', () => {
    expect(E1).toEqual({ type: 'stdio', command: '/app/FriedLiver', args: ['/ext/dist/externalStdio.js', '/store/external/browser-token.json'], env: { ELECTRON_RUN_AS_NODE: '1' } });
    expect(JSON.stringify(E1)).not.toMatch(/127\.0\.0\.1|Bearer|[0-9a-f]{64}|:\d{2,5}\b/);
  });

  it('gains our entry and keeps everything else; re-registering is idempotent', async () => {
    const file = path.join(await tmp(), '.claude.json');
    await writeFile(file, JSON.stringify(fixture), { mode: 0o600 });
    expect(await registerClaude(file, E1)).toBe('added');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ...fixture, mcpServers: { ...fixture.mcpServers, [SERVER_NAME]: E1 } });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(`${file}.friedliver-backup`, 'utf8'))).toEqual(fixture);
    expect(await registerClaude(file, E1)).toBe('unchanged');
    expect(await registerClaude(file, E2)).toBe('updated');
    expect((await readdir(path.dirname(file))).sort()).toEqual(['.claude.json', '.claude.json.friedliver-backup']);
  });

  it('migrates an older http entry: dropped first, then replaced by the stdio one', async () => {
    const file = path.join(await tmp(), '.claude.json');
    const old = { type: 'http', url: 'http://127.0.0.1:5/mcp', headers: { Authorization: `Bearer ${T1}` } };
    await writeFile(file, JSON.stringify({ ...fixture, mcpServers: { ...fixture.mcpServers, [SERVER_NAME]: old } }));
    expect(await unregisterClaude(file, true)).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(fixture);
    expect(await registerClaude(file, E1)).toBe('added');
    expect(await unregisterClaude(file, true)).toBe(false);
    expect(await readFile(file, 'utf8')).not.toContain(T1);
    expect(await unregisterClaude(file)).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(fixture);
  });

  it('creates the file when there is none, and leaves a file it cannot parse alone', async () => {
    const file = path.join(await tmp(), '.claude.json');
    expect(await registerClaude(file, E1)).toBe('added');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await writeFile(file, '{ broken');
    await expect(registerClaude(file, E1)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('{ broken');
    await writeFile(file, '{"mcpServers": []}');
    await expect(registerClaude(file, E1)).rejects.toThrow(/not an object/);
  });

  it('writes through a symlinked config instead of replacing the link', async () => {
    const dir = await tmp();
    const real = path.join(dir, 'dotfiles.json');
    const link = path.join(dir, '.claude.json');
    await writeFile(real, JSON.stringify(fixture));
    await symlink(real, link);
    await registerClaude(link, E1);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, 'utf8')).mcpServers[SERVER_NAME]).toEqual(E1);
  });
});
