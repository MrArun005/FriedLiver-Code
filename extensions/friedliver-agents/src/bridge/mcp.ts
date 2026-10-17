// Just enough of the Model Context Protocol for the FriedLiver tools: answers
// to initialize, ping, tools/list and tools/call, for the server over stdio
// (server.ts) and the one over HTTP (http.ts). An agent that takes only stdio
// servers starts its own copy of dist/bridge.js per session and keeps it for as
// long as the session lives, so fifteen chats are fifteen of these processes.
// With the MCP SDK, zod and ajv in it, each one held about 10 MB more than the
// runtime itself; written out here, it holds next to nothing.
import { AGENT_KEYS } from '../shared/model';
import { BRIDGE_LIMITS, parseCall, type BridgeCall } from './protocol';

/** Newest first; a client asking for another version gets the newest. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

const INSTRUCTIONS =
  'Tools from FriedLiver, the editor you run in. They reach the other coding agents and chats open there. ' +
  'The user may be asked to allow each call, and may say no; carry on without it if so. ' +
  'The browser_* tools drive the browser built into FriedLiver (http and https pages only), which the user sees beside the code.';

const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';
const CHAT_ID = { type: 'string', pattern: '^[\\w.:-]{1,128}$' };
const NO_INPUT = { type: 'object', properties: {} };

/** What tools/list says: the same tools, words and schemas the MCP SDK made from the zod schemas before. */
export const TOOLS = [
  {
    name: 'list_agents',
    title: 'List agents',
    description: 'Lists the coding agents FriedLiver can start, with the key to pass as `agent` to ask_agent.',
    inputSchema: NO_INPUT,
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_chats',
    title: 'List chats',
    description:
      'Lists the chats open in FriedLiver: id, agent, task and whether each is busy. This chat is marked. ' +
      'Use an id with read_chat, send_to_chat, or as chat_id for ask_agent.',
    inputSchema: NO_INPUT,
    annotations: { readOnlyHint: true },
  },
  {
    name: 'ask_agent',
    title: 'Ask another agent',
    description:
      'Asks another coding agent a question and waits for its answer, which can take minutes. ' +
      'It works in the same folder and gets a short summary of this chat, so make the question self-contained. ' +
      'Good for a second opinion, a review, or a part of the task another agent is better at. ' +
      'Asking the same agent again continues the same consultation; pass chat_id to ask a specific chat instead. ' +
      'The user is asked to allow it first unless they already did.',
    inputSchema: {
      $schema: DRAFT_07,
      type: 'object',
      properties: {
        agent: { type: 'string', enum: [...AGENT_KEYS], description: 'Which agent: claude, codex (GPT), gemini, or demo (an offline test agent).' },
        prompt: { type: 'string', minLength: 1, maxLength: BRIDGE_LIMITS.text, description: 'The question or request, written for the other agent.' },
        chat_id: { description: 'Ask this existing chat (it must be idle and use `agent`) instead of starting or reusing a consultation.', ...CHAT_ID },
      },
      required: ['agent', 'prompt'],
    },
  },
  {
    name: 'send_to_chat',
    title: 'Message a chat',
    description:
      'Sends a message to another FriedLiver chat, as if the user typed it there, and returns at once without its reply. ' +
      'The chat must be idle. Use read_chat later to see what it answered. The user is asked to allow it first unless they already did.',
    inputSchema: {
      $schema: DRAFT_07,
      type: 'object',
      properties: {
        chat_id: { ...CHAT_ID, description: 'A chat id from list_chats, like "chat-3".' },
        message: { type: 'string', minLength: 1, maxLength: BRIDGE_LIMITS.text, description: 'The message, written for the agent in that chat.' },
      },
      required: ['chat_id', 'message'],
    },
  },
  {
    name: 'read_chat',
    title: 'Read a chat',
    description: 'Reads the latest messages of another FriedLiver chat: what the user and its agent said. The user is asked to allow it first unless they already did.',
    inputSchema: {
      $schema: DRAFT_07,
      type: 'object',
      properties: {
        chat_id: { ...CHAT_ID, description: 'A chat id from list_chats, like "chat-3".' },
        last: { description: 'How many of the latest messages to return. Default 10.', type: 'integer', minimum: 1, maximum: BRIDGE_LIMITS.last },
      },
      required: ['chat_id'],
    },
    annotations: { readOnlyHint: true },
  },
  ...browserTools(),
].map((t) => ({ ...t, execution: { taskSupport: 'forbidden' } }));

function browserTools() {
  const tool = (name: string, title: string, description: string, properties: Record<string, object> = {}, required: string[] = [], readOnly = false) => ({
    name,
    title,
    description,
    inputSchema: Object.keys(properties).length ? { $schema: DRAFT_07, type: 'object', properties, ...(required.length ? { required } : {}) } : NO_INPUT,
    ...(readOnly ? { annotations: { readOnlyHint: true } } : {}),
  });
  const SELECTOR = { type: 'string', minLength: 1, maxLength: BRIDGE_LIMITS.url, description: 'A CSS selector, like "#submit" or a [data-fl="12"] one from browser_snapshot.' };
  const ASKS = ' The user is asked to allow it first unless the chat is on Full auto.';
  return [
    tool('browser_open', 'Open a page', 'Opens an http or https URL in FriedLiver\'s browser (opening the browser if needed) and waits for it to load. localhost:3000 works too.' + ASKS, {
      url: { type: 'string', minLength: 1, maxLength: BRIDGE_LIMITS.url, description: 'http://, https://, or a bare localhost:<port> address.' },
    }, ['url']),
    tool('browser_snapshot', 'Read the page', 'The open page as text: its title, URL, visible text, and the links, buttons and fields with a selector for each, to use with browser_click and browser_type.', {}, [], true),
    tool('browser_click', 'Click', 'Clicks an element on the open page, found by CSS selector or by its visible text (give one of the two).' + ASKS, {
      selector: SELECTOR,
      text: { type: 'string', minLength: 1, maxLength: BRIDGE_LIMITS.url, description: 'Visible text of a link, button or label.' },
    }),
    tool('browser_type', 'Type', 'Focuses a field on the open page and types text into it, replacing what it held.' + ASKS, {
      selector: SELECTOR,
      text: { type: 'string', maxLength: BRIDGE_LIMITS.text, description: 'What to type.' },
    }, ['selector', 'text']),
    tool('browser_screenshot', 'Screenshot', 'Saves a PNG of the visible page to a temporary file and returns its path; read that file to see it.', {}, [], true),
    tool('browser_console', 'Console', 'The open page\'s latest console messages and uncaught errors (up to 100).', {}, [], true),
    tool('browser_back', 'Go back', 'Goes back one page in the browser\'s history.' + ASKS),
    tool('browser_reload', 'Reload', 'Reloads the open page.' + ASKS),
  ];
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: true;
}

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

/** What a line from the client asks for: a reply now, a tool call to make, or nothing (a notification or garbage). */
export type Handled =
  | { reply: object }
  | { call: BridgeCall['tool']; args: Record<string, unknown>; id: string | number; progressToken?: string | number }
  | null;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string | number => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const result = (id: string | number, value: object) => ({ jsonrpc: '2.0', id, result: value });
const error = (id: string | number, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
export const toolError = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** One JSON-RPC message from the agent. */
export function handle(raw: unknown): Handled {
  if (!isObj(raw)) return null;
  const m = raw as Message;
  // Notifications (initialized, cancelled, progress) need no answer.
  if (!isId(m.id) || typeof m.method !== 'string') return null;
  const id = m.id;
  const params = isObj(m.params) ? m.params : {};
  switch (m.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return {
        reply: result(id, {
          protocolVersion: typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'friedliver', version: '1.0.0' },
          instructions: INSTRUCTIONS,
        }),
      };
    }
    case 'ping':
      return { reply: result(id, {}) };
    case 'tools/list':
      return { reply: result(id, { tools: TOOLS }) };
    case 'tools/call': {
      const name = params.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return { reply: result(id, toolError(`MCP error -32602: Tool ${String(name)} not found`)) };
      const args = params.arguments === undefined ? {} : params.arguments;
      // The editor checks every call again; this is so the agent hears what is wrong at once.
      if (!isObj(args) || !parseCall(tool.name, args)) {
        return { reply: result(id, toolError(`MCP error -32602: Input validation error: Invalid arguments for tool ${tool.name}; see its input schema.`)) };
      }
      const meta = isObj(params._meta) ? params._meta : {};
      return { call: tool.name as BridgeCall['tool'], args, id, ...(isId(meta.progressToken) ? { progressToken: meta.progressToken } : {}) };
    }
    default:
      return { reply: error(id, -32601, 'Method not found') };
  }
}

/** The answer to a tool call. */
export function toolReply(id: string | number, value: ToolResult): object {
  return result(id, value);
}

/** A progress note for a call still waiting on the editor (or the user). */
export function progress(progressToken: string | number, n: number): object {
  return { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: n, message: 'Waiting for FriedLiver' } };
}
