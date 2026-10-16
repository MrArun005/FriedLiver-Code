// The weekly "is a newer FriedLiver out?" check, without the editor (see updates.ts for that part).
// One anonymous GET to GitHub's public API; nothing about the user or the machine is sent.

export const RELEASES_API = 'https://api.github.com/repos/MrArun005/FriedLiver-Code/releases/latest';
export const RELEASES_PAGE = 'https://github.com/MrArun005/FriedLiver-Code/releases';
export const CHECK_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
/** After a failed check (offline, rate-limited), try again a day later rather than a week. */
export const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Release versions: the upstream VS Code version, then optionally FriedLiver's own build number: 1.142.0 or v1.142.0-2. */
const VERSION = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-(\d{1,6}))?$/;

export function parseVersion(text: unknown): number[] | null {
  const m = typeof text === 'string' ? VERSION.exec(text.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0)] : null;
}

/** Negative when a is older than b, 0 when equal, positive when newer; null when either isn't a version. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export interface Release {
  /** Without the leading v. */
  version: string;
  /** The release's page on GitHub, where the installers are. */
  url: string;
}

/** A published release from the API's JSON, or null. Drafts and pre-releases don't count; links only go to this repo's releases. */
export function parseRelease(json: unknown): Release | null {
  if (typeof json !== 'object' || json === null) return null;
  const r = json as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true || typeof r.tag_name !== 'string' || !parseVersion(r.tag_name)) return null;
  const url = typeof r.html_url === 'string' && r.html_url.startsWith(`${RELEASES_PAGE}/`) && !/[\s"'<>]/.test(r.html_url) ? r.html_url : RELEASES_PAGE;
  return { version: r.tag_name.trim().replace(/^v/, ''), url };
}

export async function fetchLatestRelease(fetchFn: typeof fetch): Promise<Release | null> {
  const res = await fetchFn(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'FriedLiver-update-check', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES) throw new Error('Response too large');
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('Response too large');
  return parseRelease(JSON.parse(text));
}

export interface UpdateState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export const LAST_CHECK_KEY = 'friedliver.updates.lastCheck';
export const NOTIFIED_KEY = 'friedliver.updates.notified';

export interface CheckDeps {
  /** This build's version (product.json's friedliverVersion, else the editor's). */
  current: string;
  fetch: typeof fetch;
  state: UpdateState;
  now(): number;
  notify(release: Release): void;
  log?(line: string): void;
}

export type CheckResult = 'not-due' | 'newer' | 'up-to-date' | 'already-told' | 'failed';

/** Checks at most once a week. Fails silently: a missed check is retried a day later. */
export async function checkForUpdate(deps: CheckDeps): Promise<CheckResult> {
  const now = deps.now();
  const last = deps.state.get<number>(LAST_CHECK_KEY);
  if (typeof last === 'number' && now - last < CHECK_EVERY_MS && now >= last) return 'not-due';
  let release: Release | null;
  try {
    release = await fetchLatestRelease(deps.fetch);
  } catch (err) {
    deps.log?.(`Update check failed: ${err instanceof Error ? err.message : String(err)}`);
    await deps.state.update(LAST_CHECK_KEY, now - CHECK_EVERY_MS + RETRY_AFTER_MS);
    return 'failed';
  }
  await deps.state.update(LAST_CHECK_KEY, now);
  if (!release) return 'failed';
  const order = compareVersions(release.version, deps.current);
  if (order === null || order <= 0) return 'up-to-date';
  if (deps.state.get<string>(NOTIFIED_KEY) === release.version) return 'already-told';
  await deps.state.update(NOTIFIED_KEY, release.version);
  deps.notify(release);
  return 'newer';
}
