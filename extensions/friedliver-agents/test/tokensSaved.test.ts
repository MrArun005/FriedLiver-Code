import { describe, expect, it } from 'vitest';
import { EMPTY_STATE, reduce } from '../src/shared/model';
import { savedLines, totalSaved } from '../src/shared/session';
import { chat } from './fixtures/chats';

describe('tokens saved readout', () => {
  it('adds up per chat, ignoring junk', () => {
    let s = reduce(EMPTY_STATE, { t: 'created', chat: chat('chat-1') });
    s = reduce(s, { t: 'tokens', chatId: 'chat-1', add: { naive: 12_000, sent: 800 } });
    s = reduce(s, { t: 'tokens', chatId: 'chat-1', add: { naive: 3_000, sent: 200, input: 1000, cacheRead: 9000 } });
    s = reduce(s, { t: 'tokens', chatId: 'chat-1', add: { naive: -5, sent: NaN } });
    expect(s.chats[0].tokens).toEqual({ naive: 15_000, sent: 1_000, cacheRead: 9000, input: 1000 });
    expect(savedLines(s.chats[0].tokens)).toEqual(['FriedLiver saved ~14k tokens in this chat (1k sent where the naive way takes ~15k)', 'Prompt cache: 90% of input tokens read from cache']);
    expect(savedLines(undefined)).toEqual([]);
    s = reduce(s, { t: 'created', chat: chat('chat-2', { tokens: { naive: 1000, sent: 100, cacheRead: 0, input: 0 } }) });
    expect(totalSaved(s.chats)).toBe(14_900);
  });
});
