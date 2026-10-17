import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { Dictation, MAX_SPOKEN, PRIVACY_PANES, helperArgs, helperPath, parseHelperLine } from '../src/host/dictation';
import { spliceDictation } from '../src/shared/dictation';
import { parseWebviewMessage } from '../src/shared/messages';
import { turnsLeft } from '../src/shared/session';

describe('dictation messages', () => {
  it('the mic hint may open Dictation settings', () => {
    expect(parseWebviewMessage({ type: 'dictationSettings' })).toEqual({ type: 'dictationSettings' });
  });
  it('dictate names a chat and on/off', () => {
    expect(parseWebviewMessage({ type: 'dictate', chatId: 'chat-1', on: true })).toEqual({ type: 'dictate', chatId: 'chat-1', on: true });
    expect(parseWebviewMessage({ type: 'dictate', chatId: 'chat-1', on: false })).toEqual({ type: 'dictate', chatId: 'chat-1', on: false });
    expect(parseWebviewMessage({ type: 'dictate' })).toBeNull();
    expect(parseWebviewMessage({ type: 'dictate', chatId: '../x y', on: true })).toBeNull();
    expect(parseWebviewMessage({ type: 'dictate', chatId: 'chat-1', on: 'yes' })).toBeNull();
  });
});

describe('the helper protocol', () => {
  it('reads partial, final and error lines', () => {
    expect(parseHelperLine('{"partial":"fix the"}')).toEqual({ kind: 'partial', text: 'fix the' });
    expect(parseHelperLine('{"final":"fix the login."}')).toEqual({ kind: 'final', text: 'fix the login.' });
    expect(parseHelperLine('{"final":""}')).toEqual({ kind: 'final', text: '' });
    expect(parseHelperLine('{"error":"no","code":"mic-denied"}')).toEqual({ kind: 'error', code: 'mic-denied', message: 'no' });
    expect(parseHelperLine('{"error":"no","code":"speech-denied"}')).toMatchObject({ code: 'speech-denied' });
    expect(parseHelperLine('{"partial":"हिंदी में"}')).toEqual({ kind: 'partial', text: 'हिंदी में' });
  });
  it('ignores anything else', () => {
    for (const line of ['', 'hello', '[]', 'null', '"x"', '{"partial":3}', '{"other":"x"}', '{"partial":']) expect(parseHelperLine(line), line).toBeNull();
    expect(parseHelperLine(JSON.stringify({ partial: 'x'.repeat(70_000) }))).toBeNull();
  });
  it('an unknown error code is a recognition error', () => {
    expect(parseHelperLine('{"error":"x","code":"rm -rf"}')).toMatchObject({ code: 'recognition' });
  });
  it('caps the text and strips control characters', () => {
    expect(parseHelperLine(JSON.stringify({ partial: 'a'.repeat(MAX_SPOKEN + 50) }))).toEqual({ kind: 'partial', text: 'a'.repeat(MAX_SPOKEN) });
    expect(parseHelperLine(JSON.stringify({ partial: 'a\u0000b\u001b[31mc\u007f' }))).toEqual({ kind: 'partial', text: 'ab[31mc' });
  });
});

describe('spliceDictation (the words at the caret)', () => {
  it('fills an empty box', () => {
    expect(spliceDictation('', { start: 0, len: 0 }, 'fix the login', false, 100)).toEqual({ text: 'fix the login', caret: 13, seg: { start: 0, len: 13 } });
  });
  it('each partial replaces the last; a final commits it', () => {
    let r = spliceDictation('Please', { start: 6, len: 0 }, 'fix', false, 100);
    expect(r).toMatchObject({ text: 'Please fix', caret: 10 });
    r = spliceDictation(r.text, r.seg, 'fix the login', false, 100);
    expect(r).toMatchObject({ text: 'Please fix the login', caret: 20 });
    r = spliceDictation(r.text, r.seg, 'fix the login.', true, 100);
    expect(r).toEqual({ text: 'Please fix the login.', caret: 21, seg: { start: 21, len: 0 } });
    // More speech after a final goes after it.
    r = spliceDictation(r.text, r.seg, 'Thanks', false, 100);
    expect(r.text).toBe('Please fix the login. Thanks');
  });
  it('mid-text: spaces either side, caret after the words', () => {
    const r = spliceDictation('ab|cd', { start: 3, len: 0 }, ' hello  world ', false, 100);
    expect(r).toEqual({ text: 'ab| hello world cd', caret: 15, seg: { start: 3, len: 13 } });
  });
  it('replaces the selection it started on', () => {
    expect(spliceDictation('one TWO three', { start: 4, len: 3 }, 'two', true, 100).text).toBe('one two three');
  });
  it('an empty partial clears the segment', () => {
    expect(spliceDictation('ab hi', { start: 2, len: 3 }, '', false, 100)).toEqual({ text: 'ab', caret: 2, seg: { start: 2, len: 0 } });
  });
  it('never makes the box longer than the cap', () => {
    const r = spliceDictation('x'.repeat(95), { start: 95, len: 0 }, 'hello world', false, 100);
    expect(r.text).toBe(`${'x'.repeat(95)} hell`);
    expect(r.text.length).toBe(100);
    expect(spliceDictation('x'.repeat(100), { start: 100, len: 0 }, 'more', false, 100).text).toBe('x'.repeat(100));
  });
  it('a segment past the end (the box shrank) lands at the end', () => {
    expect(spliceDictation('ab', { start: 9, len: 4 }, 'c', false, 100).text).toBe('ab c');
  });
});

describe('helperPath and helperArgs', () => {
  it('only on macOS, only the bundled executable', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fl-dictate-'));
    expect(helperPath(dir, 'darwin')).toBeUndefined();
    mkdirSync(path.join(dir, 'bin'));
    const file = path.join(dir, 'bin', 'friedliver-dictate');
    writeFileSync(file, '#!/bin/sh\n', { mode: 0o644 });
    if (process.platform !== 'win32') expect(helperPath(dir, 'darwin')).toBeUndefined();
    chmodSync(file, 0o755);
    expect(helperPath(dir, 'darwin')).toBe(file);
    expect(helperPath(dir, 'linux')).toBeUndefined();
    expect(helperPath(dir, 'win32')).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
  it('passes only valid settings', () => {
    expect(helperArgs('auto', 2.5)).toEqual(['--locale', 'auto', '--silence', '2.5', '--max', '60']);
    expect(helperArgs('hi-IN', 4)).toEqual(['--locale', 'hi-IN', '--silence', '4', '--max', '60']);
    expect(helperArgs('zh-Hans-CN', 1)[1]).toBe('zh-Hans-CN');
    expect(helperArgs('--max=999', 0.1)).toEqual(['--locale', 'auto', '--silence', '2.5', '--max', '60']);
    expect(helperArgs(undefined, 'x')).toEqual(['--locale', 'auto', '--silence', '2.5', '--max', '60']);
  });
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stdin = new PassThrough();
  signals: string[] = [];
  kill(signal: string) {
    this.signals.push(signal);
    return true;
  }
}

function setup(missing = false) {
  const posts: { surface: string; chatId: string; update: unknown }[] = [];
  const children: FakeChild[] = [];
  const spawned: { file: string; args: string[]; options: unknown }[] = [];
  const denied: string[] = [];
  const failed: string[] = [];
  const d = new Dictation<string>({
    helper: () => (missing ? undefined : '/app/bin/friedliver-dictate'),
    args: () => ['--locale', 'auto'],
    post: (surface, chatId, update) => posts.push({ surface, chatId, update }),
    denied: (code) => denied.push(code),
    failed: (m) => failed.push(m),
    spawn: ((file: string, args: string[], options: unknown) => {
      spawned.push({ file, args, options });
      const c = new FakeChild();
      children.push(c);
      return c;
    }) as never,
  });
  const updates = () => posts.map((p) => p.update);
  return { d, posts, updates, children, spawned, denied, failed };
}
const flush = () => new Promise((r) => setImmediate(r));

describe('Dictation (the helper process)', () => {
  it('spawns the bundled helper without a shell and streams partials then the final', async () => {
    const t = setup();
    t.d.start('view', 'chat-1');
    expect(t.spawned[0]).toMatchObject({ file: '/app/bin/friedliver-dictate', args: ['--locale', 'auto'], options: { shell: false } });
    expect(t.d.state).toBe('listening');
    const c = t.children[0];
    c.stdout.write('{"partial":"fix');
    c.stdout.write(' the"}\n{"partial":"fix the login"}\nnot json\n');
    c.stdout.write('{"final":"fix the login."}\n');
    await flush();
    expect(t.updates()).toEqual([
      { state: 'listening' },
      { text: 'fix the', final: false },
      { text: 'fix the login', final: false },
      { text: 'fix the login.', final: true },
    ]);
    c.emit('exit', 0);
    expect(t.updates().at(-1)).toEqual({ state: 'idle' });
    expect(t.d.state).toBe('idle');
    expect(t.posts.every((p) => p.surface === 'view' && p.chatId === 'chat-1')).toBe(true);
  });

  it('stop: listening → stopping (stdin closed, SIGTERM), then SIGKILL if it hangs', async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      t.d.start('view', 'chat-1');
      const c = t.children[0];
      let ended = false;
      c.stdin.on('finish', () => (ended = true));
      t.d.stop('other-chat');
      expect(t.d.state).toBe('listening');
      t.d.stop('chat-1');
      expect(t.d.state).toBe('stopping');
      expect(t.updates().at(-1)).toEqual({ state: 'stopping' });
      expect(c.signals).toEqual(['SIGTERM']);
      await vi.advanceTimersByTimeAsync(0);
      expect(ended).toBe(true);
      t.d.stop('chat-1');
      expect(c.signals).toEqual(['SIGTERM']);
      await vi.advanceTimersByTimeAsync(4000);
      expect(c.signals).toEqual(['SIGTERM', 'SIGKILL']);
      c.emit('exit', null);
      expect(t.d.state).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('permission denied: the toast with the pane, then idle', async () => {
    const t = setup();
    t.d.start('view', 'chat-1');
    t.children[0].stdout.write('{"error":"no mic","code":"mic-denied"}\n');
    await flush();
    t.children[0].emit('exit', 1);
    expect(t.denied).toEqual(['mic-denied']);
    expect(t.failed).toEqual([]);
    expect(t.updates().at(-1)).toEqual({ state: 'idle' });
    expect(PRIVACY_PANES['mic-denied']).toMatch(/Privacy_Microphone$/);
    expect(PRIVACY_PANES['speech-denied']).toMatch(/Privacy_SpeechRecognition$/);
  });

  it('other errors are reported once, not as permission', async () => {
    const t = setup();
    t.d.start('view', 'chat-1');
    t.children[0].stdout.write('{"error":"No microphone found.","code":"audio"}\n');
    await flush();
    expect(t.failed).toEqual(['No microphone found.']);
    expect(t.denied).toEqual([]);
  });

  it('no helper (a dev build): the hint, nothing spawned', () => {
    const t = setup(true);
    t.d.start('view', 'chat-1');
    expect(t.spawned).toEqual([]);
    expect(t.updates()).toEqual([{ state: 'fallback' }]);
    expect(t.d.state).toBe('idle');
  });

  it('a helper that cannot run: the hint', () => {
    const t = setup();
    t.d.start('view', 'chat-1');
    t.children[0].emit('error', new Error('EACCES'));
    expect(t.updates()).toEqual([{ state: 'listening' }, { state: 'idle' }, { state: 'fallback' }]);
  });

  it('one microphone: starting in another chat kills the first', () => {
    const t = setup();
    t.d.start('view', 'chat-1');
    t.d.start('view', 'chat-2');
    expect(t.children[0].signals).toEqual(['SIGKILL']);
    expect(t.posts.map((p) => [p.chatId, p.update])).toEqual([
      ['chat-1', { state: 'listening' }],
      ['chat-1', { state: 'idle' }],
      ['chat-2', { state: 'listening' }],
    ]);
    // The first one's late output and exit change nothing.
    t.children[0].emit('exit', null);
    expect(t.d.state).toBe('listening');
  });

  it('closing the chat view or the window kills the helper', () => {
    const t = setup();
    t.d.start('view', 'chat-1');
    t.d.closed('other-view');
    expect(t.children[0].signals).toEqual([]);
    t.d.closed('view');
    expect(t.children[0].signals).toEqual(['SIGKILL']);
    expect(t.d.state).toBe('idle');
    t.d.start('view', 'chat-1');
    t.d.dispose();
    expect(t.children[1].signals).toEqual(['SIGKILL']);
    t.d.dispose();
    expect(t.children[1].signals).toEqual(['SIGKILL']);
  });
});

describe('the bundled helper', () => {
  const root = path.resolve(__dirname, '..');
  it('ships in the extension', () => {
    expect(readFileSync(path.join(root, '.vscodeignore'), 'utf8')).toMatch(/^!bin\/friedliver-dictate$/m);
  });
  it('declares both usage descriptions and the JSON protocol', () => {
    const plist = readFileSync(path.join(root, 'native', 'Info.plist'), 'utf8');
    expect(plist).toContain('NSMicrophoneUsageDescription');
    expect(plist).toContain('NSSpeechRecognitionUsageDescription');
    const swift = readFileSync(path.join(root, 'native', 'friedliver-dictate.swift'), 'utf8');
    for (const s of ['requiresOnDeviceRecognition', '"partial"', '"final"', '"mic-denied"', '"speech-denied"', 'SIGTERM', 'standardInput']) expect(swift).toContain(s);
  });
});

describe('turnsLeft (the usage popover estimate)', () => {
  it('uses growth per turn, not the total (the system prompt is not a turn)', () => {
    // The light fixture: 76% of 200k used, 12k a turn lately: 48k left is 4 turns, not ~0.
    expect(turnsLeft([116_000, 128_000, 140_000, 152_000], 200_000)).toBe(4);
  });
  it('looks at the last 5 turns only', () => {
    expect(turnsLeft([10_000, 90_000, 100_000, 110_000, 120_000, 130_000, 140_000], 200_000)).toBe(6);
  });
  it('needs 2 finished turns; caps at >50; never negative', () => {
    expect(turnsLeft([], 200_000)).toBeUndefined();
    expect(turnsLeft([30_000], 200_000)).toBeUndefined();
    expect(turnsLeft([30_000, 31_000], 200_000)).toBe('>50');
    expect(turnsLeft([30_000, 30_000], 200_000)).toBe('>50');
    expect(turnsLeft([190_000, 210_000], 200_000)).toBe(0);
  });
});
