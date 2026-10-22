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
process.on('exit', () => fs.rmSync(path.dirname(out), { recursive: true, force: true }));
await build({ entryPoints: [path.join(ext, 'src/webview/ui/marks.ts')], bundle: true, format: 'esm', outfile: out, logLevel: 'error' });
const { markFor } = await import(pathToFileURL(out).href);
// The agents' v2 hues (package.json friedliver.agent* defaults; tokens.css --hue-*): an editor tab icon is a
// file, so it can't read the theme; the tab gets { dark, light } (extension.ts). Neutral agents use --fg-2.
const HUE = {
  dark: { claude: '#ebaf86', codex: '#8bd9c9', gemini: '#a9b6f5', antigravity: '#aca8a5', copilot: '#aca8a5', demo: '#aca8a5', custom: '#aca8a5' },
  light: { claude: '#984b16', codex: '#037465', gemini: '#4e59b1', antigravity: '#5e5c59', copilot: '#5e5c59', demo: '#5e5c59', custom: '#5e5c59' },
};
// Logos keep their vendors' colours (ui/logos.ts; --logo-* in tokens.css); OpenAI's is monochrome.
const LOGO = {
  dark: { 'var(--logo-claude)': '#d97757', 'var(--logo-openai)': '#e9e5e2', 'var(--logo-gemini)': '#8e75b2', 'var(--logo-github)': '#e9e5e2' },
  light: { 'var(--logo-claude)': '#d97757', 'var(--logo-openai)': '#242220', 'var(--logo-gemini)': '#8e75b2', 'var(--logo-github)': '#242220' },
};
// `custom`: every agent from friedliver.agents.custom gets the neutral glyph (markFor of an unknown agent).
for (const [kind, hues] of Object.entries(HUE))
  for (const [agent, colour] of Object.entries(hues)) {
    const m = markFor(agent);
    const open = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="${m.viewBox ?? '0 0 16 16'}">`;
    const svg = m.svg
      ? `${open}${m.svg}</svg>\n`
      : m.logo
        ? `${open}<path d="${m.d}" fill="${LOGO[kind][m.logo.color]}"/></svg>\n`
        : open +
          (m.fill ? `<path d="${m.fill}" fill="${colour}" fill-opacity=".16" stroke="${colour}" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>` : '') +
          `<path d="${m.d}" fill="none" stroke="${colour}" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`;
    fs.writeFileSync(path.join(ext, `media/agent-${agent}${kind === 'light' ? '-light' : ''}.svg`), svg);
  }
