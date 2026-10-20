import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RELEASES_API,
  RELEASES_PAGE,
  SUMS_ASSET,
  appBundleFor,
  checkForUpdate,
  compareVersions,
  downloadVerified,
  UPDATER_APP,
  UPDATER_INFO_PLIST,
  installScript,
  isAllowedDownload,
  manualCheckMessage,
  versionLabel,
  readInstallResult,
  releasePageFrom,
  resolveRealApp,
  parseRelease,
  pickInstaller,
  sumFor,
  type Release,
} from '../src/host/updateCheck';

function respond(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, req?: RequestInit) => {
    calls.push({ url, init: req });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: init.status ?? 200, headers: init.headers });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const DL = 'https://github.com/MrArun005/FriedLiver-Code/releases/download';
const asset = (tag: string, name: string, size = 10) => ({ name, size, browser_download_url: `${DL}/${tag}/${name}` });
const release = (tag: string, over: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `${RELEASES_PAGE}/tag/${tag}`,
  draft: false,
  prerelease: false,
  assets: [asset(tag, 'FriedLiver-darwin-arm64-1.143.0.dmg'), asset(tag, 'FriedLiverUserSetup-x64-1.143.0.exe'), asset(tag, SUMS_ASSET)],
  ...over,
});

describe('versions', () => {
  it('compares upstream versions and FriedLiver build numbers', () => {
    expect(compareVersions('1.143.0', '1.142.0')).toBeGreaterThan(0);
    expect(compareVersions('v1.142.0-2', '1.142.0')).toBeGreaterThan(0);
    expect(compareVersions('1.142.0', 'v1.142.0')).toBe(0);
    expect(compareVersions('1.141.9', '1.142.0')).toBeLessThan(0);
    expect(compareVersions('1.142.10', '1.142.9')).toBeGreaterThan(0);
    expect(compareVersions('latest', '1.142.0')).toBeNull();
    expect(compareVersions('1.142.0-beta', '1.142.0')).toBeNull();
  });

  it('reads releases, ignoring drafts and pre-releases, and links only to this repo', () => {
    const r = parseRelease(release('v1.143.0'))!;
    expect(r.version).toBe('1.143.0');
    expect(r.url).toBe(`${RELEASES_PAGE}/tag/v1.143.0`);
    expect(r.assets.map((a) => a.name)).toEqual(['FriedLiver-darwin-arm64-1.143.0.dmg', 'FriedLiverUserSetup-x64-1.143.0.exe', SUMS_ASSET]);
    expect(parseRelease(release('v1.143.0', { html_url: 'https://evil.example/download' }))!.url).toBe(RELEASES_PAGE);
    expect(parseRelease(release('v1.143.0', { prerelease: true }))).toBeNull();
    expect(parseRelease(release('v1.143.0', { draft: true }))).toBeNull();
    expect(parseRelease(release('[x](command:evil)'))).toBeNull();
    expect(parseRelease(null)).toBeNull();
  });

  it('drops assets that are not this repo’s release downloads', () => {
    const r = parseRelease(
      release('v1.143.0', {
        assets: [
          { name: 'a.dmg', size: 1, browser_download_url: 'https://evil.example/a.dmg' },
          { name: 'b.dmg', size: 1, browser_download_url: 'http://github.com/MrArun005/FriedLiver-Code/releases/download/v1/b.dmg' },
          { name: 'c.dmg', size: 1, browser_download_url: 'https://github.com/someone/FriedLiver-Code/releases/download/v1/c.dmg' },
          { name: 'd.dmg', size: -1, browser_download_url: `${DL}/v1/d.dmg` },
        ],
      }),
    )!;
    expect(r.assets).toEqual([]);
  });
});

describe('download URL allowlist', () => {
  it('allows only https release downloads of this repo and GitHub’s asset hosts', () => {
    expect(isAllowedDownload(`${DL}/v1.143.0/x.dmg`)).toBe(true);
    expect(isAllowedDownload('https://objects.githubusercontent.com/github-production-release-asset/1?x=1')).toBe(true);
    expect(isAllowedDownload('https://release-assets.githubusercontent.com/github-production-release-asset/1?x=1')).toBe(true);
    expect(isAllowedDownload(`http://github.com/MrArun005/FriedLiver-Code/releases/download/v1/x.dmg`)).toBe(false);
    expect(isAllowedDownload('https://github.com/MrArun005/Other/releases/download/v1/x.dmg')).toBe(false);
    expect(isAllowedDownload('https://github.com/MrArun005/FriedLiver-Code/archive/x.zip')).toBe(false);
    expect(isAllowedDownload('https://github.com.evil.example/MrArun005/FriedLiver-Code/releases/download/v1/x.dmg')).toBe(false);
    expect(isAllowedDownload('https://user@github.com/MrArun005/FriedLiver-Code/releases/download/v1/x.dmg')).toBe(false);
    expect(isAllowedDownload('https://github.com:8443/MrArun005/FriedLiver-Code/releases/download/v1/x.dmg')).toBe(false);
    expect(isAllowedDownload('not a url')).toBe(false);
  });
});

describe('installer per platform', () => {
  const r = parseRelease(release('v1.143.0'))!;
  it('picks the arm64 DMG on Apple silicon only', () => {
    expect(pickInstaller(r, 'darwin', 'arm64')?.name).toBe('FriedLiver-darwin-arm64-1.143.0.dmg');
    expect(pickInstaller(r, 'darwin', 'x64')).toBeNull();
    expect(pickInstaller(r, 'win32', 'x64')).toBeNull();
    expect(pickInstaller(r, 'linux', 'x64')).toBeNull();
    expect(pickInstaller({ ...r, assets: r.assets.filter((a) => !a.name.endsWith('.dmg')) }, 'darwin', 'arm64')).toBeNull();
  });

  it('finds the running .app from the app root, else null', () => {
    expect(appBundleFor('/Applications/FriedLiver.app/Contents/Resources/app')).toBe('/Applications/FriedLiver.app');
    expect(appBundleFor('/Users/me/Apps/FriedLiver.app/Contents/Resources/app')).toBe('/Users/me/Apps/FriedLiver.app');
    expect(appBundleFor('/home/me/vscode')).toBeNull();
  });
});

describe('checksums', () => {
  const hex = 'a'.repeat(64);
  it('reads the sum for one file from SHA256SUMS', () => {
    const sums = `${'b'.repeat(64)}  other.zip\n${hex}  FriedLiver-darwin-arm64-1.143.0.dmg\n`;
    expect(sumFor(sums, 'FriedLiver-darwin-arm64-1.143.0.dmg')).toBe(hex);
    expect(sumFor(`${hex} *x.dmg`, 'x.dmg')).toBe(hex);
    expect(sumFor(sums, 'missing.dmg')).toBeNull();
    expect(sumFor(`nothex  x.dmg`, 'x.dmg')).toBeNull();
  });
});

describe('verified download', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const body = 'installer bytes';
  const sha = createHash('sha256').update(body).digest('hex');
  const url = `${DL}/v1.143.0/x.dmg`;

  it('follows allowed redirects, reports progress and keeps a matching file', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'fl-'));
    const dest = path.join(dir, 'x.dmg');
    const seen: string[] = [];
    const fetchFn = (async (u: string) => {
      seen.push(u);
      if (u === url) return new Response(null, { status: 302, headers: { location: 'https://objects.githubusercontent.com/a?b=c' } });
      return new Response(body);
    }) as unknown as typeof fetch;
    const progress: number[] = [];
    await downloadVerified(fetchFn, url, dest, { size: body.length, sha256: sha }, (n) => progress.push(n));
    expect(readFileSync(dest, 'utf8')).toBe(body);
    expect(seen).toEqual([url, 'https://objects.githubusercontent.com/a?b=c']);
    expect(progress.at(-1)).toBe(body.length);
  });

  it('refuses a mismatched checksum, a wrong size and a redirect off the allowlist', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'fl-'));
    const dest = path.join(dir, 'x.dmg');
    await expect(downloadVerified(respond(body).fetchFn, url, dest, { size: body.length, sha256: 'c'.repeat(64) })).rejects.toThrow(/checksum/i);
    await expect(downloadVerified(respond(body).fetchFn, url, dest, { size: body.length + 1, sha256: sha })).rejects.toThrow(/size/i);
    await expect(downloadVerified(respond(body + body).fetchFn, url, dest, { size: body.length, sha256: sha })).rejects.toThrow(/size/i);
    const evil = (async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.dmg' } })) as unknown as typeof fetch;
    await expect(downloadVerified(evil, url, dest, { size: body.length, sha256: sha })).rejects.toThrow(/not allowed/i);
    await expect(downloadVerified(respond(body).fetchFn, 'https://evil.example/x.dmg', dest, { size: body.length, sha256: sha })).rejects.toThrow(/not allowed/i);
  });
});

describe('the check', () => {
  it('offers a newer release once per session, with an anonymous request to the releases API', async () => {
    const { calls, fetchFn } = respond(release('v1.143.0'));
    const told: Release[] = [];
    const offered = new Set<string>();
    const deps = { current: '1.142.0', fetch: fetchFn, offered, notify: (r: Release) => told.push(r) };
    expect(await checkForUpdate(deps)).toBe('newer');
    expect(told.map((r) => r.version)).toEqual(['1.143.0']);
    expect(calls[0].url).toBe(RELEASES_API);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(Object.keys(headers).map((h) => h.toLowerCase()).sort()).toEqual(['accept', 'user-agent', 'x-github-api-version']);
    // Later (or ignoring it) keeps that version quiet for the rest of the session.
    expect(await checkForUpdate(deps)).toBe('already-told');
    expect(told).toHaveLength(1);
    // A newer one still gets through; a new session (new set) asks again.
    expect(await checkForUpdate({ ...deps, fetch: respond(release('v1.144.0')).fetchFn })).toBe('newer');
    expect(await checkForUpdate({ ...deps, offered: new Set() })).toBe('newer');
  });

  it('stays quiet when this build is current or newer', async () => {
    for (const current of ['1.143.0', '1.143.0-1']) {
      const told: Release[] = [];
      expect(await checkForUpdate({ current, fetch: respond(release('v1.143.0')).fetchFn, offered: new Set(), notify: (r) => told.push(r) })).toBe('up-to-date');
      expect(told).toEqual([]);
    }
  });

  it('fails silently', async () => {
    const failing = [
      (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
      respond({ message: 'rate limited' }, { status: 403 }).fetchFn,
      respond('not json').fetchFn,
      respond('x', { headers: { 'content-length': String(5 * 1024 * 1024) } }).fetchFn,
    ];
    for (const fetchFn of failing) {
      const told: Release[] = [];
      const logged: string[] = [];
      expect(await checkForUpdate({ current: '1.142.0', fetch: fetchFn, offered: new Set(), notify: (r) => told.push(r), log: (l) => logged.push(l) })).toBe('failed');
      expect(told).toEqual([]);
      expect(logged[0]).toMatch(/^Update check failed/);
    }
  });
});

describe('install script', () => {
  const args = { pid: 4242, app: '/Applications/FriedLiver.app', dmg: "/tmp/fl-x/it's.dmg", dir: '/tmp/fl-x', log: '/tmp/friedliver-update.log', version: '1.142.0-3', page: `${RELEASES_PAGE}/tag/v1.142.0-3` };
  it('waits for the app, swaps the bundle from the DMG, clears quarantine and reopens the real path', () => {
    const script = installScript(args);
    expect(script).toMatchSnapshot();
    expect(script).toContain(`DMG='/tmp/fl-x/it'\\''s.dmg'`);
    expect(script).toContain('xattr -dr com.apple.quarantine "$APP"');
    expect(script).toContain('open -a "$APP"');
    expect(script).toContain('echo "RESULT ok $VERSION" >> "$LOG"');
  });
  it('mounts without a second checksum pass at its own mountpoint, retries once, and never opens the DMG in Finder', () => {
    const script = installScript(args);
    expect(script).toContain('diskutil image attach --readOnly --nobrowse --mountPoint "$MNT" "$DMG"');
    expect(script).toContain('hdiutil attach -nobrowse -readonly -noautoopen -noverify -mountpoint "$MNT" "$DMG"');
    expect(script).toContain('attach || { sleep 2; say "retrying the mount"; attach; }');
    expect(script).toContain('trap cleanup EXIT');
    expect(script).not.toMatch(/open "\$DMG"|\/Volumes\//);
  });
  it('names only this repo’s release page for a manual download', () => {
    expect(installScript(args)).toContain(`PAGE='${RELEASES_PAGE}/tag/v1.142.0-3'`);
    expect(installScript({ ...args, page: 'https://evil.example/x' })).toContain(`PAGE='${RELEASES_PAGE}'`);
    expect(releasePageFrom(`PAGE ${RELEASES_PAGE}/tag/v1.142.0-9\nstarted\n`)).toBe(`${RELEASES_PAGE}/tag/v1.142.0-9`);
    expect(releasePageFrom('PAGE https://evil.example/x\n')).toBe(RELEASES_PAGE);
    expect(releasePageFrom('started\n')).toBe(RELEASES_PAGE);
  });
  it('runs as its own background-only app, whose executable is the script', () => {
    expect(UPDATER_APP).toMatch(/\.app$/);
    expect(UPDATER_INFO_PLIST).toContain('<key>CFBundleExecutable</key><string>install</string>');
    expect(UPDATER_INFO_PLIST).toContain('<key>LSBackgroundOnly</key><true/>');
    expect(installScript(args)).toContain('exec >> "$LOG" 2>&1');
    if (process.platform !== 'darwin') return;
    const dir = mkdtempSync(path.join(tmpdir(), 'fl-plist-'));
    try {
      writeFileSync(path.join(dir, 'Info.plist'), UPDATER_INFO_PLIST);
      expect(execFileSync('/usr/bin/plutil', ['-lint', path.join(dir, 'Info.plist')], { encoding: 'utf8' })).toMatch(/OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('never targets a translocated bundle', () => {
    expect(() => installScript({ ...args, app: '/private/var/folders/x/T/AppTranslocation/U/d/FriedLiver.app' })).toThrow(/translocated/);
  });
});

describe('the real app behind a translocated one', () => {
  const T = '/private/var/folders/ab/xyz/T/AppTranslocation/6F1C-UUID/d/FriedLiver.app';
  const probe = (ids: Record<string, string>, found: string[] | (() => string[])) => ({
    home: '/Users/me',
    bundleId: (app: string) => ids[app] ?? null,
    mdfind: typeof found === 'function' ? found : () => found,
  });
  it('keeps a normal running path', () => {
    expect(resolveRealApp('/Applications/FriedLiver.app', probe({}, []))).toBe('/Applications/FriedLiver.app');
  });
  it('finds it by bundle id in ~/Applications or /Applications only', () => {
    const ids = { [T]: 'dev.friedliver', '/Users/me/Applications/FriedLiver.app': 'dev.friedliver', '/Volumes/X/FriedLiver.app': 'dev.friedliver' };
    expect(resolveRealApp(T, probe(ids, ['/Volumes/X/FriedLiver.app', T, '/Users/me/Applications/FriedLiver.app']))).toBe('/Users/me/Applications/FriedLiver.app');
  });
  it('falls back to /Applications/FriedLiver.app when Spotlight has nothing or fails', () => {
    const ids = { [T]: 'dev.friedliver', '/Applications/FriedLiver.app': 'dev.friedliver' };
    expect(resolveRealApp(T, probe(ids, []))).toBe('/Applications/FriedLiver.app');
    expect(resolveRealApp(T, probe(ids, () => { throw new Error('mds off'); }))).toBe('/Applications/FriedLiver.app');
  });
  it('refuses a bundle with another id, or an unreadable running bundle', () => {
    expect(resolveRealApp(T, probe({ [T]: 'dev.friedliver', '/Applications/FriedLiver.app': 'com.other' }, ['/Applications/FriedLiver.app']))).toBeNull();
    expect(resolveRealApp(T, probe({ '/Applications/FriedLiver.app': 'dev.friedliver' }, []))).toBeNull();
  });
});

describe('surfacing results', () => {
  it('reads the last RESULT line of the install log', () => {
    expect(readInstallResult('x\nRESULT failed could not mount the DMG\n')).toEqual({ ok: false, detail: 'could not mount the DMG' });
    expect(readInstallResult('RESULT failed a\nRESULT ok 1.142.0-3\n')).toEqual({ ok: true, detail: '1.142.0-3' });
    expect(readInstallResult('started\n')).toBeNull();
  });
  it('a manual check always says something unless the offer toast does', () => {
    expect(manualCheckMessage('up-to-date', '1.142.0-2')).toBe("You're up to date: FriedLiver 1.142.0-2.");
    // A build off main names its commit; the version it compares by stays friedliverVersion.
    expect(versionLabel({ friedliverVersion: '1.142.0-7', friedliverBuild: '1.142.0-7+3.gd0cca9f1ae' }, '1.142.0')).toBe('1.142.0-7+3.gd0cca9f1ae');
    expect(versionLabel({ friedliverVersion: '1.142.0-7' }, '1.142.0')).toBe('1.142.0-7');
    expect(versionLabel({ friedliverBuild: 'x y; rm' }, '1.142.0')).toBe('1.142.0');
    expect(versionLabel({}, '1.142.0')).toBe('1.142.0');
    expect(manualCheckMessage('already-told', '1.142.0-2')).toMatch(/up to date/);
    expect(manualCheckMessage('failed', '1.142.0-2')).toMatch(/Couldn't check/);
    expect(manualCheckMessage('newer', '1.142.0-2')).toBeNull();
  });
});

describe.runIf(process.platform === 'darwin')('install script end to end (throwaway DMG, translocated running copy)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const mkApp = (at: string, version: string) => {
    mkdirSync(path.join(at, 'Contents'), { recursive: true });
    writeFileSync(path.join(at, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.friedliver.e2e</string></dict></plist>`);
    writeFileSync(path.join(at, 'Contents/VERSION'), version);
  };
  /** An installed app, its translocated running copy, a DMG with the new app (or `badDmg` bytes), and an `open` stub on PATH. */
  const fixture = (badDmg?: string) => {
    const root = mkdtempSync(path.join(tmpdir(), 'fl-e2e-'));
    roots.push(root);
    const translocated = path.join(root, 'AppTranslocation/UUID/d/FriedLiver.app');
    const real = path.join(root, 'Applications/FriedLiver.app');
    mkApp(translocated, 'old');
    mkApp(real, 'old');
    const plist = (app: string) => { try { return execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim(); } catch { return null; } };
    const app = resolveRealApp(translocated, { home: root, bundleId: (a) => (existsSync(a) ? plist(a) : null), mdfind: () => [real] });
    expect(app).toBe(real);
    const dir = path.join(root, 'update');
    mkdirSync(dir);
    const dmg = path.join(dir, 'FriedLiver.dmg');
    if (badDmg === undefined) {
      const src = path.join(root, 'src');
      mkApp(path.join(src, 'FriedLiver.app'), 'new');
      execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Test;', path.join(src, 'FriedLiver.app')]);
      execFileSync('hdiutil', ['create', '-quiet', '-fs', 'HFS+', '-srcfolder', src, '-format', 'UDZO', dmg]);
    } else {
      writeFileSync(dmg, badDmg);
    }
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'open'), `#!/bin/sh\necho "$@" >> '${root}/opened'\n`);
    chmodSync(path.join(bin, 'open'), 0o755);
    const log = path.join(root, 'friedliver-update.log');
    const script = path.join(dir, 'install.sh');
    const write = (pid: number) => writeFileSync(script, installScript({ pid, app: app!, dmg, dir, log, version: '9.9.9', page: `${RELEASES_PAGE}/tag/v9.9.9` }));
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const opened = () => (existsSync(path.join(root, 'opened')) ? readFileSync(path.join(root, 'opened'), 'utf8').trim() : '');
    const version = () => readFileSync(path.join(real, 'Contents/VERSION'), 'utf8');
    return { root, real, translocated, app: app!, dmg, dir, log, script, write, env, opened, version, readLog: () => readFileSync(log, 'utf8') };
  };

  it('runs from its own background app through LaunchServices, as updates.ts starts it', async () => {
    const f = fixture();
    const updater = path.join(f.dir, UPDATER_APP);
    mkdirSync(path.join(updater, 'Contents/MacOS'), { recursive: true });
    writeFileSync(path.join(updater, 'Contents/Info.plist'), UPDATER_INFO_PLIST);
    writeFileSync(path.join(updater, 'Contents/MacOS/install'), installScript({ pid: spawnDead(), app: f.app, dmg: f.dmg, dir: f.dir, log: f.log, version: '9.9.9', page: `${RELEASES_PAGE}/tag/v9.9.9` }), { mode: 0o700 });
    execFileSync('/usr/bin/open', ['-n', '-g', '-j', updater]);
    for (let i = 0; i < 600 && !(existsSync(f.log) && readInstallResult(f.readLog())); i++) await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 50 && existsSync(f.dir); i++) await new Promise((r) => setTimeout(r, 100));

    expect(readInstallResult(f.readLog())).toEqual({ ok: true, detail: '9.9.9' });
    expect(f.version()).toBe('new');
    expect(existsSync(f.dir)).toBe(false);
  }, 90_000);

  // The 1.142.0-8 → -9 failure was first blamed on an inherited SIG_IGN for SIGCHLD; hdiutil and diskutil both mount fine under it.
  it.each([
    ['', '/bin/sh', [] as string[]],
    [' with SIGCHLD ignored', '/usr/bin/perl', ['-e', '$SIG{CHLD} = "IGNORE"; exec @ARGV or die', '/bin/sh']],
  ])('installs into the real app, clears quarantine, relaunches it and logs success%s', async (_name, cmd, pre) => {
    const f = fixture();
    const sleeper = spawn('sleep', ['1']);
    f.write(sleeper.pid!);
    // Async so Node reaps the sleep process; a zombie would still answer kill -0.
    await promisify(execFile)(cmd, [...pre, f.script], { env: f.env, timeout: 60_000 });

    expect(f.version()).toBe('new');
    expect(readFileSync(path.join(f.translocated, 'Contents/VERSION'), 'utf8')).toBe('old');
    expect(execFileSync('/usr/bin/xattr', [f.real], { encoding: 'utf8' })).not.toContain('com.apple.quarantine');
    expect(f.opened()).toBe(`-a ${f.real}`);
    expect(readInstallResult(f.readLog())).toEqual({ ok: true, detail: '9.9.9' });
    expect(releasePageFrom(f.readLog())).toBe(`${RELEASES_PAGE}/tag/v9.9.9`);
    expect(existsSync(f.dir)).toBe(false);
  }, 90_000);

  it('a DMG that will not mount: retries once, logs the exit codes, leaves the app alone, opens nothing and cleans up', async () => {
    const f = fixture('not a disk image');
    f.write(spawnDead());
    await expect(promisify(execFile)('/bin/sh', [f.script], { env: f.env, timeout: 60_000 })).rejects.toThrow();

    const text = f.readLog();
    expect(readInstallResult(text)).toEqual({ ok: false, detail: expect.stringMatching(/^could not mount the DMG \(hdiutil exit [1-9]\d*\)$/) });
    expect(text).toMatch(/hdiutil attach exited [1-9][\s\S]*retrying the mount[\s\S]*hdiutil attach exited [1-9]/);
    expect(f.version()).toBe('old');
    expect(f.opened()).toBe('');
    expect(existsSync(f.dir)).toBe(false);
  }, 90_000);

  it('stopped mid-install (Force Quit, logout): logs why, leaves the app alone and cleans up', async () => {
    const f = fixture();
    const app = spawn('sleep', ['60']);
    f.write(app.pid!);
    const child = spawn('/bin/sh', [f.script], { env: f.env, stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    for (let i = 0; i < 100 && !(existsSync(f.log) && f.readLog().includes('started')); i++) await new Promise((r) => setTimeout(r, 50));
    child.kill('SIGTERM');
    await exited;
    app.kill();

    expect(readInstallResult(f.readLog())).toEqual({ ok: false, detail: 'stopped by a signal' });
    expect(f.version()).toBe('old');
    expect(existsSync(f.dir)).toBe(false);
  }, 30_000);
});

/** A pid that is not running (kill -0 fails), so the script skips the wait. */
function spawnDead(): number {
  const r = spawnSync('/usr/bin/true');
  return r.pid;
}
