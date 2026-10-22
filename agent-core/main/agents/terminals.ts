import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { agentShell, shellLaunch, type AgentShell } from './agentShell';
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
  /** Keeps a command's whole output where the agent can read it, when what it gets is cut; resolves to that file. */
  saveOutput?(info: TerminalInfo, text: string): Promise<string>;
  /** An agent got `sent` for output that was `raw` (compactOutput changed it). */
  compacted?(info: TerminalInfo, raw: string, sent: string): void;
}

/** Lines of a long output an agent gets from its start and its end. */
export const OUTPUT_KEEP = { head: 60, tail: 100 };

// CSI and OSC sequences and two-character escapes: colors, cursor moves, titles, hyperlinks.
// eslint-disable-next-line no-control-regex -- matching escape sequences is the point
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const FRAME = /^(\s+)at\s/;
const LIB_FRAME = /node_modules|site-packages|[/\\]vendor[/\\]/;
const RUNTIME_FRAME = /\bnode:|\(internal\/|<anonymous>|\bjava\.base\/|\bjdk\.internal\.|\bsun\.reflect\./;

/** Repeated lines as one with a count, and runs of library or runtime stack frames as one line each. */
function fold(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    if (j - i >= 3 && lines[i].trim()) {
      out.push(lines[i], `… the line above ${j - i - 1} more times`);
      i = j;
      continue;
    }
    const frame = FRAME.exec(lines[i]);
    const kind = frame && (LIB_FRAME.test(lines[i]) ? 'lib' : RUNTIME_FRAME.test(lines[i]) ? 'runtime' : '');
    if (kind) {
      j = i + 1;
      while (j < lines.length && FRAME.test(lines[j]) && (kind === 'lib' ? LIB_FRAME.test(lines[j]) : !LIB_FRAME.test(lines[j]) && RUNTIME_FRAME.test(lines[j]))) j++;
      if (j - i >= 2) {
        out.push(`${frame![1]}… ${j - i} ${kind === 'lib' ? 'frames in node_modules' : 'runtime frames'}`);
        i = j;
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }
  return out;
}

/**
 * Command output as an agent should get it: no color codes or spinner frames (only the text after a
 * line's last carriage return), repeated lines and library stack frames folded, and when still long,
 * its first `head` and last `tail` lines with how many were left out (line numbers of the whole output).
 * `whole` names where the whole output is, for the note.
 */
export function compactOutput(text: string, keep = OUTPUT_KEEP, whole?: string): { text: string; omitted: number } {
  const lines = text
    .replace(ANSI, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => (l.includes('\r') ? l.slice(l.lastIndexOf('\r') + 1) : l));
  const folded = fold(lines);
  if (folded.length <= keep.head + keep.tail + 10) return { text: folded.join('\n'), omitted: 0 };
  const omitted = lines.length - keep.head - keep.tail;
  const note = `… ${omitted} lines left out (${keep.head + 1}-${keep.head + omitted})${whole ? `; the whole output: ${whole}` : ''}`;
  return { text: [...fold(lines.slice(0, keep.head)), note, ...fold(lines.slice(-keep.tail))].join('\n'), omitted };
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
    /** Where bare command lines run (agentShell); tests pass their own. */
    private readonly shell: AgentShell = agentShell(),
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
    const shell = this.shell;
    if (launch) {
      child = spawn(launch.file, launch.args, { cwd, env, detached, windowsHide: true, windowsVerbatimArguments: launch.windowsVerbatimArguments });
    } else if (shell.kind === 'sh') {
      child = spawn(shellLine, { cwd, env, shell: true, detached, windowsHide: true });
    } else {
      // Windows: Git Bash or PowerShell by absolute path, never cmd.exe (agentShell.ts).
      const run = shellLaunch(shell, shellLine);
      child = spawn(run.file, run.args, { cwd, env: { ...env, ...run.env }, detached, windowsHide: true });
    }

    this.listener?.onStart(info);
    this.commands.set(terminalId, new RunningCommand(info, child, outputLimit(req.outputByteLimit), this.listener));
    return { terminalId };
  }

  /** The output compacted (compactOutput); when lines were left out, the whole of it is saved first and named. */
  async output(req: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse> {
    const command = this.get(req.terminalId);
    const snap = command.snapshot();
    let r = compactOutput(snap.output);
    if (r.omitted && this.listener?.saveOutput) {
      const file = await this.listener.saveOutput(command.info, snap.output).catch(() => undefined);
      if (file) r = compactOutput(snap.output, OUTPUT_KEEP, file);
    }
    if (r.text !== snap.output) this.listener?.compacted?.(command.info, snap.output, r.text);
    return { ...snap, output: r.text, truncated: snap.truncated || r.omitted > 0 };
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
