// A Claude chat that launched three subagents (Claude's Agent tool): two still
// working, one done with its answer, each with the steps it took, shaped the
// way FriedLiver's reducer keeps them (`tool: 'Agent'`, inner calls with
// `parent`). Plus a Claude Code session from outside FriedLiver with
// subagents, and one without, which the map leaves off. Only the UI harness
// uses it (?fixture=subagents).

export function subagentsFixture(now = Date.now()) {
  const s = (sec) => now - sec * 1000;
  const agent = (id, title, status, extra = {}) => ({ kind: 'tool', id, title, toolKind: 'think', status, locations: [], tool: 'Agent', ...extra });
  const step = (id, parent, title, status = 'completed', toolKind = 'read') => ({ kind: 'tool', id, title, toolKind, status, locations: [], tool: 'Read', parent });
  const items = [
    { kind: 'user', text: 'Review the payments module three ways in parallel: security, tests and performance.', images: [] },
    { kind: 'agent', text: "I'll start three reviewers in parallel and combine what they find." },
    agent('a-sec', 'Security review of payments', 'in_progress', { startedAt: s(84) }),
    agent('a-test', 'Find gaps in payment tests', 'in_progress', { startedAt: s(41) }),
    agent('a-perf', 'Profile the refund path', 'completed', {
      startedAt: s(140),
      ms: 52_000,
      out: [{ t: 'text', text: 'The refund path makes **one query per line item**. Batching them in `refunds.ts` cuts a 40-line refund from 1.9s to 120ms. No other hot spots.' }],
    }),
    step('s1', 'a-sec', 'Read src/payments/charge.ts'),
    step('p1', 'a-perf', 'Read src/payments/refunds.ts'),
    step('t1', 'a-test', 'Find files matching test/payments/**', 'completed', 'search'),
    step('s2', 'a-sec', 'grep -n "req.body" src/payments', 'completed', 'search'),
    step('p2', 'a-perf', 'Run npm run bench -- refunds', 'completed', 'execute'),
    step('t2', 'a-test', 'Read test/payments/charge.test.ts'),
    step('s3', 'a-sec', 'Read src/payments/webhook.ts', 'in_progress'),
    step('t3', 'a-test', 'Read src/payments/refunds.ts', 'in_progress'),
  ];
  const chat = {
    id: 'chat-pay',
    agent: 'claude',
    label: 'Claude 1',
    title: 'Review the payments module',
    cwd: '/home/dev/shop',
    createdAt: s(200),
    busy: true,
    changedFiles: 0,
    items,
    depth: 0,
    files: [],
    lastActivity: s(2),
    turns: 1,
  };
  const claude = [
    { id: 'cc-1', cwd: '/home/dev/shop', title: 'Fan out docs writers', lastActivity: s(20), messages: 6, subagents: [{ id: 'x1', title: 'Write the API guide', done: false }, { id: 'x2', title: 'Write the setup guide', done: true }] },
    { id: 'cc-2', cwd: '/home/dev/shop', title: 'IDE identification question', lastActivity: s(30), messages: 2, subagents: [] },
  ];
  return { state: { chats: [chat], images: [], links: [] }, claude, ids: { chat: chat.id } };
}
