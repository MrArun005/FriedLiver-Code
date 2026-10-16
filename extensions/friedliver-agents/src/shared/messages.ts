// Messages between the webviews and the extension host. Webview content is
// treated as untrusted: every message is checked here before it is acted on.
import { isAgentKey, type Action, type AgentKey, type AppState, type NoticeAction } from './model';

export interface Attachment {
  name: string;
  mimeType: string;
  /** Base64 without the data: prefix, as ACP image blocks want it. */
  data: string;
}

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'newChat'; agent: AgentKey }
  | { type: 'select'; chatId: string }
  | { type: 'send'; chatId: string; text: string; images: Attachment[] }
  | { type: 'stop'; chatId: string }
  | { type: 'permission'; requestId: string; optionId: string | null }
  | { type: 'review'; reviewId: string; action: 'open' | 'accept' | 'reject' }
  | { type: 'command'; commandId: string; approve: boolean }
  | { type: 'undo'; chatId: string; turnId: string }
  | { type: 'notice'; chatId: string; action: NoticeAction }
  | { type: 'attach' }
  | { type: 'openFile'; path: string }
  | { type: 'createTask'; agent: AgentKey; prompt: string; worktree: boolean }
  | { type: 'openChat'; chatId: string }
  | { type: 'merge'; chatId: string }
  | { type: 'removeWorktree'; chatId: string }
  | { type: 'moveToCenter' }
  | { type: 'openTasks' }
  // Connections between chats and agents.
  /** Continue this chat with another agent, in a new chat that starts from its transcript. */
  | { type: 'handoff'; chatId: string; agent: AgentKey }
  /** Ask another agent from this chat; its reply comes back here. A message starting "@gemini" does the same. */
  | { type: 'consult'; chatId: string; agent: AgentKey; text: string }
  /** Forward each finished turn of `from` to the chat `to`. */
  | { type: 'pipe'; from: string; to: string }
  | { type: 'unlink'; linkId: string }
  /** Send `fromChatId`'s last reply to `toChatId` as a message, e.g. a consultant's answer back to the main chat. */
  | { type: 'forward'; fromChatId: string; toChatId: string }
  /** The same task on several agents at once, each in its own worktree when asked, to compare. */
  | { type: 'fanout'; agents: AgentKey[]; prompt: string; worktree: boolean }
  /** Answer an agent's request to reach another chat or agent. */
  | { type: 'bridge'; requestId: string; answer: 'allow' | 'allowChat' | 'deny' }
  | { type: 'archive'; chatId: string; archived: boolean }
  /** Stop and forget a chat. */
  | { type: 'removeChat'; chatId: string }
  /** Show what a task changed: its worktree branch against the main checkout, or the files it touched. */
  | { type: 'viewChanges'; chatId: string };

export type HostMessage =
  | { type: 'snapshot'; state: AppState; selected?: string; now: number }
  | { type: 'action'; action: Action }
  /** Several actions in order; the host batches them when agents stream fast. */
  | { type: 'actions'; actions: Action[] }
  | { type: 'select'; chatId: string }
  | { type: 'attached'; images: Attachment[] }
  | { type: 'reveal'; chatId: string; id: string };

export const LIMITS = {
  text: 100_000,
  images: 10,
  /** Base64 characters for one image: about 8 MB of bytes. */
  imageData: 11_200_000,
  path: 4096,
  command: 4096,
  /** Agents one fan-out may start: each vendor once, plus the demo. */
  fanout: 4,
};

export const IMAGE_MIME = /^image\/(png|jpeg|gif|webp|bmp|svg\+xml)$/;
const ID = /^[\w.:-]{1,128}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

function attachment(v: unknown): Attachment | null {
  if (!isObj(v)) return null;
  const { name, mimeType, data } = v;
  if (!str(name, 256) || typeof mimeType !== 'string' || !IMAGE_MIME.test(mimeType)) return null;
  if (!str(data, LIMITS.imageData) || !data || !BASE64.test(data)) return null;
  return { name, mimeType, data };
}

function noticeAction(v: unknown): NoticeAction | null {
  if (!isObj(v) || !str(v.label, 200)) return null;
  const label = v.label;
  switch (v.do) {
    case 'retry':
      return { label, do: 'retry' };
    case 'signIn':
      return isAgentKey(v.agent) && id(v.methodId) ? { label, do: 'signIn', agent: v.agent, methodId: v.methodId } : null;
    case 'apiKey':
      return isAgentKey(v.agent) ? { label, do: 'apiKey', agent: v.agent } : null;
    case 'install':
      // Only which agent to install; the host chooses the command itself.
      return isAgentKey(v.agent) && v.agent !== 'demo' ? { label, do: 'install', agent: v.agent } : null;
    default:
      return null;
  }
}

/** Returns the message if it is well formed, otherwise null. */
export function parseWebviewMessage(raw: unknown): WebviewMessage | null {
  if (!isObj(raw) || typeof raw.type !== 'string') return null;
  const m = raw;
  switch (m.type) {
    case 'ready':
    case 'attach':
    case 'moveToCenter':
    case 'openTasks':
      return { type: m.type };
    case 'newChat':
      return isAgentKey(m.agent) ? { type: 'newChat', agent: m.agent } : null;
    case 'select':
    case 'stop':
    case 'openChat':
    case 'merge':
    case 'removeWorktree':
    case 'removeChat':
    case 'viewChanges':
      return id(m.chatId) ? { type: m.type, chatId: m.chatId } : null;
    case 'handoff':
      return id(m.chatId) && isAgentKey(m.agent) ? { type: 'handoff', chatId: m.chatId, agent: m.agent } : null;
    case 'consult':
      return id(m.chatId) && isAgentKey(m.agent) && str(m.text, LIMITS.text) && m.text.trim()
        ? { type: 'consult', chatId: m.chatId, agent: m.agent, text: m.text }
        : null;
    case 'pipe':
      return id(m.from) && id(m.to) && m.from !== m.to ? { type: 'pipe', from: m.from, to: m.to } : null;
    case 'unlink':
      return id(m.linkId) ? { type: 'unlink', linkId: m.linkId } : null;
    case 'forward':
      return id(m.fromChatId) && id(m.toChatId) && m.fromChatId !== m.toChatId ? { type: 'forward', fromChatId: m.fromChatId, toChatId: m.toChatId } : null;
    case 'fanout': {
      if (!Array.isArray(m.agents) || m.agents.length < 1 || m.agents.length > LIMITS.fanout || !m.agents.every(isAgentKey)) return null;
      const agents = [...new Set(m.agents as AgentKey[])];
      return str(m.prompt, LIMITS.text) && m.prompt.trim() && typeof m.worktree === 'boolean'
        ? { type: 'fanout', agents, prompt: m.prompt, worktree: m.worktree }
        : null;
    }
    case 'bridge':
      return id(m.requestId) && (m.answer === 'allow' || m.answer === 'allowChat' || m.answer === 'deny')
        ? { type: 'bridge', requestId: m.requestId, answer: m.answer }
        : null;
    case 'archive':
      return id(m.chatId) && typeof m.archived === 'boolean' ? { type: 'archive', chatId: m.chatId, archived: m.archived } : null;
    case 'send': {
      if (!id(m.chatId) || !str(m.text, LIMITS.text) || !Array.isArray(m.images) || m.images.length > LIMITS.images) return null;
      const images = m.images.map(attachment);
      if (images.some((i) => i === null)) return null;
      if (!m.text.trim() && images.length === 0) return null;
      return { type: 'send', chatId: m.chatId, text: m.text, images: images as Attachment[] };
    }
    case 'permission':
      return id(m.requestId) && (m.optionId === null || id(m.optionId)) ? { type: 'permission', requestId: m.requestId, optionId: m.optionId } : null;
    case 'review':
      return id(m.reviewId) && (m.action === 'open' || m.action === 'accept' || m.action === 'reject')
        ? { type: 'review', reviewId: m.reviewId, action: m.action }
        : null;
    case 'command':
      return id(m.commandId) && typeof m.approve === 'boolean' ? { type: 'command', commandId: m.commandId, approve: m.approve } : null;
    case 'undo':
      return id(m.chatId) && id(m.turnId) ? { type: 'undo', chatId: m.chatId, turnId: m.turnId } : null;
    case 'notice': {
      const action = noticeAction(m.action);
      return id(m.chatId) && action ? { type: 'notice', chatId: m.chatId, action } : null;
    }
    case 'openFile':
      return str(m.path, LIMITS.path) && m.path ? { type: 'openFile', path: m.path } : null;
    case 'createTask':
      return isAgentKey(m.agent) && str(m.prompt, LIMITS.text) && m.prompt.trim() && typeof m.worktree === 'boolean'
        ? { type: 'createTask', agent: m.agent, prompt: m.prompt, worktree: m.worktree }
        : null;
    default:
      return null;
  }
}
