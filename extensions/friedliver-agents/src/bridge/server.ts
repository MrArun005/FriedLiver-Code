// The "friedliver" MCP server (dist/bridge.js). Each agent session that may
// reach other agents starts one. It offers the tools below and passes every
// call to the editor over a local socket; the editor checks the call against
// the user's setting, asks the user when it should, and does the work.
import net from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AGENT_KEYS } from '../shared/model';
import { BRIDGE_ENV, BRIDGE_LIMITS, TOKEN_ENV, encodeRequest, type BridgeCall, type BridgeResponse } from './protocol';

/** While an answer is pending, a progress note this often keeps clients that time out idle tools waiting. */
const PROGRESS_MS = 15_000;

const address = process.env[BRIDGE_ENV];
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

type Extra = { _meta?: { progressToken?: string | number }; sendNotification(n: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; message?: string } }): Promise<void> };

async function run(tool: BridgeCall['tool'], args: Record<string, unknown>, extra: Extra) {
  const progressToken = extra._meta?.progressToken;
  let n = 0;
  const timer =
    progressToken === undefined
      ? undefined
      : setInterval(() => {
          void extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: ++n, message: 'Waiting for FriedLiver' } }).catch(() => {});
        }, PROGRESS_MS);
  try {
    const r = await editor.call(tool, args);
    return r.ok ? { content: [{ type: 'text' as const, text: r.text }] } : { content: [{ type: 'text' as const, text: r.error }], isError: true };
  } finally {
    clearInterval(timer);
  }
}

const server = new McpServer(
  { name: 'friedliver', version: '1.0.0' },
  {
    instructions:
      'Tools from FriedLiver, the editor you run in. They reach the other coding agents and chats open there. ' +
      'The user may be asked to allow each call, and may say no; carry on without it if so.',
  },
);

const agent = z.enum(AGENT_KEYS).describe('Which agent: claude, codex (GPT), gemini, or demo (an offline test agent).');
const chatId = z.string().regex(/^[\w.:-]{1,128}$/).describe('A chat id from list_chats, like "chat-3".');

server.registerTool(
  'list_agents',
  {
    title: 'List agents',
    description: 'Lists the coding agents FriedLiver can start, with the key to pass as `agent` to ask_agent.',
    annotations: { readOnlyHint: true },
  },
  (extra) => run('list_agents', {}, extra as Extra),
);

server.registerTool(
  'list_chats',
  {
    title: 'List chats',
    description:
      'Lists the chats open in FriedLiver: id, agent, task and whether each is busy. This chat is marked. ' +
      'Use an id with read_chat, send_to_chat, or as chat_id for ask_agent.',
    annotations: { readOnlyHint: true },
  },
  (extra) => run('list_chats', {}, extra as Extra),
);

server.registerTool(
  'ask_agent',
  {
    title: 'Ask another agent',
    description:
      'Asks another coding agent a question and waits for its answer, which can take minutes. ' +
      'It works in the same folder and gets a short summary of this chat, so make the question self-contained. ' +
      'Good for a second opinion, a review, or a part of the task another agent is better at. ' +
      'Asking the same agent again continues the same consultation; pass chat_id to ask a specific chat instead. ' +
      'The user is asked to allow it first unless they already did.',
    inputSchema: {
      agent,
      prompt: z.string().min(1).max(BRIDGE_LIMITS.text).describe('The question or request, written for the other agent.'),
      chat_id: chatId.optional().describe('Ask this existing chat (it must be idle and use `agent`) instead of starting or reusing a consultation.'),
    },
  },
  (args, extra) => run('ask_agent', args, extra as Extra),
);

server.registerTool(
  'send_to_chat',
  {
    title: 'Message a chat',
    description:
      'Sends a message to another FriedLiver chat, as if the user typed it there, and returns at once without its reply. ' +
      'The chat must be idle. Use read_chat later to see what it answered. The user is asked to allow it first unless they already did.',
    inputSchema: {
      chat_id: chatId,
      message: z.string().min(1).max(BRIDGE_LIMITS.text).describe('The message, written for the agent in that chat.'),
    },
  },
  (args, extra) => run('send_to_chat', args, extra as Extra),
);

server.registerTool(
  'read_chat',
  {
    title: 'Read a chat',
    description: 'Reads the latest messages of another FriedLiver chat: what the user and its agent said. The user is asked to allow it first unless they already did.',
    inputSchema: {
      chat_id: chatId,
      last: z.number().int().min(1).max(BRIDGE_LIMITS.last).optional().describe('How many of the latest messages to return. Default 10.'),
    },
    annotations: { readOnlyHint: true },
  },
  (args, extra) => run('read_chat', args, extra as Extra),
);

server.connect(new StdioServerTransport()).catch((err: unknown) => {
  process.stderr.write(`FriedLiver tools: ${String(err)}\n`);
  process.exit(1);
});
