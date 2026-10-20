#!/usr/bin/env node
/* global Image, btoa, document */ // page.evaluate runs in the browser
// Generate FriedLiver's branding for the VS Code fork from branding/mark.svg (the outline mark, COMPONENTS.md
// "Brand mark"). Every size is drawn at that size (never a big image scaled down), with the stroke tuned per
// size, then written under branding/overlay/ (mirroring upstream; prepare.mjs copies it over the checkout)
// plus branding/icon.png (the Linux icon). The outputs are committed, so builds need none of this.
//
//   node branding/make-branding.mjs [--sheet <out.png>]
//
// Needs Chrome and Playwright (PW_PATH, default ~/code/reportwright/node_modules/playwright-core) and, for the
// .icns, macOS's iconutil. Local only.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'overlay');
const mark = fs.readFileSync(path.join(HERE, 'mark.svg'), 'utf8');
const LIVER = mark.match(/id="liver" d="([^"]+)"/)[1];
const STEAM = mark.match(/id="steam" d="([^"]+)"/)[1];

export const BRAND = '#e2884f';
const GRAPHITE_TOP = '#2e2925';
const GRAPHITE_BOTTOM = '#151210';

/** Stroke in output pixels per icon size: thicker than proportional at small sizes so the outline holds. */
export const STROKE = { 16: 1.5, 20: 1.6, 24: 1.7, 32: 1.75, 40: 2, 48: 2, 64: 2.25, 70: 2.3, 128: 3.25, 150: 3.6, 192: 4.4, 256: 5.5, 512: 10.5, 1024: 20 };
export const stroke = (size) => STROKE[size] ?? Math.max(1.5, size * 0.0195);
// ponytail: a slightly denser fill at <=32px so the shape reads; one threshold, tune if a size looks off.
const fillOpacity = (size) => (size <= 32 ? 0.26 : 0.16);

/** The mark's drawn content spans x 200-900, y 84-738 of its 170 60 760 700 viewBox. */
function markSvg({ cx, cy, width, size, color = BRAND }) {
	// At 16px the steam turns into three grey bars: the liver alone, larger, reads better.
	const steam = size > 16;
	const s = (steam ? width : width * 1.12) / 700; // px per mark unit (content is 700 wide)
	const x = cx - (550 - 170) * s;
	const y = cy - ((steam ? 411 : 528) - 60) * s;
	const w = (s * 760).toFixed(2);
	const h = (s * 700).toFixed(2);
	const sw = stroke(size);
	return `<svg x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w}" height="${h}" viewBox="170 60 760 700" fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round">`
		+ `<path d="${LIVER}" fill="${color}" fill-opacity="${fillOpacity(size)}" stroke-width="${sw}" vector-effect="non-scaling-stroke"/>`
		+ (steam ? `<path d="${STEAM}" stroke-width="${sw}" vector-effect="non-scaling-stroke"/>` : '') + '</svg>';
}

/** macOS: Apple's icon grid (an 824 tile on 1024, radius 185, a soft shadow), graphite, the mark at 68%. */
export function macIcon(size) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">`
		+ `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${GRAPHITE_TOP}"/><stop offset="1" stop-color="${GRAPHITE_BOTTOM}"/></linearGradient>`
		+ `<filter id="sh" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="${size <= 32 ? 0 : 0.3}"/></filter></defs>`
		+ `<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#g)" filter="url(#sh)"/>`
		+ `<rect x="101.5" y="101.5" width="821" height="821" rx="183.5" fill="none" stroke="#fff" stroke-opacity="${size <= 32 ? 0.1 : 0.07}" stroke-width="${Math.max(1, size / 512)}" vector-effect="non-scaling-stroke"/>`
		+ markSvg({ cx: 512, cy: 524, width: 560, size })
		+ '</svg>';
}

/** Windows and Linux: the same tile, Fluent-style (fills more of the square, ~22% radius, no baked shadow). */
export function winIcon(size) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">`
		+ `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${GRAPHITE_TOP}"/><stop offset="1" stop-color="${GRAPHITE_BOTTOM}"/></linearGradient></defs>`
		+ `<rect x="40" y="40" width="944" height="944" rx="208" fill="url(#g)"/>`
		+ `<rect x="41.5" y="41.5" width="941" height="941" rx="206.5" fill="none" stroke="#fff" stroke-opacity="${size <= 32 ? 0.1 : 0.07}" stroke-width="${Math.max(1, size / 512)}" vector-effect="non-scaling-stroke"/>`
		+ markSvg({ cx: 512, cy: 524, width: 640, size })
		+ '</svg>';
}

/** An installer picture: the mark alone on the graphite ground, or the Windows icon on white. */
function picture(w, h, kind) {
	if (kind === 'big') {
		const mw = Math.round(w * 0.66);
		return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${GRAPHITE_BOTTOM}"/>`
			+ markSvg({ cx: w / 2, cy: h * 0.36, width: mw, size: mw }) + '</svg>';
	}
	const s = Math.round(Math.min(w, h) * 0.9);
	const icon = winIcon(s).replace('<svg ', `<svg x="${(w - s) / 2}" y="${(h - s) / 2}" `);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#ffffff"/>${icon}</svg>`;
}

/** The empty-editor watermark in upstream's letterpress tones, drawn as the outline mark. */
function letterpress(fill, opacity) {
	const op = opacity ? ` opacity="${opacity}"` : '';
	return `<svg width="260" height="260" viewBox="170 60 760 700"${op} xmlns="http://www.w3.org/2000/svg">`
		+ `<g fill="none" stroke="${fill}" stroke-width="22" stroke-linecap="round" stroke-linejoin="round">`
		+ `<path d="${LIVER}" fill="${fill}" fill-opacity="0.35"/><path d="${STEAM}"/></g></svg>\n`;
}

// ---- encoders ---------------------------------------------------------------------------------

/** An .ico with PNG entries (Windows Vista and later). */
export function ico(entries) {
	const head = Buffer.alloc(6 + 16 * entries.length);
	head.writeUInt16LE(0, 0);
	head.writeUInt16LE(1, 2);
	head.writeUInt16LE(entries.length, 4);
	let offset = head.length;
	entries.forEach(({ size, png }, i) => {
		const e = 6 + 16 * i;
		head.writeUInt8(size >= 256 ? 0 : size, e);
		head.writeUInt8(size >= 256 ? 0 : size, e + 1);
		head.writeUInt16LE(1, e + 4);
		head.writeUInt16LE(32, e + 6);
		head.writeUInt32LE(png.length, e + 8);
		head.writeUInt32LE(offset, e + 12);
		offset += png.length;
	});
	return Buffer.concat([head, ...entries.map((e) => e.png)]);
}

/** A 24-bit bottom-up BMP from opaque RGBA pixels (Inno Setup's wizard pictures). */
function bmp(w, h, rgba) {
	const stride = Math.ceil((w * 3) / 4) * 4;
	const buf = Buffer.alloc(54 + stride * h);
	buf.write('BM', 0);
	buf.writeUInt32LE(buf.length, 2);
	buf.writeUInt32LE(54, 10);
	buf.writeUInt32LE(40, 14);
	buf.writeInt32LE(w, 18);
	buf.writeInt32LE(h, 22);
	buf.writeUInt16LE(1, 26);
	buf.writeUInt16LE(24, 28);
	buf.writeUInt32LE(stride * h, 34);
	buf.writeInt32LE(2835, 38);
	buf.writeInt32LE(2835, 42);
	for (let y = 0; y < h; y++) {
		const row = 54 + (h - 1 - y) * stride;
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			buf[row + x * 3] = rgba[i + 2];
			buf[row + x * 3 + 1] = rgba[i + 1];
			buf[row + x * 3 + 2] = rgba[i];
		}
	}
	return buf;
}

// ---- rendering --------------------------------------------------------------------------------

async function renderer() {
	const pw = process.env.PW_PATH ?? path.join(os.homedir(), 'code/reportwright/node_modules/playwright-core');
	const { chromium } = createRequire(import.meta.url)(pw);
	const browser = await chromium.launch({ channel: 'chrome', args: ['--use-mock-keychain', '--password-store=basic', '--force-color-profile=srgb'] });
	const page = await browser.newPage();
	/** Draws an SVG at w x h on a canvas; returns PNG bytes, or raw RGBA when `raw`. */
	const draw = async (svg, w, h = w, raw = false) => {
		const out = await page.evaluate(async ([s, w, h, raw]) => {
			const img = new Image();
			img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(s)));
			await img.decode();
			const c = document.createElement('canvas');
			c.width = w;
			c.height = h;
			const ctx = c.getContext('2d');
			ctx.drawImage(img, 0, 0, w, h);
			return raw ? Array.from(ctx.getImageData(0, 0, w, h).data) : c.toDataURL('image/png').split(',')[1];
		}, [svg, w, h, raw]);
		return raw ? Uint8Array.from(out) : Buffer.from(out, 'base64');
	};
	return { browser, page, draw };
}

function save(rel, data) {
	const file = rel.startsWith('/') ? rel : path.join(OUT, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, data);
	console.log('wrote', path.relative(path.dirname(HERE), file));
}

async function main() {
	const { browser, page, draw } = await renderer();
	try {
		// Windows: the app and file icon, Start menu tiles.
		const winSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
		save('resources/win32/code.ico', ico(await Promise.all(winSizes.map(async (size) => ({ size, png: await draw(winIcon(size), size) })))));
		save('resources/win32/code_150x150.png', await draw(winIcon(150), 150));
		save('resources/win32/code_70x70.png', await draw(winIcon(70), 70));

		// Windows installer (Inno Setup) pictures, one per display scale.
		const BIG = { 100: [164, 314], 125: [192, 386], 150: [246, 459], 175: [273, 556], 200: [328, 604], 225: [355, 700], 250: [410, 797] };
		const SMALL = { 100: [55, 55], 125: [64, 68], 150: [83, 80], 175: [92, 97], 200: [110, 106], 225: [119, 123], 250: [138, 140] };
		for (const [scale, [w, h]] of Object.entries(BIG)) save(`resources/win32/inno-big-${scale}.bmp`, bmp(w, h, await draw(picture(w, h, 'big'), w, h, true)));
		for (const [scale, [w, h]] of Object.entries(SMALL)) save(`resources/win32/inno-small-${scale}.bmp`, bmp(w, h, await draw(picture(w, h, 'small'), w, h, true)));

		// macOS app icon: an .iconset (1x and 2x of each point size), packed by iconutil.
		const set = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-icon-')) + '/FriedLiver.iconset';
		fs.mkdirSync(set);
		for (const pt of [16, 32, 128, 256, 512]) {
			fs.writeFileSync(path.join(set, `icon_${pt}x${pt}.png`), await draw(macIcon(pt), pt));
			fs.writeFileSync(path.join(set, `icon_${pt}x${pt}@2x.png`), await draw(macIcon(pt * 2), pt * 2));
		}
		const icns = path.join(OUT, 'resources/darwin/code.icns');
		fs.mkdirSync(path.dirname(icns), { recursive: true });
		execFileSync('iconutil', ['-c', 'icns', set, '-o', icns]);
		fs.rmSync(path.dirname(set), { recursive: true, force: true });
		console.log('wrote overlay/resources/darwin/code.icns');

		// Linux (prepare.mjs copies icon.png), server and web builds.
		save(path.join(HERE, 'icon.png'), await draw(winIcon(1024), 1024));
		save('resources/server/code-192.png', await draw(winIcon(192), 192));
		save('resources/server/code-512.png', await draw(winIcon(512), 512));
		save('resources/server/favicon.ico', ico(await Promise.all([16, 32, 48].map(async (size) => ({ size, png: await draw(winIcon(size), size) })))));

		// Empty-editor watermark (black at 30% on dark, 10% on light, solid greys for high contrast).
		const media = 'src/vs/workbench/browser/parts/editor/media';
		for (const [name, fill, opacity] of [['dark', '#000000', '0.3'], ['light', '#000000', '0.1'], ['hcDark', '#3C3C3C', null], ['hcLight', '#D9D9D9', null]]) {
			save(`${media}/letterpress-${name}.svg`, letterpress(fill, opacity));
		}

		const sheetAt = process.argv.indexOf('--sheet');
		if (sheetAt > 0) await sheet(page, draw, process.argv[sheetAt + 1]);
	} finally {
		await browser.close();
	}
}

/** The review sheet: macOS at 1024/128/32/16 (+4x zooms of 32 and 16), Windows at 256/32/16, dark and light. */
async function sheet(page, draw, out) {
	const uri = async (svg, s) => 'data:image/png;base64,' + (await draw(svg, s)).toString('base64');
	const cell = (src, label, zoom = 1, s) => `<figure><img src="${src}" style="width:${s * zoom}px;height:${s * zoom}px;image-rendering:${zoom > 1 ? 'pixelated' : 'auto'}"><figcaption>${label}</figcaption></figure>`;
	const row = async (bg, fg) => {
		const m = { 1024: await uri(macIcon(1024), 1024), 128: await uri(macIcon(128), 128), 32: await uri(macIcon(32), 32), 16: await uri(macIcon(16), 16) };
		const w = { 256: await uri(winIcon(256), 256), 32: await uri(winIcon(32), 32), 16: await uri(winIcon(16), 16) };
		return `<section style="background:${bg};color:${fg}">`
			+ cell(m[1024], 'macOS 1024', 1, 1024) + cell(m[128], 'macOS 128', 1, 128) + cell(m[32], 'macOS 32', 1, 32) + cell(m[16], 'macOS 16', 1, 16)
			+ cell(m[32], 'macOS 32 ×4', 4, 32) + cell(m[16], 'macOS 16 ×4', 4, 16)
			+ cell(w[256], 'Windows 256', 1, 256) + cell(w[32], 'Windows 32', 1, 32) + cell(w[16], 'Windows 16', 1, 16) + cell(w[16], 'Windows 16 ×4', 4, 16)
			+ '</section>';
	};
	await page.setViewportSize({ width: 2400, height: 1200 });
	await page.setContent(`<style>body{margin:0;font:13px system-ui}section{display:flex;flex-wrap:wrap;align-items:flex-end;gap:32px;padding:32px}figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:8px}</style>${await row('#1e1b19', '#e9e5e2')}${await row('#f6f3f0', '#242220')}`);
	fs.mkdirSync(path.dirname(out), { recursive: true });
	await page.screenshot({ path: out, fullPage: true });
	console.log('wrote', out);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
