// The workbench stylesheet may only use the design system's tokens (and theme colours): no raw
// sizes, colours, shadows or durations. The tokens come from the Agents extension's tokens.css,
// rewritten for the workbench by scripts/workbench-tokens.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOKENS_SOURCE, definedTokens, workbenchTokens } from '../scripts/workbench-tokens.mjs';

const CSS = fs.readFileSync(path.resolve(__dirname, '..', 'workbench', 'friedliver.css'), 'utf8').replace(/\r\n/g, '\n');
const declarations = () =>
  [...CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|[;{])\s*([\w-]+)\s*:\s*([^;{}]+);/g)].map((m) => ({ prop: m[1], value: m[2].trim() }));

/** The value with every var(...) (fallbacks included) taken out. */
function withoutVars(value: string): string {
  let v = value;
  while (/var\([^()]*\)/.test(v)) v = v.replace(/var\([^()]*\)/g, 'V');
  return v;
}

describe('workbench token generation', () => {
  const source = `/* x */
:root {
  --bg: var(--vscode-editor-background, #121314);
  --r-ctl: var(--r-5);
  --r-5: 5px;
}
@media (max-width: 720px) { :root { --gutter: 16px; } }
body.vscode-light,
body.vscode-high-contrast-light { --bg: #fff; }
body.vscode-high-contrast { --r-ctl: 0; }
@media (prefers-reduced-transparency: reduce) { :root { --r-5: 6px; } }
@keyframes rise { from { opacity: 0; } }`;
  const out = workbenchTokens(source);

  it('prefixes the tokens it defines and leaves theme variables alone', () => {
    expect(out).toContain('--fl-bg: var(--vscode-editor-background, #121314);');
    expect(out).toContain('--fl-r-ctl: var(--fl-r-5);');
    expect(out).not.toMatch(/--fl-vscode/);
  });

  it('scopes them to the workbench and its theme kinds', () => {
    expect(out).toMatch(/^\.monaco-workbench \{/m);
    expect(out).toContain('.monaco-workbench.vs,\n.monaco-workbench.hc-light {');
    expect(out).toContain('.monaco-workbench.hc-black {');
    expect(out).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{\n\t\.monaco-workbench \{/);
  });

  it('drops webview layout queries and keyframes', () => {
    expect(out).not.toContain('gutter');
    expect(out).not.toContain('@keyframes');
    expect(definedTokens(out)).toEqual(new Set(['--fl-bg', '--fl-r-ctl', '--fl-r-5']));
  });
});

describe('workbench/friedliver.css', () => {
  it('uses only tokens and theme colours for every value', () => {
    const offenders = declarations()
      .filter(({ prop }) => !prop.startsWith('--'))
      .filter(({ value }) => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\d(?:px|ms|s|em|rem)\b/i.test(withoutVars(value)))
      .map(({ prop, value }) => `${prop}: ${value}`);
    expect(offenders).toEqual([]);
  });

  it('re-points theme colours only at tokens', () => {
    const offenders = declarations()
      .filter(({ prop }) => prop.startsWith('--vscode-'))
      .filter(({ value }) => !/^(?:var\(--fl-[\w-]+\)(?:, var\(--fl-[\w-]+\))*|transparent|color-mix\(.*var\(--fl-.*\))$/.test(value))
      .map(({ prop, value }) => `${prop}: ${value}`);
    expect(offenders).toEqual([]);
  });

  it('reads only tokens the design system defines', () => {
    expect(fs.existsSync(TOKENS_SOURCE), `${TOKENS_SOURCE} is missing (ds/components)`).toBe(true);
    const defined = definedTokens(workbenchTokens(fs.readFileSync(TOKENS_SOURCE, 'utf8')));
    const used = new Set([...CSS.matchAll(/var\((--fl-[\w-]+)/g)].map((m) => m[1]));
    expect([...used].filter((t) => !defined.has(t))).toEqual([]);
  });

  /** The declarations of the rules with a selector ending in `selectorEnd`, merged. */
  function ruleFor(selectorEnd: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!m[1].split(',').some((s) => s.trim().endsWith(selectorEnd))) continue;
      for (const d of m[2].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
    }
    return out;
  }

  it('centres palette row content in the 40px row (W4)', () => {
    // The entry must fill the row, or its centring has no height to work in and labels sit at the top.
    expect(ruleFor('.quick-input-list .quick-input-list-entry')).toMatchObject({ height: '100%', 'align-items': 'center' });
    expect(ruleFor('.quick-input-list .quick-input-list-rows')).toMatchObject({ 'justify-content': 'center' });
  });

  it('keeps the editor and Agents panel attached (W1)', () => {
    for (const part of ['.part.editor', '.part.auxiliarybar']) {
      const rule = ruleFor(`:not(.floating-panels):not(.hc-black):not(.hc-light) ${part}`);
      expect(rule, part).toMatchObject({ margin: '0', 'border-radius': 'var(--fl-r-box) 0 0 0' });
      expect(rule['border-top'], part).toMatch(/var\(--fl-hairline\)/);
      expect(rule['border-left'], part).toMatch(/var\(--fl-hairline\)/);
    }
  });

  it('gives settings words column 1 and the control a 220-320 column, switch rows too (W3)', () => {
    const grid = ruleFor('.setting-item-bool) .setting-item-contents'); // the :is() list, split at its commas
    // A fixed control track: minmax(220, 320) grew to 320 before 1fr got anything, squeezing the words to ~130px.
    expect(grid['grid-template-columns']).toBe('minmax(0, 1fr) clamp(calc(5.5 * var(--fl-h-xl)), 30%, calc(8 * var(--fl-h-xl)))');
    expect(ruleFor('.setting-item-bool .setting-item-value-description')).toMatchObject({ display: 'contents' });
    expect(ruleFor('.setting-item-bool .setting-item-value-description > .setting-item-bool-control')).toMatchObject({ 'grid-column': '2', 'justify-self': 'end' });
    expect(ruleFor('.setting-item-bool .setting-item-value-description > .setting-item-description')).toMatchObject({ 'grid-column': '1' });
  });

  it('shows a neutral tile for an extension icon that does not load, badges on the icon (W6)', () => {
    expect(ruleFor('.extension-list-item > .icon-container > .extension-icon .codicon')).toMatchObject({ 'background-color': 'var(--fl-pill-bg)', width: 'var(--fl-h-lg)', 'border-radius': 'var(--fl-r-8)' });
    expect(ruleFor('.extension-list-item > .icon-container')).toMatchObject({ 'align-self': 'center' });
    expect(ruleFor('.extensions-list .extension-bookmark-container')).toMatchObject({ position: 'static' });
    // Upstream listened for one error, so a failed fallback URL left a blank slot instead of the default icon.
    const patch = fs.readFileSync(path.resolve(__dirname, '..', 'patches', '0190-extension-icon-fallback.patch'), 'utf8');
    expect(patch).toContain('+					if (this.extension?.iconUrlFallback && !triedFallback) {');
    expect(patch).toContain('-				}, { once: true });');
  });

  it('leaves high contrast to upstream', () => {
    // Keyframe steps (from, to, 40%) are not selectors.
    const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, '');
    const selectors = [...rules.matchAll(/(^|})\s*([^{}@]+)\{/g)].map((m) => m[2].trim());
    for (const sel of selectors.flatMap((s) => s.split(/,(?![^(]*\))/).map((x) => x.trim()))) {
      expect(sel, sel).toMatch(/^\.monaco-workbench(?:\.[\w-]+)*(?::not\(\.[\w-]+\))*:not\(\.hc-black\):not\(\.hc-light\)/);
    }
  });
});
