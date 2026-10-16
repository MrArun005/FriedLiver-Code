import { existsSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { AgentStartError } from '@friedliver/main/agents/agentConnection';
import { readIfExists, readTextFile, writeTextFile } from '@friedliver/main/agents/fileAccess';
import { AgentHub, AuthRequiredError } from '@friedliver/main/agents/hub';
import { DEFAULT_AGENTS, demoAgentSpec, type AgentSpec, type VendorAgentId } from '@friedliver/main/agents/registry';
import { allowedSignInUrl, signInMethods } from '@friedliver/main/agents/signIn';
import type { TerminalListener } from '@friedliver/main/agents/terminals';
import { TurnLog } from '@friedliver/main/agents/turnLog';
import * as git from '@friedliver/main/workspace/git';
import { BRIDGE_ENV, TOKEN_ENV, type BridgeCall } from '../bridge/protocol';
import type { Attachment } from '../shared/messages';
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
  type Action,
  type AgentKey,
  type AppState,
  type ChatLink,
  type ChatView,
  type Decision,
  type Item,
  type NoticeAction,
} from '../shared/model';
import { BridgeServer } from './bridge';
import { BridgeRequests, type AgentToAgent } from './bridgeRequests';
import { Connections, type NewChat, type TurnResult } from './connections';
import { MAX_AGENT_READ_BYTES, compactUpdate, imageDataUri } from './limits';
import { inGitFolder, insideRoots } from './paths';
import { settleRestored, type SavedState } from './persist';
import { loginExtras } from './signin';
import { relativeFile } from './transcript';

/** Each vendor's key goes only to that vendor's agent process. */
export const KEY_ENV: Record<VendorAgentId, string> = {
  claude: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};
export const VENDOR_AGENTS: VendorAgentId[] = ['claude', 'codex', 'gemini'];

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const OUTPUT_FLUSH_MS = 50;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

export interface PendingReview {
  reviewId: string;
  chatId?: string;
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
  askCommand?(ask: { chatId?: string; commandId: string; agentLabel: string; commandLine: string }): void;
  askPermission?(ask: { chatId: string; requestId: string; agentLabel: string; title: string }): void;
  /** An agent asks, through the FriedLiver tools, to reach another agent or chat. */
  askBridge?(ask: { chatId: string; requestId: string; title: string }): void;
  signInUrl?(agent: AgentKey, url: string): void;
  fileChanged?(file: string): void;
  /** The text of an open editor with unsaved changes, so agents read what the user sees. */
  unsavedText?(file: string): string | undefined;
}

export interface CoreOptions {
  folders(): string[];
  clientVersion: string;
  demoAgentScript: string;
  agentCommand(id: VendorAgentId): { command: string; args: string[] };
  apiKey(id: VendorAgentId): string | undefined;
  limits(): { maxRunning: number; idleStopMinutes: number };
  /** The FriedLiver tools' MCP server (dist/bridge.js). Without it, agents get no FriedLiver tools. */
  bridgeScript?: string;
  /** Whether agents may reach other agents and chats through those tools. "ask" when not given. */
  agentToAgent?(): AgentToAgent;
  ui: CoreUi;
  log?(line: string): void;
}

export interface AccountStatus {
  status: 'signed-in' | 'needs-sign-in' | 'not-installed' | 'error';
  methods: ReturnType<typeof signInMethods>;
  message?: string;
  installCommand?: string;
}

type Pending<T> = { chatId?: string; resolve(value: T): void };
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
  private readonly permissions = new Map<string, Pending<acp.RequestPermissionResponse> & { options: acp.PermissionOption[] }>();
  private readonly reviews = new Map<string, PendingReview & Pending<{ accept: boolean; content?: string }>>();
  private readonly commands = new Map<string, Pending<boolean>>();
  private readonly worktrees = new Map<string, TaskWorktree>();
  private readonly lastPrompt = new Map<string, acp.ContentBlock[]>();
  private readonly chatCount: Partial<Record<AgentKey, number>> = {};
  private readonly signingIn = new Set<AgentKey>();
  private readonly shownImages = new Set<string>();
  private readonly output = new Map<string, string>();
  /** Hand-off context waiting for the chat's first message. */
  private readonly preambles = new Map<string, string>();
  /** Chats whose Stop came while their turn was still on its way to the agent. */
  private readonly stopping = new Set<string>();
  private readonly links: Connections;
  private readonly requests: BridgeRequests;
  private bridge?: BridgeServer;
  private bridgeStarting?: Promise<void>;
  private outputTimer?: ReturnType<typeof setTimeout>;
  private nextId = 1;

  constructor(private readonly options: CoreOptions) {
    const limits = options.limits();
    this.hub = new AgentHub({
      cwd: options.folders()[0] ?? os.homedir(),
      clientVersion: options.clientVersion,
      resolveSpec: (id) => this.spec(id),
      idleStopMs: limits.idleStopMinutes * 60_000,
      maxRunning: limits.maxRunning,
      log: options.log,
      events: {
        update: (chatId, update) => {
          this.dispatch({ t: 'update', chatId, update: compactUpdate(update), at: Date.now() });
          void this.collectImages(update);
        },
        notice: (chatId, text) => this.items(chatId, [{ kind: 'notice', text, tone: 'info' }]),
        agentsChanged: () => {},
        agentStderr: (agentId, line) => {
          if (!this.signingIn.has(agentId)) return;
          for (const url of line.match(/https:\/\/[^\s"'<>)]+/g) ?? []) {
            if (allowedSignInUrl(agentId, url)) options.ui.signInUrl?.(agentId, url);
          }
        },
        permission: (chatId, req, signal) => this.askPermission(chatId, req, signal),
      },
      files: {
        read: (req) => this.readForAgent(req),
        write: (chatId, req) => this.reviewWrite(chatId, req),
      },
      terminalListener: (agentId) => this.commandHooks(agentId),
      mcpServersFor: (chatId) => this.mcpServersFor(chatId),
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
    if (id === 'demo') return { ...demoAgentSpec(this.options.demoAgentScript), label: 'Demo' };
    const base = DEFAULT_AGENTS[id];
    const { command, args } = this.options.agentCommand(id);
    const key = this.options.apiKey(id);
    return {
      ...base,
      label: AGENT_FACES[id].name,
      command: command.trim() || base.command,
      args,
      env: { ...base.env, ...(key ? { [KEY_ENV[id]]: key } : {}) },
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
    let cwd = shared?.cwd ?? folder;
    let wt = shared && this.worktrees.get(shared.id);
    if (options.worktree && !wt) {
      const repo = await git.repoRoot(folder);
      if (!repo) throw new Error('A separate worktree needs a git repository. Run `git init` and commit once, or untick the option.');
      const title = options.title ?? 'task';
      wt = { ...(await git.createWorktree(repo, options.worktreeName ?? title)), repo, title };
      cwd = wt.path;
    }
    const chat = this.hub.createChat(agent, cwd);
    if (wt) this.worktrees.set(chat.id, wt);
    const n = (this.chatCount[agent] = (this.chatCount[agent] ?? 0) + 1);
    const name = AGENT_FACES[agent].name;
    const view: ChatView = {
      id: chat.id,
      agent,
      label: n > 1 ? `${name} ${n}` : name,
      title: options.title ? titleFrom(options.title) : 'New chat',
      cwd,
      branch: wt?.branch,
      createdAt: Date.now(),
      busy: false,
      changedFiles: 0,
      items: [],
      origin: options.origin,
      group: options.group,
      depth: options.depth ?? 0,
      files: [],
      lastActivity: Date.now(),
      turns: 0,
    };
    this.dispatch({ t: 'created', chat: view });
    return view;
  }

  /**
   * Sends a message and resolves when the agent's turn ends. A message that
   * starts with an @mention ("@gemini review this") asks that agent instead.
   */
  async send(chatId: string, text: string, images: Attachment[] = []): Promise<void> {
    const mention = parseMention(text);
    if (mention) {
      await this.consult(chatId, mention.agent, mention.text, 'user', images);
      return;
    }
    await this.sendMessage(chatId, text, images);
  }

  private async sendMessage(chatId: string, text: string, images: Attachment[] = []): Promise<void> {
    const chat = this.requireChat(chatId);
    if (chat.busy) throw new Error('This chat is still working on the last message.');
    const ids: string[] = [];
    for (const img of images) {
      const src = imageDataUri(img.mimeType, img.data);
      if (!src) throw new Error(`${img.name || 'An attachment'} is not an image FriedLiver can send.`);
      const id = this.id('you');
      ids.push(id);
      this.addImage(id, src, img.name || 'Attached image', 'you');
    }
    if (!chat.items.some((i) => i.kind === 'user') && text.trim()) this.dispatch({ t: 'title', chatId, title: titleFrom(text) });
    this.items(chatId, [{ kind: 'user', text, images: ids }]);
    const blocks: acp.ContentBlock[] = [];
    if (text) blocks.push({ type: 'text', text });
    for (const img of images) blocks.push({ type: 'image', data: img.data, mimeType: img.mimeType });
    await this.promptBlocks(chatId, blocks);
  }

  async retry(chatId: string): Promise<void> {
    const blocks = this.lastPrompt.get(chatId);
    if (blocks && !this.requireChat(chatId).busy) await this.runPrompt(chatId, blocks);
  }

  /** Stops the chat's turn, and the consultations its agent is waiting on through the FriedLiver tools. */
  async cancel(chatId: string): Promise<void> {
    if (this.chat(chatId)?.busy) this.stopping.add(chatId);
    this.settleChat(chatId);
    if (this.hub.getChat(chatId)) await this.hub.cancel(chatId);
  }

  // ---- Connections between chats ----

  /** Continues the chat with another agent in a new chat; its transcript goes in front of the first message there. */
  handoff(chatId: string, agent: AgentKey): Promise<ChatView> {
    return this.links.handoff(chatId, agent);
  }

  /** Asks another agent from this chat. Resolves with the answer, which also shows in this chat. */
  async consult(chatId: string, agent: AgentKey, text: string, by: 'user' | 'agent' = 'user', images: Attachment[] = []): Promise<string> {
    const srcs = images.map((img) => imageDataUri(img.mimeType, img.data));
    const bad = images.find((_, n) => !srcs[n]);
    if (bad) throw new Error(`${bad.name || 'An attachment'} is not an image FriedLiver can send.`);
    // Shown like any attachment; an agent that can't take images gets the text and says so in its chat.
    images.forEach((img, n) => this.addImage(this.id('you'), srcs[n]!, img.name || 'Attached image', 'you'));
    return this.links.consult(chatId, agent, text, by, { images });
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
  async fanout(agents: AgentKey[], prompt: string, worktree: boolean): Promise<{ group: string; chats: ChatView[]; done: Promise<void> }> {
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
      chats.push(await this.createChat(agent, { worktree: separate, title: prompt, worktreeName: `${agent} ${prompt}`, group }));
    }
    if (shared) for (const c of chats) this.items(c.id, [{ kind: 'notice', tone: 'info', text: shared }]);
    const done = Promise.all(chats.map((c) => this.sendMessage(c.id, prompt).catch((err: unknown) => this.items(c.id, [this.failureNotice(c.agent, err)])))).then(() => {});
    return { group, chats: chats.map((c) => this.requireChat(c.id)), done };
  }

  /** Puts a chat away (or back): its history stays, the board and tabs hide it. */
  archive(chatId: string, archived: boolean): void {
    this.requireChat(chatId);
    this.dispatch({ t: 'archive', chatId, archived });
  }

  /** Stops and forgets a chat. A worktree it had stays on disk; only the record goes. */
  async removeChat(chatId: string): Promise<void> {
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
    this.hub.removeChat(chatId);
    this.dispatch({ t: 'closed', chatId });
  }

  /** The user's answer to an agent's request to reach another agent or chat. */
  answerBridge(requestId: string, answer: 'allow' | 'allowChat' | 'deny'): void {
    this.requests.answer(requestId, answer);
  }

  /** A FriedLiver tool call made by `chatId`'s agent; the bridge server calls this. */
  bridgeCall(chatId: string, call: BridgeCall, signal: AbortSignal): Promise<string> {
    return this.requests.call(chatId, call, signal);
  }

  /** Files the chat proposed or made changes to, as absolute paths. */
  touchedFiles(chatId: string): string[] {
    const chat = this.requireChat(chatId);
    return chat.files.map((f) => path.resolve(chat.cwd, f));
  }

  /** A file's content before the chat changed it: null if the chat created it, undefined if unknown. */
  beforeChat(chatId: string, file: string): string | null | undefined {
    return this.turns.firstBefore(chatId, file);
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
      if (!host) continue;
      this.hub.restoreChat(chat.id, chat.agent, chat.cwd, host.sessionId);
      let view = chat;
      if (host.worktree && existsSync(host.worktree.path)) {
        this.worktrees.set(chat.id, host.worktree);
      } else if (host.worktree || chat.branch) {
        const gone: Item = { kind: 'notice', tone: 'info', text: "This task's worktree is gone, so the chat has no folder of its own any more." };
        view = { ...chat, branch: undefined, items: [...chat.items, gone] };
      }
      if (host.preamble) this.preambles.set(chat.id, host.preamble);
      chats.push(view);
    }
    this.nextId = Math.max(this.nextId, saved.nextId);
    for (const [agent, n] of Object.entries(saved.chatCount) as [AgentKey, number][]) this.chatCount[agent] = Math.max(this.chatCount[agent] ?? 0, n);
    this.turns.continueAfter(chats.flatMap((c) => c.items.flatMap((i) => (i.kind === 'changes' ? [i.turnId] : []))));
    const ids = new Set(chats.map((c) => c.id));
    this.dispatch({ t: 'restore', state: { ...state, chats, links: state.links.filter((l) => ids.has(l.from) && ids.has(l.to)) } });
  }

  answerPermission(requestId: string, optionId: string | null): void {
    const pending = this.permissions.get(requestId);
    // Only an option the agent offered; anything else from a view is ignored.
    if (!pending || (optionId !== null && !pending.options.some((o) => o.optionId === optionId))) return;
    pending.resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
  }

  /** Accept writes `content` (the proposal as the user left it); reject tells the agent no. */
  decideReview(reviewId: string, accept: boolean, content?: string): void {
    this.reviews.get(reviewId)?.resolve({ accept, content });
  }

  decideCommand(commandId: string, approve: boolean): void {
    this.commands.get(commandId)?.resolve(approve);
  }

  /** Restores the files the chat's latest turn changed. */
  async undo(chatId: string, turnId: string): Promise<string[]> {
    if (this.requireChat(chatId).busy) throw new Error('Wait for the agent to finish, or stop it, before undoing.');
    // Checked again: a symlink may have appeared since the turn wrote these files.
    const files = await this.turns.undo(chatId, turnId, {
      write: (f, c) => writeTextFile(this.checkWrite(f), c),
      remove: (f) => rm(this.checkWrite(f), { force: true }),
    });
    this.dispatch({ t: 'undone', chatId, turnId });
    for (const f of files) this.options.ui.fileChanged?.(f);
    return files;
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

  /** Starts the agent and asks for a session (no model call). Never run this automatically. */
  async checkAccount(agent: AgentKey): Promise<AccountStatus> {
    try {
      const r = await this.hub.checkSignIn(agent);
      return r.signedIn ? { status: 'signed-in', methods: [] } : { status: 'needs-sign-in', methods: signInMethods(r.methods) };
    } catch (err) {
      if (err instanceof AgentStartError && err.failure === 'not_installed') {
        return { status: 'not-installed', methods: [], installCommand: err.spec.installCommand, message: err.message };
      }
      return { status: 'error', methods: [], message: messageOf(err) };
    }
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
    this.state = reduce(this.state, action);
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

  private policy(): AgentToAgent {
    return this.options.agentToAgent?.() ?? 'ask';
  }

  /** The FriedLiver tools for a new session: none when they are off or unavailable. */
  private mcpServersFor(chatId: string): acp.McpServer[] {
    const script = this.options.bridgeScript;
    if (!script || !this.bridge || this.policy() === 'off') return [];
    return [
      {
        name: 'friedliver',
        // Like the demo agent: the editor's own runtime, run as plain Node.
        command: process.execPath,
        args: [script],
        env: [
          { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
          { name: BRIDGE_ENV, value: this.bridge.address },
          { name: TOKEN_ENV, value: this.bridge.token(chatId) },
        ],
      },
    ];
  }

  /** Starts the bridge socket before the first session that could use it. A failure only costs the tools. */
  private ensureBridge(): Promise<void> {
    if (!this.options.bridgeScript || this.policy() === 'off') return Promise.resolve();
    this.bridgeStarting ??= BridgeServer.start((chatId, call, signal) => this.bridgeCall(chatId, call, signal), this.options.log).then(
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
    const agent = this.requireChat(chatId).agent;
    this.dispatch({ t: 'busy', chatId, busy: true, at: Date.now() });
    const turnId = this.turns.begin(chatId);
    let notice: Item | null = null;
    let stopReason: acp.StopReason | null = null;
    try {
      await this.ensureBridge();
      const result: acp.PromptResponse = this.stopping.has(chatId) ? { stopReason: 'cancelled' } : await this.hub.prompt(chatId, blocks);
      stopReason = result.stopReason;
      if (result.stopReason !== 'end_turn') notice = { kind: 'notice', tone: 'info', text: `Stopped (${result.stopReason}).` };
    } catch (err) {
      this.settleChat(chatId);
      notice = this.failureNotice(agent, err);
    } finally {
      this.stopping.delete(chatId);
      this.flushOutput();
      // Nothing the agent asked for through the FriedLiver tools waits past its turn.
      this.requests.settle(chatId, false);
      this.dispatch({ t: 'busy', chatId, busy: false, at: Date.now() });
      const changed = this.turns.latest(chatId);
      if (changed?.turnId === turnId) {
        this.dispatch({ t: 'changes', chatId, turnId, files: changed.files });
        this.touch(chatId, changed.files);
      }
      if (notice) this.items(chatId, [notice]);
    }
    const chat = this.chat(chatId);
    // Read the reply before pipes or held forwards give the chat its next message.
    const result: TurnResult = { stopReason, reply: chat ? lastReply(chat) : '' };
    this.links.turnEnded(chatId, result);
    return result;
  }

  private failureNotice(agent: AgentKey, err: unknown): Item {
    const retry: NoticeAction = { label: 'Try again', do: 'retry' };
    if (err instanceof AuthRequiredError) {
      const actions: NoticeAction[] = signInMethods(err.methods)
        .filter((m) => m.kind !== 'key')
        .map((m) => ({ label: m.name, do: 'signIn', agent, methodId: m.id }));
      if (agent !== 'demo') actions.push({ label: 'Use an API key', do: 'apiKey', agent });
      actions.push(retry);
      return { kind: 'notice', tone: 'error', text: err.message, detail: this.spec(agent).loginHint || undefined, actions };
    }
    if (err instanceof AgentStartError && err.failure === 'not_installed') {
      return {
        kind: 'notice',
        tone: 'error',
        text: err.message.split(' Install it with:')[0],
        detail: err.spec.installCommand,
        actions: [...(agent !== 'demo' ? [{ label: 'Install in terminal', do: 'install', agent } satisfies NoticeAction] : []), retry],
      };
    }
    return { kind: 'notice', tone: 'error', text: messageOf(err), actions: [retry] };
  }

  /** A cancelled or failed turn must not leave reviews, commands or tool requests waiting forever. */
  private settleChat(chatId: string): void {
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

  private async readForAgent(req: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const file = this.checkPath(req.path);
    const unsaved = this.options.ui.unsavedText?.(file);
    if (unsaved === undefined) {
      // Regular files of a sane size only: not a FIFO that never ends, not gigabytes into memory.
      const info = await stat(file);
      if (!info.isFile()) throw new Error(`${file} is not a regular file.`);
      if (info.size > MAX_AGENT_READ_BYTES) throw new Error(`${file} is ${Math.round(info.size / 1048576)} MB, more than an agent can read through FriedLiver at once.`);
      return readTextFile({ ...req, path: file });
    }
    if (req.line == null && req.limit == null) return { content: unsaved };
    const lines = unsaved.split('\n');
    const start = Math.max(0, (req.line ?? 1) - 1);
    return { content: lines.slice(start, req.limit == null ? lines.length : start + req.limit).join('\n') };
  }

  private askPermission(chatId: string, req: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    const requestId = this.id('perm');
    const title = req.toolCall.title ?? 'The agent wants to use a tool';
    return new Promise((resolve) => {
      const options = req.options;
      this.permissions.set(requestId, {
        chatId,
        options,
        resolve: (answer) => {
          if (!this.permissions.delete(requestId)) return;
          const chosen = answer.outcome.outcome === 'selected' ? options.find((o) => o.optionId === (answer.outcome as { optionId: string }).optionId) : undefined;
          this.dispatch({ t: 'permissionAnswered', requestId, answer: chosen?.name ?? 'Cancelled' });
          resolve(answer);
        },
      });
      signal.addEventListener('abort', () => this.answerPermission(requestId, null), { once: true });
      this.items(chatId, [
        {
          kind: 'permission',
          requestId,
          toolCallId: req.toolCall.toolCallId,
          title,
          options: options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
        },
      ]);
      const chat = this.chat(chatId);
      this.options.ui.askPermission?.({ chatId, requestId, agentLabel: chat?.label ?? 'The agent', title });
    });
  }

  /** Every agent write waits for review in a diff, and is recorded so the turn can be undone. */
  private async reviewWrite(chatId: string | undefined, req: acp.WriteTextFileRequest): Promise<void> {
    const file = this.checkWrite(req.path);
    const before = await readIfExists(file);
    const reviewId = this.id('review');
    const chat = chatId ? this.chat(chatId) : undefined;
    const review: PendingReview = { reviewId, chatId, path: file, before, proposed: req.content, agentLabel: chat?.label ?? 'Agent' };
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

  /** Nothing an agent asks to run starts before the user approves it. */
  private commandHooks(agentId: AgentKey): TerminalListener {
    const known = new Map<string, { commandId: string; startedAt?: number }>();
    return {
      approve: (info) => {
        const commandId = this.id('cmd');
        const chatId = this.hub.chatIdForSession(info.sessionId, agentId);
        known.set(info.terminalId, { commandId });
        const outside = insideRoots(info.cwd, this.roots()) === null;
        if (chatId) this.items(chatId, [{ kind: 'command', commandId, commandLine: info.commandLine, cwd: info.cwd, outside, state: 'awaiting', output: '' }]);
        const agentLabel = (chatId && this.chat(chatId)?.label) || this.label(agentId);
        this.options.ui.askCommand?.({ chatId, commandId, agentLabel, commandLine: info.commandLine });
        return new Promise<boolean>((resolve) => {
          this.commands.set(commandId, {
            chatId,
            resolve: (ok) => {
              if (!this.commands.delete(commandId)) return;
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

  private addImage(id: string, src: string, title: string, from: 'agent' | 'you'): void {
    this.shownImages.add(id);
    this.dispatch({ t: 'image', image: { id, src, title, from } });
  }

  /** Images the agent sends or reads go to the Images view. */
  private async collectImages(update: acp.SessionUpdate): Promise<void> {
    // The agent names the type; only the image types the views show are taken (see imageDataUri).
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'image') {
      const src = imageDataUri(update.content.mimeType, update.content.data);
      if (src) this.addImage(this.id('msg'), src, 'From the agent', 'agent');
      return;
    }
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
    for (const item of update.content ?? []) {
      if (item.type === 'content' && item.content.type === 'image') {
        const src = imageDataUri(item.content.mimeType, item.content.data);
        if (src) this.addImage(this.id('tool'), src, update.title ?? 'Tool output', 'agent');
      }
    }
    for (const loc of update.locations ?? []) {
      const type = IMAGE_TYPES[path.extname(loc.path).toLowerCase()];
      const file = type && insideRoots(loc.path, this.roots());
      if (!file || this.shownImages.has(file)) continue;
      try {
        // Size first: a huge file named .png must not be read into memory.
        const info = await stat(file);
        if (!info.isFile() || info.size > MAX_IMAGE_BYTES) continue;
        const bytes = await readFile(file);
        if (bytes.length <= MAX_IMAGE_BYTES) this.addImage(file, `data:${type};base64,${bytes.toString('base64')}`, path.basename(file), 'agent');
      } catch {
        // The agent may report paths that don't exist yet.
      }
    }
  }
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
