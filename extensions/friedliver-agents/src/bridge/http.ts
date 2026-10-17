// The FriedLiver tools over MCP's streamable HTTP transport, served by the
// extension host itself on 127.0.0.1. Agents that take HTTP MCP servers (they
// say so with agentCapabilities.mcpCapabilities.http; Claude's, Codex's and
// Gemini's adapters do) reach the tools here, so their sessions start no tools
// server process (dist/bridge.js, about 19 MB each). The same tools, answers
// and checks as over stdio (mcp.ts and parseCall), and the same per-chat
// token, sent as `Authorization: Bearer <token>`. Anything else is refused:
// another Host or Origin (DNS rebinding), another path, a missing or unknown
// token, a body that isn't JSON or is over 1 MB. GET and DELETE get 405: there
// is no server stream and no session to end.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROTOCOL_VERSIONS, handle, progress, toolReply, type ToolResult } from './mcp';
import { BRIDGE_LIMITS, EXTERNAL_CLIENT, isExternal, parseCall, type BridgeCall } from './protocol';

export const MCP_PATH = '/mcp';

/** While an answer is pending, an event this often keeps the response, and clients that time out idle tools, waiting. */
export const KEEPALIVE_MS = 15_000;

export interface HttpToolsOptions {
  /** The chat a bearer token belongs to, if it belongs to one. */
  chatFor(token: string): string | undefined;
  /** The external client's token (EXTERNAL_CLIENT), which it never sends: it signs requests with it instead. */
  externalKey?(): string | undefined;
  /** Does a checked call for the chat. The signal aborts when the agent hangs up before the answer. */
  call(chatId: string, call: BridgeCall, signal: AbortSignal): Promise<ToolResult>;
  log?(line: string): void;
  /** For tests. */
  keepaliveMs?: number;
}

export class HttpTools {
  private constructor(
    private readonly server: Server,
    /** `http://127.0.0.1:<port>/mcp` */
    readonly url: string,
  ) {}

  static async start(options: HttpToolsOptions): Promise<HttpTools> {
    let port = 0;
    const server = createServer((req, res) => void serve(req, res, port, options));
    // A request (headers and body) must arrive quickly; the answer may take as long as the other agent does.
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    // As over the socket: after this many requests on one connection the client has to open another.
    server.maxRequestsPerSocket = BRIDGE_LIMITS.requests;
    server.maxConnections = 128;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    port = (server.address() as AddressInfo).port;
    return new HttpTools(server, `http://127.0.0.1:${port}${MCP_PATH}`);
  }

  async dispose(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const JSON_TYPE = { 'Content-Type': 'application/json' };

function send(res: ServerResponse, status: number, body?: object, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { ...(body ? JSON_TYPE : {}), ...headers });
  res.end(body ? JSON.stringify(body) : undefined);
}

/** Refused, and the connection closed after the answer: a client that gets these isn't one of ours. */
function refuse(res: ServerResponse, status: number, why: string, log?: (line: string) => void, headers: Record<string, string> = {}): void {
  log?.(`FriedLiver tools (HTTP): refused a request (${why}).`);
  send(res, status, { jsonrpc: '2.0', id: null, error: { code: -32600, message: why } }, { Connection: 'close', ...headers });
}

/** Only this server's own address: a web page that renamed itself 127.0.0.1 (DNS rebinding) can't use it. */
function ownHost(value: string | undefined, port: number): boolean {
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
}

function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer ([0-9a-f]{64})$/i.exec(header ?? '');
  return m?.[1].toLowerCase();
}

/** The body, or null when it is over the limit (the rest is never kept). */
function body(req: IncomingMessage): Promise<Buffer | null> {
  if (Number(req.headers['content-length'] ?? 0) > BRIDGE_LIMITS.line) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= BRIDGE_LIMITS.line) return void chunks.push(chunk);
      req.off('data', onData);
      chunks.length = 0;
      resolve(null);
    };
    req.on('data', onData);
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', reject);
  });
}

/** HMAC-SHA256 hex of the parts, joined by newlines. Shared with the external stdio client. */
export function sign(key: string, ...parts: string[]): string {
  return createHmac('sha256', key).update(parts.join('\n')).digest('hex');
}

/** Nonces already used, so a captured request can't be replayed. ponytail: cleared at 10k; a replay then needs a 10k-request-old capture. */
const seenNonces = new Set<string>();

/**
 * The external client (externalStdio.ts) never sends its token, so a process that grabs a stale port
 * learns nothing: it signs a fresh nonce and its MCP session with it, and this server proves it has
 * the token too by signing the nonce back (X-FriedLiver-Proof). Returns the caller id, or undefined.
 */
function externalCaller(req: IncomingMessage, res: ServerResponse, o: HttpToolsOptions): string | undefined {
  const nonce = String(req.headers['x-friedliver-nonce'] ?? '');
  const session = String(req.headers['x-friedliver-session'] ?? '');
  const mac = /^FriedLiver-HMAC ([0-9a-f]{64})$/.exec(req.headers.authorization ?? '')?.[1];
  const key = o.externalKey?.();
  if (!key || !mac || !/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{32}$/.test(session) || seenNonces.has(nonce)) return undefined;
  if (!timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(sign(key, 'client', nonce, session), 'hex'))) return undefined;
  if (seenNonces.size >= 10_000) seenNonces.clear();
  seenNonces.add(nonce);
  res.setHeader('X-FriedLiver-Proof', sign(key, 'server', nonce));
  return `${EXTERNAL_CLIENT}:${session}`;
}

async function serve(req: IncomingMessage, res: ServerResponse, port: number, o: HttpToolsOptions): Promise<void> {
  try {
    if (!ownHost(req.headers.host, port)) return refuse(res, 403, 'wrong host', o.log);
    const origin = req.headers.origin;
    if (origin !== undefined && !ownHost(origin.replace(/^http:\/\//, ''), port)) return refuse(res, 403, 'wrong origin', o.log);
    if ((req.url ?? '').split('?')[0] !== MCP_PATH) return refuse(res, 404, 'unknown path', o.log);
    const token = bearer(req.headers.authorization);
    let chatId = token ? o.chatFor(token) : undefined;
    // The external token works signed only (externalCaller), never as a bearer.
    if (chatId && isExternal(chatId)) chatId = undefined;
    chatId ??= req.headers['x-friedliver-nonce'] !== undefined ? externalCaller(req, res, o) : undefined;
    if (!chatId) return refuse(res, 401, 'unknown token', o.log, { 'WWW-Authenticate': 'Bearer' });
    if (req.method !== 'POST') return send(res, 405, undefined, { Allow: 'POST' });
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return refuse(res, 415, 'not JSON', o.log);
    const version = req.headers['mcp-protocol-version'];
    if (typeof version === 'string' && !PROTOCOL_VERSIONS.includes(version)) {
      return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `Unsupported protocol version ${version}` } });
    }
    const raw = await body(req);
    if (!raw) return refuse(res, 413, 'message too large', o.log);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    await answer(req, res, chatId, parsed, o);
  } catch (err) {
    o.log?.(`FriedLiver tools (HTTP): ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
    else res.end();
  }
}

/** A JSON-RPC message, or a batch of them (older protocol versions), from an agent whose token was good. */
async function answer(req: IncomingMessage, res: ServerResponse, chatId: string, parsed: unknown, o: HttpToolsOptions): Promise<void> {
  // Aborts what this request waits for when the agent hangs up before the answer.
  const gone = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) gone.abort();
  });
  const external = isExternal(chatId);
  const handleOne = (m: unknown) => handle(m, external);
  const run = async (handled: Exclude<ReturnType<typeof handle>, null>): Promise<object> => {
    if ('reply' in handled) return handled.reply;
    const call = parseCall(handled.call, handled.args);
    return toolReply(handled.id, call ? await o.call(chatId, call, gone.signal) : { content: [{ type: 'text', text: 'Invalid arguments' }], isError: true });
  };

  if (Array.isArray(parsed)) {
    const handled = parsed.map(handleOne).filter((h) => h !== null);
    if (!handled.length) return send(res, 202);
    return send(res, 200, await Promise.all(handled.map(run)));
  }
  const handled = handleOne(parsed);
  // A notification or a response: nothing to say back.
  if (!handled) return send(res, 202);
  const streams = /\btext\/event-stream\b/.test(req.headers.accept ?? '');
  if ('reply' in handled || !streams) return send(res, 200, await run(handled));

  // A tool call: an event stream, so the response starts at once (fetch gives up on headers after 5 minutes,
  // and asking another agent can take longer) and progress keeps clients that time out idle tools waiting.
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.flushHeaders();
  const event = (message: object) => res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  let n = 0;
  const timer = setInterval(() => {
    if (handled.progressToken !== undefined) event(progress(handled.progressToken, ++n));
    else res.write(': waiting\n\n');
  }, o.keepaliveMs ?? KEEPALIVE_MS);
  try {
    const reply = await run(handled);
    if (!gone.signal.aborted) event(reply);
  } finally {
    clearInterval(timer);
    res.end();
  }
}
