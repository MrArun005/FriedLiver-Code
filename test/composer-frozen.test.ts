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
// 2026-10-20: owner-authorised v2 restyle (HANDOFF-v2 §B2.3): colours, radii, shadows and the send state; and, on the
// owner's later order ("use the whole screen"), the composer spans the chat's width on the transcript's gutters
// instead of a 680px centred column; and Stop (the send while an agent works) is the pill fill, so the accent
// marks only sending. DOM and controls unchanged.
const APPROVED = 'ce8a49b27092bdf28eb632454748fe14768457b858c255d4703b3b5fdc14e260';

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
