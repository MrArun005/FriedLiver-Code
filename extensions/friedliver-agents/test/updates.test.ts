import { describe, expect, it } from 'vitest';
import {
  CHECK_EVERY_MS,
  LAST_CHECK_KEY,
  RELEASES_API,
  RELEASES_PAGE,
  RETRY_AFTER_MS,
  checkForUpdate,
  compareVersions,
  parseRelease,
  type Release,
} from '../src/host/updateCheck';

function memory(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      data.set(key, value);
    },
  };
}

function respond(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, req?: RequestInit) => {
    calls.push({ url, init: req });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: init.status ?? 200, headers: init.headers });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const release = (tag: string, over: Record<string, unknown> = {}) => ({ tag_name: tag, html_url: `${RELEASES_PAGE}/tag/${tag}`, draft: false, prerelease: false, ...over });

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
    expect(parseRelease(release('v1.143.0'))).toEqual({ version: '1.143.0', url: `${RELEASES_PAGE}/tag/v1.143.0` });
    expect(parseRelease(release('v1.143.0', { html_url: 'https://evil.example/download' }))).toEqual({ version: '1.143.0', url: RELEASES_PAGE });
    expect(parseRelease(release('v1.143.0', { prerelease: true }))).toBeNull();
    expect(parseRelease(release('v1.143.0', { draft: true }))).toBeNull();
    expect(parseRelease(release('[x](command:evil)'))).toBeNull();
    expect(parseRelease(null)).toBeNull();
  });
});

describe('the weekly check', () => {
  const now = 1_800_000_000_000;

  it('tells once about a newer release, with an anonymous request to the releases API', async () => {
    const state = memory();
    const { calls, fetchFn } = respond(release('v1.143.0'));
    const told: Release[] = [];
    const deps = { current: '1.142.0', fetch: fetchFn, state, now: () => now, notify: (r: Release) => told.push(r) };
    expect(await checkForUpdate(deps)).toBe('newer');
    expect(told).toEqual([{ version: '1.143.0', url: `${RELEASES_PAGE}/tag/v1.143.0` }]);
    expect(calls[0].url).toBe(RELEASES_API);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(Object.keys(headers).map((h) => h.toLowerCase()).sort()).toEqual(['accept', 'user-agent', 'x-github-api-version']);
    expect(state.get(LAST_CHECK_KEY)).toBe(now);

    // Within the week nothing is asked; a week later the same release isn't announced again.
    expect(await checkForUpdate({ ...deps, now: () => now + 1000 })).toBe('not-due');
    expect(await checkForUpdate({ ...deps, now: () => now + CHECK_EVERY_MS })).toBe('already-told');
    expect(told).toHaveLength(1);
  });

  it('stays quiet when this build is current or newer', async () => {
    for (const current of ['1.143.0', '1.143.0-1']) {
      const told: Release[] = [];
      const result = await checkForUpdate({ current, fetch: respond(release('v1.143.0')).fetchFn, state: memory(), now: () => now, notify: (r) => told.push(r) });
      expect(result).toBe('up-to-date');
      expect(told).toEqual([]);
    }
  });

  it('fails silently and tries again a day later', async () => {
    const failing = [
      (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
      respond({ message: 'rate limited' }, { status: 403 }).fetchFn,
      respond('not json').fetchFn,
      respond('x', { headers: { 'content-length': String(5 * 1024 * 1024) } }).fetchFn,
    ];
    for (const fetchFn of failing) {
      const state = memory();
      const told: Release[] = [];
      const logged: string[] = [];
      const result = await checkForUpdate({ current: '1.142.0', fetch: fetchFn, state, now: () => now, notify: (r) => told.push(r), log: (l) => logged.push(l) });
      expect(result).toBe('failed');
      expect(told).toEqual([]);
      expect(logged[0]).toMatch(/^Update check failed/);
      const last = state.get<number>(LAST_CHECK_KEY)!;
      expect(now - last).toBe(CHECK_EVERY_MS - RETRY_AFTER_MS);
    }
  });
});
