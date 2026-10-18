// The design tokens (media/tokens.css, between the tokens markers), resolved
// against Dark 2026 and Light 2026 (test/fixtures/theme-*-2026.css), must keep
// WCAG contrast: body text 7:1, secondary text and links 4.5:1 on every surface
// text sits on, selected rows readable, and hover never the same as selected.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const media = (f: string) => readFileSync(path.join(__dirname, '../media', f), 'utf8');
const tokens = media('tokens.css');
// Every stylesheet a view loads, in order: the var()s they read must all be defined.
const css = ['tokens.css', 'components.css', 'webview.css'].map(media).join('\n');
const declarations = (text: string) => Object.fromEntries([...text.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()]));
const block = () => {
  const m = tokens.match(/\/\* tokens:start \*\/([\s\S]*?)\/\* tokens:end \*\//);
  if (!m) throw new Error('no tokens block');
  return m[1];
};
const theme = (name: string) => declarations(readFileSync(path.join(__dirname, `fixtures/theme-${name}.css`), 'utf8'));

type RGBA = [number, number, number, number];
function hex(h: string): RGBA {
  const v = h.slice(1);
  const n = v.length <= 4 ? [...v].map((c) => parseInt(c + c, 16)) : (v.match(/../g) ?? []).map((c) => parseInt(c, 16));
  return [n[0], n[1], n[2], n.length > 3 ? n[3] / 255 : 1];
}
const over = (top: RGBA, under: RGBA): RGBA => [...[0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])), 1] as RGBA;

/** Resolves var() and color-mix(in srgb, A p%, B) to a colour; translucency stays as alpha. */
function resolve(expr: string, vars: Record<string, string>): RGBA {
  expr = expr.trim();
  if (expr.startsWith('#')) return hex(expr);
  if (expr === 'transparent') return [0, 0, 0, 0];
  const v = expr.match(/^var\((--[\w-]+)(?:,\s*([\s\S]+))?\)$/);
  if (v) return vars[v[1]] !== undefined ? resolve(vars[v[1]], vars) : resolve(v[2]!, vars);
  const mix = expr.match(/^color-mix\(in srgb,\s*([\s\S]+)\)$/);
  if (mix) {
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
    const ca = resolve(pa ? pa[1] : a, vars);
    const cb = resolve(b, vars);
    // Premultiplied, as CSS mixes.
    const alpha = ca[3] * p + cb[3] * (1 - p);
    if (!alpha) return [0, 0, 0, 0];
    return [...[0, 1, 2].map((i) => (ca[i] * ca[3] * p + cb[i] * cb[3] * (1 - p)) / alpha), alpha] as RGBA;
  }
  throw new Error(`can't resolve ${expr}`);
}

const lum = ([r, g, b]: RGBA) => {
  const f = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: RGBA, b: RGBA) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

describe('the design tokens keep WCAG contrast in the 2026 themes', () => {
  for (const name of ['dark-2026', 'light-2026']) {
    it(name, () => {
      const vars = { ...declarations(block()), ...theme(name) };
      const bg = resolve('var(--bg)', vars);
      // A surface as it shows: over the transcript background.
      const surface = (t: string) => over(resolve(`var(${t})`, vars), bg);
      for (const t of ['--bg', '--input-bg', '--menu-bg', '--dialog-bg']) {
        const back = surface(t);
        const on = (fg: string) => contrast(over(resolve(`var(${fg})`, vars), back), back);
        expect(on('--fg'), `fg on ${t}`).toBeGreaterThanOrEqual(7);
        expect(on('--fg-2'), `fg-2 on ${t}`).toBeGreaterThanOrEqual(4.5);
        expect(on('--link'), `link on ${t}`).toBeGreaterThanOrEqual(4.5);
      }
      // A selected menu row: its text and icons on its fill, over the menu.
      const menu = surface('--menu-bg');
      const sel = over(resolve('var(--sel-bg)', vars), menu);
      const hover = over(resolve('var(--hover-bg)', vars), menu);
      expect(contrast(resolve('var(--sel-fg)', vars), sel), 'selected text').toBeGreaterThanOrEqual(7);
      expect(contrast(sel, menu), 'the selected row stands off the menu').toBeGreaterThan(1.15);
      expect(sel.slice(0, 3), 'hover differs from selected').not.toEqual(hover.slice(0, 3));
      // The composer's mic: a white glyph on the theme's button blue, at rest and hovered.
      for (const t of ['--mic-bg', '--mic-hover']) {
        const back = over(resolve(`var(${t})`, vars), surface('--input-bg'));
        expect(contrast(resolve('var(--mic-fg)', vars), back), `mic glyph on ${t}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('the mic keeps a white glyph at 4.5:1 on its brand blue in five themes and with none', () => {
    const json = (file: string) => JSON.parse(readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')).colors;
    const blackBlue = json(path.join(__dirname, '../../friedliver-theme/themes/friedliver-black-blue-color-theme.json'));
    const fixture = (name: string) => theme(name);
    const themes: Record<string, Record<string, string>> = {
      'Black Blue': { '--vscode-button-background': blackBlue['button.background'], '--vscode-button-hoverBackground': blackBlue['button.hoverBackground'] },
      'Dark 2026': fixture('dark-2026'),
      'Light 2026': fixture('light-2026'),
      // VS Code's built-in Dark Modern and Light Modern (dark_modern.json, light_modern.json).
      'Dark Modern': { '--vscode-button-background': '#0078D4', '--vscode-button-hoverBackground': '#026EC1' },
      'Light Modern': { '--vscode-button-background': '#005FB8', '--vscode-button-hoverBackground': '#0258A8' },
      none: {},
    };
    expect(blackBlue['button.background']).toBe('#7cc4ff');
    for (const [name, colors] of Object.entries(themes)) {
      const vars = { ...declarations(block()), ...colors };
      for (const t of ['--mic-bg', '--mic-hover']) {
        const back = resolve(`var(${t})`, vars);
        expect(contrast(resolve('var(--mic-fg)', vars), back), `${name} ${t}`).toBeGreaterThanOrEqual(4.5);
        expect(back.slice(0, 3), `${name} ${t} is the brand blue`).toEqual(hex(t === '--mic-bg' ? '#0078d4' : '#026ec1').slice(0, 3));
      }
    }
  });

  it('defines each token once, and every var() the stylesheet reads', () => {
    const names = [...block().matchAll(/(--[\w-]+):/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    // Components set some inline (style={{ '--at': … }}); a var() with a fallback (--fl-accent) may be unset.
    const webview = path.join(__dirname, '../src/webview');
    const inline = new Set((readdirSync(webview, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f)).flatMap((f) => [...readFileSync(path.join(webview, f), 'utf8').matchAll(/'(--[\w-]+)':/g)].map((m) => m[1])));
    const read = new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]).filter((n) => !n.startsWith('--vscode-')));
    expect([...read].filter((n) => !defined.has(n) && !inline.has(n))).toEqual([]);
  });
});
