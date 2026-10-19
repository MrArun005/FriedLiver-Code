// The "friedliver" MCP server over stdio (dist/bridge.js). Each session of an
// agent that takes only stdio MCP servers starts one (agents that take HTTP
// reach the same tools in the editor, http.ts). It offers the tools in mcp.ts
// and passes every call to the editor over a local socket; the editor checks
// the call against the user's setting, asks the user when it should, and does
// the work.
import net from 'node:net';
import { OMIT_ENV, handle, progress, toolReply, type ToolResult } from './mcp';
import { BRIDGE_ENV, BRIDGE_LIMITS, TOKEN_ENV, encodeRequest, type BridgeCall, type BridgeResponse } from './protocol';

/** While an answer is pending, a progress note this often keeps clients that time out idle tools waiting. */
const PROGRESS_MS = 15_000;

const address = process.env[BRIDGE_ENV];
/** Tools this session isn't offered (mcp.ts toolsFor), as the editor worked them out when it started the session. */
const omit = (process.env[OMIT_ENV] ?? '').split(',').filter(Boolean);
const token = process.env[TOKEN_ENV];
// Nothing this process starts should inherit the chat's secret.
delete process.env[TOKEN_ENV];
if (!address || !token) {
  process.stderr.write(`The FriedLiver tools run inside FriedLiver only (${BRIDGE_ENV} is not set).\n`);
  process.exit(1);
}

/** One socket to the editor, opened on first use; answers are matched to requests by id. */
class Editor {
  private socket?: net.Socket;
  private readonly waiting = new Map<number, (r: BridgeResponse) => void>();
  private nextId = 1;
  private buffer = '';

  call(tool: BridgeCall['tool'], args: Record<string, unknown>): Promise<BridgeResponse> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.connect().write(encodeRequest(id, token!, tool, args));
    });
  }

  private connect(): net.Socket {
    if (this.socket && !this.socket.destroyed) return this.socket;
    const socket = net.createConnection(address!);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        this.answer(line);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.buffer = '';
      for (const [id, resolve] of this.waiting) resolve({ id, ok: false, error: 'FriedLiver closed the connection to its tools. Try again in a moment.' });
      this.waiting.clear();
    });
    this.socket = socket;
    return socket;
  }

  private answer(line: string): void {
    try {
      const r = JSON.parse(line) as BridgeResponse;
      this.waiting.get(r.id)?.(r);
      this.waiting.delete(r.id);
    } catch {
      // Not from FriedLiver's host; ignore it.
    }
  }
}

const editor = new Editor();

function write(message: object): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Passes a tool call to the editor; a progress note now and then keeps clients that time out idle tools waiting. */
async function run(tool: BridgeCall['tool'], args: Record<string, unknown>, progressToken?: string | number): Promise<ToolResult> {
  let n = 0;
  const timer = progressToken === undefined ? undefined : setInterval(() => write(progress(progressToken, ++n)), PROGRESS_MS);
  try {
    const r = await editor.call(tool, args);
    return r.ok ? { content: [{ type: 'text', text: r.text }] } : { content: [{ type: 'text', text: r.error }], isError: true };
  } finally {
    clearInterval(timer);
  }
}

/** MCP over stdio: one JSON-RPC message per line. */
function onLine(line: string): void {
  if (!line.trim()) return;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return;
  }
  // Batches are from older protocol versions; each message is answered on its own line.
  for (const message of Array.isArray(raw) ? raw : [raw]) {
    const handled = handle(message, false, omit);
    if (!handled) continue;
    if ('reply' in handled) write(handled.reply);
    else void run(handled.call, handled.args, handled.progressToken).then((r) => write(toolReply(handled.id, r)));
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  input += chunk;
  let nl: number;
  while ((nl = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, nl);
    input = input.slice(nl + 1);
    onLine(line);
  }
  // A client that never ends a line gets no more room than the editor gives one.
  if (input.length > BRIDGE_LIMITS.line) input = '';
});
// The agent closed the session: nothing more to answer.
process.stdin.on('end', () => process.exit(0));
