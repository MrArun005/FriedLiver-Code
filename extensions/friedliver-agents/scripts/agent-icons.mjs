#!/usr/bin/env node
// Writes media/agent-<kind>.svg, the chat panel's editor-tab icon, from the marks in src/webview/ui/marks.ts
// (the webview tabs draw the same marks). Run after changing a mark, e.g. the FriedLiver one; test/tabStrip.test.ts checks they agree.
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fl-marks-')), 'marks.mjs');
await build({ entryPoints: [path.join(ext, 'src/webview/ui/marks.ts')], bundle: true, format: 'esm', outfile: out, logLevel: 'error' });
const { markFor } = await import(pathToFileURL(out).href);
// The --hue-* fallbacks in media/tokens.css: an editor tab icon is a file, so it can't read the theme.
const HUE = { claude: '#d97757', codex: '#89d185', gemini: '#57a3f8', demo: '#8c8c8c' };
for (const [agent, colour] of Object.entries(HUE)) {
  const m = markFor(agent);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="${m.viewBox ?? '0 0 16 16'}">` +
    (m.fill ? `<path d="${m.fill}" fill="${colour}"/>` : '') +
    `<path d="${m.d}" fill="none" stroke="${colour}" stroke-width="1.2" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`;
  fs.writeFileSync(path.join(ext, `media/agent-${agent}.svg`), svg);
}
