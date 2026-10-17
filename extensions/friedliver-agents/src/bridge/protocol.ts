// Lines between the FriedLiver MCP server an agent session runs (dist/bridge.js)
// and the extension host, over a local socket: one JSON object per line.
// The host treats every line as untrusted and checks it here first.
import { isAgentKey, type AgentKey } from '../shared/model';

/** Where the host listens: a Unix socket path or a Windows pipe name. */
export const BRIDGE_ENV = 'FRIEDLIVER_BRIDGE';
/** The chat's own secret; it decides which chat a request acts as. */
export const TOKEN_ENV = 'FRIEDLIVER_BRIDGE_TOKEN';

export const BRIDGE_LIMITS = {
  /** Bytes in one line, either way. */
  line: 1024 * 1024,
  /** Requests one connection may make before the host hangs up. */
  requests: 1000,
  /** Characters in a question or message. */
  text: 100_000,
  /** Messages read_chat returns at most. */
  last: 50,
  /** Characters in a URL or CSS selector for the browser tools. */
  url: 2048,
};

/** What an agent asks for through the FriedLiver tools. */
export type BridgeCall =
  | { tool: 'list_agents' }
  | { tool: 'list_chats' }
  | { tool: 'ask_agent'; agent: AgentKey; prompt: string; chatId?: string }
  | { tool: 'send_to_chat'; chatId: string; message: string }
  | { tool: 'read_chat'; chatId: string; last?: number }
  | { tool: 'remember'; fact: string }
  | { tool: 'browser_open'; url: string }
  | { tool: 'browser_click'; selector?: string; text?: string }
  | { tool: 'browser_type'; selector: string; text: string }
  | { tool: 'browser_snapshot' | 'browser_screenshot' | 'browser_console' | 'browser_back' | 'browser_reload' };

export type BrowserCall = Extract<BridgeCall, { tool: `browser_${string}` }>;

/**
 * The caller id of a client outside FriedLiver (the Claude Code extension or CLI) holding the
 * external token. Never a chat id (those match `chat-<n>`); it may use the browser_* tools only.
 */
export const EXTERNAL_CLIENT = ':external';

/** An external caller's id: EXTERNAL_CLIENT and its MCP session, `:external:<session>`. */
export const isExternal = (id: string): boolean => id === EXTERNAL_CLIENT || id.startsWith(`${EXTERNAL_CLIENT}:`);

export const isBrowserCall = (call: BridgeCall): call is BrowserCall => call.tool.startsWith('browser_');

export interface BridgeRequest {
  id: number;
  token: string;
  call: BridgeCall;
}

export type BridgeResponse = { id: number; ok: true; text: string } | { id: number; ok: false; error: string };

const TOKEN = /^[0-9a-f]{64}$/;
const CHAT_ID = /^[\w.:-]{1,128}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= BRIDGE_LIMITS.text;
const chatId = (v: unknown): v is string => typeof v === 'string' && CHAT_ID.test(v);
const short = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= BRIDGE_LIMITS.url;

/** The tool call in a request, or null when anything about it is off. */
export function parseCall(tool: unknown, args: unknown): BridgeCall | null {
  const a = args === undefined ? {} : args;
  if (!isObj(a)) return null;
  switch (tool) {
    case 'list_agents':
    case 'list_chats':
      return { tool };
    case 'ask_agent':
      if (!isAgentKey(a.agent) || !text(a.prompt) || (a.chat_id !== undefined && !chatId(a.chat_id))) return null;
      return { tool, agent: a.agent, prompt: a.prompt, ...(a.chat_id !== undefined ? { chatId: a.chat_id } : {}) };
    case 'send_to_chat':
      return chatId(a.chat_id) && text(a.message) ? { tool, chatId: a.chat_id, message: a.message } : null;
    case 'read_chat': {
      if (!chatId(a.chat_id)) return null;
      const last = a.last;
      if (last !== undefined && !(Number.isInteger(last) && (last as number) >= 1 && (last as number) <= BRIDGE_LIMITS.last)) return null;
      return { tool, chatId: a.chat_id, ...(last !== undefined ? { last: last as number } : {}) };
    }
    case 'remember':
      return text(a.fact) ? { tool, fact: a.fact } : null;
    case 'browser_open':
      return short(a.url) ? { tool, url: a.url } : null;
    case 'browser_click':
      // Exactly one of the two.
      if (short(a.selector) === short(a.text) || (a.selector !== undefined && !short(a.selector)) || (a.text !== undefined && !short(a.text))) return null;
      return short(a.selector) ? { tool, selector: a.selector } : { tool, text: a.text as string };
    case 'browser_type':
      return short(a.selector) && typeof a.text === 'string' && a.text.length <= BRIDGE_LIMITS.text ? { tool, selector: a.selector, text: a.text } : null;
    case 'browser_snapshot':
    case 'browser_screenshot':
    case 'browser_console':
    case 'browser_back':
    case 'browser_reload':
      return { tool };
    default:
      return null;
  }
}

/** `{"id":1,"token":"…","tool":"ask_agent","args":{…}}`, or null. */
export function parseRequest(line: string): BridgeRequest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(raw) || !Number.isSafeInteger(raw.id) || typeof raw.token !== 'string' || !TOKEN.test(raw.token)) return null;
  const call = parseCall(raw.tool, raw.args);
  return call ? { id: raw.id as number, token: raw.token, call } : null;
}

export function encodeRequest(id: number, token: string, tool: BridgeCall['tool'], args: Record<string, unknown>): string {
  return `${JSON.stringify({ id, token, tool, args })}\n`;
}
