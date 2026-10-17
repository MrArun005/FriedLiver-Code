import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type * as acp from '@agentclientprotocol/sdk';
import type { AgentSpec } from './registry';
import { killProcessTree, launchFor } from './processes';
import { TerminalManager, type TerminalListener } from './terminals';

/** What the editor provides to a running agent. */
export interface ClientHost {
  sessionUpdate(notification: acp.SessionNotification): void;
  requestPermission(req: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse>;
  readTextFile(req: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse>;
  writeTextFile(req: acp.WriteTextFileRequest): Promise<void>;
  /** A question for the user as a small form (ACP form elicitation). Without it, every one is declined. */
  createElicitation?(req: acp.CreateElicitationRequest, signal: AbortSignal): Promise<acp.CreateElicitationResponse>;
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
      return new AgentConnection(spec, child, connection, info, terminals, stderrTail);
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

  get supportsCloseSession(): boolean {
    return this.info.agentCapabilities?.sessionCapabilities?.close != null;
  }

  /**
   * `mcpServers` are tool servers the agent starts for this session, e.g. FriedLiver's own.
   * `meta` is the request's `_meta`, e.g. claude-agent-acp's `systemPrompt` and `claudeCode.options`.
   */
  newSession(cwd: string, mcpServers: acp.McpServer[] = [], meta?: Record<string, unknown>): Promise<SessionSetup & { sessionId: string }> {
    return this.connection.agent.request(sdk!.methods.agent.session.new, { cwd, mcpServers, ...(meta ? { _meta: meta } : {}) });
  }

  async loadSession(sessionId: string, cwd: string, mcpServers: acp.McpServer[] = [], meta?: Record<string, unknown>): Promise<SessionSetup> {
    return ((await this.connection.agent.request(sdk!.methods.agent.session.load, { sessionId, cwd, mcpServers, ...(meta ? { _meta: meta } : {}) })) as SessionSetup | undefined) ?? {};
  }

  /** Returns the agent's whole list of options afterwards: changing the model can change the effort levels. */
  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<acp.SessionConfigOption[]> {
    const params: acp.SetSessionConfigOptionRequest =
      typeof value === 'boolean' ? { sessionId, configId, type: 'boolean', value } : { sessionId, configId, value };
    const r = await this.connection.agent.request(sdk!.methods.agent.session.setConfigOption, params);
    return r.configOptions ?? [];
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.connection.agent.request(sdk!.methods.agent.session.setMode, { sessionId, modeId });
  }

  /** Gemini's unstable `session/set_model`, which SDK 1.8 has no type for. */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.connection.agent.request<unknown>('session/set_model', { sessionId, modelId });
  }

  /** Adds a message to the running turn. False when no turn is running, so it must go as a prompt. */
  async steer(sessionId: string, prompt: acp.ContentBlock[]): Promise<boolean> {
    const r = await this.connection.agent.request<{ outcome?: string }>('_session/steering', {
      sessionId,
      prompt,
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    });
    return r?.outcome !== 'promptRequired';
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.connection.agent.request(sdk!.methods.agent.session.close, { sessionId });
  }

  prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    return this.connection.agent.request(sdk!.methods.agent.session.prompt, { sessionId, prompt });
  }

  cancel(sessionId: string): Promise<void> {
    return this.connection.agent.notify(sdk!.methods.agent.session.cancel, { sessionId });
  }

  async authenticate(methodId: string): Promise<void> {
    await this.connection.agent.request(sdk!.methods.agent.authenticate, { methodId });
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

export function isAuthRequired(err: unknown): boolean {
  // Before the library loads, no agent has answered at all.
  return !!sdk && err instanceof sdk.RequestError && err.code === -32000;
}
