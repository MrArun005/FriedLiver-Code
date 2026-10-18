// The chat composer (message box, mic, attach, /, agents and model pills, mode button, send) is
// approved as it is: the workbench restyle must not touch it. Its menus (model, modes, /, typeahead)
// may change; they live in their own section. The packaged-app check is the computed-style
// baseline in scripts/workbench-shots.mjs; this one catches an edit on every push.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = path.resolve(__dirname, '..', 'extensions', 'friedliver-agents', 'media', 'webview.css');
const START = '/* ---- Composer (§2.1';
const END = '/* ---- Banners above the composer';
// Change only with the owner's sign-off on the new composer.
const APPROVED = '55b16fb5d2b0669d520938102b661efd24162884f1e08940c1ba8e61b5eab129';

describe('approved composer', () => {
  it('keeps its styles', () => {
    const css = fs.readFileSync(CSS, 'utf8').replace(/\r\n/g, '\n');
    const a = css.indexOf(START);
    const b = css.indexOf(END);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    const hash = crypto.createHash('sha256').update(css.slice(a, b)).digest('hex');
    expect(hash, 'the composer section of webview.css changed; it is frozen (WORKBENCH-MODERN-PLAN.md, frozen surfaces)').toBe(APPROVED);
  });
});
