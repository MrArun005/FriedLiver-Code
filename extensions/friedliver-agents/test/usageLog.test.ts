import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_STATE, MAX_USAGE_LOG, reduce } from '../src/shared/model';
import { dailyWarning, usageLines, usageTotalLines, usageTotals } from '../src/shared/session';
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

  it('adds up every chat in the window, and the turns since local midnight', () => {
    const now = new Date(2026, 9, 18, 15, 0).getTime();
    const yesterday = new Date(2026, 9, 17, 23, 59).getTime();
    const chats = [
      chat('chat-1', { usageLog: [{ ...turn(1000, 200, 5000, 100), at: yesterday }, { ...turn(500, 100, 2000, 0), at: now - 60_000 }] }),
      chat('chat-2', { usageLog: [{ ...turn(300, 50, 0, 50), at: now }] }),
      chat('chat-3'),
    ];
    const t = usageTotals(chats, now);
    expect(t.window).toEqual({ input: 1800, output: 350, cacheRead: 7000, cacheWrite: 150, total: 9300, turns: 3 });
    expect(t.today).toEqual({ input: 800, output: 150, cacheRead: 2000, cacheWrite: 50, total: 3000, turns: 2 });
    expect(usageTotalLines(t)).toContain('Today: 3k (800 input · 150 output · 2k cache read · 50 cache write)');
    expect(usageTotals([], now).today.total).toBe(0);
  });

  it('warns once a day past the limit the user set, and never when it is off', () => {
    const day = new Date(2026, 9, 18, 15, 0).getTime();
    expect(dailyWarning(0, 5_000_000, day, undefined)).toBeUndefined();
    expect(dailyWarning(1_000_000, 999_999, day, undefined)).toBeUndefined();
    const w = dailyWarning(1_000_000, 1_200_000, day, undefined)!;
    expect(w.text).toBe("Today's chats in this window used 1.2M tokens, over your 1.0M daily warning (friedliver.usage.dailyTokenWarning).");
    expect(dailyWarning(1_000_000, 1_500_000, day + 3_600_000, w.day)).toBeUndefined();
    expect(dailyWarning(1_000_000, 1_500_000, day + 86_400_000, w.day)).toBeDefined();
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
