// Mac & Windows control (host/system.ts, shared/system.ts and the system_* tool schemas): argument
// checks and caps, how each program is started (no injection, fixed binaries), platform routing,
// what may be opened, the rate limit and the audit log. Every program run is mocked, so this runs
// the same on macOS, Windows and Linux.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXTERNAL_TOOLS, handle, TOOLS } from '../src/bridge/mcp';
import { parseCall, type SystemCall } from '../src/bridge/protocol';
import { auditLine, capBytes, JXA, MAC_BIN, NOT_SUPPORTED, PS, powershell, RateLimit, SystemControl, winPowerShell, type Exec, type ExecResult } from '../src/host/system';
import { describeGrant, isGrant } from '../src/shared/permissions';
import { alwaysAllowable, isDangerousApp, SYSTEM_LIMITS, SYSTEM_TOOLS } from '../src/shared/system';
import { memoryPermissions } from './helpers';

const NASTY = ['Spo"tify', "It's $(rm -rf ~)", 'a; rm -rf /', 'back`tick`', '$env:USERPROFILE', "'; Remove-Item -Recurse C:\\ ;'", 'Ünïcødé 🎵 名前', '-e', '--args', '@(evil)'];

describe('system tool arguments (parseCall)', () => {
  const ok = (tool: string, args: object) => parseCall(tool, args);

  it('takes exactly one of app, path or url for system_open', () => {
    expect(ok('system_open', { app: 'Spotify' })).toEqual({ tool: 'system_open', app: 'Spotify' });
    expect(ok('system_open', { path: '/tmp/a.pdf' })).toEqual({ tool: 'system_open', path: '/tmp/a.pdf' });
    expect(ok('system_open', { url: 'https://example.com' })).toEqual({ tool: 'system_open', url: 'https://example.com' });
    expect(ok('system_open', {})).toBeNull();
    expect(ok('system_open', { app: 'A', url: 'https://x.y' })).toBeNull();
    expect(ok('system_open', { app: '' })).toBeNull();
    expect(ok('system_open', { app: 42 })).toBeNull();
  });

  it('refuses control characters, newlines and direction overrides in names', () => {
    for (const bad of ['Spot\nify', 'a\u0000b', 'a\rb', 'x\u202ey', 'x\u2028y', 'a\u001bb']) {
      expect(ok('system_open', { app: bad })).toBeNull();
      expect(ok('system_shortcut', { name: bad })).toBeNull();
      expect(ok('system_open', { url: `https://a.b/${bad}` })).toBeNull();
    }
    expect(ok('system_open', { app: 'x'.repeat(SYSTEM_LIMITS.name + 1) })).toBeNull();
  });

  it('caps the clipboard at 100 KB of UTF-8, not characters', () => {
    expect(ok('system_clipboard_write', { text: 'a'.repeat(SYSTEM_LIMITS.clipboard) })).not.toBeNull();
    expect(ok('system_clipboard_write', { text: 'a'.repeat(SYSTEM_LIMITS.clipboard + 1) })).toBeNull();
    // 4 bytes each: 25,600 of them fill 100 KB, one more doesn't fit.
    expect(ok('system_clipboard_write', { text: '🎵'.repeat(SYSTEM_LIMITS.clipboard / 4) })).not.toBeNull();
    expect(ok('system_clipboard_write', { text: '🎵'.repeat(SYSTEM_LIMITS.clipboard / 4 + 1) })).toBeNull();
    expect(ok('system_clipboard_write', { text: '' })).toBeNull();
    // Text may hold anything: it goes on stdin, never into a command.
    expect(ok('system_clipboard_write', { text: 'line 1\nline 2\t$(x)' })).not.toBeNull();
  });

  it('checks notifications, volume and window ids', () => {
    expect(ok('system_notify', { title: 'Done', body: 'Build passed\nall green' })).not.toBeNull();
    expect(ok('system_notify', { title: 'x'.repeat(SYSTEM_LIMITS.title + 1), body: '' })).toBeNull();
    expect(ok('system_notify', { title: 'T', body: 'x'.repeat(SYSTEM_LIMITS.body + 1) })).toBeNull();
    expect(ok('system_notify', { title: 'T' })).toBeNull();
    expect(ok('system_volume', { action: 'set', level: 40 })).toEqual({ tool: 'system_volume', action: 'set', level: 40 });
    for (const level of [-1, 101, 40.5, '40', undefined]) expect(ok('system_volume', { action: 'set', level })).toBeNull();
    expect(ok('system_volume', { action: 'mute' })).toEqual({ tool: 'system_volume', action: 'mute' });
    expect(ok('system_volume', { action: 'mute', level: 3 })).toBeNull();
    expect(ok('system_volume', { action: 'louder' })).toBeNull();
    for (const window of [0, -3, 1.5, 2 ** 31, '12']) {
      expect(ok('system_screenshot_window', { window })).toBeNull();
      expect(ok('system_focus', { window })).toBeNull();
    }
    expect(ok('system_focus', { window: 12 })).toEqual({ tool: 'system_focus', window: 12 });
    expect(ok('system_focus', { window: 12, app: 'A' })).toBeNull();
  });
});

describe('system tool schemas (mcp.ts)', () => {
  const system = TOOLS.filter((t) => t.name.startsWith('system_'));

  it('lists every system tool, with no top-level oneOf/anyOf/allOf (Claude refuses those)', () => {
    expect(system.map((t) => t.name)).toEqual([...SYSTEM_TOOLS]);
    for (const t of system) for (const k of ['oneOf', 'anyOf', 'allOf']) expect(t.inputSchema).not.toHaveProperty(k);
  });

  it('offers them, with the browser tools only, to the external client', () => {
    expect(EXTERNAL_TOOLS.map((t) => t.name).sort()).toEqual(TOOLS.filter((t) => /^(browser|system)_/.test(t.name)).map((t) => t.name).sort());
    const list = handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, true) as { reply: { result: { tools: { name: string }[] } } };
    expect(list.reply.result.tools.map((t) => t.name)).toContain('system_open');
    expect(list.reply.result.tools.map((t) => t.name)).not.toContain('read_chat');
  });

  it('turns away bad arguments before they reach the editor', () => {
    const r = handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'system_open', arguments: { app: 'a', path: '/b' } } });
    expect(r).toMatchObject({ reply: { result: { isError: true } } });
  });
});

describe('what may be always allowed', () => {
  it('knows terminals, shells, settings and key stores by name, any case', () => {
    for (const name of ['Terminal', 'terminal.app', 'iTerm', 'iTerm2', 'Warp', 'Windows PowerShell', 'PowerShell 7 (x64)', 'Command Prompt', 'cmd', 'Windows Terminal', 'System Settings', 'System Preferences', 'Keychain Access', 'Registry Editor', 'Task Manager', 'Script Editor', 'Ubuntu', 'Git Bash']) {
      expect(isDangerousApp(name), name).toBe(true);
    }
    for (const name of ['Spotify', 'Safari', 'Google Chrome', 'Notes', 'Visual Studio Code', 'Slack']) expect(isDangerousApp(name), name).toBe(false);
  });

  it('never the clipboard, screenshots or dangerous apps; stored grants for them are dropped', () => {
    expect(alwaysAllowable('system_open', 'app:Spotify')).toBe(true);
    expect(alwaysAllowable('system_open', 'app:Terminal')).toBe(false);
    expect(alwaysAllowable('system_focus', 'app:Keychain Access')).toBe(false);
    expect(alwaysAllowable('system_clipboard_read', '')).toBe(false);
    expect(alwaysAllowable('system_screenshot_window', 'app:Safari')).toBe(false);
    expect(isGrant({ kind: 'system', tool: 'system_clipboard_read', target: '' })).toBe(false);
    expect(isGrant({ kind: 'system', tool: 'system_open', target: 'app:Terminal' })).toBe(false);
    expect(isGrant({ kind: 'system', tool: 'system_open', target: 'app:Spot\nify' })).toBe(false);
    expect(isGrant({ kind: 'system', tool: 'rm_rf', target: '' })).toBe(false);
    expect(isGrant({ kind: 'system', tool: 'system_open', target: 'app:Spotify' })).toBe(true);
    const p = memoryPermissions();
    expect(p.add({ kind: 'system', tool: 'system_screenshot_window', target: 'app:Safari' })).toBe(false);
    expect(p.add({ kind: 'system', tool: 'system_open', target: 'app:Spotify' }, 'Claude')).toBe(true);
    expect(p.system('system_open', 'app:Spotify')).toMatchObject({ scope: 'user', agent: 'Claude' });
    expect(p.system('system_open', 'app:Music')).toBeUndefined();
    expect(describeGrant({ kind: 'system', tool: 'system_open', target: 'app:Spotify' })).toEqual({ what: 'Open apps, files and links', scope: 'Spotify' });
  });
});

/** A SystemControl whose programs are recorded and answered by `reply`. */
function control(platform: NodeJS.Platform, over: { reply?: (e: Exec) => Partial<ExecResult>; home?: string; appDirs?: string[]; links?: 'builtin' | 'external'; env?: NodeJS.ProcessEnv } = {}) {
  const runs: Exec[] = [];
  const opened: string[] = [];
  const sys = new SystemControl({
    platform,
    home: over.home ?? '/nonexistent-home',
    shotsBase: os.tmpdir(),
    env: over.env ?? { SystemRoot: 'C:\\Windows' },
    appDirs: over.appDirs ?? [],
    links: () => over.links ?? 'external',
    openInBrowser: async (url) => (opened.push(url), 'opened inside'),
    run: async (e) => {
      runs.push(e);
      return { code: 0, stdout: '', stderr: '', ...over.reply?.(e) };
    },
  });
  return { sys, runs, opened };
}

const signal = new AbortController().signal;

async function appsDir(platform: 'mac' | 'win', names: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fl-apps-'));
  for (const name of names) {
    if (platform === 'mac') await mkdir(path.join(dir, `${name}.app`, 'Contents'), { recursive: true });
    else {
      await mkdir(path.join(dir, 'Sub'), { recursive: true });
      await writeFile(path.join(dir, 'Sub', `${name}.lnk`), '');
    }
  }
  return dir;
}

/** The PowerShell script and data of a Windows run, decoded. */
function decodePs(e: Exec): { script: string; data: unknown } {
  const i = e.args.indexOf('-EncodedCommand');
  return { script: Buffer.from(e.args[i + 1], 'base64').toString('utf16le'), data: JSON.parse(Buffer.from(e.input!, 'base64').toString('utf8')) };
}

const MAC_FILES = new Set<string>(Object.values(MAC_BIN));

describe('platform routing', () => {
  it('says "not supported" on Linux and anything else, for every tool', async () => {
    for (const platform of ['linux', 'freebsd'] as NodeJS.Platform[]) {
      const { sys, runs } = control(platform);
      for (const call of [{ tool: 'system_apps' }, { tool: 'system_clipboard_read' }, { tool: 'system_open', app: 'x' }] as SystemCall[]) {
        await expect(sys.prepare(call)).rejects.toThrow(NOT_SUPPORTED);
      }
      expect(runs).toEqual([]);
    }
  });

  it('refuses Shortcuts on Windows, naming Power Automate as later', async () => {
    await expect(control('win32').sys.prepare({ tool: 'system_shortcut', name: 'X' })).rejects.toThrow(/macOS only.*Power Automate/);
  });

  it('starts only fixed absolute programs, without a shell', async () => {
    const mac = control('darwin', { reply: (e) => ({ stdout: e.file === MAC_BIN.osascript && e.args[3].includes('runningApplications') ? JSON.stringify({ apps: [], windows: [] }) : e.file === MAC_BIN.osascript ? '{"level":1,"muted":false}' : '' }) });
    const win = control('win32', { reply: (e) => ({ stdout: decodePs(e).script.includes('Get-Process') ? '[]' : decodePs(e).script.includes('FlAudio') ? '{"level":1,"muted":false}' : '""' }) });
    const calls: SystemCall[] = [
      { tool: 'system_apps' },
      { tool: 'system_clipboard_read' },
      { tool: 'system_clipboard_write', text: 'x' },
      { tool: 'system_notify', title: 't', body: 'b' },
      { tool: 'system_volume', action: 'get' },
      { tool: 'system_open', url: 'https://example.com/' },
    ];
    for (const call of calls) {
      await (await mac.sys.prepare(call)).run(signal);
      await (await win.sys.prepare(call)).run(signal);
    }
    expect(mac.runs.every((e) => MAC_FILES.has(e.file))).toBe(true);
    expect(win.runs.every((e) => e.file === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe(true);
    for (const e of win.runs) expect(e.args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand']);
  });

  it('finds PowerShell under the real Windows folder only, never on PATH', () => {
    expect(winPowerShell({ SystemRoot: 'D:\\WINNT' })).toBe('D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    for (const SystemRoot of ['', 'Windows', '\\\\evil\\share', 'C:\\x\\..\\evil', 'C:\\Win"dows', 'C:\\a\\b', undefined]) {
      expect(winPowerShell({ SystemRoot })).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    }
  });
});

describe('no injection: agent text never becomes code or an option', () => {
  it('macOS apps open by their bundle path from the installed list, as one argument', async () => {
    // A file name can't hold '/' (nor, on Windows, <>:"|?*\\), so those can't be installed apps.
    const names = NASTY.filter((n) => !(process.platform === 'win32' ? /[<>:"|?*\\/]/ : /\//).test(n));
    const dir = await appsDir('mac', ['Spotify', ...names]);
    const { sys, runs } = control('darwin', { appDirs: [dir] });
    for (const name of ['spotify', ...names]) {
      await (await sys.prepare({ tool: 'system_open', app: name })).run(signal);
      const e = runs.at(-1)!;
      expect(e.file).toBe('/usr/bin/open');
      expect(e.args).toHaveLength(2);
      expect(e.args[0]).toBe('-a');
      expect(path.isAbsolute(e.args[1])).toBe(true);
      expect(e.args[1].startsWith(dir)).toBe(true);
    }
    await expect(sys.prepare({ tool: 'system_open', app: 'Not Installed' })).rejects.toThrow(/No installed app/);
  });

  it('osascript gets fixed script text; data rides in FL_DATA as JSON', async () => {
    const { sys, runs } = control('darwin', { reply: () => ({ stdout: '{"level":3,"muted":false}' }) });
    for (const s of NASTY) {
      await (await sys.prepare({ tool: 'system_notify', title: s, body: `${s}\n${s}` })).run(signal);
      const e = runs.at(-1)!;
      expect(e.args.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e']);
      expect(e.args).toHaveLength(4);
      expect(e.args[3]).toContain(JXA.notify);
      expect(e.args[3]).not.toContain(s);
      expect(JSON.parse(e.env!.FL_DATA)).toEqual({ title: s, body: `${s}\n${s}` });
    }
  });

  it('PowerShell gets a fixed -EncodedCommand; data rides on stdin as base64 JSON', async () => {
    const dir = await appsDir('win', ['Spotify']);
    const { sys, runs } = control('win32', { appDirs: [dir], reply: () => ({ stdout: '{"level":3,"muted":false}' }) });
    const scripts = new Set<string>();
    for (const s of NASTY) {
      for (const call of [
        { tool: 'system_notify', title: s, body: s },
        { tool: 'system_clipboard_write', text: s },
        { tool: 'system_open', url: `https://example.com/?q=${encodeURIComponent(s)}` },
      ] as SystemCall[]) {
        await (await sys.prepare(call)).run(signal);
        const e = runs.at(-1)!;
        expect(e.args.join(' ')).not.toContain(s);
        expect(e.input).toMatch(/^[A-Za-z0-9+/]+=*$/);
        const { script, data } = decodePs(e);
        scripts.add(script);
        expect(script).not.toContain(s);
        if (call.tool !== 'system_open') expect(Object.values(data as object)).toContain(s);
      }
    }
    // One script per tool, whatever the data.
    expect(scripts.size).toBe(3);
    await (await sys.prepare({ tool: 'system_open', app: 'Spotify' })).run(signal);
    expect(decodePs(runs.at(-1)!)).toEqual({ script: expect.stringContaining(PS.openPath), data: { path: path.join(dir, 'Sub', 'Spotify.lnk') } });
  });

  it('Shortcuts run by exact name after `--`, so a name like "-h" is a name', async () => {
    const { sys, runs } = control('darwin', { reply: (e) => ({ stdout: e.args[0] === 'list' ? 'ExpenseLog\n-h\nIt\'s $(x)\n' : '' }) });
    for (const name of ['ExpenseLog', '-h', "It's $(x)"]) {
      await (await sys.prepare({ tool: 'system_shortcut', name })).run(signal);
      expect(runs.at(-1)).toMatchObject({ file: '/usr/bin/shortcuts', args: ['run', '--', name] });
    }
    await expect(sys.prepare({ tool: 'system_shortcut', name: 'expenselog' })).rejects.toThrow(/no Shortcut named exactly/);
  });

  it('the clipboard goes through stdin on macOS', async () => {
    const { sys, runs } = control('darwin');
    await (await sys.prepare({ tool: 'system_clipboard_write', text: 'a\n$(b)`c`' })).run(signal);
    expect(runs.at(-1)).toEqual({ file: '/usr/bin/pbcopy', args: [], input: 'a\n$(b)`c`' });
  });

  it('URLs are http(s) only, without credentials, and normalized before they are passed', async () => {
    const { sys, runs } = control('darwin');
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'x-apple.systempreferences:com.apple', 'vscode://command/x', 'https://user:pw@example.com']) {
      await expect(sys.prepare({ tool: 'system_open', url })).rejects.toThrow();
    }
    await (await sys.prepare({ tool: 'system_open', url: 'https://example.com/a b' })).run(signal);
    expect(runs.at(-1)!.args).toEqual(['https://example.com/a%20b']);
  });

  it('URLs open in FriedLiver\'s browser when friedliver.links.openIn is "builtin"', async () => {
    const { sys, runs, opened } = control('darwin', { links: 'builtin' });
    const p = await sys.prepare({ tool: 'system_open', url: 'https://example.com' });
    expect(p.target).toBe('url:https://example.com');
    await expect(p.run(signal)).resolves.toBe('opened inside');
    expect(opened).toEqual(['https://example.com/']);
    expect(runs).toEqual([]);
  });
});

describe('opening files and folders (on this machine\'s own disk and platform)', () => {
  const WIN = process.platform === 'win32';
  const host: NodeJS.Platform = WIN ? 'win32' : 'darwin';

  async function home() {
    const h = await mkdtemp(path.join(os.tmpdir(), 'fl-home-'));
    await mkdir(path.join(h, '.ssh'));
    await writeFile(path.join(h, '.ssh', 'id_rsa.txt'), 'key');
    await mkdir(path.join(h, 'Docs'));
    await writeFile(path.join(h, 'Docs', 'report.pdf'), '%PDF');
    for (const f of SCRIPTS) await writeFile(path.join(h, 'Docs', f), '');
    await mkdir(path.join(h, 'Docs', 'Fake.app', 'Contents'), { recursive: true });
    await mkdir(path.join(h, 'Docs', 'Sneaky', 'Contents'), { recursive: true });
    await writeFile(path.join(h, 'Docs', 'Sneaky', 'Contents', 'Info.plist'), '');
    await mkdir(path.join(h, 'Docs', 'Bin.{645FF040-5081-101B-9F08-00AA002F954E}'));
    await symlink(path.join(h, '.ssh'), path.join(h, 'Docs', 'keys'), 'junction');
    return h;
  }
  const SCRIPTS = ['run.sh', 'x.command', 'noext', 'page.html', 'evil.webloc', 'script.js', 'macro.docm', 'a.terminal', 'setup.exe', 'run.bat', 'go.ps1', 'link.lnk', 'site.url', 'a.vbs', 'b.hta', 'c.msi'];

  it('opens documents and folders by their real path', async () => {
    const h = await home();
    const { sys, runs } = control(host, { home: h });
    const p = await sys.prepare({ tool: 'system_open', path: path.join(h, 'Docs', 'report.pdf') });
    await p.run(signal);
    const real = await import('node:fs/promises').then((fs) => fs.realpath(path.join(h, 'Docs', 'report.pdf')));
    expect(p.target).toBe(`file:${real}`);
    if (WIN) expect(decodePs(runs.at(-1)!)).toEqual({ script: expect.stringContaining(PS.openPath), data: { path: real } });
    else expect(runs.at(-1)).toEqual({ file: '/usr/bin/open', args: [real] });
    await (await sys.prepare({ tool: 'system_open', path: path.join(h, 'Docs') })).run(signal);
  });

  it('refuses programs, scripts, app bundles, private folders (also through links), relative and missing paths', async () => {
    const h = await home();
    const { sys, runs } = control(host, { home: h });
    const refused: [string, RegExp][] = [
      ...SCRIPTS.map((f): [string, RegExp] => [path.join(h, 'Docs', f), /documents, images, media and folders only/]),
      [path.join(h, 'Docs', 'Fake.app'), /app or package/],
      [path.join(h, 'Docs', 'Bin.{645FF040-5081-101B-9F08-00AA002F954E}'), /app or package/],
      [path.join(h, '.ssh', 'id_rsa.txt'), /private or system place/],
      [path.join(h, 'Docs', 'keys', 'id_rsa.txt'), /private or system place/],
      [WIN ? 'Docs\\report.pdf' : 'Docs/report.pdf', /absolute path/],
      [path.join(h, 'nope.pdf'), /no file or folder/],
      ...(WIN ? [] : ([[path.join(h, 'Docs', 'Sneaky'), /app or package/], ['/etc/hosts', /private or system place/], ['//server/share/a.pdf', /Network paths/]] as [string, RegExp][])),
    ];
    for (const [p, why] of refused) await expect(sys.prepare({ tool: 'system_open', path: p }), p).rejects.toThrow(why);
    expect(runs).toEqual([]);
  });

  it('on Windows, refuses relative, network and alternate-stream paths before touching the disk', async () => {
    const { sys } = control('win32');
    await expect(sys.prepare({ tool: 'system_open', path: '\\\\attacker\\share\\a.pdf' })).rejects.toThrow(/absolute path|Network/);
    await expect(sys.prepare({ tool: 'system_open', path: 'Docs\\a.pdf' })).rejects.toThrow(/absolute path/);
    await expect(sys.prepare({ tool: 'system_open', path: 'C:\\Users\\me\\a.pdf:evil.exe' })).rejects.toThrow(/alternate data stream/);
  });
});

describe('apps, windows, focus and screenshots', () => {
  const running = { apps: [{ name: 'Safari', pid: 10, path: '/Applications/Safari.app' }], windows: [{ id: 77, app: 'Safari', pid: 10, title: 'Docs' }] };
  const reply = (e: Exec) => ({ stdout: e.file === MAC_BIN.osascript ? JSON.stringify(running) : '' });

  it('lists installed apps from the folders, and running apps with their windows', async () => {
    const mac = await appsDir('mac', ['Spotify', 'Notes']);
    const { sys } = control('darwin', { appDirs: [mac], reply });
    const out = JSON.parse(await (await sys.prepare({ tool: 'system_apps' })).run(signal));
    expect(out).toEqual({ installed: ['Notes', 'Spotify'], running: ['Safari'], windows: running.windows });
    const win = await appsDir('win', ['Spotify']);
    const w = control('win32', { appDirs: [win], reply: () => ({ stdout: '[{"id":5,"name":"spotify","title":"Spotify Premium"}]' }) });
    expect(JSON.parse(await (await w.sys.prepare({ tool: 'system_apps' })).run(signal))).toEqual({
      installed: ['Spotify'],
      running: ['spotify'],
      windows: [{ id: 5, app: 'spotify', pid: 5, title: 'Spotify Premium' }],
    });
  });

  it('focuses a running app or a window\'s app, by bundle path on macOS and process id on Windows', async () => {
    const { sys, runs } = control('darwin', { reply });
    const byWindow = await sys.prepare({ tool: 'system_focus', window: 77 });
    expect(byWindow.target).toBe('app:Safari');
    await byWindow.run(signal);
    expect(runs.at(-1)).toEqual({ file: '/usr/bin/open', args: ['-a', '/Applications/Safari.app'] });
    await expect(sys.prepare({ tool: 'system_focus', app: 'Nope' })).rejects.toThrow(/isn't running/);
    await expect(sys.prepare({ tool: 'system_focus', window: 78 })).rejects.toThrow(/no window 78/);
    const w = control('win32', { reply: () => ({ stdout: '[{"id":5,"name":"spotify","title":"x"}]' }) });
    await (await w.sys.prepare({ tool: 'system_focus', app: 'Spotify' })).run(signal);
    expect(decodePs(w.runs.at(-1)!)).toEqual({ script: expect.stringContaining('AppActivate'), data: { pid: 5 } });
  });

  it('screenshots a window into the private folder, as a file only you can read', async () => {
    const { sys, runs } = control('darwin', {
      reply: (e) => {
        if (e.file === MAC_BIN.screencapture) execFileSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(e.args.at(-1))}, 'png')`]);
        return reply(e);
      },
    });
    const p = await sys.prepare({ tool: 'system_screenshot_window', window: 77 });
    const text = await p.run(signal);
    const e = runs.at(-1)!;
    expect(e.file).toBe('/usr/sbin/screencapture');
    expect(e.args.slice(0, 3)).toEqual(['-x', '-o', '-l77']);
    const file = /^Saved to (.+\.png)\. /m.exec(text)![1];
    expect(text).toMatch(/^Screenshot of Safari — Docs$/m);
    expect(path.dirname(file)).toMatch(/shots-/);
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
  });

  it('says so when the screenshot program made nothing (no Screen Recording permission)', async () => {
    const { sys } = control('darwin', { reply });
    await expect((await sys.prepare({ tool: 'system_screenshot_window', window: 77 })).run(signal)).rejects.toThrow(/Screen Recording/);
  });

  it('reports a failing program without its raw control characters', async () => {
    const { sys } = control('darwin', { reply: () => ({ code: 1, stderr: 'boom\u001b[31m red' }) });
    await expect((await sys.prepare({ tool: 'system_clipboard_read' })).run(signal)).rejects.toThrow(/^It didn't work: boom \[31m red$/);
  });

  it('caps what the clipboard returns', async () => {
    const big = 'é'.repeat(SYSTEM_LIMITS.clipboard);
    const { sys } = control('darwin', { reply: () => ({ stdout: big }) });
    const text = await (await sys.prepare({ tool: 'system_clipboard_read' })).run(signal);
    expect(Buffer.byteLength(text)).toBeLessThan(SYSTEM_LIMITS.clipboard + 100);
    expect(text).toMatch(/cut at 100 KB/);
    expect(capBytes('abc', 10)).toBe('abc');
  });
});

describe('rate limit and audit log', () => {
  it('allows N a minute per key, then again once the minute moves on', () => {
    let t = 0;
    const r = new RateLimit(3, 60_000, () => t);
    expect([r.take('a'), r.take('a'), r.take('a'), r.take('a'), r.take('b')]).toEqual([true, true, true, false, true]);
    t = 60_001;
    expect(r.take('a')).toBe(true);
  });

  it('logs time, agent, chat, tool, args and result; clipboard text and bodies only as lengths', () => {
    const at = Date.UTC(2026, 9, 18, 10, 0, 0);
    expect(auditLine({ at, agent: 'Claude', chat: 'chat-3', call: { tool: 'system_open', app: 'Spotify' }, result: 'ok: Open Spotify' })).toBe(
      '2026-10-18T10:00:00.000Z Claude chat-3 system_open {"app":"Spotify"} → ok: Open Spotify',
    );
    expect(auditLine({ at, agent: 'Claude', chat: 'chat-3', call: { tool: 'system_clipboard_write', text: 'hunter2' }, result: 'ok' })).toContain('{"text":"<7 chars>"}');
    expect(auditLine({ at, agent: 'Claude', chat: 'chat-3', call: { tool: 'system_notify', title: 'Hi', body: 'secret' }, result: 'ok' })).toContain('{"title":"Hi","body":"<6 chars>"}');
    expect(auditLine({ at, agent: 'Claude', chat: 'chat-3', call: { tool: 'system_clipboard_read' }, result: 'ok: the secret' })).toMatch(/→ ok \(text not logged\)$/);
    expect(auditLine({ at, agent: 'A\nB', chat: 'c', call: { tool: 'system_open', app: 'x' }, result: 'not done:\nforged line' })).not.toContain('\n');
  });
});

describe.runIf(process.platform === 'darwin')('the macOS scripts compile (osacompile)', () => {
  for (const [name, script] of Object.entries(JXA)) {
    it(name, async () => {
      const out = path.join(await mkdtemp(path.join(os.tmpdir(), 'fl-jxa-')), 's.scpt');
      const exec = { file: '/usr/bin/osacompile', args: ['-l', 'JavaScript', '-o', out, '-e', `const d = {};\n${script}`] };
      expect(() => execFileSync(exec.file, exec.args, { stdio: 'pipe' })).not.toThrow();
    });
  }
});

describe('PowerShell templates', () => {
  it('start from the same prelude and never interpolate data', () => {
    for (const [name, script] of Object.entries(PS)) {
      const e = powershell(script, { x: 1 }, { SystemRoot: 'C:\\Windows' });
      const text = decodePs(e).script;
      expect(text, name).toMatch(/^\$ErrorActionPreference = 'Stop'/);
      expect(text, name).toContain('[Console]::In.ReadToEnd()');
      // No backtick escapes or double-quoted PowerShell strings that could expand: data is only ever $d.<field>.
      expect(script.replace(/@'[\s\S]*?'@/g, ''), name).not.toMatch(/`|"/);
    }
  });
});

describe('settings (friedliver.system.*)', () => {
  it('come from the user only: a workspace can neither turn them on nor let Full auto cover them', async () => {
    const { systemSettings } = await import('../src/host/system');
    expect(systemSettings(() => undefined)).toEqual({ enabled: true, fullAutoAllowed: false, tools: Object.fromEntries(SYSTEM_TOOLS.map((t) => [t, true])) });
    const fromWorkspace = systemSettings((k) => ({ defaultValue: k === 'fullAutoAllowed' ? false : k === 'enabled' ? true : {}, workspaceValue: k === 'fullAutoAllowed' ? true : k === 'enabled' ? true : {} }));
    expect(fromWorkspace.fullAutoAllowed).toBe(false);
    const user = systemSettings((k) => ({ globalValue: k === 'enabled' ? false : k === 'fullAutoAllowed' ? true : { system_clipboard_read: false, system_open: 'yes' } }));
    expect(user).toMatchObject({ enabled: false, fullAutoAllowed: true, tools: { system_clipboard_read: false, system_open: true } });
  });
});

/** CI's Windows runner (ci.yml sets FRIEDLIVER_SYSTEM_SMOKE): the real PowerShell, with harmless inputs. */
describe.runIf(process.platform === 'win32' && !!process.env.FRIEDLIVER_SYSTEM_SMOKE)('the real PowerShell templates (Windows CI smoke)', () => {
  const real = () => new SystemControl({ home: os.homedir(), shotsBase: os.tmpdir() });

  it('every template parses', async () => {
    const parse = String.raw`$errs = @()
foreach ($s in $d.scripts) { $e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([string]$s, [ref]$null, [ref]$e); $errs += @($e | ForEach-Object { $_.Message }) }
ConvertTo-Json -Compress -InputObject @($errs)`;
    const { spawnRunner } = await import('../src/host/system');
    const r = await spawnRunner('win')(powershell(parse, { scripts: Object.values(PS) }), signal);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });

  it('lists the processes that have windows', async () => {
    const r = await real().running(signal);
    expect(Array.isArray(r.apps) && Array.isArray(r.windows)).toBe(true);
  });

  it('round-trips text through the clipboard, quotes and all', async () => {
    const sys = real();
    const text = `FriedLiver smoke ${Date.now()} “quotes” 'single' $(x) \`tick\` ; 名前 🎵`;
    await (await sys.prepare({ tool: 'system_clipboard_write', text })).run(signal);
    expect(await (await sys.prepare({ tool: 'system_clipboard_read' })).run(signal)).toBe(text);
  });
});
