// The chat composer (message box, mic, attach, /, agents and model pills, mode button, send) is
// approved as it is: the workbench restyle must not touch it. Its menus (model, modes, /, typeahead)
// may change; they live in their own section. The packaged-app check is the computed-style
// baseline in scripts/workbench-shots.mjs; this one catches an edit on every push.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The section lives in webview.css today; the design-system work (ds/components) moves it, unchanged,
// into components.css. Whichever file holds it must hold it unchanged.
const MEDIA = path.resolve(__dirname, '..', 'extensions', 'friedliver-agents', 'media');
const START = '/* ---- Composer (§2.1';
const END = '/* ---- Banners above the composer';
// Change only with the owner's sign-off on the new composer.
// 2026-10-20: owner-authorised v2 restyle (HANDOFF-v2 §B2.3): colours, radii, shadows and the send state only; DOM, sizes and spacing unchanged.
const APPROVED = '5840d5bcaba5d2a36ca44a2fc9413aa92de720cf24e37d0acee6119f6a465aef';

describe('approved composer', () => {
  it('keeps its styles', () => {
    const css = ['components.css', 'webview.css']
      .map((f) => path.join(MEDIA, f))
      .filter((f) => fs.existsSync(f))
      .map((f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'))
      .find((text) => text.includes(START)) ?? '';
    const a = css.indexOf(START);
    const b = css.indexOf(END);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    const hash = crypto.createHash('sha256').update(css.slice(a, b)).digest('hex');
    expect(hash, 'the composer section changed; it is frozen (WORKBENCH-MODERN-PLAN.md, frozen surfaces)').toBe(APPROVED);
  });
});
