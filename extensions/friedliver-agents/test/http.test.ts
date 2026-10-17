import { spawn } from 'node:child_process';
import http from 'node:http';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpTools } from '../src/bridge/http';
import { BRIDGE_ENV, TOKEN_ENV } from '../src/bridge/protocol';
import { BridgeServer, type BridgeHandler } from '../src/host/bridge';
import { lastReply } from '../src/shared/model';
import { buildBridge, disposeCores, gitRepo, makeCore } from './helpers';

const rpc = (id: number, method: string, params?: object) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** One request with node:http, so tests can set any header (fetch won't set Host). */
function request(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer; onResponse?: (res: http.IncomingMessage) => void } = {}): Promise<Answer | 'closed'> {
  return new Promise((resolve) => {
    const req = http.request(url, { method: opts.method ?? 'POST', headers: opts.headers, agent: false }, (res) => {
      opts.onResponse?.(res);
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on('error', () => resolve('closed'));
      res.on('close', () => resolve('closed'));
    });
    req.on('error', () => resolve('closed'));
    req.end(opts.body);
  });
}

const auth = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' });
const post = (url: string, token: string, message: unknown, headers: Record<string, string> = {}) => request(url, { headers: { ...auth(token), ...headers }, body: JSON.stringify(message) });
const json = (a: Answer | 'closed') => (a === 'closed' ? a : JSON.parse(a.body));
/** The JSON-RPC messages in an event stream. */
const events = (a: Answer | 'closed') =>
  a === 'closed'
    ? []
    : a.body
        .split('\n\n')
        .map((b) => b.split('\n').find((l) => l.startsWith('data: ')))
        .filter((l): l is string => !!l)
        .map((l) => JSON.parse(l.slice(6)));

describe('the FriedLiver tools over HTTP', () => {
  let server: BridgeServer | undefined;
  afterEach(async () => {
    await server?.dispose();
    server = undefined;
  });

  async function start(handler: BridgeHandler = async () => 'ok') {
    server = await BridgeServer.start(handler);
    const url = await server.httpUrl();
    return { url, token: server.token('chat-7') };
  }

  it('listens on 127.0.0.1 only, from the first session that asks', async () => {
    const { url } = await start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(await server!.httpUrl()).toBe(url);
  });

  it('answers what the stdio server answers, byte for byte', async () => {
    const script = await buildBridge();
    const { url, token } = await start(async (chatId, call) => {
      if (call.tool === 'read_chat') throw new Error(`no chat ${call.chatId}`);
      return `${chatId} ${call.tool}`;
    });
    const messages = [
      rpc(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {} }),
      rpc(2, 'tools/list'),
      rpc(3, 'tools/call', { name: 'list_chats' }),
      rpc(4, 'tools/call', { name: 'read_chat', arguments: { chat_id: 'chat-9' } }),
      rpc(5, 'tools/call', { name: 'ask_agent', arguments: { agent: 'nobody', prompt: 'hi' } }),
      rpc(6, 'tools/call', { name: 'rm_rf' }),
      rpc(7, 'resources/list'),
      rpc(8, 'ping'),
    ];
    // Over stdio, through dist/bridge.js and the socket.
    const child = spawn(process.execPath, [script], { env: { ...process.env, [BRIDGE_ENV]: server!.address, [TOKEN_ENV]: token }, stdio: ['pipe', 'pipe', 'inherit'] });
    const lines: string[] = [];
    let buffer = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      buffer += d;
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        lines.push(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
    const end = Date.now() + 10_000;
    while (lines.length < messages.length && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    child.stdin.end();
    const byId = new Map(lines.map((l) => [JSON.parse(l).id as number, l]));

    for (const m of messages) {
      // Plain JSON for every reply, and an event stream for tool calls when the client takes one.
      const plain = await post(url, token, m, { accept: 'application/json' });
      expect(plain !== 'closed' && plain.status).toBe(200);
      expect(plain !== 'closed' && plain.headers['content-type']).toBe('application/json');
      expect(plain !== 'closed' && plain.body).toBe(byId.get(m.id));
      // Calls that reach the editor (3 and 4) stream; the rest are answered at once.
      const streamed = await post(url, token, m);
      const got = [3, 4].includes(m.id) ? events(streamed).at(-1) : json(streamed);
      expect(JSON.stringify(got), m.method).toBe(byId.get(m.id));
    }
  }, 20_000);

  it('acts as the chat a token belongs to, and refuses anything else', async () => {
    const calls: string[] = [];
    const { url, token } = await start(async (chatId, call) => {
      calls.push(`${chatId} ${call.tool}`);
      return 'ok';
    });
    const list = rpc(1, 'tools/call', { name: 'list_agents' });
    expect(events(await post(url, token, list)).at(-1)).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } });
    expect(calls).toEqual(['chat-7 list_agents']);

    const status = async (a: Promise<Answer | 'closed'>) => {
      const r = await a;
      return r === 'closed' ? r : r.status;
    };
    const body = JSON.stringify(list);
    expect(await status(post(url, 'f'.repeat(64), list))).toBe(401);
    expect(await status(request(url, { headers: { 'content-type': 'application/json' }, body }))).toBe(401);
    expect(await status(post(url, token, list, { authorization: `Basic ${token}` }))).toBe(401);
    // DNS rebinding: a page that renamed itself 127.0.0.1 sends its own Host or Origin.
    expect(await status(post(url, token, list, { host: `evil.example:${new URL(url).port}` }))).toBe(403);
    expect(await status(post(url, token, list, { origin: 'http://evil.example' }))).toBe(403);
    expect(await status(post(url.replace('/mcp', '/other'), token, list))).toBe(404);
    expect(await status(post(url, token, list, { 'content-type': 'text/plain' }))).toBe(415);
    expect(await status(post(url, token, list, { 'mcp-protocol-version': '1999-01-01' }))).toBe(400);
    expect(await status(request(url, { method: 'GET', headers: auth(token) }))).toBe(405);
    expect(await status(request(url, { method: 'DELETE', headers: auth(token) }))).toBe(405);
    expect(await status(request(url, { headers: auth(token), body: '{not json' }))).toBe(400);
    // Over 1 MB: refused, or cut off while it is still being sent.
    expect([413, 'closed']).toContain(await status(request(url, { headers: auth(token), body: Buffer.alloc(1024 * 1024 + 10, 'a') })));
    expect([413, 'closed']).toContain(await status(request(url, { headers: { ...auth(token), 'content-length': String(2 * 1024 * 1024) }, body: 'x' })));
    // Invalid arguments never reach the editor.
    expect(json(await post(url, token, rpc(2, 'tools/call', { name: 'ask_agent', arguments: { agent: 'bob', prompt: 'hi' } })))).toMatchObject({ result: { isError: true } });

    server!.revoke('chat-7');
    expect(await status(post(url, token, list))).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it('takes notifications and batches', async () => {
    const { url, token } = await start();
    const note = await post(url, token, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(note !== 'closed' && [note.status, note.body]).toEqual([202, '']);
    const batch = json(await post(url, token, [{ jsonrpc: '2.0', method: 'notifications/initialized' }, rpc(1, 'ping'), rpc(2, 'tools/call', { name: 'list_chats' })]));
    expect(batch).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'ok' }] } },
    ]);
  });

  it('keeps a slow call waiting with progress, and stops waiting when the agent hangs up', async () => {
    let release: (() => void) | undefined;
    let aborted = false;
    const tools = await HttpTools.start({
      chatFor: (t) => (t === 'a'.repeat(64) ? 'chat-1' : undefined),
      call: (_chatId, _call, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve({ content: [{ type: 'text', text: 'gone' }] });
          });
          release = () => resolve({ content: [{ type: 'text', text: 'answer' }] });
        }),
      keepaliveMs: 50,
    });
    try {
      const token = 'a'.repeat(64);
      const slow = post(tools.url, token, rpc(1, 'tools/call', { name: 'ask_agent', arguments: { agent: 'demo', prompt: 'hi' }, _meta: { progressToken: 'p' } }));
      await new Promise((r) => setTimeout(r, 300));
      release!();
      const got = events(await slow);
      expect(got.length).toBeGreaterThan(2);
      expect(got[0]).toEqual({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p', progress: 1, message: 'Waiting for FriedLiver' } });
      expect(got.at(-1)).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'answer' }] } });

      // Without a progress token the stream still moves (comments), and a hang-up aborts the call.
      let firstChunk = '';
      const hungUp = request(tools.url, {
        headers: auth(token),
        body: JSON.stringify(rpc(2, 'tools/call', { name: 'list_chats' })),
        onResponse: (res) => res.once('data', (c: Buffer) => {
          firstChunk = c.toString();
          res.destroy();
        }),
      });
      await hungUp;
      const end = Date.now() + 5000;
      while (!aborted && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      expect(firstChunk).toBe(': waiting\n\n');
      expect(aborted).toBe(true);
    } finally {
      await tools.dispose();
    }
  });
});

describe('the FriedLiver tools, by transport', () => {
  let bridgeScript: string;
  beforeAll(async () => {
    bridgeScript = await buildBridge();
  });
  afterEach(async () => {
    delete process.env.FAKE_AGENT_MCP_HTTP;
    await disposeCores();
  });

  it('needs no tools server for an agent that takes HTTP', async () => {
    const dir = await gitRepo();
    // Not a script at all: over HTTP nothing is started.
    const core = makeCore(dir, { bridgeScript: '/nonexistent/bridge.js', policy: () => 'allow' });
    const a = await core.createChat('demo');
    await core.send(a.id, 'ask demo hello');
    expect(lastReply(core.chat(a.id)!)).toMatch(/^Demo says: You said: [\s\S]*hello$/);
  });

  it('starts a tools server for an agent that takes only stdio', async () => {
    process.env.FAKE_AGENT_MCP_HTTP = '0';
    const dir = await gitRepo();
    const broken = makeCore(dir, { bridgeScript: '/nonexistent/bridge.js', policy: () => 'allow' });
    const b = await broken.createChat('demo');
    await broken.send(b.id, 'ask demo hello');
    expect(lastReply(broken.chat(b.id)!)).toMatch(/^Couldn't ask Demo/);

    const core = makeCore(dir, { bridgeScript, policy: () => 'allow' });
    const a = await core.createChat('demo');
    await core.send(a.id, 'ask demo hello');
    expect(lastReply(core.chat(a.id)!)).toMatch(/^Demo says: You said: [\s\S]*hello$/);
  });
});
