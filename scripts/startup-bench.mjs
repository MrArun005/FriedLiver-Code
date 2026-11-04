// Startup and footprint bench: two FriedLiver builds, the same machine, alternating launches, so
// drift on a shared CI runner falls on both alike. The proof for a speed change: the numbers in the
// run's summary, and every launch's raw Startup Performance report in the artifact.
//
//   node scripts/startup-bench.mjs --a <FriedLiver.exe|.app> --b <FriedLiver.exe|.app> --out bench
//       [--label-a base] [--label-b candidate] [--runs 8] [--settle 15] [--workspace <folder>]
//
// Per run and build: a fresh profile and a small workspace, launched twice: "first" (a new profile:
// the first start after install) and "warm" (the same profile again: every later start). Each launch:
//   window      ms from spawn to the first window
//   workbench   ms from spawn to the workbench DOM
//   restored    ms from spawn to code/didStartWorkbench .. code/didRestoreEditors (renderer marks)
//   extensions  ms from spawn to code/didLoadExtensions (every eager extension activated)
//   CPU time    CPU seconds every live process used from its start to the settle point (startup's work)
//   memory      MB of working set over every process the app owns (Electron's getAppMetrics),
//               after --settle seconds idle; processes: how many
//   idle CPU    % of one core, all processes, averaged over 10 s after settling
// plus, per build, the install folder's size and file count. The workbench's own Startup
// Performance report (perfview.show) is saved per launch (raw evidence, extension activation times).
// Profiles are throwaway; update checks and telemetry are off for both builds alike (no network noise).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
	options: {
		a: { type: 'string' },
		b: { type: 'string' },
		'label-a': { type: 'string', default: 'base' },
		'label-b': { type: 'string', default: 'candidate' },
		runs: { type: 'string', default: '8' },
		settle: { type: 'string', default: '15' },
		// A real folder to open (a repository: what indexing and git cost), copied per run; default: a 12-file project.
		workspace: { type: 'string' },
		out: { type: 'string', default: 'bench' },
	},
});
if (!values.a || !values.b) {
	console.error('usage: node scripts/startup-bench.mjs --a <app> --b <app> --out <dir> [--runs 8]');
	process.exit(2);
}
const { _electron: electron } = createRequire(path.join(ROOT, 'extensions/friedliver-agents/package.json'))('playwright');
const RUNS = Number(values.runs);
const SETTLE = Number(values.settle) * 1000;
const OUT = path.resolve(values.out);
fs.mkdirSync(path.join(OUT, 'perf'), { recursive: true });

const PERF_KEY = 'ctrl+alt+shift+p';
const builds = [
	{ key: 'a', label: values['label-a'], app: path.resolve(values.a) },
	{ key: 'b', label: values['label-b'], app: path.resolve(values.b) },
];

function executable(app) {
	// FriedLiver.exe on Windows, the binary itself on Linux (friedliver), the .app bundle on macOS.
	if (!app.endsWith('.app')) return app;
	const name = execFileSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
	return path.join(app, 'Contents', 'MacOS', name);
}
/** The folder an install puts on disk: the .app, or the folder holding FriedLiver.exe. */
const installDir = (app) => (app.endsWith('.app') ? app : path.dirname(app));
function footprint(dir) {
	let bytes = 0;
	let files = 0;
	const walk = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile()) {
				files++;
				bytes += fs.statSync(p).size;
			}
		}
	};
	walk(dir);
	return { mb: bytes / 1048576, files };
}

/** A small TypeScript project: what opening a real folder costs, without a repository's indexing noise. */
function workspace(dir) {
	if (values.workspace) {
		fs.cpSync(path.resolve(values.workspace), dir, { recursive: true, filter: (src) => !/[\\/]node_modules$/.test(src) });
		return;
	}
	fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'bench', version: '1.0.0', type: 'module' }, null, 2));
	fs.writeFileSync(path.join(dir, 'README.md'), '# Bench\n\nA small project to open.\n');
	for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, 'src', `m${i}.ts`), `export function f${i}(x: number): number {\n\treturn x * ${i};\n}\n`);
}
function profile(dir) {
	const user = path.join(dir, 'data', 'User');
	fs.mkdirSync(user, { recursive: true });
	// Only what keeps the network and first-run prompts out of the timing; everything else is the build's own default.
	fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify({
		'update.mode': 'none',
		'friedliver.update.mode': 'off',
		'extensions.autoCheckUpdates': false,
		'extensions.autoUpdate': false,
		'telemetry.telemetryLevel': 'off',
		'security.workspace.trust.enabled': false,
	}, null, 2));
	fs.writeFileSync(path.join(user, 'keybindings.json'), JSON.stringify([{ key: PERF_KEY, command: 'perfview.show' }], null, 2));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(build, dir, ws, kind, run) {
	const startedAt = Date.now();
	const app = await electron.launch({
		executablePath: executable(build.app),
		args: [ws, `--user-data-dir=${path.join(dir, 'data')}`, `--extensions-dir=${path.join(dir, 'ext')}`, '--use-mock-keychain', '--password-store=basic', '--skip-release-notes', '--disable-workspace-trust', ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
		timeout: 180_000,
	});
	const r = { build: build.key, kind, run };
	try {
		const win = await app.firstWindow({ timeout: 180_000 });
		r.window = Date.now() - startedAt;
		await win.waitForSelector('.monaco-workbench', { timeout: 180_000 });
		r.workbench = Date.now() - startedAt;
		// Renderer marks are relative to its timeOrigin; place them on the spawn's clock.
		const marks = async () =>
			win.evaluate(() => ({ origin: performance.timeOrigin, marks: performance.getEntriesByType('mark').filter((m) => m.name.startsWith('code/')).map((m) => [m.name, m.startTime]) }));
		const at = (m, name) => {
			const hit = m.marks.find(([n]) => n === name);
			return hit ? Math.round(m.origin + hit[1] - startedAt) : undefined;
		};
		// Wait (bounded) for the eager extensions to finish, then let everything settle.
		let m = await marks();
		for (let i = 0; i < 120 && at(m, 'code/didLoadExtensions') === undefined; i++) {
			await sleep(250);
			m = await marks();
		}
		r.started = at(m, 'code/didStartWorkbench');
		r.restored = at(m, 'code/didRestoreEditors') ?? at(m, 'code/didStartWorkbench');
		r.extensions = at(m, 'code/didLoadExtensions');
		await sleep(SETTLE);
		const metrics = await app.evaluate(({ app: a }) => a.getAppMetrics().map((p) => ({ type: p.type, name: p.name, ws: p.memory.workingSetSize, cpu: p.cpu.percentCPUUsage, total: p.cpu.cumulativeCPUUsage })));
		// CPU seconds every live process has used since it started: the work startup cost, whatever ran in parallel.
		if (metrics.every((p) => typeof p.total === 'number')) r.cpuTime = Math.round(metrics.reduce((s, p) => s + p.total, 0) * 100) / 100;
		r.memory = Math.round(metrics.reduce((s, p) => s + p.ws, 0) / 1024);
		r.processes = metrics.length;
		r.byType = {};
		for (const p of metrics) {
			const k = p.name ? `${p.type}:${p.name}` : p.type;
			r.byType[k] = Math.round(((r.byType[k] ?? 0) + p.ws / 1024) * 10) / 10;
		}
		// percentCPUUsage is since the previous call: one call to start the window, one 10 s later.
		await sleep(10_000);
		const cpu = await app.evaluate(({ app: a }) => a.getAppMetrics().reduce((s, p) => s + p.cpu.percentCPUUsage, 0));
		r.idleCpu = Math.round(cpu * 10) / 10;
		// The workbench's own report, copied out of its read-only editor through the clipboard.
		try {
			await win.keyboard.press(PERF_KEY.split('+').map((k) => (k === 'ctrl' ? 'Control' : k === 'alt' ? 'Alt' : k === 'shift' ? 'Shift' : `Key${k.toUpperCase()}`)).join('+'));
			await win.waitForSelector('.editor-instance .view-lines', { timeout: 15_000 });
			await sleep(2500);
			await win.keyboard.press('Control+A');
			await win.keyboard.press('Control+C');
			await sleep(300);
			const text = await app.evaluate(({ clipboard }) => clipboard.readText());
			if (text && text.includes('code/')) fs.writeFileSync(path.join(OUT, 'perf', `${build.key}-${build.label}-run${run}-${kind}.md`), text);
		} catch (e) {
			r.perfError = String(e.message).split('\n')[0];
		}
	} catch (e) {
		r.error = String(e.message).split('\n')[0];
	} finally {
		await app.close().catch(() => {});
		await sleep(1500);
	}
	return r;
}

const results = [];
const foot = {};
for (const b of builds) foot[b.key] = footprint(installDir(b.app));
// One discarded launch per build first: the first start after unpacking pays the cold disk cache
// (measured: +56% on an identical build), which says nothing about either build.
for (const b of builds) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flb-'));
	workspace(path.join(dir, 'ws'));
	profile(dir);
	const r = await launch(b, dir, path.join(dir, 'ws'), 'warmup', 0);
	console.log(`warm-up ${b.label}: ${r.error ?? `${r.workbench} ms`}`);
	fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
for (let run = 1; run <= RUNS; run++) {
	// Alternate which build goes first, so neither always gets the warmer disk cache.
	const order = run % 2 ? builds : [...builds].reverse();
	for (const b of order) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flb-'));
		const ws = path.join(dir, 'ws');
		workspace(ws);
		profile(dir);
		for (const kind of ['first', 'warm']) {
			const r = await launch(b, dir, ws, kind, run);
			results.push(r);
			console.log(JSON.stringify(r));
		}
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
	}
}

const METRICS = [
	['window', 'First window', 'ms'],
	['workbench', 'Workbench shown', 'ms'],
	['restored', 'Editors restored', 'ms'],
	['started', 'Workbench ready (Restored phase)', 'ms'],
	['extensions', 'Extensions loaded', 'ms'],
	['memory', 'Memory, all processes', 'MB'],
	['processes', 'Processes', ''],
	['cpuTime', 'CPU time to settle, all processes', 's'],
	['idleCpu', 'Idle CPU (one core = 100)', '%'],
];
const median = (xs) => {
	const s = [...xs].sort((x, y) => x - y);
	return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const vals = (key, kind, metric) => results.filter((r) => r.build === key && r.kind === kind && !r.error && typeof r[metric] === 'number').map((r) => r[metric]);
const fmt = (v) => (Number.isNaN(v) ? '–' : Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
const lines = [];
const [A, B] = builds;
lines.push(`## Startup bench: ${A.label} vs ${B.label}`, '', `${RUNS} runs per build, alternating; medians (min–max). Lower is better everywhere.`, '');
for (const kind of ['first', 'warm']) {
	lines.push(`### ${kind === 'first' ? 'First launch (new profile)' : 'Warm launch (same profile again)'}`, '', `| Metric | ${A.label} | ${B.label} | Change |`, '| --- | ---: | ---: | ---: |');
	for (const [k, name, unit] of METRICS) {
		const va = vals('a', kind, k);
		const vb = vals('b', kind, k);
		const ma = median(va);
		const mb = median(vb);
		const pct = ma ? ((mb - ma) / ma) * 100 : NaN;
		const range = (v) => (v.length ? ` (${fmt(Math.min(...v))}–${fmt(Math.max(...v))})` : '');
		lines.push(`| ${name}${unit ? ` (${unit})` : ''} | ${fmt(ma)}${range(va)} | ${fmt(mb)}${range(vb)} | ${Number.isNaN(pct) ? '–' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`} |`);
	}
	lines.push('');
}
lines.push('### Install footprint', '', `| | ${A.label} | ${B.label} | Change |`, '| --- | ---: | ---: | ---: |');
lines.push(`| Size (MB) | ${fmt(foot.a.mb)} | ${fmt(foot.b.mb)} | ${(((foot.b.mb - foot.a.mb) / foot.a.mb) * 100).toFixed(1)}% |`);
lines.push(`| Files | ${foot.a.files} | ${foot.b.files} | ${(((foot.b.files - foot.a.files) / foot.a.files) * 100).toFixed(1)}% |`, '');
const failed = results.filter((r) => r.error);
if (failed.length) lines.push(`**${failed.length} launch(es) failed:**`, '', ...failed.map((r) => `- ${builds.find((b) => b.key === r.build).label} run ${r.run} ${r.kind}: ${r.error}`), '');
lines.push(`Machine: ${os.type()} ${os.release()}, ${os.cpus().length}× ${os.cpus()[0]?.model ?? '?'}, ${Math.round(os.totalmem() / 1073741824)} GB.`);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ builds, footprint: foot, results }, null, 2));
fs.writeFileSync(path.join(OUT, 'summary.md'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
if (failed.length === results.length) process.exit(1);
