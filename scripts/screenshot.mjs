#!/usr/bin/env node
// Launch FriedLiver (dev build by default) with a throwaway profile and save a screenshot.
// Needs a display: on a headless Linux box wrap it in `xvfb-run -a -s "-screen 0 1440x900x24"`.
//
//   node code/scripts/screenshot.mjs --out shot.png [--folder dir] [--exe path/to/packaged/friedliver]
//       [--wait 8] [--keep 30] [--profile dir]   (--keep: stay open N seconds after the shot, e.g. to
//       measure memory; --profile: keep user data, extensions and logs there instead of a temp dir)
//
// Uses the `playwright` package from the repo root devDependencies.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { _electron as electron } from 'playwright';
import { VSCODE_DIR, readJson } from './lib.mjs';

const { values } = parseArgs({
	options: {
		out: { type: 'string', default: 'friedliver.png' },
		folder: { type: 'string' },
		exe: { type: 'string' },
		wait: { type: 'string', default: '8' },
		keep: { type: 'string', default: '0' },
		profile: { type: 'string' },
	},
});

const profile = values.profile ? path.resolve(values.profile) : fs.mkdtempSync(path.join(os.tmpdir(), 'friedliver-shot-'));
const flags = [
	'--no-sandbox',
	'--skip-release-notes',
	'--skip-welcome',
	'--disable-workspace-trust',
	'--disable-updates',
	`--user-data-dir=${path.join(profile, 'data')}`,
	`--extensions-dir=${path.join(profile, 'extensions')}`,
];
if (values.folder) {
	flags.push(path.resolve(values.folder));
}

let executablePath;
let args;
let env = { ...process.env };
if (values.exe) {
	executablePath = path.resolve(values.exe);
	args = flags;
} else {
	const product = readJson(path.join(VSCODE_DIR, 'product.json'));
	executablePath = path.join(VSCODE_DIR, '.build', 'electron', product.applicationName);
	args = [VSCODE_DIR, '--disable-extension=vscode.vscode-api-tests', ...flags];
	env = { ...env, NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1' };
}

const app = await electron.launch({ executablePath, args, env, timeout: 120_000 });
const pid = app.process().pid;
console.log(`launched ${executablePath} (pid ${pid})`);
const page = await app.firstWindow({ timeout: 120_000 });
await page.waitForSelector('.monaco-workbench', { timeout: 120_000 });
await page.waitForTimeout(Number(values.wait) * 1000);
console.log(`window title: ${await page.title()}`);
fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
await page.screenshot({ path: values.out });
console.log(`saved ${values.out}`);
const keep = Number(values.keep);
if (keep > 0) {
	console.log(`READY pid=${pid}; keeping the window open ${keep}s`);
	await page.waitForTimeout(keep * 1000);
}
await app.close();
if (!values.profile) {
	fs.rmSync(profile, { recursive: true, force: true });
}
