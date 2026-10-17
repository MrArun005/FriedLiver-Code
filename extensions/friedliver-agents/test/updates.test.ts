import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  installScript,
  isAllowedDownload,
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
  it('waits for the app, swaps the bundle from the DMG, and reopens it', () => {
    const script = installScript({ pid: 4242, app: '/Applications/FriedLiver.app', dmg: "/tmp/fl-x/it's.dmg", dir: '/tmp/fl-x' });
    expect(script).toMatchSnapshot();
    expect(script).toContain(`DMG='/tmp/fl-x/it'\\''s.dmg'`);
  });
});
