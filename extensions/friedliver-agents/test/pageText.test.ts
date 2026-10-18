import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { parseCall } from '../src/bridge/protocol';
import { extractPage, PageMemory, renderPage, shortUrl, toSelector, type PageData } from '../src/host/pageText';
import { estimateTokens } from '../src/shared/tokens';
import { fakeVisible, oldSnapshot, parseHtml } from './fakeDom';

const URL_ = 'https://docs.example.com/guides/webhooks';

async function page(html?: string): Promise<{ data: PageData; old: string }> {
  const text = html ?? (await readFile(path.join(__dirname, 'fixtures/pages/docs-webhooks.html'), 'utf8'));
  const { document, title } = parseHtml(text);
  // Run the page script as the browser does: its source alone, no outer scope.
  const fn = new Function(`return (${extractPage.toString()})`)() as typeof extractPage;
  const data = fn(document as never, fakeVisible as never, { title, url: URL_, start: 0 });
  return { data, old: oldSnapshot(document, title, URL_) };
}

describe('browser_snapshot as readable text', () => {
  it('keeps the main content as compact markdown and drops navigation, footers, banners and noise', async () => {
    const { data } = await page();
    const out = renderPage(data, {});
    expect(out).toMatch(/^# Webhooks — Example Docs\nURL: https:\/\/docs\.example\.com\/guides\/webhooks/);
    for (const want of [
      '# Webhooks',
      '## Retries',
      '1. Open Settings → Webhooks.',
      'Click Add endpoint and enter an HTTPS URL.',
      '[the event reference](/docs/events)',
      '`Example-Signature`',
      '```\nimport crypto from "node:crypto";',
      'Attempt | Delay | Total elapsed',
      '2 | 5 min | 6 min',
    ]) expect(out, want).toContain(want);
    for (const noise of ['Footer link', 'cookie policy', 'Topic 3', 'Blog post number', 'Was this page helpful', 'Subscribe', 'analytics', 'dataLayer', 'Start free', 'Docs / Guides'])
      expect(out, noise).not.toContain(noise);
    expect(out).toMatch(/\[read about retries\]\(https:\/\/cdn\.example\.com\/assets\/tracking\/redirect[^)]*…\)/);
    expect(out).toMatch(/Interactive: \d+ elements \(browser_snapshot with elements: true lists them\)/);
    expect(out).not.toContain('e1 ');
  });

  it('lists interactive elements with compact ids only when asked, never a hidden one or a password', async () => {
    const { data } = await page('<html><body><main><p>Log in</p><input type="password" value="hunter2" aria-label="Password"><input type="email" placeholder="Email"><button>Go</button><input type="hidden" name="csrf" value="tok"><a href="/x" style="display:none">Hidden</a><a href="/help">Help</a></main></body></html>');
    const out = renderPage(data, { elements: true });
    expect(out).toContain('e1 input[password] "Password"');
    expect(out).toContain('e2 input[email] "Email"');
    expect(out).toContain('e3 button "Go"');
    expect(out).toContain('e4 link "Help" → /help');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('csrf');
    expect(out).not.toContain('Hidden');
    expect(toSelector('e3')).toBe('[data-fl="3"]');
    expect(toSelector('#submit')).toBe('#submit');
    expect(parseCall('browser_snapshot', { elements: true, budget: 500, full: true })).toEqual({ tool: 'browser_snapshot', elements: true, budget: 500, full: true });
    expect(parseCall('browser_snapshot', { budget: 10 })).toBeNull();
  });

  it('keeps to a token budget, saying what it cut', async () => {
    const { data } = await page();
    const out = renderPage(data, { budget: 300 });
    expect(estimateTokens(out)).toBeLessThanOrEqual(300);
    expect(out).toMatch(/… cut at the 300-token budget: about \d+ more tokens \(raise budget\)/);
  });

  it('on a re-snapshot of the same page returns only what changed, per chat', async () => {
    const mem = new PageMemory();
    const first = await page();
    const full = mem.answer('chat-1', first.data, {});
    expect(full).toContain('## Retries');
    expect(mem.answer('chat-1', first.data, {})).toMatch(/No change since your last snapshot of this page/);
    const html = (await readFile(path.join(__dirname, 'fixtures/pages/docs-webhooks.html'), 'utf8')).replace('every 6 hours for up to 3 days', 'every 12 hours for up to 5 days');
    const second = await page(html);
    const d = mem.answer('chat-1', second.data, {});
    expect(d).toMatch(/Changed since your last snapshot of this page \(\+1 -1;/);
    expect(d).toContain('+If your endpoint');
    expect(d).toContain('every 12 hours');
    expect(estimateTokens(d)).toBeLessThan(estimateTokens(full) / 2);
    expect(mem.answer('chat-2', second.data, {})).toContain('## Retries');
    expect(mem.answer('chat-1', second.data, { full: true })).toContain('## Retries');
  });

  it('is far smaller than the old snapshot', async () => {
    const { data, old } = await page();
    expect(estimateTokens(renderPage(data, {}))).toBeLessThan(estimateTokens(old) * 0.4);
  });

  it('shortens long and tracking URLs', () => {
    expect(shortUrl('https://docs.example.com/docs/events', URL_)).toBe('/docs/events');
    expect(shortUrl('https://other.example/a?utm_source=x&id=7', URL_)).toBe('https://other.example/a?id=7');
    expect(shortUrl(`https://other.example/${'p'.repeat(120)}`, URL_).length).toBeLessThanOrEqual(81);
    expect(shortUrl('javascript:alert(1)', URL_)).toBe('');
  });

  it('still runs on its own after a minified production bundle', async () => {
    const r = await build({ entryPoints: [path.join(__dirname, '../src/host/pageText.ts')], bundle: true, minify: true, format: 'esm', platform: 'node', target: 'node20', write: false });
    const src = r.outputFiles[0].text;
    const mod = (await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`)) as Record<string, unknown>;
    const fn = Object.values(mod).find((v) => typeof v === 'function' && String(v).includes('data-fl')) as typeof extractPage;
    const isolated = new Function(`return (${fn.toString()})`)() as typeof extractPage;
    const { document, title } = parseHtml('<html><body><main><h1>Hi</h1><p>Text <a href="/a">link</a></p><button>Go</button></main></body></html>');
    const data = isolated(document as never, fakeVisible as never, { title, url: URL_, start: 0 });
    expect(data.lines).toEqual(['# Hi', 'Text [link](https://docs.example.com/a)']);
    expect(data.elements).toEqual(['e1 link "link" → https://docs.example.com/a', 'e2 button "Go"']);
  });
});
