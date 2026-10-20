// The branding overlay comes from branding/mark.svg (make-branding.mjs); check the generated icons carry every size.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const BRANDING = path.join(__dirname, '..', 'branding');
const read = (rel: string) => fs.readFileSync(path.join(BRANDING, rel));

/** Square sizes in an .ico (0 in the directory means 256). */
function icoSizes(buf: Buffer): number[] {
  return Array.from({ length: buf.readUInt16LE(4) }, (_, i) => buf.readUInt8(6 + 16 * i) || 256);
}

/** Element types in an .icns. */
function icnsTypes(buf: Buffer): string[] {
  const types: string[] = [];
  for (let at = 8; at < buf.readUInt32BE(4); at += buf.readUInt32BE(at + 4)) types.push(buf.toString('latin1', at, at + 4));
  return types;
}

describe('branding', () => {
  it('draws the outline mark from one source', () => {
    const mark = read('mark.svg').toString();
    expect(mark).toContain('viewBox="170 60 760 700"');
    expect(mark).toMatch(/id="liver"[^>]+fill-opacity="\.16"/);
    expect(mark).toContain('id="steam"');
  });

  it('ships the Windows icon at 16-256', () => {
    expect(icoSizes(read('overlay/resources/win32/code.ico'))).toEqual([16, 20, 24, 32, 40, 48, 64, 128, 256]);
    expect(icoSizes(read('overlay/resources/server/favicon.ico'))).toEqual([16, 32, 48]);
  });

  it('ships the macOS icon at 16-1024 with the 2x variants', () => {
    // ic04 16, ic05 32, ic07 128, ic08 256, ic09 512, ic10 1024 (512@2x), ic11 16@2x, ic12 32@2x, ic13 128@2x, ic14 256@2x.
    const types = icnsTypes(read('overlay/resources/darwin/code.icns'));
    for (const t of ['ic04', 'ic05', 'ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14']) expect(types, t).toContain(t);
  });

  it('draws the watermark as the outline mark', () => {
    for (const name of ['dark', 'light', 'hcDark', 'hcLight']) {
      const svg = read(`overlay/src/vs/workbench/browser/parts/editor/media/letterpress-${name}.svg`).toString();
      expect(svg, name).toContain('M200 500C190 380');
      expect(svg, name).toContain('stroke-linejoin="round"');
    }
  });
});
