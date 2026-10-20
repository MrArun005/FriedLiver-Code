// FriedLiver Icons (product icon theme) and FriedLiver Files (file-icon theme), COMPONENTS.md §1.6, §6.3, §6.21.
// The font itself is regenerated and compared in CI (`node scripts/build-icon-font.mjs --check`, which needs
// the Python tools); these checks are the pure-JS half: sources, the generated maps and the manifest.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FILE_COLORS, FIRST_CODEPOINT, ICONS, outputs, readGlyphs } from '../scripts/build-icon-font.mjs';

const EXT = path.join(ICONS, '..');
const src = readGlyphs();
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));

/** The ids spec §6.21 names (plus the ten common symbol-* ids). */
const SPEC_IDS = [
  'files', 'search', 'source-control', 'debug-alt', 'extensions', 'account', 'settings-gear', 'chevron-right', 'chevron-down', 'close', 'add',
  'ellipsis', 'split-horizontal', 'layout-sidebar-left', 'layout-sidebar-right', 'layout-panel', 'bell', 'sync', 'git-branch', 'error', 'warning',
  'info', 'check', 'circle-filled', 'circle-outline', 'terminal', 'file', 'folder', 'folder-opened', 'json', 'markdown', 'play', 'debug-stop',
  'refresh', 'filter', 'list-flat', 'list-tree', 'collapse-all', 'new-file', 'new-folder', 'go-to-file', 'copy', 'trash', 'edit', 'pin', 'pinned',
  'history', 'comment', 'sparkle', 'keyboard', 'globe', 'zap',
  'symbol-method', 'symbol-function', 'symbol-field', 'symbol-variable', 'symbol-class', 'symbol-interface', 'symbol-module', 'symbol-property',
  'symbol-constant', 'symbol-keyword',
];

/** Every number in path data (SVG numbers may run together: "1.5.5", "-.01"). */
const numbers = (d: string) => [...d.matchAll(/-?(?:\d+\.?\d*|\.\d+)/g)].map((m) => Number(m[0]));

describe('glyph sources', () => {
  it('are strokes of 1.5 on a 16 grid', () => {
    expect(src.grid).toBe(16);
    expect(src.stroke).toBe(1.5);
  });

  it('cover every spec id', () => {
    expect(SPEC_IDS.filter((id) => !(id in src.product))).toEqual([]);
  });

  it('are path data only, no colours', () => {
    const all = [...Object.values(src.product).flatMap((g: { d: string; fill?: string }) => [g.d, g.fill ?? '']), ...(Object.values(src.files) as string[])];
    for (const d of all) {
      expect(d).toMatch(/^[MmLlHhVvCcSsQqTtAaZz\d\s.,-]*$/);
      // Absolute coordinates stay inside the 16 box (relative steps are small by construction).
      for (const n of numbers(d)) expect(Math.abs(n), d).toBeLessThanOrEqual(16);
    }
  });
});

describe('generated files', () => {
  const want = outputs(src, () => Buffer.alloc(0));

  it('match glyphs.json (except the font, which CI rebuilds)', () => {
    for (const [rel, contents] of Object.entries(want)) {
      if (rel.endsWith('.woff2')) continue;
      expect(fs.readFileSync(path.join(ICONS, rel), 'utf8').replace(/\r\n/g, '\n'), rel).toBe(contents); // Windows checkouts may use CRLF
    }
    expect(fs.statSync(path.join(ICONS, 'friedliver-icons.woff2')).size).toBeGreaterThan(1000);
  });

  it('map every product id to its own private-use codepoint', () => {
    const defs = JSON.parse(fs.readFileSync(path.join(ICONS, 'friedliver-icons.json'), 'utf8')).iconDefinitions;
    const ids = Object.keys(src.product);
    expect(Object.keys(defs)).toEqual(ids);
    ids.forEach((id, i) => expect(defs[id].fontCharacter).toBe(`\\${(FIRST_CODEPOINT + i).toString(16).toUpperCase()}`));
  });

  it('file icons reference only SVGs that exist, drawn in --fg-2', () => {
    const theme = JSON.parse(fs.readFileSync(path.join(ICONS, 'friedliver-files.json'), 'utf8'));
    for (const { iconPath } of Object.values(theme.iconDefinitions) as { iconPath: string }[]) {
      const svg = fs.readFileSync(path.join(ICONS, iconPath), 'utf8');
      expect(svg).toContain(`stroke="${iconPath.endsWith('-light.svg') ? FILE_COLORS.light : FILE_COLORS.dark}"`);
      expect(svg).toContain('stroke-width="1.5"');
    }
    const ids = new Set(Object.keys(theme.iconDefinitions));
    const used = (t: Record<string, unknown>) => [t.file, t.folder, t.folderExpanded, ...Object.values(t.fileExtensions as object), ...Object.values(t.fileNames as object)];
    for (const id of [...used(theme), ...used(theme.light)]) expect(ids.has(id as string), String(id)).toBe(true);
    expect(used(theme.light).every((id) => String(id).endsWith('-light'))).toBe(true);
  });
});

it('the theme extension contributes both icon themes and makes them the defaults', () => {
  expect(manifest.contributes.productIconThemes).toEqual([{ id: 'friedliver-icons', label: 'FriedLiver Icons', path: './icons/friedliver-icons.json' }]);
  expect(manifest.contributes.iconThemes).toEqual([{ id: 'friedliver-files', label: 'FriedLiver Files', path: './icons/friedliver-files.json' }]);
  expect(manifest.contributes.configurationDefaults['workbench.productIconTheme']).toBe('friedliver-icons');
  expect(manifest.contributes.configurationDefaults['workbench.iconTheme']).toBe('friedliver-files');
});
