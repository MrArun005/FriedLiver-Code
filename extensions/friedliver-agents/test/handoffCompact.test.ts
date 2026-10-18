import { describe, expect, it } from 'vitest';
import { BridgeRequests, type ToolHost } from '../src/host/bridgeRequests';
import { handoffContext, rewoundHistory } from '../src/host/transcript';
import { EMPTY_STATE, reduce, type Action, type AppState } from '../src/shared/model';
import { estimateTokens } from '../src/shared/tokens';
import { chat, longChat } from './fixtures/chats';

describe('hand-off context', () => {
  it('is a compact summary: task, asks, where it stopped, open questions, files with hashes, how to fetch more', () => {
    const c = longChat();
    const out = handoffContext(c, { 'src/limiter.ts': '1a2b3c4d' });
    expect(out).toContain('Task: Add rate limiting');
    expect(out).toContain('User: Add rate limiting to the public API: 100 requests a minute per key');
    expect(out).toContain('User: Turn 39: also handle case 39');
    expect(out).toContain('(29 more in between)');
    expect(out).toMatch(/Where Demo stopped \(its last reply\):\nDemo: [\s\S]*Everything passes except the Redis-backed store\./);
    expect(out).toContain('- Should the limit be per key or per IP when no key is sent?');
    expect(out).toContain('- src/limiter.ts #1a2b3c4d');
    expect(out).toContain('read_chat with chat_id "chat-1"');
    expect(estimateTokens(out)).toBeLessThan(estimateTokens(rewoundHistory(c, c.items)) / 5);
  });
});

describe('read_chat between linked chats', () => {
  function host(links: AppState['links']) {
    let state: AppState = [chat('chat-1'), chat('chat-2'), chat('chat-3')].reduce((s, c) => reduce(s, { t: 'created', chat: c }), EMPTY_STATE);
    for (const link of links) state = reduce(state, { t: 'link', link });
    let n = 0;
    const h: ToolHost = {
      get state() {
        return state;
      },
      policy: () => 'ask',
      dispatch: (a: Action) => void (state = reduce(state, a)),
      id: (p) => `${p}-${++n}`,
      notify: () => {},
      consultation: () => undefined,
      consult: async () => '',
      message: () => {},
      cancel: async () => {},
    };
    return h;
  }
  const link = (kind: 'handoff' | 'consult' | 'pipe', from: string, to: string) => ({ id: `${from}-${to}`, kind, from, to, by: 'user' as const, createdAt: 0, active: true, count: 0 });

  it('needs no OK to read the chat that handed off to or consulted this one, and still asks otherwise', async () => {
    const r = new BridgeRequests(host([link('handoff', 'chat-1', 'chat-2'), link('consult', 'chat-3', 'chat-2')]));
    const signal = new AbortController().signal;
    await expect(r.call('chat-2', { tool: 'read_chat', chatId: 'chat-1' }, signal)).resolves.toContain('chat-1');
    await expect(r.call('chat-2', { tool: 'read_chat', chatId: 'chat-3' }, signal)).resolves.toContain('chat-3');
    let settled = false;
    void r.call('chat-1', { tool: 'read_chat', chatId: 'chat-2' }, signal).then(() => (settled = true), () => (settled = true));
    await new Promise((res) => setTimeout(res, 50));
    expect(settled).toBe(false);
  });
});
