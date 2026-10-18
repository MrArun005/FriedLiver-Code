#!/usr/bin/env node
// The workbench visual harness: launch a packaged FriedLiver with a throwaway profile, open each
// workbench surface programmatically and screenshot it, in a dark and a light theme. Also guards
// the approved chat composer: its computed styles must match the committed baseline.
//
//   node scripts/workbench-shots.mjs --app /path/FriedLiver.app --out shots [--themes dark,light]
//       [--write-baseline]
//
// CI only (.github/workflows/workbench-shots.yml, macos-latest). No network sign-ins: a fresh
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
// FriedLiver's defaults, and the owner's own theme (the composer was approved in it).
export const THEMES = { dark: 'FriedLiver Black Blue', light: 'FriedLiver Light Blue', 'dark-2026': 'Dark 2026' };
const W = 1440;
const H = 900;

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
};
const keyOf = Object.fromEntries(Object.entries(COMMANDS).map(([k, c]) => [c, k]));

// What the composer's look is made of. Width is left out: it follows the view, not the composer.
const COMPOSER_PARTS = ['.composer', '.composer textarea', '.composer-bar', '.attach-btn', '.cc-slash-btn', '.cc-pill.cc-model', '.cc-mode', '.cc-mic', '.send-btn'];
const COMPOSER_PROPS = [
	'background-color', 'color', 'border-top-color', 'border-top-width', 'border-top-style', 'border-radius', 'box-shadow',
	'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'padding', 'margin', 'gap', 'height', 'min-height', 'opacity',
];

function fixture(dir) {
	fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'package.json'), '{\n  "name": "prices",\n  "private": true,\n  "version": "1.0.0"\n}\n');
	fs.writeFileSync(path.join(dir, 'README.md'), '# Prices\n\nFormats prices in cents.\n');
	fs.writeFileSync(path.join(dir, 'src', 'cart.ts'), "import { formatCents } from './format';\n\nexport const total = (items: number[]) => formatCents(items.reduce((a, b) => a + b, 0));\n");
	fs.writeFileSync(
		path.join(dir, 'src', 'format.ts'),
		'/** Formats an amount in cents as dollars, e.g. 1999 -> "$19.99". */\nexport function formatCents(cents: number): string {\n  if (!Number.isFinite(cents)) {\n    throw new Error(`not a number: ${cents}`);\n  }\n  return `$${(cents / 100).toFixed(2)}`;\n}\n\nexport const ZERO = formatCents(0);\n',
	);
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
		'friedliver.showDemoAgent': true,
		'extensions.autoCheckUpdates': false,
		'extensions.autoUpdate': false,
		'telemetry.telemetryLevel': 'off',
		'security.workspace.trust.enabled': false,
		'git.enabled': false,
	}, null, 2));
	fs.writeFileSync(path.join(user, 'keybindings.json'), JSON.stringify(
		Object.entries(COMMANDS).map(([k, command]) => ({ key: `ctrl+alt+shift+${k}`, command })), null, 2));
}

function executable(app) {
	const name = execFileSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
	return path.join(app, 'Contents', 'MacOS', name);
}

async function run(themeKey, out, failures) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flwb-')); // short: the app's sockets live under it
	const ws = path.join(dir, 'ws');
	fixture(ws);
	profile(dir, THEMES[themeKey]);
	const app = await electron.launch({
		executablePath: executable(path.resolve(values.app)),
		args: [
			ws,
			// Opened as editors at startup: README, package.json, cart.ts, then format.ts in front.
			...['README.md', 'package.json', 'src/cart.ts', 'src/format.ts'].map((f) => path.join(ws, f)),
			`--user-data-dir=${path.join(dir, 'data')}`,
			`--extensions-dir=${path.join(dir, 'ext')}`,
			`--extensionDevelopmentPath=${path.join(HARNESS, 'ext')}`,
			'--use-mock-keychain', '--password-store=basic',
			'--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-updates',
		],
		timeout: 120_000,
	});
	const win = await app.firstWindow({ timeout: 120_000 });
	await app.evaluate(({ BrowserWindow }, [w, h]) => {
		const b = BrowserWindow.getAllWindows()[0];
		b.setContentSize(w, h);
		b.center();
	}, [W, H]);
	// The runner's screen may be shorter than 900px; emulate the viewport so every shot is 1440x900.
	await win.setViewportSize({ width: W, height: H });
	await win.waitForSelector('.monaco-workbench', { timeout: 120_000 });
	await win.waitForTimeout(8000);

	const wait = (ms) => win.waitForTimeout(ms);
	const cmd = async (command, ms = 900) => {
		await win.keyboard.press(`Control+Alt+Shift+Key${keyOf[command].toUpperCase()}`);
		await wait(ms);
	};
	const escape = async (n = 2) => {
		for (let i = 0; i < n; i++) await win.keyboard.press('Escape');
		await wait(300);
	};
	const shot = async (name) => {
		const file = path.join(out, themeKey, `${name}.png`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		await win.screenshot({ path: file });
		console.log(`${themeKey}/${name}`);
	};
	const step = async (name, fn) => {
		try {
			await fn();
		} catch (e) {
			failures.push(`${themeKey}/${name}: ${e.message.split('\n')[0]}`);
			console.error(`FAILED ${themeKey}/${name}: ${e.message}`);
			await escape(3).catch(() => {});
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

	await cmd('notifications.clearAll', 300);
	await step('01-workbench', async () => {
		await cmd('workbench.view.explorer');
		await win.locator('.tabs-container .tab', { hasText: 'format.ts' }).first().waitFor({ timeout: 30_000 });
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
		await win.keyboard.press('Meta+Z');
		await win.keyboard.press('Meta+Z');
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
		const styles = await chat.evaluate(([parts, props]) => {
			const out = {};
			for (const sel of parts) {
				const el = document.querySelector(sel);
				if (!el) {
					out[sel] = null;
					continue;
				}
				const cs = window.getComputedStyle(el);
				out[sel] = Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
			}
			return out;
		}, [COMPOSER_PARTS, COMPOSER_PROPS]);
		const file = `composer-${themeKey}.json`;
		fs.writeFileSync(path.join(out, file), JSON.stringify(styles, null, 2) + '\n');
		const baseline = path.join(HARNESS, file);
		if (values['write-baseline']) {
			fs.copyFileSync(path.join(out, file), baseline);
		} else if (fs.existsSync(baseline)) {
			const diff = diffStyles(JSON.parse(fs.readFileSync(baseline, 'utf8')), styles);
			if (diff.length) failures.push(`${themeKey}: the approved composer changed:\n  ${diff.join('\n  ')}`);
		} else {
			failures.push(`${themeKey}: no composer baseline at ${path.relative(ROOT, baseline)} (run with --write-baseline once)`);
		}
		await chat.locator('.cc-pill.cc-model').first().click();
		await wait(800);
		await shot('18-composer-model-menu');
		await win.keyboard.press('Escape');
	});

	await app.close();
	fs.rmSync(dir, { recursive: true, force: true });
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

let values;
let electron;
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	({ values } = parseArgs({
		options: {
			app: { type: 'string' },
			out: { type: 'string', default: 'workbench-shots' },
			themes: { type: 'string', default: 'dark,light,dark-2026' },
			'write-baseline': { type: 'boolean', default: false },
		},
	}));
	if (!values.app) {
		console.error('Usage: node scripts/workbench-shots.mjs --app <FriedLiver.app> --out <dir>');
		process.exit(2);
	}
	({ _electron: electron } = createRequire(path.join(ROOT, 'extensions/friedliver-agents/package.json'))('playwright'));
	const out = path.resolve(values.out);
	fs.mkdirSync(out, { recursive: true });
	const failures = [];
	for (const t of values.themes.split(',')) {
		if (!THEMES[t]) throw new Error(`unknown theme ${t}`);
		await run(t, out, failures);
	}
	fs.writeFileSync(path.join(out, 'failures.txt'), failures.join('\n') + '\n');
	if (failures.length) {
		console.error(`\n${failures.length} problem(s):\n${failures.join('\n')}`);
		process.exit(1);
	}
}
