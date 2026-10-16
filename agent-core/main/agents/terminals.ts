import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { killProcessTree, launchFor, quoteWindowsArg } from './processes';

const DEFAULT_OUTPUT_LIMIT = 1_000_000;
/** An agent may ask to keep more output than the default, but not unbounded memory. */
export const MAX_OUTPUT_LIMIT = 16_000_000;
/** Windows names can hold characters like `(x86)`; no name may hold `=` or NUL. */
const ENV_NAME = /^[^=\0]+$/;

function outputLimit(requested: number | null | undefined): number {
  if (requested == null || !Number.isFinite(requested)) return DEFAULT_OUTPUT_LIMIT;
  return Math.min(Math.max(0, Math.floor(requested)), MAX_OUTPUT_LIMIT);
}

// Control characters other than tab and newline, and the invisible ones that reorder or
// hide text (bidi overrides, zero-width characters): enough to make `rm -rf ~` look harmless.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/** Spells out characters that wouldn't show on screen, as <U+202E>, so what the user approves reads true. */
export function visibleText(text: string): string {
  return text.replace(INVISIBLE, (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`);
}

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
    // A relative folder resolves against the session's folder, the one the user is shown,
    // not against wherever the editor process happens to run.
    const cwd = path.resolve(this.defaultCwd, req.cwd ?? '.');
    const extraEnv = req.env ?? [];
    for (const v of extraEnv) {
      if (!ENV_NAME.test(v.name) || v.value.includes('\0')) throw new Error(`Refused an invalid environment variable name: ${JSON.stringify(v.name)}`);
    }
    const env = { ...process.env };
    for (const v of extraEnv) env[v.name] = v.value;
    // With no args the command is a whole shell line ("npm test"); otherwise quote it too,
    // since a path like C:\Program Files\nodejs\node.exe would split at the space.
    const shellLine = [args.length ? quoteArg(req.command) : req.command, ...args.map(quoteArg)].join(' ');
    // What the user approves shows everything that changes what runs: the variables the
    // agent sets (NODE_OPTIONS or PATH can turn `npm test` into anything) come first, as a
    // shell would write them, and characters that don't show on screen are spelled out.
    const commandLine = visibleText([...extraEnv.map((v) => `${v.name}=${quoteArg(v.value)}`), shellLine].join(' '));
    const info: TerminalInfo = { terminalId, sessionId: req.sessionId, commandLine, cwd };
    // Resolved before asking, so a command that can't start doesn't wait for a decision.
    const launch = args.length ? launchFor(req.command, args) : undefined;

    if (this.listener?.approve && !(await this.listener.approve(info))) {
      throw new Error(`The user denied this command: ${commandLine}`);
    }

    // A bare command string ("npm test") goes to the shell; a command with
    // arguments starts directly, so nothing re-splits them (see launchFor).
    const detached = process.platform !== 'win32';
    let child: ChildProcess;
    if (!launch) {
      child = spawn(shellLine, { cwd, env, shell: true, detached, windowsHide: true });
    } else {
      child = spawn(launch.file, launch.args, { cwd, env, detached, windowsHide: true, windowsVerbatimArguments: launch.windowsVerbatimArguments });
    }

    this.listener?.onStart(info);
    this.commands.set(terminalId, new RunningCommand(info, child, outputLimit(req.outputByteLimit), this.listener));
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

/** Shell-style quoting, for the command line shown to the user. */
function quoteArg(arg: string): string {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  if (process.platform === 'win32') return quoteWindowsArg(arg);
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
