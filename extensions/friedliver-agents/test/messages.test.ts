import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from '../src/shared/markdown';
import { parseWebviewMessage } from '../src/shared/messages';
import { insideRoots } from '../src/host/paths';

describe('webview message validation', () => {
  it('accepts well-formed messages', () => {
    expect(parseWebviewMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseWebviewMessage({ type: 'openChat', chatId: 'chat-1', item: 'toolu_01' })).toEqual({ type: 'openChat', chatId: 'chat-1', item: 'toolu_01' });
    expect(parseWebviewMessage({ type: 'openChat', chatId: 'chat-1', item: 'a b' })).toEqual({ type: 'openChat', chatId: 'chat-1' });
    expect(parseWebviewMessage({ type: 'openClaudeSession', sessionId: '11111111-1111-4111-8111-111111111111' })).toEqual({ type: 'openClaudeSession', sessionId: '11111111-1111-4111-8111-111111111111' });
    expect(parseWebviewMessage({ type: 'openClaudeSession', sessionId: '../x' })).toBeNull();
    expect(parseWebviewMessage({ type: 'newChat', agent: 'gemini' })).toEqual({ type: 'newChat', agent: 'gemini' });
    expect(parseWebviewMessage({ type: 'send', chatId: 'chat-1', text: 'hi', images: [{ name: 'a.png', mimeType: 'image/png', data: 'aGk=' }] })).toMatchObject({
      type: 'send',
      images: [{ mimeType: 'image/png' }],
    });
    expect(parseWebviewMessage({ type: 'permission', requestId: 'perm-1', optionId: null })).toEqual({ type: 'permission', requestId: 'perm-1', optionId: null });
    expect(parseWebviewMessage({ type: 'notice', chatId: 'chat-1', action: { label: 'Log in', do: 'signIn', agent: 'claude', methodId: 'claude-login' } })).toBeTruthy();
  });

  it('drops extra fields', () => {
    expect(parseWebviewMessage({ type: 'stop', chatId: 'chat-1', evil: true })).toEqual({ type: 'stop', chatId: 'chat-1' });
  });

  it('rejects malformed or hostile messages', () => {
    const bad: unknown[] = [
      null,
      'ready',
      [],
      { type: 'nope' },
      { type: 'newChat', agent: 'rm -rf' },
      { type: 'stop', chatId: '../../etc' },
      { type: 'send', chatId: 'chat-1', text: '', images: [] },
      { type: 'send', chatId: 'chat-1', text: 'x'.repeat(100_001), images: [] },
      { type: 'send', chatId: 'chat-1', text: 'hi', images: [{ name: 'a', mimeType: 'text/html', data: 'aGk=' }] },
      { type: 'send', chatId: 'chat-1', text: 'hi', images: [{ name: 'a', mimeType: 'image/png', data: '<script>' }] },
      { type: 'send', chatId: 'chat-1', text: 'hi', images: 'x' },
      { type: 'command', commandId: 'cmd-1', approve: 'yes' },
      { type: 'review', reviewId: 'r-1', action: 'delete' },
      { type: 'notice', chatId: 'chat-1', action: { label: 'x', do: 'shell', command: 'rm' } },
      { type: 'notice', chatId: 'chat-1', action: { label: 'x', do: 'install', command: '' } },
      { type: 'createTask', agent: 'demo', prompt: '   ', worktree: false },
      { type: 'createTask', agent: 'demo', prompt: 'go', worktree: 'yes' },
    ];
    for (const m of bad) expect(parseWebviewMessage(m), JSON.stringify(m)).toBeNull();
  });
});

describe('code references in messages (additive fields)', () => {
  const ref = { path: '/work/app/src/a.ts', startLine: 3, endLine: 5 };

  it('keeps a message without them exactly as before', () => {
    expect(parseWebviewMessage({ type: 'send', chatId: 'chat-1', text: 'hi', images: [] })).toEqual({ type: 'send', chatId: 'chat-1', text: 'hi', images: [] });
    expect(parseWebviewMessage({ type: 'openFile', path: 'src/a.ts' })).toEqual({ type: 'openFile', path: 'src/a.ts' });
  });

  it('takes well-formed references, also as the whole message', () => {
    expect(parseWebviewMessage({ type: 'send', chatId: 'chat-1', text: 'why?', images: [], refs: [ref] })).toEqual({ type: 'send', chatId: 'chat-1', text: 'why?', images: [], refs: [ref] });
    expect(parseWebviewMessage({ type: 'send', chatId: 'chat-1', text: '', images: [], refs: [{ ...ref, extra: 1 }] })).toEqual({ type: 'send', chatId: 'chat-1', text: '', images: [], refs: [ref] });
    expect(parseWebviewMessage({ type: 'openFile', path: ref.path, line: 3, endLine: 5 })).toEqual({ type: 'openFile', path: ref.path, line: 3, endLine: 5 });
    expect(parseWebviewMessage({ type: 'openFile', path: ref.path, line: 3 })).toEqual({ type: 'openFile', path: ref.path, line: 3 });
  });

  it('refuses malformed ones', () => {
    const bad: unknown[] = [
      { type: 'send', chatId: 'chat-1', text: 'x', images: [], refs: 'a.ts' },
      { type: 'send', chatId: 'chat-1', text: 'x', images: [], refs: [{ ...ref, startLine: 0 }] },
      { type: 'send', chatId: 'chat-1', text: 'x', images: [], refs: [{ ...ref, startLine: 6 }] },
      { type: 'send', chatId: 'chat-1', text: 'x', images: [], refs: [{ ...ref, endLine: 2.5 }] },
      { type: 'send', chatId: 'chat-1', text: 'x', images: [], refs: [{ ...ref, path: '' }] },
      { type: 'send', chatId: 'chat-1', text: 'x', images: [], refs: [{ ...ref, path: 'x'.repeat(5000) }] },
      { type: 'send', chatId: 'chat-1', text: 'x', images: [], refs: Array.from({ length: 11 }, () => ref) },
      { type: 'send', chatId: 'chat-1', text: '', images: [], refs: [] },
      { type: 'openFile', path: 'a.ts', line: -1 },
      { type: 'openFile', path: 'a.ts', line: '3' },
      { type: 'openFile', path: 'a.ts', line: 5, endLine: 4 },
    ];
    for (const m of bad) expect(parseWebviewMessage(m), JSON.stringify(m).slice(0, 120)).toBeNull();
  });
});

describe('Run in terminal', () => {
  const heredoc = "cat << 'EOF' | python3 minidb.py\nSELECT 1;\n\tEOF";

  it('takes a command with its lines and tabs as it is, and an optional folder', () => {
    expect(parseWebviewMessage({ type: 'runInTerminal', chatId: 'chat-1', command: heredoc })).toEqual({ type: 'runInTerminal', chatId: 'chat-1', command: heredoc });
    expect(parseWebviewMessage({ type: 'runInTerminal', chatId: 'chat-1', command: 'npm test', cwd: '/work/app', extra: true })).toEqual({ type: 'runInTerminal', chatId: 'chat-1', command: 'npm test', cwd: '/work/app' });
  });

  it('refuses control characters, empty or huge commands, and bad ids or folders', () => {
    const bad: unknown[] = [
      { type: 'runInTerminal', chatId: 'chat-1', command: 'echo \u001b]0;title\u0007' },
      { type: 'runInTerminal', chatId: 'chat-1', command: 'echo a\u0000b' },
      { type: 'runInTerminal', chatId: 'chat-1', command: 'echo \u0003' },
      { type: 'runInTerminal', chatId: 'chat-1', command: '  \n ' },
      { type: 'runInTerminal', chatId: 'chat-1', command: 'x'.repeat(64 * 1024 + 1) },
      { type: 'runInTerminal', chatId: 'chat-1', command: ['npm', 'test'] },
      { type: 'runInTerminal', chatId: '../x', command: 'npm test' },
      { type: 'runInTerminal', command: 'npm test' },
      { type: 'runInTerminal', chatId: 'chat-1', command: 'npm test', cwd: '' },
      { type: 'runInTerminal', chatId: 'chat-1', command: 'npm test', cwd: 'a\0b' },
      { type: 'runInTerminal', chatId: 'chat-1', command: 'npm test', cwd: 3 },
    ];
    for (const m of bad) expect(parseWebviewMessage(m), JSON.stringify(m).slice(0, 120)).toBeNull();
  });
});

describe('workspace path check', () => {
  const roots = ['/work/app', '/work/.app-worktrees/task-1'];

  it('allows paths inside a workspace folder or a task worktree', () => {
    expect(insideRoots('/work/app/src/a.ts', roots, path.posix)).toBe('/work/app/src/a.ts');
    expect(insideRoots('src/a.ts', roots, path.posix)).toBe('/work/app/src/a.ts');
    expect(insideRoots('/work/app', roots, path.posix)).toBe('/work/app');
    expect(insideRoots('/work/.app-worktrees/task-1/NOTES.md', roots, path.posix)).toBe('/work/.app-worktrees/task-1/NOTES.md');
    expect(insideRoots('/work/app/..notes', roots, path.posix)).toBe('/work/app/..notes');
  });

  it('refuses everything else', () => {
    expect(insideRoots('/work/app/../secret', roots, path.posix)).toBeNull();
    expect(insideRoots('/work/application/x', roots, path.posix)).toBeNull();
    expect(insideRoots('/etc/passwd', roots, path.posix)).toBeNull();
    expect(insideRoots('../../etc/passwd', roots, path.posix)).toBeNull();
    expect(insideRoots('/work/app/a\0b', roots, path.posix)).toBeNull();
    expect(insideRoots(42, roots, path.posix)).toBeNull();
    expect(insideRoots('/work/app/a', [], path.posix)).toBeNull();
  });

  it('compares Windows paths without regard to case', () => {
    expect(insideRoots('c:\\Work\\App\\a.ts', ['C:\\work\\app'], path.win32)).toBe('c:\\Work\\App\\a.ts');
    expect(insideRoots('D:\\work\\app\\a.ts', ['C:\\work\\app'], path.win32)).toBeNull();
  });
});

describe('markdown', () => {
  it('parses blocks', () => {
    expect(parseMarkdown('# Title\n\nSome **bold** text.\n\n- one\n- two\n\n```ts\nconst a = 1;\n```')).toEqual([
      { t: 'h', level: 1, inline: [{ t: 'text', v: 'Title' }] },
      { t: 'p', inline: [{ t: 'text', v: 'Some ' }, { t: 'strong', v: 'bold' }, { t: 'text', v: ' text.' }] },
      { t: 'ul', items: [{ inline: [{ t: 'text', v: 'one' }] }, { inline: [{ t: 'text', v: 'two' }] }] },
      { t: 'pre', lang: 'ts', code: 'const a = 1;' },
    ]);
  });

  it('keeps only https links', () => {
    expect(parseInline('[docs](https://agentclientprotocol.com) and [x](javascript:alert(1))')).toEqual([
      { t: 'link', v: 'docs', href: 'https://agentclientprotocol.com' },
      { t: 'text', v: ' and ' },
      { t: 'text', v: 'x' },
      { t: 'text', v: ')' },
    ]);
  });

  it('reads inline code and emphasis', () => {
    expect(parseInline('run `npm test` *now*')).toEqual([
      { t: 'text', v: 'run ' },
      { t: 'code', v: 'npm test' },
      { t: 'text', v: ' ' },
      { t: 'em', v: 'now' },
    ]);
  });
});
