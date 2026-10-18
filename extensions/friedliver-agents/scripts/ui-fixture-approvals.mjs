// Approvals at every weight, on the afternoon of the design mockups (approvals/RESEARCH.md): Claude
// fixing formatCents waits on a routine `npm test`, an edit with its diff, a click on "Place order",
// a question for Gemini, an edit to .env.local and a force push (with the commits it would drop);
// two other chats wait on the same `npm test`, so Allow all shows. `countdown` gives the routine
// request a running countdown. Only the UI harness uses it (?fixture=approvals, &countdown=1).

const ROOT = '/Users/arun/code/shop';
const OPTIONS = [
  { optionId: 'allow', name: 'Yes', kind: 'allow_once' },
  { optionId: 'always', name: "Yes, and don't ask again for this session", kind: 'allow_always' },
  { optionId: 'reject', name: 'No', kind: 'reject_once' },
];
const dl = (op, text) => ({ op, text });

export function approvalsFixture(now = Date.now(), { countdown = false } = {}) {
  const sec = (s) => now - s * 1000;
  const chat = (id, agent, label, title, items, over = {}) => ({
    id,
    agent,
    label,
    title,
    cwd: ROOT,
    createdAt: sec(1800),
    busy: true,
    changedFiles: 0,
    items,
    depth: 0,
    files: ['src/format.ts'],
    lastActivity: sec(5),
    turns: 1,
    ...over,
  });
  const npmTest = (requestId, at, extra = {}) => ({
    kind: 'permission',
    requestId,
    title: 'npm test',
    toolKind: 'execute',
    options: OPTIONS,
    detail: { command: { line: 'npm test', cwd: ROOT }, text: 'Run the test suite to confirm the fix.' },
    at: sec(at),
    ...extra,
  });
  const main = [
    { kind: 'user', text: 'Fix formatCents for negative amounts, run the tests, check checkout on staging, then push.', images: [], at: sec(900) },
    { kind: 'tool', id: 'tc-read', title: 'Read src/format.ts', toolKind: 'read', status: 'completed', locations: [`${ROOT}/src/format.ts`] },
    { kind: 'agent', text: 'The sign is lost before formatting. I’ll keep it separately and format the absolute value.', at: sec(600) },
    {
      kind: 'permission',
      requestId: 'perm-edit',
      title: 'Edit src/format.ts',
      toolKind: 'edit',
      options: OPTIONS,
      detail: {
        files: [
          {
            path: `${ROOT}/src/format.ts`,
            added: 3,
            removed: 1,
            isNew: false,
            full: true,
            more: 0,
            lines: [
              dl(' ', 'export function formatCents(cents: number): string {'),
              dl('-', '  return `$${(cents / 100).toFixed(2)}`;'),
              dl('+', "  const sign = cents < 0 ? '-' : '';"),
              dl('+', '  const abs = Math.abs(cents);'),
              dl('+', '  return `${sign}$${(abs / 100).toFixed(2)}`;'),
              dl(' ', '}'),
            ],
          },
        ],
        always: [{ kind: 'folder', folder: `${ROOT}/src`, access: 'write' }],
      },
      at: sec(500),
    },
    npmTest('perm-test', 420, countdown ? { autoAt: now + 6000 } : {}),
    {
      kind: 'bridge',
      requestId: 'bridge-click',
      tool: 'browser_click',
      target: { browser: true },
      text: 'button#place-order',
      state: 'awaiting',
      always: 'https://staging.shop.dev',
      at: sec(60),
    },
    {
      kind: 'bridge',
      requestId: 'bridge-ask',
      tool: 'ask_agent',
      target: { agent: 'gemini' },
      text: 'Does the reports page already have a CSV helper I should reuse, or should I add one under src/lib?',
      state: 'awaiting',
      always: 'in every chat',
      at: sec(120),
    },
    {
      kind: 'permission',
      requestId: 'perm-env',
      title: 'Edit .env.local',
      toolKind: 'edit',
      options: OPTIONS,
      detail: { files: [{ path: `${ROOT}/.env.local`, added: 1, removed: 0, isNew: false, full: true, more: 0, lines: [dl(' ', 'API_URL=https://staging.shop.dev'), dl('+', 'CHECKOUT_DEBUG=1')] }] },
      at: sec(30),
    },
    {
      kind: 'permission',
      requestId: 'perm-push',
      title: 'git push --force origin main',
      toolKind: 'execute',
      options: OPTIONS,
      detail: {
        command: { line: 'git push --force origin main', cwd: ROOT },
        text: 'Push the rebased migration branch so CI runs on it.',
        dropped: {
          ref: 'origin/main',
          commits: [
            { hash: 'a41c9e2', subject: 'fix(reports): CSV escaping for commas', author: 'Priya' },
            { hash: '9be0d17', subject: 'chore: bump vitest to 3.2', author: 'Rahul' },
            { hash: '77d2a40', subject: 'feat(checkout): order note field', author: 'Meena' },
          ],
          more: 0,
        },
      },
      at: sec(15),
    },
  ];
  const chats = [
    chat('chat-shop', 'claude', 'Claude 1', 'Fix formatCents for negative amounts', main),
    chat('chat-csv', 'codex', 'Codex 1', 'Add CSV export to the reports page', [
      { kind: 'user', text: 'Add a CSV export button to the reports page.', images: [], at: sec(1200) },
      { kind: 'command', commandId: 'cmd-csv-test', commandLine: 'npm test', cwd: ROOT, outside: false, state: 'awaiting', output: '', at: sec(360) },
    ]),
    chat('chat-deps', 'claude', 'Claude 2', 'Bump the test dependencies', [
      { kind: 'user', text: 'Bump vitest and the testing libraries, then run the tests.', images: [], at: sec(600) },
      npmTest('perm-deps-test', 300),
      {
        kind: 'question',
        requestId: 'q-deps',
        message: 'Which vitest version should I pin?',
        state: 'awaiting',
        fields: [
          {
            key: 'version',
            title: 'Version',
            type: 'choice',
            required: true,
            options: [
              { value: '3.2', title: '3.2 (Recommended)', description: 'Latest stable; the config needs no change' },
              { value: '3.1', title: '3.1', description: 'What the API package already uses' },
              { value: '2.1', title: '2.1', description: 'The last 2.x, if 3 breaks the snapshot tests' },
            ],
          },
        ],
        at: sec(90),
      },
    ]),
  ];
  return { state: { chats, images: [], links: [] } };
}
