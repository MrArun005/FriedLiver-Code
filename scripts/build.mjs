#!/usr/bin/env node
// Build FriedLiver from the prepared upstream checkout.
//
//   node scripts/build.mjs              # dev build: npm ci + compile + Electron (run with dev.mjs)
//   node scripts/build.mjs --package    # packaged, minified app: <VSCODE_DIR>/../VSCode-<os>-<arch>
//   node scripts/build.mjs --package --installer   # also the installer, into installers/
//   options: --skip-deps (no apt-get), --reinstall (fresh npm ci), --no-compile (install only)
//
// Linux: installs the apt packages upstream's build needs if they are missing
// (uses sudo unless already root). Node: if the current Node does not satisfy
// upstream's .nvmrc, the exact version is downloaded to .cache (FRIEDLIVER_CACHE_DIR).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CACHE_DIR, VSCODE_DIR, checkSha256, codesignArgs, fail, isWindows, log, matchesIntegrity, nodeEnv, pinnedSha256, readJson, run, sha256File, vscodeSysrootAsset } from './lib.mjs';

const args = new Set(process.argv.slice(2));
const wantPackage = args.has('--package');

if (!fs.existsSync(path.join(VSCODE_DIR, 'package.json'))) {
	fail(`${VSCODE_DIR} has no package.json. Run fetch.mjs and prepare.mjs first.`);
}
if (!fs.existsSync(path.join(VSCODE_DIR, '.friedliver-prepare.json'))) {
	fail(`${VSCODE_DIR} is not prepared. Run: node scripts/prepare.mjs`);
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
//
// Both downloads are verified: the npm tarball against upstream's package-lock.json
// integrity, and the binary against its pin in scripts/checksums.json (ripgrep-prebuilt
// publishes no checksums, and @vscode/ripgrep's own download checks nothing).
function seedRipgrepCache() {
	const lock = readJson(path.join(VSCODE_DIR, 'package-lock.json'));
	const entry = lock.packages?.['node_modules/@vscode/ripgrep'];
	const pkgVersion = entry?.version;
	if (!pkgVersion) {
		return;
	}
	if (!/^\d+\.\d+\.\d+$/.test(pkgVersion)) {
		fail(`@vscode/ripgrep version ${JSON.stringify(pkgVersion)} in package-lock.json is not a plain version`);
	}
	const cache = path.join(os.tmpdir(), `vscode-ripgrep-cache-${pkgVersion}`);
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'friedliver-rg-'));
	const tgz = path.join(work, 'rg.tgz');
	run('curl', ['-fsSL', '--retry', '3', '-o', tgz, `https://registry.npmjs.org/@vscode/ripgrep/-/ripgrep-${pkgVersion}.tgz`], { cwd: work });
	if (!matchesIntegrity(tgz, entry.integrity)) {
		fs.rmSync(work, { recursive: true, force: true });
		fail(`@vscode/ripgrep ${pkgVersion} from the npm registry does not match the integrity in upstream's package-lock.json`);
	}
	log(`@vscode/ripgrep ${pkgVersion}: npm integrity verified`);
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
	const pin = pinnedSha256(asset);
	if (!pin && process.env.FRIEDLIVER_REQUIRE_PINS) {
		fail(`${asset} has no SHA-256 pin in scripts/checksums.json, and this build requires one`);
	}
	// Anyone on this machine can write to the temp folder: a file already there is used only if it matches its pin.
	if (fs.existsSync(file) && (!pin || sha256File(file) !== pin)) {
		fs.rmSync(file, { force: true });
	}
	if (!fs.existsSync(file)) {
		fs.mkdirSync(cache, { recursive: true });
		run('curl', ['-fsSL', '--retry', '3', '-o', file, `https://github.com/microsoft/ripgrep-prebuilt/releases/download/${rgVersion}/${asset}`], { cwd: cache });
	}
	if (pin) {
		checkSha256(file, pin, `ripgrep ${asset}`);
	} else {
		log(`ripgrep: ${asset} has no SHA-256 pin in scripts/checksums.json; using it unverified, as @vscode/ripgrep would. Add the pin.`);
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

/**
 * Removes what a FriedLiver user never runs, before installers and signing: source maps
 * (about 300 MB; Microsoft's release pipeline uploads them elsewhere) and the Copilot SDK
 * runtime (about 150 MB; packaged because the agent-host code imports it, but built-in AI
 * features are off and Copilot is gone, see patches 0010 and 0020).
 */
function trimPackagedApp(appDir) {
	const app = process.platform === 'darwin'
		? path.join(appDir, fs.readdirSync(appDir).find(name => name.endsWith('.app')) ?? '', 'Contents', 'Resources', 'app')
		: path.join(appDir, 'resources', 'app');
	let bytes = 0;
	const remove = target => {
		const stat = fs.statSync(target);
		bytes += stat.isDirectory()
			? fs.readdirSync(target, { recursive: true }).reduce((sum, rel) => sum + (fs.statSync(path.join(target, rel)).isFile() ? fs.statSync(path.join(target, rel)).size : 0), 0)
			: stat.size;
		fs.rmSync(target, { recursive: true, force: true });
	};
	for (const rel of fs.readdirSync(app, { recursive: true })) {
		if (rel.endsWith('.map') && fs.existsSync(path.join(app, rel))) {
			remove(path.join(app, rel));
		}
	}
	const unpackedGithub = path.join(app, 'node_modules.asar.unpacked', '@github');
	if (fs.existsSync(unpackedGithub)) {
		for (const name of fs.readdirSync(unpackedGithub).filter(n => n.startsWith('copilot-sdk'))) {
			remove(path.join(unpackedGithub, name));
		}
	}
	log(`trimmed ${Math.round(bytes / 1048576)} MB of source maps and the Copilot SDK runtime from the app`);
}

/**
 * Upstream's .deb step looks the VS Code sysroot (the toolchain it reads library
 * dependencies with) up through api.github.com too, which answers anonymous calls from
 * shared CI runners and some proxies with 403 (see seedRipgrepCache). It skips the lookup
 * when the sysroot folder already has a .stamp naming the asset, so we fetch the asset from
 * the plain release-download URL, check it against upstream's
 * build/checksums/vscode-sysroot.txt (the hash upstream itself checks) before unpacking it,
 * and point VSCODE_SYSROOT_DIR at a folder of ours instead of the shared temp folder.
 * Returns the env for the .deb steps.
 */
function seedVSCodeSysroot(arch) {
	const debArch = { x64: 'amd64', arm64: 'arm64', armhf: 'armhf' }[arch];
	const sysroot = vscodeSysrootAsset(
		fs.readFileSync(path.join(VSCODE_DIR, 'build', 'linux', 'debian', 'install-sysroot.ts'), 'utf8'),
		fs.readFileSync(path.join(VSCODE_DIR, 'build', 'checksums', 'vscode-sysroot.txt'), 'utf8'),
		debArch, process.env.VSCODE_SYSROOT_PREFIX);
	if (!sysroot) {
		log(`sysroot: no ${debArch ?? arch} asset found from upstream's install-sysroot.ts and checksums; leaving the download to upstream`);
		return env;
	}
	const dir = process.env.VSCODE_SYSROOT_DIR || path.join(CACHE_DIR, `vscode-${debArch}-sysroot`);
	const stamp = path.join(dir, '.stamp');
	if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === sysroot.asset) {
		log(`sysroot ${sysroot.asset} present: ${dir}`);
		return { ...env, VSCODE_SYSROOT_DIR: dir };
	}
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	const tgz = path.join(dir, sysroot.asset);
	run('curl', ['-fsSL', '--retry', '3', '-o', tgz, sysroot.url], { cwd: dir });
	checkSha256(tgz, sysroot.sha256, `sysroot ${sysroot.asset}`);
	run('tar', ['-xzf', tgz, '-C', dir], { cwd: dir });
	fs.rmSync(tgz, { force: true });
	fs.writeFileSync(stamp, sysroot.asset);
	log(`sysroot seeded: ${dir}`);
	return { ...env, VSCODE_SYSROOT_DIR: dir };
}

/**
 * Before the app is signed: the usage descriptions macOS shows when the composer's mic first asks
 * for the microphone and speech recognition (Electron's Info.plist has no speech one), and the
 * dictation helper (extensions/friedliver-agents/native/build.sh, built by CI) executable and
 * signed first, so the app's signature seals it. Without the helper the mic shows the Fn Fn hint.
 */
function finishMacApp(appPath, signing) {
	const plist = path.join(appPath, 'Contents', 'Info.plist');
	for (const [key, text] of [
		['NSMicrophoneUsageDescription', 'FriedLiver listens while you dictate a message with the mic button.'],
		['NSSpeechRecognitionUsageDescription', 'FriedLiver turns what you say into text when you dictate a message.'],
	]) {
		run('plutil', ['-replace', key, '-string', text, plist]);
	}
	const helper = path.join(appPath, 'Contents', 'Resources', 'app', 'extensions', 'friedliver-agents', 'bin', 'friedliver-dictate');
	if (fs.existsSync(helper)) {
		fs.chmodSync(helper, 0o755);
		run('codesign', codesignArgs(helper, { ...signing, identifier: 'com.friedliver.dictate' }));
		log('dictation helper signed');
	} else {
		log('no dictation helper in the app (native/build.sh not run): the mic falls back to the Fn Fn hint');
	}
}

/**
 * The installer for this OS, into installers/: a per-user setup .exe on Windows (no admin
 * rights needed), a .dmg on macOS, a .deb on Linux. Unsigned: signing needs certificates.
 */
function buildInstaller(arch, appDir) {
	const version = readJson(path.join(VSCODE_DIR, 'package.json')).version;
	const dest = path.join(path.dirname(fs.realpathSync(VSCODE_DIR)), 'installers');
	fs.mkdirSync(dest, { recursive: true });
	let file;
	if (process.platform === 'win32') {
		run('npm', ['run', 'gulp', '--', `vscode-win32-${arch}-inno-updater`], { env });
		run('npm', ['run', 'gulp', '--', `vscode-win32-${arch}-user-setup`], { env });
		file = path.join(dest, `FriedLiverUserSetup-${arch}-${version}.exe`);
		fs.copyFileSync(path.join(VSCODE_DIR, '.build', `win32-${arch}`, 'user-setup', 'VSCodeSetup.exe'), file);
	} else if (process.platform === 'darwin') {
		const app = fs.readdirSync(appDir).find(name => name.endsWith('.app'));
		if (!app) {
			fail(`no .app in ${appDir}`);
		}
		// MACOS_SIGN_IDENTITY / MACOS_SIGN_KEYCHAIN come from build.yml's signing keychain; without them
		// (forks, local builds) ad-hoc, the minimum Apple silicon runs. Not notarized either way.
		const signing = { identity: process.env.MACOS_SIGN_IDENTITY ?? '', keychain: process.env.MACOS_SIGN_KEYCHAIN ?? '' };
		log(signing.identity ? 'signing with the certificate from the signing keychain' : 'no signing identity: ad-hoc signature');
		finishMacApp(path.join(appDir, app), signing);
		run('codesign', codesignArgs(path.join(appDir, app), { ...signing, deep: true }), { cwd: appDir });
		file = path.join(dest, `FriedLiver-darwin-${arch}-${version}.dmg`);
		run('hdiutil', ['create', '-volname', 'FriedLiver', '-srcfolder', path.join(appDir, app), '-ov', '-format', 'UDZO', file], { cwd: appDir });
	} else if (process.platform === 'linux') {
		const debEnv = seedVSCodeSysroot(arch);
		run('npm', ['run', 'gulp', '--', `vscode-linux-${arch}-prepare-deb`], { env: debEnv });
		run('npm', ['run', 'gulp', '--', `vscode-linux-${arch}-build-deb`], { env: debEnv });
		const debDir = fs.readdirSync(path.join(VSCODE_DIR, '.build', 'linux', 'deb'))
			.map(d => path.join(VSCODE_DIR, '.build', 'linux', 'deb', d, 'deb'))
			.find(d => fs.existsSync(d));
		const deb = debDir && fs.readdirSync(debDir).find(name => name.endsWith('.deb'));
		if (!deb) {
			fail('the .deb was not produced');
		}
		file = path.join(dest, deb);
		fs.copyFileSync(path.join(debDir, deb), file);
	} else {
		fail(`no installer for ${process.platform}`);
	}
	log(`installer: ${file}`);
}

const started = Date.now();
if (wantPackage) {
	const arch = process.arch === 'arm' ? 'armhf' : process.arch;
	const task = `vscode-${process.platform}-${arch}-min`;
	run('npm', ['run', 'gulp', '--', task], { env });
	const out = path.join(path.dirname(fs.realpathSync(VSCODE_DIR)), `VSCode-${process.platform}-${arch}`);
	log(`packaged app: ${out} (${Math.round((Date.now() - started) / 60000)} min)`);
	trimPackagedApp(out);
	if (args.has('--installer')) {
		buildInstaller(arch, out);
	}
} else {
	run('npm', ['run', 'compile'], { env });
	run('npm', ['run', 'electron'], { env });
	run('node', ['build/lib/preLaunch.ts'], { env });
	log(`dev build ready (${Math.round((Date.now() - started) / 60000)} min). Run: node scripts/dev.mjs`);
}
