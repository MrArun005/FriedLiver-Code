// A busy afternoon on one project, as the host would snapshot it: fifteen open
// chats across the agents (working, waiting on you, failed, done), a fan-out of
// three, a consultation, a hand-off, a live pipe, an agent asking to message
// another chat, two chats changing the same file, and two archived chats.
// Only the UI harness uses it.

const ROOT = '/home/dev/inventory-app';
const tree = (branch) => `${ROOT}/.worktrees/${branch.replace('/', '-')}`;

const user = (text) => ({ kind: 'user', text, images: [] });
const agent = (text) => ({ kind: 'agent', text });
const plan = (entries, at) => ({
  kind: 'plan',
  entries: entries.map((content, i) => ({ content, status: i < at ? 'completed' : i === at ? 'in_progress' : 'pending' })),
});
const tool = (id, title, status, locations = [], toolKind) => ({ kind: 'tool', id, title, toolKind, status, locations });
const link = (linkId, role, other, text, by = 'user') => ({ kind: 'link', linkId, role, chatId: other.id, agent: other.agent, label: other.label, text, by });

export function fixture(now = Date.now()) {
  const min = (m) => now - m * 60_000;
  const sec = (s) => now - s * 1000;
  const chat = (id, agentKey, label, title, over) => ({
    id,
    agent: agentKey,
    label,
    title,
    cwd: over.branch ? tree(over.branch) : ROOT,
    createdAt: min(30),
    busy: false,
    changedFiles: 0,
    items: [],
    depth: 0,
    files: [],
    lastActivity: min(5),
    turns: 0,
    ...over,
  });

  const c = {
    c1: { id: 'chat-c1', agent: 'claude', label: 'Claude 1' },
    c5: { id: 'chat-c5', agent: 'claude', label: 'Claude 5' },
    c6: { id: 'chat-c6', agent: 'claude', label: 'Claude 6' },
    x2: { id: 'chat-x2', agent: 'codex', label: 'Codex 2' },
    x3: { id: 'chat-x3', agent: 'codex', label: 'Codex 3' },
    x4: { id: 'chat-x4', agent: 'codex', label: 'Codex 4' },
    g1: { id: 'chat-g1', agent: 'gemini', label: 'Gemini 1' },
    g4: { id: 'chat-g4', agent: 'gemini', label: 'Gemini 4' },
  };

  const chats = [
    chat('chat-c1', 'claude', 'Claude 1', 'Fix formatCents for negative amounts', {
      createdAt: min(42),
      lastActivity: sec(20),
      busy: true,
      turns: 1,
      files: ['src/format.ts'],
      items: [
        user('formatCents breaks on negative values and always uses en-US. Fix it, and keep existing calls working.'),
        plan(['Read format.ts and its callers', 'Keep the sign, add a locale argument', 'Run the format tests', 'Summarize the change'], 1),
        tool('t-c1-1', 'Read src/format.ts', 'completed', [`${ROOT}/src/format.ts`], 'read'),
        tool('t-c1-2', 'Search for formatCents', 'completed', [], 'search'),
        link('link-consult-1', 'asked', c.g1, 'Is a minus sign before the currency symbol right for every locale, or should Intl place it?'),
        link(
          'link-consult-1',
          'reply',
          c.g1,
          "Let `Intl.NumberFormat` place the sign: pass the signed value and keep `signDisplay: 'auto'`. Some locales put the sign after the symbol (`de-CH` gives `CHF-5.00`), so prepending `-` yourself is wrong there.",
        ),
        agent('Gemini is right. I pass the signed value to `Intl.NumberFormat` instead of prepending the sign, and `locale` is a new optional third argument, so the three existing calls behave the same.'),
        tool('t-c1-3', 'Edit src/format.ts', 'in_progress', [`${ROOT}/src/format.ts`], 'edit'),
        {
          kind: 'bridge',
          requestId: 'bridge-c1',
          tool: 'send_to_chat',
          target: { chatId: 'chat-x2' },
          text: 'formatCents now takes an optional locale. Hold the formatCents tests until my edit is accepted, then test de-CH too.',
          state: 'awaiting',
        },
        { kind: 'review', reviewId: 'rev-c1', path: `${ROOT}/src/format.ts`, added: 8, removed: 2, isNew: false, state: 'pending' },
      ],
    }),
    chat('chat-c2', 'claude', 'Claude 2', 'Migrate the inventory store to SQLite', {
      createdAt: min(55),
      lastActivity: min(1),
      busy: true,
      turns: 2,
      branch: 'claude/sqlite-store',
      files: ['src/store.ts', 'src/db/schema.sql', 'package.json'],
      items: [
        user('Move the inventory store from the JSON file to SQLite. Keep the store API the same.'),
        plan(['Design the schema', 'Write the SQLite store', 'Migrate the JSON data', 'Remove the JSON store'], 3),
        tool('t-c2-1', 'Edit src/store.ts', 'completed', ['src/store.ts'], 'edit'),
        {
          kind: 'permission',
          requestId: 'perm-c2',
          title: 'Delete src/legacyStore.ts',
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        },
      ],
    }),
    chat('chat-c3', 'claude', 'Claude 3', 'Add CSV export to the reports page', {
      createdAt: min(18),
      lastActivity: sec(4),
      busy: true,
      group: 'fan-csv',
      branch: 'claude/csv-export',
      files: ['src/reports/export.ts', 'src/reports/page.tsx'],
      items: [
        user('Add a CSV export button to the reports page. Quote fields properly.'),
        plan(['Find the report table data', 'Write the CSV encoder', 'Add the export button', 'Test with commas and quotes', 'Summarize'], 2),
        tool('t-c3-1', 'Edit src/reports/export.ts', 'completed', ['src/reports/export.ts'], 'edit'),
        tool('t-c3-2', 'Edit src/reports/page.tsx', 'in_progress', ['src/reports/page.tsx'], 'edit'),
        agent('The encoder quotes any field with a comma, quote or newline, and doubles inner quotes. Wiring the button now.'),
      ],
    }),
    chat('chat-c4', 'claude', 'Claude 4', 'Write release notes for 0.4', {
      createdAt: min(35),
      lastActivity: min(9),
      items: [
        user('Write release notes for 0.4 from the merged changes since 0.3.'),
        {
          kind: 'notice',
          tone: 'error',
          text: "Claude's sign-in expired.",
          actions: [{ label: 'Sign in', do: 'signIn', agent: 'claude', methodId: 'claude-login' }],
        },
      ],
    }),
    chat('chat-c5', 'claude', 'Claude 5', 'Explain the auth middleware', {
      createdAt: min(80),
      lastActivity: min(26),
      turns: 2,
      items: [
        user('How does the auth middleware decide a session is valid?'),
        agent('It reads the `sid` cookie on every request and looks it up in the in-memory map in `src/auth/sessions.ts`. Expired entries are swept every minute.'),
        link('link-handoff-1', 'handoff-to', c.x3, ''),
      ],
    }),
    chat('chat-c6', 'claude', 'Claude 6', 'Speed up the product search query', {
      createdAt: min(25),
      lastActivity: sec(2),
      busy: true,
      turns: 3,
      branch: 'claude/search-speed',
      files: ['src/search.ts', 'src/db/indexes.sql'],
      items: [
        user('Product search takes 900 ms on the big catalog. Make it fast.'),
        tool('t-c6-1', 'Edit src/db/indexes.sql', 'completed', ['src/db/indexes.sql'], 'edit'),
        link('link-pipe-1', 'piped-out', c.x4, 'Added a trigram index on products.name and switched the query to use it.'),
        {
          kind: 'command',
          commandId: 'cmd-c6',
          commandLine: 'npm run bench -- search',
          cwd: tree('claude/search-speed'),
          outside: false,
          state: 'running',
          output: 'search "red mug" x1000\n  before  912 ms/op\n  after    41 ms/op\n',
          startedAt: sec(12),
        },
      ],
    }),
    chat('chat-x1', 'codex', 'Codex 1', 'Add CSV export to the reports page', {
      createdAt: min(18),
      lastActivity: sec(40),
      busy: true,
      group: 'fan-csv',
      turns: 1,
      branch: 'codex/csv-export',
      files: ['src/reports/csvExport.ts', 'test/csvExport.test.ts'],
      items: [
        user('Add a CSV export button to the reports page. Quote fields properly.'),
        agent('Export is in `src/reports/csvExport.ts` with tests for commas, quotes and newlines. Running them next.'),
        {
          kind: 'command',
          commandId: 'cmd-x1',
          commandLine: 'npm test -- --run csvExport',
          cwd: tree('codex/csv-export'),
          outside: false,
          state: 'awaiting',
          output: '',
        },
      ],
    }),
    chat('chat-x2', 'codex', 'Codex 2', 'Add tests for formatCents', {
      createdAt: min(40),
      lastActivity: sec(8),
      busy: true,
      branch: 'codex/format-tests',
      files: ['src/format.ts', 'test/format.test.ts'],
      items: [
        user('Add tests for formatCents: negatives, zero, large values, other currencies.'),
        plan(['Read formatCents', 'Write the cases', 'Run them'], 1),
        tool('t-x2-1', 'Edit test/format.test.ts', 'in_progress', ['test/format.test.ts'], 'edit'),
      ],
    }),
    chat('chat-x3', 'codex', 'Codex 3', 'Make the session store swappable', {
      createdAt: min(24),
      lastActivity: sec(6),
      busy: true,
      turns: 2,
      depth: 1,
      origin: { kind: 'handoff', chatId: 'chat-c5', by: 'user' },
      branch: 'codex/session-store',
      files: ['src/auth/middleware.ts', 'src/auth/store.ts'],
      changedFiles: 2,
      items: [
        link(
          'link-handoff-1',
          'handoff-from',
          c.c5,
          "**Where Claude 5 got to.** The middleware reads the `sid` cookie on every request and looks it up in the in-memory map in `src/auth/sessions.ts`; expired entries are swept every minute.\n\n**Next:** put sessions behind an interface so another store can replace the map.",
        ),
        user('Refactor the middleware so the session store can be swapped. Keep the tests green.'),
        plan(['Read the middleware', 'Add a SessionStore interface', 'Move the map behind it', 'Pick a store for serverless'], 3),
        tool('t-x3-1', 'Read src/auth/middleware.ts', 'completed', ['src/auth/middleware.ts'], 'read'),
        tool('t-x3-2', 'Edit src/auth/store.ts', 'completed', ['src/auth/store.ts'], 'edit'),
        tool('t-x3-3', 'Edit src/auth/middleware.ts', 'completed', ['src/auth/middleware.ts'], 'edit'),
        {
          kind: 'command',
          commandId: 'cmd-x3',
          commandLine: 'npm test -- --run auth',
          cwd: tree('codex/session-store'),
          outside: false,
          state: 'exited',
          exitCode: 0,
          durationMs: 2400,
          output: ' ✓ test/auth.test.ts (12 tests) 812ms\n\n Test Files  1 passed (1)\n      Tests  12 passed (12)\n',
        },
        { kind: 'changes', turnId: 'turn-x3-1', files: ['src/auth/middleware.ts', 'src/auth/store.ts'] },
        agent('The middleware now takes a `SessionStore`, and the in-memory map is one implementation of it. All 12 auth tests pass.\n\nBefore adding a second store I asked Gemini which one suits a serverless deploy.'),
        link('link-consult-2', 'asked', c.g4, 'Which session store fits a serverless deploy: Redis, DynamoDB or signed cookies? We have about 2k active sessions.', 'agent'),
      ],
    }),
    chat('chat-x4', 'codex', 'Codex 4', 'Review each search change for regressions', {
      createdAt: min(24),
      lastActivity: min(2),
      turns: 3,
      items: [
        user('Review every change Claude 6 sends you for regressions. Be brief.'),
        link('link-pipe-1', 'piped-in', c.c6, 'Added a trigram index on products.name and switched the query to use it.'),
        agent('Looks safe. The index adds about 40 MB on the big catalog; worth noting in the release notes.'),
      ],
    }),
    chat('chat-g1', 'gemini', 'Gemini 1', 'Is a minus sign before the currency symbol right?', {
      createdAt: min(30),
      lastActivity: min(12),
      turns: 1,
      depth: 1,
      origin: { kind: 'consult', chatId: 'chat-c1', by: 'user' },
      items: [
        link('link-consult-1', 'consulted', c.c1, 'Is a minus sign before the currency symbol right for every locale, or should Intl place it?'),
        agent(
          "Let `Intl.NumberFormat` place the sign: pass the signed value and keep `signDisplay: 'auto'`. Some locales put the sign after the symbol (`de-CH` gives `CHF-5.00`), so prepending `-` yourself is wrong there.",
        ),
      ],
    }),
    chat('chat-g2', 'gemini', 'Gemini 2', 'Add CSV export to the reports page', {
      createdAt: min(18),
      lastActivity: min(4),
      group: 'fan-csv',
      turns: 1,
      branch: 'gemini/csv-export',
      files: ['src/reports/toCsv.ts', 'src/reports/page.tsx'],
      changedFiles: 2,
      items: [
        user('Add a CSV export button to the reports page. Quote fields properly.'),
        { kind: 'changes', turnId: 'turn-g2-1', files: ['src/reports/toCsv.ts', 'src/reports/page.tsx'] },
        agent('Done. `toCsv` streams rows so a 50k-row report exports without freezing the page, and the button sits next to Print.'),
      ],
    }),
    chat('chat-g3', 'gemini', 'Gemini 3', 'Document the inventory API', {
      createdAt: min(14),
      lastActivity: sec(15),
      busy: true,
      branch: 'gemini/api-docs',
      files: ['docs/api.md'],
      items: [
        user('Document every public function of the inventory API in docs/api.md.'),
        plan(['List the exports', 'Read inventory.ts', 'Write docs/api.md', 'Add examples'], 1),
        tool('t-g3-1', 'Read src/inventory.ts', 'in_progress', ['src/inventory.ts'], 'read'),
      ],
    }),
    chat('chat-g4', 'gemini', 'Gemini 4', 'Which session store fits serverless?', {
      createdAt: min(3),
      lastActivity: sec(3),
      busy: true,
      depth: 2,
      origin: { kind: 'consult', chatId: 'chat-x3', by: 'agent' },
      items: [
        link('link-consult-2', 'consulted', c.x3, 'Which session store fits a serverless deploy: Redis, DynamoDB or signed cookies? We have about 2k active sessions.', 'agent'),
        agent('Comparing the three on cold starts, cost at 2k sessions and revocation…'),
      ],
    }),
    chat('chat-d1', 'demo', 'Demo', 'Tour of the project', {
      createdAt: min(95),
      lastActivity: min(90),
      turns: 1,
      items: [user('tour'), agent('This is an inventory app: `src/inventory.ts` holds the stock, `src/format.ts` formats money, and `src/reports` builds the reports page.')],
    }),
    chat('chat-c7', 'claude', 'Claude 7', 'Rename the price helpers', {
      createdAt: min(200),
      lastActivity: min(150),
      turns: 2,
      archived: true,
      items: [user('Rename priceOf to unitPrice everywhere.'), agent('Renamed in 6 files.')],
    }),
    chat('chat-d2', 'demo', 'Demo 2', 'Build the calculator demo', {
      createdAt: min(300),
      lastActivity: min(280),
      turns: 1,
      archived: true,
      merged: true,
      items: [user('project'), agent('Built the calculator.')],
    }),
  ];

  const links = [
    { id: 'link-consult-1', kind: 'consult', from: 'chat-c1', to: 'chat-g1', by: 'user', createdAt: min(30), active: true, count: 2 },
    { id: 'link-handoff-1', kind: 'handoff', from: 'chat-c5', to: 'chat-x3', by: 'user', createdAt: min(24), active: true, count: 1 },
    { id: 'link-pipe-1', kind: 'pipe', from: 'chat-c6', to: 'chat-x4', by: 'user', createdAt: min(24), active: true, count: 3 },
    { id: 'link-consult-2', kind: 'consult', from: 'chat-x3', to: 'chat-g4', by: 'agent', createdAt: min(3), active: true, count: 1 },
  ];

  return { state: { chats, images: [], links }, ids: { side: 'chat-c1', center: 'chat-x3' } };
}
