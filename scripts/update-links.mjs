#!/usr/bin/env node
// Adds the latest GitHub release to the Releases table in LINKS.md, which lives
// outside this repo (~/code/FriedLiver-Code-design/LINKS.md). Run it after the
// Release workflow finishes:
//
//   node scripts/update-links.mjs                    # latest release
//   node scripts/update-links.mjs v1.142.0-8         # a given release
//   node scripts/update-links.mjs --file path/LINKS.md
//
// A row for a tag that is already in the table is left as it is. Needs gh, logged in.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail, log } from './lib.mjs';

const REPO = 'MrArun005/FriedLiver-Code';

/** "a, b, c" from the notes' bullets: markup, PR numbers and the text after " — " dropped, at most `max` characters. */
export function summary(body, max = 240) {
	const items = body
		.split('\n')
		.filter(l => /^\s*[-*] /.test(l))
		.map(l => l.replace(/^\s*[-*] /, '').replace(/\s*\(#\d+\)\s*$/, '').replace(/[`*]/g, '').replace(/\s+—\s+.*$/, '').trim())
		.filter(Boolean);
	let out = '';
	for (const item of items) {
		const next = out ? `${out}, ${item}` : item;
		if (next.length > max) {
			return out ? `${out}, …` : `${item.slice(0, max - 1)}…`;
		}
		out = next;
	}
	return out || 'see release notes';
}

/** LINKS.md with a row for `release` appended to the Releases table, "live, latest" moved to it, and the Updated date set. */
export function updateLinks(text, release, today) {
	const lines = text.split('\n');
	const start = lines.findIndex(l => /^## Releases\s*$/.test(l));
	if (start < 0) {
		fail('LINKS.md has no "## Releases" section');
	}
	let end = start + 1;
	while (end < lines.length && !lines[end].startsWith('|')) {
		end++;
	}
	if (end === lines.length) {
		fail('LINKS.md has no table under "## Releases"');
	}
	while (end < lines.length && lines[end].startsWith('|')) {
		end++;
	}
	const rows = lines.slice(start, end);
	if (rows.some(l => l.startsWith(`| ${release.tagName} |`))) {
		return text;
	}
	for (let i = start; i < end; i++) {
		lines[i] = lines[i].replace('(live, latest, ', '(');
	}
	const date = release.publishedAt.slice(0, 10);
	const compare = release.previous ? ` ; compare https://github.com/${REPO}/compare/${release.previous}...${release.tagName}` : '';
	const row = `| ${release.tagName} | ${summary(release.body).replace(/\|/g, '\\|')} | ${release.url} (live, latest, signed with own cert; ${date}; tag ${release.tagName} on main ${release.commit.slice(0, 7)}${compare}) |`;
	lines.splice(end, 0, row);
	return lines.join('\n').replace(/^Updated \d{4}-\d{2}-\d{2}\./m, `Updated ${today}.`);
}

function gh(args) {
	const r = spawnSync('gh', args, { encoding: 'utf8' });
	if (r.status !== 0) {
		fail(`gh ${args.join(' ')} failed: ${r.stderr || r.error}`);
	}
	return r.stdout.trim();
}

function main() {
	const args = process.argv.slice(2);
	const fileAt = args.indexOf('--file');
	const file = fileAt >= 0 ? args[fileAt + 1] : path.join(os.homedir(), 'code', 'FriedLiver-Code-design', 'LINKS.md');
	const tag = args.find((a, i) => !a.startsWith('--') && i !== fileAt + 1);
	const release = JSON.parse(gh(['release', 'view', ...(tag ? [tag] : []), '--repo', REPO, '--json', 'tagName,url,publishedAt,body,isDraft,isPrerelease']));
	if (release.isDraft || release.isPrerelease) {
		fail(`${release.tagName} is a draft or pre-release`);
	}
	release.commit = gh(['api', `repos/${REPO}/commits/${release.tagName}`, '--jq', '.sha']);
	release.previous = /compare\/(v[\w.-]+)\.\.\./.exec(release.body)?.[1] || null;
	const text = fs.readFileSync(file, 'utf8');
	const next = updateLinks(text, release, new Date().toISOString().slice(0, 10));
	if (next === text) {
		log(`${file} already lists ${release.tagName}`);
		return;
	}
	fs.writeFileSync(file, next);
	log(`${file}: added ${release.tagName}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main();
}
