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
const css = ['tokens.css', 'webview.css', 'components.css'].map(media).join('\n');
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
/** Hue in degrees (0–360) and the shortest distance between two hues. */
function hue([r, g, b]: RGBA): number {
  const [x, y, z] = [r / 255, g / 255, b / 255];
  const max = Math.max(x, y, z);
  const d = max - Math.min(x, y, z);
  if (!d) return 0;
  const h = max === x ? ((y - z) / d) % 6 : max === y ? (z - x) / d + 2 : (x - y) / d + 4;
  return (h * 60 + 360) % 360;
}
const hueGap = (a: RGBA, b: RGBA) => {
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d);
};
const contrast = (a: RGBA, b: RGBA) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

describe('the design tokens keep WCAG contrast in the 2026 themes and the v2 FriedLiver Dark and Light', () => {
  for (const name of ['dark-2026', 'light-2026', 'friedliver-dark', 'friedliver-light']) {
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
      // Status (QA F06, 2026-10-18): four distinct colours; needs-you is a blue, far from error red and the brand orange.
      const st = (t: string) => resolve(`var(${t})`, vars);
      const [working, done, waiting, failed] = ['--status-working', '--status-done', '--status-waiting', '--status-failed'].map(st);
      expect(new Set([working, done, waiting, failed].map((c) => c.slice(0, 3).join())).size, 'four distinct status colours').toBe(4);
      expect(hueGap(waiting, failed), 'needs-you is not error red').toBeGreaterThanOrEqual(60);
      expect(hueGap(waiting, hex('#d97757')), 'needs-you is not the brand orange').toBeGreaterThanOrEqual(60);
      expect(hue(waiting), 'needs-you is a blue').toBeGreaterThanOrEqual(190);
      expect(hue(waiting)).toBeLessThanOrEqual(230);
      // A dot is a graphic: 3:1 on the page (WCAG 1.4.11).
      for (const [n, c] of Object.entries({ working, done, waiting, failed })) expect(contrast(over(c, bg), bg), `${n} dot on the page`).toBeGreaterThanOrEqual(3);
      // Text on the loud decision fill (counts, the waiting badge).
      expect(contrast(st('--decision-fg'), over(waiting, bg)), 'text on the decision colour').toBeGreaterThanOrEqual(4.5);
      // A toned pill's text on its 14% tint over a card: 4.5:1. The tone mixes toward --fg by --tone-ink (75% dark, 40% light).
      const ink = name.includes('light') ? 0.4 : 0.75;
      if (!name.includes('light')) expect(vars['--tone-ink'], 'dark themes keep 75% of a tone').toBe('75%');
      expect(css, 'the light block keeps --tone-ink at 40%').toMatch(/body\.vscode-light[\s\S]*?--tone-ink: 40%/);
      const fg = st('--fg');
      for (const [n, c] of Object.entries({ working, waiting, failed, warn: st('--warn'), success: st('--tl-success') })) {
        const text: RGBA = [...[0, 1, 2].map((i) => c[i] * ink + fg[i] * (1 - ink)), 1] as RGBA;
        const tint = over([c[0], c[1], c[2], 0.14], menu);
        expect(contrast(text, tint), `${n} pill text on its tint`).toBeGreaterThanOrEqual(4.5);
      }
      // The composer's mic at rest: a bare glyph on the message box, white in dark themes and the
      // text colour in light ones (the body.vscode-light block). Listening: white on the brand blue.
      const idle = resolve(name.includes('light') ? 'var(--fg)' : '#ffffff', vars);
      expect(contrast(idle, surface('--input-bg')), 'idle mic glyph').toBeGreaterThanOrEqual(4.5);
      expect(contrast(resolve('var(--mic-fg)', vars), over(resolve('var(--mic-bg)', vars), surface('--input-bg'))), 'listening mic').toBeGreaterThanOrEqual(4.5);
    });
  }

  it('the listening mic keeps white at 4.5:1 on its brand blue in five themes and with none; idle is white, or the text colour in light themes', () => {
    const json = (file: string) => JSON.parse(readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')).colors;
    const blackBlue = json(path.join(__dirname, '../../friedliver-theme/themes/friedliver-black-blue-color-theme.json'));
    const themes: Record<string, Record<string, string>> = {
      'Black Blue': { '--vscode-button-background': blackBlue['button.background'] },
      'Dark 2026': theme('dark-2026'),
      'Light 2026': theme('light-2026'),
      // VS Code's built-in Dark Modern and Light Modern (dark_modern.json, light_modern.json).
      'Dark Modern': { '--vscode-button-background': '#0078D4' },
      'Light Modern': { '--vscode-button-background': '#005FB8' },
      none: {},
    };
    for (const [name, colors] of Object.entries(themes)) {
      const vars = { ...declarations(block()), ...colors };
      const back = resolve('var(--mic-bg)', vars);
      expect(contrast(resolve('var(--mic-fg)', vars), back), name).toBeGreaterThanOrEqual(4.5);
      expect(back.slice(0, 3), `${name}: the brand blue`).toEqual(hex('#0078d4').slice(0, 3));
    }
    expect(declarations(block())['--mic-idle']).toBe('#fff');
    const light = css.slice(css.indexOf('body.vscode-light,'), css.indexOf('}', css.indexOf('body.vscode-light,')));
    expect(declarations(light)['--mic-idle']).toBe('var(--fg)');
  });

  // Every text token a component in components.css draws on a fill of its own (a pill, a chip, a
  // button…) reads 4.5:1 on that fill, the fill laid over each surface it can sit on. The pairs come
  // from the stylesheet: a rule's colour and background, through its custom properties (--pill-c,
  // --pill-fill), merged with its base rule (.fl-pill under .fl-pill[data-tone='muted']); an element
  // with no fill of its own (.fl-pill__sub) is checked on every fill its block takes, with what a
  // "block-state element" rule gives it there. --disabled and --placeholder are exempt (WCAG 1.4.3:
  // inactive controls, hints). The frozen composer is cut out until its owner signs off a change
  // (test/composer-frozen.test.ts).
  it('text tokens read 4.5:1 on every component fill they are used on, dark and light', () => {
    const TEXT = ['--sel-fg', '--fg', '--fg-2', '--fg-50', '--link', '--inline-code-fg'];
    const raw = media('components.css');
    const frozen = [raw.indexOf('/* ---- Composer (§2.1'), raw.indexOf('/* ---- Banners above the composer')];
    expect(frozen[0]).toBeGreaterThan(-1);
    const sheet = (raw.slice(0, frozen[0]) + raw.slice(frozen[1])).replace(/\/\*[\s\S]*?\*\//g, '');
    // A:is(x, [y]) is A x and A[y] (a tag inside :is adds nothing here).
    const unIs = (sel: string): string[] => {
      const m = /:is\(((?:[^()]|\([^()]*\))*)\)/.exec(sel);
      if (!m) return [sel];
      return m[1].split(/,(?![^(]*\))/).flatMap((a) => unIs(sel.slice(0, m.index) + a.trim().replace(/^[a-z]+/, '') + sel.slice(m.index + m[0].length)));
    };
    // Rules as [compound selector, declarations], one per selector in a list; only single compounds
    // (no descendants), the leading tag dropped (button.fl-pill is .fl-pill). And "block-state
    // element" rules (.fl-row[aria-selected='true'] .fl-row__meta): the element's colour in that state.
    const rules: [string, Record<string, string>][] = [];
    const nested: [string, string, Record<string, string>][] = [];
    for (const m of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const decls = Object.fromEntries(m[2].split(';').filter((d) => d.includes(':')).map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]));
      for (const s of m[1].split(/,(?![^(]*\))/).flatMap((x) => unIs(x.trim().replace(/^[a-z]+(?=[.[:])/, ''))))
        if (/^[.[][^\s>+~]*$/.test(s)) rules.push([s, decls]);
        else if (/^[.[][^\s>+~]*\s*>?\s*\.[^\s>+~]*$/.test(s)) nested.push([...(s.split(/\s*>?\s+|\s*>\s*/) as [string, string]), decls]);
    }
    const base = (s: string) => /^\.([\w-]+?)(?=--|[[:.]|$)/.exec(s)?.[1];
    const quals = (s: string) => s.replace(/^\.[\w-]+?(?=--|[[:.]|$)/, '').match(/--[\w-]+|\[[^\]]+\]|::?[\w-]+(?:\([^)]*\))?|\.[\w-]+/g) ?? [];
    // q applies to p: same base (or q is attribute-only), and each of q's qualifiers is in p ([a] matches [a=…]).
    const applies = (q: string, p: string) =>
      (q.startsWith('[') || base(q) === base(p)) && quals(q).every((t) => quals(p).some((u) => u === t || (t.startsWith('[') && !t.includes('=') && u.startsWith(t.slice(0, -1) + '='))));
    const merged = (p: string) => Object.assign({}, ...rules.filter(([q]) => applies(q, p)).map(([, d]) => d)) as Record<string, string>;
    // Pseudo-elements (::placeholder) are hints, exempt with --placeholder.
    const compounds = [...new Set(rules.map(([s]) => s).filter((s) => !s.startsWith('[') && !s.includes('::')))];
    // A glyph-only part (an icon button, a ×, a twisty) is a graphic: 3:1 (WCAG 1.4.11), not 4.5:1.
    const GLYPH = /--icon\b|__x\b|__twisty\b/;
    const fillOf = (d: Record<string, string>) => {
      const f = d['background'] ?? d['background-color'];
      return f && f !== 'none' && f !== 'transparent' && f !== 'inherit' ? f : undefined;
    };
    /** The text token a colour comes down to through the rule's own custom properties, if any. */
    const textToken = (v: string | undefined, d: Record<string, string>): string | undefined => {
      const m = v && /^var\((--[\w-]+)\)$/.exec(v);
      if (!m) return undefined;
      return TEXT.includes(m[1]) ? m[1] : d[m[1]] !== undefined ? textToken(d[m[1]], d) : undefined;
    };
    const lightAt = tokens.indexOf('body.vscode-light,');
    const light = declarations(tokens.slice(lightAt, tokens.indexOf('}', lightAt)));
    let checked = 0;
    const fails: string[] = [];
    for (const name of ['dark-2026', 'light-2026', 'friedliver-dark', 'friedliver-light']) {
      const vars = { ...declarations(block()), ...theme(name), ...(name.includes('light') ? light : {}) };
      const surfaces = ['--bg', '--input-bg', '--menu-bg', '--dialog-bg'].map((t) => over(resolve(`var(${t})`, vars), resolve('var(--bg)', vars)));
      for (const p of compounds) {
        const d = merged(p);
        if (!textToken(d['color'], d)) continue;
        // Its own fill, or (a BEM element with none) each fill of its block and the block's variants and states.
        const blk = base(p)!.split('__')[0];
        const on: [string, Record<string, string>][] = fillOf(d)
          ? [[p, d]]
          : base(p)!.includes('__')
            ? compounds
                .filter((q) => base(q) === blk || base(q)?.startsWith(`${blk}--`))
                .map((q) => [q, merged(q)] as [string, Record<string, string>])
                .filter(([, e]) => fillOf(e))
            : [];
        for (const [q, e] of on) {
          let fill: RGBA;
          try {
            fill = resolve(fillOf(e)!, { ...vars, ...e });
          } catch {
            continue; // an image or gradient: not a flat fill
          }
          // The element's own colour, or what a "q p" rule gives it there (inherit takes q's colour).
          // ponytail: opacity is not modelled (on its own element it dims fill and text alike).
          const inQ = Object.assign({}, d, ...nested.filter(([a, b]) => q !== p && applies(a, q) && applies(b, p)).map(([, , n]) => n)) as Record<string, string>;
          const t = inQ['color'] === 'inherit' ? textToken(e['color'], e) : textToken(inQ['color'], inQ);
          if (!t) continue;
          const text = resolve(`var(${t})`, vars);
          const min = GLYPH.test(p) ? 3 : 4.5;
          for (const s of surfaces) {
            const under = over(fill, s);
            const ratio = contrast(over(text, under), under);
            checked++;
            if (ratio < min) fails.push(`${name}: ${p} (${t}) on ${q} = ${ratio.toFixed(2)}`);
          }
        }
      }
    }
    expect(checked, 'the pairs come from components.css').toBeGreaterThan(50);
    expect([...new Set(fails)]).toEqual([]);
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
