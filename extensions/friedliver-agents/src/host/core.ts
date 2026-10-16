import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { AgentStartError } from '@friedliver/main/agents/agentConnection';
import { readIfExists, readTextFile, writeTextFile } from '@friedliver/main/agents/fileAccess';
import { AgentHub, AuthRequiredError } from '@friedliver/main/agents/hub';
import { DEFAULT_AGENTS, demoAgentSpec, type AgentSpec, type VendorAgentId } from '@friedliver/main/agents/registry';
import { allowedExternal, signInMethods } from '@friedliver/main/agents/signIn';
import type { TerminalListener } from '@friedliver/main/agents/terminals';
import { TurnLog } from '@friedliver/main/agents/turnLog';
import * as git from '@friedliver/main/workspace/git';
import type { Attachment } from '../shared/messages';
import {
  AGENT_FACES,
  EMPTY_STATE,
  decisions,
  lineStats,
  reduce,
  titleFrom,
  type Action,
  type AgentKey,
  type AppState,
  type ChatView,
  type Decision,
  type Item,
  type NoticeAction,
} from '../shared/model';
import { insideRoots } from './paths';

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
 * undo through TurnLog, and tasks in their own git worktrees.
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
          this.dispatch({ t: 'update', chatId, update });
          void this.collectImages(update);
        },
        notice: (chatId, text) => this.dispatch({ t: 'items', chatId, items: [{ kind: 'notice', text, tone: 'info' }] }),
        agentsChanged: () => {},
        agentStderr: (agentId, line) => {
          if (!this.signingIn.has(agentId)) return;
          for (const url of line.match(/https:\/\/[^\s"'<>)]+/g) ?? []) {
            if (allowedExternal(url)) options.ui.signInUrl?.(agentId, url);
          }
        },
        permission: (chatId, req, signal) => this.askPermission(chatId, req, signal),
      },
      files: {
        read: (req) => this.readForAgent(req),
        write: (chatId, req) => this.reviewWrite(chatId, req),
      },
      terminalListener: (agentId) => this.commandHooks(agentId),
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
    return [...this.options.folders(), ...[...this.worktrees.values()].map((w) => w.path)];
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

  async createChat(agent: AgentKey, options: { worktree?: boolean; title?: string } = {}): Promise<ChatView> {
    const folder = this.options.folders()[0];
    if (!folder) throw new Error('Open a folder first. Agents work inside the folder you open.');
    let cwd = folder;
    let wt: TaskWorktree | undefined;
    if (options.worktree) {
      const repo = await git.repoRoot(folder);
      if (!repo) throw new Error('A separate worktree needs a git repository. Run `git init` and commit once, or untick the option.');
      const title = options.title ?? 'task';
      wt = { ...(await git.createWorktree(repo, title)), repo, title };
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
    };
    this.dispatch({ t: 'created', chat: view });
    return view;
  }

  /** Sends a message and resolves when the agent's turn ends. */
  async send(chatId: string, text: string, images: Attachment[] = []): Promise<void> {
    const chat = this.requireChat(chatId);
    if (chat.busy) throw new Error('This chat is still working on the last message.');
    const ids: string[] = [];
    for (const img of images) {
      const id = this.id('you');
      ids.push(id);
      this.addImage(id, `data:${img.mimeType};base64,${img.data}`, img.name || 'Attached image', 'you');
    }
    if (!chat.items.some((i) => i.kind === 'user') && text.trim()) this.dispatch({ t: 'title', chatId, title: titleFrom(text) });
    this.dispatch({ t: 'items', chatId, items: [{ kind: 'user', text, images: ids }] });
    const blocks: acp.ContentBlock[] = [];
    if (text) blocks.push({ type: 'text', text });
    for (const img of images) blocks.push({ type: 'image', data: img.data, mimeType: img.mimeType });
    this.lastPrompt.set(chatId, blocks);
    await this.runPrompt(chatId, blocks);
  }

  async retry(chatId: string): Promise<void> {
    const blocks = this.lastPrompt.get(chatId);
    if (blocks && !this.requireChat(chatId).busy) await this.runPrompt(chatId, blocks);
  }

  async cancel(chatId: string): Promise<void> {
    this.settleChat(chatId);
    await this.hub.cancel(chatId);
  }

  answerPermission(requestId: string, optionId: string | null): void {
    this.permissions.get(requestId)?.resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
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
    const files = await this.turns.undo(chatId, turnId, {
      write: (f, c) => writeTextFile(f, c),
      remove: (f) => rm(f, { force: true }),
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
    if (this.requireChat(chatId).busy) throw new Error('Wait for the agent to finish before merging.');
    await git.mergeWorktree(wt.repo, wt, `FriedLiver task: ${wt.title}`);
    this.dispatch({ t: 'worktree', chatId, branch: wt.branch, merged: true });
    this.options.ui.fileChanged?.(wt.repo);
  }

  async removeWorktree(chatId: string): Promise<void> {
    const wt = this.worktrees.get(chatId);
    if (!wt) throw new Error('This task has no worktree.');
    if (this.requireChat(chatId).busy) await this.cancel(chatId);
    await git.removeWorktree(wt.repo, wt);
    this.worktrees.delete(chatId);
    this.dispatch({ t: 'worktree', chatId, branch: undefined });
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
    const spec = this.spec(agent);
    return { command: spec.command, args: [...spec.args, ...(method.args ?? [])], env: { ...spec.env, ...method.env } };
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
  }

  // ---- Internals ----

  private dispatch(action: Action): void {
    this.state = reduce(this.state, action);
    for (const listener of this.listeners) listener(action, this.state);
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

  private async runPrompt(chatId: string, blocks: acp.ContentBlock[]): Promise<void> {
    const agent = this.requireChat(chatId).agent;
    this.dispatch({ t: 'busy', chatId, busy: true });
    const turnId = this.turns.begin(chatId);
    let notice: Item | null = null;
    try {
      const result = await this.hub.prompt(chatId, blocks);
      if (result.stopReason !== 'end_turn') notice = { kind: 'notice', tone: 'info', text: `Stopped (${result.stopReason}).` };
    } catch (err) {
      this.settleChat(chatId);
      notice = this.failureNotice(agent, err);
    } finally {
      this.flushOutput();
      this.dispatch({ t: 'busy', chatId, busy: false });
      const changed = this.turns.latest(chatId);
      if (changed?.turnId === turnId) this.dispatch({ t: 'changes', chatId, turnId, files: changed.files });
      if (notice) this.dispatch({ t: 'items', chatId, items: [notice] });
    }
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
        actions: [{ label: 'Install in terminal', do: 'install', command: err.spec.installCommand }, retry],
      };
    }
    return { kind: 'notice', tone: 'error', text: messageOf(err), actions: [retry] };
  }

  /** A cancelled or failed turn must not leave reviews or commands waiting forever. */
  private settleChat(chatId: string): void {
    for (const p of [...this.permissions.values()]) if (p.chatId === chatId) p.resolve({ outcome: { outcome: 'cancelled' } });
    for (const p of [...this.reviews.values()]) if (p.chatId === chatId) p.resolve({ accept: false });
    for (const p of [...this.commands.values()]) if (p.chatId === chatId) p.resolve(false);
  }

  private checkPath(file: string): string {
    const resolved = insideRoots(file, this.roots());
    if (!resolved) throw new Error(`${file} is outside the workspace folders, so FriedLiver won't let the agent touch it.`);
    return resolved;
  }

  private async readForAgent(req: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const file = this.checkPath(req.path);
    const unsaved = this.options.ui.unsavedText?.(file);
    if (unsaved === undefined) return readTextFile({ ...req, path: file });
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
      this.dispatch({
        t: 'items',
        chatId,
        items: [
          {
            kind: 'permission',
            requestId,
            toolCallId: req.toolCall.toolCallId,
            title,
            options: options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
          },
        ],
      });
      const chat = this.chat(chatId);
      this.options.ui.askPermission?.({ chatId, requestId, agentLabel: chat?.label ?? 'The agent', title });
    });
  }

  /** Every agent write waits for review in a diff, and is recorded so the turn can be undone. */
  private async reviewWrite(chatId: string | undefined, req: acp.WriteTextFileRequest): Promise<void> {
    const file = this.checkPath(req.path);
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
        this.dispatch({ t: 'items', chatId, items: [{ kind: 'review', reviewId, path: file, ...stats, isNew: before === null, state: 'pending' }] });
      }
      this.options.ui.showReview(review);
    });
    if (!decision.accept) throw new Error(`The user rejected the change to ${file}.`);
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
        const chatId = this.hub.chatIdForSession(info.sessionId);
        known.set(info.terminalId, { commandId });
        const outside = insideRoots(info.cwd, this.roots()) === null;
        if (chatId) {
          this.dispatch({
            t: 'items',
            chatId,
            items: [{ kind: 'command', commandId, commandLine: info.commandLine, cwd: info.cwd, outside, state: 'awaiting', output: '' }],
          });
        }
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
    this.output.set(commandId, (this.output.get(commandId) ?? '') + data);
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
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'image') {
      this.addImage(this.id('msg'), `data:${update.content.mimeType};base64,${update.content.data}`, 'From the agent', 'agent');
      return;
    }
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
    for (const item of update.content ?? []) {
      if (item.type === 'content' && item.content.type === 'image') {
        this.addImage(this.id('tool'), `data:${item.content.mimeType};base64,${item.content.data}`, update.title ?? 'Tool output', 'agent');
      }
    }
    for (const loc of update.locations ?? []) {
      const type = IMAGE_TYPES[path.extname(loc.path).toLowerCase()];
      const file = type && insideRoots(loc.path, this.roots());
      if (!file || this.shownImages.has(file)) continue;
      try {
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
