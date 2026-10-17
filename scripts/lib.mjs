// Shared helpers for the FriedLiver fork scripts (fetch, prepare, build, dev).
// Plain Node, no dependencies, so the scripts run on Linux, macOS and Windows.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
/** The repository root: upstream.json, product.json, patches/, branding/, extensions/. */
export const ROOT_DIR = path.dirname(SCRIPTS_DIR);

/** Upstream checkout. Override with VSCODE_DIR; default is vscode/ in this repo. */
export const VSCODE_DIR = path.resolve(process.env.VSCODE_DIR || path.join(ROOT_DIR, 'vscode'));

/** FriedLiver built-in extensions. Override with FRIEDLIVER_EXTENSIONS_DIR; default is extensions/. */
export const EXTENSIONS_DIR = path.resolve(process.env.FRIEDLIVER_EXTENSIONS_DIR || path.join(ROOT_DIR, 'extensions'));

/** Downloads (Node toolchain). Override with FRIEDLIVER_CACHE_DIR; default is .cache/. */
export const CACHE_DIR = path.resolve(process.env.FRIEDLIVER_CACHE_DIR || path.join(ROOT_DIR, '.cache'));

export const isWindows = process.platform === 'win32';

export function readJson(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
	fs.writeFileSync(file, JSON.stringify(value, null, '\t') + '\n');
}

export function upstream() {
	return readJson(path.join(ROOT_DIR, 'upstream.json'));
}

/**
 * The FriedLiver version stamped into product.json (friedliverVersion), which the
 * agents extension's update check compares with the latest GitHub release. Release
 * builds set FRIEDLIVER_VERSION from their tag (v1.142.0, v1.142.0-2); other builds
 * use the pinned upstream version.
 */
export function friedliverVersion(env = process.env) {
	const fromEnv = (env.FRIEDLIVER_VERSION || '').trim();
	if (!fromEnv) {
		return upstream().tag;
	}
	if (!/^v?\d+\.\d+\.\d+(-\d+)?$/.test(fromEnv)) {
		fail(`FRIEDLIVER_VERSION ${JSON.stringify(fromEnv)} is not X.Y.Z or X.Y.Z-N`);
	}
	return fromEnv.replace(/^v/, '');
}

// ---- Download integrity ----

export function sha256File(file) {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** The SHA-256 for `fileName` in a SHASUMS256.txt (`<hash>  <name>` per line), or null. */
export function shasumFor(shasums, fileName) {
	for (const line of String(shasums).split(/\r?\n/)) {
		const m = /^([0-9a-f]{64}) [ *]?(.+)$/.exec(line.trim());
		if (m && m[2] === fileName) {
			return m[1];
		}
	}
	return null;
}

/** Whether a file matches an npm lockfile `integrity` (Subresource Integrity, e.g. `sha512-…`). */
export function matchesIntegrity(file, integrity) {
	const bytes = fs.readFileSync(file);
	return String(integrity ?? '').split(/\s+/).some(entry => {
		const m = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(entry);
		return m !== null && crypto.createHash(m[1]).update(bytes).digest('base64') === m[2];
	});
}

/**
 * SHA-256 pins for downloads that publish no checksums of their own (the ripgrep
 * binaries), from scripts/checksums.json.
 */
export function pinnedSha256(fileName, pinsFile = path.join(SCRIPTS_DIR, 'checksums.json')) {
	const pins = fs.existsSync(pinsFile) ? readJson(pinsFile) : {};
	const hash = pins.files?.[fileName];
	return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

/**
 * The VS Code sysroot that upstream's .deb step (build/linux/debian/install-sysroot.ts) would
 * fetch for a Debian arch, read from that file's source and upstream's
 * build/checksums/vscode-sysroot.txt: `{ asset, sha256, url }`, where `url` is the plain
 * release-download link rather than the api.github.com lookup upstream makes. Null when
 * upstream's code no longer has the shape this reads, or the asset has no checksum.
 */
export function vscodeSysrootAsset(installSysrootSource, checksums, debArch, prefixOverride) {
	const src = String(installSysrootSource);
	const version = /const version = '([\w.-]+)';/.exec(src)?.[1];
	const repo = /https:\/\/api\.github\.com\/repos\/([\w.-]+\/[\w.-]+)\/releases\/tags\/v\$\{version\}/.exec(src)?.[1];
	const defaultPrefix = /process\.env\['VSCODE_SYSROOT_PREFIX'\] \?\? '([\w.-]+)'/.exec(src)?.[1];
	const prefix = prefixOverride ?? defaultPrefix;
	const triple = { amd64: 'x86_64-linux-gnu', arm64: 'aarch64-linux-gnu', armhf: 'arm-rpi-linux-gnueabihf' }[debArch];
	if (!version || !repo || prefix === undefined || !/^[\w.-]*$/.test(prefix) || !triple) {
		return null;
	}
	const asset = `${triple}${prefix}.tar.gz`;
	const sha256 = shasumFor(checksums, asset);
	return sha256 ? { asset, sha256, url: `https://github.com/${repo}/releases/download/v${version}/${asset}` } : null;
}

/** Fails, and deletes the file, unless it has the expected SHA-256. */
export function checkSha256(file, expected, what) {
	const actual = sha256File(file);
	if (actual !== expected) {
		fs.rmSync(file, { force: true });
		fail(`${what}: SHA-256 is ${actual}, expected ${expected}. The download was deleted.`);
	}
	log(`${what}: SHA-256 verified`);
}

export function log(...args) {
	console.log('[friedliver]', ...args);
}

export function fail(message) {
	console.error(`[friedliver] ERROR: ${message}`);
	process.exit(1);
}

/**
 * Run a command, inherit stdio, exit on failure unless `allowFail`.
 * On Windows, npm/npx are .cmd files and need a shell.
 */
export function run(cmd, args, { cwd = VSCODE_DIR, env = process.env, allowFail = false, capture = false } = {}) {
	const shell = isWindows && /^(npm|npx)(\.cmd)?$/i.test(cmd);
	const quoted = shell ? args.map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
	if (!capture) {
		log(`$ ${cmd} ${args.join(' ')}${cwd ? `   (in ${cwd})` : ''}`);
	}
	const result = spawnSync(cmd, quoted, {
		cwd,
		env,
		shell,
		stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
		encoding: 'utf8',
	});
	if (result.error) {
		if (allowFail) {
			return result;
		}
		fail(`${cmd} could not start: ${result.error.message}`);
	}
	if (result.status !== 0 && !allowFail) {
		fail(`${cmd} ${args.join(' ')} exited with ${result.status}${capture ? `\n${result.stderr}` : ''}`);
	}
	return result;
}

export function git(args, opts = {}) {
	return run('git', args, opts);
}

/** Deep merge: objects merge key by key, arrays and scalars replace, null deletes the key. */
export function deepMerge(target, overrides) {
	const out = Array.isArray(target) ? [...target] : { ...target };
	for (const [key, value] of Object.entries(overrides)) {
		if (value === null) {
			delete out[key];
		} else if (value && typeof value === 'object' && !Array.isArray(value)
			&& out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
			out[key] = deepMerge(out[key], value);
		} else {
			out[key] = value;
		}
	}
	return out;
}

/** Recursive copy that skips node_modules, .git and .vscode-test (extension test downloads). */
export function copyDir(src, dest) {
	fs.cpSync(src, dest, {
		recursive: true,
		filter: source => {
			const base = path.basename(source);
			return base !== 'node_modules' && base !== '.git' && base !== '.vscode-test';
		},
	});
}

/** Node version required by upstream (.nvmrc), falling back to upstream.json. */
export function requiredNodeVersion() {
	const nvmrc = path.join(VSCODE_DIR, '.nvmrc');
	if (fs.existsSync(nvmrc)) {
		return fs.readFileSync(nvmrc, 'utf8').trim().replace(/^v/, '');
	}
	return upstream().node;
}

/** Same rule as upstream's build/npm/preinstall.ts: same major, >= minor.patch. */
export function nodeSatisfies(actual, required) {
	const [a1, a2, a3] = actual.replace(/^v/, '').split('.').map(Number);
	const [r1, r2, r3] = required.split('.').map(Number);
	return a1 === r1 && (a2 > r2 || (a2 === r2 && a3 >= r3));
}

/**
 * Returns an env whose PATH starts with a Node that satisfies upstream's .nvmrc.
 * Uses the current Node if it fits; otherwise downloads the exact version from
 * nodejs.org into CACHE_DIR (tar handles .tar.xz on Linux/macOS and .zip on Windows 10+).
 */
export function nodeEnv() {
	const required = requiredNodeVersion();
	if (nodeSatisfies(process.versions.node, required)) {
		return { env: { ...process.env }, version: process.versions.node };
	}
	const platform = { linux: 'linux', darwin: 'darwin', win32: 'win' }[process.platform];
	const arch = process.arch;
	if (!platform) {
		fail(`no Node download for platform ${process.platform}; install Node ${required} yourself`);
	}
	const name = `node-v${required}-${platform}-${arch}`;
	const ext = isWindows ? 'zip' : 'tar.xz';
	const home = path.join(CACHE_DIR, name);
	const bin = isWindows ? home : path.join(home, 'bin');
	const exe = path.join(bin, isWindows ? 'node.exe' : 'node');
	if (!fs.existsSync(exe)) {
		if (!/^\d+\.\d+\.\d+$/.test(required)) {
			fail(`upstream .nvmrc asks for Node ${JSON.stringify(required)}, which is not a plain version`);
		}
		fs.mkdirSync(CACHE_DIR, { recursive: true });
		const archive = path.join(CACHE_DIR, `${name}.${ext}`);
		const base = `https://nodejs.org/dist/v${required}`;
		log(`Node ${process.versions.node} does not match upstream .nvmrc ${required}; downloading ${base}/${name}.${ext}`);
		run('curl', ['-fL', '--retry', '3', '-o', archive, `${base}/${name}.${ext}`], { cwd: CACHE_DIR });
		// Checked against the release's SHASUMS256.txt before anything is unpacked or run.
		const sums = run('curl', ['-fsSL', '--retry', '3', `${base}/SHASUMS256.txt`], { cwd: CACHE_DIR, capture: true }).stdout;
		const expected = shasumFor(sums, `${name}.${ext}`);
		if (!expected) {
			fs.rmSync(archive, { force: true });
			fail(`${base}/SHASUMS256.txt lists no ${name}.${ext}`);
		}
		checkSha256(archive, expected, `Node ${required} (${name}.${ext})`);
		run('tar', ['-xf', archive, '-C', CACHE_DIR], { cwd: CACHE_DIR });
		fs.rmSync(archive, { force: true });
	}
	const sep = isWindows ? ';' : ':';
	const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
	return {
		env: { ...process.env, [pathKey]: `${bin}${sep}${process.env[pathKey] || ''}` },
		version: required,
	};
}

/**
 * codesign's arguments for one macOS target. With an identity (MACOS_SIGN_IDENTITY: the
 * self-signed certificate CI imports, or later a Developer ID) the signature's designated
 * requirement names that certificate, so macOS keeps Desktop, Documents, mic and speech grants
 * across updates; without one it is ad-hoc ('-'), whose requirement is the build's cdhash and
 * changes every build. No hardened runtime: Electron needs entitlements for that.
 */
export function codesignArgs(target, { identity = '', keychain = '', identifier = '', deep = false } = {}) {
	const signed = identity.trim() !== '';
	return [
		'--force',
		...(deep ? ['--deep'] : []),
		'--sign', signed ? identity : '-',
		...(signed ? ['--timestamp=none'] : []),
		...(signed && keychain ? ['--keychain', keychain] : []),
		...(identifier ? ['--identifier', identifier] : []),
		target,
	];
}
