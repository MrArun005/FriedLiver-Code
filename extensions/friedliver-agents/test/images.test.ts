import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_PREVIEW_BYTES, previewableImage } from '../src/host/imageAccess';
import type { Item } from '../src/shared/model';
import { chatImages, humanTitle, isImagePath, stepImage } from '../src/shared/stepImages';

type Tool = Extract<Item, { kind: 'tool' }>;
const tool = (over: Partial<Tool>): Tool => ({ kind: 'tool', id: 't1', title: 'Read', locations: [], ...over });

describe('which steps are images', () => {
  it('knows image files by extension', () => {
    for (const f of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.svg']) expect(isImagePath(f)).toBe(true);
    for (const f of ['a.ts', 'png', 'a.png.txt', '', 'a.tiff']) expect(isImagePath(f)).toBe(false);
  });
  it('a Read of an image', () => {
    expect(stepImage(tool({ locations: ['/w/docs/login-page_final.png'] }))).toEqual({ path: '/w/docs/login-page_final.png', title: 'Login page final' });
    expect(stepImage(tool({ locations: ['/w/src/a.ts'] }))).toBeNull();
  });
  it('a browser screenshot: the path from its result, the title from its first line', () => {
    const t = tool({ title: 'browser_screenshot', out: [{ t: 'text', text: 'Screenshot of myntra.com/puma\nSaved to /store/shots-x/screenshot-3.png. Read that file to see it.' }] });
    expect(stepImage(t)).toEqual({ path: '/store/shots-x/screenshot-3.png', title: 'Screenshot of myntra.com/puma' });
  });
  it("the step's own description wins", () => {
    expect(stepImage(tool({ locations: ['/w/x.png'], about: 'The header after the fix' }))?.title).toBe('The header after the fix');
  });
  it('humanises file names', () => {
    expect(humanTitle('/a/b/screenshot-12.png')).toBe('Screenshot 12');
    expect(humanTitle('my_photo.final.jpeg')).toBe('My photo final');
  });
  it('lists a chat’s images once each, in order', () => {
    const items: Item[] = [tool({ id: 'a', locations: ['/w/a.png'] }), { kind: 'agent', text: 'hi' }, tool({ id: 'b', locations: ['/w/a.png'] }), tool({ id: 'c', locations: ['/w/c.svg'] })];
    expect(chatImages(items).map((i) => i.path)).toEqual(['/w/a.png', '/w/c.svg']);
  });
});

describe('which images the webview may load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-img-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-out-'));
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const write = (d: string, name: string, bytes = 10) => {
    const f = path.join(d, name);
    fs.writeFileSync(f, Buffer.alloc(bytes));
    return f;
  };

  it('an image inside an allowed root', async () => {
    const f = write(dir, 'ok.png');
    expect(await previewableImage(f, [dir])).toBe(f);
  });
  it('nothing outside the roots, by name or through a symlink', async () => {
    const f = write(outside, 'secret.png');
    expect(await previewableImage(f, [dir])).toBeNull();
    fs.symlinkSync(f, path.join(dir, 'link.png'));
    expect(await previewableImage(path.join(dir, 'link.png'), [dir])).toBeNull();
  });
  it('only image files, and not past the size cap', async () => {
    expect(await previewableImage(write(dir, 'notes.txt'), [dir])).toBeNull();
    expect(await previewableImage(path.join(dir, 'missing.png'), [dir])).toBeNull();
    fs.mkdirSync(path.join(dir, 'folder.png'));
    expect(await previewableImage(path.join(dir, 'folder.png'), [dir])).toBeNull();
    const big = path.join(dir, 'big.png');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, MAX_PREVIEW_BYTES + 1);
    expect(await previewableImage(big, [dir])).toBeNull();
    fs.truncateSync(big, MAX_PREVIEW_BYTES);
    expect(await previewableImage(big, [dir])).toBe(big);
  });
});
