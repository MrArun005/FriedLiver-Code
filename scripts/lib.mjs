// Shared helpers for the FriedLiver fork scripts (fetch, prepare, build, dev).
// Plain Node, no dependencies, so the scripts run on Linux, macOS and Windows.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const CODE_DIR = path.dirname(SCRIPTS_DIR);
export const REPO_ROOT = path.dirname(CODE_DIR);

/** Upstream checkout. Override with VSCODE_DIR; default is code/vscode. */
export const VSCODE_DIR = path.resolve(process.env.VSCODE_DIR || path.join(CODE_DIR, 'vscode'));

/** FriedLiver built-in extensions. Override with FRIEDLIVER_EXTENSIONS_DIR; default is code/extensions. */
export const EXTENSIONS_DIR = path.resolve(process.env.FRIEDLIVER_EXTENSIONS_DIR || path.join(CODE_DIR, 'extensions'));

/** Downloads (Node toolchain). Override with FRIEDLIVER_CACHE_DIR; default is code/.cache. */
export const CACHE_DIR = path.resolve(process.env.FRIEDLIVER_CACHE_DIR || path.join(CODE_DIR, '.cache'));

export const isWindows = process.platform === 'win32';

export function readJson(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
	fs.writeFileSync(file, JSON.stringify(value, null, '\t') + '\n');
}

export function upstream() {
	return readJson(path.join(CODE_DIR, 'upstream.json'));
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
		fs.mkdirSync(CACHE_DIR, { recursive: true });
		const archive = path.join(CACHE_DIR, `${name}.${ext}`);
		const url = `https://nodejs.org/dist/v${required}/${name}.${ext}`;
		log(`Node ${process.versions.node} does not match upstream .nvmrc ${required}; downloading ${url}`);
		run('curl', ['-fL', '--retry', '3', '-o', archive, url], { cwd: CACHE_DIR });
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
