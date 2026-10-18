// /discuss in a real-looking project: Claude, Gemini and Codex weigh Postgres against MySQL for an
// audit log. Three chats show the card's states: running (round 2, Codex speaking), done and still
// split, and (an open question, two agents) agreed. `before` is the same question asked the old way, one /ask at
// a time. Only the UI harness uses it (?fixture=discuss, ?fixture=discuss-before).

const ROOT = '/Users/arun/code/ledger';

const stance = (side, position, confidence, re, quote, disagree = ['x']) => ({ position, side, agree: [], disagree, confidence, parsed: true, ...(re ? { re: { agent: re, quote } } : {}) });
const turn = (by, round, side, conf, claim, text, re, quote, disagree) => ({ by, round, text, stance: stance(side, claim, conf, re, quote, disagree) });

// Scenario 1, as in the redesign mockups: Postgres or MySQL, three agents, still split after 3 rounds.
const T = {
  claude1: turn('claude', 1, 'Postgres', 0.75, '`jsonb` with GIN keeps the JSON filters indexed; monthly partitions make retention a `DROP PARTITION`.', 'The audit log is append-heavy with **JSON payloads we filter on** (`actor.id`, `diff.field`). Postgres gives us `jsonb` with GIN indexes, so those filters stay indexed without a schema change per event type.'),
  gemini1: turn('gemini', 1, 'MySQL', 0.7, 'We already run MySQL 8 on RDS; a second engine doubles backups, failover and runbooks.', 'MySQL 8 has `JSON` columns and multi-valued indexes, which cover filtering on `actor.id`. Range partitioning exists there too.'),
  codex1: turn('codex', 1, 'Postgres', 0.65, '3 of the 5 report queries filter on nested keys that MySQL’s multi-valued indexes don’t cover.', 'I read `src/audit/queries.ts`: `diff.field` and `meta.ip` are nested. Multi-valued indexes are for arrays only. Ops cost is real though.'),
  you2: { by: 'you', round: 2, text: 'Reports must stay under 2 s at 50M rows.' },
  claude2: turn('claude', 2, 'Postgres', 0.8, 'That settles indexing. RDS Postgres with the same backup policy keeps the runbook delta small.', 'Nested keys need an expression index per key in MySQL. On ops, we could put the audit log on RDS Postgres with the same backup policy.', 'codex', '3 of 5 report queries filter on nested keys'),
  gemini2: turn('gemini', 2, 'MySQL', 0.6, 'Agreed on nested keys, but ops is under-counted: failover drills, upgrades, a second pool.', 'Generated columns per key would work but drift with every new event type. I still think the ops cost is under-counted.', 'claude', 'the runbook delta is small'),
  codex2: turn('codex', 2, 'Postgres', 0.75, 'At 50M rows a generated column per event type won’t hold 2 s; the ops list is a one-time cost.', 'I ran the plan for the slowest report on a 50M-row copy: 3.4 s on MySQL with generated columns, 0.6 s with a GIN index.', 'gemini', 'ops is under-counted'),
  claude3: turn('claude', 3, 'Postgres', 0.8, 'Nothing on ops changes my read: query fit decides the 2 s budget.', 'Nothing on ops changes my read: query fit decides the 2 s budget.', 'gemini', 'a second pool'),
  gemini3: turn('gemini', 3, 'MySQL', 0.55, 'I’d accept Postgres only with the ops work budgeted in the same PR.', 'I’d accept Postgres only with the ops work budgeted in the same PR.', 'codex', 'a one-time cost'),
  codex3: turn('codex', 3, 'Postgres', 0.8, 'Failover drill, upgrade plan and a second pool come to about 2 days. Put them in the PR.', 'Failover drill, upgrade plan and a second pool come to about 2 days. Put them in the PR.', 'gemini', 'budgeted in the same PR'),
};

const conclusionSplit = {
  agreed: ['Monthly range partitions for the 13-month retention', 'Nested-key filters (`diff.field`, `meta.ip`) need `jsonb` with a GIN index', 'Keep the same RDS backup policy for whichever engine'],
  disagreed: [
    {
      point: 'Is a second database engine worth its operating cost?',
      sides: [
        { agent: 'claude', view: 'Yes: the runbook delta is small on RDS, and the query fit decides the 2 s budget.' },
        { agent: 'gemini', view: 'Only if budgeted: failover drills, upgrades and a second connection pool are real work.' },
      ],
    },
  ],
  next: 'Prototype the audit log on RDS Postgres behind the existing `AuditStore` interface, and list the ops work (failover drill, upgrade plan, pool) in the PR.',
  by: 'claude',
  carryOut: 'codex',
  rounds: [{ round: 1 }, { round: 2, trend: 'converging', on: 'indexing' }, { round: 3, trend: 'stuck', on: 'ops cost' }],
};

// Scenario 2: an open question (no options), two agents; Codex moves over in round 2.
const W = {
  claude1: turn('claude', 1, 'Backoff, then dead-letter', 0.7, 'Exponential backoff with jitter, 6 tries over about 4 hours, then a dead-letter queue.', 'Exponential backoff with jitter, 6 tries over about 4 hours, then a dead-letter queue.'),
  codex1: turn('codex', 1, 'Fixed retries, then alert', 0.6, '3 retries a minute apart, then alert: most failures in the logs are 4xx, and waiting won’t fix them.', 'I read `logs/webhooks-30d.csv`: most failures are 4xx. 3 retries a minute apart, then alert.'),
  claude2: turn('claude', 2, 'Backoff, then dead-letter', 0.85, 'Good catch: fail 4xx at once (except 408 and 429); back off only on 5xx and timeouts.', 'Good catch: fail 4xx at once (except 408 and 429); back off only on 5xx and timeouts.', 'codex', 'most failures are 4xx', []),
  codex2: turn('codex', 2, 'Backoff, then dead-letter', 0.85, 'With 4xx out, backoff is right for what’s left. Add an idempotency key so retries are safe.', 'With 4xx out, backoff is right for what’s left. Add an idempotency key so retries are safe.', 'claude', 'back off only on 5xx and timeouts', []),
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
  const question = 'Postgres or MySQL for the invoice audit log (13-month retention, JSON filters in reports, 50M rows)?';
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
    turns: [T.claude1, T.gemini1, T.codex1, T.you2, T.claude2, T.gemini2],
    tokens: 14200,
    at: sec(400),
  });
  const split = card({ ended: 'rounds', round: 3, maxRounds: 3, turns: Object.values(T), conclusion: conclusionSplit, span: 2 });
  const agreed = card({
    id: 'discuss-2',
    question: 'How should the webhook worker retry failed deliveries?\n`webhook-delivery.handler.ts` · about 40k deliveries a day',
    participants: [participants[0], participants[2]],
    ended: 'agreed',
    round: 2,
    maxRounds: 2,
    turns: Object.values(W),
    conclusion: {
      agreed: ['Retry only 5xx, 408, 429 and timeouts; fail other 4xx at once', 'Exponential backoff with full jitter, 6 attempts over about 4 hours', 'Dead-letter after the last try; alert above 10 dead letters an hour', 'An idempotency key on every delivery'],
      disagreed: [],
      next: 'Add the retry policy to `webhook-delivery.handler.ts`, with a test for the jitter bounds and the 4xx rule.',
      by: 'claude',
      carryOut: 'claude',
      rounds: [{ round: 1 }, { round: 2, trend: 'converging', on: 'the 4xx rule' }],
    },
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
    chat('chat-agreed', 'claude', 'Invoice audit log', [...lead, typed, agreed, ...folded.slice(0, 2)]),
    chat('chat-g', 'gemini', 'Discussion', [], { origin: { kind: 'consult', chatId: 'chat-main', by: 'user' }, depth: 1 }),
    chat('chat-x', 'codex', 'Discussion', [], { origin: { kind: 'consult', chatId: 'chat-main', by: 'user' }, depth: 1, busy: true }),
  ];
  return { state: { chats, images: [], links: [] } };
}
