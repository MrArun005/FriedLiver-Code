// The static UI site (scripts/web-export.mjs, deployed by vercel.json at the repo root) and the forced-colours
// layer in components.css: config that drifts silently unless something checks it.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const EXT = path.resolve(__dirname, '..');
const ROOT = path.resolve(EXT, '..', '..');
const read = (p: string) => fs.readFileSync(p, 'utf8');

describe('the static UI site', () => {
  const script = read(path.join(EXT, 'scripts', 'web-export.mjs'));
  const vercel = JSON.parse(read(path.join(ROOT, 'vercel.json'))) as { buildCommand: string; outputDirectory: string };

  it('Vercel serves the folder the exporter writes', () => {
    expect(script).toMatch(/default: path\.join\(ext, 'web-dist'\)/);
    expect(vercel.outputDirectory).toBe('extensions/friedliver-agents/web-dist');
    expect(vercel.buildCommand).toContain('node esbuild.mjs');
    expect(vercel.buildCommand).toContain('node scripts/web-export.mjs');
    expect(read(path.join(ROOT, '.gitignore'))).toContain('extensions/friedliver-agents/web-dist/');
  });

  it('every page names a surface the harness serves, and file names are unique', () => {
    const pages = [...script.matchAll(/\['([\w-]+)', '[^']+', '[^']+', '([^']+)'\]/g)].map((m) => ({ file: m[1], query: m[2] }));
    expect(pages.length).toBeGreaterThanOrEqual(15);
    expect(new Set(pages.map((p) => p.file)).size).toBe(pages.length);
    for (const { query } of pages) expect(new URLSearchParams(query).get('surface')).toMatch(/^(tasks|chat|images|permissions|accounts|welcome)$/);
  });

  it("moves the fixture's times to the viewer's clock and answers the Images view without a host", () => {
    expect(script).toContain('const shift = Date.now() -');
    expect(script).toContain("startsWith('/host-image')");
  });
});

describe('forced colours (Windows High Contrast)', () => {
  const css = read(path.join(EXT, 'media', 'components.css'));
  const block = css.slice(css.indexOf('@media (forced-colors: active)'));

  it('has a layer', () => expect(css).toContain('@media (forced-colors: active)'));

  it('redraws what only a fill or a shadow drew', () => {
    for (const sel of [".fl-tab[aria-selected='true']", '.fl-toggle', ".fl-toggle[aria-checked='true']::after", '.fl-check__box:checked', '.tl::before', '.seg-bar i', '.apv.fl-card[data-focus]', '.composer:focus-within']) {
      expect(block, sel).toContain(sel);
    }
  });

  it('never lets selection replace the focus ring', () => {
    const selection = block.slice(0, block.indexOf('outline: 2px solid Highlight'));
    for (const line of selection.split('\n').filter((l) => /aria-(selected|checked|pressed)='true'\]/.test(l))) expect(line).toContain(':not(:focus-visible)');
    expect(block).toContain('outline: 3px solid CanvasText');
  });
});
