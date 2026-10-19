#!/usr/bin/env node
// The next release's version and notes, for .github/workflows/release.yml.
//
//   node scripts/release.mjs            # writes version, previous and notes to $GITHUB_OUTPUT (or prints them)
//
// Version: v<upstream.json tag>-N, N one more than the newest tag for that upstream
// version (v1.142.0-7 -> v1.142.0-8; a new upstream starts at -1). Notes: the titles
// of pull requests merged into main since the previous release tag, grouped by their
// conventional-commit type; without any, the first-parent commit subjects.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT_DIR, fail, upstream } from './lib.mjs';

const TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/;

/** [major, minor, patch, build] of a release tag, or null for any other tag. */
export function parseTag(tag) {
	const m = TAG.exec(tag);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] || 0)] : null;
}

function compareTags(a, b) {
	const x = parseTag(a);
	const y = parseTag(b);
	for (let i = 0; i < 4; i++) {
		if (x[i] !== y[i]) {
			return x[i] - y[i];
		}
	}
	return 0;
}

/** The newest release tag in `tags`, or null. */
export function latestTag(tags) {
	const releases = tags.filter(t => parseTag(t));
	return releases.length ? releases.sort(compareTags).at(-1) : null;
}

/** The tag after the newest one for `upstreamTag` (e.g. 1.142.0). */
export function nextVersion(tags, upstreamTag) {
	if (!/^\d+\.\d+\.\d+$/.test(upstreamTag)) {
		fail(`upstream tag ${JSON.stringify(upstreamTag)} is not X.Y.Z`);
	}
	const builds = tags.map(parseTag).filter(p => p && p.slice(0, 3).join('.') === upstreamTag).map(p => p[3]);
	return `v${upstreamTag}-${builds.length ? Math.max(...builds) + 1 : 1}`;
}

const GROUPS = [
	['Features', ['feat']],
	['Fixes', ['fix']],
	['Performance', ['perf']],
	['Design', ['ui', 'ds', 'style']],
	['Docs', ['docs']],
	['Maintenance', ['chore', 'ci', 'build', 'test', 'refactor', 'revert']],
];
const CONVENTIONAL = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/;

/** One line per title: "- **scope:** text (#12)", grouped by type ("Other" for the rest). */
export function releaseNotes({ version, previous, repo, items }) {
	const groups = new Map([...GROUPS.map(([name]) => [name, []]), ['Other', []]]);
	for (const { title, number } of items) {
		const m = CONVENTIONAL.exec(title.trim());
		const group = (m && GROUPS.find(([, types]) => types.includes(m[1].toLowerCase()))?.[0]) || 'Other';
		const text = m && group !== 'Other' ? `${m[2] ? `**${m[2]}:** ` : ''}${m[3]}` : title.trim();
		groups.get(group).push(`- ${text}${number ? ` (#${number})` : ''}`);
	}
	const out = [`## What's in ${version.replace(/^v/, '')}`, ''];
	for (const [name, lines] of groups) {
		if (lines.length) {
			out.push(`### ${name}`, '', ...lines, '');
		}
	}
	if (!items.length) {
		out.push('No changes since the previous release.', '');
	}
	out.push('The macOS app is signed with FriedLiver\'s self-signed certificate; check downloads against SHA256SUMS.txt.', '');
	if (previous) {
		out.push(`**Full Changelog**: https://github.com/${repo}/compare/${previous}...${version}`);
	}
	return out.join('\n') + '\n';
}

/** Merged pull requests whose merge commit is in `commits` (the new release's commits), oldest first. */
export function prsInRange(prs, commits) {
	const set = new Set(commits);
	return prs.filter(p => p.mergeCommit && set.has(p.mergeCommit.oid)).sort((a, b) => a.number - b.number);
}

function sh(cmd, args) {
	const r = spawnSync(cmd, args, { cwd: ROOT_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	if (r.status !== 0) {
		fail(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.error}`);
	}
	return r.stdout.trim();
}

function main() {
	const repo = process.env.GITHUB_REPOSITORY || 'MrArun005/FriedLiver-Code';
	const tags = sh('git', ['tag', '--list', 'v*']).split('\n').filter(Boolean);
	const version = nextVersion(tags, upstream().tag);
	const previous = latestTag(tags);
	const range = previous ? `${previous}..HEAD` : 'HEAD';
	const commits = sh('git', ['rev-list', range]).split('\n').filter(Boolean);
	if (!commits.length) {
		fail(`Nothing to release: main has no commits since ${previous}.`);
	}
	const prs = JSON.parse(sh('gh', ['pr', 'list', '--repo', repo, '--state', 'merged', '--base', 'main', '--limit', '300', '--json', 'number,title,mergeCommit']));
	let items = prsInRange(prs, commits);
	if (!items.length) {
		// ponytail: hand merges carry no PR; their first-parent subjects stand in.
		items = sh('git', ['log', '--first-parent', '--format=%s', range]).split('\n').filter(Boolean).reverse().map(title => ({ title }));
	}
	const notes = releaseNotes({ version, previous, repo, items });
	if (!process.env.GITHUB_OUTPUT) {
		process.stdout.write(`version=${version}\nprevious=${previous}\n\n${notes}`);
		return;
	}
	const eof = `EOF_${crypto.randomBytes(8).toString('hex')}`;
	fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nprevious=${previous || ''}\nnotes<<${eof}\n${notes}${eof}\n`);
	if (process.env.GITHUB_STEP_SUMMARY) {
		fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `# ${version}\n\n${notes}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main();
}
