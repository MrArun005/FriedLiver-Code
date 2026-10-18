import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdCommandLine, findOnWindowsPath, quoteWindowsArg } from '@friedliver/main/agents/processes';
import { allowedExternal, allowedSignInUrl } from '@friedliver/main/agents/signIn';
import { MAX_OUTPUT_LIMIT, TerminalManager, visibleText, type TerminalInfo } from '@friedliver/main/agents/terminals';
import * as git from '@friedliver/main/workspace/git';

// ---- A model of how cmd.exe reads `cmd /d /s /c "<line>"` ----
// Phase 1 expands %VAR% (an undefined name stays as written). Phase 2 handles ^ and quotes:
// outside quotes ^ makes the next character literal and & | < > ( ) start or join commands.
// Enough of cmd.exe to see whether an argument can break out.

function expandPercent(line: string, env: Record<string, string>): string {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '%') {
      out += line[i];
      continue;
    }
    const end = line.indexOf('%', i + 1);
    const name = end > i ? line.slice(i + 1, end) : '';
    if (end > i && name && Object.hasOwn(env, name)) {
      out += env[name];
      i = end;
    } else {
      out += '%';
    }
  }
  return out;
}

/** Returns the text cmd.exe passes on, or throws when the line would run more than one command. */
function cmdPhase2(line: string): string {
  let out = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      quoted = !quoted;
      out += c;
    } else if (!quoted && c === '^') {
      i++;
      if (i < line.length) out += line[i];
    } else if (!quoted && '&|<>()'.includes(c)) {
      throw new Error(`cmd.exe would treat ${JSON.stringify(c)} as an operator in: ${line}`);
    } else {
      out += c;
    }
  }
  return out;
}

/** CommandLineToArgvW / the MSVC runtime. */
function argvW(line: string): string[] {
  const args: string[] = [];
  let cur = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < line.length; ) {
    const c = line[i];
    if (c === '\\') {
      let n = 0;
      while (line[i] === '\\') {
        n++;
        i++;
      }
      if (line[i] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2) {
          cur += '"';
          i++;
        }
      } else {
        cur += '\\'.repeat(n);
      }
      started = true;
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
      started = true;
      i++;
      continue;
    }
    if (!quoted && (c === ' ' || c === '\t')) {
      if (started) args.push(cur);
      cur = '';
      started = false;
      i++;
      continue;
    }
    cur += c;
    started = true;
    i++;
  }
  if (started) args.push(cur);
  return args;
}

/** What node.exe receives when cmd.exe runs an npm wrapper (`"%_prog%" "%dp0%\…\cli.js" %*`) with this line. */
function throughNpmWrapper(file: string, line: string, env: Record<string, string>): string[] {
  const outer = cmdPhase2(expandPercent(line, env));
  // The batch file runs with everything after its own path as %*.
  expect(outer.startsWith(`${file} `)).toBe(true);
  const rest = outer.slice(file.length + 1);
  // %* is replaced as text and not expanded again; the batch line then goes through phase 2.
  const inner = cmdPhase2(`"node" "C:\\npm\\cli.js" ${rest}`);
  return argvW(inner).slice(2);
}

describe('cmd.exe command lines for npm .cmd wrappers', () => {
  const env = { PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\x', x: 'EXPANDED' };
  const hostile = [
    'plain',
    'with space',
    'a" & calc & "b',
    '"&calc&"',
    'x | whoami',
    '> C:\\out.txt',
    '%PATH%',
    '%USERPROFILE%\\x',
    '!x!',
    '^',
    '^^',
    'trailing\\',
    'C:\\dir with space\\',
    'quote"inside',
    'back\\\\"slash',
    '(paren)',
    '',
    'üñí 日本',
    '--flag=value',
    '&& del /q *',
  ];

  it('passes every argument through exactly, operators and variables included', () => {
    const file = 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude-agent-acp.cmd';
    for (const arg of hostile) {
      expect(throughNpmWrapper(file, cmdCommandLine(file, [arg, '--acp']), env), JSON.stringify(arg)).toEqual([arg, '--acp']);
    }
    expect(throughNpmWrapper(file, cmdCommandLine(file, hostile), env)).toEqual(hostile);
  });

  it('catches what plain quoting got wrong (the model is strict enough)', () => {
    const file = 'C:\\npm\\claude-agent-acp.cmd';
    const old = (args: string[]) => [file, ...args].map(quoteWindowsArg).join(' ');
    expect(() => throughNpmWrapper(file, old(['a" & calc & "b']), env)).toThrow(/operator/);
    expect(throughNpmWrapper(file, old(['%x%']), env)).toEqual(['EXPANDED']);
  });

  it('keeps a wrapper path with spaces, parentheses and & in one piece', () => {
    const line = cmdCommandLine('C:\\Program Files (x86)\\R&D\\npm\\gemini.cmd', ['--acp']);
    const outer = cmdPhase2(expandPercent(line, env));
    expect(outer.startsWith('C:\\Program Files (x86)\\R&D\\npm\\gemini.cmd ')).toBe(true);
  });

  it('refuses line breaks, which cmd.exe cannot be told to read literally', () => {
    expect(() => cmdCommandLine('C:\\npm\\x.cmd', ['a\nb'])).toThrow(/line breaks/);
    expect(() => cmdCommandLine('C:\\npm\\x.cmd', ['a\rcalc'])).toThrow(/line breaks/);
    expect(() => cmdCommandLine('C:\\npm\\x.cmd', ['a\0'])).toThrow(/line breaks/);
  });
});

describe('finding programs on PATH (Windows rules)', () => {
  it('skips relative PATH entries, which would search the current folder', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fl-path-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'tool.CMD'), '');
    const env = { PATH: ['.', 'bin', '', bin].join(';'), PATHEXT: '.EXE;.CMD' };
    const before = process.cwd();
    process.chdir(dir);
    try {
      fs.writeFileSync(path.join(dir, 'tool.EXE'), '');
      expect(findOnWindowsPath('tool', env, ';')).toBe(path.join(bin, 'tool.CMD'));
      expect(findOnWindowsPath('missing', env, ';')).toBeNull();
    } finally {
      process.chdir(before);
    }
  });
});

describe('agent terminals', () => {
  function manager(cwd: string, approve: (info: TerminalInfo) => boolean) {
    const seen: TerminalInfo[] = [];
    const m = new TerminalManager(cwd, {
      approve: async (info) => {
        seen.push(info);
        return approve(info);
      },
      onStart: () => {},
      onData: () => {},
      onExit: () => {},
    });
    return { m, seen };
  }

  it('shows the variables an agent sets as part of the command the user approves', async () => {
    const { m, seen } = manager(os.tmpdir(), () => false);
    await expect(
      m.create({ sessionId: 's', command: 'npm', args: ['test'], env: [{ name: 'NODE_OPTIONS', value: '--require /tmp/evil.js' }] }),
    ).rejects.toThrow(/denied/);
    expect(seen[0].commandLine).toBe("NODE_OPTIONS='--require /tmp/evil.js' npm test");
  });

  it('resolves a relative folder against the session folder, as shown', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fl-term-'));
    const { m, seen } = manager(root, () => false);
    await expect(m.create({ sessionId: 's', command: 'ls', cwd: 'sub' })).rejects.toThrow(/denied/);
    expect(seen[0].cwd).toBe(path.join(root, 'sub'));
  });

  it('spells out invisible and direction-changing characters', () => {
    const rlo = String.fromCodePoint(0x202e);
    const zwsp = String.fromCodePoint(0x200b);
    expect(visibleText(`echo safe ${rlo}fdp.exe`)).toBe('echo safe <U+202E>fdp.exe');
    expect(visibleText(`rm${zwsp} -rf`)).toBe('rm<U+200B> -rf');
    expect(visibleText('a\x1b[2Kb\rc')).toBe('a<U+001B>[2Kb<U+000D>c');
    expect(visibleText('line one\n\tline two')).toBe('line one\n\tline two');
  });

  it('refuses environment names that would set other variables', async () => {
    const { m, seen } = manager(os.tmpdir(), () => true);
    await expect(m.create({ sessionId: 's', command: 'echo', args: ['x'], env: [{ name: 'A=B', value: '1' }] })).rejects.toThrow(/invalid environment/);
    expect(seen).toHaveLength(0);
  });

  it('caps the output an agent asks to keep', async () => {
    const { m } = manager(os.tmpdir(), () => true);
    const { terminalId } = await m.create({ sessionId: 's', command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(5000))"], outputByteLimit: 1e15 });
    await m.waitForExit({ sessionId: 's', terminalId });
    expect((await m.output({ sessionId: 's', terminalId })).output.length).toBe(5000);
    expect(MAX_OUTPUT_LIMIT).toBeLessThanOrEqual(16_000_000);
    const small = await m.create({ sessionId: 's', command: process.execPath, args: ['-e', "process.stdout.write('y'.repeat(5000))"], outputByteLimit: 100 });
    await m.waitForExit({ sessionId: 's', terminalId: small.terminalId });
    expect(await m.output({ sessionId: 's', terminalId: small.terminalId })).toMatchObject({ truncated: true, output: 'y'.repeat(100) });
    m.killAll();
  });
});

describe('sign-in links', () => {
  it('offers only the signing-in vendor’s own pages', () => {
    expect(allowedSignInUrl('gemini', 'https://accounts.google.com/o/oauth2/v2/auth?x=1')).toBe(true);
    expect(allowedSignInUrl('codex', 'https://auth.openai.com/oauth/authorize')).toBe(true);
    expect(allowedSignInUrl('claude', 'https://claude.ai/oauth/authorize')).toBe(true);
    expect(allowedSignInUrl('gemini', 'https://auth.openai.com/oauth/authorize')).toBe(false);
    expect(allowedSignInUrl('gemini', 'https://github.com/someone/phish')).toBe(false);
    expect(allowedSignInUrl('gemini', 'https://accounts.google.com.evil.example/')).toBe(false);
    expect(allowedSignInUrl('gemini', 'https://accounts.google.com@evil.example/')).toBe(false);
    expect(allowedSignInUrl('gemini', 'http://accounts.google.com/')).toBe(false);
    expect(allowedSignInUrl('unknown', 'https://accounts.google.com/')).toBe(false);
    expect(allowedExternal('https://user:pw@claude.ai/')).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('git helpers in a hostile repository', () => {
  it('never runs an fsmonitor program the repository configures', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fl-git-'));
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir });
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    await writeFile(path.join(dir, 'a.txt'), 'a\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'init');
    const marker = path.join(dir, 'fsmonitor-ran');
    const hook = path.join(os.tmpdir(), `fl-fsmonitor-${process.pid}.sh`);
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    run('config', 'core.fsmonitor', hook);

    await writeFile(path.join(dir, 'b.txt'), 'b\n');
    expect((await git.status(dir))?.files.map((f) => f.path)).toEqual(['b.txt']);
    const wt = await git.createWorktree(dir, 'task');
    await writeFile(path.join(wt.path, 'c.txt'), 'c\n');
    await git.mergeWorktree(dir, wt, 'task');
    await git.removeWorktree(dir, wt);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
