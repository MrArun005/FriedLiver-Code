import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type * as acp from '@agentclientprotocol/sdk';
import type { AgentSpec } from './registry';
import { killProcessTree, launchFor } from './processes';
import { authStatusOf, type AuthStatus } from './signIn';
import { TerminalManager, type TerminalListener } from './terminals';

/** What the editor provides to a running agent. */
export interface ClientHost {
  sessionUpdate(notification: acp.SessionNotification): void;
  requestPermission(req: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse>;
  readTextFile(req: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse>;
  writeTextFile(req: acp.WriteTextFileRequest): Promise<void>;
  /** A question for the user as a small form (ACP form elicitation). Without it, every one is declined. */
  createElicitation?(req: acp.CreateElicitationRequest, signal: AbortSignal): Promise<acp.CreateElicitationResponse>;
  /** The identity the agent says it runs as (`_auth/status_update`), already checked. */
  authStatus?(status: AuthStatus): void;
  terminalListener?: TerminalListener;
}

export type AgentStartFailure = 'not_installed' | 'crashed';

/** Gemini's unstable model list, which SDK 1.8 has no type for. */
export interface SessionModels {
  currentModelId: string;
  availableModels: { modelId: string; name: string; description?: string | null }[];
}

/** What `session/new` and `session/load` answer besides the session id. */
export interface SessionSetup {
  configOptions?: acp.SessionConfigOption[] | null;
  modes?: acp.SessionModeState | null;
  models?: SessionModels | null;
}

export class AgentStartError extends Error {
  constructor(
    message: string,
    readonly spec: AgentSpec,
    readonly failure: AgentStartFailure,
  ) {
    super(message);
  }
}

export interface StartOptions {
  cwd: string;
  host: ClientHost;
  clientVersion: string;
  log?: (line: string) => void;
  /** Every stderr line, e.g. to catch a sign-in URL the agent couldn't open itself. */
  onStderr?: (line: string) => void;
}

/**
 * The ACP library, loaded with the first agent: with the schemas it builds
 * when it loads, it is most of the editor's memory for agents, and a window
 * where no agent runs doesn't need it.
 */
let sdk: typeof import('@agentclientprotocol/sdk') | undefined;

const STDERR_TAIL_LINES = 40;
const STOP_GRACE_MS = 2000;
const EXIT_GRACE_MS = 1000;

/** One agent process and its ACP connection. */
export class AgentConnection {
  readonly exited: Promise<void>;
  private alive = true;

  private constructor(
    readonly spec: AgentSpec,
    private readonly child: ChildProcess,
    private readonly connection: acp.ClientConnection,
    readonly info: acp.InitializeResponse,
    readonly terminals: TerminalManager,
    private readonly stderrTail: string[],
    private readonly log?: (line: string) => void,
  ) {
    this.exited = new Promise((resolve) => {
      const onExit = () => {
        this.alive = false;
        this.terminals.killAll();
        connection.close(new Error(`${spec.label} stopped`));
        resolve();
      };
      if (child.exitCode !== null || child.signalCode !== null) onExit();
      else child.once('exit', onExit);
    });
  }

  static async start(spec: AgentSpec, options: StartOptions): Promise<AgentConnection> {
    const { cwd, host, log, onStderr } = options;
    const lib = (sdk ??= await import('@agentclientprotocol/sdk'));
    let launch: ReturnType<typeof launchFor>;
    try {
      launch = launchFor(spec.command, spec.args);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notInstalled(spec);
      throw new AgentStartError(`${spec.label} could not start: ${(err as Error).message}`, spec, 'crashed');
    }
    const child = spawn(launch.file, launch.args, {
      cwd,
      // On Windows, npm's .cmd wrappers run `node` by bare name, and cmd.exe would look for it in the
      // current folder (the workspace) first. This variable turns that lookup off.
      env: { ...process.env, ...spec.env, ...(process.platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    const stderrTail: string[] = [];
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line) continue;
        log?.(`[${spec.id}] ${line}`);
        onStderr?.(line);
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      }
    });

    const failed = new Promise<never>((_, reject) => {
      child.once('error', (err: NodeJS.ErrnoException) => {
        reject(
          err.code === 'ENOENT'
            ? notInstalled(spec)
            : new AgentStartError(`${spec.label} could not start: ${err.message}`, spec, 'crashed'),
        );
      });
      child.once('exit', (code) => {
        const tail = stderrTail.join('\n');
        // Through cmd.exe (npm's .cmd wrappers) a missing command is reported by the shell, not as ENOENT.
        if (code === 127 || /not recognized as an internal|command not found|No such file/i.test(tail)) {
          reject(notInstalled(spec));
        } else {
          reject(new AgentStartError(`${spec.label} exited during startup (code ${code}).\n${tail}`, spec, 'crashed'));
        }
      });
    });
    failed.catch(() => {});

    const terminals = new TerminalManager(cwd, host.terminalListener);
    const stream = lib.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    const connection = lib
      .client({ name: 'friedliver' })
      .onNotification(lib.methods.client.session.update, ({ params }) => host.sessionUpdate(params))
      // Claude's and Codex's adapters say which account they run as; an agent that doesn't stays silent.
      .onNotification('_auth/status_update', (raw) => raw, ({ params }) => {
        const status = authStatusOf(params);
        if (status) host.authStatus?.(status);
      })
      .onRequest(lib.methods.client.session.requestPermission, ({ params, signal }) => host.requestPermission(params, signal))
      .onRequest(lib.methods.client.fs.readTextFile, ({ params }) => host.readTextFile(params))
      .onRequest(lib.methods.client.elicitation.create, ({ params, signal }) => host.createElicitation?.(params, signal) ?? Promise.resolve({ action: 'decline' as const }))
      .onRequest(lib.methods.client.fs.writeTextFile, async ({ params }) => {
        await host.writeTextFile(params);
        return {};
      })
      .onRequest(lib.methods.client.terminal.create, ({ params }) => terminals.create(params))
      .onRequest(lib.methods.client.terminal.output, ({ params }) => terminals.output(params))
      .onRequest(lib.methods.client.terminal.waitForExit, ({ params }) => terminals.waitForExit(params))
      .onRequest(lib.methods.client.terminal.kill, ({ params }) => {
        terminals.kill(params);
        return {};
      })
      .onRequest(lib.methods.client.terminal.release, ({ params }) => {
        terminals.release(params);
        return {};
      })
      .connect(stream);

    try {
      const info = await Promise.race([
        connection.agent.request(lib.methods.agent.initialize, {
          protocolVersion: lib.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
            auth: { terminal: true },
            // On/off options (Fast mode) as toggles, and short notices ("Auto mode unavailable") as notices.
            session: { configOptions: { boolean: {} }, notices: {} },
            // Questions as small forms: Claude's AskUserQuestion needs this, or it turns the tool off.
            elicitation: { form: {} },
          },
          clientInfo: { name: 'friedliver', version: options.clientVersion },
        }),
        failed,
      ]);
      return new AgentConnection(spec, child, connection, info, terminals, stderrTail, log);
    } catch (err) {
      // The connection often closes a moment before the process reports its
      // exit (always on Windows, where a missing command exits through
      // cmd.exe). The exit explains more, e.g. "not installed", so prefer it.
      const reason = await Promise.race([failed.catch((e: unknown) => e), new Promise((r) => setTimeout(() => r(err), EXIT_GRACE_MS))]);
      connection.close(reason);
      if (child.pid && child.exitCode === null) killProcessTree(child.pid);
      throw reason;
    }
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get running(): boolean {
    return this.alive;
  }

  get supportsImages(): boolean {
    return this.info.agentCapabilities?.promptCapabilities?.image === true;
  }

  get supportsLoadSession(): boolean {
    return this.info.agentCapabilities?.loadSession === true;
  }

  /** Whether session MCP servers may be HTTP endpoints, not only programs to start. */
  get supportsHttpMcp(): boolean {
    return this.info.agentCapabilities?.mcpCapabilities?.http === true;
  }

  get authMethods(): acp.AuthMethod[] {
    return this.info.authMethods ?? [];
  }

  /** A message can join the running turn (`_session/steering`, Claude's adapter and the Demo). */
  get supportsSteering(): boolean {
    const meta = this.info._meta as { steering?: { supported?: unknown } } | null | undefined;
    return meta?.steering?.supported === true;
  }

  /** The agent can sign out itself (ACP `logout`), so FriedLiver never deletes its files. */
  get supportsLogout(): boolean {
    return (this.info.agentCapabilities as { auth?: { logout?: unknown } } | undefined)?.auth?.logout != null;
  }

  get supportsCloseSession(): boolean {
    return this.info.agentCapabilities?.sessionCapabilities?.close != null;
  }

  /**
   * `mcpServers` are tool servers the agent starts for this session, e.g. FriedLiver's own.
   * `meta` is the request's `_meta`, e.g. claude-agent-acp's `systemPrompt` and `claudeCode.options`.
   */
  newSession(cwd: string, mcpServers: acp.McpServer[] = [], meta?: Record<string, unknown>): Promise<SessionSetup & { sessionId: string }> {
    return this.request(sdk!.methods.agent.session.new, { cwd, mcpServers, ...(meta ? { _meta: meta } : {}) });
  }

  async loadSession(sessionId: string, cwd: string, mcpServers: acp.McpServer[] = [], meta?: Record<string, unknown>): Promise<SessionSetup> {
    return ((await this.request<SessionSetup | undefined>(sdk!.methods.agent.session.load, { sessionId, cwd, mcpServers, ...(meta ? { _meta: meta } : {}) })) as SessionSetup | undefined) ?? {};
  }

  /** Returns the agent's whole list of options afterwards: changing the model can change the effort levels. */
  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<acp.SessionConfigOption[]> {
    const params: acp.SetSessionConfigOptionRequest =
      typeof value === 'boolean' ? { sessionId, configId, type: 'boolean', value } : { sessionId, configId, value };
    const r = await this.request<acp.SetSessionConfigOptionResponse>(sdk!.methods.agent.session.setConfigOption, params);
    return r.configOptions ?? [];
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.request(sdk!.methods.agent.session.setMode, { sessionId, modeId });
  }

  /** Gemini's unstable `session/set_model`, which SDK 1.8 has no type for. */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.request('session/set_model', { sessionId, modelId });
  }

  /** Adds a message to the running turn. False when no turn is running, so it must go as a prompt. */
  async steer(sessionId: string, prompt: acp.ContentBlock[]): Promise<boolean> {
    const r = await this.request<{ outcome?: string }>('_session/steering', {
      sessionId,
      prompt,
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    });
    return r?.outcome !== 'promptRequired';
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request(sdk!.methods.agent.session.close, { sessionId });
  }

  prompt(sessionId: string, prompt: acp.ContentBlock[], meta?: Record<string, unknown>): Promise<acp.PromptResponse> {
    return this.request(sdk!.methods.agent.session.prompt, { sessionId, prompt, ...(meta ? { _meta: meta } : {}) });
  }

  cancel(sessionId: string): Promise<void> {
    return this.connection.agent.notify(sdk!.methods.agent.session.cancel, { sessionId });
  }

  async authenticate(methodId: string): Promise<void> {
    await this.request(sdk!.methods.agent.authenticate, { methodId });
  }

  async logout(): Promise<void> {
    await this.request(sdk!.methods.agent.logout, {});
  }

  async stop(): Promise<void> {
    if (!this.alive || !this.child.pid) return;
    const pid = this.child.pid;
    killProcessTree(pid);
    const forced = setTimeout(() => {
      if (!this.alive) return;
      try {
        process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, STOP_GRACE_MS);
    await this.exited;
    clearTimeout(forced);
  }

  /** Every request to the agent; a failure is logged with the agent's own code, message and data before it is thrown on. */
  private async request<T>(method: string, params: unknown): Promise<T> {
    try {
      return await this.connection.agent.request<T>(method, params as never);
    } catch (err) {
      if (this.alive) this.log?.(`[${this.spec.id}] ${method} failed: ${describeAgentError(err)}`);
      throw err;
    }
  }

  recentStderr(): string {
    return this.stderrTail.join('\n');
  }
}

function notInstalled(spec: AgentSpec): AgentStartError {
  return new AgentStartError(
    `${spec.label} isn't installed (couldn't find \`${spec.command}\`). Install it with: ${spec.installCommand}`,
    spec,
    'not_installed',
  );
}

/** An error as the log shows it: the JSON-RPC code, message and data. */
export function describeAgentError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const { code, data } = err as { code?: unknown; data?: unknown };
  const json = data === undefined ? '' : JSON.stringify(data);
  return `${code !== undefined ? `code ${String(code)} ` : ''}"${err.message}"${json ? ` data ${json.length > 2000 ? `${json.slice(0, 2000)}…` : json}` : ''}`;
}

/**
 * What the agent itself said went wrong. Agents often answer with a bare
 * "Internal error" and put the reason in `data`: Gemini as `details`, Codex as
 * `message` holding the API's JSON error.
 */
export function agentErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return reasonIn((err as { data?: unknown }).data) ?? err.message;
}

function reasonIn(data: unknown, depth = 0): string | undefined {
  if (depth > 6) return undefined;
  if (typeof data === 'string') {
    const s = data.trim();
    if (!s) return undefined;
    try {
      const parsed: unknown = JSON.parse(s);
      if (parsed && typeof parsed === 'object') return reasonIn(parsed, depth + 1) ?? s;
    } catch {
      // Plain text.
    }
    return s;
  }
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  for (const key of ['error', 'message', 'details', 'detail', 'reason']) {
    const found = reasonIn(d[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function isAuthRequired(err: unknown): boolean {
  // Before the library loads, no agent has answered at all.
  return !!sdk && err instanceof sdk.RequestError && err.code === -32000;
}
