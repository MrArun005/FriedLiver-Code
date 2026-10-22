import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { agentShell, COMMAND_VAR, pickAgentShell, shellLaunch, shellNote, type ShellProbe } from '@friedliver/main/agents/agentShell';
import { findProgram } from '@friedliver/main/agents/processes';
import { TerminalManager } from '@friedliver/main/agents/terminals';
import { commandGuard } from '../src/host/fullAutoGuards';

const ENV = { ProgramW6432: 'C:\\Program Files', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\Jo\\AppData\\Local', SystemRoot: 'C:\\Windows' };

function probe(files: string[], o: { reg?: Record<string, string>; execPath?: string; env?: NodeJS.ProcessEnv } = {}): ShellProbe {
  const have = new Set(files.map((f) => f.toLowerCase()));
  return { env: o.env ?? ENV, exists: (f) => have.has(f.toLowerCase()), registry: (key) => o.reg?.[key], gitExecPath: () => o.execPath };
}
const pick = (files: string[], o?: Parameters<typeof probe>[1]) => pickAgentShell('win32', probe(files, o));

describe('agent shell selection', () => {
  it('stays /bin/sh off Windows', () => {
    expect(pickAgentShell('darwin', probe(['C:\\Program Files\\Git\\bin\\bash.exe']))).toEqual({ kind: 'sh' });
    expect(pickAgentShell('linux', probe([]))).toEqual({ kind: 'sh' });
    expect(shellNote({ kind: 'sh' })).toBeUndefined();
  });

  it('prefers Git Bash: registry, then Program Files, then per-user, then git --exec-path', () => {
    const all = ['D:\\Tools\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Users\\Jo\\AppData\\Local\\Programs\\Git\\bin\\bash.exe', 'E:\\G\\bin\\bash.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'];
    const execPath = 'E:/G/mingw64/libexec/git-core\n';
    expect(pick(all, { reg: { 'HKLM\\SOFTWARE\\GitForWindows': 'D:\\Tools\\Git' }, execPath })).toEqual({ kind: 'git-bash', file: 'D:\\Tools\\Git\\bin\\bash.exe' });
    expect(pick(all, { execPath })).toEqual({ kind: 'git-bash', file: 'C:\\Program Files\\Git\\bin\\bash.exe' });
    expect(pick(all.slice(2), { execPath })).toEqual({ kind: 'git-bash', file: 'C:\\Users\\Jo\\AppData\\Local\\Programs\\Git\\bin\\bash.exe' });
    expect(pick(all.slice(3), { execPath })).toEqual({ kind: 'git-bash', file: 'E:\\G\\bin\\bash.exe' });
  });

  it('falls back to PowerShell 7, then Windows PowerShell; never cmd.exe', () => {
    expect(pick(['C:\\Program Files\\PowerShell\\7\\pwsh.exe'])).toEqual({ kind: 'pwsh', file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' });
    const ps = pick([]);
    expect(ps).toEqual({ kind: 'powershell', file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' });
    for (const s of [ps, pick(['C:\\Program Files\\Git\\bin\\bash.exe'])]) expect(JSON.stringify(s)).not.toMatch(/cmd\.exe/i);
    expect(shellNote(ps)).toMatch(/Windows PowerShell 5\.1/);
    expect(shellNote(pick(['C:\\Program Files\\Git\\bin\\bash.exe']))).toMatch(/Git Bash/);
  });

  it('takes only absolute drive paths: no relative, share, or System32 (WSL) bash', () => {
    const files = ['Git\\bin\\bash.exe', '.\\bin\\bash.exe', '\\\\evil\\share\\Git\\bin\\bash.exe', 'C:\\Windows\\System32\\bin\\bash.exe'];
    const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'Program Files', LOCALAPPDATA: '\\\\evil\\share' };
    for (const o of <Parameters<typeof probe>[1][]>[
      { reg: { 'HKLM\\SOFTWARE\\GitForWindows': 'Git' }, env },
      { reg: { 'HKCU\\SOFTWARE\\GitForWindows': '\\\\evil\\share\\Git' }, env },
      { reg: { 'HKLM\\SOFTWARE\\GitForWindows': 'C:\\Windows\\System32' }, env },
      { execPath: 'mingw64/libexec/git-core', env },
      { execPath: '\\\\evil\\share\\Git\\mingw64\\libexec\\git-core', env },
    ]) {
      expect(pick(files, o).kind).toBe('powershell');
    }
  });
});

describe('agent shell launch', () => {
  // Spaces, both quotes, $, &, |, %, a trailing backslash, a glob, a line break.
  const LINE = `printf '%s|' "a b" 'c"d' '$HOME' "100%" 'x\\' '*'; echo && echo "it's" | cat\necho done`;
  const EXPECTED = `a b|c"d|$HOME|100%|x\\|*|\nit's\ndone\n`;

  it('Git Bash gets the line only through a variable, never on its command line', () => {
    const run = shellLaunch({ kind: 'git-bash', file: 'C:\\Git\\bin\\bash.exe' }, LINE);
    expect(run.env[COMMAND_VAR]).toBe(LINE);
    expect(run.args.join(' ')).not.toContain('printf');
  });

  it.runIf(process.platform !== 'win32')('round-trips through bash exactly', () => {
    const run = shellLaunch({ kind: 'git-bash', file: '/bin/bash' }, LINE);
    const out = execFileSync(run.file, run.args, { env: { ...process.env, ...run.env, HOME: '/h' }, encoding: 'utf8' });
    expect(out).toBe(EXPECTED);
    expect(execFileSync(run.file, run.args, { env: { ...process.env, [COMMAND_VAR]: `echo "[$${COMMAND_VAR}]"` }, encoding: 'utf8' })).toBe('[]\n');
  });

  it('PowerShell gets the line verbatim in -EncodedCommand, with no profile and no prompts', () => {
    const run = shellLaunch({ kind: 'pwsh', file: 'C:\\pwsh.exe' }, LINE);
    expect(run.args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand']);
    expect(Buffer.from(run.args[4], 'base64').toString('utf16le')).toContain(`\n${LINE}\n`);
  });

  const pwsh = findProgram(process.platform === 'win32' ? 'pwsh.exe' : 'pwsh');
  it.runIf(pwsh)('round-trips through real PowerShell and keeps exit codes', () => {
    const line = `Write-Output (('a b', 'c"d', '$HOME', '100%', '&|^') -join '|')`;
    const run = shellLaunch({ kind: 'pwsh', file: pwsh! }, line);
    expect(execFileSync(run.file, run.args, { encoding: 'utf8' }).trim()).toBe('a b|c"d|$HOME|100%|&|^');
    const fail = shellLaunch({ kind: 'pwsh', file: pwsh! }, 'Get-Item C:/no/such/file');
    expect(() => execFileSync(fail.file, fail.args, { stdio: 'ignore' })).toThrow(expect.objectContaining({ status: 1 }));
  });

  it.runIf(process.platform !== 'win32')('TerminalManager runs bare lines in the picked shell', async () => {
    const m = new TerminalManager(os.tmpdir(), undefined, { kind: 'git-bash', file: '/bin/bash' });
    const { terminalId } = await m.create({ sessionId: 's', command: `X='a b'; echo "[$X][$${COMMAND_VAR}]" | tr a-z A-Z` });
    await m.waitForExit({ sessionId: 's', terminalId });
    expect((await m.output({ sessionId: 's', terminalId })).output).toBe('[A B][]\n');
  });

  it.runIf(process.platform === 'win32')('Windows: a POSIX line runs in the shell picked on this machine, not cmd.exe', async () => {
    const shell = agentShell();
    expect(shell.kind).not.toBe('sh');
    const m = new TerminalManager(os.tmpdir());
    const line = shell.kind === 'git-bash' ? `X='a b'; echo "$X" | cat` : `$X = 'a b'; Write-Output $X`;
    const { terminalId } = await m.create({ sessionId: 's', command: line });
    expect((await m.waitForExit({ sessionId: 's', terminalId })).exitCode).toBe(0);
    expect((await m.output({ sessionId: 's', terminalId })).output.trim()).toBe('a b');
  });
});

describe('full-auto guards and the chosen shell', () => {
  it('treats parentheses as running code only under PowerShell', () => {
    expect(commandGuard('ls (x)', new Set(), true)).toBeUndefined();
    expect(commandGuard('ls (x)', new Set(), true, true)).toMatch(/command substitution/);
  });
});
