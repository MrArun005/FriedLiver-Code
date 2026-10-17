import { describe, expect, it } from 'vitest';
import { BROWSER_WIDTH, browserNeedsApproval, checkBrowserUrl, clampBrowserWidth, isLocalhost, relaxLocalhostCors } from '../src/host/browserRules';
import { handle, TOOLS } from '../src/bridge/mcp';
import { parseCall } from '../src/bridge/protocol';

describe('browser URLs agents may open', () => {
  it('takes http and https, and adds http:// to bare localhost addresses', () => {
    expect(checkBrowserUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(checkBrowserUrl(' http://localhost:3000 ')).toBe('http://localhost:3000/');
    expect(checkBrowserUrl('localhost:5173/app')).toBe('http://localhost:5173/app');
    expect(checkBrowserUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/');
    expect(checkBrowserUrl('[::1]:4000')).toBe('http://[::1]:4000/');
  });

  it.each(['file:///etc/passwd', 'chrome://settings', 'devtools://devtools/bundled/inspector.html', 'javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,hi', 'about:blank', 'ftp://x.org', 'view-source:https://a.com', 'chrome-extension://abc/x'])(
    'refuses %s',
    (url) => expect(() => checkBrowserUrl(url)).toThrow(/only http and https/),
  );

  it('refuses what is not a URL', () => {
    expect(() => checkBrowserUrl('not a url')).toThrow(/Not a URL/);
    expect(() => checkBrowserUrl('')).toThrow(/Not a URL/);
  });

  it('knows localhost', () => {
    expect(isLocalhost('http://localhost:3000/x')).toBe(true);
    expect(isLocalhost('https://127.0.0.1/')).toBe(true);
    expect(isLocalhost('http://[::1]:1/')).toBe(true);
    expect(isLocalhost('http://localhost.evil.com/')).toBe(false);
    expect(isLocalhost('http://127.0.0.2/')).toBe(false);
    expect(isLocalhost('file://localhost/etc')).toBe(false);
    expect(isLocalhost('garbage')).toBe(false);
  });
});

describe('browser width', () => {
  it('stays between 40% and 70% of the window', () => {
    expect(clampBrowserWidth(0.55)).toBe(0.55);
    expect(clampBrowserWidth(0.1)).toBe(BROWSER_WIDTH.min);
    expect(clampBrowserWidth(0.95)).toBe(BROWSER_WIDTH.max);
    expect(clampBrowserWidth(0.4)).toBe(0.4);
    expect(clampBrowserWidth(0.7)).toBe(0.7);
  });
  it('falls back to half for anything that is not a number', () => {
    for (const v of [undefined, null, NaN, Infinity, '0.6', {}]) expect(clampBrowserWidth(v)).toBe(0.5);
  });
});

describe('which browser tools wait for the user', () => {
  it('looking never does; acting does unless the chat is on Full auto', () => {
    for (const tool of ['browser_snapshot', 'browser_screenshot', 'browser_console']) {
      expect(browserNeedsApproval(tool, 'ask')).toBe(false);
    }
    for (const tool of ['browser_open', 'browser_click', 'browser_type', 'browser_back', 'browser_reload']) {
      expect(browserNeedsApproval(tool, undefined)).toBe(true);
      expect(browserNeedsApproval(tool, 'ask')).toBe(true);
      expect(browserNeedsApproval(tool, 'edits')).toBe(true);
      expect(browserNeedsApproval(tool, 'full')).toBe(false);
    }
  });
});

describe('relaxing CORS for localhost', () => {
  const paused = (url: string, method = 'GET', headers: Record<string, string> = { Origin: 'http://localhost:3000' }) => ({
    request: { url, method, headers },
    responseHeaders: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'access-control-allow-origin', value: 'https://other.example' },
    ],
  });

  it('leaves anything not from localhost alone', () => {
    expect(relaxLocalhostCors(paused('https://api.example.com/x'))).toBeNull();
    expect(relaxLocalhostCors(paused('http://localhost.evil.com/x'))).toBeNull();
  });

  it('leaves same-origin requests (no Origin) alone', () => {
    expect(relaxLocalhostCors(paused('http://localhost:8080/x', 'GET', {}))).toBeNull();
  });

  it('allows the requesting origin on a localhost response, replacing what the server said', () => {
    const r = relaxLocalhostCors(paused('http://127.0.0.1:8080/api'))!;
    expect(r.fulfill).toBe(false);
    const names = r.headers.map((h) => h.name.toLowerCase());
    expect(names.filter((n) => n === 'access-control-allow-origin')).toHaveLength(1);
    expect(r.headers).toContainEqual({ name: 'Access-Control-Allow-Origin', value: 'http://localhost:3000' });
    expect(r.headers).toContainEqual({ name: 'Access-Control-Allow-Credentials', value: 'true' });
    expect(r.headers).toContainEqual({ name: 'Content-Type', value: 'application/json' });
  });

  it('answers a localhost preflight itself, echoing what was asked', () => {
    const r = relaxLocalhostCors(
      paused('http://localhost:8080/api', 'OPTIONS', { origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type, x-token' }),
    )!;
    expect(r.fulfill).toBe(true);
    expect(r.headers).toContainEqual({ name: 'Access-Control-Allow-Methods', value: 'PUT' });
    expect(r.headers).toContainEqual({ name: 'Access-Control-Allow-Headers', value: 'content-type, x-token' });
    expect(r.headers.some((h) => h.name === 'Content-Type')).toBe(false);
  });
});

describe('browser tool arguments', () => {
  it('lists the browser tools over MCP', () => {
    const names = TOOLS.map((t) => t.name);
    for (const n of ['browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_console', 'browser_back', 'browser_reload']) expect(names).toContain(n);
  });

  it('parses good calls', () => {
    expect(parseCall('browser_open', { url: 'http://localhost:3000' })).toEqual({ tool: 'browser_open', url: 'http://localhost:3000' });
    expect(parseCall('browser_click', { selector: '#go' })).toEqual({ tool: 'browser_click', selector: '#go' });
    expect(parseCall('browser_click', { text: 'Sign in' })).toEqual({ tool: 'browser_click', text: 'Sign in' });
    expect(parseCall('browser_type', { selector: 'input[name=q]', text: '' })).toEqual({ tool: 'browser_type', selector: 'input[name=q]', text: '' });
    for (const tool of ['browser_snapshot', 'browser_screenshot', 'browser_console', 'browser_back', 'browser_reload']) expect(parseCall(tool, {})).toEqual({ tool });
  });

  it.each([
    ['browser_open', {}],
    ['browser_open', { url: 42 }],
    ['browser_open', { url: 'x'.repeat(5000) }],
    ['browser_click', {}],
    ['browser_click', { selector: '#a', text: 'b' }],
    ['browser_click', { selector: '  ' }],
    ['browser_type', { selector: '#a' }],
    ['browser_type', { text: 'hi' }],
    ['browser_type', { selector: '#a', text: 7 }],
  ])('refuses %s %j', (tool, args) => {
    expect(parseCall(tool, args)).toBeNull();
    expect(handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } })).toMatchObject({ reply: { result: { isError: true } } });
  });
});
