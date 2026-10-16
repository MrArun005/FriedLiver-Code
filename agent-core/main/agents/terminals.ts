import { spawn, type ChildProcess } from 'node:child_process';
import type * as acp from '@agentclientprotocol/sdk';
import { killProcessTree } from './processes';

const DEFAULT_OUTPUT_LIMIT = 1_000_000;

export interface TerminalInfo {
  terminalId: string;
  sessionId: string;
  commandLine: string;
  cwd: string;
}

/** Lets the editor approve agent commands and mirror them where the user can watch. */
export interface TerminalListener {
  /** Asked before anything runs. Resolving false refuses the command. */
  approve?(info: TerminalInfo): Promise<boolean>;
  onStart(info: TerminalInfo): void;
  onData(terminalId: string, data: string): void;
  onExit(terminalId: string, status: acp.TerminalExitStatus): void;
}

class RunningCommand {
  private output = '';
  private outputBytes = 0;
  private truncated = false;
  private exitStatus: acp.TerminalExitStatus | null = null;
  readonly exited: Promise<acp.TerminalExitStatus>;

  constructor(
    readonly info: TerminalInfo,
    private readonly child: ChildProcess,
    private readonly limit: number,
    listener: TerminalListener | undefined,
  ) {
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.append(text);
      listener?.onData(info.terminalId, text);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    this.exited = new Promise((resolve) => {
      const finish = (status: acp.TerminalExitStatus) => {
        if (this.exitStatus) return;
        this.exitStatus = status;
        listener?.onExit(info.terminalId, status);
        resolve(status);
      };
      child.once('error', (err) => {
        onData(Buffer.from(`${err.message}\n`));
        finish({ exitCode: 127, signal: null });
      });
      child.once('close', (code, signal) => finish({ exitCode: code, signal }));
    });
  }

  get running(): boolean {
    return this.exitStatus === null;
  }

  snapshot(): acp.TerminalOutputResponse {
    return { output: this.output, truncated: this.truncated, exitStatus: this.exitStatus };
  }

  kill(): void {
    if (this.running && this.child.pid) killProcessTree(this.child.pid);
  }

  // ACP asks clients to drop output from the beginning once the byte limit is
  // reached, cutting on a character boundary.
  private append(text: string): void {
    this.output += text;
    this.outputBytes += Buffer.byteLength(text);
    if (this.outputBytes <= this.limit) return;
    const buf = Buffer.from(this.output);
    let start = buf.length - this.limit;
    while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
    this.output = buf.subarray(start).toString('utf8');
    this.outputBytes = buf.length - start;
    this.truncated = true;
  }
}

/** Runs the commands an agent asks for (ACP `terminal/*` methods). */
export class TerminalManager {
  private readonly commands = new Map<string, RunningCommand>();
  private nextId = 1;

  constructor(
    private readonly defaultCwd: string,
    private readonly listener?: TerminalListener,
  ) {}

  async create(req: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
    const terminalId = `term-${this.nextId++}`;
    const args = req.args ?? [];
    const cwd = req.cwd ?? this.defaultCwd;
    const env = { ...process.env };
    for (const v of req.env ?? []) env[v.name] = v.value;
    const commandLine = [req.command, ...args.map(quoteArg)].join(' ');
    const info: TerminalInfo = { terminalId, sessionId: req.sessionId, commandLine, cwd };

    if (this.listener?.approve && !(await this.listener.approve(info))) {
      throw new Error(`The user denied this command: ${commandLine}`);
    }

    // A bare command string ("npm test") needs a shell; Windows needs one for
    // .cmd shims such as npm and npx.
    const useShell = args.length === 0 || process.platform === 'win32';
    const child = useShell
      ? spawn(commandLine, { cwd, env, shell: true, detached: process.platform !== 'win32', windowsHide: true })
      : spawn(req.command, args, { cwd, env, detached: process.platform !== 'win32', windowsHide: true });

    this.listener?.onStart(info);
    this.commands.set(terminalId, new RunningCommand(info, child, req.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT, this.listener));
    return { terminalId };
  }

  output(req: acp.TerminalOutputRequest): acp.TerminalOutputResponse {
    return this.get(req.terminalId).snapshot();
  }

  async waitForExit(req: acp.WaitForTerminalExitRequest): Promise<acp.WaitForTerminalExitResponse> {
    const status = await this.get(req.terminalId).exited;
    return { exitCode: status.exitCode, signal: status.signal };
  }

  kill(req: acp.KillTerminalRequest): void {
    this.get(req.terminalId).kill();
  }

  release(req: acp.ReleaseTerminalRequest): void {
    const command = this.commands.get(req.terminalId);
    command?.kill();
    this.commands.delete(req.terminalId);
  }

  /** Kills the newest still-running command (Ctrl+C in the mirrored terminal). */
  interruptLatest(): boolean {
    const running = [...this.commands.values()].filter((c) => c.running);
    const latest = running.at(-1);
    latest?.kill();
    return latest !== undefined;
  }

  killAll(): void {
    for (const command of this.commands.values()) command.kill();
    this.commands.clear();
  }

  private get(terminalId: string): RunningCommand {
    const command = this.commands.get(terminalId);
    if (!command) throw new Error(`Unknown terminal ${terminalId}`);
    return command;
  }
}

function quoteArg(arg: string): string {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  if (process.platform === 'win32') return `"${arg.replace(/"/g, '\\"')}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
