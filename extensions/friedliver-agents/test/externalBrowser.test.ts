import { lstat, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVER_NAME, registerClaude, unregisterClaude, writeTokenFile } from '../src/host/externalBrowser';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'flx-'));
const T1 = 'a'.repeat(64);
const T2 = 'b'.repeat(64);

describe('the external token file', () => {
  it('is 0600 in a 0700 dir, and a new launch replaces the old one', async () => {
    const storage = await tmp();
    const first = await writeTokenFile(storage, 'http://127.0.0.1:1/mcp', T1);
    expect((await stat(first)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(first))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(first, 'utf8'))).toEqual({ url: 'http://127.0.0.1:1/mcp', token: T1 });
    const second = await writeTokenFile(storage, 'http://127.0.0.1:2/mcp', T2);
    expect(second).not.toBe(first);
    expect(await readdir(storage)).toEqual([path.basename(path.dirname(second))]);
    expect(JSON.parse(await readFile(second, 'utf8')).token).toBe(T2);
  });
});

describe("Claude Code's config", () => {
  const fixture = {
    numStartups: 42,
    projects: { '/w': { allowedTools: ['Bash'], mcpServers: { local: { command: 'x' } } } },
    mcpServers: { github: { type: 'http', url: 'https://api.github.com/mcp', headers: { Authorization: 'Bearer gh' } } },
    oauthAccount: { email: 'me@example.com' },
  };

  it('gains our entry and keeps every other byte of meaning; re-registering is idempotent', async () => {
    const file = path.join(await tmp(), '.claude.json');
    await writeFile(file, JSON.stringify(fixture), { mode: 0o600 });
    expect(await registerClaude(file, 'http://127.0.0.1:5/mcp', T1)).toBe('added');
    const after = JSON.parse(await readFile(file, 'utf8'));
    expect(after).toEqual({
      ...fixture,
      mcpServers: { ...fixture.mcpServers, [SERVER_NAME]: { type: 'http', url: 'http://127.0.0.1:5/mcp', headers: { Authorization: `Bearer ${T1}` } } },
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(`${file}.friedliver-backup`, 'utf8'))).toEqual(fixture);
    expect(await registerClaude(file, 'http://127.0.0.1:5/mcp', T1)).toBe('unchanged');
    expect(await registerClaude(file, 'http://127.0.0.1:6/mcp', T2)).toBe('updated');
    expect(JSON.parse(await readFile(file, 'utf8')).mcpServers[SERVER_NAME].url).toBe('http://127.0.0.1:6/mcp');
    expect((await readdir(path.dirname(file))).sort()).toEqual(['.claude.json', '.claude.json.friedliver-backup']);
  });

  it('removes only an entry this launch wrote', async () => {
    const file = path.join(await tmp(), '.claude.json');
    await writeFile(file, JSON.stringify(fixture));
    await registerClaude(file, 'http://127.0.0.1:5/mcp', T1);
    expect(await unregisterClaude(file, 'http://127.0.0.1:9/mcp')).toBe(false);
    expect(await unregisterClaude(file, 'http://127.0.0.1:5/mcp')).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(fixture);
  });

  it('creates the file when there is none, and leaves a file it cannot parse alone', async () => {
    const dir = await tmp();
    const file = path.join(dir, '.claude.json');
    expect(await registerClaude(file, 'http://127.0.0.1:5/mcp', T1)).toBe('added');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await writeFile(file, '{ broken');
    await expect(registerClaude(file, 'http://127.0.0.1:5/mcp', T1)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('{ broken');
    await writeFile(file, '{"mcpServers": []}');
    await expect(registerClaude(file, 'http://127.0.0.1:5/mcp', T1)).rejects.toThrow(/not an object/);
  });

  it('writes through a symlinked config instead of replacing the link', async () => {
    const dir = await tmp();
    const real = path.join(dir, 'dotfiles.json');
    const link = path.join(dir, '.claude.json');
    await writeFile(real, JSON.stringify(fixture));
    await symlink(real, link);
    await registerClaude(link, 'http://127.0.0.1:5/mcp', T1);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, 'utf8')).mcpServers[SERVER_NAME].url).toBe('http://127.0.0.1:5/mcp');
  });
});
