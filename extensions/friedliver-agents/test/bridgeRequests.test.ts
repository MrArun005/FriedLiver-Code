import { describe, expect, it } from 'vitest';
import { BridgeRequests, MAX_WAITING_PER_CHAT, type ToolHost } from '../src/host/bridgeRequests';
import { EMPTY_STATE, reduce, type Action, type AppState, type ChatView } from '../src/shared/model';

const chat = (id: string, over: Partial<ChatView> = {}): ChatView => ({
  id,
  agent: 'demo',
  label: id,
  title: 'Task',
  cwd: '/w',
  createdAt: 0,
  busy: false,
  changedFiles: 0,
  items: [],
  depth: 0,
  files: [],
  lastActivity: 0,
  turns: 0,
  ...over,
});

function host(policy: 'ask' | 'allow' | 'off' = 'ask') {
  let state: AppState = [chat('chat-1'), chat('chat-2')].reduce((s, c) => reduce(s, { t: 'created', chat: c }), EMPTY_STATE);
  let n = 0;
  const h: ToolHost = {
    get state() {
      return state;
    },
    policy: () => policy,
    dispatch: (action: Action) => {
      state = reduce(state, action);
    },
    id: (prefix) => `${prefix}-${++n}`,
    notify: () => {},
    consultation: () => undefined,
    consult: async () => 'answer',
    message: () => {},
    cancel: async () => {},
  };
  return h;
}

describe('agent requests waiting on the user', () => {
  it(`holds at most ${MAX_WAITING_PER_CHAT} per chat and refuses the rest`, async () => {
    const h = host();
    const requests = new BridgeRequests(h);
    const signal = new AbortController().signal;
    const waiting = Array.from({ length: MAX_WAITING_PER_CHAT }, () => requests.call('chat-1', { tool: 'read_chat', chatId: 'chat-2' }, signal));
    await expect(requests.call('chat-1', { tool: 'read_chat', chatId: 'chat-2' }, signal)).rejects.toThrow(/already wait for the user/);
    const items = h.state.chats[0].items.filter((i) => i.kind === 'bridge');
    expect(items).toHaveLength(MAX_WAITING_PER_CHAT);

    // Another chat still gets its own requests through, and answering frees a slot.
    const other = requests.call('chat-2', { tool: 'read_chat', chatId: 'chat-1' }, signal);
    for (const i of items) if (i.kind === 'bridge') requests.answer(i.requestId, 'deny');
    await Promise.all(waiting.map((w) => expect(w).rejects.toThrow(/did not allow/)));
    const next = requests.call('chat-1', { tool: 'read_chat', chatId: 'chat-2' }, signal);
    const latest = h.state.chats[0].items.filter((i) => i.kind === 'bridge').at(-1);
    if (latest?.kind === 'bridge') requests.answer(latest.requestId, 'allow');
    await expect(next).resolves.toContain('chat-2');
    requests.settle('chat-2', true);
    await expect(other).rejects.toThrow(/did not allow/);
  });

  it('never waits under "allow"', async () => {
    const requests = new BridgeRequests(host('allow'));
    const signal = new AbortController().signal;
    for (let i = 0; i < MAX_WAITING_PER_CHAT + 2; i++) {
      await expect(requests.call('chat-1', { tool: 'read_chat', chatId: 'chat-2' }, signal)).resolves.toContain('chat-2');
    }
  });
});
