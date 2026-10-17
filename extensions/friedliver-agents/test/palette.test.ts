// The chat's 60/30/10 palette (media/webview.css, between the palette markers),
// resolved against Dark Modern and Light Modern with the default orange accent,
// must keep WCAG contrast: body text 7:1, secondary text and links 4.5:1, and
// the accent, used only as a border, 3:1 against the surfaces it edges.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.join(__dirname, '../media/webview.css'), 'utf8');
const block = (name: string) => {
  const m = css.match(new RegExp(`/\\* ${name}:start \\*/([\\s\\S]*?)/\\* ${name}:end \\*/`));
  if (!m) throw new Error(`no ${name} block`);
  return Object.fromEntries([...m[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()]));
};

type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const NAMED: Record<string, RGB | null> = { black: [0, 0, 0], white: [255, 255, 255], transparent: null };

/** Resolves var() and color-mix(in srgb, A p%, B) to a colour; transparent mixes become alpha-blended over the background. */
function resolve(expr: string, vars: Record<string, string>, bg: RGB): RGB {
  expr = expr.trim();
  if (expr.startsWith('#')) return hex(expr);
  if (expr in NAMED) return NAMED[expr] ?? bg;
  const v = expr.match(/^var\((--[\w-]+)(?:,\s*([\s\S]+))?\)$/);
  if (v) return vars[v[1]] !== undefined ? resolve(vars[v[1]], vars, bg) : resolve(v[2]!, vars, bg);
  const mix = expr.match(/^color-mix\(in srgb,\s*([\s\S]+)\)$/);
  if (mix) {
    // Split on the top-level comma.
    let depth = 0;
    let cut = -1;
    for (let i = 0; i < mix[1].length; i++) {
      const c = mix[1][i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) cut = i;
    }
    const [a, b] = [mix[1].slice(0, cut), mix[1].slice(cut + 1)];
    const pa = a.match(/^([\s\S]+?)\s+([\d.]+)%\s*$/);
    const p = pa ? Number(pa[2]) / 100 : 0.5;
    const ca = resolve(pa ? pa[1] : a, vars, bg);
    const cb = resolve(b, vars, bg);
    return ca.map((x, i) => x * p + cb[i] * (1 - p)) as RGB;
  }
  throw new Error(`can't resolve ${expr}`);
}

const lum = ([r, g, b]: RGB) => {
  const f = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

const THEMES = {
  'Dark Modern': { light: false, v: { 'editor-background': '#1f1f1f', foreground: '#cccccc', descriptionForeground: '#9d9d9d', 'button-background': '#0078d4', 'charts-green': '#89d185', 'charts-yellow': '#cca700', errorForeground: '#f85149', 'textLink-foreground': '#4daafc' } },
  'Light Modern': { light: true, v: { 'editor-background': '#ffffff', foreground: '#3b3b3b', descriptionForeground: '#717171', 'button-background': '#005fb8', 'charts-green': '#388a34', 'charts-yellow': '#bf8803', errorForeground: '#f85149', 'textLink-foreground': '#005fb8' } },
};

describe('the chat palette keeps WCAG contrast', () => {
  for (const [name, theme] of Object.entries(THEMES)) {
    it(name, () => {
      const vars: Record<string, string> = { '--fl-accent': '#D97757', ...block('palette'), ...(theme.light ? block('palette-light') : {}) };
      for (const [k, v] of Object.entries(theme.v)) vars[`--vscode-${k}`] = v;
      const bg = hex(theme.v['editor-background']);
      const c = (token: string) => resolve(`var(${token})`, vars, bg);
      const on = (fg: string, back: string) => contrast(c(fg), c(back));
      // Text (WCAG 1.4.6): body 7:1, secondary and links 4.5:1, on every surface text sits on.
      for (const back of ['--c-bg', '--c-surface', '--c-surface2']) {
        expect(on('--c-text', back), `text on ${back}`).toBeGreaterThanOrEqual(7);
        expect(on('--c-soft', back), `soft on ${back}`).toBeGreaterThanOrEqual(7);
        expect(on('--c-mute', back), `mute on ${back}`).toBeGreaterThanOrEqual(4.5);
        expect(on('--c-link', back), `link on ${back}`).toBeGreaterThanOrEqual(4.5);
        // Non-text (WCAG 1.4.11): the accent is only a border, 3:1 against what it edges.
        expect(on('--c-acc', back), `accent border on ${back}`).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
