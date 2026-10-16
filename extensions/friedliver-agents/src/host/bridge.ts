import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { BRIDGE_LIMITS, parseRequest, type BridgeCall, type BridgeResponse } from '../bridge/protocol';

/** Does what a chat's agent asked; throwing sends the message back to the agent as the tool's error. */
export type BridgeHandler = (chatId: string, call: BridgeCall, signal: AbortSignal) => Promise<string>;

/** Unix socket paths must fit in sockaddr_un (104 bytes on macOS, 108 on Linux). */
const MAX_SOCKET_PATH = 100;

/**
 * The editor's end of the FriedLiver tools: a local socket the tool servers
 * of agent sessions connect to. Each chat has its own random token, and a
 * request acts as the chat its token belongs to, so a tool server can only
 * speak for its own chat. Anything malformed, oversized or with an unknown
 * token closes the connection.
 */
export class BridgeServer {
  private readonly tokens = new Map<string, string>();
  private readonly chats = new Map<string, string>();
  private readonly sockets = new Set<net.Socket>();

  private constructor(
    private readonly server: net.Server,
    /** The socket path or pipe name, passed to tool servers in FRIEDLIVER_BRIDGE. */
    readonly address: string,
    private readonly dir: string | undefined,
    private readonly handler: BridgeHandler,
    private readonly log?: (line: string) => void,
  ) {
    server.on('connection', (socket) => this.accept(socket));
  }

  static async start(handler: BridgeHandler, log?: (line: string) => void): Promise<BridgeServer> {
    let address: string;
    let dir: string | undefined;
    if (process.platform === 'win32') {
      address = `\\\\.\\pipe\\friedliver-${randomBytes(16).toString('hex')}`;
    } else {
      // A fresh directory only this user can enter, so nobody else can reach the socket.
      const base = path.join(os.tmpdir(), 'flb-').length + 8 > MAX_SOCKET_PATH ? '/tmp' : os.tmpdir();
      dir = await mkdtemp(path.join(base, 'flb-'));
      await chmod(dir, 0o700);
      address = path.join(dir, 's');
    }
    const server = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(address, () => {
          server.off('error', reject);
          resolve();
        });
      });
      if (dir) await chmod(address, 0o600);
    } catch (err) {
      server.close();
      if (dir) await rm(dir, { recursive: true, force: true });
      throw err;
    }
    return new BridgeServer(server, address, dir, handler, log);
  }

  /** The chat's token, made on first use. It lives only in memory and in that chat's tool server. */
  token(chatId: string): string {
    let token = this.chats.get(chatId);
    if (!token) {
      token = randomBytes(32).toString('hex');
      this.chats.set(chatId, token);
      this.tokens.set(hash(token), chatId);
    }
    return token;
  }

  /** The chat is gone: its tool server can no longer act for it. */
  revoke(chatId: string): void {
    const token = this.chats.get(chatId);
    if (!token) return;
    this.chats.delete(chatId);
    this.tokens.delete(hash(token));
  }

  async dispose(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    // A tool server that goes away no longer waits for anything it asked.
    const gone = new AbortController();
    let pending: Buffer = Buffer.alloc(0);
    let count = 0;
    const close = (why: string) => {
      this.log?.(`FriedLiver tools: closed a connection (${why}).`);
      socket.destroy();
    };
    const reply = (r: BridgeResponse) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(r)}\n`);
    };
    socket.on('data', (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let nl: number;
      while ((nl = pending.indexOf(0x0a)) >= 0) {
        const line = pending.subarray(0, nl);
        pending = pending.subarray(nl + 1);
        if (line.length > BRIDGE_LIMITS.line) return close('message too large');
        if (++count > BRIDGE_LIMITS.requests) return close('too many requests');
        const req = parseRequest(line.toString('utf8'));
        if (!req) return close('malformed request');
        const chatId = this.tokens.get(hash(req.token));
        if (!chatId) return close('unknown token');
        this.handler(chatId, req.call, gone.signal).then(
          (text) => reply({ id: req.id, ok: true, text: fit(text) }),
          (err: unknown) => reply({ id: req.id, ok: false, error: fit(err instanceof Error ? err.message : String(err)) }),
        );
      }
      if (pending.length > BRIDGE_LIMITS.line) close('message too large');
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.sockets.delete(socket);
      gone.abort();
    });
  }
}

/** Tokens are looked up by hash, so the lookup's timing says nothing about a real token. */
function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Answers stay under the line limit; a long transcript loses its start. */
function fit(text: string): string {
  const max = BRIDGE_LIMITS.line / 4;
  return text.length > max ? `…${text.slice(-max)}` : text;
}
