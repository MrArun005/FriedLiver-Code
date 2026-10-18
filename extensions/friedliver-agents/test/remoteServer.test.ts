// FriedLiver Remote's server over real TLS on loopback (tests only; the editor
// refuses loopback): Host and Origin checks, auth on every route and on the
// WebSocket, pairing, lockout, revocation, and the addresses it will bind.
import { request } from 'node:https';
import { connect, type TLSSocket } from 'node:tls';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Devices, Lockout, Pairing, type Device } from '../src/remote/auth';
import { selfSigned } from '../src/remote/cert';
import type { RemoteAction } from '../src/remote/protocol';
import { RemoteServer } from '../src/remote/server';
import { memoryStore, waitFor } from './helpers';

const HOST = '127.0.0.1';
const { cert, key } = selfSigned([HOST]);
const servers: RemoteServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.dispose()));
});

async function start(over: { now?: () => number } = {}) {
  const devices = new Devices(memoryStore());
  const pairing = new Pairing(devices, over.now);
  const lockout = new Lockout(over.now);
  const acted: { action: RemoteAction; device: string }[] = [];
  const connections: number[] = [];
  const server = await RemoteServer.start({
    endpoints: [{ host: HOST, names: [HOST], cert, key }],
    devices,
    pairing,
    lockout,
    host: {
      list: () => ({ groups: [], agents: [], folders: [], now: 0 }),
      chat: (id) => (id === 'chat-1' ? ({ id: 'chat-1' } as never) : undefined),
      act: async (action, device) => (acted.push({ action, device: device.name }), { ok: true }),
    },
    assets: { js: 'console.log(1)', css: 'body{}', icon: '<svg/>', manifest: '{}' },
    onConnections: (d) => connections.push(d.length),
    checkHost: () => {},
    ...over,
  });
  servers.push(server);
  const port = Number(new URL(server.urls()[0]).port);
  const origin = `https://${HOST}:${port}`;
  return { server, devices, pairing, lockout, acted, connections, port, origin };
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json(): Record<string, unknown>;
}

function call(port: number, method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(Object.entries({ host: `${HOST}:${port}`, ...opts.headers }).filter(([, v]) => v !== ''));
    const req = request({ host: HOST, port, method, path, ca: cert, servername: '', checkServerIdentity: () => undefined, agent: false, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

const post = (port: number, path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(port, 'POST', path, { headers: { 'content-type': 'application/json', origin: `https://${HOST}:${port}`, ...headers }, body: JSON.stringify(body) });

async function pair(port: number, pairing: Pairing, name = 'Test phone'): Promise<{ token: string; device: Device }> {
  const r = await post(port, '/api/pair', { code: pairing.start().code, name });
  expect(r.status).toBe(200);
  return r.json() as never;
}

/** A WebSocket client over TLS, just enough for these tests. */
function ws(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; socket: TLSSocket; messages: string[]; closed: () => boolean }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: HOST, port, ca: cert, servername: undefined }, () => {
      const h = { host: `${HOST}:${port}`, origin: `https://${HOST}:${port}`, upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': randomBytes(16).toString('base64'), 'sec-websocket-version': '13', ...headers };
      socket.write(`GET ${path} HTTP/1.1\r\n${Object.entries(h).filter(([, v]) => v !== '').map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    });
    const messages: string[] = [];
    let buf = Buffer.alloc(0);
    let status = 0;
    let closed = false;
    socket.on('close', () => (closed = true));
    socket.on('error', () => (closed = true));
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!status) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        status = Number(/^HTTP\/1\.1 (\d+)/.exec(buf.subarray(0, end).toString())?.[1]);
        buf = buf.subarray(end + 4);
        resolve({ status, socket, messages, closed: () => closed });
      }
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          len = buf.readUInt16BE(2);
          off = 4;
        }
        if (buf.length < off + len) break;
        if ((buf[0] & 0x0f) === 0x1) messages.push(buf.subarray(off, off + len).toString());
        buf = buf.subarray(off + len);
      }
    });
    setTimeout(() => reject(new Error('no answer')), 5000).unref();
  });
}

describe('the app shell', () => {
  it('is served with a strict CSP and no CORS, to anyone who names this server', async () => {
    const { port } = await start();
    const r = await call(port, 'GET', '/');
    expect(r.status).toBe(200);
    expect(r.body).toContain('<script src="/app.js"></script>');
    expect(r.headers['content-security-policy']).toBe(
      `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss://${HOST}:${port}; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
    expect(r.headers['strict-transport-security']).toBeUndefined();
    const pre = await call(port, 'OPTIONS', '/api/chats', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(pre.status).not.toBe(200);
    expect(Object.keys(pre.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
    expect((await call(port, 'GET', '/app.js')).headers['content-type']).toBe('text/javascript; charset=utf-8');
  });

  it('refuses another Host (DNS rebinding) on every path, the WebSocket too', async () => {
    const { port, pairing } = await start();
    const { token } = await pair(port, pairing);
    for (const host of ['evil.example', `evil.example:${port}`, `${HOST}:1`, HOST, `${HOST}:${port}.evil.example`]) {
      for (const path of ['/', '/app.js', '/api/chats']) {
        expect((await call(port, 'GET', path, { headers: { host, authorization: `Bearer ${token}` } })).status, `${host} ${path}`).toBe(421);
      }
    }
    const ticket = ((await post(port, '/api/ticket', {}, { authorization: `Bearer ${token}` })).json() as { ticket: string }).ticket;
    expect((await ws(port, `/ws?ticket=${ticket}`, { host: 'evil.example' })).status).toBe(421);
  });

  it('refuses a request from another page (Origin), the WebSocket without one', async () => {
    const { port, pairing } = await start();
    const { token } = await pair(port, pairing);
    expect((await post(port, '/api/action', { type: 'stop', chatId: 'chat-1' }, { origin: 'https://evil.example', authorization: `Bearer ${token}` })).status).toBe(421);
    const ticket = ((await post(port, '/api/ticket', {}, { authorization: `Bearer ${token}` })).json() as { ticket: string }).ticket;
    expect((await ws(port, `/ws?ticket=${ticket}`, { origin: '' })).status).toBe(421);
    expect((await ws(port, `/ws?ticket=${ticket}`, { origin: 'https://evil.example' })).status).toBe(421);
  });
});

describe('pairing over the server', () => {
  it('gives a token for the code on screen, once, and only from the page', async () => {
    const { port, pairing } = await start();
    const { code } = pairing.start();
    expect((await post(port, '/api/pair', { code, name: 'x' }, { origin: '' })).status).toBe(403);
    const ok = await post(port, '/api/pair', { code, name: 'Arun’s iPhone' });
    expect(ok.status).toBe(200);
    expect(ok.json()).toMatchObject({ token: expect.any(String), device: { name: 'Arun’s iPhone' } });
    expect((await post(port, '/api/pair', { code, name: 'x' })).status).toBe(403);
  });

  it('refuses an expired code', async () => {
    let now = 0;
    const { port, pairing } = await start({ now: () => now });
    const { code } = pairing.start();
    now += 121_000;
    expect((await post(port, '/api/pair', { code, name: 'x' })).status).toBe(403);
  });

  it('locks the address out after five wrong codes, even for the right one', async () => {
    const { port, pairing } = await start();
    const { code } = pairing.start();
    for (let i = 0; i < 5; i++) expect((await post(port, '/api/pair', { code: `nope${i}`, name: 'x' })).status).toBe(403);
    expect((await post(port, '/api/pair', { code, name: 'x' })).status).toBe(429);
  });
});

describe('every API route', () => {
  it('needs a paired device’s token in the header, and locks out after bad ones', async () => {
    const { port, pairing } = await start();
    const { token } = await pair(port, pairing);
    const routes: [string, string][] = [
      ['GET', '/api/chats'],
      ['GET', '/api/chats/chat-1'],
      ['POST', '/api/action'],
      ['POST', '/api/ticket'],
      ['POST', '/api/forget'],
    ];
    for (const [method, path] of routes.slice(0, 4)) {
      const r = await call(port, method, path, { headers: { 'content-type': 'application/json', origin: `https://${HOST}:${port}` }, body: '{}' });
      expect(r.status, path).toBe(401);
    }
    // A cookie or a query-string token is not a token.
    expect((await call(port, 'GET', `/api/chats?token=${token}`, { headers: { cookie: `token=${token}` } })).status).toBe(401);
    expect((await call(port, 'GET', '/api/chats', { headers: { authorization: `Bearer ${token}` } })).status).toBe(429);
  });

  it('serves the chats and takes checked actions for a paired device', async () => {
    const { port, pairing, acted } = await start();
    const { token } = await pair(port, pairing, 'Pixel');
    const auth = { authorization: `Bearer ${token}` };
    expect((await call(port, 'GET', '/api/chats', { headers: auth })).json()).toMatchObject({ groups: [] });
    expect((await call(port, 'GET', '/api/chats/chat-1', { headers: auth })).json()).toEqual({ id: 'chat-1' });
    expect((await call(port, 'GET', '/api/chats/nope', { headers: auth })).status).toBe(404);
    expect((await post(port, '/api/action', { type: 'stop', chatId: 'chat-1' }, auth)).json()).toEqual({ ok: true });
    expect((await post(port, '/api/action', { type: 'openFile', path: '/etc/passwd' }, auth)).status).toBe(400);
    expect((await call(port, 'POST', '/api/action', { headers: { ...auth, 'content-type': 'text/plain', origin: `https://${HOST}:${port}` }, body: '{"type":"stop","chatId":"chat-1"}' })).status).toBe(415);
    expect((await post(port, '/api/action', { type: 'send', chatId: 'chat-1', text: 'x'.repeat(300_000) }, auth)).status).toBe(413);
    expect(acted).toEqual([{ action: { type: 'stop', chatId: 'chat-1' }, device: 'Pixel' }]);
  });
});

describe('the WebSocket', () => {
  it('opens only with a fresh single-use ticket, and pushes changes', async () => {
    const { port, pairing, server, connections } = await start();
    const { token } = await pair(port, pairing);
    expect((await ws(port, '/ws')).status).toBe(401);
    expect((await ws(port, '/ws?ticket=made-up')).status).toBe(401);
    const ticket = ((await post(port, '/api/ticket', {}, { authorization: `Bearer ${token}` })).json() as { ticket: string }).ticket;
    const sock = await ws(port, `/ws?ticket=${ticket}`);
    expect(sock.status).toBe(101);
    expect((await ws(port, `/ws?ticket=${ticket}`)).status).toBe(401);
    await waitFor(() => server.connected().length === 1);
    server.changed(['chat-1']);
    await waitFor(() => sock.messages.length === 1);
    expect(JSON.parse(sock.messages[0])).toEqual({ type: 'changed', chats: ['chat-1'] });
    expect(connections.at(-1)).toBe(1);
    sock.socket.destroy();
  });

  it('closes, and the token stops working, when the device is revoked on the Mac', async () => {
    const { port, pairing, server } = await start();
    const a = await pair(port, pairing, 'A');
    const b = await pair(port, pairing, 'B');
    const ticket = ((await post(port, '/api/ticket', {}, { authorization: `Bearer ${a.token}` })).json() as { ticket: string }).ticket;
    const sock = await ws(port, `/ws?ticket=${ticket}`);
    server.revoke(a.device.id);
    await waitFor(() => sock.closed());
    expect(sock.messages.map((m) => JSON.parse(m))).toEqual([{ type: 'revoked' }]);
    expect((await call(port, 'GET', '/api/chats', { headers: { authorization: `Bearer ${a.token}` } })).status).toBe(401);
    expect((await call(port, 'GET', '/api/chats', { headers: { authorization: `Bearer ${b.token}` } })).status).toBe(200);
    server.revokeAll();
    expect((await call(port, 'GET', '/api/chats', { headers: { authorization: `Bearer ${b.token}` } })).status).toBe(401);
  });
});

describe('where it listens', () => {
  it('refuses the wildcard, loopback and public addresses without a test override', async () => {
    for (const host of ['0.0.0.0', '::', '127.0.0.1', '8.8.8.8']) {
      await expect(
        RemoteServer.start({
          endpoints: [{ host, names: [host], cert, key }],
          devices: new Devices(memoryStore()),
          pairing: new Pairing(new Devices(memoryStore())),
          lockout: new Lockout(),
          host: { list: () => ({}) as never, chat: () => undefined, act: async () => ({ ok: true }) },
          assets: { js: '', css: '', icon: '', manifest: '' },
        }),
        host,
      ).rejects.toThrow(/private LAN or Tailscale/);
    }
  });
});
