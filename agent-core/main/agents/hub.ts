import type * as acp from '@agentclientprotocol/sdk';
import { AgentConnection, isAuthRequired, type ClientHost } from './agentConnection';
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

export interface HubEvents {
  update(chatId: string, update: acp.SessionUpdate): void;
  permission(chatId: string, req: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse>;
  notice(chatId: string, text: string): void;
  agentsChanged(): void;
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
  log?(line: string): void;
}

export interface Chat {
  readonly id: string;
  readonly agentId: AgentId;
  busy: boolean;
}

interface ChatState extends Chat {
  sessionId?: string;
  /** Which agent process the session belongs to; a restarted agent needs a new or reloaded session. */
  sessionGeneration?: number;
  /** While `session/load` replays history, its updates are dropped: the panel already shows them. */
  loading: boolean;
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
  private readonly sessionToChat = new Map<string, string>();
  private nextChat = 1;
  private nextGeneration = 1;
  private disposed = false;

  constructor(private readonly options: HubOptions) {}

  configure(settings: Partial<Pick<HubOptions, 'idleStopMs' | 'maxRunning'>>): void {
    Object.assign(this.options, settings);
    for (const agent of this.agents.values()) this.scheduleIdleStop(agent);
  }

  createChat(agentId: AgentId): Chat {
    const chat: ChatState = { id: `chat-${this.nextChat++}`, agentId, busy: false, loading: false };
    this.chats.set(chat.id, chat);
    return chat;
  }

  getChat(chatId: string): Chat | undefined {
    return this.chats.get(chatId);
  }

  async prompt(chatId: string, blocks: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    const chat = this.requireChat(chatId);
    if (chat.busy) throw new Error('This chat is still working on the last message.');
    chat.busy = true;
    let agent: RunningAgent | undefined;
    try {
      agent = await this.ensureAgent(chat.agentId);
      agent.activeTurns++;
      this.clearIdleStop(agent);
      await this.ensureSession(chat, agent);
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

  async cancel(chatId: string): Promise<void> {
    const chat = this.requireChat(chatId);
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
    await this.makeRoom();
    const spec = this.options.resolveSpec(agentId);
    this.options.log?.(`Starting ${spec.label}: ${[spec.command, ...spec.args].join(' ')}`);
    const conn = await AgentConnection.start(spec, {
      cwd: this.options.cwd,
      clientVersion: this.options.clientVersion,
      host: this.hostFor(agentId),
      log: this.options.log,
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

  private async makeRoom(): Promise<void> {
    const excess = this.agents.size + 1 - Math.max(1, this.options.maxRunning);
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

  private async ensureSession(chat: ChatState, agent: RunningAgent): Promise<void> {
    if (chat.sessionId && chat.sessionGeneration === agent.generation) return;
    const previous = chat.sessionId;
    const { cwd } = this.options;

    if (previous && agent.conn.supportsLoadSession) {
      chat.loading = true;
      try {
        await agent.conn.loadSession(previous, cwd);
        chat.sessionGeneration = agent.generation;
        return;
      } catch (err) {
        if (isAuthRequired(err)) throw err;
        this.options.log?.(`Couldn't reload session ${previous}: ${String(err)}`);
      } finally {
        chat.loading = false;
      }
    }

    const session = await agent.conn.newSession(cwd);
    if (previous) {
      this.sessionToChat.delete(previous);
      this.options.events.notice(
        chat.id,
        `${agent.conn.spec.label} was restarted, so this chat continues in a new session. It won't remember the earlier messages.`,
      );
    }
    chat.sessionId = session.sessionId;
    chat.sessionGeneration = agent.generation;
    this.sessionToChat.set(session.sessionId, chat.id);
  }

  private fitToAgent(chat: ChatState, agent: RunningAgent, blocks: acp.ContentBlock[]): acp.ContentBlock[] {
    if (agent.conn.supportsImages || !blocks.some((b) => b.type === 'image')) return blocks;
    this.options.events.notice(chat.id, `${agent.conn.spec.label} can't take images here, so only the text was sent.`);
    return blocks.filter((b) => b.type !== 'image');
  }

  private hostFor(agentId: AgentId): ClientHost {
    const { events, files } = this.options;
    const chatFor = (sessionId: string) => {
      const chatId = this.sessionToChat.get(sessionId);
      return chatId ? this.chats.get(chatId) : undefined;
    };
    return {
      sessionUpdate: ({ sessionId, update }) => {
        const chat = chatFor(sessionId);
        if (chat && !chat.loading) events.update(chat.id, update);
      },
      requestPermission: async (req, signal) => {
        const chat = chatFor(req.sessionId);
        if (!chat) return { outcome: { outcome: 'cancelled' } };
        return events.permission(chat.id, req, signal);
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
