import { describe, expect, it } from 'vitest';
import { EXTERNAL_CLIENT } from '../src/bridge/protocol';
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

describe('browser tools', () => {
  function browserHost(approval?: 'ask' | 'edits' | 'full', policy: 'ask' | 'allow' | 'off' = 'ask') {
    const h = host(policy);
    if (approval) h.dispatch({ t: 'approval', chatId: 'chat-1', level: approval });
    const done: string[] = [];
    h.browser = async (_chatId, call) => {
      done.push('url' in call ? `${call.tool} ${call.url}` : call.tool);
      return 'ok';
    };
    return { h, done, requests: new BridgeRequests(h), signal: new AbortController().signal };
  }
  const bridgeItems = (h: ToolHost) => h.state.chats[0].items.filter((i) => i.kind === 'bridge');

  it('looks without asking', async () => {
    const { h, done, requests, signal } = browserHost();
    for (const tool of ['browser_snapshot', 'browser_screenshot', 'browser_console'] as const) await expect(requests.call('chat-1', { tool }, signal)).resolves.toBe('ok');
    expect(done).toEqual(['browser_snapshot', 'browser_screenshot', 'browser_console']);
    expect(bridgeItems(h)).toHaveLength(0);
  });

  it('waits for the user before acting, and does nothing when denied', async () => {
    const { h, done, requests, signal } = browserHost('edits');
    const click = requests.call('chat-1', { tool: 'browser_click', text: 'Sign in' }, signal);
    const [item] = bridgeItems(h);
    expect(item).toMatchObject({ tool: 'browser_click', target: { browser: true }, text: '"Sign in"', state: 'awaiting' });
    expect(done).toEqual([]);
    if (item.kind === 'bridge') requests.answer(item.requestId, 'deny');
    await expect(click).rejects.toThrow(/did not allow/);
    expect(done).toEqual([]);
  });

  it('acts at once on Full auto, and still records it in the chat', async () => {
    const { h, done, requests, signal } = browserHost('full');
    await expect(requests.call('chat-1', { tool: 'browser_open', url: 'localhost:3000' }, signal)).resolves.toBe('ok');
    expect(done).toEqual(['browser_open http://localhost:3000/']);
    expect(bridgeItems(h)).toEqual([expect.objectContaining({ tool: 'browser_open', text: 'http://localhost:3000/', state: 'allowed' })]);
  });

  it('asks even when agent-to-agent calls are on "allow": only Full auto skips it', async () => {
    const { h, requests, signal } = browserHost(undefined, 'allow');
    void requests.call('chat-1', { tool: 'browser_reload' }, signal).catch(() => {});
    expect(bridgeItems(h)).toEqual([expect.objectContaining({ state: 'awaiting' })]);
  });

  it('refuses file:, javascript: and the like before asking anyone', async () => {
    const { h, done, requests, signal } = browserHost('full');
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://gpu', 'devtools://x']) {
      await expect(requests.call('chat-1', { tool: 'browser_open', url }, signal)).rejects.toThrow(/only http and https/);
    }
    expect(done).toEqual([]);
    expect(bridgeItems(h)).toHaveLength(0);
  });

  it('"Allow for this chat" covers later browser actions, not other agents', async () => {
    const { h, done, requests, signal } = browserHost();
    const first = requests.call('chat-1', { tool: 'browser_back' }, signal);
    const [item] = bridgeItems(h);
    if (item.kind === 'bridge') requests.answer(item.requestId, 'allowChat');
    await first;
    await expect(requests.call('chat-1', { tool: 'browser_type', selector: '#q', text: 'hi' }, signal)).resolves.toBe('ok');
    expect(done).toEqual(['browser_back', 'browser_type']);
    void requests.call('chat-1', { tool: 'read_chat', chatId: 'chat-2' }, signal).catch(() => {});
    expect(bridgeItems(h).at(-1)).toMatchObject({ tool: 'read_chat', state: 'awaiting' });
  });

  it('says so when the editor has no browser, and is off with the other tools', async () => {
    const requests = new BridgeRequests(host());
    const signal = new AbortController().signal;
    await expect(requests.call('chat-1', { tool: 'browser_snapshot' }, signal)).rejects.toThrow(/isn't available/);
    const off = browserHost('full', 'off');
    await expect(off.requests.call('chat-1', { tool: 'browser_snapshot' }, signal)).rejects.toThrow(/turned off/);
  });
});

describe('browser requests whose world changed while the user decided', () => {
  function setup() {
    let policy: 'ask' | 'off' = 'ask';
    const h = host();
    h.policy = () => policy;
    const done: string[] = [];
    h.browser = async (_c, call) => (done.push(call.tool), 'ok');
    const requests = new BridgeRequests(h);
    const signal = new AbortController().signal;
    const pending = requests.call('chat-1', { tool: 'browser_reload' }, signal);
    const item = h.state.chats[0].items.find((i) => i.kind === 'bridge')!;
    return { h, done, requests, pending, id: item.kind === 'bridge' ? item.requestId : '', off: () => (policy = 'off') };
  }

  it('does nothing when the tools are turned off mid-approval, even if allowed', async () => {
    const s = setup();
    s.off();
    s.requests.answer(s.id, 'allow');
    await expect(s.pending).rejects.toThrow(/turned off/);
    expect(s.done).toEqual([]);
  });

  it('refuseAll denies everything waiting', async () => {
    const s = setup();
    s.off();
    s.requests.refuseAll();
    await expect(s.pending).rejects.toThrow(/did not allow/);
    expect(s.done).toEqual([]);
  });

  it('does nothing when the chat closed mid-approval', async () => {
    const s = setup();
    s.h.dispatch({ t: 'closed', chatId: 'chat-1' });
    s.requests.answer(s.id, 'allow');
    await expect(s.pending).rejects.toThrow(/closed/);
    expect(s.done).toEqual([]);
  });
});

describe('the external client (Claude Code outside FriedLiver)', () => {
  const ext = (auto = false) => {
    const h = host();
    const done: string[] = [];
    const asked: string[] = [];
    h.browser = async (_c, call) => (done.push(call.tool), 'ok');
    h.notify = (a) => asked.push(a.title);
    h.externalAutoApprove = () => auto;
    return { h, done, asked, requests: new BridgeRequests(h), signal: new AbortController().signal };
  };

  it('reaches only the browser tools', async () => {
    const { requests, signal } = ext(true);
    for (const call of [{ tool: 'list_chats' }, { tool: 'list_agents' }, { tool: 'read_chat', chatId: 'chat-1' }] as const) {
      await expect(requests.call(EXTERNAL_CLIENT, call, signal)).rejects.toThrow(/Only the browser_\* tools/);
    }
  });

  it('asks the user before acting, as "Claude Code", and does nothing when denied', async () => {
    const { done, asked, requests, signal } = ext();
    await expect(requests.call(EXTERNAL_CLIENT, { tool: 'browser_snapshot' }, signal)).resolves.toBe('ok');
    let id = '';
    const notify = new Promise<void>((r) => (requests['host'].notify = (a) => ((id = a.requestId), asked.push(a.title), r())));
    const click = requests.call(EXTERNAL_CLIENT, { tool: 'browser_click', text: 'Buy' }, signal);
    await notify;
    expect(asked).toEqual(['Claude Code wants to click in the browser']);
    requests.answer(id, 'deny');
    await expect(click).rejects.toThrow(/did not allow/);
    expect(done).toEqual(['browser_snapshot']);
  });

  it('"Allow for this session" covers later actions; auto-approve only by setting; URL rules still apply', async () => {
    const { done, requests, signal } = ext();
    let id = '';
    requests['host'].notify = (a) => (id = a.requestId);
    const first = requests.call(EXTERNAL_CLIENT, { tool: 'browser_reload' }, signal);
    requests.answer(id, 'allowChat');
    await first;
    await expect(requests.call(EXTERNAL_CLIENT, { tool: 'browser_back' }, signal)).resolves.toBe('ok');
    expect(done).toEqual(['browser_reload', 'browser_back']);
    const auto = ext(true);
    await expect(auto.requests.call(EXTERNAL_CLIENT, { tool: 'browser_open', url: 'localhost:3000' }, auto.signal)).resolves.toBe('ok');
    await expect(auto.requests.call(EXTERNAL_CLIENT, { tool: 'browser_open', url: 'file:///etc/passwd' }, auto.signal)).rejects.toThrow(/only http and https/);
    expect(auto.asked).toEqual([]);
  });
});
