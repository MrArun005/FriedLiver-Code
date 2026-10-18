// The Decision Inbox on a busy afternoon: five chats waiting on you for ten things at once. Three
// of them run the same `npm test` in the same folder (one through FriedLiver's own terminal), one
// runs it elsewhere; an edit with its diff; a review; a site to open and a button to press there;
// a question for another agent (with its ten-minute timeout); and a question with options. With
// `answered`, the same afternoon after you answered everything. Only the UI harness uses it
// (?fixture=inbox, ?fixture=inbox-empty).

const ROOT = '/Users/arun/code/shop';
const OPTIONS = [
  { optionId: 'allow', name: 'Yes', kind: 'allow_once' },
  { optionId: 'always', name: "Yes, and don't ask again for npm commands", kind: 'allow_always' },
  { optionId: 'reject', name: 'No', kind: 'reject_once' },
];
const dl = (op, text) => ({ op, text });

export function inboxFixture(now = Date.now(), { answered = false } = {}) {
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
    files: [],
    lastActivity: sec(5),
    turns: 1,
    ...over,
  });
  const npmTest = (requestId, at, cwd = ROOT) => ({
    kind: 'permission',
    requestId,
    title: 'npm test',
    toolKind: 'execute',
    options: OPTIONS,
    detail: { command: { line: 'npm test', cwd } },
    at: sec(at),
  });
  const done = (item, answer) => (answered ? { ...item, ...answer } : item);
  const chats = [
    chat('chat-a', 'claude', 'Claude 1', 'Fix formatCents for negative amounts', [
      { kind: 'user', text: 'formatCents breaks on negative values. Fix it and run the tests.', images: [], at: sec(900) },
      done(npmTest('perm-a-test', 420), { answer: 'Yes' }),
      done(
        {
          kind: 'permission',
          requestId: 'perm-a-edit',
          title: 'Edit src/format.ts',
          toolKind: 'edit',
          options: OPTIONS.map((o) => (o.optionId === 'always' ? { ...o, name: "Yes, and don't ask again for this session" } : o)),
          detail: {
            files: [
              {
                path: `${ROOT}/src/format.ts`,
                added: 3,
                removed: 2,
                isNew: false,
                full: true,
                more: 0,
                lines: [
                  dl(' ', 'export function formatCents(cents: number, currency = "USD"'),
                  dl('-', ') {'),
                  dl('-', '  const sign = cents < 0 ? "-" : "";'),
                  dl('+', ', locale = "en-US") {'),
                  dl('+', '  const value = cents / 100;'),
                  dl('+', '  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(value);'),
                  dl(' ', '}'),
                ],
              },
            ],
            always: [{ kind: 'folder', folder: `${ROOT}/src`, access: 'write' }],
          },
          at: sec(250),
        },
        { answer: 'Yes' },
      ),
    ]),
    chat('chat-b', 'codex', 'Codex 2', 'Add CSV export to the reports page', [
      { kind: 'user', text: 'Add a CSV export button to the reports page.', images: [], at: sec(1200) },
      done({ kind: 'command', commandId: 'cmd-b-test', commandLine: 'npm test', cwd: ROOT, outside: false, state: 'awaiting', output: '', at: sec(360) }, { state: 'exited', exitCode: 0 }),
      done(
        {
          kind: 'bridge',
          requestId: 'bridge-b-ask',
          tool: 'ask_agent',
          target: { agent: 'gemini' },
          text: 'Does a CSV opened in Excel on Windows need a UTF-8 BOM so the ₹ sign shows?',
          state: 'awaiting',
          always: 'in every chat',
          at: sec(150),
        },
        { state: 'allowed' },
      ),
    ]),
    chat('chat-c', 'gemini', 'Gemini 1', 'Check the checkout flow on staging', [
      { kind: 'user', text: 'Walk through checkout on staging and tell me what breaks.', images: [], at: sec(1000) },
      done(
        { kind: 'bridge', requestId: 'bridge-c-open', tool: 'browser_open', target: { browser: true }, text: 'https://staging.shop.test/checkout', state: 'awaiting', always: 'https://staging.shop.test', at: sec(200) },
        { state: 'allowed' },
      ),
      done(
        { kind: 'bridge', requestId: 'bridge-c-click', tool: 'browser_click', target: { browser: true }, text: '"Pay ₹1,499"', state: 'awaiting', always: 'https://staging.shop.test', at: sec(70) },
        { state: 'denied' },
      ),
    ]),
    chat('chat-d', 'claude', 'Claude 2', 'Migrate the inventory store to SQLite', [
      { kind: 'user', text: 'Move the inventory store from the JSON file to SQLite.', images: [], at: sec(1500) },
      done(
        {
          kind: 'question',
          requestId: 'q-d-driver',
          message: 'Which SQLite driver should the store use?',
          state: 'awaiting',
          fields: [
            {
              key: 'driver',
              title: 'Driver',
              type: 'choice',
              required: true,
              options: [
                { value: 'better-sqlite3', title: 'better-sqlite3 (Recommended)', description: 'Synchronous, fastest for a single process' },
                { value: 'sqlite3', title: 'sqlite3', description: 'Callback API, slower, widely used' },
                { value: 'node-sqlite', title: 'node:sqlite', description: 'Built into Node 22, still experimental' },
              ],
            },
            { key: 'driver_custom', title: 'Other', type: 'text' },
          ],
          at: sec(95),
        },
        { state: 'answered', summary: 'better-sqlite3' },
      ),
      done({ kind: 'review', reviewId: 'review-d-store', path: `${ROOT}/src/store.ts`, added: 42, removed: 17, isNew: false, state: 'pending', at: sec(30) }, { state: 'accepted' }),
    ]),
    chat('chat-e', 'claude', 'Claude 3', 'Bump the test dependencies', [
      { kind: 'user', text: 'Bump vitest and the testing libraries, then run the tests.', images: [], at: sec(600) },
      done(npmTest('perm-e-test', 45), { answer: 'Yes' }),
      done(npmTest('perm-e-api', 20, `${ROOT}/packages/api`), { answer: 'No' }),
    ]),
  ];
  return {
    state: { chats, images: [], links: [] },
    ids: { first: 'perm-a-test', same: ['perm-a-test', 'cmd-b-test', 'perm-e-test'], elsewhere: 'perm-e-api', edit: 'perm-a-edit', review: 'review-d-store', question: 'q-d-driver', click: 'bridge-c-click' },
  };
}
