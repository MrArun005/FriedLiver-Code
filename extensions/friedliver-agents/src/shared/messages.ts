// Messages between the webviews and the extension host. Webview content is
// treated as untrusted: every message is checked here before it is acted on.
import { isAgentKey, type Action, type AgentKey, type AppState, type CodeRef, type NoticeAction } from './model';
import { isRule, type CommandRule } from './rules';
import { isApprovalLevel, type AgentDefaults, type ApprovalLevel } from './session';
import { typeable } from './steps';

/** Choices for a new task's agents, per agent: optionKey → value (see session.ts). */
export type TaskChoices = Partial<Record<AgentKey, Record<string, string | boolean>>>;

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
  /** `refs`: code from the editor the message is about (Add Selection to Chat); optional. */
  | { type: 'send'; chatId: string; text: string; images: Attachment[]; refs?: CodeRef[] }
  | { type: 'stop'; chatId: string }
  | { type: 'permission'; requestId: string; optionId: string | null }
  | { type: 'review'; reviewId: string; action: 'open' | 'accept' | 'reject' }
  | { type: 'command'; commandId: string; approve: boolean }
  | { type: 'undo'; chatId: string; turnId: string }
  /** Rewind the chat to before a message (its checkpoint); without `turnId`, pick one from the chat's checkpoints. */
  | { type: 'rewind'; chatId: string; turnId?: string }
  | { type: 'notice'; chatId: string; action: NoticeAction }
  /** `chatId` (optional): the composer the images go to. */
  | { type: 'attach'; chatId?: string }
  /** macOS dictation into the focused composer (the webview focuses it first). */
  | { type: 'dictate' }
  /** A step's image: the host answers with imageSrc when the webview may show it. */
  | { type: 'imageSrc'; path: string }
  /** Opens an image in the editor's image preview, beside the chat. */
  | { type: 'openImage'; path: string }
  /** `line`/`endLine` (1-based, optional) select those lines, for a code reference. */
  | { type: 'openFile'; path: string; line?: number; endLine?: number }
  /** `choices` and `approval` (optional): the agent's model, effort and approval level for the task. */
  | { type: 'createTask'; agent: AgentKey; prompt: string; worktree: boolean; choices?: TaskChoices; approval?: ApprovalLevel }
  /** `item` (optional): a transcript item to scroll to, e.g. a subagent's tool call. */
  | { type: 'openChat'; chatId: string; item?: string }
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
  | { type: 'fanout'; agents: AgentKey[]; prompt: string; worktree: boolean; choices?: TaskChoices; approval?: ApprovalLevel }
  /** Answer an agent's request to reach another chat or agent. */
  | { type: 'bridge'; requestId: string; answer: 'allow' | 'allowChat' | 'deny' }
  | { type: 'archive'; chatId: string; archived: boolean }
  | { type: 'star'; chatId: string; starred: boolean }
  /** Open the shared rules files (sharedRules.ts). */
  | { type: 'openRules' }
  /** Ask for a new name; a name you give stays put. */
  | { type: 'renameChat'; chatId: string }
  /** Stop and forget a chat. */
  | { type: 'removeChat'; chatId: string }
  /** Show what a task changed: its worktree branch against the main checkout, or the files it touched. */
  | { type: 'viewChanges'; chatId: string }
  // Session settings and approvals.
  /** Set one of the chat's session settings (model, effort, mode, Fast…) to a value its agent offers. */
  | { type: 'setOption'; chatId: string; optionId: string; value: string | boolean }
  /** FriedLiver's approval level for the chat. Full auto asks once to confirm. */
  | { type: 'approval'; chatId: string; level: ApprovalLevel }
  | { type: 'plan'; chatId: string; on: boolean }
  /** A read-only diff of what a permission request would write to `path`. */
  | { type: 'permissionDiff'; requestId: string; path: string }
  /** Always allow a command from now on (after a confirmation), and allow this one. */
  | { type: 'allowAlways'; requestId?: string; commandId?: string; rule: CommandRule }
  | { type: 'reviewAll'; chatId: string; action: 'accept' | 'reject' }
  /** A queued message: drop it, or send it now into the running turn. */
  | { type: 'unqueue'; chatId: string; id: string }
  | { type: 'steer'; chatId: string; id: string }
  | { type: 'copy'; text: string }
  /** Puts code from a reply into the active editor at the cursor. */
  | { type: 'insert'; text: string }
  /**
   * Types a command the chat showed in full (a step's command, a shell block in a reply) into a new
   * terminal and runs it, because the user clicked Run. The host runs only what the chat showed.
   * `cwd` (optional): the folder the step ran in; the host uses it only inside the workspace.
   */
  | { type: 'runInTerminal'; chatId: string; command: string; cwd?: string }
  /** An answer to an agent's form, or declining it; the host checks it against what was asked. */
  | { type: 'answerQuestion'; requestId: string; action: 'accept' | 'decline'; values?: Record<string, string | number | boolean | string[]> }
  /** Files matching what follows "#" in the composer, for the picker. */
  | { type: 'findFiles'; chatId: string; query: string }
  /** Claude Code, Cline, Roo Code, Kilo Code or Continue, from the extension gallery. */
  | { type: 'otherAgents' }
  /** Continue a Claude Code session started outside FriedLiver in a new chat. */
  | { type: 'openClaudeSession'; sessionId: string };

export type HostMessage =
  /** `defaults` (optional): each agent's last known options and the user's last choices. */
  | { type: 'snapshot'; state: AppState; selected?: string; now: number; defaults?: Partial<Record<AgentKey, AgentDefaults>> }
  | { type: 'defaults'; defaults: Partial<Record<AgentKey, AgentDefaults>> }
  | { type: 'action'; action: Action }
  /** Several actions in order; the host batches them when agents stream fast. */
  | { type: 'actions'; actions: Action[] }
  | { type: 'select'; chatId: string }
  | { type: 'attached'; images: Attachment[]; chatId?: string }
  /** `src` (a data: URI the host vetted) only when the image may be shown; else the webview shows its name. */
  | { type: 'imageSrc'; path: string; src?: string }
  /** Workspace files for the "#" picker, relative to the chat's folder. */
  | { type: 'foundFiles'; chatId: string; query: string; files: string[] }
  | { type: 'reveal'; chatId: string; id: string }
  /** Put a code reference into that chat's composer, to go with the next message. */
  | { type: 'addRef'; chatId: string; ref: CodeRef }
  /** The workspace's Claude Code sessions FriedLiver didn't start, for the Manager. */
  | { type: 'claudeSessions'; sessions: ClaudeSession[] };

/** A Claude Code session started outside FriedLiver (the CLI or the Claude Code extension), read-only. */
export interface ClaudeSession {
  id: string;
  /** The workspace folder it ran in. */
  cwd: string;
  title: string;
  /** When its transcript last changed, ms since the epoch. */
  lastActivity: number;
  messages: number;
  /** Its Task/Agent calls; `done` once a result came back. */
  subagents: { id: string; title: string; done: boolean }[];
  /** Idle for over a week: counted under Archived, not on the board. */
  archived?: boolean;
}

export const LIMITS = {
  text: 100_000,
  images: 10,
  /** Base64 characters for one image: about 8 MB of bytes. */
  imageData: 11_200_000,
  path: 4096,
  command: 4096,
  /** Agents one fan-out may start: each vendor once, plus the demo. */
  fanout: 4,
  /** Code references one message may carry. */
  refs: 10,
  /** Highest line number a reference may name. */
  line: 10_000_000,
  /** Text one Copy button may put on the clipboard. */
  copy: 1_000_000,
  /** Session settings one new task may set per agent. */
  choices: 16,
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

const line = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= LIMITS.line;

function codeRef(v: unknown): CodeRef | null {
  if (!isObj(v) || !str(v.path, LIMITS.path) || !v.path || !line(v.startLine) || !line(v.endLine) || v.endLine < v.startLine) return null;
  return { path: v.path, startLine: v.startLine, endLine: v.endLine };
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

const optionValue = (v: unknown): v is string | boolean => typeof v === 'boolean' || (typeof v === 'string' && v.length > 0 && v.length <= 256);

/** Per-agent choices for a new task; the host checks each value against what the agent offers. */
function taskChoices(v: unknown): TaskChoices | null | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) return null;
  const out: TaskChoices = {};
  for (const [agent, values] of Object.entries(v)) {
    if (!isAgentKey(agent) || !isObj(values)) return null;
    const entries = Object.entries(values);
    if (entries.length > LIMITS.choices || !entries.every(([k, val]) => str(k, 128) && k && optionValue(val))) return null;
    out[agent] = Object.fromEntries(entries) as Record<string, string | boolean>;
  }
  return out;
}

function taskExtras(m: Obj): { choices?: TaskChoices; approval?: ApprovalLevel } | null {
  const choices = taskChoices(m.choices);
  if (choices === null || (m.approval !== undefined && !isApprovalLevel(m.approval))) return null;
  return { ...(choices ? { choices } : {}), ...(m.approval !== undefined ? { approval: m.approval as ApprovalLevel } : {}) };
}

/** Returns the message if it is well formed, otherwise null. */
export function parseWebviewMessage(raw: unknown): WebviewMessage | null {
  if (!isObj(raw) || typeof raw.type !== 'string') return null;
  const m = raw;
  switch (m.type) {
    case 'ready':
    case 'moveToCenter':
    case 'openTasks':
    case 'otherAgents':
    case 'dictate':
      return { type: m.type };
    case 'attach':
      if (m.chatId === undefined) return { type: 'attach' };
      return id(m.chatId) ? { type: 'attach', chatId: m.chatId } : null;
    case 'imageSrc':
    case 'openImage':
      return str(m.path, LIMITS.path) && m.path ? { type: m.type, path: m.path } : null;
    case 'setOption':
      return id(m.chatId) && str(m.optionId, 128) && m.optionId && optionValue(m.value) ? { type: 'setOption', chatId: m.chatId, optionId: m.optionId, value: m.value } : null;
    case 'approval':
      return id(m.chatId) && isApprovalLevel(m.level) ? { type: 'approval', chatId: m.chatId, level: m.level } : null;
    case 'plan':
      return id(m.chatId) && typeof m.on === 'boolean' ? { type: 'plan', chatId: m.chatId, on: m.on } : null;
    case 'permissionDiff':
      return id(m.requestId) && str(m.path, LIMITS.path) && m.path ? { type: 'permissionDiff', requestId: m.requestId, path: m.path } : null;
    case 'allowAlways': {
      if (!isRule(m.rule) || (m.requestId !== undefined && !id(m.requestId)) || (m.commandId !== undefined && !id(m.commandId))) return null;
      if ((m.requestId === undefined) === (m.commandId === undefined)) return null;
      const rule = { kind: m.rule.kind, command: m.rule.command };
      return m.requestId !== undefined ? { type: 'allowAlways', requestId: m.requestId as string, rule } : { type: 'allowAlways', commandId: m.commandId as string, rule };
    }
    case 'reviewAll':
      return id(m.chatId) && (m.action === 'accept' || m.action === 'reject') ? { type: 'reviewAll', chatId: m.chatId, action: m.action } : null;
    case 'unqueue':
    case 'steer':
      return id(m.chatId) && id(m.id) ? { type: m.type, chatId: m.chatId, id: m.id } : null;
    case 'copy':
    case 'insert':
      return str(m.text, LIMITS.copy) && m.text ? { type: m.type, text: m.text } : null;
    case 'runInTerminal':
      if (!id(m.chatId) || typeof m.command !== 'string' || !typeable(m.command)) return null;
      if (m.cwd !== undefined && (!str(m.cwd, LIMITS.path) || !m.cwd || m.cwd.includes('\0'))) return null;
      return { type: 'runInTerminal', chatId: m.chatId, command: m.command, ...(m.cwd !== undefined ? { cwd: m.cwd } : {}) };
    case 'findFiles':
      return id(m.chatId) && str(m.query, 200) ? { type: 'findFiles', chatId: m.chatId, query: m.query } : null;
    case 'answerQuestion': {
      if (!id(m.requestId) || (m.action !== 'accept' && m.action !== 'decline')) return null;
      if (m.values === undefined) return { type: 'answerQuestion', requestId: m.requestId, action: m.action };
      if (!isObj(m.values) || Object.keys(m.values).length > 12) return null;
      const ok = Object.entries(m.values).every(
        ([k, v]) =>
          str(k, 128) &&
          (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || str(v, 10_000) || (Array.isArray(v) && v.length <= 50 && v.every((x) => str(x, 500)))),
      );
      return ok ? { type: 'answerQuestion', requestId: m.requestId, action: m.action, values: m.values as Record<string, string | number | boolean | string[]> } : null;
    }
    case 'newChat':
      return isAgentKey(m.agent) ? { type: 'newChat', agent: m.agent } : null;
    case 'openClaudeSession':
      return id(m.sessionId) ? { type: 'openClaudeSession', sessionId: m.sessionId } : null;
    case 'openChat':
      return id(m.chatId) ? { type: 'openChat', chatId: m.chatId, ...(id(m.item) ? { item: m.item } : {}) } : null;
    case 'select':
    case 'stop':
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
      const extras = taskExtras(m);
      return extras && str(m.prompt, LIMITS.text) && m.prompt.trim() && typeof m.worktree === 'boolean'
        ? { type: 'fanout', agents, prompt: m.prompt, worktree: m.worktree, ...extras }
        : null;
    }
    case 'bridge':
      return id(m.requestId) && (m.answer === 'allow' || m.answer === 'allowChat' || m.answer === 'deny')
        ? { type: 'bridge', requestId: m.requestId, answer: m.answer }
        : null;
    case 'openRules':
      return { type: 'openRules' };
    case 'star':
      return id(m.chatId) && typeof m.starred === 'boolean' ? { type: 'star', chatId: m.chatId, starred: m.starred } : null;
    case 'renameChat':
      return id(m.chatId) ? { type: 'renameChat', chatId: m.chatId } : null;
    case 'archive':
      return id(m.chatId) && typeof m.archived === 'boolean' ? { type: 'archive', chatId: m.chatId, archived: m.archived } : null;
    case 'send': {
      if (!id(m.chatId) || !str(m.text, LIMITS.text) || !Array.isArray(m.images) || m.images.length > LIMITS.images) return null;
      const images = m.images.map(attachment);
      if (images.some((i) => i === null)) return null;
      if (m.refs !== undefined && (!Array.isArray(m.refs) || m.refs.length > LIMITS.refs)) return null;
      const refs = m.refs === undefined ? [] : m.refs.map(codeRef);
      if (refs.some((r) => r === null)) return null;
      if (!m.text.trim() && images.length === 0 && refs.length === 0) return null;
      return { type: 'send', chatId: m.chatId, text: m.text, images: images as Attachment[], ...(refs.length ? { refs: refs as CodeRef[] } : {}) };
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
    case 'rewind':
      if (!id(m.chatId)) return null;
      if (m.turnId === undefined) return { type: 'rewind', chatId: m.chatId };
      return id(m.turnId) ? { type: 'rewind', chatId: m.chatId, turnId: m.turnId } : null;
    case 'notice': {
      const action = noticeAction(m.action);
      return id(m.chatId) && action ? { type: 'notice', chatId: m.chatId, action } : null;
    }
    case 'openFile':
      if (!str(m.path, LIMITS.path) || !m.path) return null;
      if (m.line === undefined) return { type: 'openFile', path: m.path };
      if (!line(m.line) || (m.endLine !== undefined && (!line(m.endLine) || m.endLine < m.line))) return null;
      return { type: 'openFile', path: m.path, line: m.line, ...(m.endLine !== undefined ? { endLine: m.endLine } : {}) };
    case 'createTask': {
      const extras = taskExtras(m);
      return extras && isAgentKey(m.agent) && str(m.prompt, LIMITS.text) && m.prompt.trim() && typeof m.worktree === 'boolean'
        ? { type: 'createTask', agent: m.agent, prompt: m.prompt, worktree: m.worktree, ...extras }
        : null;
    }
    default:
      return null;
  }
}
