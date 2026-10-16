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
const dl = (op, text) => ({ op, text });

// What each agent's session offers, shaped like its adapter's config options (model names are placeholders).
const select = (id, name, category, current, choices) => ({ id, name, category, type: 'select', current, choices, via: 'option' });
const choice = (value, name, description, group) => ({ value, name, ...(description ? { description } : {}), ...(group ? { group } : {}) });
const efforts = (values) => values.map((v) => choice(v, v === 'xhigh' ? 'Xhigh' : v[0].toUpperCase() + v.slice(1)));
const MODES = {
  claude: [
    choice('default', 'Manual', 'Always ask before making changes'),
    choice('acceptEdits', 'Accept edits', 'Automatically accept all file edits'),
    choice('plan', 'Plan', 'Claude can analyze but not modify files or execute commands'),
    choice('auto', 'Auto', 'Claude handles permission decisions'),
    choice('bypassPermissions', 'Bypass permissions', 'Accepts all permissions'),
  ],
  codex: [
    choice('read-only', 'Read-only', 'Requires approval to edit files and access the internet.'),
    choice('workspace-write', 'Workspace access', 'Edit workspace files; ask before writing outside the workspace or accessing the network.'),
    choice('agent', 'Auto review', 'Only ask for actions detected as potentially unsafe'),
    choice('agent-full-access', 'Full access', 'Unrestricted access to the internet and any file on your computer'),
  ],
  gemini: [choice('default', 'Default', 'Prompts for approval'), choice('autoEdit', 'Auto Edit', 'Auto-approves edit tools'), choice('yolo', 'YOLO', 'Auto-approves all tools'), choice('plan', 'Plan', 'Read-only mode')],
};
const COMMANDS = {
  claude: [
    { name: 'compact', description: 'Clear conversation history but keep a summary in context' },
    { name: 'review', description: 'Review a pull request' },
    { name: 'mcp', description: 'Show MCP servers' },
  ],
  codex: [
    { name: 'review', description: 'Review the current changes' },
    { name: 'status', description: 'Show the session status' },
    { name: 'compact', description: 'Summarize the conversation to free context' },
  ],
  gemini: [
    { name: 'memory', description: 'Manage memory' },
    { name: 'init', description: 'Analyze the project and create a GEMINI.md' },
  ],
};
function session(agentKey, mode, { model = 'default', effort, used, fast } = {}) {
  const options = [select('mode', 'Mode', 'mode', mode, MODES[agentKey])];
  if (agentKey === 'gemini') {
    options[0].via = 'mode';
    options.push({ ...select('model', 'Model', 'model', model, [choice('auto', 'Auto'), choice('pro', 'Pro'), choice('flash', 'Flash')]), via: 'model' });
  } else {
    options.push(select('model', 'Model', 'model', model, [choice('default', 'Default', 'Recommended', 'Recommended'), choice('large', 'Large', 'Most capable', 'All models'), choice('small', 'Small', 'Fastest', 'All models')]));
    options.push(select(agentKey === 'codex' ? 'reasoning_effort' : 'effort', agentKey === 'codex' ? 'Reasoning effort' : 'Effort', 'thought_level', effort ?? 'high', efforts(['low', 'medium', 'high', 'xhigh', 'max'])));
    options.push({ id: agentKey === 'codex' ? 'fast-mode' : 'fast', name: 'Fast mode', description: 'Faster responses on supported models', category: 'model_config', type: 'boolean', current: !!fast, choices: [], via: 'option' });
  }
  if (agentKey === 'codex') options.push(select('collaboration_mode', 'Collaboration mode', 'collaboration_mode', 'default', [choice('default', 'Default'), choice('plan', 'Plan', 'Plan before making changes')]));
  return { options, commands: COMMANDS[agentKey], live: true, ...(used ? { usage: { used, size: 200_000, cost: { amount: used / 140_000, currency: 'USD' } } } : {}) };
}

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
        { ...user('formatCents breaks on negative values and always uses en-US. Fix it, and keep existing calls working.'), refs: [{ path: `${ROOT}/src/format.ts`, startLine: 12, endLine: 18 }] },
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
        {
          kind: 'permission',
          requestId: 'perm-c1',
          toolCallId: 't-c1-3',
          title: 'Edit src/format.ts',
          toolKind: 'edit',
          options: [
            { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
            { optionId: 'allow-with-updates', name: "Yes, and don't ask again for this session", kind: 'allow_always' },
            { optionId: 'reject', name: 'No', kind: 'reject_once' },
          ],
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
          },
        },
      ],
      session: session('claude', 'default', { effort: 'high', used: 84_000 }),
      queue: [{ id: 'queued-c1', text: 'Then run the format tests.', images: 0 }],
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
          title: 'rm src/legacyStore.ts',
          toolKind: 'execute',
          options: [
            { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
            { optionId: 'allow-with-updates', name: "Yes, and don't ask again for rm commands", kind: 'allow_always' },
            { optionId: 'reject', name: 'No', kind: 'reject_once' },
          ],
          detail: { command: { line: 'rm src/legacyStore.ts', cwd: tree('claude/sqlite-store') } },
        },
      ],
      session: session('claude', 'acceptEdits', { model: 'large', effort: 'max', used: 151_000 }),
      approval: 'edits',
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
      session: session('claude', 'default', { effort: 'medium', used: 12_000 }),
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
          ...tool('t-c6-2', 'npm run bench -- search', 'in_progress', [], 'execute'),
          out: [{ t: 'text', text: 'search "red mug" x1000\n  before  912 ms/op\n  after    41 ms/op\n' }],
          input: '{\n  "command": "npm run bench -- search",\n  "description": "Benchmark the search"\n}',
        },
      ],
      session: session('claude', 'bypassPermissions', { effort: 'medium', used: 37_000 }),
      approval: 'full',
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
          kind: 'permission',
          requestId: 'perm-x1',
          toolCallId: 'call-x1',
          title: 'Run npm test -- --run csvExport',
          toolKind: 'execute',
          options: [
            { optionId: 'approved', name: 'Yes', kind: 'allow_once' },
            { optionId: 'approved-for-session', name: "Yes, and don't ask again for this command", kind: 'allow_always' },
            { optionId: 'abort', name: 'No, and tell Codex what to do differently', kind: 'reject_once' },
          ],
          detail: { command: { line: 'npm test -- --run csvExport', cwd: tree('codex/csv-export') } },
        },
      ],
      session: session('codex', 'read-only', { effort: 'medium', used: 22_000 }),
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
      // Codex's own default, which FriedLiver didn't choose: the badge says so.
      session: session('codex', 'agent', { effort: 'low' }),
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
        {
          ...tool('t-x3-3', 'Edit src/auth/middleware.ts', 'completed', ['src/auth/middleware.ts'], 'edit'),
          out: [
            {
              t: 'diff',
              path: `${tree('codex/session-store')}/src/auth/middleware.ts`,
              added: 2,
              removed: 1,
              isNew: false,
              more: 0,
              lines: [dl(' ', 'export function auth(req, res, next) {'), dl('-', '  const session = sessions.get(req.cookies.sid);'), dl('+', '  const store = options.store ?? memoryStore;'), dl('+', '  const session = await store.get(req.cookies.sid);')],
            },
          ],
        },
        {
          ...tool('t-x3-4', 'npm test -- --run auth', 'completed', [], 'execute'),
          out: [{ t: 'text', text: ' ✓ test/auth.test.ts (12 tests) 812ms\n\n Test Files  1 passed (1)\n      Tests  12 passed (12)\n' }],
        },
        { kind: 'changes', turnId: 'turn-x3-1', files: ['src/auth/middleware.ts', 'src/auth/store.ts'] },
        agent('The middleware now takes a `SessionStore`, and the in-memory map is one implementation of it. All 12 auth tests pass.\n\nBefore adding a second store I asked Gemini which one suits a serverless deploy.'),
        link('link-consult-2', 'asked', c.g4, 'Which session store fits a serverless deploy: Redis, DynamoDB or signed cookies? We have about 2k active sessions.', 'agent'),
      ],
      session: session('codex', 'workspace-write', { effort: 'high', used: 61_000, fast: true }),
      approval: 'edits',
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
      session: session('gemini', 'autoEdit', { model: 'auto' }),
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
      session: {
        options: [
          select('mode', 'Mode', 'mode', 'default', [choice('default', 'Ask', 'Asks before it edits a file or runs a command'), choice('acceptEdits', 'Accept edits'), choice('plan', 'Plan'), choice('bypassPermissions', 'Full access', 'Never asks')]),
          select('model', 'Model', 'model', 'demo-smart', [choice('demo-smart', 'Smart', 'Every effort level', 'Thorough'), choice('demo-small', 'Small', 'Low and medium effort only', 'Quick')]),
          select('effort', 'Effort', 'thought_level', 'medium', efforts(['low', 'medium', 'high', 'xhigh', 'max'])),
          { id: 'fast', name: 'Fast mode', category: 'model_config', type: 'boolean', current: false, choices: [], via: 'option' },
        ],
        commands: [{ name: 'help', description: 'What the Demo agent can do' }, { name: 'compact', description: 'Clear the context, so usage starts over' }, { name: 'review', description: 'Pretend to review a file', hint: 'file to review' }],
        live: true,
        usage: { used: 9_000, size: 200_000, cost: { amount: 0.03, currency: 'USD' } },
      },
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

  // Each agent's last known options and the user's last choices, as the host keeps them for new tasks.
  const defaults = {
    claude: { options: session('claude', 'default').options.filter((o) => o.category !== 'mode'), chosen: { thought_level: 'high' } },
    codex: { options: session('codex', 'read-only').options.filter((o) => o.category !== 'mode'), chosen: {} },
    demo: { options: chats.find((x) => x.id === 'chat-d1').session.options.filter((o) => o.category !== 'mode'), chosen: {} },
  };
  return { state: { chats, images: [], links }, ids: { side: 'chat-c1', center: 'chat-x3' }, defaults };
}
