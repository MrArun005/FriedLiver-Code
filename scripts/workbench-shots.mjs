#!/usr/bin/env node
// The workbench visual harness: launch a packaged FriedLiver with a throwaway profile, open each
// workbench surface programmatically and screenshot it, per theme and window size; check the
// objective design gates on the live DOM after every shot; optionally record three short motion
// clips. Also guards the approved chat composer: its computed styles must match the committed
// baseline (themes that have one; macOS only, where the baselines were taken).
//
//   node scripts/workbench-shots.mjs --app <FriedLiver.app | FriedLiver.exe> --out shots
//       [--themes fl-dark,fl-light,dark-2026] [--sizes 1440x900,1280x800] [--record]
//       [--write-baseline] [--strict-gates]
//
// Output: <out>/<mac|windows>/<theme>/<WxH>/NN-name.png + gates.json, <out>/<platform>/recordings/*.webm,
// <out>/<platform>/composer-<theme>.json, failures.txt and gates-summary.txt.
//
// CI only (.github/workflows/workbench-shots.yml, macOS and Windows). No network sign-ins: a fresh
// profile, the mock keychain, no update checks. Surfaces are opened through user keybindings to
// command ids, so nothing depends on typing localized command names.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HARNESS = path.join(ROOT, 'test', 'workbench-harness');
// FriedLiver's v2 defaults, the v1 themes the composer baselines were taken in, and the owner's own theme.
export const THEMES = {
	'fl-dark': 'FriedLiver Dark',
	'fl-light': 'FriedLiver Light',
	dark: 'FriedLiver Black Blue',
	light: 'FriedLiver Light Blue',
	'dark-2026': 'Dark 2026',
};
const PLATFORM = process.platform === 'win32' ? 'windows' : 'mac';
const MOD = PLATFORM === 'windows' ? 'Control' : 'Meta';

// One key per command; ctrl+alt+shift+<letter> is unbound upstream.
const COMMANDS = {
	a: 'workbench.action.showCommands',
	b: 'workbench.action.quickOpen',
	c: 'harness.toasts',
	d: 'notifications.showList',
	e: 'notifications.clearAll',
	f: 'harness.dialog',
	g: 'editor.action.showHover',
	h: 'actions.find',
	i: 'workbench.action.openSettings2',
	j: 'workbench.view.extensions',
	k: 'workbench.action.openWalkthrough',
	l: 'workbench.action.togglePanel',
	m: 'workbench.action.closeAllEditors',
	n: 'workbench.view.explorer',
	o: 'editor.action.triggerSuggest',
	p: 'workbench.action.closeQuickOpen',
	q: 'notifications.hideList',
	r: 'workbench.action.closeActiveEditor',
	s: 'harness.diff',
	t: 'harness.peek',
	u: 'workbench.view.search',
	v: 'workbench.view.scm',
	w: 'breadcrumbs.focusAndSelect',
	x: 'harness.downloads',
	y: 'workbench.action.browser.showDownloads',
};
const keyOf = Object.fromEntries(Object.entries(COMMANDS).map(([k, c]) => [c, k]));

// What the composer's look is made of. Width is left out: it follows the view, not the composer.
const COMPOSER_PARTS = ['.composer', '.composer textarea', '.composer-bar', '.attach-btn', '.cc-slash-btn', '.cc-pill.cc-model', '.cc-mode', '.cc-mic', '.send-btn'];
const COMPOSER_PROPS = [
	'background-color', 'color', 'border-top-color', 'border-top-width', 'border-top-style', 'border-radius', 'box-shadow',
	'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'padding', 'margin', 'gap', 'height', 'min-height', 'opacity',
];

const FORMAT_OLD = '/** Formats an amount in cents as dollars. */\nexport function formatCents(cents: number): string {\n  return `$${cents / 100}`;\n}\n\nexport const ZERO = formatCents(0);\n';
const FORMAT_NEW = '/** Formats an amount in cents as dollars, e.g. 1999 -> "$19.99". */\nexport function formatCents(cents: number): string {\n  if (!Number.isFinite(cents)) {\n    throw new Error(`not a number: ${cents}`);\n  }\n  return `$${(cents / 100).toFixed(2)}`;\n}\n\nexport const ZERO = formatCents(0);\n';

/** The workspace: a small repository on a feature branch with a modified file and an untracked one (SCM, gutter, decorations). */
function fixture(dir, failures) {
	fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'package.json'), '{\n  "name": "prices",\n  "private": true,\n  "version": "1.0.0"\n}\n');
	fs.writeFileSync(path.join(dir, 'README.md'), '# Prices\n\nFormats prices in cents.\n');
	fs.writeFileSync(path.join(dir, 'src', 'cart.ts'), "import { formatCents } from './format';\n\nexport const total = (items: number[]) => formatCents(items.reduce((a, b) => a + b, 0));\n");
	fs.writeFileSync(path.join(dir, 'src', 'format.ts'), FORMAT_OLD);
	try {
		const g = (...args) => execFileSync('git', ['-c', 'user.name=Harness', '-c', 'user.email=harness@friedliver.invalid', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'pipe' });
		g('init', '-q', '-b', 'main');
		g('add', '-A');
		g('commit', '-q', '-m', 'Prices in cents');
		g('checkout', '-q', '-b', 'feat/checkout-tax');
	} catch (e) {
		failures.push(`fixture: git: ${e.message.split('\n')[0]}`);
	}
	fs.writeFileSync(path.join(dir, 'src', 'format.ts'), FORMAT_NEW);
	fs.writeFileSync(path.join(dir, 'src', 'tax.ts'), "import { formatCents } from './format';\n\nexport const VAT = 0.19;\nexport const withVat = (cents: number) => formatCents(Math.round(cents * (1 + VAT)));\n");
}

function profile(dir, theme) {
	const user = path.join(dir, 'data', 'User');
	fs.mkdirSync(user, { recursive: true });
	fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify({
		'workbench.colorTheme': theme,
		// Custom menus and dialogs: they are DOM (what FriedLiver styles), native ones can't be captured.
		'window.menuStyle': 'custom',
		'window.dialogStyle': 'custom',
		'workbench.startupEditor': 'none',
		'workbench.hover.delay': 300,
		'update.mode': 'none',
		'friedliver.update.mode': 'off',
		'extensions.autoCheckUpdates': false,
		'extensions.autoUpdate': false,
		'telemetry.telemetryLevel': 'off',
		'security.workspace.trust.enabled': false,
		// The fixture is a repository: SCM, gutter bars and tree decorations show; nothing is fetched.
		'git.enabled': true,
		'git.autofetch': false,
		'git.autoRepositoryDetection': true,
		'git.openRepositoryInParentFolders': 'never',
		// Quick open lists workspace symbols under the files (24-palette-typed).
		'search.quickOpen.includeSymbols': true,
		'friedliver.browser.downloadFolder': path.join(dir, 'downloads'),
	}, null, 2));
	fs.writeFileSync(path.join(user, 'keybindings.json'), JSON.stringify(
		Object.entries(COMMANDS).map(([k, command]) => ({ key: `ctrl+alt+shift+${k}`, command })), null, 2));
}

function executable(app) {
	if (app.toLowerCase().endsWith('.exe')) return app;
	const name = execFileSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
	return path.join(app, 'Contents', 'MacOS', name);
}

/** A fresh profile + workspace and the app on it at w x h. Returns { app, win, dir, startedAt }. */
async function launch(themeKey, [w, h], failures, extra = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flwb-')); // short: the app's sockets live under it
	const ws = path.join(dir, 'ws');
	fixture(ws, failures);
	profile(dir, THEMES[themeKey]);
	const startedAt = Date.now();
	const app = await electron.launch({
		executablePath: executable(path.resolve(values.app)),
		// The fake Demo agent runs only with this; packaged builds never set it.
		env: { ...process.env, FRIEDLIVER_TEST_AGENTS: '1' },
		args: [
			ws,
			// Opened as editors at startup, as four tabs.
			...['README.md', 'package.json', 'src/cart.ts', 'src/format.ts'].map((f) => path.join(ws, f)),
			`--user-data-dir=${path.join(dir, 'data')}`,
			`--extensions-dir=${path.join(dir, 'ext')}`,
			`--extensionDevelopmentPath=${path.join(HARNESS, 'ext')}`,
			// The harness opens the integrated browser (vscode.window.openBrowserTab, proposed API).
			'--enable-proposed-api', 'friedliver-test.workbench-harness',
			'--use-mock-keychain', '--password-store=basic',
			'--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-updates',
		],
		timeout: 120_000,
		...extra,
	});
	const win = await app.firstWindow({ timeout: 120_000 });
	await app.evaluate(({ BrowserWindow }, [cw, ch]) => {
		const b = BrowserWindow.getAllWindows()[0];
		b.setContentSize(cw, ch);
		b.center();
	}, [w, h]);
	// The runner's screen may be smaller than the window; emulate the viewport so every shot is exactly w x h.
	await win.setViewportSize({ width: w, height: h });
	await win.waitForSelector('.monaco-workbench', { timeout: 120_000 });
	await win.waitForTimeout(8000);
	return { app, win, dir, startedAt };
}

/** Keyboard and wait helpers for one window; `failures` gets one line per failed step. */
function helpers(win, label, failures, [w, h]) {
	const wait = (ms) => win.waitForTimeout(ms);
	const cmd = async (command, ms = 900) => {
		await win.keyboard.press(`Control+Alt+Shift+Key${keyOf[command].toUpperCase()}`);
		await wait(ms);
	};
	const escape = async (n = 2) => {
		for (let i = 0; i < n; i++) await win.keyboard.press('Escape');
		await wait(300);
	};
	const step = async (name, fn) => {
		try {
			await fn();
		} catch (e) {
			failures.push(`${label}/${name}: ${e.message.split('\n')[0]}`);
			console.error(`FAILED ${label}/${name}: ${e.message}`);
			await escape(3).catch(() => {});
			await win.mouse.move(w / 2, h / 2).catch(() => {});
		}
	};
	/** Runs a command until `selector` shows (a test-extension command may land before it activates). */
	const until = async (command, selector) => {
		for (let i = 0; i < 4; i++) {
			await cmd(command, 300);
			if (await win.locator(selector).first().waitFor({ timeout: 3000 }).then(() => true, () => false)) return wait(1200);
		}
		throw new Error(`${command}: ${selector} never showed`);
	};
	return { wait, cmd, escape, step, until };
}

async function run(themeKey, size, out, failures, summary) {
	const [W, H] = size;
	const sizeName = `${W}x${H}`;
	const label = `${PLATFORM}/${themeKey}/${sizeName}`;
	const dirOut = path.join(out, PLATFORM, themeKey, sizeName);
	fs.mkdirSync(dirOut, { recursive: true });
	const { app, win, dir } = await launch(themeKey, size, failures);
	const { wait, cmd, escape, step, until } = helpers(win, label, failures, size);
	const report = {};
	const shot = async (name) => {
		await win.screenshot({ path: path.join(dirOut, `${name}.png`) });
		console.log(`${label}/${name}`);
		report[name] = await win.evaluate(gates).catch((e) => ({ error: e.message.split('\n')[0] }));
	};

	await cmd('notifications.clearAll', 300);
	await step('01-workbench', async () => {
		await cmd('workbench.view.explorer');
		// The first file on the command line opens in front; bring format.ts forward (the explorer reveals it).
		await win.locator('.tabs-container .tab', { hasText: 'format.ts' }).first().click({ timeout: 30_000 });
		await wait(1500);
		await shot('01-workbench');
	});
	await step('02-command-palette', async () => {
		await cmd('workbench.action.showCommands', 1200);
		await shot('02-command-palette');
		await cmd('workbench.action.closeQuickOpen', 300);
	});
	await step('03-quick-open', async () => {
		await cmd('workbench.action.quickOpen', 1200);
		await shot('03-quick-open');
		await cmd('workbench.action.closeQuickOpen', 300);
	});
	await step('04-toasts', async () => {
		await until('harness.toasts', '.notifications-toasts .notification-toast');
		await shot('04-toasts');
	});
	await step('05-notification-center', async () => {
		await cmd('notifications.showList', 1000);
		await shot('05-notification-center');
		await cmd('notifications.hideList', 300);
		await cmd('notifications.clearAll', 600);
	});
	await step('06-context-menu', async () => {
		await win.locator('.explorer-folders-view .monaco-list-row', { hasText: 'format.ts' }).first().click({ button: 'right' });
		await wait(900);
		await shot('06-context-menu');
		await escape(1);
	});
	await step('07-editor-context-menu', async () => {
		await win.locator('.monaco-editor .view-lines').first().click({ button: 'right', position: { x: 160, y: 30 } });
		await wait(900);
		await shot('07-editor-context-menu');
		await escape(1);
	});
	await step('08-hover-editor', async () => {
		await wait(4000); // the TypeScript server starts on the first .ts file
		await win.locator('.monaco-editor .view-line', { hasText: 'export function formatCents' }).first().click({ position: { x: 150, y: 8 } });
		await cmd('editor.action.showHover', 2500);
		await shot('08-hover-editor');
		await escape(1);
	});
	await step('09-suggest', async () => {
		await win.keyboard.press('End');
		await win.keyboard.press('Enter');
		await win.keyboard.type('cents.to', { delay: 40 });
		await cmd('editor.action.triggerSuggest', 1500);
		await shot('09-suggest');
		await escape(1);
		await win.keyboard.press(`${MOD}+Z`);
		await win.keyboard.press(`${MOD}+Z`);
	});
	await step('10-find', async () => {
		await cmd('actions.find', 300);
		await win.keyboard.type('cents', { delay: 30 });
		await wait(700);
		await shot('10-find');
		await escape(1);
	});
	await step('11-hover-workbench', async () => {
		await win.locator('.part.activitybar .action-item').nth(1).hover();
		await wait(1500);
		await shot('11-hover-workbench');
		await win.mouse.move(W / 2, H / 2);
	});
	await step('12-dialog', async () => {
		await until('harness.dialog', '.monaco-dialog-box');
		await shot('12-dialog');
		await escape(1);
	});
	await step('13-panel', async () => {
		await cmd('workbench.action.togglePanel', 2000);
		await shot('13-panel');
		await cmd('workbench.action.togglePanel', 600);
	});
	await step('14-settings', async () => {
		await cmd('workbench.action.openSettings2', 2500);
		await shot('14-settings');
		// Settings may open in the modal editor, which would cover the next shots.
		await cmd('workbench.action.closeActiveEditor', 800);
	});
	await step('15-extensions', async () => {
		await cmd('workbench.view.extensions', 3000);
		await shot('15-extensions');
		await cmd('workbench.view.explorer', 500);
	});
	await step('16-welcome', async () => {
		await cmd('workbench.action.openWalkthrough', 2500);
		await shot('16-welcome');
		await cmd('workbench.action.closeAllEditors', 800);
	});

	// Browser downloads (patch 0300, COMPONENTS.md §2.39): a page's download waiting with its toast,
	// then the indicator's popover with a finished, a running, a failed and a waiting download.
	await step('25-downloads-toast', async () => {
		await cmd('notifications.clearAll', 300);
		// Once: each run would open another browser tab (the harness is active since 04-toasts).
		await cmd('harness.downloads', 300);
		await win.locator('.notifications-toasts .notification-toast').first().waitFor({ timeout: 30_000 });
		await win.locator('.fl-dl-indicator').first().waitFor({ timeout: 30_000 });
		await wait(6000); // the harness allows three; their toasts close, the installer's stays
		await shot('25-downloads-toast');
	});
	await step('26-downloads-popover', async () => {
		await cmd('workbench.action.browser.showDownloads', 300);
		await win.locator('.fl-downloads .fl-downloads__row').nth(3).waitFor({ timeout: 15_000 });
		await wait(800);
		await shot('26-downloads-popover');
		await escape(1);
		await cmd('workbench.action.closeAllEditors', 800);
		await cmd('notifications.clearAll', 600);
	});

	// The approved composer: a screenshot to look at, and its computed styles to compare.
	await step('17-composer', async () => {
		const chat = await surface(win, 'chat');
		const demo = chat.getByRole('button', { name: /Demo/ }).first();
		if (await demo.count()) await demo.click();
		await chat.locator('.composer').first().waitFor({ timeout: 30_000 });
		await wait(1200);
		// At rest: the focus ring is part of the approved look too, but focus is not deterministic.
		await chat.evaluate(() => document.activeElement?.blur());
		await win.mouse.move(W / 2, H / 2);
		await wait(400);
		await shot('17-composer');
		if (sizeName === '1440x900') composerCheck(themeKey, await chat.evaluate(([parts, props]) => {
			const res = {};
			for (const sel of parts) {
				const el = document.querySelector(sel);
				if (!el) {
					res[sel] = null;
					continue;
				}
				const cs = window.getComputedStyle(el);
				res[sel] = Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
			}
			return res;
		}, [COMPOSER_PARTS, COMPOSER_PROPS]), out, failures);
		await chat.locator('.cc-pill.cc-model').first().click();
		await wait(800);
		await shot('18-composer-model-menu');
		await win.keyboard.press('Escape');
		await wait(300);
		await win.mouse.click(W / 2, H / 2).catch(() => {}); // focus back in the workbench, out of the webview
	});

	// Stock surfaces with their own spec entries (COMPONENTS.md §6.17–§6.20, §6.5, §6.9).
	await step('19-diff', async () => {
		await until('harness.diff', '.monaco-diff-editor');
		await wait(1500);
		await shot('19-diff');
		await cmd('workbench.action.closeActiveEditor', 600);
	});
	await step('20-peek', async () => {
		for (let i = 0; i < 6; i++) {
			await cmd('harness.peek', 300);
			if (await win.locator('.peekview-widget').first().waitFor({ timeout: 4000 }).then(() => true, () => false)) break;
			await escape(1);
		}
		await win.locator('.peekview-widget').first().waitFor({ timeout: 2000 });
		await wait(1200);
		await shot('20-peek');
		await escape(1);
	});
	await step('21-search', async () => {
		await cmd('workbench.view.search', 1200);
		await win.keyboard.type('cents', { delay: 40 });
		await win.keyboard.press('Enter');
		await wait(2000);
		await shot('21-search');
		await cmd('workbench.view.explorer', 500);
	});
	await step('22-scm', async () => {
		await cmd('workbench.view.scm', 1500);
		await win.locator('.scm-view .monaco-list-row').first().waitFor({ timeout: 15_000 });
		await wait(1500);
		await shot('22-scm');
		await cmd('workbench.view.explorer', 500);
	});
	await step('23-breadcrumbs', async () => {
		// 16-welcome closed every editor: open format.ts again through quick open.
		await cmd('workbench.action.quickOpen', 800);
		await win.keyboard.type('format.ts', { delay: 40 });
		await wait(1200);
		await win.keyboard.press('Enter');
		await wait(1200);
		await cmd('breadcrumbs.focusAndSelect', 1200);
		await shot('23-breadcrumbs');
		await escape(2);
	});
	await step('24-palette-typed', async () => {
		await cmd('workbench.action.quickOpen', 800);
		await win.keyboard.type('format', { delay: 50 });
		await wait(2000);
		await shot('24-palette-typed');
		await cmd('workbench.action.closeQuickOpen', 300);
	});

	fs.writeFileSync(path.join(dirOut, 'gates.json'), JSON.stringify(report, null, 1) + '\n');
	summary.push(summarize(label, report));
	await app.close();
	fs.rmSync(dir, { recursive: true, force: true });
}

/** Compares (or saves) the composer's computed styles. Only themes with a baseline, and only on macOS, are compared. */
function composerCheck(themeKey, styles, out, failures) {
	const file = `composer-${themeKey}.json`;
	fs.writeFileSync(path.join(out, PLATFORM, file), JSON.stringify(styles, null, 2) + '\n');
	const baseline = path.join(HARNESS, file);
	if (values['write-baseline']) {
		if (PLATFORM === 'mac') fs.copyFileSync(path.join(out, PLATFORM, file), baseline);
	} else if (PLATFORM === 'mac' && fs.existsSync(baseline)) {
		const diff = diffStyles(JSON.parse(fs.readFileSync(baseline, 'utf8')), styles);
		if (diff.length) failures.push(`${themeKey}: the approved composer changed:\n  ${diff.join('\n  ')}`);
	}
}

/** Three short clips to judge motion (FriedLiver Dark, 1440x900). The action starts `actionStartsAt` seconds in. */
async function record(out, failures) {
	const dirOut = path.join(out, PLATFORM, 'recordings');
	fs.mkdirSync(dirOut, { recursive: true });
	const size = [1440, 900];
	const clips = {
		'palette': async (h) => {
			await h.cmd('workbench.action.showCommands', 900);
			await h.win.keyboard.type('format', { delay: 90 });
			await h.wait(900);
			await h.cmd('workbench.action.closeQuickOpen', 1000);
			await h.cmd('workbench.action.quickOpen', 900);
			await h.cmd('workbench.action.closeQuickOpen', 1000);
		},
		'palette-reduced-motion': async (h) => {
			await h.win.emulateMedia({ reducedMotion: 'reduce' });
			await h.wait(500);
			await clips.palette(h);
		},
		'tabs': async (h) => {
			for (const name of ['README.md', 'package.json', 'cart.ts', 'format.ts', 'cart.ts', 'README.md']) {
				await h.win.locator('.tabs-container .tab', { hasText: name }).first().click({ timeout: 10_000 });
				await h.wait(600);
			}
		},
		'toast': async (h) => {
			await h.until('harness.toasts', '.notifications-toasts .notification-toast');
			await h.wait(2500);
			await h.cmd('notifications.clearAll', 1500);
		},
	};
	const times = {};
	for (const [name, fn] of Object.entries(clips)) {
		const label = `${PLATFORM}/recordings/${name}`;
		let session;
		try {
			session = await launch('fl-dark', size, failures, { recordVideo: { dir: dirOut, size: { width: size[0], height: size[1] } } });
			const h = { win: session.win, ...helpers(session.win, label, failures, size) };
			await h.cmd('notifications.clearAll', 300);
			times[name] = { actionStartsAt: +((Date.now() - session.startedAt) / 1000).toFixed(1) };
			await h.step('clip', () => fn(h));
			await h.wait(500);
			const video = session.win.video();
			await session.app.close();
			if (video) fs.renameSync(await video.path(), path.join(dirOut, `${name}.webm`));
			console.log(label);
		} catch (e) {
			failures.push(`${label}: ${e.message.split('\n')[0]}`);
			await session?.app.close().catch(() => {});
		} finally {
			if (session) fs.rmSync(session.dir, { recursive: true, force: true });
		}
	}
	fs.writeFileSync(path.join(dirOut, 'recordings.json'), JSON.stringify(times, null, 1) + '\n');
}

/** The webview frame that shows one of the Agents extension's surfaces (data-surface on its body). */
async function surface(win, kind, timeout = 30_000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		for (const f of win.frames()) {
			if ((await f.evaluate(() => document.body?.dataset.surface).catch(() => null)) === kind) return f;
		}
		await win.waitForTimeout(300);
	}
	throw new Error(`no ${kind} surface`);
}

/** Every element/property that differs between two composer style snapshots, as readable lines. */
export function diffStyles(want, got) {
	const lines = [];
	for (const sel of new Set([...Object.keys(want), ...Object.keys(got)])) {
		const a = want[sel] ?? null;
		const b = got[sel] ?? null;
		if (a === null || b === null) {
			if (a !== b) lines.push(`${sel}: ${a === null ? 'absent' : 'present'} -> ${b === null ? 'absent' : 'present'}`);
			continue;
		}
		for (const p of new Set([...Object.keys(a), ...Object.keys(b)])) {
			if (a[p] !== b[p]) lines.push(`${sel} ${p}: ${JSON.stringify(a[p])} -> ${JSON.stringify(b[p])}`);
		}
	}
	return lines;
}

/** One summary line per theme/size: the gate totals over every shot. */
export function summarize(label, report) {
	const shots = Object.values(report).filter((g) => g && !g.error);
	const sum = (k) => shots.reduce((n, g) => n + (g[k] ?? 0), 0);
	const t = {
		text: sum('textFails'),
		ui: shots.reduce((n, g) => n + (g.ui?.length ?? 0), 0),
		accentMax: Math.max(0, ...shots.map((g) => g.accentGroups ?? 0)),
		off2: sum('off2Count'),
		off2Styled: sum('off2Styled'),
		offscreen: shots.reduce((n, g) => n + (g.offscreen?.length ?? 0), 0),
	};
	return { label, ...t, line: `${label}: text<AA ${t.text} · ui<3:1 ${t.ui} · accent groups max ${t.accentMax} · off-grid ${t.off2} (FriedLiver-styled ${t.off2Styled}) · outside window ${t.offscreen} · ${shots.length} shots` };
}

/**
 * In-page gates (ported from the v2 mock's render.mjs): text contrast on the composited background,
 * focus ring and switch 3:1, accent groups, spacing on the 2px half-grid, controls inside the window.
 * Walks open shadow roots (context menus render in one). Self-contained: it runs in the page.
 */
/* global ShadowRoot, getComputedStyle, innerWidth, innerHeight -- page globals: gates() runs in the window */
export function gates() {
	const parse = (c) => {
		const m = String(c).match(/rgba?\(([^)]+)\)/);
		if (!m) {
			const s = String(c).match(/srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?/);
			if (s) return [s[1] * 255, s[2] * 255, s[3] * 255, s[4] === undefined ? 1 : +s[4]];
			return [0, 0, 0, 0];
		}
		const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
		return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
	};
	const over = (t, u) => [0, 1, 2].map((k) => t[k] * t[3] + u[k] * (1 - t[3])).concat(1);
	const lum = ([r, g, b]) => {
		const f = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
		return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
	};
	const ratio = (a, b) => {
		const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
		return (x + 0.05) / (y + 0.05);
	};
	const up = (e) => e.parentElement ?? (e.parentNode instanceof ShadowRoot ? e.parentNode.host : null);
	const wb = document.querySelector('.monaco-workbench') ?? document.body;
	const wbBg = parse(getComputedStyle(wb).backgroundColor);
	const bgOf = (el) => {
		const stack = [];
		for (let e = el; e; e = up(e)) {
			const c = parse(getComputedStyle(e).backgroundColor);
			if (c[3] > 0) stack.push(c);
			if (c[3] >= 1) break;
		}
		let base = wbBg[3] > 0 ? [...wbBg.slice(0, 3), 1] : [255, 255, 255, 1];
		for (const c of stack.reverse()) base = over(c, base);
		return base;
	};
	const desc = (e) => `${e.tagName.toLowerCase()}${[...e.classList].slice(0, 3).map((c) => '.' + c).join('')}`;
	const all = [];
	const collect = (root) => {
		for (const e of root.querySelectorAll('*')) {
			all.push(e);
			if (e.shadowRoot) collect(e.shadowRoot);
		}
	};
	collect(document);
	const visible = new Map();
	const isVisible = (e) => {
		if (visible.has(e)) return visible.get(e);
		const r = e.getBoundingClientRect();
		const cs = getComputedStyle(e);
		const v = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
		visible.set(e, v);
		return v;
	};
	const opacity = (e) => {
		let op = 1;
		for (let x = e; x; x = up(x)) op *= +getComputedStyle(x).opacity;
		return op;
	};

	// Text contrast (WCAG 1.4.3). Disabled text is exempt; the minimap is a canvas.
	const fails = [];
	let checked = 0;
	for (const el of all) {
		if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
		if (!isVisible(el) || el.closest('.minimap, .disabled, [aria-disabled="true"]')) continue;
		const op = opacity(el);
		if (op === 0) continue;
		const cs = getComputedStyle(el);
		const bg = bgOf(el);
		const fgc = parse(cs.color);
		const fg = over([fgc[0], fgc[1], fgc[2], fgc[3] * op], bg);
		const sizePx = parseFloat(cs.fontSize);
		const large = sizePx >= 24 || (sizePx >= 18.66 && +cs.fontWeight >= 700);
		const min = large ? 3 : 4.5;
		const v = ratio(fg, bg);
		checked++;
		if (v < min) fails.push({ text: el.textContent.trim().slice(0, 40), ratio: +v.toFixed(2), min, where: desc(el) });
	}

	// Non-text (WCAG 1.4.11): the keyboard focus ring and an "on" switch against what they sit on.
	const ui = [];
	let active = document.activeElement;
	while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
	if (active && active !== document.body) {
		const cs = getComputedStyle(active);
		if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 && isVisible(active)) {
			const bg = bgOf(up(active) ?? active);
			const v = ratio(over(parse(cs.outlineColor), bg), bg);
			if (v < 3) ui.push({ what: 'focus ring', where: desc(active), ratio: +v.toFixed(2) });
		}
	}
	for (const el of all.filter((e) => e.matches('.monaco-custom-toggle.checked') && isVisible(e))) {
		const bg = bgOf(up(el) ?? el);
		const v = ratio(over(parse(getComputedStyle(el).backgroundColor), bg), bg);
		if (v < 3) ui.push({ what: 'toggle on', where: desc(el), ratio: +v.toFixed(2) });
	}

	// The accent (button.background, the ember): filled actions on screen. Switches and checkboxes take
	// it as their "on" state (§2.8) and are not counted; a split button counts once.
	const probe = document.createElement('i');
	probe.style.background = 'var(--vscode-button-background)';
	wb.append(probe);
	const accent = parse(getComputedStyle(probe).backgroundColor);
	probe.remove();
	const same = (a, b) => a.slice(0, 3).every((v, k) => Math.abs(v - b[k]) < 2) && a[3] > 0.5;
	const accented = new Set(accent[3] > 0 ? all.filter((e) => isVisible(e) && !e.closest('.monaco-custom-toggle, .monaco-checkbox, .setting-value-checkbox') && same(parse(getComputedStyle(e).backgroundColor), accent)) : []);
	const top = [...accented].filter((e) => { for (let x = up(e); x; x = up(x)) if (accented.has(x)) return false; return true; });
	const groups = [...new Set(top.map((e) => e.closest('.monaco-button-dropdown') ?? e))];

	// Spacing on the 2px half-grid (counted; the editor's text layers position by line and are left out).
	const STYLED = '.part.titlebar, .part.activitybar, .part.statusbar, .quick-input-widget, .monaco-menu, .notification-toast, .notifications-center, .monaco-dialog-box, .tabs-container, .settings-editor, .monaco-hover, .find-widget, .suggest-widget, .monaco-breadcrumbs, .pane-header, .extension-list-item, .peekview-widget, .scm-view';
	const offs = new Map();
	let spacings = 0;
	let off2Count = 0;
	let off2Styled = 0;
	let off4 = 0;
	for (const e of all) {
		if (!isVisible(e) || e.closest('.view-lines, .view-overlays, .margin-view-overlays, .minimap, .xterm-rows')) continue;
		const cs = getComputedStyle(e);
		for (const p of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'rowGap', 'columnGap']) {
			const v = parseFloat(cs[p]);
			if (!v || Number.isNaN(v)) continue;
			spacings++;
			const r2 = Math.abs(v % 2);
			if (r2 > 0.01 && Math.abs(r2 - 2) > 0.01) {
				off2Count++;
				if (e.closest(STYLED)) off2Styled++;
				const k = `${desc(e)} ${p}=${+v.toFixed(2)}`;
				offs.set(k, (offs.get(k) ?? 0) + 1);
			} else {
				const r4 = Math.abs(v % 4);
				if (r4 > 0.01 && Math.abs(r4 - 4) > 0.01) off4++;
			}
		}
	}
	const off2Top = [...offs].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, n]) => `${n}× ${k}`);

	// Controls whose box leaves the window.
	const offscreen = all
		.filter((e) => e.matches('.monaco-button, .monaco-custom-toggle, .monaco-keybinding, .monaco-inputbox, .monaco-select-box, .statusbar-item, .action-item'))
		.filter((e) => {
			const b = e.getBoundingClientRect();
			return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden' && (b.right > innerWidth + 0.5 || b.bottom > innerHeight + 0.5 || b.left < -0.5 || b.top < -0.5);
		})
		.map((e) => `${desc(e)} ${(e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 30)}`);

	return {
		checked, textFails: fails.length, fails: fails.slice(0, 30), ui,
		accentGroups: groups.length, accentWhere: groups.slice(0, 6).map(desc),
		spacings, off2Count, off2Styled, off2Top, off4, offscreen: offscreen.slice(0, 20),
	};
}

let values;
let electron;
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	({ values } = parseArgs({
		options: {
			app: { type: 'string' },
			out: { type: 'string', default: 'workbench-shots' },
			themes: { type: 'string', default: 'fl-dark,fl-light,dark-2026' },
			sizes: { type: 'string', default: '1440x900,1280x800' },
			record: { type: 'boolean', default: false },
			'write-baseline': { type: 'boolean', default: false },
			'strict-gates': { type: 'boolean', default: false },
		},
	}));
	if (!values.app) {
		console.error('Usage: node scripts/workbench-shots.mjs --app <FriedLiver.app|FriedLiver.exe> --out <dir>');
		process.exit(2);
	}
	const sizes = values.sizes.split(',').map((s) => {
		const m = /^(\d{3,4})x(\d{3,4})$/.exec(s.trim());
		if (!m) throw new Error(`bad size ${s} (want WxH, e.g. 1440x900)`);
		return [+m[1], +m[2]];
	});
	const themes = values.themes.split(',');
	for (const t of themes) if (!THEMES[t]) throw new Error(`unknown theme ${t}`);
	({ _electron: electron } = createRequire(path.join(ROOT, 'extensions/friedliver-agents/package.json'))('playwright'));
	const out = path.resolve(values.out);
	const platOut = path.join(out, PLATFORM);
	fs.mkdirSync(platOut, { recursive: true });
	const failures = [];
	const summary = [];
	for (const t of themes) {
		for (const s of sizes) {
			await run(t, s, out, failures, summary).catch((e) => failures.push(`${PLATFORM}/${t}/${s.join('x')}: ${e.message.split('\n')[0]}`));
		}
	}
	if (values.record) await record(out, failures);
	fs.writeFileSync(path.join(platOut, 'gates-summary.txt'), summary.map((s) => s.line).join('\n') + '\n');
	const gateProblems = summary.filter((s) => s.text || s.ui || s.accentMax > 1 || s.off2Styled || s.offscreen);
	if (values['strict-gates']) failures.push(...gateProblems.map((s) => `gates: ${s.line}`));
	fs.writeFileSync(path.join(platOut, 'failures.txt'), failures.join('\n') + '\n');
	console.log(summary.map((s) => s.line).join('\n'));
	if (failures.length) {
		console.error(`\n${failures.length} problem(s):\n${failures.join('\n')}`);
		process.exit(1);
	}
}
