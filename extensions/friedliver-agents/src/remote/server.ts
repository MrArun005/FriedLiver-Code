// FriedLiver Remote's HTTPS server, in the extension host. It listens only on
// the addresses it is given (a private LAN address, the Tailscale address),
// each checked, never the wildcard. Every request must name this server in its
// Host header (DNS rebinding) and, when it carries an Origin, come from this
// server's own page (no CORS, ever). The app shell is public; everything else
// needs a paired device's token in the Authorization header (no cookies, so no
// CSRF). The WebSocket only pushes "something changed": it opens with a
// single-use ticket from an authenticated request, and the phone reads what
// changed over HTTPS. Failures lock the address out.
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import type { ActionResult } from './actions';
import { deviceName, sameSecret, type Device, type Devices, type Lockout, type Pairing } from './auth';
import { checkBindHost } from './net';
import { parseRemoteAction, type PhoneChat, type PhoneEvent, type PhoneList, type RemoteAction } from './protocol';

const MAX_BODY = 256 * 1024;
const TICKET_MS = 30_000;
const PING_MS = 25_000;
const MAX_SOCKETS = 20;
/** Open connections in all, and from one address: a host on the network can't exhaust the extension host's sockets. */
const MAX_CONNECTIONS = 64;
const MAX_PER_IP = 16;
/** A socket that buffers more than this for a phone that doesn't read is dropped. */
const MAX_BUFFERED = 256 * 1024;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface RemoteHostApi {
  list(): PhoneList;
  chat(chatId: string): PhoneChat | undefined;
  act(action: RemoteAction, device: Device): Promise<ActionResult>;
}

export interface Endpoint {
  /** The address to listen on: a private LAN or Tailscale address. */
  host: string;
  /** Host names the phone may use for it (Host header), e.g. the IP and the MagicDNS name. */
  names: string[];
  cert: string;
  key: string;
  /** A certificate the phone's browser trusts by itself (tailscale cert): HSTS is sent. */
  trusted?: boolean;
}

export interface Assets {
  js: string;
  css: string;
  icon: string;
  manifest: string;
}

export interface RemoteServerOptions {
  endpoints: Endpoint[];
  devices: Devices;
  pairing: Pairing;
  lockout: Lockout;
  host: RemoteHostApi;
  assets: Assets;
  onPaired?(device: Device): void;
  /** The Mac's OK for a phone that has the right code, before it gets a token. Without it: allowed. */
  approvePairing?(name: string, ip: string): Promise<boolean>;
  /** A device used this server for the first time since it started (HTTP or WebSocket). */
  onSeen?(device: Device): void;
  /** The port to try first (the last one used, so the phone's address stays the same). */
  port?: number;
  /** Open sockets changed: who is connected now. */
  onConnections?(devices: Device[]): void;
  log?(line: string): void;
  now?(): number;
  /** Tests only: what may be listened on. The editor always uses checkBindHost. */
  checkHost?(host: string): void;
}

interface Phone {
  socket: Socket;
  device: Device;
  /** A ping is out and unanswered. */
  pinged: boolean;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

export class RemoteServer {
  private readonly phones = new Set<Phone>();
  private readonly tickets = new Map<string, { deviceId: string; expires: number }>();
  private readonly seen = new Set<string>();
  private readonly perIp = new Map<string, number>();
  private pinger?: ReturnType<typeof setInterval>;

  private constructor(
    private readonly options: RemoteServerOptions,
    private readonly servers: { server: Server; endpoint: Endpoint; port: number }[],
  ) {
    this.pinger = setInterval(() => this.ping(), PING_MS);
    this.pinger.unref?.();
  }

  static async start(options: RemoteServerOptions): Promise<RemoteServer> {
    const check = options.checkHost ?? checkBindHost;
    if (!options.endpoints.length) throw new Error('No address to listen on.');
    for (const e of options.endpoints) check(e.host);
    const started: { server: Server; endpoint: Endpoint; port: number }[] = [];
    try {
      for (const endpoint of options.endpoints) {
        const server = createServer({ cert: endpoint.cert, key: endpoint.key, minVersion: 'TLSv1.2', handshakeTimeout: 10_000 });
        server.maxConnections = MAX_CONNECTIONS;
        server.headersTimeout = 10_000;
        server.requestTimeout = 15_000;
        server.keepAliveTimeout = 5_000;
        server.maxHeadersCount = 50;
        const port = await listen(server, endpoint.host, started[0]?.port ?? options.port ?? 0);
        started.push({ server, endpoint, port });
      }
    } catch (err) {
      for (const s of started) s.server.close();
      throw err;
    }
    const self = new RemoteServer(options, started);
    for (const s of started) {
      s.server.on('connection', (socket: Socket) => self.connection(socket));
      s.server.on('request', (req, res) => void self.request(s, req, res));
      s.server.on('upgrade', (req, socket) => self.upgrade(s, req, socket as Socket));
      s.server.on('tlsClientError', () => {});
    }
    return self;
  }

  /** The address each endpoint serves, as https URLs (by its first name). */
  urls(): string[] {
    return this.servers.map((s) => `https://${s.endpoint.names[0]}:${s.port}/`);
  }

  /** Devices with a live socket, each once. */
  connected(): Device[] {
    const out = new Map<string, Device>();
    for (const p of this.phones) out.set(p.device.id, p.device);
    return [...out.values()];
  }

  /** Something changed: tell the phones which chats. */
  changed(chats: string[]): void {
    this.broadcast({ type: 'changed', chats });
  }

  /** The device's token stops working and its sockets close. */
  revoke(deviceId: string): void {
    this.options.devices.revoke(deviceId);
    this.seen.delete(deviceId);
    this.drop((p) => p.device.id === deviceId);
  }

  revokeAll(): void {
    this.options.devices.revokeAll();
    this.seen.clear();
    this.drop(() => true);
  }

  async dispose(): Promise<void> {
    clearInterval(this.pinger);
    for (const p of this.phones) p.socket.destroy();
    this.phones.clear();
    await Promise.all(
      this.servers.map(
        (s) =>
          new Promise<void>((r) => {
            s.server.closeAllConnections?.();
            s.server.close(() => r());
          }),
      ),
    );
  }

  // ---- HTTP ----

  /** Before TLS: a locked-out address, or one with too many sockets open, is dropped at once. */
  private connection(socket: Socket): void {
    const ip = socket.remoteAddress ?? '';
    const n = (this.perIp.get(ip) ?? 0) + 1;
    if (this.options.lockout.blocked(ip) || n > MAX_PER_IP) {
      socket.destroy();
      return;
    }
    this.perIp.set(ip, n);
    socket.once('close', () => {
      const left = (this.perIp.get(ip) ?? 1) - 1;
      if (left > 0) this.perIp.set(ip, left);
      else this.perIp.delete(ip);
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Host must name this endpoint; an Origin, when sent, must be this page's own. */
  private sameSite(s: { endpoint: Endpoint; port: number }, req: IncomingMessage, originRequired: boolean): boolean {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!s.endpoint.names.some((n) => host === `${n.toLowerCase()}:${s.port}`)) return false;
    const origin = req.headers.origin;
    if (origin === undefined) return !originRequired;
    return origin === `https://${host}`;
  }

  private headers(s: { endpoint: Endpoint; port: number }, req: IncomingMessage, res: ServerResponse): void {
    const host = req.headers.host ?? '';
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss://${host}; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Cache-Control', 'no-store');
    if (s.endpoint.trusted) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }

  private async request(s: { endpoint: Endpoint; port: number }, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? '';
    try {
      // The Host goes into the CSP, so it is checked first.
      if (!this.sameSite(s, req, false)) return json(res, 421, { error: 'Wrong host.' });
      this.headers(s, req, res);
      if (this.options.lockout.blocked(ip)) return json(res, 429, { error: 'Too many failed attempts. Wait a few minutes.' });
      // Another site's page (an <img>, a form) never reaches the API or the pairing.
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site requests are refused.' });
      const url = new URL(req.url ?? '/', 'https://remote.invalid');
      const route = `${req.method} ${url.pathname}`;
      const asset = this.asset(url.pathname);
      if (asset) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
        res.writeHead(200, { 'Content-Type': asset.type });
        res.end(req.method === 'HEAD' ? undefined : asset.body);
        return;
      }
      if (route === 'POST /api/pair') return await this.pair(s, req, res, ip);
      if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
      const device = this.authenticate(req, ip);
      if (!device) return json(res, 401, { error: 'Not paired.' });
      const chat = /^\/api\/chats\/([\w.:-]{1,128})$/.exec(url.pathname);
      if (req.method === 'GET' && url.pathname === '/api/chats') return json(res, 200, this.options.host.list());
      if (req.method === 'GET' && chat) {
        const view = this.options.host.chat(chat[1]);
        return view ? json(res, 200, view) : json(res, 404, { error: 'No such chat.' });
      }
      if (route === 'POST /api/action') {
        const action = parseRemoteAction(await readJson(req));
        if (!action) return json(res, 400, { error: 'Not an action the phone may send.' });
        this.options.log?.(`Remote: ${device.name} sent ${action.type}`);
        return json(res, 200, await this.options.host.act(action, device));
      }
      if (route === 'POST /api/ticket') {
        await readJson(req);
        return json(res, 200, { ticket: this.ticket(device) });
      }
      if (route === 'POST /api/forget') {
        await readJson(req);
        this.revoke(device.id);
        return json(res, 200, { ok: true });
      }
      return json(res, ['GET', 'POST'].includes(req.method ?? '') ? 404 : 405, { error: 'Not found.' });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) this.options.log?.(`Remote: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Something went wrong.' : (err as Error).message });
      else res.destroy();
    }
  }

  private asset(pathname: string): { type: string; body: string } | undefined {
    const a = this.options.assets;
    switch (pathname) {
      case '/':
        return { type: 'text/html; charset=utf-8', body: SHELL };
      case '/app.js':
        return { type: 'text/javascript; charset=utf-8', body: a.js };
      case '/app.css':
        return { type: 'text/css; charset=utf-8', body: a.css };
      case '/icon.svg':
        return { type: 'image/svg+xml', body: a.icon };
      case '/manifest.webmanifest':
        return { type: 'application/manifest+json', body: a.manifest };
      default:
        return undefined;
    }
  }

  private async pair(s: { endpoint: Endpoint; port: number }, req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    // A browser always sends Origin on a POST from the page; anything else is refused.
    if (!this.sameSite(s, req, true)) return json(res, 403, { error: 'Pair from the page the QR code opens.' });
    const body = (await readJson(req)) as { code?: unknown; name?: unknown };
    if (typeof body?.code !== 'string' || body.code.length > 64 || !this.options.pairing.claim(body.code)) {
      this.options.lockout.fail(ip);
      return json(res, 403, { error: 'That pairing code is wrong or has expired. Show a new QR code on your Mac.' });
    }
    const name = deviceName(body.name);
    if (this.options.approvePairing && !(await this.options.approvePairing(name, ip))) {
      return json(res, 403, { error: 'Your Mac didn’t allow this phone. Show a new QR code to try again.' });
    }
    const paired = this.options.devices.add(name);
    this.options.log?.(`Remote: paired ${paired.device.name} from ${ip}`);
    this.options.onPaired?.(paired.device);
    json(res, 200, { token: paired.token, device: paired.device });
  }

  /** The device whose token the request carries. A wrong token counts against the address; no token at all doesn't (a page's <img> could send that). */
  private authenticate(req: IncomingMessage, ip: string): Device | undefined {
    if (req.headers.authorization === undefined) return undefined;
    const m = /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(req.headers.authorization);
    const device = m ? this.options.devices.authenticate(m[1]) : undefined;
    if (!device) this.options.lockout.fail(ip);
    else this.saw(device);
    return device;
  }

  private saw(device: Device): void {
    if (this.seen.has(device.id)) return;
    this.seen.add(device.id);
    this.options.onSeen?.(device);
  }

  private ticket(device: Device): string {
    const now = this.now();
    for (const [t, v] of this.tickets) if (v.expires <= now) this.tickets.delete(t);
    if (this.tickets.size >= 100) this.tickets.delete(this.tickets.keys().next().value!);
    const ticket = randomBytes(24).toString('base64url');
    this.tickets.set(ticket, { deviceId: device.id, expires: now + TICKET_MS });
    return ticket;
  }

  /** A ticket's device, once; the ticket is gone after. Compared in constant time against each live ticket. */
  private redeemTicket(ticket: string): Device | undefined {
    const now = this.now();
    let found: string | undefined;
    for (const t of this.tickets.keys()) if (sameSecret(t, ticket)) found = t;
    if (!found) return undefined;
    const { deviceId, expires } = this.tickets.get(found)!;
    this.tickets.delete(found);
    if (expires <= now) return undefined;
    return this.options.devices.list().find((d) => d.id === deviceId);
  }

  // ---- WebSocket: server → phone only ----

  private upgrade(s: { endpoint: Endpoint; port: number }, req: IncomingMessage, socket: Socket): void {
    const ip = req.socket.remoteAddress ?? '';
    const refuse = (status: string) => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    socket.on('error', () => {});
    if (!this.sameSite(s, req, true)) return refuse('421 Misdirected Request');
    if (this.options.lockout.blocked(ip)) return refuse('429 Too Many Requests');
    const url = new URL(req.url ?? '/', 'https://remote.invalid');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== '/ws' || req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string') return refuse('400 Bad Request');
    const device = this.redeemTicket(url.searchParams.get('ticket') ?? '');
    if (!device) {
      this.options.lockout.fail(ip);
      return refuse('401 Unauthorized');
    }
    if (this.phones.size >= MAX_SOCKETS) return refuse('503 Service Unavailable');
    this.saw(device);
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    const phone: Phone = { socket, device, pinged: false };
    this.phones.add(phone);
    this.options.onConnections?.(this.connected());
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const frame = readFrame(buffered);
        if (frame === null) break;
        if (frame === 'bad') return socket.destroy();
        buffered = buffered.subarray(frame.size);
        if (frame.op === 0x8) return void socket.end(encodeFrame(0x8, Buffer.from([0x03, 0xe8])));
        if (frame.op === 0x9) socket.write(encodeFrame(0xa, frame.payload));
        else if (frame.op === 0xa) phone.pinged = false;
        // The phone sends its actions over HTTPS; data frames here are refused.
        else return void socket.end(encodeFrame(0x8, Buffer.from([0x03, 0xeb])));
      }
      if (buffered.length > 1024) socket.destroy();
    });
    socket.on('close', () => {
      this.phones.delete(phone);
      this.options.onConnections?.(this.connected());
    });
  }

  private broadcast(event: PhoneEvent, only?: (p: Phone) => boolean): void {
    if (only && ![...this.phones].some(only)) return;
    const frame = encodeFrame(0x1, Buffer.from(JSON.stringify(event)));
    for (const p of this.phones) {
      if (only && !only(p)) continue;
      if (p.socket.writableLength > MAX_BUFFERED) p.socket.destroy();
      else p.socket.write(frame);
    }
  }

  private drop(which: (p: Phone) => boolean): void {
    this.broadcast({ type: 'revoked' }, which);
    for (const p of [...this.phones]) {
      if (!which(p)) continue;
      this.phones.delete(p);
      p.socket.end(encodeFrame(0x8, Buffer.from([0x0f, 0xa0])));
      setTimeout(() => p.socket.destroy(), 1000).unref();
    }
    this.options.onConnections?.(this.connected());
    for (const t of [...this.tickets.keys()]) if (!this.options.devices.has(this.tickets.get(t)!.deviceId)) this.tickets.delete(t);
  }

  /** A phone that missed the last ping is gone (asleep, out of range). */
  private ping(): void {
    // A device revoked elsewhere (another window, or expired) loses its socket here.
    this.drop((p) => !this.options.devices.has(p.device.id));
    for (const p of [...this.phones]) {
      if (p.pinged) {
        p.socket.destroy();
        continue;
      }
      p.pinged = true;
      p.socket.write(encodeFrame(0x9, Buffer.alloc(0)));
    }
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function listen(server: Server, host: string, port: number): Promise<number> {
  const attempt = (p: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once('error', onError);
      server.listen({ host, port: p, exclusive: true }, () => {
        server.off('error', onError);
        resolve((server.address() as AddressInfo).port);
      });
    });
  // The same port as the first address when it is free; any port otherwise.
  return attempt(port).catch((err: NodeJS.ErrnoException) => (port && err.code === 'EADDRINUSE' ? attempt(0) : Promise.reject(err)));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send JSON.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw new HttpError(400, 'Not JSON.');
  }
}

/** One frame from the phone, masked as the protocol requires; control frames only, so 125 bytes at most. */
function readFrame(b: Buffer): { op: number; payload: Buffer; size: number } | null | 'bad' {
  if (b.length < 2) return null;
  const fin = (b[0] & 0x80) !== 0;
  const op = b[0] & 0x0f;
  const masked = (b[1] & 0x80) !== 0;
  const len = b[1] & 0x7f;
  if (!fin || !masked || len > 125 || (b[0] & 0x70) !== 0) return 'bad';
  if (b.length < 6 + len) return null;
  const mask = b.subarray(2, 6);
  const payload = Buffer.from(b.subarray(6, 6 + len));
  for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
  return { op, payload, size: 6 + len };
}

function encodeFrame(op: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 0xff]) : (() => {
    const h = Buffer.alloc(10);
    h[0] = 0x80 | op;
    h[1] = 127;
    h.writeBigUInt64BE(BigInt(n), 2);
    return h;
  })();
  return Buffer.concat([head, payload]);
}

const SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#121314" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="FriedLiver">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
<title>FriedLiver Remote</title>
</head>
<body>
<div id="root"></div>
<script src="/app.js"></script>
</body>
</html>
`;
