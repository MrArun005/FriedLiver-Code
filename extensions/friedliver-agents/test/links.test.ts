import { describe, expect, it } from 'vitest';
import { LINK_MAX, linkDestination, linkTarget } from '../src/shared/links';
import { parseWebviewMessage } from '../src/shared/messages';

describe('links clicked in FriedLiver', () => {
  it('opens web links, files as files, and refuses every other scheme', () => {
    expect(linkTarget('https://example.com/a?b=1#c')).toEqual({ kind: 'web', url: 'https://example.com/a?b=1#c' });
    expect(linkTarget('http://localhost:3000/')).toEqual({ kind: 'web', url: 'http://localhost:3000/' });
    expect(linkTarget('file:///Users/me/proj/src/a.ts')).toEqual({ kind: 'file', path: '/Users/me/proj/src/a.ts' });
    expect(linkTarget('file:///Users/me/my%20file.md')).toEqual({ kind: 'file', path: '/Users/me/my file.md' });
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'chrome://settings', 'vscode://file/x', 'command:workbench.action.quit', 'ftp://x.org', '//evil.com', '#top', '', 'not a url', 'https://user:pass@example.com/']) {
      expect(linkTarget(bad), bad).toBeNull();
    }
    expect(linkTarget(`https://e.com/${'a'.repeat(LINK_MAX)}`)).toBeNull();
    expect(linkTarget('file://server/share/x')).toBeNull();
  });

  it('goes where the setting says, a Cmd/Ctrl-click the other way', () => {
    expect(linkDestination('builtin', false)).toBe('builtin');
    expect(linkDestination('builtin', true)).toBe('external');
    expect(linkDestination('external', false)).toBe('external');
    expect(linkDestination('external', true)).toBe('builtin');
    // An unknown setting is the default.
    expect(linkDestination('nonsense', false)).toBe('builtin');
  });

  it('reaches the host only as an http(s) link, checked again there', () => {
    expect(parseWebviewMessage({ type: 'openLink', url: 'https://example.com', modifier: true })).toEqual({ type: 'openLink', url: 'https://example.com/', modifier: true });
    expect(parseWebviewMessage({ type: 'openLink', url: 'https://example.com' })).toEqual({ type: 'openLink', url: 'https://example.com/', modifier: false });
    expect(parseWebviewMessage({ type: 'openLink', url: 'javascript:alert(1)' })).toBeNull();
    expect(parseWebviewMessage({ type: 'openLink', url: 'file:///etc/passwd' })).toBeNull();
    expect(parseWebviewMessage({ type: 'openLink', url: 42 })).toBeNull();
  });
});
