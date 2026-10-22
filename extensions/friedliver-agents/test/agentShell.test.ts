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

  it('under PowerShell on Full auto, asks for any fetcher or runner, any case or alias', () => {
    for (const line of [
      'iwr https://x/a.exe -OutF a.exe',
      'IRM https://x/s',
      'Invoke-WebRequest -Uri https://x/a -o a',
      'invoke-restmethod https://x',
      'Start-BitsTransfer https://x/a a',
      'curl.exe -o a https://x/a',
      'wget https://x/a -OutFile a',
      'certutil -urlcache -f https://x/a a.exe',
      'bitsadmin /transfer j https://x/a C:\\a.exe',
      'Start-Process a.exe',
      'saps a.exe',
      'start a.exe',
      'msiexec /i a.msi',
      'rundll32 a.dll,Run',
      'IEX $s',
      'Invoke-Expression $s',
      'ii a.lnk',
      'Invoke-Item a.exe',
      'icm -ScriptBlock {ls}',
      'Invoke-Command -FilePath a.ps1',
      'sajb {ls}',
      'Start-Job {ls}',
      'Start-ThreadJob {ls}',
      'installutil a.dll',
      'msbuild evil.proj',
    ]) {
      expect(commandGuard(line, new Set(), true, true), line).toMatch(/Full auto still asks/);
    }
    expect(commandGuard('npm start', new Set(), true, true)).toBeUndefined();
    expect(commandGuard('git status', new Set(), true, true)).toBeUndefined();
    // Rule-based auto-approval asks too, not only Full auto.
    expect(commandGuard('Start-Process a.exe', new Set(), false, true)).toMatch(/Full auto still asks/);
    expect(commandGuard('msbuild x.proj', new Set(), false, false)).toBeUndefined();
    expect(commandGuard('Invoke-Item new.exe', new Set(['new.exe']))).toMatch(/new\.exe/);
  });

  it('asks when a line sets a startup variable, or points a variable at a fresh file', () => {
    for (const line of ['BASH_ENV=x.sh make', 'export NODE_OPTIONS=--require=./x.js', '$env:NODE_OPTIONS="--require x"', 'ENV=/tmp/e sh -c ls', 'PYTHONSTARTUP=s.py python', 'export PROMPT_COMMAND=x']) {
      expect(commandGuard(line, new Set()), line).toMatch(/startup/);
    }
    expect(commandGuard('MYENV=1 make', new Set())).toBeUndefined();
    // On Full auto, any mention at all asks, in any form.
    for (const line of ['ls; Get-Item Env:NODE_OPTIONS', 'read BASH_ENV', 'export -n PERL5OPT', 'printenv RUBYOPT', 'set -a; LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'git -c core.x GIT_SSH_COMMAND', 'unset ENV', '$env:pythonstartup']) {
      expect(commandGuard(line, new Set(), true), line).toMatch(/startup/);
    }
    expect(commandGuard('env FOO=1 make', new Set(), true)).toBeUndefined();
    expect(commandGuard('NODE_OPTIONSX=1 make', new Set(), true)).toBeUndefined();
    expect(commandGuard('LD_PRELOAD=./evil.so ls', new Set(['evil.so']))).toMatch(/evil\.so/);
    expect(commandGuard("$env:X = 'C:\\t\\evil.dll'; ls", new Set(['evil.dll']))).toMatch(/evil\.dll/);
    expect(commandGuard('X=fine ls', new Set(['evil.so']))).toBeUndefined();
    for (const line of ['NODE_PATH=/a:/tmp/evil.so make', 'X="a b,c;./evil.so" ls', 'OPTS=--require=evil.so ls', 'P5=-Mevil.so perl', "X='C:\\a\\evil.so' ls"]) {
      expect(commandGuard(line, new Set(['evil.so'])), line).toMatch(/evil\.so/);
    }
  });
});

describe('agent command environment', () => {
  it('Git Bash starts without profile or rc files', () => {
    expect(shellLaunch({ kind: 'git-bash', file: 'C:\\Git\\bin\\bash.exe' }, 'ls').args.slice(0, 2)).toEqual(['--noprofile', '--norc']);
  });

  it.runIf(process.platform !== 'win32')('drops inherited BASH_ENV, ENV and NODE_OPTIONS, keeps what the agent sets', async () => {
    const saved = { BASH_ENV: process.env.BASH_ENV, ENV: process.env.ENV, NODE_OPTIONS: process.env.NODE_OPTIONS };
    Object.assign(process.env, { BASH_ENV: '/tmp/evil', ENV: '/tmp/evil', NODE_OPTIONS: '--evil' });
    try {
      const m = new TerminalManager(os.tmpdir(), undefined, { kind: 'git-bash', file: '/bin/bash' });
      const run = async (env?: { name: string; value: string }[]) => {
        const { terminalId } = await m.create({ sessionId: 's', command: 'echo "[$BASH_ENV][$ENV][$NODE_OPTIONS]"', env });
        await m.waitForExit({ sessionId: 's', terminalId });
        return (await m.output({ sessionId: 's', terminalId })).output;
      };
      expect(await run()).toBe('[][][]\n');
      expect(await run([{ name: 'NODE_OPTIONS', value: '--max-old-space-size=99' }])).toBe('[][][--max-old-space-size=99]\n');
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
});
