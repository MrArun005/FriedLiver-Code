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

  it('leaves high contrast to upstream', () => {
    // Keyframe steps (from, to, 40%) are not selectors.
    const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, '');
    const selectors = [...rules.matchAll(/(^|})\s*([^{}@]+)\{/g)].map((m) => m[2].trim());
    for (const sel of selectors.flatMap((s) => s.split(/,(?![^(]*\))/).map((x) => x.trim()))) {
      expect(sel, sel).toMatch(/^\.monaco-workbench(?:\.[\w-]+)*(?::not\(\.[\w-]+\))*:not\(\.hc-black\):not\(\.hc-light\)/);
    }
  });
});
