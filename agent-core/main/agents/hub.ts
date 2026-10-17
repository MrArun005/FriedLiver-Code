import type * as acp from '@agentclientprotocol/sdk';
import { AgentConnection, isAuthRequired, type ClientHost, type SessionSetup } from './agentConnection';
import type { AgentId, AgentSpec } from './registry';
import type { TerminalListener } from './terminals';

export class AuthRequiredError extends Error {
  constructor(
    readonly spec: AgentSpec,
    readonly methods: acp.AuthMethod[],
  ) {
    super(`${spec.label} needs you to sign in.`);
  }
}

/** A chat's session, new or reloaded, as the agent describes it. */
export interface SessionStart extends SessionSetup {
  /** `session/load` brought back the chat's earlier session. */
  loaded: boolean;
  /** The agent was restarted, so this replaces a session the chat had. */
  replaced: boolean;
  /** The agent takes a message while it works (`_session/steering`). */
  steering: boolean;
  agentInfo?: { name: string; version: string };
}

/** No session to change: the chat's agent hasn't started one yet, or was restarted since. */
export class NoSessionError extends Error {
  constructor() {
    super('The agent has no session for this chat yet.');
  }
}

/** Updates about the session itself, not the transcript: kept even while `session/load` replays history. */
const SESSION_STATE_UPDATES = new Set(['config_option_update', 'current_mode_update', 'available_commands_update', 'usage_update', 'session_info_update']);

export interface HubEvents {
  update(chatId: string, update: acp.SessionUpdate): void;
  /** A session started or was reloaded. Awaited before the chat's first prompt goes out, so choices can be applied. */
  session?(chatId: string, start: SessionStart): Promise<void> | void;
  permission(chatId: string, req: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse>;
  /** A form the agent asks the user to fill in; declined when not given. */
  elicit?(chatId: string, req: acp.CreateElicitationRequest, signal: AbortSignal): Promise<acp.CreateElicitationResponse>;
  notice(chatId: string, text: string): void;
  agentsChanged(): void;
  agentStderr?(agentId: AgentId, line: string): void;
}

export interface FileHost {
  read(req: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse>;
  write(chatId: string | undefined, req: acp.WriteTextFileRequest): Promise<void>;
}

export interface HubOptions {
  cwd: string;
  clientVersion: string;
  resolveSpec(id: AgentId): AgentSpec;
  /** Stop an agent after this long without a turn. 0 keeps it running. */
  idleStopMs: number;
  /** Soft cap on agent processes; the least recently used idle one is stopped first. */
  maxRunning: number;
  events: HubEvents;
  files: FileHost;
  terminalListener?(agentId: AgentId): TerminalListener;
  /**
   * MCP servers a chat's session gets, e.g. FriedLiver's own tools. Asked whenever the chat gets a session;
   * `agent.http` says whether its agent takes HTTP servers.
   */
  mcpServersFor?(chatId: string, agent: { http: boolean }): acp.McpServer[] | Promise<acp.McpServer[]>;
  log?(line: string): void;
}

export interface Chat {
  readonly id: string;
  readonly agentId: AgentId;
  /** Folder the agent works in: the open folder, or a task's own git worktree. */
  readonly cwd: string;
  busy: boolean;
}

interface ChatState extends Chat {
  sessionId?: string;
  /** Which agent process the session belongs to; a restarted agent needs a new or reloaded session. */
  sessionGeneration?: number;
  /** While `session/load` replays history, its updates are dropped: the panel already shows them. */
  loading: boolean;
  /** Stop was pressed before the turn reached the agent, e.g. while it was still starting. */
  cancelled?: boolean;
  /** A session on its way: a prompt and an early start share it. */
  starting?: Promise<void>;
}

interface RunningAgent {
  readonly id: AgentId;
  readonly conn: AgentConnection;
  readonly generation: number;
  activeTurns: number;
  lastUsed: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export interface RunningAgentInfo {
  id: AgentId;
  label: string;
  pid?: number;
  busy: boolean;
}

/**
 * Starts agents when a chat first needs them, routes their traffic to chats,
 * and stops them when idle so they don't hold memory.
 */
export class AgentHub {
  private readonly agents = new Map<AgentId, RunningAgent>();
  private readonly starting = new Map<AgentId, Promise<RunningAgent>>();
  private readonly chats = new Map<string, ChatState>();
  /**
   * Keyed by agent and session ID. Session IDs come from the agents, so two agents can
   * pick the same one, and one agent must never reach (or pose as) another's chat.
   */
  private readonly sessionToChat = new Map<string, string>();
  private nextChat = 1;
  private nextGeneration = 1;
  private disposed = false;

  constructor(private readonly options: HubOptions) {}

  configure(settings: Partial<Pick<HubOptions, 'idleStopMs' | 'maxRunning'>>): void {
    Object.assign(this.options, settings);
    for (const agent of this.agents.values()) this.scheduleIdleStop(agent);
  }

  createChat(agentId: AgentId, cwd = this.options.cwd): Chat {
    const chat: ChatState = { id: `chat-${this.nextChat++}`, agentId, cwd, busy: false, loading: false };
    this.chats.set(chat.id, chat);
    return chat;
  }

  /**
   * Brings back a chat from an earlier window under its old id. Given the
   * session it had, the next prompt reloads that session when the agent can,
   * and otherwise starts a new one and says so.
   */
  restoreChat(id: string, agentId: AgentId, cwd: string, sessionId?: string): Chat {
    if (this.chats.has(id)) throw new Error(`Chat ${id} already exists.`);
    const chat: ChatState = { id, agentId, cwd, busy: false, loading: false, sessionId };
    this.chats.set(id, chat);
    if (sessionId) this.sessionToChat.set(sessionKey(agentId, sessionId), id);
    // New chats must not take a restored chat's id.
    const n = Number(/^chat-(\d+)$/.exec(id)?.[1]);
    if (n >= this.nextChat) this.nextChat = n + 1;
    return chat;
  }

  /** Forgets a chat. Its agent keeps running for the others; stop a busy chat's turn first. */
  removeChat(chatId: string): void {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    this.chats.delete(chatId);
    if (chat.sessionId) this.sessionToChat.delete(sessionKey(chat.agentId, chat.sessionId));
  }

  getChat(chatId: string): Chat | undefined {
    return this.chats.get(chatId);
  }

  /** The agent's id for the chat's session, kept so a later window can reload it. */
  sessionId(chatId: string): string | undefined {
    return this.chats.get(chatId)?.sessionId;
  }

  /** The chat a session belongs to, only if that agent owns it. */
  chatIdForSession(sessionId: string, agentId: AgentId): string | undefined {
    return this.sessionToChat.get(sessionKey(agentId, sessionId));
  }

  async prompt(chatId: string, blocks: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    const chat = this.requireChat(chatId);
    if (chat.busy) throw new Error('This chat is still working on the last message.');
    chat.busy = true;
    chat.cancelled = false;
    let agent: RunningAgent | undefined;
    try {
      agent = await this.ensureAgent(chat.agentId);
      agent.activeTurns++;
      this.clearIdleStop(agent);
      await this.ensureSession(chat, agent);
      if (chat.cancelled) return { stopReason: 'cancelled' };
      return await agent.conn.prompt(chat.sessionId!, this.fitToAgent(chat, agent, blocks));
    } catch (err) {
      if (agent && isAuthRequired(err)) throw new AuthRequiredError(agent.conn.spec, agent.conn.authMethods);
      throw err;
    } finally {
      chat.busy = false;
      if (agent) {
        agent.activeTurns--;
        agent.lastUsed = Date.now();
        this.scheduleIdleStop(agent);
      }
    }
  }

  /**
   * Starts the chat's agent and session without a turn, so its options are
   * known before the first message and a sign-in problem shows at once.
   */
  async startSession(chatId: string): Promise<void> {
    const chat = this.requireChat(chatId);
    let agent: RunningAgent | undefined;
    try {
      agent = await this.ensureAgent(chat.agentId);
      await this.ensureSession(chat, agent);
    } catch (err) {
      if (agent && isAuthRequired(err)) throw new AuthRequiredError(agent.conn.spec, agent.conn.authMethods);
      throw err;
    } finally {
      if (agent) {
        agent.lastUsed = Date.now();
        this.scheduleIdleStop(agent);
      }
    }
  }

  /** Whether the chat's session is live in its agent's current process. */
  hasSession(chatId: string): boolean {
    return this.live(this.requireChat(chatId)) !== undefined;
  }

  /** Changes one of the session's config options; returns the agent's whole new list. */
  async setConfigOption(chatId: string, configId: string, value: string | boolean): Promise<acp.SessionConfigOption[]> {
    const { agent, sessionId } = this.requireLive(chatId);
    return agent.conn.setConfigOption(sessionId, configId, value);
  }

  async setMode(chatId: string, modeId: string): Promise<void> {
    const { agent, sessionId } = this.requireLive(chatId);
    await agent.conn.setMode(sessionId, modeId);
  }

  async setModel(chatId: string, modelId: string): Promise<void> {
    const { agent, sessionId } = this.requireLive(chatId);
    await agent.conn.setModel(sessionId, modelId);
  }

  /** Adds a message to the running turn. False when the agent had no turn running, so it wasn't taken. */
  async steer(chatId: string, blocks: acp.ContentBlock[]): Promise<boolean> {
    const chat = this.requireChat(chatId);
    const { agent, sessionId } = this.requireLive(chatId);
    if (!agent.conn.supportsSteering) return false;
    return agent.conn.steer(sessionId, this.fitToAgent(chat, agent, blocks));
  }

  async cancel(chatId: string): Promise<void> {
    const chat = this.requireChat(chatId);
    // Before the session exists there is nothing to tell the agent; the turn stops once it does.
    if (chat.busy) chat.cancelled = true;
    const agent = this.agents.get(chat.agentId);
    if (chat.sessionId && agent?.conn.running) await agent.conn.cancel(chat.sessionId);
  }

  async authMethods(agentId: AgentId): Promise<acp.AuthMethod[]> {
    return (await this.ensureAgent(agentId)).conn.authMethods;
  }

  async authenticate(agentId: AgentId, methodId: string): Promise<void> {
    const agent = await this.ensureAgent(agentId);
    await agent.conn.authenticate(methodId);
  }

  /**
   * Whether the agent is signed in, by asking for a session (no model call).
   * The probe session is never used.
   */
  async checkSignIn(agentId: AgentId): Promise<{ signedIn: true } | { signedIn: false; methods: acp.AuthMethod[] }> {
    const agent = await this.ensureAgent(agentId);
    try {
      const probe = await agent.conn.newSession(this.options.cwd);
      // Claude lists every session in its history; don't leave a probe there when it can be closed.
      if (agent.conn.supportsCloseSession) await agent.conn.closeSession(probe.sessionId).catch(() => {});
      return { signedIn: true };
    } catch (err) {
      if (isAuthRequired(err)) return { signedIn: false, methods: agent.conn.authMethods };
      throw err;
    }
  }

  /** The running adapter's name and version, from `initialize`. */
  agentInfo(agentId: AgentId): { name: string; version: string } | undefined {
    const info = this.agents.get(agentId)?.conn.info.agentInfo;
    return info ? { name: info.name, version: info.version } : undefined;
  }

  running(): RunningAgentInfo[] {
    return [...this.agents.values()].map((a) => ({
      id: a.id,
      label: a.conn.spec.label,
      pid: a.conn.pid,
      busy: a.activeTurns > 0,
    }));
  }

  /** Ctrl+C from a mirrored terminal: stop that agent's newest command. */
  interruptCommand(agentId: AgentId): boolean {
    return this.agents.get(agentId)?.conn.terminals.interruptLatest() ?? false;
  }

  async stopAgent(agentId: AgentId): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    this.clearIdleStop(agent);
    this.agents.delete(agentId);
    await agent.conn.stop();
    this.options.events.agentsChanged();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.agents.keys()].map((id) => this.stopAgent(id)));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled(this.starting.values());
    await this.stopAll();
  }

  private requireChat(chatId: string): ChatState {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Error(`Unknown chat ${chatId}`);
    return chat;
  }

  private live(chat: ChatState): { agent: RunningAgent; sessionId: string } | undefined {
    const agent = this.agents.get(chat.agentId);
    if (!agent?.conn.running || !chat.sessionId || chat.sessionGeneration !== agent.generation) return undefined;
    return { agent, sessionId: chat.sessionId };
  }

  private requireLive(chatId: string): { agent: RunningAgent; sessionId: string } {
    const live = this.live(this.requireChat(chatId));
    if (!live) throw new NoSessionError();
    return live;
  }

  private ensureAgent(agentId: AgentId): Promise<RunningAgent> {
    const running = this.agents.get(agentId);
    if (running?.conn.running) return Promise.resolve(running);
    let pending = this.starting.get(agentId);
    if (!pending) {
      pending = this.startAgent(agentId).finally(() => this.starting.delete(agentId));
      this.starting.set(agentId, pending);
    }
    return pending;
  }

  private async startAgent(agentId: AgentId): Promise<RunningAgent> {
    if (this.disposed) throw new Error('FriedLiver is shutting down.');
    await this.makeRoom(agentId);
    const spec = this.options.resolveSpec(agentId);
    this.options.log?.(`Starting ${spec.label}: ${[spec.command, ...spec.args].join(' ')}`);
    const conn = await AgentConnection.start(spec, {
      cwd: this.options.cwd,
      clientVersion: this.options.clientVersion,
      host: this.hostFor(agentId),
      log: this.options.log,
      onStderr: (line) => this.options.events.agentStderr?.(agentId, line),
    });
    if (this.disposed) {
      await conn.stop();
      throw new Error('FriedLiver is shutting down.');
    }
    const agent: RunningAgent = {
      id: agentId,
      conn,
      generation: this.nextGeneration++,
      activeTurns: 0,
      lastUsed: Date.now(),
    };
    this.agents.set(agentId, agent);
    void conn.exited.then(() => {
      if (this.agents.get(agentId) !== agent) return;
      this.clearIdleStop(agent);
      this.agents.delete(agentId);
      this.options.log?.(`${spec.label} exited.`);
      this.options.events.agentsChanged();
    });
    this.options.events.agentsChanged();
    return agent;
  }

  private async makeRoom(agentId: AgentId): Promise<void> {
    // Agents starting at the same moment count against the limit too.
    const othersStarting = [...this.starting.keys()].filter((id) => id !== agentId).length;
    const excess = this.agents.size + othersStarting + 1 - Math.max(1, this.options.maxRunning);
    if (excess <= 0) return;
    const idle = [...this.agents.values()]
      .filter((a) => a.activeTurns === 0)
      .sort((a, b) => a.lastUsed - b.lastUsed)
      .slice(0, excess);
    for (const agent of idle) {
      this.options.log?.(`Stopping ${agent.conn.spec.label} to stay within the agent limit.`);
      await this.stopAgent(agent.id);
    }
  }

  private ensureSession(chat: ChatState, agent: RunningAgent): Promise<void> {
    if (chat.sessionId && chat.sessionGeneration === agent.generation) return Promise.resolve();
    chat.starting ??= this.openSession(chat, agent).finally(() => {
      chat.starting = undefined;
    });
    return chat.starting;
  }

  private async openSession(chat: ChatState, agent: RunningAgent): Promise<void> {
    const previous = chat.sessionId;
    const { cwd } = chat;
    const mcpServers = (await this.options.mcpServersFor?.(chat.id, { http: agent.conn.supportsHttpMcp })) ?? [];

    if (previous && agent.conn.supportsLoadSession) {
      chat.loading = true;
      let setup: SessionSetup | undefined;
      try {
        setup = await agent.conn.loadSession(previous, cwd, mcpServers);
        chat.sessionGeneration = agent.generation;
      } catch (err) {
        if (isAuthRequired(err)) throw err;
        this.options.log?.(`Couldn't reload session ${previous}: ${String(err)}`);
      } finally {
        chat.loading = false;
      }
      if (setup) {
        await this.announce(chat, agent, { ...setup, loaded: true, replaced: false });
        return;
      }
    }

    const session = await agent.conn.newSession(cwd, mcpServers);
    if (previous) {
      this.sessionToChat.delete(sessionKey(chat.agentId, previous));
      this.options.events.notice(
        chat.id,
        `${agent.conn.spec.label} was restarted, so this chat continues in a new session. It won't remember the earlier messages.`,
      );
    }
    chat.sessionId = session.sessionId;
    chat.sessionGeneration = agent.generation;
    this.sessionToChat.set(sessionKey(chat.agentId, session.sessionId), chat.id);
    await this.announce(chat, agent, { configOptions: session.configOptions, modes: session.modes, models: session.models, loaded: false, replaced: previous !== undefined });
  }

  /** Tells the editor what the session offers. Its handler may set options; a failure there doesn't stop the turn. */
  private async announce(chat: ChatState, agent: RunningAgent, start: Omit<SessionStart, 'steering' | 'agentInfo'>): Promise<void> {
    const info = agent.conn.info.agentInfo;
    try {
      await this.options.events.session?.(chat.id, {
        ...start,
        steering: agent.conn.supportsSteering,
        agentInfo: info ? { name: info.name, version: info.version } : undefined,
      });
    } catch (err) {
      this.options.log?.(`Couldn't apply the chat's choices to ${agent.conn.spec.label}: ${String(err)}`);
    }
  }

  private fitToAgent(chat: ChatState, agent: RunningAgent, blocks: acp.ContentBlock[]): acp.ContentBlock[] {
    if (agent.conn.supportsImages || !blocks.some((b) => b.type === 'image')) return blocks;
    this.options.events.notice(chat.id, `${agent.conn.spec.label} can't take images here, so only the text was sent.`);
    return blocks.filter((b) => b.type !== 'image');
  }

  private hostFor(agentId: AgentId): ClientHost {
    const { events, files } = this.options;
    const chatFor = (sessionId: string) => {
      const chatId = this.chatIdForSession(sessionId, agentId);
      return chatId ? this.chats.get(chatId) : undefined;
    };
    return {
      sessionUpdate: ({ sessionId, update }) => {
        const chat = chatFor(sessionId);
        if (chat && (!chat.loading || SESSION_STATE_UPDATES.has(update.sessionUpdate))) events.update(chat.id, update);
      },
      requestPermission: async (req, signal) => {
        const chat = chatFor(req.sessionId);
        if (!chat) return { outcome: { outcome: 'cancelled' } };
        return events.permission(chat.id, req, signal);
      },
      createElicitation: async (req, signal) => {
        // Only questions about one of this agent's sessions; one tied to another request has no chat to ask in.
        const sessionId = (req as { sessionId?: unknown }).sessionId;
        const chat = typeof sessionId === 'string' ? chatFor(sessionId) : undefined;
        if (!chat || !events.elicit || req.mode !== 'form') return { action: 'decline' };
        return events.elicit(chat.id, req, signal);
      },
      readTextFile: (req) => files.read(req),
      writeTextFile: (req) => files.write(chatFor(req.sessionId)?.id, req),
      terminalListener: this.options.terminalListener?.(agentId),
    };
  }

  private scheduleIdleStop(agent: RunningAgent): void {
    this.clearIdleStop(agent);
    const ms = this.options.idleStopMs;
    if (ms <= 0 || agent.activeTurns > 0) return;
    agent.idleTimer = setTimeout(() => {
      if (agent.activeTurns === 0 && this.agents.get(agent.id) === agent) {
        this.options.log?.(`Stopping ${agent.conn.spec.label} after ${Math.round(ms / 60000)} idle minutes.`);
        void this.stopAgent(agent.id);
      }
    }, ms);
    agent.idleTimer.unref?.();
  }

  private clearIdleStop(agent: RunningAgent): void {
    if (agent.idleTimer) clearTimeout(agent.idleTimer);
    agent.idleTimer = undefined;
  }
}

function sessionKey(agentId: AgentId, sessionId: string): string {
  return `${agentId}:${sessionId}`;
}
