#!/usr/bin/env node
// Build FriedLiver from the prepared upstream checkout.
//
//   node code/scripts/build.mjs              # dev build: npm ci + compile + Electron (run with dev.mjs)
//   node code/scripts/build.mjs --package    # packaged, minified app: <VSCODE_DIR>/../VSCode-<os>-<arch>
//   options: --skip-deps (no apt-get), --reinstall (fresh npm ci), --no-compile (install only)
//
// Linux: installs the apt packages upstream's build needs if they are missing
// (uses sudo unless already root). Node: if the current Node does not satisfy
// upstream's .nvmrc, the exact version is downloaded to code/.cache (FRIEDLIVER_CACHE_DIR).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VSCODE_DIR, fail, isWindows, log, nodeEnv, readJson, run } from './lib.mjs';

const args = new Set(process.argv.slice(2));
const wantPackage = args.has('--package');

if (!fs.existsSync(path.join(VSCODE_DIR, 'package.json'))) {
	fail(`${VSCODE_DIR} has no package.json. Run fetch.mjs and prepare.mjs first.`);
}
if (!fs.existsSync(path.join(VSCODE_DIR, '.friedliver-prepare.json'))) {
	fail(`${VSCODE_DIR} is not prepared. Run: node code/scripts/prepare.mjs`);
}

// Linux build dependencies, from upstream's "How to Contribute" wiki plus
// fakeroot/rpm/dpkg for the .deb and .rpm packaging tasks.
const LINUX_PACKAGES = [
	'build-essential', 'g++', 'make', 'pkg-config', 'python-is-python3',
	'libx11-dev', 'libxkbfile-dev', 'libsecret-1-dev', 'libkrb5-dev',
	'fakeroot', 'rpm', 'dpkg',
];

function ensureLinuxPackages() {
	if (process.platform !== 'linux' || args.has('--skip-deps')) {
		return;
	}
	const hasApt = run('sh', ['-c', 'command -v apt-get'], { capture: true, allowFail: true }).status === 0;
	if (!hasApt) {
		log(`No apt-get. Install the equivalents of: ${LINUX_PACKAGES.join(' ')}`);
		return;
	}
	const missing = LINUX_PACKAGES.filter(pkg =>
		run('dpkg-query', ['-W', '-f=${Status}', pkg], { capture: true, allowFail: true }).stdout?.includes('install ok installed') !== true);
	if (missing.length === 0) {
		log('apt build dependencies present');
		return;
	}
	const sudo = process.getuid && process.getuid() === 0 ? [] : ['sudo'];
	const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
	const aptGet = (...a) => sudo.length ? run('sudo', ['apt-get', ...a], { cwd: undefined, env }) : run('apt-get', a, { cwd: undefined, env });
	log(`installing apt packages: ${missing.join(' ')}`);
	aptGet('update', '-q');
	aptGet('install', '-y', '-q', '--no-install-recommends', ...missing);
}

ensureLinuxPackages();

const { env, version } = nodeEnv();
log(`using Node ${version}`);
// Native modules are compiled against Electron's headers (upstream .npmrc); keep builds parallel.
env.npm_config_jobs = env.npm_config_jobs || String(os.cpus().length);

// @vscode/ripgrep's postinstall looks its binary up through api.github.com, which
// rate-limits anonymous calls (and is blocked behind some proxies, token or not). It
// skips the API when the asset is already in $TMPDIR/vscode-ripgrep-cache-<pkg version>/,
// so we put it there from the plain release-download URL first.
function seedRipgrepCache() {
	const lock = readJson(path.join(VSCODE_DIR, 'package-lock.json'));
	const pkgVersion = lock.packages?.['node_modules/@vscode/ripgrep']?.version;
	if (!pkgVersion) {
		return;
	}
	const cache = path.join(os.tmpdir(), `vscode-ripgrep-cache-${pkgVersion}`);
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'friedliver-rg-'));
	run('curl', ['-fsSL', '-o', path.join(work, 'rg.tgz'), `https://registry.npmjs.org/@vscode/ripgrep/-/ripgrep-${pkgVersion}.tgz`], { cwd: work });
	run('tar', ['-xzf', 'rg.tgz'], { cwd: work });
	const postinstall = fs.readFileSync(path.join(work, 'package', 'lib', 'postinstall.js'), 'utf8');
	fs.rmSync(work, { recursive: true, force: true });
	const rgVersion = /const VERSION = '([^']+)'/.exec(postinstall)?.[1];
	const target = {
		'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
		'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
		'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
	}[`${process.platform}-${process.arch}`];
	if (!rgVersion || !target) {
		log('ripgrep: unknown version or target, leaving the download to @vscode/ripgrep');
		return;
	}
	const asset = `ripgrep-${rgVersion}-${target}${isWindows ? '.zip' : '.tar.gz'}`;
	const file = path.join(cache, asset);
	if (!fs.existsSync(file)) {
		fs.mkdirSync(cache, { recursive: true });
		run('curl', ['-fsSL', '--retry', '3', '-o', file, `https://github.com/microsoft/ripgrep-prebuilt/releases/download/${rgVersion}/${asset}`], { cwd: cache });
	}
	log(`ripgrep cache seeded: ${file}`);
}

// Upstream's postinstall writes this file only after every install step succeeded.
// Its sub-installs (about 100 folders, in parallel) sometimes die on a network reset;
// when the root install finished, retrying the postinstall is much cheaper than npm ci.
const stateFile = path.join(VSCODE_DIR, 'node_modules', '.postinstall-state');
const rootInstalled = fs.existsSync(path.join(VSCODE_DIR, 'node_modules', '.package-lock.json'));
if (!fs.existsSync(stateFile) || args.has('--reinstall')) {
	seedRipgrepCache();
	const started = Date.now();
	let ok = false;
	if (rootInstalled && !args.has('--reinstall')) {
		log('root node_modules present but postinstall unfinished; retrying postinstall');
	} else {
		ok = run('npm', ['ci', '--no-audit', '--no-fund'], { env, allowFail: true }).status === 0;
	}
	for (let attempt = 1; !ok && attempt <= 2; attempt++) {
		if (!fs.existsSync(path.join(VSCODE_DIR, 'node_modules', '.package-lock.json'))) {
			break;
		}
		log(`postinstall attempt ${attempt}`);
		ok = run('npm', ['run', 'postinstall'], { env, allowFail: true }).status === 0;
	}
	if (!ok) {
		fail('npm install failed; see the npm errors above');
	}
	log(`npm install took ${Math.round((Date.now() - started) / 60000)} min`);
} else {
	log('node_modules complete; skipping npm ci (use --reinstall to force)');
}

if (args.has('--no-compile')) {
	process.exit(0);
}

const started = Date.now();
if (wantPackage) {
	const arch = process.arch === 'arm' ? 'armhf' : process.arch;
	const task = `vscode-${process.platform}-${arch}-min`;
	run('npm', ['run', 'gulp', '--', task], { env });
	const out = path.join(path.dirname(fs.realpathSync(VSCODE_DIR)), `VSCode-${process.platform}-${arch}`);
	log(`packaged app: ${out} (${Math.round((Date.now() - started) / 60000)} min)`);
} else {
	run('npm', ['run', 'compile'], { env });
	run('npm', ['run', 'electron'], { env });
	run('node', ['build/lib/preLaunch.ts'], { env });
	log(`dev build ready (${Math.round((Date.now() - started) / 60000)} min). Run: node code/scripts/dev.mjs`);
}
