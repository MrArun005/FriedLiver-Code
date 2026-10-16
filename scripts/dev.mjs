#!/usr/bin/env node
// Run FriedLiver from source (upstream scripts/code.sh, or code.bat on Windows).
// Every argument is passed through, e.g.:
//
//   node code/scripts/dev.mjs                         # empty window
//   node code/scripts/dev.mjs ~/some/folder           # open a folder
//   node code/scripts/dev.mjs --user-data-dir /tmp/fl # throwaway profile
//
// As root on Linux, Electron needs --no-sandbox; it is added automatically.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { VSCODE_DIR, fail, isWindows, nodeEnv } from './lib.mjs';

if (!fs.existsSync(path.join(VSCODE_DIR, 'out'))) {
	fail(`${VSCODE_DIR}/out is missing. Run: node code/scripts/build.mjs`);
}

const args = process.argv.slice(2).map(a => (fs.existsSync(a) ? path.resolve(a) : a));
if (process.platform === 'linux' && process.getuid?.() === 0 && !args.includes('--no-sandbox')) {
	args.push('--no-sandbox');
}

const { env } = nodeEnv();
const script = isWindows ? path.join(VSCODE_DIR, 'scripts', 'code.bat') : path.join(VSCODE_DIR, 'scripts', 'code.sh');
const child = spawn(script, args, { cwd: VSCODE_DIR, env, stdio: 'inherit', shell: isWindows });
child.on('exit', code => process.exit(code ?? 1));
