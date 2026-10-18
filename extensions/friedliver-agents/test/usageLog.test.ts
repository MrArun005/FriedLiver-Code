import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_STATE, MAX_USAGE_LOG, reduce } from '../src/shared/model';
import { usageLines } from '../src/shared/session';
import { parseSaved, trimForSave } from '../src/host/persist';
import { chat } from './fixtures/chats';
import { disposeCores, gitRepo, makeCore, waitFor } from './helpers';

afterEach(disposeCores);

const turn = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({ at: 1, input, output, cacheRead, cacheWrite });

describe('per-turn token usage', () => {
  it('logs each turn per chat, adds the totals, ignores junk and keeps the newest turns', () => {
    let s = reduce(EMPTY_STATE, { t: 'created', chat: chat('chat-1') });
    s = reduce(s, { t: 'turnUsage', chatId: 'chat-1', usage: { ...turn(1000, 200, 9000, 500), context: { used: 12_000, size: 200_000 }, cost: { amount: 0.02, currency: 'USD' } } });
    s = reduce(s, { t: 'turnUsage', chatId: 'chat-1', usage: turn(2000, NaN, -4, 100) });
    const c = s.chats[0];
    expect(c.usageLog).toEqual([
      { ...turn(1000, 200, 9000, 500), context: { used: 12_000, size: 200_000 }, cost: { amount: 0.02, currency: 'USD' } },
      turn(2000, 0, 0, 100),
    ]);
    expect(c.tokens).toMatchObject({ input: 3000, output: 200, cacheRead: 9000, cacheWrite: 600 });
    expect(usageLines(c.usageLog)).toEqual([
      'Tokens in this chat: 2 turns · 3k input · 200 output · 9k cache read · 600 cache write',
      'Last turn: 2k input · 0 output · 0 cache read · 100 cache write',
    ]);
    expect(usageLines(undefined)).toEqual([]);
    for (let i = 0; i < MAX_USAGE_LOG + 5; i++) s = reduce(s, { t: 'turnUsage', chatId: 'chat-1', usage: turn(i, 0, 0, 0) });
    expect(s.chats[0].usageLog).toHaveLength(MAX_USAGE_LOG);
    expect(s.chats[0].usageLog!.at(-1)!.input).toBe(MAX_USAGE_LOG + 4);
  });

  it('is kept on disk with the chat, junk dropped on the way back', () => {
    const log = [{ ...turn(1, 2, 3, 4), context: { used: 5, size: 10 }, cost: { amount: 0.5, currency: 'USD' } }, turn(1, 1, 1, 1)];
    const c = chat('chat-1', { usageLog: [...log, { at: 'x' } as never] });
    const saved = trimForSave({ version: 1, state: { chats: [c], images: [], links: [] }, chats: { 'chat-1': { agent: 'demo', cwd: '/w' } }, nextId: 2, chatCount: {} });
    expect(parseSaved(JSON.parse(JSON.stringify(saved)))!.state.chats[0].usageLog).toEqual(log);
  });

  it('comes from the agent\'s prompt response and usage_update, and reads as the usage tooltip lines', async () => {
    const core = makeCore(await gitRepo());
    const { id } = await core.createChat('demo');
    await core.send(id, 'hello');
    await waitFor(() => !!core.chat(id)!.usageLog?.length);
    const [t] = core.chat(id)!.usageLog!;
    expect(t).toMatchObject({ input: 1200, output: 300, cacheRead: 800, cacheWrite: 100 });
    expect(t.context?.size).toBeGreaterThan(0);
    expect(usageLines(core.chat(id)!.usageLog)).toContain('Tokens in this chat: 1 turn · 1.2k input · 300 output · 800 cache read · 100 cache write');
  }, 30_000);
});
