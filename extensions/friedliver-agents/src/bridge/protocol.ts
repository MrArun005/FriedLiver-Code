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
};

/** What an agent asks for through the FriedLiver tools. */
export type BridgeCall =
  | { tool: 'list_agents' }
  | { tool: 'list_chats' }
  | { tool: 'ask_agent'; agent: AgentKey; prompt: string; chatId?: string }
  | { tool: 'send_to_chat'; chatId: string; message: string }
  | { tool: 'read_chat'; chatId: string; last?: number };

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
