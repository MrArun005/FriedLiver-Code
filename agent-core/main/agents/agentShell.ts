import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { findOnWindowsPath, windowsSystemProgram } from './processes';

/**
 * The shell an agent's bare command line ("ls -la | head") runs in. `sh` is /bin/sh through
 * Node's `shell: true` (macOS, Linux). On Windows that would be cmd.exe, where the POSIX lines
 * agents write fail or mean something else, so it is Git Bash when Git for Windows is
 * installed, else PowerShell (7 when installed, else the 5.1 every Windows has). Never cmd.exe.
 */
export type AgentShell = { kind: 'sh' } | { kind: 'git-bash' | 'pwsh' | 'powershell'; file: string };

/** What picking a shell looks at; faked in tests. */
export interface ShellProbe {
  env: NodeJS.ProcessEnv;
  exists(file: string): boolean;
  /** A registry value (REG_SZ), or undefined. */
  registry(key: string, value: string): string | undefined;
  /** `git --exec-path` of the git on PATH, or undefined. */
  gitExecPath(): string | undefined;
}

/** A plain drive path (`C:\…`): never relative, never a share, so nothing in the workspace or cwd can stand in. */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

export function pickAgentShell(platform: NodeJS.Platform, probe: ShellProbe): AgentShell {
  if (platform !== 'win32') return { kind: 'sh' };
  const { env } = probe;
  const programFiles = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']];
  const execPath = probe.gitExecPath();
  // <Git>\mingw64\libexec\git-core (or mingw32 / clangarm64) is three folders below the install.
  const fromExecPath = execPath && /[\\/](?:mingw64|mingw32|clangarm64)[\\/]libexec[\\/]git-core[\\/]?$/i.test(execPath.trim()) ? path.win32.resolve(execPath.trim(), '..', '..', '..') : undefined;
  const gitRoots = [
    probe.registry('HKLM\\SOFTWARE\\GitForWindows', 'InstallPath'),
    probe.registry('HKCU\\SOFTWARE\\GitForWindows', 'InstallPath'),
    ...programFiles.map((d) => d && path.win32.join(d, 'Git')),
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git'),
    fromExecPath,
  ];
  // <Git>\bin\bash.exe sets up Git's PATH itself; System32\bash.exe is WSL, never a candidate here.
  const usable = (file: string | undefined): file is string => !!file && DRIVE_PATH.test(file) && !/\\system32\\/i.test(file) && probe.exists(file);
  const bash = gitRoots.map((r) => r && path.win32.join(r, 'bin', 'bash.exe')).find(usable);
  if (bash) return { kind: 'git-bash', file: bash };
  const pwsh = programFiles.map((d) => d && path.win32.join(d, 'PowerShell', '7', 'pwsh.exe')).find(usable);
  if (pwsh) return { kind: 'pwsh', file: pwsh };
  return { kind: 'powershell', file: windowsSystemProgram('WindowsPowerShell\\v1.0\\powershell.exe', env) };
}

/** Carries the command to Git Bash, so no Windows argument quoting ever touches it. */
export const COMMAND_VAR = 'FRIEDLIVER_COMMAND';

/** How to run `line` in `shell` (not `sh`): the program, its arguments and any variables to add. */
export function shellLaunch(shell: Exclude<AgentShell, { kind: 'sh' }>, line: string): { file: string; args: string[]; env: Record<string, string> } {
  if (shell.kind === 'git-bash') {
    // The line travels in a variable and is eval'd: the fixed -c text is all bash parses from the command line.
    // No profile or rc files; BASH_ENV and ENV are dropped from the environment by TerminalManager.
    return { file: shell.file, args: ['--noprofile', '--norc', '-c', `__fl_cmd=$${COMMAND_VAR}; unset ${COMMAND_VAR}; eval "$__fl_cmd"`], env: { [COMMAND_VAR]: line } };
  }
  // -EncodedCommand is base64 UTF-16LE, so nothing in the line is re-parsed on the way. The exit code
  // is the failing native program's, or 1 for a failed cmdlet, as a POSIX shell would report.
  const script = `$ProgressPreference = 'SilentlyContinue'\n${line}\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }`;
  return { file: shell.file, args: ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], env: {} };
}

/** What a session is told about the shell its commands run in; undefined where it is the usual /bin/sh. */
export function shellNote(shell: AgentShell): string | undefined {
  if (shell.kind === 'sh') return undefined;
  if (shell.kind === 'git-bash') return 'This computer runs Windows. Commands you run as a single command line go to Git Bash (bash), so write POSIX shell syntax; Windows paths work as C:/dir or /c/dir.';
  return `This computer runs Windows. Commands you run as a single command line go to ${shell.kind === 'pwsh' ? 'PowerShell 7' : 'Windows PowerShell 5.1'}, not a POSIX shell, so write PowerShell syntax (Get-ChildItem, Remove-Item -Recurse -Force, $env:NAME, ';' between commands${shell.kind === 'pwsh' ? '' : ', no && or ||'}).`;
}

function systemProbe(): ShellProbe {
  const run = (file: string, args: string[]) => {
    try {
      return execFileSync(file, args, { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return undefined;
    }
  };
  return {
    env: process.env,
    exists: existsSync,
    registry: (key, value) => /\s+REG_(?:EXPAND_)?SZ\s+(.+)/.exec(run(windowsSystemProgram('reg.exe'), ['query', key, '/v', value]) ?? '')?.[1].trim(),
    gitExecPath: () => {
      // Only a git found in an absolute PATH entry, never one in the current folder.
      const git = findOnWindowsPath('git.exe');
      return git ? run(git, ['--exec-path']) : undefined;
    },
  };
}

let picked: AgentShell | undefined;
/** The shell for this machine, picked once. */
export function agentShell(): AgentShell {
  return (picked ??= pickAgentShell(process.platform, process.platform === 'win32' ? systemProbe() : { env: {}, exists: () => false, registry: () => undefined, gitExecPath: () => undefined }));
}
