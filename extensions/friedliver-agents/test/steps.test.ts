import { describe, expect, it } from 'vitest';
import { applyUpdate, type Item } from '../src/shared/model';
import {
  foldApprovals,
  MAX_COMMAND,
  argvLine,
  commandSummary,
  cut,
  heredocOf,
  inFolder,
  rawOutputText,
  runnableCode,
  shortPaths,
  shownCommand,
  stepFacts,
  stepOutput,
  stepSummary,
  typeable,
  withRawOutput,
} from '../src/shared/steps';

const PIPE = `cat << 'EOF' | python3 /tmp/agent_heavy/minidb.py
CREATE TABLE users (id INT, email TEXT, age INT);
INSERT INTO users VALUES (1, 'alice@example.com', 28);
SELECT * FROM users;
exit
EOF`;
const README = `cat << 'EOF' > /tmp/agent_heavy/README.md
# Mini SQL Database Engine

A lightweight SQL engine.
EOF`;
const WRITE_THEN_RUN = `cat << 'EOF' > /tmp/agent_heavy/demo_advanced.sql
-- Advanced demo
SELECT 1;
EOF
python3 /tmp/agent_heavy/minidb.py /tmp/agent_heavy/demo_advanced.sql`;

describe('heredocs', () => {
  it('finds the heredoc, its delimiter, its text and what follows', () => {
    expect(heredocOf(PIPE)).toEqual({
      head: "cat << 'EOF' | python3 /tmp/agent_heavy/minidb.py",
      delimiter: 'EOF',
      body: "CREATE TABLE users (id INT, email TEXT, age INT);\nINSERT INTO users VALUES (1, 'alice@example.com', 28);\nSELECT * FROM users;\nexit",
      before: '',
      after: '',
      closed: true,
    });
    expect(heredocOf(WRITE_THEN_RUN)).toMatchObject({ file: '/tmp/agent_heavy/demo_advanced.sql', after: 'python3 /tmp/agent_heavy/minidb.py /tmp/agent_heavy/demo_advanced.sql' });
    expect(heredocOf('npm test')).toBeUndefined();
    expect(heredocOf('cat <<< "a here-string"')).toBeUndefined();
  });

  it('reads the file a heredoc writes, in its usual spellings', () => {
    expect(heredocOf(README)?.file).toBe('/tmp/agent_heavy/README.md');
    expect(heredocOf('cat > notes.txt << EOF\nhi\nEOF')?.file).toBe('notes.txt');
    expect(heredocOf('cat <<EOF >> log.txt\nhi\nEOF')).toMatchObject({ file: 'log.txt', append: true });
    expect(heredocOf('cat << "END" > "my file.md"\nhi\nEND')?.file).toBe('my file.md');
    expect(heredocOf('cat <<EOF | tee -a out.txt\nhi\nEOF')).toMatchObject({ file: 'out.txt', append: true });
    expect(heredocOf('cd /tmp/x && cat << EOF > a.sql\nSELECT 1;\nEOF')?.file).toBe('a.sql');
    // <<- strips leading tabs, also before the delimiter.
    expect(heredocOf('cat <<-EOF > a.txt\n\tindented\n\tEOF')).toMatchObject({ body: 'indented', closed: true });
    // Not a write: a program reads the heredoc, and its output goes to the file.
    expect(heredocOf("python3 - << 'EOF' > out.txt\nprint(1)\nEOF")?.file).toBeUndefined();
    expect(heredocOf('cat << EOF | python3 x.py\nSELECT 1;\nEOF')?.file).toBeUndefined();
    expect(heredocOf('cat << EOF > a.txt\nnot closed')).toMatchObject({ closed: false, body: 'not closed' });
  });
});

describe('step summaries', () => {
  it('names a heredoc piped into a program by its program and target, with its line count', () => {
    const s = stepSummary({ title: PIPE, toolKind: 'execute', cmd: { line: PIPE } });
    expect(s).toMatchObject({ verb: 'Run', text: 'cat << EOF | python3 minidb.py', mono: true, lines: 6 });
    expect(s.full).toBe(PIPE);
  });

  it('reads a heredoc write as Write <file> with the lines it writes', () => {
    expect(stepSummary({ title: README, toolKind: 'execute', cmd: { line: README } })).toMatchObject({ verb: 'Write', text: 'README.md', mono: false, lines: 3, file: '/tmp/agent_heavy/README.md' });
    expect(commandSummary(WRITE_THEN_RUN)).toMatchObject({ verb: 'Write', text: 'demo_advanced.sql, then python3 minidb.py demo_advanced.sql', lines: 2 });
  });

  it('shows the program after a leading cd, and keeps the folder', () => {
    expect(commandSummary('cd /tmp/agent_heavy && python3 minidb.py test.sql 2>&1')).toEqual({ verb: 'Run', text: 'python3 minidb.py test.sql 2>&1', mono: true, lines: undefined, dir: '/tmp/agent_heavy' });
    expect(commandSummary('ls -lh /tmp/agent_heavy/ && wc -l /tmp/agent_heavy/minidb.py').text).toBe('ls -lh agent_heavy/ && wc -l minidb.py');
  });

  it('cuts long one-liners with an ellipsis and keeps the whole command for the tooltip', () => {
    const long = `echo ${'x'.repeat(300)}`;
    const s = stepSummary({ title: long, toolKind: 'execute', cmd: { line: long } });
    expect(s.text.length).toBeLessThanOrEqual(110);
    expect(s.text.endsWith('…')).toBe(true);
    expect(s.full).toBe(long);
    expect(cut('short')).toBe('short');
    expect(cut('a'.repeat(20), 10)).toBe(`${'a'.repeat(9)}…`);
  });

  it('takes the command from the title when an execute step has no input', () => {
    expect(stepSummary({ title: 'npm test', toolKind: 'execute' })).toMatchObject({ verb: 'Run', text: 'npm test', mono: true });
    expect(stepSummary({ title: 'Run npm test -- --run auth', toolKind: 'execute' }).text).toBe('npm test -- --run auth');
    expect(stepSummary({ title: '`git status`', toolKind: 'execute' }).text).toBe('git status');
  });

  it('gives other tools a verb from their kind, or from the title when it says better', () => {
    expect(stepSummary({ title: 'Read src/format.ts (1 - 50)', toolKind: 'read' })).toMatchObject({ verb: 'Read', text: 'src/format.ts (1 - 50)' });
    expect(stepSummary({ title: 'Write README.md', toolKind: 'edit' })).toMatchObject({ verb: 'Write', text: 'README.md' });
    expect(stepSummary({ title: 'Edit src/store.ts', toolKind: 'edit' })).toMatchObject({ verb: 'Edit', text: 'src/store.ts' });
    expect(stepSummary({ title: 'grep -n "formatCents" src', toolKind: 'search' })).toMatchObject({ verb: 'Search', text: 'grep -n "formatCents" src', mono: true });
    expect(stepSummary({ title: 'Find `src` `*.ts`', toolKind: 'search' })).toMatchObject({ verb: 'Find', text: 'src *.ts' });
    expect(stepSummary({ title: 'Fetch https://example.com', toolKind: 'fetch' })).toMatchObject({ verb: 'Fetch', text: 'https://example.com' });
    expect(stepSummary({ title: 'Check the edge cases', toolKind: 'think' })).toMatchObject({ verb: 'Think', text: 'Check the edge cases' });
    expect(stepSummary({ title: 'Ready to code?', toolKind: 'switch_mode' })).toMatchObject({ verb: 'Plan', text: 'Ready to code?' });
    expect(stepSummary({ title: 'mcp__friedliver__list_chats', toolKind: 'other' })).toMatchObject({ verb: 'FriedLiver', text: 'list chats' });
    expect(stepSummary({ title: 'Delete old.txt' })).toMatchObject({ verb: 'Delete', text: 'old.txt' });
    expect(stepSummary({ title: 'Something\nwith lines', toolKind: 'think' }).text).toBe('Something with lines');
  });

  it('shortens paths in command lines only where they are paths', () => {
    expect(shortPaths('python3 /tmp/agent_heavy/minidb.py ./src/a.ts ../x/y.js ~/z/w.md')).toBe('python3 minidb.py a.ts y.js w.md');
    expect(shortPaths('curl https://example.com/a/b 2>&1')).toBe('curl https://example.com/a/b 2>&1');
  });
});

describe('step output', () => {
  it('takes off the console fence Claude wraps output in, and reads its exit code', () => {
    expect(stepOutput('```console\nOK: 22 queries\n```')).toEqual({ text: 'OK: 22 queries', lang: 'console' });
    expect(stepOutput('```console\nExit code 2\nError: bad SQL\n```')).toEqual({ text: 'Error: bad SQL', lang: 'console', exit: 2 });
    expect(stepOutput('plain output\n')).toEqual({ text: 'plain output\n' });
    // Output cut to its end lost the opening fence.
    expect(stepOutput('…\nlast lines\n```')).toEqual({ text: '…\nlast lines' });
    // Code fences inside the output aren't taken apart.
    expect(stepOutput('```\na\n```\ntext\n```\nb\n```').text).toContain('text');
  });
});

describe('running a shown command', () => {
  it('runs shell blocks as they are, and only the commands of a console block', () => {
    expect(runnableCode('bash', 'npm ci\nnpm test\n')).toBe('npm ci\nnpm test');
    expect(runnableCode('sh', '$ npm test\n$ npm run build')).toBe('npm test\nnpm run build');
    expect(runnableCode('console', '$ npm test\n> vitest run\n 12 passed\n$ ls \\\n  -la\nfoo')).toBe('npm test\nls \\\n  -la');
    expect(runnableCode('console', 'just output')).toBeUndefined();
    expect(runnableCode('ts', 'const a = 1;')).toBeUndefined();
    expect(runnableCode('ZSH', 'echo hi')).toBe('echo hi');
    expect(runnableCode('bash', 'printf "\u001b[31mred"')).toBeUndefined();
  });

  it('types only text without control characters, up to a limit', () => {
    expect(typeable('cat << EOF\n\tx\nEOF')).toBe(true);
    expect(typeable('echo \u0007')).toBe(false);
    expect(typeable('echo \u009b')).toBe(false);
    expect(typeable('   ')).toBe(false);
    expect(typeable('x'.repeat(MAX_COMMAND + 1))).toBe(false);
  });

  it('accepts only a command the chat showed in full', () => {
    const items: Item[] = [
      { kind: 'tool', id: 't1', title: PIPE, toolKind: 'execute', locations: [], cmd: { line: PIPE } },
      { kind: 'tool', id: 't2', title: 'big', toolKind: 'execute', locations: [], cmd: { line: 'echo cut', cut: true } },
      { kind: 'agent', text: 'Run it:\n```bash\ncd /tmp && python3 minidb.py\n```\nand\n```console\n$ npm test\nok\n```' },
      { kind: 'link', linkId: 'l', role: 'reply', chatId: 'c2', agent: 'codex', label: 'Codex', text: '```sh\nmake check\n```', by: 'user' },
    ];
    expect(shownCommand(items, PIPE)).toBe(true);
    expect(shownCommand(items, 'cd /tmp && python3 minidb.py')).toBe(true);
    expect(shownCommand(items, 'npm test')).toBe(true);
    expect(shownCommand(items, 'make check')).toBe(true);
    expect(shownCommand(items, 'echo cut')).toBe(false);
    expect(shownCommand(items, 'rm -rf ~')).toBe(false);
    expect(shownCommand(items, 'ok')).toBe(false);
    expect(shownCommand(items, `${PIPE}\nrm -rf ~`)).toBe(false);
    // A tool that isn't a shell step, though its input has a "command", runs nothing.
    expect(shownCommand([{ kind: 'tool', id: 'm', title: 'mcp tool', toolKind: 'other', locations: [], cmd: { line: 'make deploy' } }], 'make deploy')).toBe(false);
    expect(stepSummary({ title: 'Deploy it', toolKind: 'other', cmd: { line: 'make deploy' } })).toMatchObject({ verb: 'Tool', text: 'Deploy it' });
  });

  it('turns an argv into a line a shell runs the same way', () => {
    expect(argvLine(['/bin/zsh', '-lc', 'cd app && npm test'])).toBe('cd app && npm test');
    expect(argvLine(['git', 'commit', '-m', "it's done"])).toBe("git commit -m 'it'\\''s done'");
  });
});

describe('step facts', () => {
  it('keeps the command, its description, exit code and duration on the tool item', () => {
    let items: Item[] = [];
    items = applyUpdate(items, { sessionUpdate: 'tool_call', toolCallId: 't1', title: PIPE, kind: 'execute', status: 'pending', rawInput: { command: PIPE, description: 'Try queries' } }, 1000);
    items = applyUpdate(items, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' }, 5000);
    items = applyUpdate(items, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', _meta: { terminal_exit: { exit_code: 0 } } }, 5380);
    expect(items[0]).toMatchObject({ cmd: { line: PIPE }, about: 'Try queries', exit: 0, startedAt: 5000, ms: 380 });
  });

  it('counts no duration without an in-progress report, and reads exit codes from raw output', () => {
    const tool = stepFacts({ toolCallId: 't', status: 'failed', rawOutput: { exit_code: 3 } }, { cmd: { line: 'false' } }, 9000);
    expect(tool).toEqual({ cmd: { line: 'false' }, exit: 3 });
  });

  it('shows the output a raw output carries when the tool shows none', () => {
    let items: Item[] = [];
    items = applyUpdate(items, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'npm test', kind: 'execute', status: 'in_progress', rawInput: { command: ['bash', '-lc', 'npm test'] } }, 100);
    items = applyUpdate(items, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed', rawOutput: { stdout: '1 failed', stderr: 'boom', exit_code: 1 } }, 350);
    expect(items[0]).toMatchObject({ cmd: { line: 'npm test' }, exit: 1, ms: 250, out: [{ t: 'text', text: '1 failed\nboom' }] });
    // Text the tool showed itself wins; a raw string isn't read.
    expect(withRawOutput([{ t: 'text', text: 'shown' }], { stdout: 'raw' })).toEqual([{ t: 'text', text: 'shown' }]);
    expect(rawOutputText('anything')).toBeUndefined();
    expect(rawOutputText({ formatted_output: 'fmt', stdout: 'x' })).toBe('fmt');
  });

  it('cuts a command longer than it keeps, and turns argv into a line', () => {
    const long = `echo ${'x'.repeat(MAX_COMMAND)}`;
    expect(stepFacts({ toolCallId: 't', title: 'x', rawInput: { command: long } }, undefined, undefined).cmd).toMatchObject({ cut: true });
    expect(stepFacts({ toolCallId: 't', title: 'x', rawInput: { command: ['bash', '-lc', 'npm test'], cwd: '/w' } }, undefined, undefined).cmd).toEqual({ line: 'npm test', cwd: '/w' });
  });
});

describe('paths in the chat folder', () => {
  it('resolves relative paths and keeps outside ones out', () => {
    expect(inFolder('/home/dev/app', 'src/a.ts')).toBe('/home/dev/app/src/a.ts');
    expect(inFolder('/home/dev/app', '/home/dev/app/README.md')).toBe('/home/dev/app/README.md');
    expect(inFolder('/home/dev/app', './x/../y.ts')).toBe('/home/dev/app/y.ts');
    expect(inFolder('/home/dev/app', '../other/a.ts')).toBeUndefined();
    expect(inFolder('/home/dev/app', '/home/dev/application/a.ts')).toBeUndefined();
    expect(inFolder('/home/dev/app', '/tmp/a.ts')).toBeUndefined();
    expect(inFolder('/home/dev/app', '~/a.ts')).toBeUndefined();
    expect(inFolder('/home/dev/app', '/home/dev/app')).toBeUndefined();
    expect(inFolder('C:\\work\\app', 'src\\a.ts')).toBe('C:\\work\\app\\src\\a.ts');
    expect(inFolder('C:\\work\\app', 'c:\\Work\\App\\b.ts')).toBe('c:\\Work\\App\\b.ts');
  });
});

describe('friendly tool names and folded approvals', () => {
  it('names MCP tools without their mcp__server__ prefix, FriedLiver browser tools in plain words', () => {
    expect(stepSummary({ title: 'mcp__friedliver__browser_click', toolKind: 'other', input: '{"text":"Add to bag"}' })).toMatchObject({ verb: 'Clicked', text: '‘Add to bag’' });
    expect(stepSummary({ title: 'mcp__friedliver__browser_screenshot' })).toMatchObject({ verb: 'Took a screenshot', text: '' });
    expect(stepSummary({ title: 'Tool mcp__friedliver__browser_open', input: '{"url":"https://www.myntra.com/puma"}' })).toMatchObject({ verb: 'Opened', text: 'myntra.com/puma' });
    expect(stepSummary({ title: 'mcp__friedliver__browser_type', input: '{"selector":"#q","text":"puma"}' })).toMatchObject({ verb: 'Typed', text: '‘puma’' });
    expect(stepSummary({ title: 'mcp__friedliver__browser_snapshot' })).toMatchObject({ verb: 'Read page', text: '' });
    expect(stepSummary({ title: 'mcp__friedliver__browser_take_screenshot' })).toMatchObject({ verb: 'Browser', text: 'take screenshot' });
    expect(stepSummary({ title: 'mcp__github__create_issue' })).toMatchObject({ verb: 'github', text: 'create issue' });
    expect(stepSummary({ title: 'mcp__friedliver__ask_agent' })).toMatchObject({ verb: 'FriedLiver', text: 'ask agent' });
  });

  it('shows a long path by its last part', () => {
    const p = '/Users/a/Library/Application Support/FriedLiver/User/globalStorage/x/screenshot-6.png';
    expect(stepSummary({ title: `Read ${p}`, toolKind: 'read' })).toMatchObject({ verb: 'Read', text: 'screenshot-6.png', full: `Read ${p}` });
  });

  const tool = (id: string, title: string): Item => ({ kind: 'tool', id, title, locations: [] }) as Item;
  const bridge = (requestId: string, t: string, state: 'awaiting' | 'allowed' | 'denied'): Item =>
    ({ kind: 'bridge', requestId, tool: t, target: { browser: true }, text: '', state }) as Item;

  it('folds an answered approval into the tool row it approved, keeps pending and unmatched ones', () => {
    const items = [
      tool('t1', 'mcp__friedliver__browser_click'),
      bridge('r1', 'browser_click', 'allowed'),
      tool('t2', 'mcp__friedliver__browser_open'),
      bridge('r2', 'browser_open', 'awaiting'),
      bridge('r3', 'browser_type', 'denied'),
      { kind: 'permission', requestId: 'p1', toolCallId: 't2', title: 'x', options: [], answer: 'Allow' } as Item,
    ];
    const { items: out, approvals } = foldApprovals(items);
    expect(out.map((i) => ('requestId' in i ? i.requestId : 'id' in i ? i.id : ''))).toEqual(['t1', 't2', 'r2', 'r3']);
    expect(approvals).toEqual({ t1: { text: 'allowed', ok: true }, t2: { text: 'Allow', ok: true } });
  });
});
