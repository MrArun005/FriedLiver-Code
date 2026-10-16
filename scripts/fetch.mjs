#!/usr/bin/env node
// Clone or update the upstream VS Code checkout to the tag pinned in code/upstream.json.
//
//   node code/scripts/fetch.mjs            # VSCODE_DIR defaults to code/vscode
//   VSCODE_DIR=/path/to/vscode node code/scripts/fetch.mjs
//
// Shallow (depth 1): about 120 MB of git data and 420 MB of files.
// An existing checkout is moved to the pinned commit with `git checkout --force`,
// so local edits to tracked files are lost; untracked files (node_modules, out) stay.

import fs from 'node:fs';
import path from 'node:path';
import { VSCODE_DIR, git, log, fail, upstream } from './lib.mjs';

const { repository, tag, commit } = upstream();
const env = { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' };

if (!fs.existsSync(path.join(VSCODE_DIR, '.git'))) {
	if (fs.existsSync(VSCODE_DIR) && fs.readdirSync(VSCODE_DIR).length > 0) {
		fail(`${VSCODE_DIR} exists, is not empty and is not a git checkout`);
	}
	fs.mkdirSync(path.dirname(VSCODE_DIR), { recursive: true });
	log(`Cloning ${repository} ${tag} into ${VSCODE_DIR}`);
	git(['clone', '--depth', '1', '--branch', tag, repository, VSCODE_DIR], { cwd: path.dirname(VSCODE_DIR), env });
} else {
	const head = git(['rev-parse', 'HEAD'], { capture: true }).stdout.trim();
	if (head === commit) {
		log(`${VSCODE_DIR} is already at ${tag} (${commit})`);
	} else {
		log(`Updating ${VSCODE_DIR} from ${head} to ${tag}`);
		git(['fetch', '--depth', '1', 'origin', `refs/tags/${tag}:refs/tags/${tag}`, '--force'], { env });
		git(['checkout', '--force', '--detach', `refs/tags/${tag}`], { env });
	}
}

const head = git(['rev-parse', 'HEAD'], { capture: true }).stdout.trim();
if (head !== commit) {
	fail(`tag ${tag} resolved to ${head}, but code/upstream.json pins ${commit}. Update upstream.json if the tag moved on purpose.`);
}
log(`OK: ${VSCODE_DIR} at ${tag} (${head})`);
