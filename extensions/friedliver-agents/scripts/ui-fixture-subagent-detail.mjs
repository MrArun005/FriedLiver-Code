// Two Claude Code subagents from outside FriedLiver, as the host's subagentDetail message carries them: one still
// working (a real-length brief, ~60 steps with commands, reads, edits, a failed test, notes), one finished with its
// report. Shapes are those host/subagentDetail.ts builds from a transcript. Only the UI harness uses it
// (--only subagent-detail).

const SESSION = '607dfe49-a562-4c39-8755-d4057bf35d87';
const ROOT = '/Users/dev/code/wt-token-waste/extensions/friedliver-agents';

const BRIEF = `FriedLiver (~/code/FriedLiver-Code; extension extensions/friedliver-agents). A token-efficiency review (scored 7/10) listed waste below. **Verify each claim against the code first** (file:line, measured token cost); fix only confirmed ones; report any claim that's wrong.

Branch \`perf/token-waste\` from origin/main; open a PR to main when CI is green; do NOT merge.

Rules: never a Co-Authored-By trailer; no Docker; tests first; design system is law (COMPONENTS.md + media/tokens.css); stop if free disk < 3 GiB; clean temp dirs.

Findings:
1. browser console tool has no output limit (up to ~50k tokens/call) → default budget ~1.5k tokens, only new lines since the last call.
2. \`browser_snapshot\` returns the full accessibility tree every call → diff against the previous snapshot.
3. Images re-sent on every turn → send once, refer by hash.
4. The Agent Manager re-posts every session on each file event → post only what changed.
5. System prompt repeats the tool list twice.
6. (Deferred until fix/agent-errors-and-chat-reuse merges) consult re-sends the whole transcript.`;

const REPORT = `## Token waste: 5 of 6 confirmed, 4 fixed

| # | Claim | Verdict | Fix |
|---|---|---|---|
| 1 | console has no limit | **confirmed**: 48k tokens on a noisy page | budget 1.5k, new lines only (\`browser.ts:212\`) |
| 2 | snapshot sent whole | **confirmed**: 9–14k per call | diff vs. previous (\`browser.ts:340\`) |
| 3 | images re-sent | wrong: sent once already (\`core.ts:1188\`) | none |
| 4 | Manager re-posts all | **confirmed** | post on change only |
| 5 | tool list twice | **confirmed**: 1.1k tokens/turn | dropped the copy |
| 6 | consult re-sends | deferred | note in \`connections.ts:96\` |

Tests: 2,914 passed. tsc and lint clean. PR #57 is green.`;

let seq = 0;
const tool = (tool, toolKind, title, extra = {}) => ({ kind: 'tool', id: `t${++seq}`, seq, rev: seq, tool, toolKind, title, status: 'completed', locations: [], ...extra });
const bash = (command, about, extra = {}) => tool('Bash', 'execute', command, { cmd: { line: command }, ...(about ? { about } : {}), ...extra });
const read = (file) => tool('Read', 'read', `Read ${ROOT}/${file}`, { locations: [`${ROOT}/${file}`], ms: 40 });
const edit = (file, old, now) => tool('Edit', 'edit', `Edit ${ROOT}/${file}`, {
  locations: [`${ROOT}/${file}`],
  ms: 60,
  out: [{ t: 'diff', path: `${ROOT}/${file}`, added: now.length, removed: old.length, more: 0, isNew: false, lines: [...old.map((text) => ({ op: '-', text })), ...now.map((text) => ({ op: '+', text }))] }],
});
const note = (text, extra = {}) => ({ kind: 'note', id: `n${++seq}`, seq, rev: seq, text, ...extra });

function working() {
  seq = 0;
  const entries = [
    bash('df -g / | tail -1; git -C ~/code/FriedLiver-Code fetch -q origin', 'Check disk and fetch', { ms: 1800, out: [{ t: 'text', text: '/dev/disk3s1s1  228  13  12  52%  /' }] }),
    bash('git -C ~/code/FriedLiver-Code worktree add -b perf/token-waste ~/code/wt-token-waste origin/main', 'Create the worktree', { ms: 2400 }),
    read('src/host/browser.ts'),
    tool('Grep', 'search', 'grep browser_console src', { ms: 90 }),
    read('src/bridge/mcp.ts'),
    note('Claim 1 holds: `console` returns every buffered line. Measuring a noisy page before changing it.'),
    bash('node scripts/measure-tokens.mjs --tool browser_console --page fixtures/noisy.html', 'Measure console output', { ms: 5200, out: [{ t: 'text', text: 'browser_console: 191,204 chars ≈ 47,801 tokens' }] }),
    read('src/host/externalBrowser.ts'),
    read('test/browser.test.ts'),
    edit('test/browser.test.ts', [], ["  it('keeps a console read within its budget', async () => {", '    expect(tokens(await console(page))).toBeLessThan(1600);', '  });']),
    bash('npx vitest run test/browser.test.ts', 'Run the browser tests (expect a failure first)', { status: 'failed', ms: 7400, exit: 1, out: [{ t: 'text', text: 'Exit code 1\n FAIL  test/browser.test.ts > keeps a console read within its budget\nAssertionError: expected 47801 to be less than 1600' }] }),
    edit('src/host/browser.ts', ['    return lines.join(\'\\n\');'], ['    return budget(lines.slice(this.seen), CONSOLE_BUDGET);', '    // ponytail: char budget ≈ tokens × 4']),
    bash('npx vitest run test/browser.test.ts', 'Run the browser tests', { ms: 6900, out: [{ t: 'text', text: ' ✓ test/browser.test.ts (41 tests) 812ms' }] }),
    note('1 fixed. Claim 2 next: `browser_snapshot`.'),
    read('src/host/browserRules.ts'),
    tool('Grep', 'search', 'grep snapshot src/bridge', { ms: 70 }),
    read('src/bridge/protocol.ts'),
    edit('src/host/browser.ts', ['    return tree;'], ['    const diff = treeDiff(this.lastTree, tree);', '    this.lastTree = tree;', '    return diff ?? tree;']),
    bash('npx vitest run test/browser.test.ts test/mcp.test.ts', 'Run browser and MCP tests', { ms: 9100, out: [{ t: 'text', text: ' ✓ test/browser.test.ts (43 tests)\n ✓ test/mcp.test.ts (28 tests)' }] }),
    read('src/host/core.ts'),
    tool('Grep', 'search', 'grep -n imageData src/host/core.ts', { ms: 60 }),
    note('Claim 3 is wrong: images are sent once and then referred to by hash (`core.ts:1188`). Leaving it.'),
    read('src/extension.ts'),
    read('src/host/claudeSessions.ts'),
    edit('src/extension.ts', ['    for (const s of this.surfaces) post(s, msg);'], ['    if (same(msg, this.lastPosted)) return;', '    for (const s of this.surfaces) post(s, msg);']),
    bash('npx vitest run test/claudeSessions.test.ts test/claudeSubagents.test.ts', 'Run the Claude Code session tests', { ms: 4100 }),
    read('src/shared/session.ts'),
    edit('src/shared/session.ts', ['  tools: toolList(agent),', '  instructions: `${base}\\n${toolList(agent)}`,'], ['  tools: toolList(agent),', '  instructions: base,']),
    bash('npx tsc --noEmit -p .', 'Typecheck', { ms: 21_000 }),
    bash('npx eslint src test', 'Lint', { ms: 14_000 }),
    bash('npx vitest run', 'Run the full suite', { status: 'in_progress' }),
  ];
  return {
    sessionId: SESSION,
    id: 'toolu_01EyeNNJQdfnUL6zhNS2XAVe',
    prompt: BRIEF,
    agentType: 'general-purpose',
    model: 'claude-opus-5-5',
    usage: { input: 340, output: 21_367, cacheRead: 34_690_515, cacheWrite: 291_332 },
    entries,
    reset: true,
    first: 1,
    total: seq,
    files: [
      { path: `${ROOT}/src/host/browser.ts`, edits: 2, reads: 1 },
      { path: `${ROOT}/test/browser.test.ts`, edits: 1, reads: 1 },
      { path: `${ROOT}/src/extension.ts`, edits: 1, reads: 1 },
      { path: `${ROOT}/src/shared/session.ts`, edits: 1, reads: 1 },
      { path: `${ROOT}/src/bridge/mcp.ts`, edits: 0, reads: 1 },
      { path: `${ROOT}/src/host/externalBrowser.ts`, edits: 0, reads: 1 },
      { path: `${ROOT}/src/host/browserRules.ts`, edits: 0, reads: 1 },
      { path: `${ROOT}/src/bridge/protocol.ts`, edits: 0, reads: 1 },
      { path: `${ROOT}/src/host/core.ts`, edits: 0, reads: 1 },
      { path: `${ROOT}/src/host/claudeSessions.ts`, edits: 0, reads: 1 },
    ],
    filesMore: 0,
  };
}

function finished() {
  const d = working();
  const last = d.entries.at(-1);
  d.entries[d.entries.length - 1] = { ...last, status: 'completed', ms: 96_000, out: [{ t: 'text', text: ' Test Files  214 passed (214)\n      Tests  2914 passed (2914)' }] };
  d.entries.push(bash('git push -u origin perf/token-waste && gh pr create --base main --fill', 'Push and open the PR', { ms: 6100, out: [{ t: 'text', text: 'https://github.com/MrArun005/FriedLiver-Code/pull/57' }] }));
  d.entries.push(bash('gh run watch --exit-status', 'Wait for CI', { ms: 412_000 }));
  d.total = seq;
  d.id = 'toolu_01AuditAgentMap';
  d.usage = { input: 512, output: 38_904, cacheRead: 52_118_220, cacheWrite: 402_118 };
  d.report = REPORT;
  return d;
}

/** The session the two subagents belong to (a ClaudeSession), and each one's detail by its id. */
export function subagentDetailFixture(now = Date.now()) {
  const session = {
    id: SESSION,
    cwd: '/Users/dev/HRMS',
    title: 'IDE identification question',
    lastActivity: now - 2000,
    messages: 912,
    subagents: [
      { id: 'toolu_01EyeNNJQdfnUL6zhNS2XAVe', title: 'Fix token waste findings', agentType: 'general-purpose', model: 'claude-opus-5-5', startedAt: now - 774_000, lastActivity: now - 2000, idle: false, tools: 31, last: 'Bash · npx vitest run' },
      { id: 'toolu_01AuditAgentMap', title: 'Audit the token waste', end: 'done', agentType: 'general-purpose', model: 'claude-opus-5-5', startedAt: now - 3_400_000, lastActivity: now - 1_900_000, idle: true, tools: 33 },
    ],
  };
  const w = working();
  const f = finished();
  w.startedAt = now - 774_000;
  w.lastAt = now - 2000;
  f.startedAt = now - 3_400_000;
  f.lastAt = now - 1_900_000;
  return { session, details: { [w.id]: w, [f.id]: f } };
}
