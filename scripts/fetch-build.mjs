#!/usr/bin/env node
// Download a FriedLiver app for the workbench screenshot harness, verified: the macOS arm64 .app
// or the portable Windows x64 app (the unzipped VSCode-win32-x64 folder).
//
//   node scripts/fetch-build.mjs <ref> <out dir> [mac|windows]     (default: this machine's OS)
//
// <ref> is "latest", a release tag (v1.142.0-5), or a Build FriedLiver run id. A release
// zip is checked against the release's SHA256SUMS.txt; a run artifact against the digest
// GitHub recorded at upload, and only from a trusted run (checkRun, the same gate as
// editor-bench's patched lane). Prints the path of the unpacked .app or FriedLiver.exe. Needs `gh` (GH_TOKEN).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File, shasumFor } from './lib.mjs';

export const REPO = 'MrArun005/FriedLiver-Code';
export const ASSETS = { mac: 'friedliver-fork-macos-arm64', windows: 'friedliver-fork-windows-x64' };
const TRUSTED_BRANCH = /^(?:main|(?:perf|release|ui|design)\/[A-Za-z0-9._/-]+|v\d[A-Za-z0-9.+-]*)$/;

/** "latest" | a release tag | a run id (digits) -> { kind, ref }. The value reaches `gh`, so it is validated. */
export function parseRef(ref) {
	if (ref === 'latest') return { kind: 'release', ref: null };
	if (/^\d+$/.test(ref)) return { kind: 'run', ref };
	if (/^v\d[A-Za-z0-9.+-]*$/.test(ref)) return { kind: 'release', ref };
	throw new Error(`build must be "latest", a v* release tag or a Build FriedLiver run id, got ${JSON.stringify(ref)}`);
}

/**
 * The harness runs whatever the artifact holds, so only Build FriedLiver runs from a push or a
 * dispatch on this repository itself (never a fork), from a trusted branch or a v* tag, qualify.
 * `run` is the GET /repos/{REPO}/actions/runs/{id} payload. Throws with every problem found.
 */
export function checkRun(run) {
	const branch = run.head_branch ?? '';
	const head = run.head_repository?.full_name;
	const problems = [
		[run.repository?.full_name === REPO, `run is not in ${REPO}`],
		[run.path === '.github/workflows/build.yml', `workflow ${JSON.stringify(run.path)} is not build.yml`],
		[run.conclusion === 'success', `run conclusion ${JSON.stringify(run.conclusion)} is not success`],
		[['push', 'workflow_dispatch'].includes(run.event), `event ${JSON.stringify(run.event)} is not push/workflow_dispatch`],
		[head === REPO, `head repository ${JSON.stringify(head)} is not ${REPO} (fork runs are refused)`],
		[TRUSTED_BRANCH.test(branch) && !branch.includes('..'), `branch ${JSON.stringify(branch)} is not main, perf/*, release/*, ui/*, design/* or a v* tag`],
	].filter(([ok]) => !ok).map(([, msg]) => msg);
	if (problems.length) throw new Error('untrusted run: ' + problems.join('; '));
}

const gh = (args, opts = {}) => execFileSync('gh', args, { encoding: opts.encoding ?? 'utf8', maxBuffer: 1 << 30, ...opts });

const WIN_TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

/** Unpacks a zip: ditto on macOS (keeps the app's signature and symlinks), Windows' bsdtar elsewhere. */
function unzip(zip, dir) {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	if (process.platform === 'darwin') execFileSync('ditto', ['-x', '-k', zip, dir]);
	else execFileSync(process.platform === 'win32' ? WIN_TAR : 'unzip', process.platform === 'win32' ? ['-xf', zip, '-C', dir] : ['-q', zip, '-d', dir]);
}

/** The app inside a platform zip: the .app (macOS) or the portable folder's FriedLiver.exe (Windows). */
function unzipApp(zip, out, platform) {
	const dir = path.join(out, 'app');
	unzip(zip, dir);
	if (platform === 'windows') {
		const product = JSON.parse(fs.readFileSync(path.join(dir, 'resources', 'app', 'product.json'), 'utf8'));
		const exe = path.join(dir, `${product.nameShort}.exe`);
		if (!fs.existsSync(exe)) throw new Error(`no ${product.nameShort}.exe in ${zip}`);
		return exe;
	}
	const app = fs.readdirSync(dir).find((f) => f.endsWith('.app'));
	if (!app) throw new Error(`no .app in ${zip}`);
	return path.join(dir, app);
}

function fromRelease(tag, out, platform) {
	const ASSET = ASSETS[platform];
	const dl = path.join(out, 'release');
	fs.mkdirSync(dl, { recursive: true });
	gh(['release', 'download', ...(tag ? [tag] : []), '-R', REPO, '--clobber', '-D', dl, '-p', `${ASSET}.zip`, '-p', 'SHA256SUMS.txt']);
	const zip = path.join(dl, `${ASSET}.zip`);
	const want = shasumFor(fs.readFileSync(path.join(dl, 'SHA256SUMS.txt'), 'utf8'), `${ASSET}.zip`);
	const got = sha256File(zip);
	if (!want || want !== got) throw new Error(`${ASSET}.zip sha256 ${got} does not match SHA256SUMS.txt (${want})`);
	const name = JSON.parse(gh(['release', 'view', ...(tag ? [tag] : []), '-R', REPO, '--json', 'tagName'])).tagName;
	return { app: unzipApp(zip, out, platform), label: `release ${name}` };
}

function fromRun(id, out, platform) {
	const ASSET = ASSETS[platform];
	const run = JSON.parse(gh(['api', `repos/${REPO}/actions/runs/${id}`]));
	checkRun(run);
	const arts = JSON.parse(gh(['api', `repos/${REPO}/actions/runs/${id}/artifacts?per_page=100`])).artifacts;
	const art = arts.find((a) => a.name === ASSET);
	if (!art || art.expired || !String(art.digest ?? '').startsWith('sha256:')) throw new Error(`artifact ${ASSET} of run ${id} is missing, expired or has no digest`);
	const outer = path.join(out, 'artifact.zip');
	fs.writeFileSync(outer, gh(['api', `repos/${REPO}/actions/artifacts/${art.id}/zip`], { encoding: 'buffer' }));
	const got = sha256File(outer);
	if (got !== art.digest.slice(7)) throw new Error(`artifact digest mismatch: ${got} != ${art.digest}`);
	const inner = path.join(out, 'artifact');
	unzip(outer, inner);
	return { app: unzipApp(path.join(inner, `${ASSET}.zip`), out, platform), label: `run ${id}: ${run.head_branch}@${run.head_sha.slice(0, 10)}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [ref, out, platform = process.platform === 'win32' ? 'windows' : 'mac'] = process.argv.slice(2);
	if (!ref || !out || !ASSETS[platform]) {
		console.error('Usage: node scripts/fetch-build.mjs <latest|tag|run id> <out dir> [mac|windows]');
		process.exit(2);
	}
	fs.mkdirSync(out, { recursive: true });
	const { kind, ref: r } = parseRef(ref);
	const { app, label } = kind === 'run' ? fromRun(r, path.resolve(out), platform) : fromRelease(r, path.resolve(out), platform);
	console.error(`verified ${label}`);
	console.log(app);
}
