import net from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { encodeRequest, parseRequest } from '../src/bridge/protocol';
import { BridgeServer } from '../src/host/bridge';
import type { AgentToAgent } from '../src/host/bridgeRequests';
import { lastReply, type BridgeItem } from '../src/shared/model';
import { buildBridge, disposeCores, gitRepo, makeCore, waitFor } from './helpers';

let bridgeScript: string;
beforeAll(async () => {
  bridgeScript = await buildBridge();
});
afterEach(disposeCores);

const bridgeItems = (items: { kind: string }[]) => items.filter((i): i is BridgeItem => i.kind === 'bridge');

describe('the FriedLiver tools, used by the demo agent', () => {
  it('asks the user, then asks the other agent and replies with its answer', async () => {
    const dir = await gitRepo();
    const asked: string[] = [];
    const core = makeCore(dir, { bridgeScript, policy: () => 'ask', ui: { showReview: () => {}, closeReview: () => {}, askBridge: (a) => asked.push(a.title) } });
    const a = await core.createChat('demo');
    const turn = core.send(a.id, 'ask demo hello');

    await waitFor(() => core.decisions().length > 0);
    const [decision] = core.decisions();
    // The chat by its topic (titled from its first message), not its label.
    const named = `“${core.chat(a.id)!.title}” wants to ask Demo`;
    expect(named).toBe('“Ask demo hello” wants to ask Demo');
    expect(decision).toMatchObject({ kind: 'bridge', chatId: a.id, title: named });
    expect(asked).toEqual([named]);
    expect(core.snapshot.chats).toHaveLength(1);
    core.answerBridge(decision.id, 'allow');
    await turn;

    const chat = core.chat(a.id)!;
    expect(bridgeItems(chat.items)).toEqual([expect.objectContaining({ tool: 'ask_agent', target: { agent: 'demo' }, text: 'hello', state: 'allowed' })]);
    expect(lastReply(chat)).toMatch(/^Demo says: You said: \[FriedLiver\] Demo, another coding agent[\s\S]*hello$/);
    const consulted = core.snapshot.chats[1];
    expect(consulted).toMatchObject({ agent: 'demo', depth: 1, origin: { kind: 'consult', chatId: a.id, by: 'agent' } });
    expect(chat.items.some((i) => i.kind === 'link' && i.role === 'reply')).toBe(true);
  });

  it('tells the agent when the user says no', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir, { bridgeScript, policy: () => 'ask' });
    const a = await core.createChat('demo');
    const turn = core.send(a.id, 'ask gemini hello');
    await waitFor(() => core.decisions().length > 0);
    core.answerBridge(core.decisions()[0].id, 'deny');
    await turn;
    expect(lastReply(core.chat(a.id)!)).toMatch(/^Couldn't ask Gemini: The user did not allow this/);
    expect(bridgeItems(core.chat(a.id)!.items)[0].state).toBe('denied');
    expect(core.snapshot.chats).toHaveLength(1);
  });

  it('allows the rest of a chat after "allow for this chat"', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir, { bridgeScript, policy: () => 'ask' });
    const a = await core.createChat('demo');
    const first = core.send(a.id, 'ask demo one');
    await waitFor(() => core.decisions().length > 0);
    core.answerBridge(core.decisions()[0].id, 'allowChat');
    await first;
    await core.send(a.id, 'ask demo two');
    expect(lastReply(core.chat(a.id)!)).toMatch(/two$/);
    expect(bridgeItems(core.chat(a.id)!.items).map((i) => i.state)).toEqual(['allowed', 'allowed']);
    // The second question went to the same consultation.
    expect(core.snapshot.chats).toHaveLength(2);
    expect(core.snapshot.chats[1].turns).toBe(2);

    const b = await core.createChat('demo');
    const other = core.send(b.id, 'ask demo three');
    await waitFor(() => core.decisions().length > 0);
    expect(core.decisions()[0].chatId).toBe(b.id);
    await core.cancel(b.id);
    await other;
    expect(bridgeItems(core.chat(b.id)!.items)[0].state).toBe('denied');
  });

  it('gives agents no tools when connections are off', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir, { bridgeScript, policy: () => 'off' });
    const a = await core.createChat('demo');
    await core.send(a.id, 'ask demo hello');
    expect(lastReply(core.chat(a.id)!)).toBe("Couldn't ask Demo: This session has no FriedLiver tools.");
  });

  it('stops agents from starting chats past the depth limit', async () => {
    const dir = await gitRepo();
    const policy: AgentToAgent = 'allow';
    const core = makeCore(dir, { bridgeScript, policy: () => policy });
    const a = await core.createChat('demo');
    await core.send(a.id, 'ask demo ask demo ask demo hi');
    expect(core.snapshot.chats.map((c) => c.depth)).toEqual([0, 1, 2]);
    expect(lastReply(core.chat(a.id)!)).toMatch(/^Demo says: Demo says: Couldn't ask Demo: Too many hops/);
  });

  it('cancels the consultation an agent waits on when its own turn is stopped', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir, { bridgeScript, policy: () => 'allow' });
    const a = await core.createChat('demo');
    const turn = core.send(a.id, 'ask demo wait');
    await waitFor(() => core.snapshot.chats[1]?.busy === true);
    await core.cancel(a.id);
    await turn;
    await waitFor(() => !core.snapshot.chats[1].busy);
    expect(core.snapshot.chats[1].items.at(-1)).toMatchObject({ kind: 'notice', text: 'Stopped.' });
    expect(core.chat(a.id)!.items).toContainEqual(expect.objectContaining({ kind: 'notice', text: 'Stopped.' }));
  });

  it('refuses the caller itself, busy chats and unknown ones, and messages idle ones', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir, { bridgeScript, policy: () => 'allow' });
    const a = await core.createChat('demo');
    const b = await core.createChat('gemini');
    const signal = new AbortController().signal;
    const call = (c: Parameters<typeof core.bridgeCall>[1]) => core.bridgeCall(a.id, c, signal);

    await expect(call({ tool: 'send_to_chat', chatId: a.id, message: 'hi' })).rejects.toThrow(/That is this chat/);
    await expect(call({ tool: 'read_chat', chatId: 'chat-99' })).rejects.toThrow(/no chat chat-99/);
    await expect(call({ tool: 'ask_agent', agent: 'claude', prompt: 'x', chatId: b.id })).rejects.toThrow(/gemini chat, not claude/);

    const busy = core.send(b.id, 'wait');
    await waitFor(() => core.chat(b.id)!.busy);
    await expect(call({ tool: 'send_to_chat', chatId: b.id, message: 'hi' })).rejects.toThrow(/busy/);
    await core.cancel(b.id);
    await busy;

    expect(await call({ tool: 'send_to_chat', chatId: b.id, message: 'from a' })).toMatch(/^Sent to “wait” \(chat-/);
    await waitFor(() => core.chat(b.id)!.turns === 2);
    expect(core.chat(b.id)!.items.find((i) => i.kind === 'link')).toMatchObject({ role: 'piped-in', chatId: a.id, by: 'agent', text: 'from a' });
    expect(await call({ tool: 'read_chat', chatId: b.id, last: 1 })).toContain('From Demo');
  });

  it('lists chats for the agent', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir, { bridgeScript, policy: () => 'ask' });
    await core.createChat('gemini');
    const a = await core.createChat('demo');
    await core.send(a.id, 'chats');
    const reply = lastReply(core.chat(a.id)!);
    expect(reply).toContain('chat-1 · Gemini (Gemini) · "New chat" · idle');
    expect(reply).toContain(`${a.id} · Demo (Demo) · "chats" · busy, this chat`);
    expect(core.decisions()).toEqual([]);
  });
});

describe('the bridge socket', () => {
  let server: BridgeServer | undefined;
  afterEach(async () => {
    await server?.dispose();
    server = undefined;
  });

  /** Sends raw bytes and resolves with the first line back, or "closed". */
  function exchange(address: string, data: string | Buffer): Promise<string> {
    return new Promise((resolve) => {
      const socket = net.createConnection(address);
      let got = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        got += chunk;
        if (got.includes('\n')) {
          resolve(got.split('\n')[0]);
          socket.destroy();
        }
      });
      socket.on('close', () => resolve(got ? got.split('\n')[0] : 'closed'));
      socket.on('error', () => {});
      socket.write(data);
    });
  }

  it('acts as the chat a token belongs to, and hangs up on anything else', async () => {
    const calls: string[] = [];
    server = await BridgeServer.start(async (chatId, call) => {
      calls.push(`${chatId} ${call.tool}`);
      return 'ok';
    });
    const token = server.token('chat-7');
    expect(server.token('chat-7')).toBe(token);
    expect(JSON.parse(await exchange(server.address, encodeRequest(1, token, 'list_chats', {})))).toEqual({ id: 1, ok: true, text: 'ok' });
    expect(calls).toEqual(['chat-7 list_chats']);

    const wrong = 'f'.repeat(64);
    expect(await exchange(server.address, encodeRequest(2, wrong, 'list_chats', {}))).toBe('closed');
    expect(await exchange(server.address, 'not json\n')).toBe('closed');
    expect(await exchange(server.address, encodeRequest(3, token, 'ask_agent', { agent: 'bob', prompt: 'hi' }))).toBe('closed');
    expect(await exchange(server.address, Buffer.alloc(1024 * 1024 + 10, 'a'))).toBe('closed');

    server.revoke('chat-7');
    expect(await exchange(server.address, encodeRequest(4, token, 'list_chats', {}))).toBe('closed');
    expect(calls).toHaveLength(1);
  });

  it('checks every tool call', () => {
    const t = 'a'.repeat(64);
    const line = (tool: string, args: unknown) => JSON.stringify({ id: 1, token: t, tool, args });
    expect(parseRequest(line('ask_agent', { agent: 'gemini', prompt: 'why?', chat_id: 'chat-2' }))?.call).toEqual({ tool: 'ask_agent', agent: 'gemini', prompt: 'why?', chatId: 'chat-2' });
    expect(parseRequest(line('read_chat', { chat_id: 'chat-2', last: 5 }))?.call).toEqual({ tool: 'read_chat', chatId: 'chat-2', last: 5 });
    for (const [tool, args] of [
      ['ask_agent', { agent: 'gemini', prompt: '  ' }],
      ['ask_agent', { agent: 'gemini', prompt: 'x', chat_id: '../etc' }],
      ['send_to_chat', { chat_id: 'chat-2', message: 'x'.repeat(100_001) }],
      ['read_chat', { chat_id: 'chat-2', last: 0 }],
      ['read_chat', { chat_id: 'chat-2', last: 51 }],
      ['delete_everything', {}],
    ] as const) {
      expect(parseRequest(line(tool, args))).toBeNull();
    }
    expect(parseRequest(JSON.stringify({ id: 1, token: 'short', tool: 'list_chats' }))).toBeNull();
  });
});
