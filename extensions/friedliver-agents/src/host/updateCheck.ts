// The "is a newer FriedLiver out?" check and the macOS self-install, without the editor (see updates.ts for that part).
// One anonymous GET to GitHub's public API per check; nothing about the user or the machine is sent.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { once } from 'node:events';

const REPO = 'MrArun005/FriedLiver-Code';
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
/** Written by the release job in .github/workflows/build.yml. */
export const SUMS_ASSET = 'SHA256SUMS.txt';
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;

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

/**
 * Downloads come only over https from this repo's release downloads, or the hosts GitHub
 * redirects those to. Every redirect hop is checked against this too.
 */
export function isAllowedDownload(text: string): boolean {
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  if (u.hostname === 'github.com') return u.pathname.startsWith(`/${REPO}/releases/download/`);
  return u.hostname === 'objects.githubusercontent.com' || u.hostname === 'release-assets.githubusercontent.com';
}

export interface Asset {
  name: string;
  size: number;
  url: string;
}

export interface Release {
  /** Without the leading v. */
  version: string;
  /** The release's page on GitHub, where the installers are. */
  url: string;
  /** Only assets whose download URL passes isAllowedDownload. */
  assets: Asset[];
}

/** A published release from the API's JSON, or null. Drafts and pre-releases don't count; links only go to this repo's releases. */
export function parseRelease(json: unknown): Release | null {
  if (typeof json !== 'object' || json === null) return null;
  const r = json as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true || typeof r.tag_name !== 'string' || !parseVersion(r.tag_name)) return null;
  const url = typeof r.html_url === 'string' && r.html_url.startsWith(`${RELEASES_PAGE}/`) && !/[\s"'<>]/.test(r.html_url) ? r.html_url : RELEASES_PAGE;
  const assets: Asset[] = [];
  for (const a of Array.isArray(r.assets) ? (r.assets as Record<string, unknown>[]) : []) {
    if (typeof a?.name !== 'string' || typeof a.browser_download_url !== 'string' || !Number.isSafeInteger(a.size) || (a.size as number) <= 0) continue;
    if (isAllowedDownload(a.browser_download_url)) assets.push({ name: a.name, size: a.size as number, url: a.browser_download_url });
  }
  return { version: r.tag_name.trim().replace(/^v/, ''), url, assets };
}

/** The installer this machine can install itself: the arm64 DMG on Apple silicon. Elsewhere null (people get the release page). */
export function pickInstaller(release: Release, platform: string, arch: string): Asset | null {
  if (platform !== 'darwin' || arch !== 'arm64') return null;
  return release.assets.find((a) => a.name.startsWith('FriedLiver-darwin-arm64-') && a.name.endsWith('.dmg')) ?? null;
}

/** /X/FriedLiver.app from vscode.env.appRoot (/X/FriedLiver.app/Contents/Resources/app), else null. */
export function appBundleFor(appRoot: string): string | null {
  const m = /^(\/.+\.app)\/Contents\/Resources\/app\/?$/.exec(appRoot);
  return m ? m[1] : null;
}

/** The SHA-256 for `name` in a sha256sum listing, lower-case hex, or null. */
export function sumFor(sums: string, name: string): string | null {
  for (const line of sums.split('\n')) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+?)\r?$/.exec(line);
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return null;
}

/** GET with redirects followed by hand, so every hop is held to the allowlist. */
async function getAllowed(fetchFn: typeof fetch, url: string, timeoutMs?: number): Promise<Response> {
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedDownload(url)) throw new Error(`Download URL not allowed: ${url}`);
    const res = await fetchFn(url, { redirect: 'manual', headers: { 'User-Agent': 'FriedLiver-update' }, signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url).toString();
      continue;
    }
    if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`);
    return res;
  }
  throw new Error('Too many redirects');
}

/** The small checksum listing from a release. */
export async function fetchSums(fetchFn: typeof fetch, release: Release): Promise<string> {
  const asset = release.assets.find((a) => a.name === SUMS_ASSET || a.name === 'SHA256SUMS');
  if (!asset || asset.size > MAX_RESPONSE_BYTES) throw new Error(`The release has no ${SUMS_ASSET}`);
  const text = await (await getAllowed(fetchFn, asset.url, TIMEOUT_MS)).text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('Checksum file too large');
  return text;
}

/**
 * Streams url to dest, checking size and SHA-256 as it goes. On any mismatch the file is
 * deleted and this throws; on success dest holds exactly the expected bytes.
 */
export async function downloadVerified(
  fetchFn: typeof fetch,
  url: string,
  dest: string,
  expected: { size: number; sha256: string },
  progress?: (bytes: number) => void,
): Promise<void> {
  const out = createWriteStream(dest, { mode: 0o600, flags: 'wx' });
  // Opened before anything can fail, so a cleanup rm can't race the open and leave a file behind.
  await once(out, 'open');
  const done = new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  try {
    const res = await getAllowed(fetchFn, url);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > expected.size) throw new Error('Download is larger than the release says (size mismatch)');
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, 'drain');
      progress?.(bytes);
    }
    out.end();
    await done;
    if (bytes !== expected.size) throw new Error(`Download size mismatch: ${bytes} of ${expected.size} bytes`);
    if (hash.digest('hex') !== expected.sha256.toLowerCase()) throw new Error('Checksum mismatch: the download does not match SHA256SUMS');
  } catch (err) {
    out.destroy();
    await rm(dest, { force: true });
    throw err;
  }
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

export interface CheckDeps {
  /** This build's version (product.json's friedliverVersion, else the editor's). */
  current: string;
  fetch: typeof fetch;
  /** Versions already offered this session; each is offered once per launch, whatever the answer. */
  offered: Set<string>;
  notify(release: Release): void;
  log?(line: string): void;
}

export type CheckResult = 'newer' | 'up-to-date' | 'already-told' | 'failed';

/** Fails silently; the caller's next tick is the retry. */
export async function checkForUpdate(deps: CheckDeps): Promise<CheckResult> {
  let release: Release | null;
  try {
    release = await fetchLatestRelease(deps.fetch);
  } catch (err) {
    deps.log?.(`Update check failed: ${err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  }
  if (!release) {
    deps.log?.('Update check: no usable release');
    return 'failed';
  }
  const order = compareVersions(release.version, deps.current);
  const decision: CheckResult = order === null || order <= 0 ? 'up-to-date' : deps.offered.has(release.version) ? 'already-told' : 'newer';
  deps.log?.(`Update check: current ${deps.current}, latest ${release.version}: ${decision}`);
  if (decision !== 'newer') return decision;
  deps.offered.add(release.version);
  deps.notify(release);
  return 'newer';
}

/**
 * The version as Show Version and "You're up to date" say it: product.json's friedliverBuild when there is
 * one (a build off a tag's commit names it, e.g. "1.142.0-7+3.gd0cca9f1ae"), else friedliverVersion, else
 * `fallback`. Only for showing: comparisons read friedliverVersion alone (parseVersion, compareVersions).
 */
export function versionLabel(product: { friedliverVersion?: unknown; friedliverBuild?: unknown }, fallback: string): string {
  const build = product.friedliverBuild;
  if (typeof build === 'string' && /^[\w.+-]{1,80}$/.test(build)) return build;
  return typeof product.friedliverVersion === 'string' ? product.friedliverVersion : fallback;
}

/** What a manual "Check for Updates" says; null when the toast offering the update says it instead. */
export function manualCheckMessage(result: CheckResult, current: string): string | null {
  if (result === 'newer') return null;
  if (result === 'failed') return `Couldn't check for updates (FriedLiver ${current}). See the FriedLiver Updates output.`;
  return `You're up to date: FriedLiver ${current}.`;
}

export interface BundleProbe {
  /** CFBundleIdentifier from <app>/Contents/Info.plist, or null when unreadable. */
  bundleId(app: string): string | null;
  /** Spotlight's .app paths for a bundle id. */
  mdfind(id: string): string[];
  home: string;
}

/**
 * The .app to install over. macOS runs a quarantined app from a read-only randomized copy
 * (App Translocation: /private/var/folders/…/AppTranslocation/<uuid>/d/X.app); writing there
 * does nothing. Then the real bundle is found by bundle id in /Applications or ~/Applications,
 * else /Applications/FriedLiver.app; it must carry the same bundle id. Null when none does.
 */
export function resolveRealApp(running: string, probe: BundleProbe): string | null {
  if (!running.includes('/AppTranslocation/')) return running;
  const id = probe.bundleId(running);
  if (!id) return null;
  const roots = ['/Applications/', `${probe.home.replace(/\/$/, '')}/Applications/`];
  let found: string[] = [];
  try {
    found = probe.mdfind(id);
  } catch {
    // Spotlight off or failing: fall back to the default location.
  }
  const candidates = [...found.filter((p) => p.endsWith('.app') && roots.some((r) => p.startsWith(r))), '/Applications/FriedLiver.app'];
  return candidates.find((p) => !p.includes('/AppTranslocation/') && probe.bundleId(p) === id) ?? null;
}

/** The outcome the install script left in its log: its last RESULT line, or null when there is none. */
export function readInstallResult(log: string): { ok: boolean; detail: string } | null {
  const lines = log.split('\n').filter((l) => l.startsWith('RESULT '));
  const m = /^RESULT (ok|failed) ?(.*)$/.exec(lines.at(-1) ?? '');
  return m ? { ok: m[1] === 'ok', detail: m[2] } : null;
}

/** The release page the install log names on its `PAGE` line (for "Download manually"); this repo's releases otherwise. */
export function releasePageFrom(log: string): string {
  const m = /^PAGE (\S+)$/m.exec(log);
  return m && m[1].startsWith(`${RELEASES_PAGE}/`) && !/["'<>]/.test(m[1]) ? m[1] : RELEASES_PAGE;
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The install script runs as this background-only app: <dir>/FriedLiver Update.app/Contents/MacOS/install. */
export const UPDATER_APP = 'FriedLiver Update.app';

/**
 * Info.plist for UPDATER_APP, which `open -n -g -j` starts through LaunchServices. A child the
 * app spawns (even detached) still counts as part of the app: its Dock icon stays "running"
 * after the window closes, and Force Quit on it kills the child mid-install. That's how
 * 1.142.0-8 → -9 died on 2026-10-19: the Dock force-quit FriedLiver at 10:09:10 while hdiutil
 * was checksumming ("canceling…", "attach failed - No child processes") and took the script
 * down before it could log a RESULT. Launched as its own app, the installer is in its own
 * coalition: the Dock icon goes as soon as the app exits, and nothing aimed at FriedLiver reaches it.
 */
export const UPDATER_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.friedliver.update</string>
  <key>CFBundleName</key><string>FriedLiver Update</string>
  <key>CFBundleExecutable</key><string>install</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSBackgroundOnly</key><true/>
</dict>
</plist>
`;

/**
 * The script that installs a verified DMG after the app quits: wait for the app's process,
 * mount the image read-only at a mountpoint inside its own folder (never /Volumes/<name>),
 * copy the new .app next to the old one, swap them (putting the old one back if the swap
 * fails), clear quarantine on the new bundle (it's checksum-verified, and a quarantined app
 * would launch translocated again), reopen by path with `open -a`. Whatever happens, on exit
 * it detaches the image and removes its folder; on failure the current app is untouched.
 * Every step goes to LOG, which outlives the folder: a `PAGE <release page>` line, exit codes
 * of the mount, and last `RESULT ok <version>` or `RESULT failed <reason>`.
 */
export function installScript(p: { pid: number; app: string; dmg: string; dir: string; log: string; version: string; page: string }): string {
  if (!Number.isSafeInteger(p.pid) || p.pid <= 1) throw new Error('bad pid');
  if (p.app.includes('/AppTranslocation/')) throw new Error('refusing to install into a translocated app');
  return `#!/bin/sh
# FriedLiver update: written by the Agents extension, runs once as its own app, removes its folder.
set -u
PID=${p.pid}
APP=${sq(p.app)}
DMG=${sq(p.dmg)}
DIR=${sq(p.dir)}
LOG=${sq(p.log)}
VERSION=${sq(p.version)}
PAGE=${sq(releasePageFrom(`PAGE ${p.page}`))}
MNT="$DIR/mnt"
RC=0
say() { echo "$(date '+%Y-%m-%dT%H:%M:%S') $*" >> "$LOG"; }
fail() { say "$1"; echo "RESULT failed $1" >> "$LOG"; exit 1; }
cleanup() {
  hdiutil detach "$MNT" -quiet 2>/dev/null || hdiutil detach "$MNT" -force -quiet 2>/dev/null
  # An empty mountpoint is not mounted; never rm -rf into a mounted image.
  if [ -n "$(ls -A "$MNT" 2>/dev/null)" ]; then say "$MNT is still mounted; leaving $DIR"; else rm -rf "$DIR"; fi
}
trap cleanup EXIT
trap 'fail "stopped by a signal"' HUP INT TERM
: > "$LOG"
exec >> "$LOG" 2>&1 # Stray errors too (LaunchServices sends stdout and stderr nowhere).
echo "PAGE $PAGE"
say "install script started: $VERSION into $APP (waiting for pid $PID)"
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 300 ] && fail "the app did not quit within 300 s"
  sleep 1
done
say "the app quit after $i s; mounting the update"
mkdir -p "$MNT"
# No checksum pass: the extension already checked the DMG's SHA-256 against SHA256SUMS.
# diskutil image (macOS 14+) first; where it's missing or fails, hdiutil.
attach() {
  diskutil image attach --readOnly --nobrowse --mountPoint "$MNT" "$DMG" >> "$LOG" 2>&1 && return 0
  say "diskutil image attach exited $?; trying hdiutil"
  hdiutil attach -nobrowse -readonly -noautoopen -noverify -mountpoint "$MNT" "$DMG" >> "$LOG" 2>&1
  RC=$?
  say "hdiutil attach exited $RC"
  return $RC
}
attach || { sleep 2; say "retrying the mount"; attach; } || fail "could not mount the DMG (hdiutil exit $RC)"
SRC=$(ls -d "$MNT"/*.app 2>/dev/null | head -n 1)
say "copying \${SRC:-<no .app in the DMG>}"
OK=0
if [ -n "$SRC" ] && rm -rf "$APP.new" && ditto "$SRC" "$APP.new" >> "$LOG" 2>&1; then
  rm -rf "$APP.old"
  if mv "$APP" "$APP.old"; then
    if mv "$APP.new" "$APP"; then OK=1; rm -rf "$APP.old"; else mv "$APP.old" "$APP"; fi
  fi
fi
rm -rf "$APP.new"
hdiutil detach "$MNT" -quiet || hdiutil detach "$MNT" -force -quiet
[ "$OK" = 1 ] || fail "could not replace $APP"
xattr -dr com.apple.quarantine "$APP" >> "$LOG" 2>&1 || say "could not clear quarantine (continuing)"
say "installed; relaunching $APP"
echo "RESULT ok $VERSION" >> "$LOG"
open -a "$APP"
`;
}
