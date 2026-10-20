import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';

/** A Windows system program by absolute path, so a same-named file in the current folder is never run instead. */
export function windowsSystemProgram(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', name);
}

/**
 * Kills a process and everything it started. Agents and their shell commands
 * spawn children of their own, and killing only the parent would leave those
 * holding memory.
 */
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn(windowsSystemProgram('taskkill.exe'), ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    return;
  }
  // Children spawned with `detached: true` lead their own process group.
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

export interface Launch {
  file: string;
  args: string[];
  /** Set when `args` is already a complete, quoted cmd.exe command line. */
  windowsVerbatimArguments?: boolean;
}

/**
 * How to start `command args` without a shell re-splitting arguments.
 *
 * On Windows, npm installs CLIs as `.cmd` wrappers that only cmd.exe can run,
 * and Node's `shell: true` joins arguments without quoting, so any path with
 * a space (`C:\Users\Jane Doe\…`) breaks. Instead: find the real file on PATH;
 * run an `.exe` directly, and a `.cmd`/`.bat` through cmd.exe with every
 * argument escaped for cmd.exe (see cmdCommandLine). Elsewhere commands run directly.
 *
 * On Windows a command that isn't on PATH throws an ENOENT error ("not
 * installed"). It is never started by bare name: Windows looks for that name
 * in the current folder first, which is the workspace, so a repository could
 * ship its own `claude-agent-acp.exe`.
 */
export function launchFor(command: string, args: string[]): Launch {
  if (process.platform !== 'win32') return { file: command, args };
  const resolved = findOnWindowsPath(command);
  if (!resolved) throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT', path: command });
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const comspec = process.env.ComSpec || windowsSystemProgram('cmd.exe');
    return { file: comspec, args: ['/d', '/s', '/c', `"${cmdCommandLine(resolved, args)}"`], windowsVerbatimArguments: true };
  }
  return { file: resolved, args };
}

/**
 * Where `command` runs from: a path as given, or the first match in an absolute PATH entry.
 * Null when there is none, the way a spawn would fail with ENOENT.
 */
export function findProgram(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') return findOnWindowsPath(command, env);
  const runnable = (file: string) => {
    try {
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  };
  if (command.includes('/')) return runnable(command) ? command : null;
  for (const dir of (env.PATH ?? '').split(':')) {
    if (dir && path.isAbsolute(dir) && runnable(path.join(dir, command))) return path.join(dir, command);
  }
  return null;
}

export function findOnWindowsPath(command: string, env: NodeJS.ProcessEnv = process.env, delimiter = path.delimiter): string | null {
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasExt = exts.some((e) => command.toLowerCase().endsWith(e.toLowerCase()));
  // Extensionless files next to npm's wrappers are for Git Bash; Windows can't run them.
  const candidates = (base: string) => (hasExt ? [base] : exts.map((e) => base + e));
  if (/[\\/]/.test(command)) return candidates(command).find((c) => existsSync(c)) ?? null;
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    // A relative entry (".") would find files in whatever folder this process happens to be in.
    if (!dir || !(path.isAbsolute(dir) || path.win32.isAbsolute(dir))) continue;
    const hit = candidates(path.join(dir, command)).find((c) => existsSync(c));
    if (hit) return hit;
  }
  return null;
}

/** Quotes one argument the way Windows programs (CommandLineToArgvW) read it back. For display and direct .exe launches. */
export function quoteWindowsArg(arg: string): string {
  if (arg && !/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

// Every character cmd.exe treats specially, escaped with ^ (the approach cross-spawn takes).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * The command line for `cmd.exe /d /s /c "<line>"` that runs the batch file
 * `file` with exactly `args`.
 *
 * cmd.exe doesn't understand `\"`: quoting alone lets an argument like
 * `a" & calc & "` end the quotes and start a second command. So each argument
 * is first quoted for CommandLineToArgvW, then every cmd.exe metacharacter,
 * the quotes included, is escaped with ^. Batch files read their arguments a
 * second time (npm's wrappers pass them on with %*), so arguments are escaped
 * twice. Line breaks can't be escaped for cmd.exe at all and are refused.
 */
export function cmdCommandLine(file: string, args: readonly string[]): string {
  for (const part of [file, ...args]) {
    if (/[\r\n\0]/.test(part)) throw new Error('A command for cmd.exe cannot contain line breaks or NUL characters.');
  }
  return [file.replace(CMD_META, '^$1'), ...args.map((a) => escapeCmdArg(a, true))].join(' ');
}

export function escapeCmdArg(arg: string, twice: boolean): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`.replace(CMD_META, '^$1');
  return twice ? quoted.replace(CMD_META, '^$1') : quoted;
}
