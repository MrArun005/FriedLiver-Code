import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { AgentSpec } from './registry';
import { killProcessTree } from './processes';
import { TerminalManager, type TerminalListener } from './terminals';

/** What the editor provides to a running agent. */
export interface ClientHost {
  sessionUpdate(notification: acp.SessionNotification): void;
  requestPermission(req: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse>;
  readTextFile(req: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse>;
  writeTextFile(req: acp.WriteTextFileRequest): Promise<void>;
  terminalListener?: TerminalListener;
}

export type AgentStartFailure = 'not_installed' | 'crashed';

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
}

const STDERR_TAIL_LINES = 40;
const STOP_GRACE_MS = 2000;

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
    const { cwd, host, log } = options;
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // npm installs CLIs as .cmd shims on Windows, which need a shell.
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    const stderrTail: string[] = [];
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line) continue;
        log?.(`[${spec.id}] ${line}`);
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
        // With `shell: true` a missing command is reported by the shell, not as ENOENT.
        if (code === 127 || /not recognized as an internal|command not found|No such file/i.test(tail)) {
          reject(notInstalled(spec));
        } else {
          reject(new AgentStartError(`${spec.label} exited during startup (code ${code}).\n${tail}`, spec, 'crashed'));
        }
      });
    });
    failed.catch(() => {});

    const terminals = new TerminalManager(cwd, host.terminalListener);
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    const connection = acp
      .client({ name: 'friedliver' })
      .onNotification(acp.methods.client.session.update, ({ params }) => host.sessionUpdate(params))
      .onRequest(acp.methods.client.session.requestPermission, ({ params, signal }) => host.requestPermission(params, signal))
      .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => host.readTextFile(params))
      .onRequest(acp.methods.client.fs.writeTextFile, async ({ params }) => {
        await host.writeTextFile(params);
        return {};
      })
      .onRequest(acp.methods.client.terminal.create, ({ params }) => terminals.create(params))
      .onRequest(acp.methods.client.terminal.output, ({ params }) => terminals.output(params))
      .onRequest(acp.methods.client.terminal.waitForExit, ({ params }) => terminals.waitForExit(params))
      .onRequest(acp.methods.client.terminal.kill, ({ params }) => {
        terminals.kill(params);
        return {};
      })
      .onRequest(acp.methods.client.terminal.release, ({ params }) => {
        terminals.release(params);
        return {};
      })
      .connect(stream);

    try {
      const info = await Promise.race([
        connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
            auth: { terminal: true },
          },
          clientInfo: { name: 'friedliver', version: options.clientVersion },
        }),
        failed,
      ]);
      return new AgentConnection(spec, child, connection, info, terminals, stderrTail);
    } catch (err) {
      connection.close(err);
      if (child.pid && child.exitCode === null) killProcessTree(child.pid);
      throw err;
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

  get authMethods(): acp.AuthMethod[] {
    return this.info.authMethods ?? [];
  }

  newSession(cwd: string): Promise<acp.NewSessionResponse> {
    return this.connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    await this.connection.agent.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] });
  }

  prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    return this.connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt });
  }

  cancel(sessionId: string): Promise<void> {
    return this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
  }

  async authenticate(methodId: string): Promise<void> {
    await this.connection.agent.request(acp.methods.agent.authenticate, { methodId });
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
  return err instanceof acp.RequestError && err.code === -32000;
}
