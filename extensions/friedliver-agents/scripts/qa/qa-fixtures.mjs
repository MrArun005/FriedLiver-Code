// QA fixtures posted into the harness as host snapshots (qa-walk.mjs): fresh chats per agent,
// a question card, and a long transcript for render and scroll timings. Not shipped.

const ROOT = '/home/dev/inventory-app';

/** A chat the host just created for `agent`: no items, the session still starting for real agents. */
export function freshChat(agent) {
  const now = Date.now();
  return {
    id: `chat-new-${agent}`,
    agent,
    label: `${agent[0].toUpperCase()}${agent.slice(1)} 9`,
    title: 'New chat',
    cwd: ROOT,
    createdAt: now,
    busy: false,
    changedFiles: 0,
    items: [],
    depth: 0,
    files: [],
    lastActivity: now,
    turns: 0,
    ...(agent === 'demo' ? { session: { live: true, options: [], commands: [{ name: 'help', description: 'Show what the demo does' }] } } : { session: { starting: true, options: [], commands: [] } }),
  };
}

/** Claude's AskUserQuestion as a form: one choice field (keys 1–3 pick). */
export function questionItem() {
  return {
    kind: 'question',
    requestId: 'q-1',
    message: 'Which store should the sessions use in production?',
    state: 'awaiting',
    fields: [
      {
        key: 'store',
        title: 'Session store',
        type: 'choice',
        required: true,
        options: [
          { value: 'redis', title: 'Redis', description: 'Shared across instances; needs a Redis server' },
          { value: 'sqlite', title: 'SQLite', description: 'One file; fine for a single instance' },
          { value: 'memory', title: 'In memory', description: 'Lost on restart; tests only' },
        ],
      },
    ],
  };
}

/** One chat of `turns` turns (user, two steps, a reply with a list and a code block): 4 items a turn, MAX_ITEMS at 500. */
export function longFixture(turns) {
  const now = Date.now();
  const items = [];
  for (let n = 1; n <= turns; n++) {
    items.push({ kind: 'user', text: `Turn ${n}: make formatCents handle case ${n}, and explain the change.`, images: [], checkpoint: `turn-${n}` });
    items.push({ kind: 'tool', id: `r-${n}`, title: 'Read src/format.ts', toolKind: 'read', status: 'completed', locations: [`${ROOT}/src/format.ts`] });
    items.push({
      kind: 'tool',
      id: `e-${n}`,
      title: 'Edit src/format.ts',
      toolKind: 'edit',
      status: 'completed',
      locations: [`${ROOT}/src/format.ts`],
      out: [{ t: 'diff', path: `${ROOT}/src/format.ts`, added: 1, removed: 1, isNew: false, more: 0, lines: [{ op: '-', text: `  return case${n - 1};` }, { op: '+', text: `  return case${n};` }] }],
    });
    items.push({
      kind: 'agent',
      text: `Case ${n} now works.\n\n- The sign is kept.\n- \`locale\` defaults to \`en-US\`.\n\n\`\`\`ts\nformatCents(-${n}00, 'EUR', 'de-DE'); // "-${n},00 €"\n\`\`\``,
    });
  }
  const chat = { id: 'chat-long', agent: 'claude', label: 'Claude 1', title: `${turns}-turn session`, cwd: ROOT, createdAt: now - 3600e3, busy: false, changedFiles: 1, items, depth: 0, files: ['src/format.ts'], lastActivity: now, turns };
  return { chats: [chat], images: [], links: [] };
}
