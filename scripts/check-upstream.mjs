#!/usr/bin/env node
// Is there a newer stable VS Code than upstream.json pins? Run weekly by
// .github/workflows/upstream.yml, which opens a pull request when there is.
//
//   node scripts/check-upstream.mjs              # update upstream.json and the docs' pinned version
//   node scripts/check-upstream.mjs --dry-run    # only say what it would do
//
// Every value read from the network is checked against a strict pattern before
// it goes into a file, a branch name or a pull request.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT_DIR, fail, log, readJson, run, upstream } from './lib.mjs';

export const RELEASES_URL = 'https://update.code.visualstudio.com/api/releases/stable';
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export function compareVersions(a, b) {
	const x = a.split('.').map(Number);
	const y = b.split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		if (x[i] !== y[i]) {
			return x[i] - y[i];
		}
	}
	return 0;
}

/** The newest plain X.Y.Z in the update service's list (not trusting its order), or null. */
export function newestVersion(list) {
	if (!Array.isArray(list)) {
		return null;
	}
	const versions = list.filter(v => typeof v === 'string' && VERSION.test(v));
	return versions.sort((a, b) => compareVersions(b, a))[0] ?? null;
}

/** The commit a tag names in `git ls-remote` output; an annotated tag's peeled `^{}` line wins. */
export function tagCommit(lsRemote, tag) {
	let direct = null;
	let peeled = null;
	for (const line of String(lsRemote).split(/\r?\n/)) {
		const [sha, ref] = line.trim().split(/\s+/);
		if (!sha || !COMMIT.test(sha)) {
			continue;
		}
		if (ref === `refs/tags/${tag}`) {
			direct = sha;
		} else if (ref === `refs/tags/${tag}^{}`) {
			peeled = sha;
		}
	}
	return peeled ?? direct;
}

const PINNED_LINE = /Pinned upstream: \*\*[^*\n]+\*\* \(`[0-9a-f]{40}`\)\. On\n\d{4}-\d{2}-\d{2} this was the newest version on `update\.code\.visualstudio\.com\/api\/releases\/stable`\./;

/** docs/BUILD.md with its "Pinned upstream" paragraph moved to the new version. Null when the paragraph isn't there. */
export function updateBuildDoc(text, { tag, commit, date }) {
	if (!PINNED_LINE.test(text)) {
		return null;
	}
	return text.replace(PINNED_LINE, `Pinned upstream: **${tag}** (\`${commit}\`). On\n${date} this was the newest version on \`update.code.visualstudio.com/api/releases/stable\`.`);
}

/** README.md's "built on VS Code 1.142" with the new major.minor. */
export function updateReadme(text, tag) {
	const [major, minor] = tag.split('.');
	return text.replace(/built on VS Code \d+\.\d+ \(Code - OSS\)/, `built on VS Code ${major}.${minor} (Code - OSS)`);
}

export function prBody({ from, to, commit, node, previousNode, ripgrep, previousRipgrep }) {
	const lines = [
		`VS Code ${to} is the newest stable release on ${RELEASES_URL}; upstream.json pinned ${from}.`,
		'',
		`- Tag \`${to}\`, commit \`${commit}\` (checked with \`git ls-remote\`).`,
		`- Node from upstream's \`.nvmrc\`: ${node}${node === previousNode ? ' (unchanged)' : ` (was ${previousNode})`}.`,
	];
	if (ripgrep && ripgrep !== previousRipgrep) {
		lines.push(`- \`@vscode/ripgrep\` is now ${ripgrep} (was ${previousRipgrep ?? 'unknown'}): add the new ripgrep binaries' SHA-256 to \`scripts/checksums.json\`, or release builds stop.`);
	}
	lines.push(
		'',
		'Before merging:',
		'- [ ] `node scripts/fetch.mjs && node scripts/prepare.mjs`: every patch still applies',
		'- [ ] `node scripts/build.mjs` and a quick run with `node scripts/dev.mjs`',
		'- [ ] Line references in `docs/DEFAULTS.md` still point at the right places',
		'',
		'Opened by the Upstream VS Code workflow. Pull requests made with the workflow token start no other workflows: push a commit (or close and reopen) to run CI.',
	);
	return lines.join('\n') + '\n';
}

async function fetchText(url) {
	const res = await globalThis.fetch(url, { headers: { 'User-Agent': 'FriedLiver-upstream-check' }, signal: globalThis.AbortSignal.timeout(60_000) });
	if (!res.ok) {
		throw new Error(`${url} answered ${res.status}`);
	}
	return res.text();
}

async function main() {
	const dryRun = process.argv.includes('--dry-run');
	const pinned = upstream();
	const latest = newestVersion(JSON.parse(await fetchText(RELEASES_URL)));
	if (!latest) {
		fail(`${RELEASES_URL} listed no versions`);
	}
	if (compareVersions(latest, pinned.tag) <= 0) {
		log(`upstream.json pins ${pinned.tag}; the newest stable is ${latest}. Nothing to do.`);
		output({ changed: 'false' });
		return;
	}
	const ls = run('git', ['ls-remote', pinned.repository, `refs/tags/${latest}`, `refs/tags/${latest}^{}`], { cwd: ROOT_DIR, capture: true }).stdout;
	const commit = tagCommit(ls, latest);
	if (!commit) {
		fail(`${pinned.repository} has no tag ${latest} yet`);
	}
	const node = (await fetchText(`https://raw.githubusercontent.com/microsoft/vscode/${commit}/.nvmrc`)).trim().replace(/^v/, '');
	if (!VERSION.test(node)) {
		fail(`.nvmrc at ${commit} says ${JSON.stringify(node)}`);
	}
	let ripgrep = null;
	try {
		const lock = JSON.parse(await fetchText(`https://raw.githubusercontent.com/microsoft/vscode/${commit}/package-lock.json`));
		const v = lock.packages?.['node_modules/@vscode/ripgrep']?.version;
		ripgrep = typeof v === 'string' && VERSION.test(v) ? v : null;
	} catch (err) {
		log(`could not read upstream's package-lock.json: ${err.message}`);
	}
	const date = new Date().toISOString().slice(0, 10);
	const next = {
		repository: pinned.repository,
		tag: latest,
		commit,
		node,
		checkedOn: date,
		notes: `Latest stable on update.code.visualstudio.com/api/releases/stable on ${date}, bumped by the Upstream VS Code workflow. node is upstream's .nvmrc at this tag.`,
	};
	const buildDocFile = path.join(ROOT_DIR, 'docs', 'BUILD.md');
	const buildDoc = updateBuildDoc(fs.readFileSync(buildDocFile, 'utf8'), { tag: latest, commit, date });
	if (buildDoc === null) {
		fail('docs/BUILD.md has no "Pinned upstream" paragraph in the expected form');
	}
	const readmeFile = path.join(ROOT_DIR, 'README.md');
	const readme = updateReadme(fs.readFileSync(readmeFile, 'utf8'), latest);
	const pins = readJson(path.join(ROOT_DIR, 'scripts', 'checksums.json'));
	const body = prBody({ from: pinned.tag, to: latest, commit, node, previousNode: pinned.node, ripgrep, previousRipgrep: pins.ripgrepPackage });
	log(`upstream ${pinned.tag} -> ${latest} (${commit}), Node ${node}`);
	if (dryRun) {
		process.stdout.write(body);
		return;
	}
	fs.writeFileSync(path.join(ROOT_DIR, 'upstream.json'), JSON.stringify(next, null, 2) + '\n');
	fs.writeFileSync(buildDocFile, buildDoc);
	fs.writeFileSync(readmeFile, readme);
	const bodyFile = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'upstream-pr.md');
	fs.writeFileSync(bodyFile, body);
	output({ changed: 'true', version: latest, body: bodyFile });
}

function output(values) {
	if (process.env.GITHUB_OUTPUT) {
		fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	await main();
}
