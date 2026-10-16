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
  | { type: 'openTasks' };

export type HostMessage =
  | { type: 'snapshot'; state: AppState; selected?: string; now: number }
  | { type: 'action'; action: Action }
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
      return str(v.command, LIMITS.command) && v.command ? { label, do: 'install', command: v.command } : null;
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
      return id(m.chatId) ? { type: m.type, chatId: m.chatId } : null;
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
