import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Kills a process and everything it started. Agents and their shell commands
 * spawn children of their own, and killing only the parent would leave those
 * holding memory.
 */
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
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
 * argument quoted. Elsewhere commands run directly.
 */
export function launchFor(command: string, args: string[]): Launch {
  if (process.platform !== 'win32') return { file: command, args };
  const resolved = findOnWindowsPath(command);
  if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
    const line = [resolved, ...args].map(quoteWindowsArg).join(' ');
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
  }
  // Not found: start it anyway, so the error is a plain ENOENT ("not installed").
  return { file: resolved ?? command, args };
}

export function findOnWindowsPath(command: string, env: NodeJS.ProcessEnv = process.env, delimiter = path.delimiter): string | null {
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasExt = exts.some((e) => command.toLowerCase().endsWith(e.toLowerCase()));
  // Extensionless files next to npm's wrappers are for Git Bash; Windows can't run them.
  const candidates = (base: string) => (hasExt ? [base] : exts.map((e) => base + e));
  if (/[\\/]/.test(command)) return candidates(command).find((c) => existsSync(c)) ?? null;
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    const hit = candidates(path.join(dir, command)).find((c) => existsSync(c));
    if (hit) return hit;
  }
  return null;
}

/** Quotes one argument the way Windows programs (CommandLineToArgvW) read it back. */
export function quoteWindowsArg(arg: string): string {
  if (arg && !/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}
