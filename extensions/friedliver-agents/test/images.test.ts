import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { MAX_PREVIEW_BYTES, imagePreview } from '../src/host/imageAccess';
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
    expect(stepImage(tool({ locations: ['/w/docs/login-page_final.png'] }))).toEqual({ path: '/w/docs/login-page_final.png', title: 'Login page final', source: 'read' });
    expect(stepImage(tool({ locations: ['/w/src/a.ts'] }))).toBeNull();
  });
  it('a browser screenshot: the path from its result, the title from its first line', () => {
    const t = tool({ title: 'browser_screenshot', out: [{ t: 'text', text: 'Screenshot of myntra.com/puma\nSaved to /store/shots-x/screenshot-3.png. Read that file to see it.' }] });
    expect(stepImage(t)).toEqual({ path: '/store/shots-x/screenshot-3.png', title: 'Screenshot of myntra.com/puma', source: 'screenshot' });
  });
  it('a screenshot tool, or a write, says so', () => {
    expect(stepImage(tool({ tool: 'mcp__plugin_playwright_playwright__browser_take_screenshot', locations: ['/w/s.png'] }))?.source).toBe('screenshot');
    expect(stepImage(tool({ toolKind: 'edit', title: 'Write chart.png', locations: ['/w/chart.png'] }))?.source).toBe('created');
    expect(stepImage(tool({ tool: 'Write', locations: ['/w/chart.png'] }))?.source).toBe('created');
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

vi.mock('vscode', () => ({ Uri: { joinPath: (base: { path: string }, ...parts: string[]) => ({ path: [base.path, ...parts].join('/') }), file: (p: string) => ({ path: p }) } }));

describe('which images the webview may load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-img-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-out-'));
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const write = (d: string, name: string, bytes: Buffer = PNG) => {
    const f = path.join(d, name);
    fs.writeFileSync(f, bytes);
    return f;
  };

  it('a PNG inside an allowed root comes as a data: URI', async () => {
    expect(await imagePreview(write(dir, 'ok.png'), [dir])).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
  });
  it('a path outside the roots is refused', async () => {
    expect(await imagePreview(write(outside, 'secret.png'), [dir])).toBeNull();
    expect(await imagePreview(path.join(dir, '../', path.basename(outside), 'secret.png'), [dir])).toBeNull();
  });
  it('a symlink out of a root is refused', async () => {
    fs.symlinkSync(path.join(outside, 'secret.png'), path.join(dir, 'link.png'));
    expect(await imagePreview(path.join(dir, 'link.png'), [dir])).toBeNull();
  });
  it('the bytes must be an image of the kind; SVG and other files show as names', async () => {
    expect(await imagePreview(write(dir, 'fake.png', Buffer.from('<html><script>x</script>')), [dir])).toBeNull();
    expect(await imagePreview(write(dir, 'pic.svg', Buffer.from('<svg/>')), [dir])).toBeNull();
    expect(await imagePreview(write(dir, 'notes.txt'), [dir])).toBeNull();
    expect(await imagePreview(path.join(dir, 'missing.png'), [dir])).toBeNull();
  });
  it('not past the preview cap', async () => {
    const big = write(dir, 'big.png');
    fs.truncateSync(big, MAX_PREVIEW_BYTES + 1);
    expect(await imagePreview(big, [dir])).toBeNull();
    fs.truncateSync(big, MAX_PREVIEW_BYTES);
    expect(await imagePreview(big, [dir])).toMatch(/^data:image\/png;base64,/);
  });
  it("the webview's local resources are the media folder only", async () => {
    const { webviewOptions } = await import('../src/host/webviews');
    expect(webviewOptions({ path: '/ext' } as never).localResourceRoots).toEqual([{ path: '/ext/media' }]);
  });
});
