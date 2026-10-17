import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyReplacement, INLINE_AROUND, INLINE_LIMITS, INLINE_MARK, inlinePrompt, parseReplacement, runInline } from '../src/host/inlineEdit';
import { disposeCores, gitRepo, makeCore } from './helpers';

afterEach(disposeCores);

const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
const TEXT = lines.join('\n') + '\n';
const SPAN = { start: { line: 149, character: 0 }, end: { line: 150, character: 8 } };

describe('inline edit prompt', () => {
  it('carries the file, the selection and 80 lines either side, no more', () => {
    const p = inlinePrompt({ cwd: '/w', file: '/w/src/a.ts', languageId: 'typescript', text: TEXT, span: SPAN });
    expect(p).toContain(INLINE_MARK);
    expect(p).toContain('File: src/a.ts');
    expect(p).toContain('Selected code:\n```typescript\nline 150\nline 151\n```');
    expect(p).toContain(`Before it (lines ${150 - INLINE_AROUND}-149)`);
    expect(p).toContain(`After it (lines 152-${151 + INLINE_AROUND})`);
    expect(p).not.toMatch(/\bline 69\b/);
    expect(p).not.toMatch(/\bline 232\b/);
    expect(p).toMatch(/Do NOT write/);
  });

  it('caps long context lines and context size, keeping the lines nearest the selection', () => {
    const big = Array.from({ length: 200 }, (_, i) => `${i}:${'x'.repeat(1000)}`).join('\n');
    const p = inlinePrompt({ cwd: '/w', file: '/w/a.ts', languageId: 'ts', text: big, span: { start: { line: 100, character: 0 }, end: { line: 100, character: 3 } } });
    expect(p).toContain('[… line cut]');
    expect(p).toContain('99:x');
    expect(p).not.toContain('\n21:x');
    expect(p.length).toBeLessThan(2 * INLINE_LIMITS.around + 10_000);
  });

  it('refuses a selection too long to replace whole', () => {
    const text = 'a'.repeat(INLINE_LIMITS.selection + 1);
    expect(() => inlinePrompt({ cwd: '/w', file: '/w/a.ts', languageId: 'ts', text, span: { start: { line: 0, character: 0 }, end: { line: 0, character: text.length } } })).toThrow(/too long/);
  });

  it('asks for an insertion at a bare cursor', () => {
    const p = inlinePrompt({ cwd: '/w', file: '/w/a.ts', languageId: 'ts', text: TEXT, span: { start: { line: 3, character: 2 }, end: { line: 3, character: 2 } } });
    expect(p).toContain('code to insert at the cursor');
    expect(p).not.toContain('Selected code');
  });

  it('includes the last proposal and the follow-up on retry', () => {
    const p = inlinePrompt({ cwd: '/w', file: '/w/a.ts', languageId: 'ts', text: TEXT, span: SPAN, previous: { replacement: 'old try', followUp: 'shorter' } });
    expect(p).toContain('old try');
    expect(p).toContain('Their follow-up: shorter');
  });
});

describe('inline edit reply parsing', () => {
  it('takes a fenced block', () => expect(parseReplacement('Here:\n```ts\nconst a = 1;\n  b();\n```\nDone.')).toBe('const a = 1;\n  b();'));
  it('takes the last of several blocks', () => expect(parseReplacement('```\nfirst\n```\nbetter:\n```js\nsecond\n```')).toBe('second'));
  it('takes the whole reply with no fence, or nothing when bare is off', () => {
    expect(parseReplacement('\nreturn x;\n')).toBe('return x;');
    expect(parseReplacement('return x;', false)).toBeUndefined();
    expect(parseReplacement('   ')).toBeUndefined();
  });
  it('reads an unclosed block while streaming', () => expect(parseReplacement('```ts\nconst a', false)).toBe('const a'));
  it('handles a longer fence holding backticks', () => expect(parseReplacement('````md\n```\ninner\n```\n````')).toBe('```\ninner\n```'));
});

describe('inline edit apply', () => {
  it('changes only the selection', () => {
    const out = applyReplacement(TEXT, SPAN, 'NEW');
    expect(out.split('\n').slice(148, 151)).toEqual(['line 149', 'NEW', 'line 152']);
    expect(out.replace('NEW', 'line 150\nline 151')).toBe(TEXT);
  });
  it('keeps CRLF line ends and inserts at a cursor', () => {
    expect(applyReplacement('a\r\nbc\r\n', { start: { line: 1, character: 1 }, end: { line: 1, character: 1 } }, 'X')).toBe('a\r\nbXc\r\n');
  });
});

describe('inline edit run (Demo agent)', () => {
  it('returns a proposal and removes its throwaway chat', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir);
    const owned = new Set<string>();
    const result = await runInline(core, 'claude', 'context', 'make it fast', undefined, owned).done;
    expect(result?.replacement).toContain('make it fast');
    expect(core.snapshot.chats.length).toBe(0);
    expect(owned.size).toBe(0);
  });

  it('rejects any file write the agent attempts, leaving the file untouched', async () => {
    const dir = await gitRepo();
    const file = path.join(dir, 'README.md');
    const before = await readFile(file, 'utf8');
    // The Demo agent's "edit" command writes a file; makeCore would approve it, the inline run must not.
    await writeFile(path.join(dir, 'x.txt'), 'keep\n');
    const core = makeCore(dir);
    const result = await runInline(core, 'claude', 'context', `edit ${path.join(dir, 'x.txt')}`).done;
    expect(result?.reply).toContain('Skipped the edit');
    expect(await readFile(path.join(dir, 'x.txt'), 'utf8')).toBe('keep\n');
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('cancels: resolves undefined and removes the chat', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir);
    const run = runInline(core, 'claude', 'context', 'wait');
    setTimeout(() => run.cancel(), 300);
    expect(await run.done).toBeUndefined();
    expect(core.snapshot.chats.length).toBe(0);
  });
});
