import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as acp from '@agentclientprotocol/sdk';
import { AgentStartError, agentErrorMessage } from '@friedliver/main/agents/agentConnection';
import { agentShell } from '@friedliver/main/agents/agentShell';
import { readIfExists, readTextFile, writeTextFile } from '@friedliver/main/agents/fileAccess';
import { AgentHub, AuthRequiredError, NoSessionError, type SessionStart } from '@friedliver/main/agents/hub';
import { DEFAULT_AGENTS, demoAgentSpec, type AgentSpec, type VendorAgentId } from '@friedliver/main/agents/registry';
import { findProgram } from '@friedliver/main/agents/processes';
import { allowedSignInUrl, signInMethods } from '@friedliver/main/agents/signIn';
import { visibleText, type TerminalListener } from '@friedliver/main/agents/terminals';
import { TurnLog } from '@friedliver/main/agents/turnLog';
import { commandGuard, downloadTargets, FileTrail } from './fullAutoGuards';
import * as git from '@friedliver/main/workspace/git';
import { BRIDGE_ENV, EXTERNAL_CLIENT, TOKEN_ENV, type BridgeCall } from '../bridge/protocol';
import { OMIT_ENV, omittedTools } from '../bridge/mcp';
import type { Attachment } from '../shared/messages';
import { describeRule, matchesRule } from '../shared/rules';
import { describeGrant, sameGrant, siteOrigin, type Access, type Grant } from '../shared/permissions';
import {
  APPROVAL_NAMES,
  EMPTY_SESSION,
  defaultChoices,
  baseModel,
  choiceName,
  hiddenModels,
  withoutModels,
  type ModelVisibility,
  levelOfMode,
  modeFor,
  modeOption,
  offers,
  optionKey,
  planToggle,
  planning,
  sessionOptions,
  type AgentDefaults,
  type ApprovalLevel,
  type ChatSession,
  type SessionOption,
  readOnlyChoice,
  CLAUDE_READ_ONLY_META,
} from '../shared/session';
import { answerSummary, checkAnswer, questionFields, type QuestionField } from '../shared/questions';
import { ESCALATING, claudeMeta, commandOf, planOf, type PermissionDetail } from '../shared/tools';
import { approvalOf, type Approvable } from '../shared/approval';
import { autoRoutineCommand, commandRisk, forcePush, type DroppedCommits } from '../shared/risk';
import { chatRef } from '../shared/names';
import {
  AGENT_FACES,
  EMPTY_STATE,
  MAX_COMMAND_OUTPUT,
  decisions,
  lastReply,
  lineStats,
  parseMention,
  reduce,
  titleFrom,
  topicTitle,
  type Action,
  type AgentKey,
  type AppState,
  type ChatLink,
  type ChatView,
  type CodeRef,
  type Decision,
  type Item,
  type NoticeAction,
  type QueuedMessage,
  type TokenTally,
} from '../shared/model';
import { estimateTokens } from '../shared/tokens';
import { BridgeServer } from './bridge';
import { Checkpoints, type RewindPlan } from './checkpoints';
import { BridgeRequests, type AgentToAgent, type BridgeAnswer, type ToolHost } from './bridgeRequests';
import { Connections, type NewChat, type TurnResult } from './connections';
import { MAX_AGENT_READ_BYTES, compactUpdate, imageDataUri } from './limits';
import { inGitFolder, insideRoots, realPath, workspacePath } from './paths';
import type { Permissions } from './permissions';
import { settleRestored, type SavedState } from './persist';
import { applyDiffs, diffsByFile, proposedFile, type Proposal } from './proposals';
import { loginExtras } from './signin';
import { mergeOffered, type AccountRecord } from '../shared/accounts';
import { relativeFile, rewoundHistory } from './transcript';
import { testAgentsOn } from './settings';
import { RULES_CAP, type Rules } from './sharedRules';
import { DISCUSS_READ_ONLY, Discussions, discussionAllows, discussionAllowsBridge } from './discuss';
import { currentModel, modelCatalog, sameModel, type Who } from '../shared/discussMentions';

const READ_ONLY = 'This chat only proposes text: FriedLiver refuses file access, commands and tools in it.';
/** Each prompt of a chat that must stay read only says so: an adapter that can hold itself to it (Antigravity's talk only) does, whatever its mode. */
export const READ_ONLY_PROMPT_META = { friedliver: { readOnly: true } };
const LEVEL_LOCKED = 'This chat stays read only while it is in a discussion (or is a read-only chat), so its level and mode can’t change until that ends.';

/** Each vendor's key goes only to that vendor's agent process. Antigravity has none: agy signs in with Google itself. */
export const KEY_ENV: Partial<Record<VendorAgentId, string>> = {
  claude: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};
export const VENDOR_AGENTS: VendorAgentId[] = ['claude', 'codex', 'gemini', 'antigravity'];

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
/** Files larger than this aren't read to show a permission request's whole diff. */
const MAX_PROPOSAL_BYTES = 4 * 1024 * 1024;
/** Tool calls remembered per chat until they finish, to fill in permission requests that name only an id. */
const MAX_OPEN_TOOLS = 200;
/** Tokens the project map at a session's start takes at most. */
export const PRIMER_TOKENS = 1500;
/** The share of the context window past which a chat is offered /compact. */
export const CONTEXT_FULL = 0.85;
/** Where agents' tool inputs name the files they act on (Claude, Codex, Gemini, and the obvious others). */
const TARGET_KEYS = ['file_path', 'filePath', 'path', 'abs_path', 'notebook_path', 'old_path', 'new_path', 'source', 'destination', 'target'];
/** Messages that can wait for a busy chat. */
const MAX_QUEUE = 10;

const OUTPUT_FLUSH_MS = 50;

export interface PendingReview {
  reviewId: string;
  chatId?: string;
  /** Opened by itself, not from an editor command: reuses the chat's diff tab. */
  auto?: boolean;
  path: string;
  /** Null when the agent creates the file. */
  before: string | null;
  proposed: string;
  agentLabel: string;
}

/** What the editor shows around the core: diff editors, notifications. */
export interface CoreUi {
  showReview(review: PendingReview): void;
  closeReview(reviewId: string): void;
  /** `careful`: allowed only by holding on its card, so a notification offers no Run. */
  askCommand?(ask: { chatId?: string; commandId: string; agentLabel: string; commandLine: string; careful?: boolean }): void;
  /** `allow`/`deny`: the agent's own options a notification may offer, by id. */
  /** No `allow` for a careful request: it is allowed only by holding on its card. */
  askPermission?(ask: { chatId: string; requestId: string; agentLabel: string; title: string; allow?: { optionId: string; name: string }; deny?: { optionId: string; name: string } }): void;
  /** A read-only diff of what a permission request would write. */
  showProposal?(p: { id: string; path: string; before: string | null; after: string; agentLabel: string; chatId: string }): void;
  /** A turn ended: the editor may say so when the chat isn't on screen. */
  turnEnded?(t: { chatId: string; agent: AgentKey; title: string; stopReason: acp.StopReason | null; failure?: Item; files: number; byUser: boolean }): void;
  /** Asks once per chat before Full auto. */
  confirmFullAuto?(ask: { label: string; agent: string; mode?: string }): Promise<boolean>;
  /** Asks before adding an "Always allow" command rule. */
  confirmRule?(rule: Extract<Grant, { kind: 'exact' | 'prefix' }>): Promise<boolean>;
  /** FriedLiver Remote asked for something that keeps allowing (Auto, "Always allow"): the user's OK on the Mac. No hook: refused. */
  confirmRemote?(ask: { title: string; detail: string; button: string }): Promise<boolean>;
  /** An agent asks, through the FriedLiver tools, to reach another agent or chat. */
  askBridge?(ask: { chatId: string; requestId: string; title: string; detail?: string; always?: string; careful?: boolean; once?: boolean }): void;
  /** An agent asks a question as a small form, answered in the chat. */
  askQuestion?(ask: { chatId: string; requestId: string; agentLabel: string; message: string }): void;
  signInUrl?(agent: AgentKey, url: string): void;
  fileChanged?(file: string): void;
  /** The text of an open editor with unsaved changes, so agents read what the user sees. */
  unsavedText?(file: string): string | undefined;
}

export interface CoreOptions {
  folders(): string[];
  clientVersion: string;
  demoAgentScript: string;
  /**
   * FriedLiver's ACP adapter for agy (dist/agy-acp.js), which has no ACP mode. Without it the
   * Antigravity command must speak ACP itself, like the other agents' (the tests' demo agent).
   */
  agyAdapterScript?: string;
  agentCommand(id: VendorAgentId): { command: string; args: string[] };
  apiKey(id: VendorAgentId): string | undefined;
  /** Other credentials FriedLiver keeps for the agent (Gemini's Vertex AI settings), as its environment. */
  credentialEnv?(id: VendorAgentId): Record<string, string>;
  /** What a session, a failure or the agent itself just said about its sign-in (accounts.ts caches it). */
  accountSeen?(agent: AgentKey, patch: Partial<AccountRecord>): void;
  limits(): { maxRunning: number; idleStopMinutes: number };
  /** The FriedLiver tools' MCP server (dist/bridge.js). Without it, agents get no FriedLiver tools. */
  bridgeScript?: string;
  /** Does the browser_* tools' calls (browser.ts); without it they say there is no browser. */
  browser?: ToolHost['browser'];
  /** Whether read_chat between linked chats skips the user's OK (friedliver.chat.autoAllowLinkedReads). */
  autoAllowLinkedReads?: () => boolean;
  /** friedliver.discuss.maxRounds and .tokenBudget; the defaults when unset. */
  discussSettings?: () => { maxRounds?: number; tokenBudget?: number };
  /** Whether the external client's browser actions skip the user's OK (friedliver.browser.externalAutoApprove). */
  externalAutoApprove?: () => boolean;
  /** The browser page's origin and whether a selector there is a password field (browser.ts). */
  browserPage?: ToolHost['browserPage'];
  /** Answers the index_* tools (projectIndexHost.ts). */
  index?: ToolHost['index'];
  /** The system_* tools (system.ts, the user's settings, the audit log). */
  system?: ToolHost['system'];
  /** Whether the project index is on (friedliver.index.enabled); without it, sessions aren't offered the index_* tools. On when absent and `index` is given. */
  indexEnabled?(): boolean;
  /** A file (absolute) a chat's agent read or wrote: it has seen this version (projectIndexHost.ts observe). */
  indexSeen?(chatId: string, file: string): void;
  /** A project map for a new session's first message (projectIndex.ts projectPrimer), at most `maxTokens`. */
  primer?(chatId: string, text: string, maxTokens: number): Promise<string | undefined>;
  /** A chat's turn ended: index_changes since "last_turn" compares with now. */
  indexTurnEnded?(chatId: string): void;
  /** Whether agents may reach other agents and chats through those tools. "ask" when not given. */
  agentToAgent?(): AgentToAgent;
  /** The level new chats start at, from the user's own settings (never a workspace's). Ask when not given. */
  approvalDefault?(): Exclude<ApprovalLevel, 'full'>;
  /** Full auto's hard limits (fullAutoGuards.ts); on unless the user's own settings say false. */
  fullAutoGuards?(): boolean;
  /** Which models the agent's own records let this account use (Codex's models cache), to keep pickers to them. */
  modelVisibility?(agent: AgentKey): Promise<ModelVisibility | undefined>;
  /** Each agent's last known options and the user's last choices, kept in the user's own storage. */
  defaults?: { get(agent: AgentKey): AgentDefaults | undefined; set(agent: AgentKey, value: AgentDefaults): void };
  /** Remembered "Always allow" answers (permissions.ts), from the user's own storage. */
  permissions?: Permissions;
  /** Seconds before a routine request allows itself once (friedliver.approvals.autoRoutineSeconds); 0 or absent: never. */
  autoRoutineSeconds?(): number;
  /** Where agents start when no folder is open: an empty folder of FriedLiver's, so they don't scan home (and macOS doesn't ask for Desktop, Documents, Downloads). */
  noFolderCwd?: string;
  /** Starts a new chat's agent and session at once, before its first message. On unless false. */
  warmStart?: boolean;
  /** The shared rules for a new session (sharedRules.ts loadRules); none when absent. */
  sharedRules?(agent?: AgentKey): Promise<Rules | undefined>;
  /** Appends to the project's memory for the remember tool; absent without a trusted folder. */
  remember?(fact: string): Promise<string>;
  ui: CoreUi;
  log?(line: string): void;
  /** Where checkpoints are kept across windows (global storage); folders outside git need it. */
  checkpointDir?: string;
  /** A private folder for commands' whole output when an agent got it cut (terminals.ts compactOutput). */
  outputDir?: string;
}

/**
 * Where a request came from: the desktop, or a phone paired with FriedLiver Remote (by its name).
 * A phone's request that loosens review or keeps allowing waits for the user's OK on the Mac.
 */
export type Via = 'desktop' | { device: string; valid?(): boolean };

/** Rewind to a message: its files, the conversation, or both. */
export type RewindMode = 'both' | 'code' | 'conversation';

export interface AccountStatus {
  status: 'signed-in' | 'needs-sign-in' | 'not-installed' | 'error';
  methods: ReturnType<typeof signInMethods>;
  message?: string;
  installCommand?: string;
  /** The adapter's version, and what to do when it is too old to have model, effort or plan options. */
  version?: string;
  update?: string;
  /** The agent signs out itself (ACP `logout`). */
  logout?: boolean;
}

/** Extras for a message sent from the editor (src/host/editor.ts). */
export interface SendOptions {
  /** Code the message is about, shown as chips with the message. */
  refs?: CodeRef[];
  /** Text the agent gets in front of the message but the chat doesn't show: the file, the selection, a diff. */
  context?: string;
  /** Names the chat after this rather than its first message. */
  title?: string;
}

type Pending<T> = { chatId?: string; resolve(value: T): void };
type Queued = QueuedMessage & { attachments: Attachment[]; options: SendOptions; done(): void; failed(err: unknown): void };
/** A tool call as the agent last described it, before compaction, while it is open. */
type OpenTool = Partial<Pick<acp.ToolCall, 'title' | 'kind' | 'status' | 'content' | 'locations' | 'rawInput'>>;
type TaskWorktree = git.Worktree & { repo: string; title: string };

/**
 * FriedLiver's agent features without the editor: chats on the app's
 * AgentHub, every write held for review, every command held for approval,
 * undo through TurnLog, tasks in their own git worktrees, chats connected to
 * each other (connections.ts), and the FriedLiver tools agents use to reach
 * other agents with the user's OK (bridgeRequests.ts).
 */
export class AgentCore {
  private state: AppState = EMPTY_STATE;
  private readonly listeners = new Set<(action: Action, state: AppState) => void>();
  private readonly hub: AgentHub;
  private readonly turns = new TurnLog();
  /** Files each chat downloaded or wrote lately: running one asks even on Full auto. */
  private readonly trail = new FileTrail();
  /** `careful`: once only, so the agent's own "don't ask again" is refused for it too. */
  private readonly permissions = new Map<string, Pending<acp.RequestPermissionResponse> & { options: acp.PermissionOption[]; careful?: boolean }>();
  /** Routine requests counting down to allow themselves, by request or command id. */
  private readonly autoTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reviews = new Map<string, PendingReview & Pending<{ accept: boolean; content?: string }>>();
  private readonly commands = new Map<string, Pending<boolean>>();
  private readonly questions = new Map<string, Pending<acp.CreateElicitationResponse> & { fields: QuestionField[] }>();
  private readonly worktrees = new Map<string, TaskWorktree>();
  private readonly lastPrompt = new Map<string, acp.ContentBlock[]>();
  private readonly chatCount: Partial<Record<AgentKey, number>> = {};
  private readonly signingIn = new Set<AgentKey>();
  private readonly output = new Map<string, string>();
  /** Hand-off context waiting for the chat's first message. */
  private readonly preambles = new Map<string, string>();
  /** Chats whose Stop came while their turn was still on its way to the agent. */
  private readonly stopping = new Set<string>();
  private readonly checkpoints: Checkpoints;
  private readonly checkpointsLoaded: Promise<void>;
  private readonly rewinding = new Set<string>();
  /** Settings the user chose in each chat (optionKey → value), applied again when its agent restarts. */
  private readonly chosen = new Map<string, Record<string, string | boolean>>();
  /** Chats where the user confirmed Full auto once. */
  private readonly confirmedFull = new Set<string>();
  private readonly queues = new Map<string, Queued[]>();
  private readonly openTools = new Map<string, Map<string, OpenTool>>();
  /** Bytes of shared rules each chat's session got, so the project map fits beside them. */
  private readonly rulesBytes = new Map<string, number>();
  /** Chats offered /compact on this climb toward a full context. */
  private readonly compactOffered = new Set<string>();
  /** What a permission request would write, for "Open diff", by request. */
  private readonly proposals = new Map<string, Proposal[]>();
  /** Content the user approved on a permission card that showed its diff: the write that follows isn't asked again. */
  private readonly approvedWrites = new Map<string, Map<string, string>>();
  /** Accept all / Reject all: the rest of the turn's edits go the same way. */
  private readonly turnDecision = new Map<string, 'accept' | 'reject'>();
  /** Files each chat's running turn said it touches, for checkpoints shared with another chat. */
  private readonly reported = new Map<string, Set<string>>();
  /** New tasks whose first message is on its way: their turn, not the warm start, reports a failure to start. */
  private readonly turnComing = new Set<string>();
  private readonly links: Connections;
  /** /discuss (discuss.ts); chats taking part in one are read-only (`discussing`) until it ends. */
  readonly discussions: Discussions;
  /** Discussions each chat is in now: read-only while above 0. */
  private readonly discussing = new Map<string, number>();
  /** A discussing chat's mode before it went read-only, put back after. */
  private readonly modeBefore = new Map<string, string>();
  private readonly requests: BridgeRequests;
  private bridge?: BridgeServer;
  private bridgeStarting?: Promise<void>;
  private outputTimer?: ReturnType<typeof setTimeout>;
  private nextId = 1;

  constructor(private readonly options: CoreOptions) {
    const limits = options.limits();
    this.checkpoints = new Checkpoints({
      log: options.log,
      dir: options.checkpointDir,
      onGone: (chatId, turnIds) => {
        // A rewind says itself what went, after it has used the messages' checkpoints.
        if (this.chat(chatId) && !this.rewinding.has(chatId)) this.dispatch({ t: 'checkpointsGone', chatId, turnIds });
      },
    });
    this.checkpointsLoaded = this.checkpoints.load().catch((err: unknown) => options.log?.(`Couldn't load checkpoints: ${messageOf(err)}`));
    this.hub = new AgentHub({
      cwd: options.folders()[0] ?? options.noFolderCwd ?? os.homedir(),
      clientVersion: options.clientVersion,
      resolveSpec: (id) => this.spec(id),
      idleStopMs: limits.idleStopMinutes * 60_000,
      maxRunning: limits.maxRunning,
      log: options.log,
      events: {
        update: (chatId, update) => {
          this.noteTool(chatId, update);
          this.dispatch({ t: 'update', chatId, update: compactUpdate(update), at: Date.now() });
          if (update.sessionUpdate === 'available_commands_update') this.updateKnown(chatId);
          if (update.sessionUpdate === 'usage_update') this.checkContext(chatId, Number(update.used), Number(update.size));
          this.collectImages(chatId, update);
        },
        session: (chatId, start) => this.sessionStarted(chatId, start),
        notice: (chatId, text) => this.items(chatId, [{ kind: 'notice', text, tone: 'info' }]),
        agentsChanged: () => {},
        authStatus: (agentId, identity) => options.accountSeen?.(agentId, { identity }),
        agentStderr: (agentId, line) => {
          if (!this.signingIn.has(agentId)) return;
          for (const url of line.match(/https:\/\/[^\s"'<>)]+/g) ?? []) {
            if (allowedSignInUrl(agentId, url)) options.ui.signInUrl?.(agentId, url);
          }
        },
        permission: (chatId, req, signal) => this.askPermission(chatId, req, signal),
        elicit: (chatId, req, signal) => this.askQuestion(chatId, req, signal),
      },
      files: {
        read: (req, chatId) => this.readForAgent(req, chatId),
        write: (chatId, req) => this.reviewWrite(chatId, req),
      },
      terminalListener: (agentId) => this.commandHooks(agentId),
      mcpServersFor: (chatId, agent) => this.mcpServersFor(chatId, agent.http),
      rulesFor: (chatId) => this.rulesFor(chatId),
      // The map shares the rules' cap: rules first, the map gets what is left (~4 bytes a token), at most PRIMER_TOKENS.
      // The map tells the agent to use the index_* tools: only for a session that is offered them.
      primerFor: async (chatId, _agent, text) =>
        !this.toolsOffered(chatId) ? undefined : this.options.primer?.(chatId, text, Math.min(PRIMER_TOKENS, Math.floor((RULES_CAP - (this.rulesBytes.get(chatId) ?? 0)) / 4))),
      freshSessionFor: (chatId) => this.readOnlyChat(chatId),
      sessionMetaFor: (chatId, agentId) => (this.readOnlyChat(chatId) && agentId === 'claude' ? CLAUDE_READ_ONLY_META : undefined),
      // Per turn, not only per mode: an adapter that can hold itself read only (Antigravity's talk only) does for this turn.
      promptMetaFor: (chatId) => (this.mustStayReadOnly(chatId) ? READ_ONLY_PROMPT_META : undefined),
    });
    // The connections read the live state, not the one at construction.
    const live = () => this.state;
    this.links = new Connections({
      get state() {
        return live();
      },
      dispatch: (action) => this.dispatch(action),
      id: (prefix) => this.id(prefix),
      createChat: (agent, opts) => this.createChat(agent, opts),
      prompt: (chatId, blocks) => this.promptBlocks(chatId, blocks),
      preamble: (chatId, text) => this.preambles.set(chatId, text),
    });
    this.discussions = new Discussions({
      get state() {
        return live();
      },
      dispatch: (action) => this.dispatch(action),
      id: (prefix) => this.id(prefix),
      settings: () => this.options.discussSettings?.() ?? {},
      participant: async (sourceId, agent, model, taken = []) => {
        const source = this.requireChat(sourceId);
        // The newest chat this one consults with the agent, on the model when one is named, that no other participant has.
        const known = live()
          .links.filter((l) => l.kind === 'consult' && l.from === sourceId)
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((l) => this.chat(l.to))
          .find((c) => c && c.agent === agent && !c.archived && !taken.includes(c.id) && (!model || sameModel(currentModel(c.session) ?? this.chosen.get(c.id)?.model?.toString(), model)));
        if (known) return known.id;
        const chat = await this.createChat(agent, {
          shareWorktreeOf: sourceId,
          title: 'Discussion',
          origin: { kind: 'consult', chatId: sourceId, by: 'user' },
          depth: source.depth + 1,
          ...(model ? { choices: { model } } : {}),
        });
        return chat.id;
      },
      models: (agent) => modelCatalog(this.agentDefaults(), live().chats)[agent] ?? [],
      prompt: (chatId, text) => {
        const chat = this.requireChat(chatId);
        // What the agent was given, so its reply is read from here on (folded into the card in the chat).
        this.items(chatId, [{ kind: 'link', linkId: 'discussion', role: 'piped-in', chatId, agent: chat.agent, label: 'Discussion', text, by: 'user' }]);
        return this.promptBlocks(chatId, [{ type: 'text', text }]);
      },
      ask: (sourceId, chatId, agent, text) => this.links.consult(sourceId, agent, text, 'user', { chatId }),
      cancel: (chatId) => this.cancel(chatId),
      guard: (chatId, on) => this.guardDiscussion(chatId, on),
      send: (chatId, text) => this.send(chatId, text),
      message: (from, to, text) => this.links.message(from, to, text, 'user'),
    });
    this.requests = new BridgeRequests({
      get state() {
        return live();
      },
      policy: () => this.policy(),
      dispatch: (action) => this.dispatch(action),
      id: (prefix) => this.id(prefix),
      notify: (ask) => options.ui.askBridge?.(ask),
      consultation: (chatId, agent) => this.links.consultation(chatId, agent),
      consult: (chatId, agent, text, targetChatId, started) => this.links.consult(chatId, agent, text, 'agent', { chatId: targetChatId, started }),
      message: (chatId, target, text) => void this.links.message(chatId, target, text, 'agent').catch(() => {}),
      cancel: (chatId) => this.cancel(chatId),
      browser: options.browser,
      externalAutoApprove: options.externalAutoApprove,
      fullAutoGuards: options.fullAutoGuards,
      downloaded: (chatId, file) => this.trail.add(chatId, file),
      autoAllowLinkedReads: options.autoAllowLinkedReads,
      browserPage: options.browserPage,
      index: options.index,
      system: options.system,
      get remember() {
        return options.remember;
      },
      permissions: options.permissions,
    });
  }

  get snapshot(): AppState {
    return this.state;
  }

  onAction(listener: (action: Action, state: AppState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  decisions(): Decision[] {
    return decisions(this.state);
  }

  chat(chatId: string): ChatView | undefined {
    return this.state.chats.find((c) => c.id === chatId);
  }

  review(reviewId: string): PendingReview | undefined {
    return this.reviews.get(reviewId);
  }

  pendingReviews(): PendingReview[] {
    return [...this.reviews.values()];
  }

  /** Workspace folders and task worktrees: the only places agents may read or write. */
  roots(): string[] {
    return [...new Set([...this.options.folders(), ...[...this.worktrees.values()].map((w) => w.path)])];
  }

  /** The agent's command, with the user's settings and that agent's own API key applied. */
  spec(id: AgentKey): AgentSpec {
    if (id === 'demo') {
      if (!testAgentsOn()) throw new Error('The Demo agent was removed.');
      return { ...demoAgentSpec(this.options.demoAgentScript), label: 'Demo' };
    }
    const base = DEFAULT_AGENTS[id];
    const { command, args } = this.options.agentCommand(id);
    const key = this.options.apiKey(id);
    const keyEnv = KEY_ENV[id];
    const spec: AgentSpec = {
      ...base,
      label: AGENT_FACES[id].name,
      command: command.trim() || base.command,
      args,
      env: { ...base.env, ...(key && keyEnv ? { [keyEnv]: key } : {}), ...this.options.credentialEnv?.(id) },
    };
    const adapter = this.options.agyAdapterScript;
    if (id !== 'antigravity' || !adapter) return spec;
    // agy itself when it isn't installed, so starting it fails as "not installed" naming agy.
    const agy = findProgram(spec.command);
    if (!agy) return { ...spec, args: [] };
    return {
      ...spec,
      command: process.execPath,
      args: [adapter],
      env: { ...spec.env, ELECTRON_RUN_AS_NODE: '1', FRIEDLIVER_AGY: agy, FRIEDLIVER_AGY_ARGS: JSON.stringify(args) },
    };
  }

  /** New settings: limits apply at once, and agents whose command or key changed restart on next use. */
  async reconfigure(restart: AgentKey[]): Promise<void> {
    const limits = this.options.limits();
    this.hub.configure({ idleStopMs: limits.idleStopMinutes * 60_000, maxRunning: limits.maxRunning });
    await Promise.all(restart.map((id) => this.hub.stopAgent(id)));
  }

  async createChat(agent: AgentKey, options: NewChat = {}): Promise<ChatView> {
    const folder = this.options.folders()[0];
    if (!folder) throw new Error('Open a folder first. Agents work inside the folder you open.');
    const shared = options.shareWorktreeOf ? this.chat(options.shareWorktreeOf) : undefined;
    const resumeCwd = options.resume && this.options.folders().includes(options.resume.cwd) ? options.resume.cwd : undefined;
    const chosenCwd = options.cwd && this.options.folders().includes(options.cwd) ? options.cwd : undefined;
    let cwd = shared?.cwd ?? resumeCwd ?? chosenCwd ?? folder;
    let wt = shared && this.worktrees.get(shared.id);
    if (options.worktree && !wt) {
      const repo = await git.repoRoot(folder);
      if (!repo) throw new Error('A separate worktree needs a git repository. Run `git init` and commit once, or untick the option.');
      const title = options.title ?? 'task';
      wt = { ...(await git.createWorktree(repo, options.worktreeName ?? title)), repo, title };
      cwd = wt.path;
    }
    const chat = this.hub.createChat(agent, cwd, options.resume?.sessionId);
    if (wt) this.worktrees.set(chat.id, wt);
    if (options.messageFollows) this.turnComing.add(chat.id);
    // Counted still (saved state keeps it), never shown: a chat is named by its topic (names.ts).
    this.chatCount[agent] = (this.chatCount[agent] ?? 0) + 1;
    const name = AGENT_FACES[agent].name;
    const view: ChatView = {
      id: chat.id,
      agent,
      label: name,
      title: options.title ? titleFrom(options.title) : 'New chat',
      cwd,
      branch: wt?.branch,
      createdAt: Date.now(),
      busy: false,
      changedFiles: 0,
      items: options.resume
        ? [{ kind: 'notice', tone: 'info', text: `Continues Claude Code session ${options.resume.sessionId}. Its earlier messages aren't shown here, but ${name} remembers them.` }]
        : [],
      origin: options.origin,
      group: options.group,
      ...(options.readOnly ? { readOnly: true as const } : {}),
      depth: options.depth ?? 0,
      files: [],
      lastActivity: Date.now(),
      turns: 0,
    };
    const level = options.approval ?? this.options.defaults?.get(agent)?.approval ?? this.options.approvalDefault?.() ?? 'ask';
    if (level !== 'ask') view.approval = level;
    if (level === 'full') this.confirmedFull.add(chat.id);
    if (options.choices) this.chosen.set(chat.id, { ...options.choices });
    // Pickers and "/" show the agent's last known options and commands until its session answers.
    const known = this.options.defaults?.get(agent);
    if (known?.options.length || known?.commands?.length) view.session = { ...EMPTY_SESSION, options: known.options, commands: known.commands ?? [], live: false };
    if (this.options.warmStart !== false) view.session = { ...(view.session ?? { ...EMPTY_SESSION, live: false }), starting: true };
    this.dispatch({ t: 'created', chat: view });
    if (this.options.warmStart !== false) void this.warmStart(chat.id);
    return view;
  }

  /**
   * Starts the chat's agent and session now, without a model turn, so its
   * settings show at once and a sign-in problem shows before the first message.
   */
  private async warmStart(chatId: string): Promise<void> {
    try {
      await this.ensureBridge();
      if (this.hub.getChat(chatId)) await this.hub.startSession(chatId);
    } catch (err) {
      const chat = this.chat(chatId);
      // A turn that started meanwhile, or is about to (a new task's first message), reports the same failure itself.
      if (chat && !chat.busy && !this.turnComing.has(chatId)) this.items(chatId, [this.failureNotice(chat.agent, err, chatId)]);
    } finally {
      const session = this.chat(chatId)?.session;
      if (session?.starting) this.dispatch({ t: 'session', chatId, session: { ...session, starting: false } });
    }
  }

  /**
   * Sends a message and resolves when the agent's turn ends. A message that
   * starts with an @mention ("@gemini review this") asks that agent instead.
   */
  async send(chatId: string, text: string, images: Attachment[] = [], options: SendOptions = {}): Promise<void> {
    // During a discussion a message is said in it, heard from the next turn on.
    if (this.discussions.runningIn(chatId)) return this.discussions.interject(chatId, text);
    const mention = parseMention(text);
    if (mention) {
      await this.consult(chatId, mention.agent, options.context ? `${mention.text}\n\n${options.context}` : mention.text, 'user', images);
      return;
    }
    await this.sendMessage(chatId, text, images, options);
  }

  /** The chat is named after your latest real request; the first message names it even when it is only "hi". */
  private retitle(chat: ChatView, text: string): void {
    const topic = topicTitle(text);
    if (topic) this.dispatch({ t: 'title', chatId: chat.id, title: topic });
    else if (!chat.items.some((i) => i.kind === 'user' || i.kind === 'link') && text.trim()) this.dispatch({ t: 'title', chatId: chat.id, title: titleFrom(text) });
  }

  star(chatId: string, starred: boolean): void {
    this.dispatch({ t: 'star', chatId, starred });
  }

  /** A name you gave: the title stops following the conversation. */
  renameChat(chatId: string, title: string): void {
    const name = title.trim();
    if (name) this.dispatch({ t: 'title', chatId, title: titleFrom(name), pinned: true });
  }

  private async sendMessage(chatId: string, text: string, images: Attachment[] = [], options: SendOptions = {}): Promise<void> {
    const chat = this.requireChat(chatId);
    if (chat.busy) return this.enqueue(chatId, text, images, options);
    const ids: string[] = [];
    for (const img of images) {
      const src = imageDataUri(img.mimeType, img.data);
      if (!src) throw new Error(`${img.name || 'An attachment'} is not an image FriedLiver can send.`);
      const id = this.id('you');
      ids.push(id);
      this.addImage(id, src, img.name || 'Attached image', 'you', { chatId });
    }
    if (options.title) this.dispatch({ t: 'title', chatId, title: titleFrom(options.title) });
    else this.retitle(chat, text);
    this.items(chatId, [{ kind: 'user', text, images: ids, ...(options.refs?.length ? { refs: options.refs } : {}) }]);
    const blocks: acp.ContentBlock[] = [];
    if (options.context) blocks.push({ type: 'text', text: options.context });
    if (text) blocks.push({ type: 'text', text });
    for (const img of images) blocks.push({ type: 'image', data: img.data, mimeType: img.mimeType });
    blocks.push(...this.fileLinks(chat.cwd, text));
    await this.promptBlocks(chatId, blocks);
  }

  /**
   * Files named with "#path" in a message, as ACP resource links, so the agent
   * gets them as files and not only as words. Only files inside the workspace;
   * the text keeps the names for agents that ignore links.
   */
  private fileLinks(cwd: string, text: string): acp.ContentBlock[] {
    const out: acp.ContentBlock[] = [];
    const seen = new Set<string>();
    for (const m of text.matchAll(/(?:^|\s)#([\w./@+-]+[\w/])/g)) {
      const file = insideRoots(path.resolve(cwd, m[1]), this.roots());
      if (!file || seen.has(file) || !existsSync(file) || out.length >= 10) continue;
      seen.add(file);
      out.push({ type: 'resource_link', uri: pathToFileURL(file).href, name: path.basename(file) });
    }
    return out;
  }

  /** A message for a busy chat waits in its queue and goes when the turn ends; resolves when its own turn ends. */
  private enqueue(chatId: string, text: string, images: Attachment[], options: SendOptions): Promise<void> {
    const queue = this.queues.get(chatId) ?? [];
    if (queue.length >= MAX_QUEUE) throw new Error(`${MAX_QUEUE} messages are already waiting for this chat.`);
    for (const img of images) if (!imageDataUri(img.mimeType, img.data)) throw new Error(`${img.name || 'An attachment'} is not an image FriedLiver can send.`);
    return new Promise<void>((resolve, reject) => {
      queue.push({ id: this.id('queued'), text, images: images.length, ...(options.refs?.length ? { refs: options.refs.length } : {}), attachments: images, options, done: resolve, failed: reject });
      this.queues.set(chatId, queue);
      this.publishQueue(chatId);
    });
  }

  private publishQueue(chatId: string): void {
    const queue = this.queues.get(chatId) ?? [];
    if (!queue.length) this.queues.delete(chatId);
    this.dispatch({ t: 'queue', chatId, queue: queue.map(({ id, text, images, refs }) => ({ id, text, images, ...(refs ? { refs } : {}) })) });
  }

  /** Drops a queued message; its sender hears it was not sent. */
  unqueue(chatId: string, id: string): void {
    const queue = this.queues.get(chatId) ?? [];
    const at = queue.findIndex((q) => q.id === id);
    if (at < 0) return;
    const [item] = queue.splice(at, 1);
    this.publishQueue(chatId);
    item.done();
  }

  /**
   * Sends a queued message now: into the running turn when the agent takes
   * that (steering), or as the next turn when the chat is idle.
   */
  async sendNow(chatId: string, id: string): Promise<void> {
    const queue = this.queues.get(chatId) ?? [];
    const item = queue.find((q) => q.id === id);
    if (!item) return;
    const chat = this.requireChat(chatId);
    if (chat.busy) {
      const blocks: acp.ContentBlock[] = [
        ...(item.options.context ? [{ type: 'text' as const, text: item.options.context }] : []),
        ...(item.text ? [{ type: 'text' as const, text: item.text }] : []),
        ...item.attachments.map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType })),
      ];
      if (!chat.session?.steering) {
        this.items(chatId, [{ kind: 'notice', tone: 'info', text: `${chat.label} can't take a message while it works, so this one waits for the turn to end.` }]);
        return;
      }
      // False while the turn is still on its way to the agent: the message keeps its place and goes after it.
      if (!(await this.hub.steer(chatId, blocks).catch(() => false))) return;
      queue.splice(queue.indexOf(item), 1);
      this.publishQueue(chatId);
      this.items(chatId, [{ kind: 'user', text: item.text, images: [], ...(item.options.refs?.length ? { refs: item.options.refs } : {}) }]);
      item.done();
      return;
    }
    queue.splice(queue.indexOf(item), 1);
    this.publishQueue(chatId);
    await this.sendMessage(chatId, item.text, item.attachments, item.options).then(item.done, item.failed);
  }

  /** The next queued message, once a turn ended normally. */
  private drainQueue(chatId: string): void {
    const queue = this.queues.get(chatId);
    const next = queue?.shift();
    if (!next) return;
    this.publishQueue(chatId);
    void this.sendMessage(chatId, next.text, next.attachments, next.options).then(next.done, next.failed);
  }

  // ---- Session settings and approvals ----

  /** Each agent's last known options and the user's last choices, for new chats and new tasks. */
  agentDefaults(): Partial<Record<AgentKey, AgentDefaults>> {
    const out: Partial<Record<AgentKey, AgentDefaults>> = {};
    for (const agent of Object.keys(AGENT_FACES) as AgentKey[]) {
      const d = this.options.defaults?.get(agent);
      if (d) out[agent] = d;
    }
    return out;
  }

  /**
   * Sets one of the chat's session settings to a value its agent offers. A
   * mode that runs without asking (bypass, full access) counts as Full auto and
   * asks once. Without a live session the choice waits for the next one.
   */
  async setOption(chatId: string, optionId: string, value: string | boolean): Promise<void> {
    const chat = this.requireChat(chatId);
    const option = chat.session?.options.find((o) => o.id === optionId);
    if (!option || !offers(option, value)) return;
    if ((option.category === 'mode' || planToggle(chat.session)?.option === option) && this.levelLocked(chatId)) return;
    if (option.category === 'mode' && typeof value === 'string') {
      const level = levelOfMode(chat.agent, option, value);
      if (level === 'full' && !(await this.confirmFull(chat))) return;
      const before = chat.approval ?? 'ask';
      if (!level || level === before) {
        await this.applyOption(chatId, option, value);
        return;
      }
      // The level follows the mode only once the agent took it.
      this.dispatch({ t: 'approval', chatId, level });
      if (await this.applyOption(chatId, option, value)) this.setLevel(chat, level);
      else this.dispatch({ t: 'approval', chatId, level: before });
      return;
    }
    this.remember(chat, option, value);
    await this.applyOption(chatId, option, value);
  }

  /** FriedLiver's approval level for the chat, and the agent's matching mode. */
  async setApproval(chatId: string, level: ApprovalLevel, via: Via = 'desktop'): Promise<void> {
    const chat = this.requireChat(chatId);
    if (this.levelLocked(chatId)) return;
    const before = chat.approval ?? 'ask';
    if (via !== 'desktop') {
      // From a phone: tightening goes ahead; loosening waits for the Mac; nothing becomes a default for new chats.
      if (level === (chat.approval ?? 'ask')) return;
      if (level === 'full' && !(await this.confirmFull(chat, via))) return;
      if (level === 'edits' && !(await this.confirmRemote(via, { title: `Let ${chatRef(chat)} accept edits without asking?`, detail: `${chat.label}'s edits would be written without review until the chat is switched back.`, button: 'Accept edits' }))) return;
      this.dispatch({ t: 'approval', chatId, level });
      if (!(await this.applyLevel(chatId, true))) this.dispatch({ t: 'approval', chatId, level: before });
      return;
    }
    if (level === 'full' && !(await this.confirmFull(chat))) return;
    // Shown at once; back to the old level if the agent refuses the mode for it.
    this.dispatch({ t: 'approval', chatId, level });
    if (await this.applyLevel(chatId, true)) this.setLevel(chat, level);
    else this.dispatch({ t: 'approval', chatId, level: before });
  }

  /** Plan mode on or off: a Plan entry in the agent's modes, or Codex's collaboration mode. */
  async setPlan(chatId: string, on: boolean): Promise<void> {
    const chat = this.requireChat(chatId);
    if (this.levelLocked(chatId)) return;
    const plan = planToggle(chat.session);
    if (!plan) return;
    const off = plan.option.category === 'mode' ? modeFor(chat.agent, plan.option, chat.approval ?? 'ask') : plan.off;
    const value = on ? plan.on : off;
    if (value !== undefined && value !== plan.option.current) await this.applyOption(chatId, plan.option, value, { by: 'user' });
  }

  private setLevel(chat: ChatView, level: ApprovalLevel): void {
    this.dispatch({ t: 'approval', chatId: chat.id, level });
    if (level !== 'full') this.saveDefaults(chat.agent, { approval: level });
  }

  private async confirmFull(chat: ChatView, via: Via = 'desktop'): Promise<boolean> {
    if (via !== 'desktop') {
      // Every time from the phone, whatever the desktop confirmed before.
      const ok = await this.confirmRemote(via, { title: `Run ${chatRef(chat)} in Auto?`, detail: `${chat.label} would edit and run commands without asking until the chat is switched back.`, button: 'Use Auto' });
      if (ok) this.confirmedFull.add(chat.id);
      return ok;
    }
    if (this.confirmedFull.has(chat.id)) return true;
    const mode = modeFor(chat.agent, modeOption(chat.session), 'full');
    const name = modeOption(chat.session)?.choices.find((c) => c.value === mode)?.name;
    if (!(await this.options.ui.confirmFullAuto?.({ label: `the chat ${chatRef(chat)}`, agent: this.label(chat.agent), mode: name }))) return false;
    this.confirmedFull.add(chat.id);
    return true;
  }

  /**
   * Remembers a choice (model, effort…) for this chat, and its next sessions. Not for the agent's other chats:
   * only the Accounts page sets those (setDefaultChoice), so trying max effort in one chat doesn't make every
   * new chat, inline edit and consultation use it.
   */
  private remember(chat: ChatView, option: SessionOption, value: string | boolean): void {
    const key = optionKey(option);
    this.chosen.set(chat.id, { ...this.chosen.get(chat.id), [key]: value });
  }

  private saveDefaults(agent: AgentKey, patch: Partial<AgentDefaults>): void {
    const store = this.options.defaults;
    if (!store) return;
    const d = store.get(agent) ?? { options: [], chosen: {} };
    store.set(agent, { ...d, ...patch });
  }

  /**
   * Sends one setting to the agent the way it takes it, and shows the agent's
   * answer. True when the agent took it. A refusal is always logged; it shows
   * in the chat only for a change the user made just now (`by: 'user'`), never
   * for one FriedLiver makes itself when a session starts.
   */
  private async applyOption(chatId: string, option: SessionOption, value: string | boolean, { by = 'user' }: { by?: 'user' | 'auto' } = {}): Promise<boolean> {
    const show = (session: ChatSession | undefined) => this.dispatch({ t: 'session', chatId, session });
    const local = (s: ChatSession | undefined) => s && { ...s, options: s.options.map((o) => (o.id === option.id ? { ...o, current: value } : o)) };
    if (!this.hub.hasSession(chatId)) {
      // Applied when the session starts: the mode through the approval level, the rest as chosen.
      show(local(this.chat(chatId)?.session));
      return true;
    }
    try {
      if (option.via === 'mode') {
        await this.hub.setMode(chatId, String(value));
        show(local(this.chat(chatId)?.session));
      } else if (option.via === 'model') {
        await this.hub.setModel(chatId, String(value));
        show(local(this.chat(chatId)?.session));
      } else {
        const list = await this.hub.setConfigOption(chatId, option.id, value);
        const prev = this.chat(chatId)?.session ?? EMPTY_SESSION;
        const fresh = withoutModels(sessionOptions({ configOptions: list }), prev.hiddenModels);
        show({ ...prev, options: [...prev.options.filter((o) => o.via !== 'option' && !fresh.some((n) => n.category === o.category)), ...fresh] });
      }
      this.updateKnown(chatId);
      return true;
    } catch (err) {
      if (err instanceof NoSessionError) return true;
      const chat = this.chat(chatId);
      const agent = chat ? this.label(chat.agent) : 'The agent';
      const to = typeof value === 'string' ? choiceName(option, value) : value ? 'on' : 'off';
      this.options.log?.(`${agent} refused ${option.name} = ${String(value)} in chat ${chatId} (${by === 'user' ? 'the user chose it' : 'set by FriedLiver'}): ${messageOf(err)}`);
      const why = messageOf(err);
      // Gemini keeps its privileged modes for folders the user trusted in Gemini itself.
      const detail = chat?.agent === 'gemini' && /untrusted folder/i.test(why) ? "Trust this folder in Gemini: run `gemini` in it and choose to trust it, then pick the level again." : undefined;
      if (by === 'user') this.items(chatId, [{ kind: 'notice', tone: 'error', text: `${agent} didn't change ${option.name} to ${to}: ${why}`, ...(detail ? { detail } : {}) }]);
      return false;
    }
  }

  /**
   * Puts the agent in the mode for the chat's level. Leaves Plan mode alone unless the user chose a level just now.
   * False when the agent refused the mode. When a session starts the agent may keep its own mode (e.g. Gemini
   * refuses Auto Edit in a folder it doesn't trust): FriedLiver's level still decides what it answers for the agent.
   */
  private async applyLevel(chatId: string, chosenNow: boolean): Promise<boolean> {
    const chat = this.chat(chatId);
    const mode = modeOption(chat?.session);
    if (!chat || !mode || (!chosenNow && planning(chat.session) && planToggle(chat.session)?.option === mode)) return true;
    const want = modeFor(chat.agent, mode, chat.approval ?? 'ask');
    if (want === undefined || want === mode.current) return true;
    return this.applyOption(chatId, mode, want, { by: chosenNow ? 'user' : 'auto' });
  }

  /** The agent's options and commands, kept as its defaults for the next chat's pickers and "/" menu. */
  private updateKnown(chatId: string): void {
    const chat = this.chat(chatId);
    if (chat?.session?.live) this.saveDefaults(chat.agent, { options: chat.session.options.filter((o) => o.category !== 'mode'), commands: chat.session.commands });
  }

  /**
   * A session started or came back: show what it offers, then apply the chat's
   * choices (or, for a new chat, the user's last choices for this agent), then
   * the mode for its approval level. FriedLiver decides the mode, so Codex's
   * "Auto review" default or a user's ~/.claude defaultMode doesn't carry over.
   */
  private async sessionStarted(chatId: string, start: SessionStart): Promise<void> {
    const chat = this.chat(chatId);
    if (!chat) return;
    const offered = sessionOptions(start);
    const hidden = hiddenModels(start, offered, await this.options.modelVisibility?.(chat.agent).catch(() => undefined));
    // Read after the await: commands or usage the agent sent meanwhile stay.
    const prev = this.chat(chatId)?.session;
    const session: ChatSession = {
      options: withoutModels(offered, hidden),
      ...(hidden.length ? { hiddenModels: hidden } : {}),
      // Commands may arrive before the session's answer; the agent sends a fresh list soon anyway.
      commands: prev?.commands ?? [],
      ...(prev?.usage && start.loaded ? { usage: prev.usage } : {}),
      steering: start.steering || undefined,
      live: true,
      ...(start.agentInfo ? { agent: start.agentInfo } : {}),
      ...(start.loaded ? (prev?.rules ? { rules: prev.rules } : {}) : start.rules ? { rules: start.rules } : {}),
    };
    this.dispatch({ t: 'session', chatId, session });
    this.options.accountSeen?.(chat.agent, { status: 'signed-in', ...this.versionOf(chat.agent, start.agentInfo) });
    const wanted = start.loaded ? { ...this.chosen.get(chatId) } : { ...defaultChoices(this.options.defaults?.get(chat.agent)), ...this.chosen.get(chatId) };
    // The model first: it decides which effort levels there are.
    const keys = Object.keys(wanted).sort((a, b) => (a === 'model' ? -1 : b === 'model' ? 1 : 0));
    for (const key of keys) {
      const option = this.chat(chatId)?.session?.options.find((o) => optionKey(o) === key);
      const value = wanted[key];
      if (option && option.category !== 'mode' && offers(option, value) && option.current !== value) await this.applyOption(chatId, option, value, { by: 'auto' });
    }
    if (chat.readOnly || this.discussing.has(chatId)) await this.restrictMode(chatId);
    else await this.applyLevel(chatId, false);
    this.updateKnown(chatId);
  }

  /** A read-only chat: the agent's own most restrictive mode too, so its built-in tools can't act either. */
  private async restrictMode(chatId: string): Promise<void> {
    const pick = readOnlyChoice(this.chat(chatId)?.session?.options ?? []);
    if (!pick) {
      this.options.log?.(`Read-only chat ${chatId}: the agent offers no plan or read-only mode; FriedLiver's refusals still apply.`);
      return;
    }
    if (pick.option.current !== pick.value) await this.applyOption(chatId, pick.option, pick.value, { by: 'auto' });
  }

  /** Runs the last message again, or, when the chat has none yet, starts its agent again. */
  async retry(chatId: string): Promise<void> {
    const blocks = this.lastPrompt.get(chatId);
    const chat = this.requireChat(chatId);
    if (chat.busy) return;
    if (blocks) {
      await this.runPrompt(chatId, blocks);
      return;
    }
    if (chat.session?.live) return;
    this.dispatch({ t: 'session', chatId, session: { ...(chat.session ?? { ...EMPTY_SESSION, live: false }), starting: true } });
    await this.warmStart(chatId);
  }

  /** Stops the chat's turn, and the consultations its agent is waiting on through the FriedLiver tools. */
  async cancel(chatId: string): Promise<void> {
    if (this.chat(chatId)?.busy) this.stopping.add(chatId);
    this.settleChat(chatId);
    if (this.hub.getChat(chatId)) await this.hub.cancel(chatId);
  }

  // ---- Connections between chats ----

  /** Continues the chat with another agent: in the chat it handed off to before, or a new one (`fresh`). Where the task is goes in front of the next message there. */
  handoff(chatId: string, agent: AgentKey, fresh = false): Promise<ChatView> {
    return this.links.handoff(chatId, agent, fresh);
  }

  /** Asks another agent from this chat. Resolves with the answer, which also shows in this chat. */
  async consult(chatId: string, agent: AgentKey, text: string, by: 'user' | 'agent' = 'user', images: Attachment[] = [], fresh = false): Promise<string> {
    const srcs = images.map((img) => imageDataUri(img.mimeType, img.data));
    const bad = images.find((_, n) => !srcs[n]);
    if (bad) throw new Error(`${bad.name || 'An attachment'} is not an image FriedLiver can send.`);
    // Shown like any attachment; an agent that can't take images gets the text and says so in its chat.
    images.forEach((img, n) => this.addImage(this.id('you'), srcs[n]!, img.name || 'Attached image', 'you', { chatId }));
    // A chat whose first message is a question for another agent is about that question. Later ones don't
    // rename it: a consultation is a side question, not the chat's request (retitle follows only real requests).
    const chat = this.requireChat(chatId);
    if (by === 'user' && !chat.titlePinned && !chat.items.some((i) => i.kind === 'user' || i.kind === 'link')) this.retitle(chat, text);
    return this.links.consult(chatId, agent, text, by, { images, fresh });
  }

  /** /discuss: this chat's agent and `who` (agents, or agents on models) talk `question` through; resolves with the conclusion on the card. */
  discuss(chatId: string, who: (AgentKey | Who)[], question: string): Promise<void> {
    this.retitle(this.requireChat(chatId), question);
    return this.discussions.start(chatId, who, question);
  }

  /**
   * Read-only for a chat in a discussion: FriedLiver refuses writes, commands and acting tools, and the agent goes
   * to its read-only mode. Counted per chat, so a chat in two discussions stays read-only until both have ended;
   * the mode is saved on the first and put back on the last. An extra "off" does nothing.
   */
  private async guardDiscussion(chatId: string, on: boolean): Promise<void> {
    const n = this.discussing.get(chatId) ?? 0;
    if (on) {
      this.discussing.set(chatId, n + 1);
      if (n === 0) {
        const mode = modeOption(this.chat(chatId)?.session);
        if (mode && typeof mode.current === 'string') this.modeBefore.set(chatId, mode.current);
      }
      await this.restrictMode(chatId);
      return;
    }
    if (n === 0) return;
    if (n > 1) {
      this.discussing.set(chatId, n - 1);
      return;
    }
    this.discussing.delete(chatId);
    const before = this.modeBefore.get(chatId);
    this.modeBefore.delete(chatId);
    const mode = modeOption(this.chat(chatId)?.session);
    if (mode && before !== undefined && mode.current !== before) await this.applyOption(chatId, mode, before);
    else if (before === undefined) await this.applyLevel(chatId, true);
  }

  /** The tool's real name, as the agent's adapter reports it (Claude's _meta), on the request or its tool call: never the title. */
  private toolName(chatId: string, call: acp.ToolCallUpdate): string | undefined {
    const own = claudeMeta(call._meta).tool;
    if (own) return own;
    const step = this.chat(chatId)?.items.find((i) => i.kind === 'tool' && i.id === call.toolCallId);
    return step?.kind === 'tool' ? step.tool : undefined;
  }


  /** Forwards each finished turn of `from` to `to` as a message. */
  pipe(from: string, to: string, by: 'user' | 'agent' = 'user'): ChatLink {
    return this.links.pipe(from, to, by);
  }

  unlink(linkId: string): void {
    this.links.unlink(linkId);
  }

  /** Sends `from`'s last reply to `to` as a message and resolves when that turn ends. */
  async forward(from: string, to: string): Promise<void> {
    await this.links.forward(from, to);
  }

  /**
   * The same task on several agents at once, to compare: one chat each, in
   * a group, each in its own worktree when asked. `done` resolves when every
   * turn has ended.
   */
  async fanout(
    agents: AgentKey[],
    prompt: string,
    worktree: boolean,
    extras: { choices?: Partial<Record<AgentKey, Record<string, string | boolean>>>; approval?: ApprovalLevel } = {},
  ): Promise<{ group: string; chats: ChatView[]; done: Promise<void> }> {
    const folder = this.options.folders()[0];
    if (!folder) throw new Error('Open a folder first. Agents work inside the folder you open.');
    const group = this.id('group');
    let separate = worktree;
    let shared: string | undefined;
    if (worktree && agents.length > 1 && !(await git.repoRoot(folder))) {
      separate = false;
      shared = "This folder isn't a git repository, so the agents share it instead of each getting a worktree. Watch for edits to the same files.";
    }
    const chats: ChatView[] = [];
    for (const agent of agents) {
      // The agent's name keeps branch names apart when chats start in the same millisecond.
      chats.push(await this.createChat(agent, { worktree: separate, title: prompt, worktreeName: `${agent} ${prompt}`, group, choices: extras.choices?.[agent], approval: extras.approval, messageFollows: true }));
    }
    if (shared) for (const c of chats) this.items(c.id, [{ kind: 'notice', tone: 'info', text: shared }]);
    const done = Promise.all(chats.map((c) => this.sendMessage(c.id, prompt).catch((err: unknown) => this.items(c.id, [this.failureNotice(c.agent, err, c.id)])))).then(() => {});
    return { group, chats: chats.map((c) => this.requireChat(c.id)), done };
  }

  /** Puts a chat away (or back): its history stays, the board and tabs hide it. */
  archive(chatId: string, archived: boolean): void {
    this.requireChat(chatId);
    this.dispatch({ t: 'archive', chatId, archived });
    // An archived chat keeps its history, not its checkpoints.
    if (archived) void this.checkpoints.forget(chatId);
  }

  /** Stops and forgets a chat. A worktree it had stays on disk; only the record goes. */
  async removeChat(chatId: string): Promise<void> {
    this.rulesBytes.delete(chatId);
    this.compactOffered.delete(chatId);
    this.turnComing.delete(chatId);
    const chat = this.chat(chatId);
    if (!chat) return;
    if (chat.busy) await this.cancel(chatId);
    this.settleChat(chatId);
    this.requests.forget(chatId);
    this.links.forget(chatId);
    this.bridge?.revoke(chatId);
    this.worktrees.delete(chatId);
    this.preambles.delete(chatId);
    this.lastPrompt.delete(chatId);
    this.turns.forget(chatId);
    this.trail.forget(chatId);
    void this.checkpoints.forget(chatId);
    for (const q of this.queues.get(chatId) ?? []) q.done();
    for (const map of [this.queues, this.chosen, this.openTools, this.approvedWrites, this.turnDecision, this.reported]) map.delete(chatId);
    this.confirmedFull.delete(chatId);
    this.hub.removeChat(chatId);
    this.dispatch({ t: 'closed', chatId });
  }

  /** The user's answer to an agent's request to reach another agent or chat. */
  answerBridge(requestId: string, answer: BridgeAnswer): void {
    this.requests.answer(requestId, answer);
  }

  /** A FriedLiver tool call made by `chatId`'s agent; the bridge server calls this. */
  /** The FriedLiver tools were turned off: deny every tool request still waiting on the user. */
  toolsOff(): void {
    this.requests.refuseAll();
  }

  /**
   * The URL and this launch's token for clients outside FriedLiver (externalBrowser.ts), minted on
   * first use; undefined when the tools are off or unavailable.
   */
  async externalAccess(): Promise<{ url: string; token: string } | undefined> {
    await this.ensureBridge();
    if (!this.bridge || this.policy() === 'off') return undefined;
    return { url: await this.bridge.httpUrl(), token: this.bridge.token(EXTERNAL_CLIENT) };
  }

  /** The external token stops working and anything it has waiting on the user is denied. */
  revokeExternal(): void {
    this.requests.forgetExternal();
    this.bridge?.revoke(EXTERNAL_CLIENT);
  }

  bridgeCall(chatId: string, call: BridgeCall, signal: AbortSignal): Promise<string> {
    if (this.discussing.has(chatId) && !discussionAllowsBridge(call)) return Promise.reject(new Error(DISCUSS_READ_ONLY));
    return this.requests.call(chatId, call, signal);
  }

  /** Files the chat proposed or made changes to, as absolute paths. */
  touchedFiles(chatId: string): string[] {
    const chat = this.requireChat(chatId);
    return chat.files.map((f) => path.resolve(chat.cwd, f));
  }

  /** A file's content before the chat changed it: null if the chat created it, undefined if unknown. */
  async beforeChat(chatId: string, file: string): Promise<string | null | undefined> {
    const logged = this.turns.firstBefore(chatId, file);
    if (logged !== undefined) return logged;
    const snap = await this.checkpoints.firstBefore(chatId, file);
    return snap === undefined ? undefined : snap === null ? null : snap.toString('utf8');
  }

  // ---- Saving and restoring ----

  /** What a later window needs to bring the chats back. No API keys, no bridge tokens. */
  exportState(): SavedState {
    const chats: SavedState['chats'] = {};
    for (const c of this.state.chats) {
      const wt = this.worktrees.get(c.id);
      chats[c.id] = {
        agent: c.agent,
        cwd: c.cwd,
        sessionId: this.hub.sessionId(c.id),
        worktree: wt && { path: wt.path, branch: wt.branch, repo: wt.repo, title: wt.title },
        preamble: this.preambles.get(c.id),
        choices: this.chosen.get(c.id),
      };
    }
    return { version: 1, state: this.state, chats, nextId: this.nextId, chatCount: { ...this.chatCount } };
  }

  /**
   * Brings back chats saved by an earlier window, before any new ones. What
   * was waiting is closed as stopped; each chat continues in its old session
   * when its agent can reload it.
   */
  restore(saved: SavedState): void {
    if (this.state.chats.length) throw new Error('Chats can only be restored into an empty core.');
    const state = settleRestored(saved.state);
    const chats: ChatView[] = [];
    for (const chat of state.chats) {
      const host = saved.chats[chat.id];
      // Chats with the removed Demo agent are dropped on restore.
      if (!host || (chat.agent === 'demo' && !testAgentsOn())) continue;
      this.hub.restoreChat(chat.id, chat.agent, chat.cwd, host.sessionId);
      let view = chat;
      if (host.worktree && existsSync(host.worktree.path)) {
        this.worktrees.set(chat.id, host.worktree);
      } else if (host.worktree || chat.branch) {
        const gone: Item = { kind: 'notice', tone: 'info', text: "This task's worktree is gone, so the chat has no folder of its own any more." };
        view = { ...chat, branch: undefined, items: [...chat.items, gone] };
      }
      if (host.preamble) this.preambles.set(chat.id, host.preamble);
      if (host.choices) this.chosen.set(chat.id, host.choices);
      chats.push(view);
    }
    this.nextId = Math.max(this.nextId, saved.nextId);
    for (const [agent, n] of Object.entries(saved.chatCount) as [AgentKey, number][]) this.chatCount[agent] = Math.max(this.chatCount[agent] ?? 0, n);
    this.turns.continueAfter(chats.flatMap((c) => c.items.flatMap((i) => (i.kind === 'changes' ? [i.turnId] : i.kind === 'user' && i.checkpoint ? [i.checkpoint] : []))));
    // Messages whose checkpoint is gone (pruned while FriedLiver was closed) lose "Rewind to here".
    void this.checkpointsLoaded.then(() => {
      for (const c of this.state.chats) {
        const gone = c.items.flatMap((i) => (i.kind === 'user' && i.checkpoint && !this.checkpoints.has(c.id, i.checkpoint) ? [i.checkpoint] : []));
        if (gone.length) this.dispatch({ t: 'checkpointsGone', chatId: c.id, turnIds: gone });
      }
    });
    const ids = new Set(chats.map((c) => c.id));
    this.dispatch({ t: 'restore', state: { ...state, chats, links: state.links.filter((l) => ids.has(l.from) && ids.has(l.to)) } });
  }

  answerPermission(requestId: string, optionId: string | null): void {
    const pending = this.permissions.get(requestId);
    // Only an option the agent offered; anything else from a view is ignored.
    if (!pending || (optionId !== null && !pending.options.some((o) => o.optionId === optionId))) return;
    // A careful request is allowed once only: never the agent's "don't ask again" or a mode change.
    const chosen = pending.options.find((o) => o.optionId === optionId);
    if (pending.careful && chosen?.kind.startsWith('allow') && (chosen.kind !== 'allow_once' || ESCALATING.test(chosen.name))) return;
    pending.resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
  }

  /** The user's answer to an agent's form: only values that fit what it asked go back. */
  answerQuestion(requestId: string, action: 'accept' | 'decline', values: Record<string, unknown> = {}): void {
    const pending = this.questions.get(requestId);
    if (!pending) return;
    if (action === 'decline') {
      pending.resolve({ action: 'decline' });
      return;
    }
    const answer = checkAnswer(pending.fields, values);
    if (answer) pending.resolve({ action: 'accept', content: answer });
  }

  /** Accept writes `content` (the proposal as the user left it); reject tells the agent no. */
  decideReview(reviewId: string, accept: boolean, content?: string): void {
    this.reviews.get(reviewId)?.resolve({ accept, content });
  }

  decideCommand(commandId: string, approve: boolean): void {
    this.commands.get(commandId)?.resolve(approve);
  }

  /** Stop: a routine request's countdown ends, and it waits for the user like any other. */
  stopAuto(id: string): void {
    const timer = this.autoTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.autoTimers.delete(id);
    this.dispatch({ t: 'autoOff', id });
  }

  /** When a routine request allows itself, or undefined: off, or not routine. Starts the timer that does it. */
  private autoRoutine(id: string, routine: boolean, run: () => void): number | undefined {
    const seconds = Math.min(60, Math.max(0, Number(this.options.autoRoutineSeconds?.() ?? 0) || 0));
    if (!routine || !seconds) return undefined;
    const timer = setTimeout(() => {
      this.autoTimers.delete(id);
      run();
    }, seconds * 1000);
    timer.unref?.();
    this.autoTimers.set(id, timer);
    return Date.now() + seconds * 1000;
  }

  private endAuto(id: string): boolean {
    const timer = this.autoTimers.get(id);
    clearTimeout(timer);
    return this.autoTimers.delete(id);
  }

  /**
   * A force push: the commits it would drop from the remote branch, as of the last fetch. Git runs before
   * the user says yes, so only in a workspace folder (a trusted one: the extension doesn't run in untrusted
   * workspaces), and with the repository's program-running config off (git.remoteOnlyCommits).
   */
  private async droppedBy(line: string | undefined, cwd: string | undefined): Promise<DroppedCommits | undefined> {
    const push = line ? forcePush(line) : undefined;
    const dir = push && cwd ? insideRoots(cwd, this.roots()) : null;
    const real = dir ? realPath(dir) : null;
    // The workspace root holding it, by its real path: git is pointed at exactly that root's .git folder.
    const root = real ? this.roots().map((r) => realPath(r)).find((r): r is string => !!r && (real === r || real.startsWith(r.endsWith(path.sep) ? r : r + path.sep))) : undefined;
    if (!push || !root) return undefined;
    return (await git.remoteOnlyCommits(root, push.remote, push.dst, push.src ?? 'HEAD').catch(() => null)) ?? undefined;
  }

  /**
   * Restores the files the chat's latest turn changed: from the turn's git
   * checkpoint for files the agent changed itself, and from FriedLiver's own
   * record for the rest. A file changed again since the turn is left alone.
   */
  async undo(chatId: string, turnId: string): Promise<string[]> {
    if (this.requireChat(chatId).busy) throw new Error('Wait for the agent to finish, or stop it, before undoing.');
    if (this.turns.current(chatId) !== turnId) throw new Error('Only the most recent turn can be undone.');
    // Checked again: a symlink may have appeared since the turn wrote these files.
    const snap = await this.checkpoints.undo(chatId, turnId, {
      write: async (f, c) => {
        const file = this.checkWrite(f);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, c);
      },
      remove: (f) => rm(this.checkWrite(f), { force: true }),
    });
    const handled = new Set([...snap.restored, ...snap.kept]);
    const logged =
      this.turns.current(chatId) === turnId
        ? await this.turns.undo(
            chatId,
            turnId,
            { write: (f, c) => writeTextFile(this.checkWrite(f), c), remove: (f) => rm(this.checkWrite(f), { force: true }) },
            (f) => handled.has(f),
          )
        : [];
    const files = [...snap.restored, ...logged];
    this.dispatch({ t: 'undone', chatId, turnId });
    if (snap.kept.length) {
      const names = snap.kept.map((f) => path.basename(f)).join(', ');
      this.items(chatId, [{ kind: 'notice', tone: 'info', text: `Left ${names} as ${snap.kept.length === 1 ? 'it is: it' : 'they are: they'} changed after the turn.` }]);
    }
    for (const f of files) this.options.ui.fileChanged?.(f);
    return files;
  }

  /** The chat's messages that can be rewound to, oldest first. */
  checkpointList(chatId: string): { turnId: string; text: string; at?: number; files: number }[] {
    const kept = new Map(this.checkpoints.list(chatId).map((c) => [c.turnId, c]));
    return this.requireChat(chatId).items.flatMap((i) => {
      const cp = i.kind === 'user' && i.checkpoint ? kept.get(i.checkpoint) : undefined;
      return i.kind === 'user' && cp ? [{ turnId: cp.turnId, text: i.text, at: i.at ?? cp.at, files: cp.files.length }] : [];
    });
  }

  /** What rewinding the code to before `turnId`'s message would change, with paths relative to the chat's folder. */
  async rewindPlan(chatId: string, turnId: string): Promise<RewindPlan> {
    const chat = this.requireChat(chatId);
    const plan = await this.checkpoints.plan(chatId, turnId);
    return { ...plan, files: plan.files.map((f) => ({ ...f, file: relativeFile(chat.cwd, f.file) })) };
  }

  /**
   * Rewinds the chat to before the message that started `turnId`: its files
   * (`code`), its transcript (`conversation`), or both. Files changed since
   * the agent's last turn are kept unless listed in `useCheckpoint` (relative
   * paths from rewindPlan). The agent's session can't be cut back, so a
   * rewound conversation continues in a new session that is given a summary
   * of what's left; the chat says so.
   */
  async rewind(chatId: string, turnId: string, mode: RewindMode, useCheckpoint: string[] = []): Promise<{ restored: string[]; kept: string[] }> {
    const chat = this.requireChat(chatId);
    if (chat.busy) throw new Error('Wait for the agent to finish, or stop it, before rewinding.');
    const at = chat.items.findIndex((i) => i.kind === 'user' && i.checkpoint === turnId);
    const message = chat.items[at];
    if (message?.kind !== 'user') throw new Error('That message has no checkpoint any more.');
    let result = { restored: [] as string[], kept: [] as string[] };
    let gone: string[] = [];
    if (mode !== 'conversation') {
      const chosen = new Set(useCheckpoint.map((f) => path.resolve(chat.cwd, f)));
      // Checked again by checkWrite: a symlink may have appeared since the turn.
      this.rewinding.add(chatId);
      const done = await this.checkpoints
        .rewind(
          chatId,
          turnId,
          {
            write: async (f, c) => {
              const file = this.checkWrite(f);
              await mkdir(path.dirname(file), { recursive: true });
              await writeFile(file, c);
            },
            remove: (f) => rm(this.checkWrite(f), { force: true }),
          },
          (f) => chosen.has(f),
        )
        .finally(() => this.rewinding.delete(chatId));
      gone = done.turnIds;
      result = { restored: done.restored, kept: done.kept };
      // FriedLiver's own record of these turns is stale now.
      this.turns.forget(chatId);
      if (mode === 'code') for (const id of done.turnIds) this.dispatch({ t: 'undone', chatId, turnId: id });
      for (const f of done.restored) this.options.ui.fileChanged?.(f);
    }
    const quote = message.text.length > 60 ? `${message.text.slice(0, 59)}…` : message.text;
    const notes: string[] = [];
    if (mode !== 'conversation') notes.push(`Restored ${result.restored.length} file${result.restored.length === 1 ? '' : 's'} to before “${quote}”.`);
    if (result.kept.length) notes.push(`Kept your changes to ${result.kept.map((f) => relativeFile(chat.cwd, f)).join(', ')}.`);
    if (mode !== 'code') {
      const history = rewoundHistory(chat, chat.items.slice(0, at));
      this.dispatch({ t: 'rewound', chatId, turnId });
      gone = [];
      this.hub.resetSession(chatId);
      this.preambles.delete(chatId);
      if (history) this.preambles.set(chatId, history);
      this.lastPrompt.delete(chatId);
      notes.push(
        `Conversation rewound. ${chat.label} can't cut its session back to a message, so your next message starts a new session${history ? ' that is given a summary of the conversation up to here' : ''}.${mode === 'conversation' ? ' Files were not changed.' : ''}`,
      );
    }
    if (gone.length) this.dispatch({ t: 'checkpointsGone', chatId, turnIds: gone });
    this.items(chatId, [{ kind: 'notice', tone: 'info', text: notes.join(' ') }]);
    return result;
  }

  worktree(chatId: string): TaskWorktree | undefined {
    return this.worktrees.get(chatId);
  }

  /** Commits the task's worktree and merges its branch into the main checkout. */
  async merge(chatId: string): Promise<void> {
    const wt = this.worktrees.get(chatId);
    if (!wt) throw new Error('This task has no worktree.');
    this.requireChat(chatId);
    if (this.sharing(wt).some((id) => this.chat(id)?.busy)) throw new Error('Wait for the agents in this worktree to finish before merging.');
    await git.mergeWorktree(wt.repo, wt, `FriedLiver task: ${wt.title}`);
    for (const id of this.sharing(wt)) this.dispatch({ t: 'worktree', chatId: id, branch: wt.branch, merged: true });
    this.options.ui.fileChanged?.(wt.repo);
  }

  /** Deletes the worktree and its branch, for every chat working in it. */
  async removeWorktree(chatId: string): Promise<void> {
    const wt = this.worktrees.get(chatId);
    if (!wt) throw new Error('This task has no worktree.');
    const chats = this.sharing(wt);
    for (const id of chats) if (this.chat(id)?.busy) await this.cancel(id);
    await git.removeWorktree(wt.repo, wt);
    for (const id of chats) {
      this.worktrees.delete(id);
      this.dispatch({ t: 'worktree', chatId: id, branch: undefined });
    }
  }

  // ---- Sign-in ----

  async authMethods(agent: AgentKey): Promise<AccountStatus['methods']> {
    return signInMethods(await this.hub.authMethods(agent));
  }

  /** A terminal sign-in method as a command line: the agent's own CLI login, with its environment. */
  async terminalLogin(agent: AgentKey, methodId: string): Promise<{ command: string; args: string[]; env: Record<string, string> } | null> {
    const methods = (await this.hub.authMethods(agent)) as (acp.AuthMethod & { args?: string[]; env?: Record<string, string> })[];
    const method = methods.find((m) => m.id === methodId);
    if (!method) return null;
    const extras = loginExtras(method);
    if (!extras) throw new Error(`${this.label(agent)} offered a sign-in command FriedLiver won't run (its arguments aren't plain text).`);
    const spec = this.spec(agent);
    // The agent's own settings (and its API key) win over what the sign-in method asks for.
    return { command: spec.command, args: [...spec.args, ...extras.args], env: { ...extras.env, ...spec.env } };
  }

  /** ACP authenticate: the agent opens the vendor's page and waits. Five minutes, or until cancelled. */
  async signInWithBrowser(agent: AgentKey, methodId: string, cancelled: Promise<void>): Promise<void> {
    this.signingIn.add(agent);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.hub.authenticate(agent, methodId),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Sign-in timed out after 5 minutes.')), SIGN_IN_TIMEOUT_MS);
        }),
        cancelled.then(async () => {
          // Stopping the agent abandons its pending sign-in.
          await this.hub.stopAgent(agent);
          throw new Error('Sign-in cancelled.');
        }),
      ]);
    } catch (err) {
      await this.hub.stopAgent(agent);
      throw err;
    } finally {
      clearTimeout(timer);
      this.signingIn.delete(agent);
    }
  }

  /**
   * Starts the agent and asks for a session (no model call), which is closed
   * at once. Its models and effort levels become the agent's defaults, as a
   * chat's session does. Never run this automatically.
   */
  async checkAccount(agent: AgentKey): Promise<AccountStatus> {
    try {
      const r = await this.hub.checkSignIn(agent);
      const extra = { ...this.versionOf(agent, this.hub.agentInfo(agent)), logout: await this.hub.supportsLogout(agent) };
      if (!r.signedIn) return { status: 'needs-sign-in', methods: signInMethods(r.methods), ...extra };
      const store = this.options.defaults;
      if (store) store.set(agent, mergeOffered(store.get(agent), sessionOptions(r.setup)));
      return { status: 'signed-in', methods: await this.authMethods(agent), ...extra };
    } catch (err) {
      if (err instanceof AgentStartError && err.failure === 'not_installed') {
        return { status: 'not-installed', methods: [], installCommand: err.spec.installCommand, message: err.message };
      }
      return { status: 'error', methods: [], message: messageOf(err) };
    }
  }

  /** The agent's own sign-out (ACP `logout`); FriedLiver deletes none of its files. */
  async signOut(agent: AgentKey): Promise<void> {
    await this.hub.logout(agent);
    // Sessions it had were for the account it just left.
    await this.hub.stopAgent(agent);
  }

  /** Sets the model or effort the agent's new chats start with, to a value its last session offered. */
  setDefaultChoice(agent: AgentKey, key: string, value: string): boolean {
    const d = this.options.defaults?.get(agent);
    const option = d?.options.find((o) => optionKey(o) === key);
    if (!d || !option || !offers(option, value)) return false;
    this.saveDefaults(agent, { chosen: { ...defaultChoices(d), [key]: value }, explicit: true });
    return true;
  }

  /** The adapter's version, and what to do when it is too old to have model, effort or plan options. */
  private versionOf(agent: AgentKey, info: { name: string; version: string } | undefined): { version?: string; update?: string } {
    if (!info) return {};
    const spec = this.spec(agent);
    const old = (spec.minVersion && olderThan(info.version, spec.minVersion)) || info.name.startsWith('@zed-industries/');
    return { version: info.version, ...(old ? { update: `Update it: ${spec.installCommand}` } : {}) };
  }

  /** A fresh agent process picks up credentials a CLI login just saved. */
  stopAgent(agent: AgentKey): Promise<void> {
    return this.hub.stopAgent(agent);
  }

  stopAll(): Promise<void> {
    return this.hub.stopAll();
  }

  async dispose(): Promise<void> {
    for (const chat of this.state.chats) this.settleChat(chat.id);
    clearTimeout(this.outputTimer);
    await this.hub.dispose();
    await this.bridgeStarting?.catch(() => {});
    await this.bridge?.dispose();
    this.bridge = undefined;
  }

  // ---- Internals ----

  private dispatch(action: Action): void {
    const chatId = 'chatId' in action && typeof action.chatId === 'string' ? action.chatId : undefined;
    const before = chatId && this.chat(chatId)?.items.at(-1);
    this.state = reduce(this.state, action);
    // Error notices toast and go (shared/toasts.ts), so each is also kept in the log.
    // ponytail: checks only the last item; a notice is always appended on its own.
    const last = chatId && this.chat(chatId)?.items.at(-1);
    if (last && last !== before && last.kind === 'notice' && last.tone === 'error') this.options.log?.(`Error in chat ${chatId}: ${last.text}${last.detail ? `\n${last.detail}` : ''}`);
    for (const listener of this.listeners) listener(action, this.state);
  }

  private items(chatId: string, items: Item[]): void {
    this.dispatch({ t: 'items', chatId, items, at: Date.now() });
  }

  /** Records files a chat proposed or changed, relative to its folder. */
  private touch(chatId: string, files: string[]): void {
    const chat = this.chat(chatId);
    if (chat && files.length) this.dispatch({ t: 'files', chatId, files: files.map((f) => relativeFile(chat.cwd, f)) });
  }

  /** Chats working in the same worktree: a task and the chats it handed off to or consulted. */
  private sharing(wt: TaskWorktree): string[] {
    return [...this.worktrees].filter(([, w]) => w.path === wt.path).map(([id]) => id);
  }

  /**
   * Past CONTEXT_FULL of the context window, once per climb: offers the agent's own /compact (or,
   * without one, a hand-off, which carries a compact summary). Offered again after usage falls below 60%.
   */
  private checkContext(chatId: string, used: number, size: number): void {
    if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return;
    const share = used / size;
    if (share < 0.6) this.compactOffered.delete(chatId);
    if (share < CONTEXT_FULL || this.compactOffered.has(chatId)) return;
    this.compactOffered.add(chatId);
    const can = this.chat(chatId)?.session?.commands.some((c) => c.name === 'compact');
    const text = `The context is ${Math.round(share * 100)}% full. ${
      can ? 'Compact it now: the agent summarizes the conversation so far and goes on with room to spare.' : 'Hand the task off or start a new chat soon: a hand-off carries a compact summary.'
    }`;
    this.items(chatId, [{ kind: 'notice', tone: 'info', text, ...(can ? { actions: [{ label: 'Compact now', do: 'compact' as const }] } : {}) }]);
  }

  /** Adds to a chat's token totals (the "tokens saved" readout). */
  noteTokens(chatId: string, add: Partial<TokenTally>): void {
    if (this.chat(chatId)) this.dispatch({ t: 'tokens', chatId, add });
  }

  /** Sends the agent's own /compact as the chat's next message. */
  async compact(chatId: string): Promise<void> {
    await this.send(chatId, '/compact');
  }

  private async rulesFor(chatId: string): Promise<{ text: string; files: string[] } | undefined> {
    const rules = await this.options.sharedRules?.(this.chat(chatId)?.agent);
    this.rulesBytes.set(chatId, rules ? Buffer.byteLength(rules.text) : 0);
    if (rules?.truncated) {
      this.items(chatId, [{ kind: 'notice', tone: 'error', text: `The shared rules are over ${RULES_CAP / 1024} KB, so this session got only the first ${RULES_CAP / 1024} KB. Shorten .friedliver/rules.md or memory.md.` }]);
    }
    return rules && { text: rules.text, files: rules.files };
  }

  private policy(): AgentToAgent {
    return this.options.agentToAgent?.() ?? 'ask';
  }

  /**
   * The FriedLiver tools for a new session: none when they are off or unavailable. An agent that takes
   * MCP over HTTP reaches them in this process; any other starts a tools server for the session.
   */
  /** Whether the chat may only answer (inline edit); checked before any rule, level or policy. */
  private readOnlyChat(chatId: string | undefined): boolean {
    return !!chatId && this.chat(chatId)?.readOnly === true;
  }

  /** A read-only chat, or one in a discussion (counted, so it holds until the last one ends). */
  private mustStayReadOnly(chatId: string): boolean {
    return this.readOnlyChat(chatId) || this.discussing.has(chatId);
  }

  /** Refuses a level or mode change for a chat that must stay read only, and says why in it. */
  private levelLocked(chatId: string): boolean {
    if (!this.mustStayReadOnly(chatId)) return false;
    this.items(chatId, [{ kind: 'notice', tone: 'info', text: LEVEL_LOCKED }]);
    return true;
  }

  private async mcpServersFor(chatId: string, http: boolean): Promise<acp.McpServer[]> {
    if (this.readOnlyChat(chatId)) return [];
    const script = this.options.bridgeScript;
    if (!script || !this.bridge || this.policy() === 'off') return [];
    const token = this.bridge.token(chatId);
    const url = http ? await this.bridge.httpUrl().catch((err: unknown) => this.options.log?.(`FriedLiver tools over HTTP are unavailable: ${messageOf(err)}`)) : undefined;
    if (url) return [{ type: 'http', name: 'friedliver', url, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] }];
    const omit = this.omittedTools();
    return [
      {
        name: 'friedliver',
        // Like the demo agent: the editor's own runtime, run as plain Node.
        command: process.execPath,
        args: [script],
        env: [
          { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
          { name: BRIDGE_ENV, value: this.bridge.address },
          { name: TOKEN_ENV, value: token },
          ...(omit.length ? [{ name: OMIT_ENV, value: omit.join(',') }] : []),
        ],
      },
    ];
  }

  /** The tools a session isn't offered: system_* this computer lacks or the user turned off, index_* with the index off. */
  private omittedTools(): string[] {
    const platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'other';
    const index = !!this.options.index && (this.options.indexEnabled?.() ?? true);
    return omittedTools({ platform, system: this.options.system?.settings(), index });
  }

  /** Whether a new session gets the FriedLiver tools at all (the project map's index_* advice needs them). */
  private toolsOffered(chatId: string): boolean {
    return !this.readOnlyChat(chatId) && !!this.options.bridgeScript && this.policy() !== 'off' && !this.omittedTools().includes('index_search');
  }

  /** Starts the bridge socket before the first session that could use it. A failure only costs the tools. */
  private ensureBridge(): Promise<void> {
    if (!this.options.bridgeScript || this.policy() === 'off') return Promise.resolve();
    this.bridgeStarting ??= BridgeServer.start((chatId, call, signal) => this.bridgeCall(chatId, call, signal), this.options.log, () => this.omittedTools()).then(
      (server) => {
        this.bridge = server;
      },
      (err: unknown) => this.options.log?.(`FriedLiver tools are unavailable: ${messageOf(err)}`),
    );
    return this.bridgeStarting;
  }

  /** One turn with these blocks, after any hand-off context still waiting for the chat. Kept for "Try again". */
  private promptBlocks(chatId: string, blocks: acp.ContentBlock[]): Promise<TurnResult> {
    const context = this.preambles.get(chatId);
    if (context) {
      this.preambles.delete(chatId);
      blocks = [{ type: 'text', text: context }, ...blocks];
    }
    this.lastPrompt.set(chatId, blocks);
    return this.runPrompt(chatId, blocks);
  }

  private id(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }

  private requireChat(chatId: string): ChatView {
    const chat = this.chat(chatId);
    if (!chat) throw new Error(`Unknown chat ${chatId}`);
    return chat;
  }

  private label(agent: AgentKey): string {
    return AGENT_FACES[agent].name;
  }

  private async runPrompt(chatId: string, blocks: acp.ContentBlock[]): Promise<TurnResult> {
    const start = this.requireChat(chatId);
    const agent = start.agent;
    this.turnComing.delete(chatId);
    // A consultation or a pipe gives a chat its turn; the user started the rest.
    const byUser = start.origin?.kind !== 'consult';
    this.dispatch({ t: 'busy', chatId, busy: true, at: Date.now() });
    const turnId = this.turns.begin(chatId);
    this.reported.set(chatId, new Set());
    let notice: Item | null = null;
    let stopReason: acp.StopReason | null = null;
    try {
      // Before the agent can change anything: the checkpoint Undo goes back to.
      if (await this.checkpoints.begin(chatId, start.cwd, turnId)) this.dispatch({ t: 'checkpoint', chatId, turnId });
      await this.ensureBridge();
      const result: acp.PromptResponse = this.stopping.has(chatId) ? { stopReason: 'cancelled' } : await this.hub.prompt(chatId, blocks);
      stopReason = result.stopReason;
      // The agent's own count of this turn's tokens, logged with the context and cost its last usage_update gave.
      if (result.usage) {
        const { used, size, cost } = this.chat(chatId)?.session?.usage ?? {};
        const usage = { at: Date.now(), input: Number(result.usage.inputTokens), output: Number(result.usage.outputTokens), cacheRead: Number(result.usage.cachedReadTokens ?? 0), cacheWrite: Number(result.usage.cachedWriteTokens ?? 0) };
        this.dispatch({ t: 'turnUsage', chatId, usage: { ...usage, ...(size ? { context: { used: used!, size } } : {}), ...(cost ? { cost } : {}) } });
      }
      if (result.stopReason !== 'end_turn') notice = stopNotice(result.stopReason, this.label(agent));
    } catch (err) {
      this.settleChat(chatId);
      notice = this.failureNotice(agent, err, chatId);
    } finally {
      this.stopping.delete(chatId);
      this.flushOutput();
      // Nothing the agent asked for through the FriedLiver tools waits past its turn.
      this.requests.settle(chatId, false);
    }
    // The chat stays busy until the turn's changes are known, so a new turn can't start in between.
    const files = await this.turnFiles(chatId, turnId);
    for (const f of files) this.trail.add(chatId, f);
    this.trail.endTurn(chatId);
    this.options.indexTurnEnded?.(chatId);
    for (const map of [this.turnDecision, this.approvedWrites, this.reported]) map.delete(chatId);
    this.dispatch({ t: 'busy', chatId, busy: false, at: Date.now() });
    if (files.length) {
      this.dispatch({ t: 'changes', chatId, turnId, files });
      this.touch(chatId, files);
    }
    // Codex 2 says a model isn't allowed as its reply, and ends the turn normally.
    const said = stopReason === 'end_turn' ? this.turnReply(chatId) : '';
    const refused = said.length < 1000 ? modelProblem(said) : undefined;
    if (!notice && refused) notice = this.modelNotice(chatId, agent, refused, said);
    if (notice) this.items(chatId, [notice]);
    const chat = this.chat(chatId);
    if (chat) {
      this.options.ui.turnEnded?.({ chatId, agent: chat.agent, title: chat.title, stopReason, failure: notice?.kind === 'notice' && notice.tone === 'error' ? notice : undefined, files: files.length, byUser });
    }
    // Read the reply before pipes or held forwards give the chat its next message.
    const result: TurnResult = { stopReason, reply: chat ? lastReply(chat) : '' };
    this.links.turnEnded(chatId, result);
    // Queued messages go on after a turn that ended normally; after Stop or a failure they wait.
    if (stopReason !== null && stopReason !== 'cancelled') setTimeout(() => this.drainQueue(chatId), 0);
    return result;
  }

  /**
   * What the turn changed: the git checkpoint's files (every agent, however it
   * writes), and files FriedLiver recorded before a write or an edit request
   * whose content did change (folders outside git).
   */
  private async turnFiles(chatId: string, turnId: string): Promise<string[]> {
    const snap = await this.checkpoints.end(chatId, turnId, this.reported.get(chatId) ?? new Set()).catch(() => []);
    const logged = this.turns.current(chatId) === turnId ? (this.turns.latest(chatId)?.files ?? []) : [];
    const changed: string[] = [];
    for (const f of logged) {
      const now = await readIfExists(f).catch(() => undefined);
      if (now === this.turns.before(chatId, f)) this.turns.drop(chatId, f);
      else changed.push(f);
    }
    return [...new Set([...snap, ...changed])];
  }

  /** Keeps open tool calls whole (a permission request may name only the id), and notes files edit tools touch. */
  private noteTool(chatId: string, update: acp.SessionUpdate): void {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
    const tools = this.openTools.get(chatId) ?? new Map<string, OpenTool>();
    this.openTools.set(chatId, tools);
    const prev = tools.get(update.toolCallId) ?? {};
    const next: OpenTool = { ...prev };
    if (update.title != null) next.title = update.title;
    if (update.kind != null) next.kind = update.kind;
    if (update.status != null) next.status = update.status;
    if (update.content != null) next.content = update.content;
    if (update.locations != null) next.locations = update.locations;
    if (update.rawInput !== undefined) next.rawInput = update.rawInput;
    tools.delete(update.toolCallId);
    if (next.status === 'completed' || next.status === 'failed') {
      // Done: nothing will ask about it any more.
    } else {
      tools.set(update.toolCallId, next);
      if (tools.size > MAX_OPEN_TOOLS) tools.delete(tools.keys().next().value!);
    }
    const diffs = (update.content ?? []).flatMap((c) => (c.type === 'diff' ? [c.path] : []));
    if (next.kind === 'edit' || next.kind === 'delete' || next.kind === 'move' || diffs.length) {
      for (const file of [...(update.locations ?? []).map((l) => l.path), ...diffs]) this.noteFile(chatId, file);
    }
    // A finished read or edit: the agent has this version of the file now (index_diff compares with it).
    if (next.status === 'completed' && (next.kind === 'read' || next.kind === 'edit' || diffs.length)) {
      const files = [...(next.locations ?? []).map((l) => l.path), ...(next.content ?? []).flatMap((c) => (c.type === 'diff' ? [c.path] : []))];
      for (const file of new Set(files)) if (typeof file === 'string' && path.isAbsolute(file)) this.options.indexSeen?.(chatId, file);
    }
  }

  /**
   * A file the running turn says it changes: counts for its checkpoint, and its
   * content now is kept for Undo outside git. `before` is what a permission
   * request saw, read while the agent waited for the answer.
   */
  private noteFile(chatId: string, file: string, before?: string | null): void {
    if (typeof file === 'string') this.trail.add(chatId, file);
    const resolved = typeof file === 'string' && path.isAbsolute(file) ? insideRoots(file, this.roots()) : null;
    const turn = this.reported.get(chatId);
    if (!resolved || !turn) return;
    turn.add(resolved);
    if (this.turns.before(chatId, resolved) !== undefined) return;
    if (before !== undefined) {
      this.turns.record(chatId, resolved, before);
      return;
    }
    void readIfExists(resolved)
      .then((before) => this.reported.get(chatId) === turn && this.turns.record(chatId, resolved, before))
      .catch(() => {});
  }

  /** A permission request's tool call, filled in from the tool call of the same id that came before it. */
  private mergedTool(chatId: string, call: acp.ToolCallUpdate): OpenTool {
    const prev = this.openTools.get(chatId)?.get(call.toolCallId) ?? {};
    const pick = <K extends keyof OpenTool>(k: K) => (call[k as keyof acp.ToolCallUpdate] ?? prev[k] ?? undefined) as OpenTool[K];
    return {
      title: pick('title'),
      kind: pick('kind'),
      status: pick('status'),
      content: call.content?.length ? call.content : prev.content,
      locations: call.locations?.length ? call.locations : prev.locations,
      rawInput: call.rawInput !== undefined ? call.rawInput : prev.rawInput,
    };
  }

  /** The whole files a request would write, from the files on disk and its diffs; only inside the workspace. */
  private async proposalsFor(tool: OpenTool): Promise<Proposal[]> {
    const out: Proposal[] = [];
    const replaceAll = !!(tool.rawInput && typeof tool.rawInput === 'object' && (tool.rawInput as Record<string, unknown>).replace_all === true);
    for (const [file, entries] of diffsByFile(tool.content)) {
      const inside = path.isAbsolute(file) ? insideRoots(file, this.roots()) : null;
      let before: string | null = null;
      let readable = false;
      if (inside) {
        try {
          const info = await stat(inside);
          readable = info.isFile() && info.size <= MAX_PROPOSAL_BYTES;
          if (readable) before = await readFile(inside, 'utf8');
        } catch (err) {
          readable = (err as NodeJS.ErrnoException).code === 'ENOENT';
        }
      }
      const after = readable ? applyDiffs(before, entries, replaceAll) : undefined;
      out.push({ path: inside ?? file, before, after, entries });
    }
    return out;
  }

  private permissionDetail(tool: OpenTool, proposals: Proposal[], chat: ChatView | undefined): PermissionDetail {
    const detail: PermissionDetail = {};
    const command = commandOf(tool.rawInput);
    if (command) detail.command = { line: visibleText(command.line), cwd: command.cwd ?? chat?.cwd };
    const plan = planOf(tool.rawInput);
    if (plan) detail.plan = plan;
    const url = (tool.rawInput as { url?: unknown } | undefined)?.url;
    if (tool.kind === 'fetch' && typeof url === 'string' && siteOrigin(url)) detail.url = url.slice(0, 2000);
    if (proposals.length) {
      detail.files = proposals.map((p) => proposedFile(p.path, p.before, p.entries, p.after));
    }
    const text = (tool.content ?? [])
      .flatMap((c) => (c.type === 'content' && c.content.type === 'text' ? [c.content.text] : []))
      .join('\n')
      .trim();
    if (text && !plan) detail.text = text.slice(0, 4000);
    const locations = (tool.locations ?? []).map((l) => l.path).filter((l) => !proposals.some((p) => p.path === l));
    if (locations.length && !detail.files) detail.locations = locations.slice(0, 10);
    return detail;
  }

  /**
   * Answers a request for the user when the chat's level or an "Always allow"
   * rule covers it. Only ever with a one-time allow that doesn't change the
   * agent's mode, and never for a plan or a mode switch.
   */
  private autoAnswer(
    chat: ChatView | undefined,
    kind: string | undefined,
    detail: PermissionDetail,
    options: acp.PermissionOption[],
    files: { paths: string[]; access?: Access; complete: boolean },
    careful = false,
  ): { option: acp.PermissionOption; reason: string } | undefined {
    // Full auto's hard limits: no level, rule or "Accept all" answers these.
    if (!chat || kind === 'switch_mode' || detail.plan || detail.guard) return undefined;
    const once = options.find((o) => o.kind === 'allow_once' && !ESCALATING.test(o.name));
    const no = options.find((o) => o.kind === 'reject_once');
    const edit = kind === 'edit' || kind === 'delete' || kind === 'move' || !!detail.files?.length;
    const level = chat.approval ?? 'ask';
    const all = this.turnDecision.get(chat.id);
    if (edit && all === 'reject' && no) return { option: no, reason: 'Reject all' };
    if (!once) return undefined;
    // Accept all never covers a careful edit (secrets, keys, .git): that one is held and allowed on its own.
    if (edit && all === 'accept' && !careful) return { option: once, reason: 'Accept all' };
    if (edit && level !== 'ask') return { option: once, reason: APPROVAL_NAMES[level] };
    const outside = detail.command?.cwd !== undefined && insideRoots(detail.command.cwd, this.roots()) === null;
    if (level === 'full' && !outside) return { option: once, reason: APPROVAL_NAMES.full };
    // A careful request asks every time: no remembered rule answers it.
    if (careful) return undefined;
    if (kind === 'execute' && detail.command && !outside) {
      const rule = matchesRule(detail.command.line, this.options.permissions?.commands() ?? []);
      if (rule) return { option: once, reason: `Always allowed: ${describeRule(rule)}` };
    }
    // Remembered folders and websites answer with the agent's one-time allow, so it doesn't ask again either.
    const remembered = this.options.permissions;
    if (remembered && files.access && files.complete && files.paths.length) {
      const rules = files.paths.map((f) => remembered.folder(f, files.access!));
      if (rules.every(Boolean)) return { option: once, reason: `Always allowed: ${describeGrant(rules[0]!.grant).scope}` };
    }
    const origin = kind === 'fetch' && detail.url ? siteOrigin(detail.url) : undefined;
    if (remembered && origin && remembered.site(origin)) return { option: once, reason: `Always allowed: ${origin}` };
    return undefined;
  }

  /**
   * The files a request is about, and whether it reads or changes them: what a folder rule is matched
   * against. Every target it names counts: its diffs, its locations, and the paths in its input
   * (file_path, new_path, paths[], Codex's changes…), relative ones resolved against the chat's
   * folder. Fails closed: `complete` is false when any target isn't a usable path, and then no rule
   * answers it or is offered.
   */
  private requestFiles(tool: OpenTool, kind: string | undefined, proposals: Proposal[], cwd: string | undefined): { paths: string[]; access?: Access; complete: boolean } {
    // A request that runs a command or approves a plan is never a file request, whatever kind it claims.
    if (commandOf(tool.rawInput) || planOf(tool.rawInput)) return { paths: [], complete: false };
    const raw = tool.rawInput && typeof tool.rawInput === 'object' && !Array.isArray(tool.rawInput) ? (tool.rawInput as Record<string, unknown>) : {};
    const named: unknown[] = TARGET_KEYS.flatMap((k) => (raw[k] === undefined ? [] : [raw[k]]));
    if (raw.paths !== undefined) named.push(...(Array.isArray(raw.paths) ? raw.paths : [raw.paths]));
    if (raw.changes && typeof raw.changes === 'object' && !Array.isArray(raw.changes)) named.push(...Object.keys(raw.changes));
    let complete = true;
    const paths = new Set<string>();
    for (const target of [...proposals.map((p) => p.path), ...(tool.locations ?? []).map((l) => l.path), ...named]) {
      const abs = typeof target !== 'string' || !target || target.includes('\0') ? undefined : path.isAbsolute(target) ? target : cwd ? path.resolve(cwd, target) : undefined;
      if (!abs || realPath(abs) === null) complete = false;
      else paths.add(abs);
    }
    const access: Access | undefined =
      kind === 'edit' || kind === 'delete' || kind === 'move' || proposals.length ? 'write' : kind === 'read' || kind === 'search' ? 'read' : undefined;
    return { paths: [...paths], access, complete };
  }

  /** What "Always allow" may offer for a request beyond commands: its folders, or the website it fetches. */
  private alwaysFor(files: { paths: string[]; access?: Access; complete: boolean }, detail: PermissionDetail): Grant[] {
    const remembered = this.options.permissions;
    if (!remembered || detail.plan) return [];
    if (files.paths.length || !files.complete) return files.access && files.complete ? remembered.folderCandidates(files.paths, files.access, this.roots()) : [];
    const origin = detail.url ? siteOrigin(detail.url) : undefined;
    return origin ? [{ kind: 'site', origin }] : [];
  }

  /** The user (or the level) allowed exactly these files: the writes that follow aren't asked again. */
  private approveWrites(chatId: string, proposals: Proposal[]): void {
    const full = proposals.filter((p) => p.after !== undefined);
    if (!full.length) return;
    const map = this.approvedWrites.get(chatId) ?? new Map<string, string>();
    for (const p of full) map.set(p.path, p.after!);
    this.approvedWrites.set(chatId, map);
  }

  /** The agent's reply in the turn that just ended, if it gave one. */
  private turnReply(chatId: string): string {
    const items = this.chat(chatId)?.items ?? [];
    const lastUser = items.findLastIndex((i) => i.kind === 'user' || i.kind === 'link');
    const own = items.slice(lastUser + 1);
    return own.some((i) => i.kind === 'agent') ? lastReply({ ...this.chat(chatId)!, items: own }) : '';
  }

  /**
   * The account can't use the chat's model: says which, and offers the models
   * the agent lists for this account as one-click switches. An adapter too old
   * for the account's models gets an update instead.
   */
  private modelNotice(chatId: string | undefined, agent: AgentKey, problem: { model: string; outdated: boolean }, said: string): Item {
    const name = this.label(agent);
    const retry: NoticeAction = { label: 'Try again', do: 'retry' };
    const update: NoticeAction[] = agent !== 'demo' ? [{ label: `Update ${name}`, do: 'install', agent }] : [];
    const option = chatId ? this.chat(chatId)?.session?.options.find((o) => o.category === 'model' && o.type === 'select') : undefined;
    const others = problem.outdated ? [] : (option?.choices ?? []).filter((c) => baseModel(c.value) !== baseModel(problem.model)).slice(0, 3);
    if (problem.outdated || !option || !others.length) {
      return { kind: 'notice', tone: 'error', text: `${name} can't run the model ${problem.model}: this version of ${name} is too old for it, or your account can't use it.`, detail: said.trim(), actions: [...update, retry] };
    }
    const switches = others.map((c): NoticeAction => ({ label: `Use ${c.name}`, do: 'setOption', optionId: option.id, value: c.value }));
    return { kind: 'notice', tone: 'error', text: `${name} can't use the model ${problem.model} with this account.`, detail: said.trim(), actions: switches };
  }

  private failureNotice(agent: AgentKey, err: unknown, chatId?: string): Item {
    const retry: NoticeAction = { label: 'Try again', do: 'retry' };
    const problem = modelProblem(messageOf(err));
    if (problem) return this.modelNotice(chatId, agent, problem, messageOf(err));
    if (err instanceof AuthRequiredError) {
      this.options.accountSeen?.(agent, { status: 'needs-sign-in', methods: signInMethods(err.methods) });
      const actions: NoticeAction[] = [
        { label: `Sign in to ${this.label(agent)}`, do: 'accounts', agent },
        ...signInMethods(err.methods)
          .filter((m) => m.kind !== 'key')
          .map((m): NoticeAction => ({ label: m.name, do: 'signIn', agent, methodId: m.id })),
      ];
      if (agent !== 'demo') actions.push({ label: 'Use an API key', do: 'apiKey', agent });
      actions.push(retry);
      return { kind: 'notice', tone: 'error', text: err.message, detail: this.spec(agent).loginHint || undefined, actions };
    }
    if (err instanceof AgentStartError && err.failure === 'not_installed') {
      this.options.accountSeen?.(agent, { status: 'not-installed', message: err.message });
      return {
        kind: 'notice',
        tone: 'error',
        text: err.message.split(' Install it with:')[0],
        detail: err.spec.installCommand,
        detailKind: 'code',
        actions: [...(agent !== 'demo' ? [{ label: 'Install in terminal', do: 'install', agent } satisfies NoticeAction] : []), retry],
      };
    }
    return { kind: 'notice', tone: 'error', text: messageOf(err), actions: [retry] };
  }

  /** A cancelled or failed turn must not leave reviews, commands or tool requests waiting forever. */
  private settleChat(chatId: string): void {
    for (const q of [...this.questions.values()]) if (q.chatId === chatId) q.resolve({ action: 'cancel' });
    for (const p of [...this.permissions.values()]) if (p.chatId === chatId) p.resolve({ outcome: { outcome: 'cancelled' } });
    for (const p of [...this.reviews.values()]) if (p.chatId === chatId) p.resolve({ accept: false });
    for (const p of [...this.commands.values()]) if (p.chatId === chatId) p.resolve(false);
    this.requests.settle(chatId, true);
  }

  private checkPath(file: string): string {
    const resolved = insideRoots(file, this.roots());
    if (!resolved) throw new Error(`${file} is outside the workspace folders, so FriedLiver won't let the agent touch it.`);
    return resolved;
  }

  /** Writes also stay out of `.git`, whose config and hooks run programs and never show in a diff. */
  private checkWrite(file: string): string {
    const resolved = this.checkPath(file);
    if (inGitFolder(resolved, this.roots())) throw new Error(`${file} is inside a .git folder. FriedLiver doesn't let agents write there; use a git command instead.`);
    return resolved;
  }

  private async readForAgent(req: acp.ReadTextFileRequest, chatId?: string): Promise<acp.ReadTextFileResponse> {
    if (this.readOnlyChat(chatId)) throw new Error(READ_ONLY);
    const file = this.checkPath(req.path);
    const unsaved = this.options.ui.unsavedText?.(file);
    if (unsaved === undefined) {
      // Regular files of a sane size only: not a FIFO that never ends, not gigabytes into memory.
      const info = await stat(file);
      if (!info.isFile()) throw new Error(`${file} is not a regular file.`);
      if (info.size > MAX_AGENT_READ_BYTES) throw new Error(`${file} is ${Math.round(info.size / 1048576)} MB, more than an agent can read through FriedLiver at once.`);
      const read = await readTextFile({ ...req, path: file });
      if (chatId) this.options.indexSeen?.(chatId, file);
      return read;
    }
    if (req.line == null && req.limit == null) return { content: unsaved };
    const lines = unsaved.split('\n');
    const start = Math.max(0, (req.line ?? 1) - 1);
    return { content: lines.slice(start, req.limit == null ? lines.length : start + req.limit).join('\n') };
  }

  /**
   * An agent's permission request is the review for agents that act on their
   * own (Claude, Codex): its card shows the diff, the command and its folder,
   * or the plan, filled in from the tool call it refers to.
   */
  private async askPermission(chatId: string, req: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    if (this.readOnlyChat(chatId)) {
      // Before Always-allow rules and approval levels, and without a card: the chat may only answer.
      const reject = req.options.find((o) => o.kind === 'reject_once') ?? req.options.find((o) => o.kind.startsWith('reject'));
      return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } };
    }
    const requestId = this.id('perm');
    const tool = this.mergedTool(chatId, req.toolCall);
    const proposals = await this.proposalsFor(tool).catch(() => [] as Proposal[]);
    if (signal.aborted) return { outcome: { outcome: 'cancelled' } };
    if (this.discussing.has(chatId) && !discussionAllows({ kind: tool.kind, toolName: this.toolName(chatId, req.toolCall), command: !!commandOf(tool.rawInput) || !!planOf(tool.rawInput), diffs: proposals.length > 0 })) {
      const reject = req.options.find((o) => o.kind === 'reject_once') ?? req.options.find((o) => o.kind.startsWith('reject'));
      const title = tool.title?.trim() || 'A change';
      this.items(chatId, [{ kind: 'permission', requestId, toolCallId: req.toolCall.toolCallId, title, options: req.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })), answer: reject?.name ?? 'Refused', auto: 'Read-only during the discussion', ...(tool.kind ? { toolKind: tool.kind } : {}) }]);
      return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } };
    }
    const chat = this.chat(chatId);
    const kind = tool.kind ?? undefined;
    const detail = this.permissionDetail(tool, proposals, chat);
    const files = this.requestFiles(tool, kind, proposals, chat?.cwd);
    const dropped = await this.droppedBy(detail.command?.line, detail.command?.cwd ?? chat?.cwd);
    if (dropped) detail.dropped = dropped;
    if (signal.aborted) return { outcome: { outcome: 'cancelled' } };
    const always = kind === 'switch_mode' ? [] : this.alwaysFor(files, detail);
    if (always.length) detail.always = always;
    const guard = detail.command ? this.commandGuard(chatId, detail.command.line) : undefined;
    if (guard) detail.guard = guard;
    for (const p of proposals) this.noteFile(chatId, p.path, p.before);
    const title = tool.title?.trim() || fallbackTitle(kind, detail);
    const options = req.options;
    const item: Item = {
      kind: 'permission',
      requestId,
      toolCallId: req.toolCall.toolCallId,
      title,
      options: options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
      ...(kind ? { toolKind: kind } : {}),
      ...(Object.keys(detail).length ? { detail } : {}),
    };
    const risk = approvalOf(item as Approvable, chat ?? { agent: 'demo', label: '', cwd: '' }).risk;
    const careful = risk.tone === 'careful' || !!guard;
    const auto = this.autoAnswer(chat, kind, detail, options, files, careful);
    if (auto) {
      this.items(chatId, [{ ...item, answer: auto.option.name, auto: auto.reason }]);
      if (auto.option.kind.startsWith('allow')) this.approveWrites(chatId, proposals);
      return { outcome: { outcome: 'selected', optionId: auto.option.optionId } };
    }
    if (proposals.some((p) => p.after !== undefined)) {
      this.proposals.set(requestId, proposals);
      if (this.proposals.size > 50) this.proposals.delete(this.proposals.keys().next().value!);
    }
    return new Promise((resolve) => {
      let autoFired = false;
      this.permissions.set(requestId, {
        chatId,
        options,
        careful,
        resolve: (answer) => {
          if (!this.permissions.delete(requestId)) return;
          this.endAuto(requestId);
          const chosen = answer.outcome.outcome === 'selected' ? options.find((o) => o.optionId === (answer.outcome as { optionId: string }).optionId) : undefined;
          if (chosen?.kind.startsWith('allow')) this.approveWrites(chatId, proposals);
          this.dispatch({ t: 'permissionAnswered', requestId, answer: chosen?.name ?? 'Cancelled', ...(autoFired ? { auto: 'Routine, allowed after the countdown' } : {}) });
          resolve(answer);
        },
      });
      signal.addEventListener('abort', () => this.answerPermission(requestId, null), { once: true });
      const allow = options.find((o) => o.kind === 'allow_once' && !ESCALATING.test(o.name));
      // Routine, with a plain one-time yes, not a plan, and wholly inside the workspace (the command's folder,
      // every file it names, all of them resolvable): it may count down (off unless the user set it).
      // Relative paths resolve against the chat's folder, links are followed, and anything that doesn't resolve fails closed.
      const inside = (p: string | undefined) => workspacePath(p, chat?.cwd, this.roots()) !== null;
      const inWorkspace = detail.command
        ? inside(detail.command.cwd ?? chat?.cwd)
        : files.complete && files.paths.length > 0 && [...files.paths, ...(detail.locations ?? [])].every(inside);
      // Only the exact command list ever counts down; nothing the classifier says does.
      const routine = !guard && inWorkspace && !!detail.command && autoRoutineCommand(detail.command.line);
      const autoAt =
        allow && !detail.plan && kind !== 'switch_mode'
          ? this.autoRoutine(requestId, routine, () => {
              autoFired = true;
              this.answerPermission(requestId, allow.optionId);
            })
          : undefined;
      this.items(chatId, [autoAt ? { ...item, autoAt } : item]);
      const deny = options.find((o) => o.kind === 'reject_once');
      this.options.ui.askPermission?.({
        chatId,
        requestId,
        agentLabel: chat?.label ?? 'The agent',
        title,
        ...(allow && !careful ? { allow: { optionId: allow.optionId, name: allow.name } } : {}),
        ...(deny ? { deny: { optionId: deny.optionId, name: deny.name } } : {}),
      });
    });
  }

  /** A question as a small form in the chat. One FriedLiver can't show is declined, so the agent asks another way. */
  private askQuestion(chatId: string, req: acp.CreateElicitationRequest, signal: AbortSignal): Promise<acp.CreateElicitationResponse> {
    if (this.readOnlyChat(chatId)) return Promise.resolve({ action: 'decline' });
    const fields = questionFields(req);
    if (!fields || signal.aborted) return Promise.resolve({ action: 'decline' });
    const requestId = this.id('question');
    const message = String(req.message ?? '').slice(0, 4000) || 'The agent has a question.';
    return new Promise((resolve) => {
      this.questions.set(requestId, {
        chatId,
        fields,
        resolve: (answer) => {
          if (!this.questions.delete(requestId)) return;
          const summary = answer.action === 'accept' && 'content' in answer && answer.content ? answerSummary(fields, answer.content as Record<string, never>) : undefined;
          this.dispatch({ t: 'question', requestId, state: answer.action === 'accept' ? 'answered' : 'declined', ...(summary ? { summary } : {}) });
          resolve(answer);
        },
      });
      signal.addEventListener('abort', () => this.questions.get(requestId)?.resolve({ action: 'cancel' }), { once: true });
      this.items(chatId, [{ kind: 'question', requestId, message, fields, state: 'awaiting' }]);
      this.options.ui.askQuestion?.({ chatId, requestId, agentLabel: this.chat(chatId)?.label ?? 'The agent', message });
    });
  }

  /** Workspace files whose path contains `query`, for the composer's "#" picker; relative to the chat's folder. */
  fileMatches(chatId: string, files: string[], query: string): string[] {
    const chat = this.chat(chatId);
    if (!chat) return [];
    const q = query.toLowerCase();
    return files
      .filter((f) => insideRoots(f, this.roots()))
      .map((f) => relativeFile(chat.cwd, f))
      .filter((rel) => !rel.startsWith('..') && rel.toLowerCase().includes(q))
      .sort((a, b) => a.length - b.length || a.localeCompare(b))
      .slice(0, 12);
  }

  /** "Open diff" on a permission card: the whole proposed file against the file on disk, read-only. */
  showProposal(requestId: string, file: string): boolean {
    const p = this.proposals.get(requestId)?.find((x) => x.path === file && x.after !== undefined);
    const chat = this.state.chats.find((c) => c.items.some((i) => i.kind === 'permission' && i.requestId === requestId));
    if (!p || !chat || !this.options.ui.showProposal) return false;
    this.options.ui.showProposal({ id: requestId, path: p.path, before: p.before, after: p.after!, agentLabel: chat.label, chatId: chat.id });
    return true;
  }

  /**
   * "Always allow": remembers the grant for every chat and later session (a command rule after the
   * user confirms it), then allows the request that asked. The grant must be one this very request
   * offered: the command on screen, or a folder or website its card listed. Never in a read-only chat.
   */
  async allowAlways(target: { requestId: string } | { commandId: string }, grant: Grant, via: Via = 'desktop'): Promise<void> {
    let found: { chat: ChatView; line?: string; offered: Grant[] } | undefined;
    for (const chat of this.state.chats) {
      for (const i of chat.items) {
        if ('requestId' in target && i.kind === 'permission' && i.requestId === target.requestId && !i.answer) found = { chat, line: i.detail?.command?.line, offered: i.detail?.always ?? [] };
        if ('commandId' in target && i.kind === 'command' && i.commandId === target.commandId && i.state === 'awaiting' && !i.outside) found = { chat, line: i.commandLine, offered: [] };
      }
    }
    const remembered = this.options.permissions;
    if (!found || found.chat.readOnly || !remembered) return;
    // Careful requests are allowed once, never remembered.
    if (('requestId' in target && this.permissions.get(target.requestId)?.careful) || (found.line !== undefined && commandRisk(found.line).tone === 'careful')) return;
    const fromPhone = () => {
      const { what, scope } = describeGrant(grant);
      const title = grant.kind === 'folder' ? `${grant.access === 'read' ? 'reading' : 'changing'} files in ${scope}` : grant.kind === 'site' ? `${scope} in the browser` : grant.kind === 'tool' ? what.toLowerCase() : scope;
      return via !== 'desktop' && this.confirmRemote(via, { title: `Always allow ${title}?`, detail: `${what}, in every chat, for every agent, until you revoke it in "FriedLiver: Manage Permissions".`, button: 'Always allow' });
    };
    if (grant.kind === 'exact' || grant.kind === 'prefix') {
      // The rule must cover the very command on screen.
      if (!found.line || !matchesRule(found.line, [grant])) return;
      if (!(await (via !== 'desktop' ? fromPhone() : this.options.ui.confirmRule?.(grant)))) return;
    } else if (!found.offered.some((g) => sameGrant(g, grant)) || (via !== 'desktop' && !(await fromPhone()))) {
      return;
    }
    if (!remembered.add(grant, AGENT_FACES[found.chat.agent].name)) return;
    if ('commandId' in target) {
      this.decideCommand(target.commandId, true);
      return;
    }
    const pending = this.permissions.get(target.requestId);
    const once = pending?.options.find((o) => o.kind === 'allow_once' && !ESCALATING.test(o.name));
    if (once) this.answerPermission(target.requestId, once.optionId);
  }

  /** The user's OK on the Mac for a request from FriedLiver Remote; refused when the editor can't ask. */
  private async confirmRemote(via: { device: string; valid?(): boolean }, ask: { title: string; detail: string; button: string }): Promise<boolean> {
    const confirm = this.options.ui.confirmRemote;
    // A phone revoked while the question was up gets nothing from the answer.
    return confirm ? (await confirm({ ...ask, title: `Phone “${via.device}” asks: ${ask.title}` })) === true && via.valid?.() !== false : false;
  }

  /** Accept all / Reject all: the edits waiting now (the editor decides its reviews) and the rest of this turn's. */
  decideAll(chatId: string, action: 'accept' | 'reject'): string[] {
    const chat = this.requireChat(chatId);
    if (chat.busy) this.turnDecision.set(chatId, action);
    for (const [id, p] of this.permissions) {
      if (p.chatId !== chatId) continue;
      const item = chat.items.find((i) => i.kind === 'permission' && i.requestId === id);
      if (item?.kind !== 'permission' || !(item.toolKind === 'edit' || item.detail?.files?.length)) continue;
      if (action === 'accept' && p.careful) continue;
      const option = p.options.find((o) => (action === 'accept' ? o.kind === 'allow_once' && !ESCALATING.test(o.name) : o.kind === 'reject_once'));
      if (option) this.answerPermission(id, option.optionId);
    }
    return [...this.reviews.values()].filter((r) => r.chatId === chatId).map((r) => r.reviewId);
  }

  /**
   * Every agent write waits for review in a diff, unless the chat's level
   * accepts edits or the user just approved this very content on a permission
   * card. Either way it is recorded, so the turn can be undone.
   */
  private async reviewWrite(chatId: string | undefined, req: acp.WriteTextFileRequest): Promise<void> {
    if (this.readOnlyChat(chatId)) throw new Error(READ_ONLY);
    if (chatId && this.discussing.has(chatId)) throw new Error(DISCUSS_READ_ONLY);
    const file = this.checkWrite(req.path);
    const before = await readIfExists(file);
    const reviewId = this.id('review');
    const chat = chatId ? this.chat(chatId) : undefined;
    if (chatId && chat) {
      this.reported.get(chatId)?.add(file);
      this.trail.add(chatId, file);
      const approved = this.approvedWrites.get(chatId)?.get(file) === req.content;
      const all = this.turnDecision.get(chatId);
      const level = chat.approval ?? 'ask';
      const stats = lineStats(before, req.content);
      if (all === 'reject') {
        this.items(chatId, [{ kind: 'review', reviewId, path: file, ...stats, isNew: before === null, state: 'rejected', auto: 'Reject all' }]);
        throw new Error(`The user rejected the change to ${file}.`);
      }
      const folder = this.options.permissions?.folder(file, 'write');
      const reason = approved
        ? 'Approved above'
        : all === 'accept'
          ? 'Accept all'
          : level !== 'ask'
            ? APPROVAL_NAMES[level]
            : folder
              ? `Always allowed: ${describeGrant(folder.grant).scope}`
              : undefined;
      if (reason) {
        if (approved) this.approvedWrites.get(chatId)?.delete(file);
        this.items(chatId, [{ kind: 'review', reviewId, path: file, ...stats, isNew: before === null, state: 'accepted', auto: reason }]);
        this.touch(chatId, [file]);
        this.checkWrite(file);
        this.turns.record(chatId, file, before);
        await writeTextFile(file, req.content);
        this.options.ui.fileChanged?.(file);
        return;
      }
    }
    const review: PendingReview = { reviewId, chatId, path: file, before, proposed: req.content, agentLabel: chat?.label ?? 'Agent', auto: true };
    const decision = await new Promise<{ accept: boolean; content?: string }>((resolve) => {
      this.reviews.set(reviewId, {
        ...review,
        resolve: (value) => {
          if (!this.reviews.delete(reviewId)) return;
          this.dispatch({ t: 'review', reviewId, state: value.accept ? 'accepted' : 'rejected' });
          this.options.ui.closeReview(reviewId);
          resolve(value);
        },
      });
      if (chatId) {
        const stats = lineStats(before, req.content);
        this.items(chatId, [{ kind: 'review', reviewId, path: file, ...stats, isNew: before === null, state: 'pending' }]);
        this.touch(chatId, [file]);
      }
      this.options.ui.showReview(review);
    });
    if (!decision.accept) throw new Error(`The user rejected the change to ${file}.`);
    // A review can take minutes: check again, in case a symlink appeared in the meantime.
    this.checkWrite(file);
    if (chatId) this.turns.record(chatId, file, before);
    await writeTextFile(file, decision.content ?? req.content);
    this.options.ui.fileChanged?.(file);
  }

  /**
   * Why `line` asks even on Full auto or an "Always allow" rule (fullAutoGuards.ts), or undefined.
   * What a curl or wget in it saves joins the chat's trail first, so fetch-then-run in one line asks.
   */
  private commandGuard(chatId: string | undefined, line: string): string | undefined {
    if (!chatId || this.options.fullAutoGuards?.() === false) return undefined;
    for (const f of downloadTargets(line)) this.trail.add(chatId, f);
    return commandGuard(line, this.trail.names(chatId), this.chat(chatId)?.approval === 'full', /^(?:pwsh|powershell)$/.test(agentShell().kind));
  }

  /** Nothing an agent asks to run starts before the user approves it. */
  private commandHooks(agentId: AgentKey): TerminalListener {
    const known = new Map<string, { commandId: string; startedAt?: number }>();
    return {
      approve: async (info) => {
        const commandId = this.id('cmd');
        const chatId = this.hub.chatIdForSession(info.sessionId, agentId);
        if (this.readOnlyChat(chatId) || (chatId && this.discussing.has(chatId))) return Promise.resolve(false);
        known.set(info.terminalId, { commandId });
        const outside = insideRoots(info.cwd, this.roots()) === null;
        // Full auto and "Always allow" rules run it at once, but never in a folder outside the workspace.
        const chat = chatId ? this.chat(chatId) : undefined;
        const risk = commandRisk(info.commandLine);
        const guard = this.commandGuard(chatId, info.commandLine);
        // A careful command asks every time: no remembered rule runs it; nor does Full auto run a guarded one.
        const rule = outside || guard || risk.tone === 'careful' ? undefined : matchesRule(info.commandLine, this.options.permissions?.commands() ?? []);
        const auto = outside || !chat || guard ? undefined : chat.approval === 'full' ? APPROVAL_NAMES.full : rule ? `Always allowed: ${describeRule(rule)}` : undefined;
        if (chatId && auto) {
          this.items(chatId, [{ kind: 'command', commandId, commandLine: info.commandLine, cwd: info.cwd, outside, state: 'running', output: '', auto }]);
          return true;
        }
        const dropped = await this.droppedBy(info.commandLine, info.cwd);
        let autoFired = false;
        const autoAt = outside || !chatId || guard ? undefined : this.autoRoutine(commandId, autoRoutineCommand(info.commandLine), () => ((autoFired = true), this.decideCommand(commandId, true)));
        if (chatId)
          this.items(chatId, [
            { kind: 'command', commandId, commandLine: info.commandLine, cwd: info.cwd, outside, state: 'awaiting', output: '', ...(dropped ? { dropped } : {}), ...(autoAt ? { autoAt } : {}), ...(guard ? { guard } : {}) },
          ]);
        const agentLabel = (chatId && this.chat(chatId)?.label) || this.label(agentId);
        this.options.ui.askCommand?.({ chatId, commandId, agentLabel, commandLine: info.commandLine, ...(risk.tone === 'careful' || guard ? { careful: true } : {}) });
        return new Promise<boolean>((resolve) => {
          this.commands.set(commandId, {
            chatId,
            resolve: (ok) => {
              if (!this.commands.delete(commandId)) return;
              this.endAuto(commandId);
              if (autoFired) this.dispatch({ t: 'command', commandId, patch: { auto: 'Routine, run after the countdown' } });
              if (!ok) known.delete(info.terminalId);
              this.dispatch({ t: 'command', commandId, patch: { state: ok ? 'running' : 'denied' } });
              resolve(ok);
            },
          });
        });
      },
      onStart: (info) => {
        const k = known.get(info.terminalId);
        if (!k) return;
        k.startedAt = Date.now();
        this.dispatch({ t: 'command', commandId: k.commandId, patch: { state: 'running', startedAt: k.startedAt } });
      },
      onData: (terminalId, data) => {
        const k = known.get(terminalId);
        if (k) this.queueOutput(k.commandId, data);
      },
      compacted: (info, raw, sent) => {
        const chatId = this.hub.chatIdForSession(info.sessionId, agentId);
        if (chatId) this.noteTokens(chatId, { naive: estimateTokens(raw), sent: estimateTokens(sent) });
      },
      saveOutput: async (info, text) => {
        const dir = this.options.outputDir;
        if (!dir) throw new Error('No folder for command output.');
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const file = path.join(dir, `${info.sessionId.replace(/[^\w-]/g, '_').slice(0, 64)}-${info.terminalId}.txt`);
        // Private, and replaced whole: a later call while the command runs has more.
        await writeFile(file, text, { mode: 0o600 });
        return file;
      },
      onExit: (terminalId, status) => {
        const k = known.get(terminalId);
        if (!k) return;
        known.delete(terminalId);
        this.flushOutput();
        const durationMs = Date.now() - (k.startedAt ?? Date.now());
        this.dispatch({ t: 'command', commandId: k.commandId, patch: { state: 'exited', exitCode: status.exitCode, durationMs } });
      },
    };
  }

  // Output arrives in many small chunks; batch them so webviews get a few messages a second.
  private queueOutput(commandId: string, data: string): void {
    // The transcript keeps only the last MAX_COMMAND_OUTPUT characters, so nothing more is held between flushes.
    this.output.set(commandId, ((this.output.get(commandId) ?? '') + data).slice(-MAX_COMMAND_OUTPUT));
    this.outputTimer ??= setTimeout(() => this.flushOutput(), OUTPUT_FLUSH_MS);
  }

  private flushOutput(): void {
    clearTimeout(this.outputTimer);
    this.outputTimer = undefined;
    for (const [commandId, data] of this.output) this.dispatch({ t: 'commandOutput', commandId, data });
    this.output.clear();
  }

  private addImage(id: string, src: string, title: string, from: 'agent' | 'you', where: { chatId?: string; stepId?: string } = {}): void {
    this.dispatch({ t: 'image', image: { id, src, title, from, ...where, at: Date.now() } });
  }

  /**
   * Images the agent sends as data (in a reply, or as a tool's output) go to the Images view.
   * An image file a step reads or makes isn't copied here: the view shows the step's file.
   */
  private collectImages(chatId: string, update: acp.SessionUpdate): void {
    // The agent names the type; only the image types the views show are taken (see imageDataUri).
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'image') {
      const src = imageDataUri(update.content.mimeType, update.content.data);
      if (src) this.addImage(this.id('msg'), src, 'From the agent', 'agent', { chatId });
      return;
    }
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
    for (const item of update.content ?? []) {
      if (item.type === 'content' && item.content.type === 'image') {
        const src = imageDataUri(item.content.mimeType, item.content.data);
        if (src) this.addImage(this.id('tool'), src, update.title ?? 'Tool output', 'agent', { chatId, stepId: update.toolCallId });
      }
    }
  }
}

/** An error in plain words: for an agent's error, what the agent itself said, never a bare "Internal error". */
export function messageOf(err: unknown): string {
  return agentErrorMessage(err);
}

/** The model an agent says this account can't use, from its error or its reply. */
export function modelProblem(text: string): { model: string; outdated: boolean } | undefined {
  const m = /\bThe '([^']{1,80})' model (is not supported|requires a newer version)/i.exec(text);
  return m ? { model: m[1], outdated: /newer version/i.test(m[2]) } : undefined;
}

/** How a turn that didn't end normally reads. */
function stopNotice(reason: acp.StopReason, agent: string): Item {
  switch (reason) {
    case 'cancelled':
      return { kind: 'notice', tone: 'info', text: 'Stopped.' };
    case 'max_tokens':
      return { kind: 'notice', tone: 'info', text: `${agent} reached its output limit. Send "continue" to go on.`, actions: [{ label: 'Try again', do: 'retry' }] };
    case 'max_turn_requests':
      return { kind: 'notice', tone: 'info', text: `${agent} reached its limit of steps for one message. Send "continue" to go on.` };
    case 'refusal':
      return { kind: 'notice', tone: 'info', text: `${agent} declined this request.` };
    default:
      return { kind: 'notice', tone: 'info', text: `Stopped (${reason}).` };
  }
}

/** A title for a permission request that came without one. */
function fallbackTitle(kind: string | undefined, detail: PermissionDetail): string {
  if (kind === 'execute') return detail.command ? `Run ${detail.command.line.split('\n')[0].slice(0, 80)}` : 'Run a command';
  if (detail.files?.length) return `Edit ${detail.files.map((f) => path.basename(f.path)).join(', ')}`;
  if (kind === 'edit') return 'Edit files';
  if (kind === 'switch_mode' || detail.plan) return 'Approve the plan';
  if (kind === 'fetch') return 'Fetch from the web';
  return 'Use a tool';
}

/** Whether a dotted version is older than another (numbers only; anything else isn't). */
export function olderThan(version: string, min: string): boolean {
  const a = version.split(/[.-]/).map(Number);
  const b = min.split(/[.-]/).map(Number);
  for (let i = 0; i < b.length; i++) {
    const x = a[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(b[i])) return false;
    if (x !== b[i]) return x < b[i];
  }
  return false;
}
