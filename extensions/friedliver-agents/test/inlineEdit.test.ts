import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyReplacement, INLINE_AROUND, INLINE_LIMITS, INLINE_MARK, inlinePrompt, parseReplacement, runInline } from '../src/host/inlineEdit';
import { lastReply } from '../src/shared/model';
import { readOnlyChoice, type SessionOption } from '../src/shared/session';
import { waitFor } from './helpers';
import { buildBridge, disposeCores, gitRepo, makeCore } from './helpers';

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

describe('read-only chats (enforced in the core)', () => {
  const spies = () => {
    const shown: string[] = [];
    return {
      shown,
      ui: {
        showReview: () => shown.push('review'),
        closeReview: () => {},
        askCommand: () => shown.push('command'),
        askPermission: () => shown.push('permission'),
        askBridge: () => shown.push('bridge'),
        askQuestion: () => shown.push('question'),
      },
    };
  };

  it('refuses a command an Always-allow rule and Full auto would run, without showing anything', async () => {
    const dir = await gitRepo();
    const { shown, ui } = spies();
    const core = makeCore(dir, { ui, rules: { get: () => [{ kind: 'prefix', command: process.execPath }], add: () => {} } });
    const chat = await core.createChat('claude', { readOnly: true, approval: 'full' });
    await core.send(chat.id, 'run');
    expect(lastReply(core.chat(chat.id)!)).toContain('denied the command');
    expect(shown).toEqual([]);
  });

  it('refuses writes at any level, with no card or diff', async () => {
    const dir = await gitRepo();
    const file = path.join(dir, 'x.txt');
    await writeFile(file, 'keep\n');
    const { shown, ui } = spies();
    const core = makeCore(dir, { ui });
    const chat = await core.createChat('claude', { readOnly: true, approval: 'full' });
    await core.send(chat.id, `edit ${file}`);
    await core.send(chat.id, 'question');
    expect(await readFile(file, 'utf8')).toBe('keep\n');
    expect(shown).toEqual([]);
  });

  it('offers no FriedLiver tools even when the bridge policy is allow', async () => {
    const dir = await gitRepo();
    const { shown, ui } = spies();
    const core = makeCore(dir, { ui, bridgeScript: await buildBridge(), policy: () => 'allow' });
    const chat = await core.createChat('claude', { readOnly: true });
    await core.send(chat.id, 'ask demo hello');
    expect(lastReply(core.chat(chat.id)!)).not.toContain('Demo says');
    expect(core.snapshot.chats).toHaveLength(1);
    expect(shown).toEqual([]);
  });
});

describe("read-only chats: the agent's own mode", () => {
  const sel = (id: string, name: string, choices: [string, string][], category?: string): SessionOption => ({ id, name, category, type: 'select', current: choices[0][0], choices: choices.map(([value, n]) => ({ value, name: n })), via: 'option' });

  it('picks read-only before plan, by id or name, and nothing when neither is offered', () => {
    const codex = [sel('approval_preset', 'Approval', [['auto', 'Auto'], ['read-only', 'Read Only']])];
    const claude = [sel('mode', 'Mode', [['default', 'Ask'], ['plan', 'Plan'], ['bypassPermissions', 'Full']], 'mode')];
    expect(readOnlyChoice(codex)).toMatchObject({ value: 'read-only' });
    expect(readOnlyChoice(claude)).toMatchObject({ value: 'plan' });
    expect(readOnlyChoice([...claude, ...codex])).toMatchObject({ value: 'read-only' });
    expect(readOnlyChoice([sel('model', 'Model', [['plan-x', 'Plan X']], 'model')])).toBeUndefined();
    expect(readOnlyChoice([sel('mode', 'Mode', [['default', 'Ask']], 'mode')])).toBeUndefined();
  });

  it("puts the Demo agent in its Plan mode, whatever the chat's level", async () => {
    const dir = await gitRepo();
    const core = makeCore(dir);
    const chat = await core.createChat('claude', { readOnly: true, approval: 'full' });
    await core.send(chat.id, 'hi');
    await waitFor(() => readOnlyChoice(core.chat(chat.id)?.session?.options ?? [])?.option.current === 'plan');
    const normal = await core.createChat('claude');
    await core.send(normal.id, 'hi');
    expect(core.chat(normal.id)?.session?.options.find((o) => o.category === 'mode')?.current).not.toBe('plan');
  });
});

describe('read-only chats: never a loaded session', () => {
  it('starts a fresh session with the tool limits and Plan mode when the agent comes back, where a normal chat reloads', async () => {
    const before = process.env.FAKE_AGENT_LOAD_SESSION;
    process.env.FAKE_AGENT_LOAD_SESSION = '1';
    try {
      const dir = await gitRepo();
      const core = makeCore(dir);
      const ro = await core.createChat('claude', { readOnly: true });
      const normal = await core.createChat('claude');
      const session = async (id: string) => {
        await core.send(id, 'session');
        return lastReply(core.chat(id)!);
      };
      const first = await session(ro.id);
      expect(first).toContain('"disallowedTools"');
      const normalFirst = await session(normal.id);
      await core.stopAgent('claude');
      const second = await session(ro.id);
      expect(second).toContain('"tools":[]');
      expect((await session(normal.id)).split(',')[0]).toBe(normalFirst.split(',')[0]);
      // session/new, not session/load: the restarted Demo numbers sessions from 1 again, so the notice tells them apart.
      const fresh = (id: string) => core.chat(id)!.items.some((i) => i.kind === 'notice' && /continues in a new session/.test(i.text));
      expect(fresh(ro.id)).toBe(true);
      expect(fresh(normal.id)).toBe(false);
      await waitFor(() => readOnlyChoice(core.chat(ro.id)?.session?.options ?? [])?.option.current === 'plan');
    } finally {
      if (before === undefined) delete process.env.FAKE_AGENT_LOAD_SESSION;
      else process.env.FAKE_AGENT_LOAD_SESSION = before;
    }
  });
});
