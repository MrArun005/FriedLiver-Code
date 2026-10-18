// What FriedLiver Remote's server and the phone app say to each other. The
// phone is untrusted input like a webview: every action is checked here
// (through the webviews' own parser where the shapes are the same) before the
// host acts on it.
import type { DiffLine } from '../shared/diff';
import { LIMITS, parseWebviewMessage } from '../shared/messages';
import type { AgentKey, ChatStatus } from '../shared/model';
import { isAgentKey } from '../shared/model';
import type { Grant } from '../shared/permissions';
import type { Risk } from './risk';
import type { QuestionField, QuestionValue } from '../shared/questions';
import type { ApprovalLevel } from '../shared/session';
import type { Subagent } from '../shared/view';

export interface PhoneSummary {
  id: string;
  agent: AgentKey;
  label: string;
  title: string;
  status: ChatStatus;
  /** The chat's folder name. */
  folder: string;
  busy: boolean;
  lastActivity: number;
  /** Decisions waiting on the user. */
  waiting: number;
  /** Subagents still running. */
  subagents: number;
  approval: ApprovalLevel;
}

export interface PhoneList {
  groups: { status: ChatStatus; title: string; chats: PhoneSummary[] }[];
  /** Agents a new chat may start with. */
  agents: { key: AgentKey; name: string }[];
  /** The window's folders, for a new chat. */
  folders: { path: string; name: string }[];
  now: number;
}

export interface PhoneFile {
  path: string;
  added: number;
  removed: number;
  isNew?: boolean;
  lines: DiffLine[];
  more: number;
}

export type PhoneItem =
  | { k: 'user'; text: string }
  | { k: 'agent'; text: string }
  | { k: 'tool'; id: string; title: string; status?: string; subagent?: boolean }
  | { k: 'plan'; entries: { content: string; status: string }[] }
  | {
      k: 'permission';
      id: string;
      title: string;
      /** The header: "Run", "Edit", "Fetch"; the mono target; and how careful to be. */
      verb: string;
      target?: string;
      risk: Risk;
      /** The scope control: the agent's plain one-time yes, its "for this session" answer, and its no. */
      once?: string;
      chat?: string;
      deny?: string;
      /** The agent's other answers (a plan's "and auto-accept edits", "tell Claude what to do differently"). */
      options: { id: string; name: string; kind: string; escalates: boolean }[];
      answer?: string;
      auto?: string;
      command?: { line: string; cwd?: string };
      files?: PhoneFile[];
      plan?: string;
      text?: string;
      url?: string;
      /** The command can't be shown whole and plainly: allow it on the Mac. */
      onMac?: boolean;
      /** "Always allow" choices: what the card offers, each confirmed on the Mac. */
      always: { grant: Grant; label: string }[];
    }
  | { k: 'command'; id: string; line: string; cwd: string; state: string; outside: boolean; output: string; exitCode?: number | null; auto?: string; onMac?: boolean; risk: Risk }
  | { k: 'question'; id: string; message: string; fields: QuestionField[]; state: string; summary?: string }
  | { k: 'review'; id: string; file: PhoneFile; state: string; auto?: string }
  /** `once`: Allow (once) and Deny only; `careful`: also held to allow. */
  | { k: 'bridge'; id: string; title: string; text: string; state: string; always?: string; agent: AgentKey; once?: true; careful?: true }
  | { k: 'notice'; text: string; tone: 'info' | 'error' }
  | { k: 'changes'; files: number; undone?: boolean }
  | { k: 'link'; label: string; text: string; role: string };

export interface PhoneChat extends PhoneSummary {
  items: PhoneItem[];
  /** Earlier items not sent. */
  earlier: number;
  subagentList: Subagent[];
  queued: number;
}

/** Server → phone over the WebSocket: something changed; fetch what you show. */
export type PhoneEvent = { type: 'changed'; chats: string[] } | { type: 'revoked' };

export type RemoteAction =
  | { type: 'send'; chatId: string; text: string }
  | { type: 'stop'; chatId: string }
  /** `shown`: the exact command the phone showed; an allow is refused unless it matches the request now. */
  | { type: 'permission'; requestId: string; optionId: string | null; shown?: string }
  | { type: 'command'; commandId: string; approve: boolean; shown?: string }
  | { type: 'answerQuestion'; requestId: string; action: 'accept' | 'decline'; values?: Record<string, QuestionValue> }
  | { type: 'review'; reviewId: string; action: 'accept' | 'reject' }
  | { type: 'bridge'; requestId: string; answer: 'allow' | 'allowChat' | 'allowAlways' | 'deny' }
  | { type: 'allowAlways'; requestId?: string; commandId?: string; grant: Grant; shown?: string }
  | { type: 'approval'; chatId: string; level: ApprovalLevel }
  | { type: 'newChat'; agent: AgentKey; folder: string; text: string };

const SAME_AS_WEBVIEW = new Set(['stop', 'permission', 'command', 'answerQuestion', 'bridge', 'allowAlways', 'approval']);

/** The action if it is one the phone may send, well formed; otherwise null. */
export function parseRemoteAction(raw: unknown): RemoteAction | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.type === 'string' && SAME_AS_WEBVIEW.has(m.type)) {
    const parsed = parseWebviewMessage(m) as RemoteAction | null;
    if (!parsed || m.shown === undefined) return parsed;
    if (typeof m.shown !== 'string' || m.shown.length > LIMITS.command * 2 || !(parsed.type === 'permission' || parsed.type === 'command' || parsed.type === 'allowAlways')) return null;
    return { ...parsed, shown: m.shown };
  }
  switch (m.type) {
    case 'send': {
      // Text only: no images, no code references from the phone.
      const parsed = parseWebviewMessage({ type: 'send', chatId: m.chatId, text: m.text, images: [] });
      return parsed?.type === 'send' ? { type: 'send', chatId: parsed.chatId, text: parsed.text } : null;
    }
    case 'review':
      return (m.action === 'accept' || m.action === 'reject') && parseWebviewMessage(m) ? { type: 'review', reviewId: m.reviewId as string, action: m.action } : null;
    case 'newChat': {
      const text = typeof m.text === 'string' && m.text.length <= LIMITS.text ? m.text : null;
      return isAgentKey(m.agent) && typeof m.folder === 'string' && m.folder.length > 0 && m.folder.length <= LIMITS.path && text !== null
        ? { type: 'newChat', agent: m.agent, folder: m.folder, text }
        : null;
    }
    default:
      return null;
  }
}
