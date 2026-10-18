// /discuss in a real-looking project: Claude, Gemini and Codex weigh Postgres against MySQL for an
// audit log. Three chats show the card's states: running (round 2, Codex speaking), done and still
// split, and agreed then carried out. `before` is the same question asked the old way, one /ask at
// a time. Only the UI harness uses it (?fixture=discuss, ?fixture=discuss-before).

const ROOT = '/Users/arun/code/ledger';

const stance = (position, agree, disagree, confidence) => ({ position, agree, disagree, confidence, parsed: true });

const T = {
  claude1: {
    by: 'claude',
    round: 1,
    text: 'Postgres. The audit log is append-heavy with **JSON payloads we filter on** (`actor.id`, `diff.field`). Postgres gives us `jsonb` with GIN indexes, so those filters stay indexed without a schema change per event type. Its partitioning by month (`PARTITION BY RANGE (created_at)`) also makes the 13-month retention a `DROP PARTITION`, not a long `DELETE`.',
    stance: stance('Postgres, for jsonb indexing and partitioned retention', [], ['MySQL is good enough here'], 0.75),
  },
  gemini1: {
    by: 'gemini',
    round: 1,
    text: 'MySQL. We already run **MySQL 8 on RDS** for the main app, with backups, failover and on-call runbooks. A second engine doubles that. MySQL 8 has `JSON` columns and multi-valued indexes, which cover filtering on `actor.id`. Range partitioning exists there too.',
    stance: stance('MySQL, to keep one engine to operate', ['Monthly partitions make retention cheap'], ['jsonb is needed for our filters'], 0.7),
  },
  codex1: {
    by: 'codex',
    round: 1,
    text: 'Leaning Postgres, but the deciding factor is the **query mix**. I read `src/audit/queries.ts`: 3 of the 5 report queries filter on nested keys (`diff.field`, `meta.ip`), which MySQL’s multi-valued indexes don’t cover (arrays only). Ops cost is real though.',
    stance: stance('Postgres if nested-key filters matter', ['Monthly partitions make retention cheap', 'A second engine has an ops cost'], ['MySQL indexes cover our filters'], 0.65),
  },
  claude2: {
    by: 'claude',
    round: 2,
    text: 'Codex’s read of `queries.ts` settles the indexing question for me: nested keys need expression indexes per key in MySQL. On ops, we could put the audit log on **RDS Postgres with the same backup policy**; the runbook delta is small.',
    stance: stance('Postgres on RDS, same backup policy', ['A second engine has an ops cost'], ['The runbook delta is large'], 0.8),
  },
  gemini2: {
    by: 'gemini',
    round: 2,
    text: 'Agreed on the nested keys: generated columns per key would work but drift with every new event type. I still think the ops cost is under-counted: failover drills, version upgrades and a second connection pool in the app.',
    stance: stance('Postgres is acceptable if ops is budgeted', ['jsonb with GIN fits the nested filters'], ['The ops delta is small'], 0.6),
  },
};

const conclusionSplit = {
  agreed: ['Monthly range partitions for the 13-month retention', 'Nested-key filters (diff.field, meta.ip) need jsonb with a GIN index', 'Keep the same RDS backup policy for whichever engine'],
  disagreed: [
    {
      point: 'Is a second database engine worth its operating cost?',
      sides: [
        { agent: 'claude', view: 'Yes: the runbook delta is small on RDS, and the query fit matters more for reports.' },
        { agent: 'gemini', view: 'Only if budgeted: failover drills, upgrades and a second connection pool are real work.' },
      ],
    },
  ],
  next: 'Prototype the audit log on RDS Postgres behind the existing AuditStore interface, and list the ops work (failover drill, upgrade plan, pool) in the PR.',
  by: 'claude',
  carryOut: 'codex',
};

export function discussFixture(now = Date.now(), { before = false } = {}) {
  const sec = (s) => now - s * 1000;
  const chat = (id, agent, title, items, over = {}) => ({
    id,
    agent,
    label: agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : 'Gemini',
    title,
    cwd: ROOT,
    createdAt: sec(3600),
    busy: false,
    changedFiles: 0,
    items,
    depth: 0,
    files: [],
    lastActivity: sec(20),
    turns: 3,
    ...over,
  });
  const lead = [
    { kind: 'user', text: 'We need an audit log for every change to an invoice: who, what changed, when. Kept 13 months, filterable in the admin reports.', images: [], at: sec(1500) },
    { kind: 'agent', text: 'I’ve sketched the `AuditStore` interface in `src/audit/store.ts`. Before I build the storage, there’s one open choice: put it in our MySQL, or a Postgres beside it.', at: sec(1400) },
  ];
  const question = 'Postgres or MySQL for the invoice audit log (13-month retention, JSON filters in reports)?';
  const participants = [
    { agent: 'claude', chatId: 'chat-main' },
    { agent: 'gemini', chatId: 'chat-g' },
    { agent: 'codex', chatId: 'chat-x' },
  ];
  const card = (over) => ({ kind: 'discussion', id: 'discuss-1', question, participants, maxRounds: 3, round: 2, state: 'done', turns: [], tokens: 18400, budget: 60000, at: sec(900), ...over });
  const typed = { kind: 'user', text: `/discuss @gemini @codex ${question}`, images: [], at: sec(1000) };

  if (before) {
    const link = (role, agent, chatId, text) => ({ kind: 'link', linkId: `l-${agent}`, role, chatId, agent, label: agent === 'gemini' ? 'Gemini' : 'Codex', text, by: 'user' });
    const items = [
      ...lead,
      link('asked', 'gemini', 'chat-g', 'Postgres or MySQL for the invoice audit log (13-month retention, JSON filters in reports)?'),
      link('reply', 'gemini', 'chat-g', T.gemini1.text),
      link('asked', 'codex', 'chat-x', 'Postgres or MySQL for the invoice audit log? Gemini says MySQL to keep one engine; Claude leans Postgres.'),
      link('reply', 'codex', 'chat-x', T.codex1.text),
      { kind: 'user', text: 'So which one? Can you compare what they said and recommend one?', images: [], at: sec(300) },
      { kind: 'agent', text: 'Gemini prefers MySQL for operational simplicity; Codex leans Postgres because of nested-key filters. Taking both into account, I’d still go with Postgres, but it’s a judgement call.', at: sec(250) },
    ];
    return { state: { chats: [chat('chat-main', 'claude', 'Invoice audit log', items), chat('chat-g', 'gemini', 'Audit log storage', []), chat('chat-x', 'codex', 'Audit log storage', [])], images: [], links: [] } };
  }

  const running = card({
    state: 'running',
    round: 2,
    speaking: 'codex',
    turns: [T.claude1, T.gemini1, T.codex1, { by: 'you', round: 2, text: 'Reports must stay under 2 s at 50M rows.' }, T.claude2, T.gemini2],
    tokens: 14200,
    at: sec(400),
  });
  const split = card({ ended: 'rounds', round: 2, maxRounds: 2, turns: [T.claude1, T.gemini1, T.codex1, T.claude2, T.gemini2], conclusion: conclusionSplit, span: 2 });
  const agreed = card({
    id: 'discuss-2',
    ended: 'agreed',
    turns: [T.claude1, T.gemini1, T.codex1, T.claude2, T.gemini2],
    conclusion: { ...conclusionSplit, disagreed: [], agreed: [...conclusionSplit.agreed, 'Budget the ops work (failover drill, upgrade plan, pool) in the same PR'] },
    carried: 'codex',
    span: 2,
  });
  // The turns the starting agent took: folded into the card by the chat view.
  const folded = [
    { kind: 'link', linkId: 'discussion', role: 'piped-in', chatId: 'chat-main', agent: 'claude', label: 'Discussion', text: '[FriedLiver discussion] …', by: 'user' },
    { kind: 'agent', text: T.claude1.text },
    { kind: 'link', linkId: 'l-g', role: 'asked', chatId: 'chat-g', agent: 'gemini', label: 'Gemini', text: '[FriedLiver discussion] …', by: 'user' },
    { kind: 'link', linkId: 'l-g', role: 'reply', chatId: 'chat-g', agent: 'gemini', label: 'Gemini', text: T.gemini1.text, by: 'user' },
  ];
  const chats = [
    chat('chat-main', 'claude', 'Invoice audit log', [...lead, typed, running, ...folded], { lastActivity: sec(2) }),
    chat('chat-split', 'claude', 'Invoice audit log', [...lead, typed, split, ...folded.slice(0, 2)]),
    chat('chat-agreed', 'claude', 'Invoice audit log', [...lead, typed, agreed, ...folded.slice(0, 2), { kind: 'link', linkId: 'l-x', role: 'piped-out', chatId: 'chat-x', agent: 'codex', label: 'Codex', text: 'Carry out what the discussion concluded. …', by: 'user' }]),
    chat('chat-g', 'gemini', 'Discussion', [], { origin: { kind: 'consult', chatId: 'chat-main', by: 'user' }, depth: 1 }),
    chat('chat-x', 'codex', 'Discussion', [], { origin: { kind: 'consult', chatId: 'chat-main', by: 'user' }, depth: 1, busy: true }),
  ];
  return { state: { chats, images: [], links: [] } };
}
