// The session in the owner's Claude Code reference screenshots (DESIGN-SYSTEM.md §5):
// a long prompt, Thinking, a Bash heredoc with "Tests 5 passed (5)", a Read, an
// Edit with its diff, a reply with a paragraph, a list, inline code and a code
// block, and fourteen agents with their real titles, times and tokens. The
// session offers the model list, effort and toggle exactly as 5.png; the chat is
// in Auto. Only the UI harness uses it (?fixture=reference).

export const ROOT = '/Users/dev/code/wt-composer2';

export const PROMPT =
  "we don't need to have everything as such or label to it. We can just hover on it and see the details. The first row will be the composer, the second row will be selection of a model. In the third row will be selection of a um, how fast it should be, medium, fast, extra fast. And how much context would be available? And here there would be a link where I can just click on it and it will redirect me to agent manager. For a full view, so on click it opens the map and there's an option to move to agent manager.";

/** 3,000 characters of a pasted spec: the long user message the transcript must not let take over. */
export const LONG_PROMPT = Array.from({ length: 30 }, (_, n) => `${n + 1}. The composer row keeps the model and effort pills; the map opens from the agents pill and lists every agent.`)
  .join(' ')
  .slice(0, 3000);

export const DICTATED = "I don't really understand why these designs are really bad. Is there anything, is something I have to do or what? It's not looking good at all. Just copy paste Claude. Just copy paste Claude code. I'll get you the image.";

export const ATTACHMENTS = [
  [1356, 958],
  [3420, 2224],
  [1672, 842],
];

const HEREDOC = `cd ~/code/wt-composer2/extensions/friedliver-agents && python3 - <<'EOF'
p='src/webview/controls.tsx'; s=open(p).read()
a=s.index("/**\\n * One button for usage, model and effort")
b=s.index("export function ModeBadge")
s=s[:a]+s[b:]
open(p,'w').write(s)
EOF
npx vitest run test/composer.test.ts`;

const AGENTS = [
  ['Composer clarity, colors, fix mic', 957, 169_800, true],
  ['Build shared project index', 109, 157_500],
  ['Build inline edit (Cmd+K)', 120, 165_800],
  ['Build inline edit (Cmd+K)', 12, 58_600],
  ['Build rewind / restore points', 1558, 204_100],
  ['Build shared project rules and memory', 114, 149_900],
  ['Fix updater for macOS translocation', 227, 85_800],
  ['Fix composer squeeze at narrow width', 920, 242_200],
  ['Subagent visibility in chat and map', 887, 210_200],
  ['Browser tools for Claude Code extension', 506, 167_400],
  ['Status groups and topic titles', 345, 274_400],
  ['Agent Manager list view', 431, 122_300],
  ['Chat list cleanup', 264, 96_100],
  ['Ship external stdio bridge', 98, 41_700],
];

const choice = (value, name, description) => ({ value, name, ...(description ? { description } : {}) });

const MODELS = [
  choice('default', 'Default (recommended)', 'Opus 5.5 · Best for everyday, complex tasks'),
  choice('opus', 'Opus 5.5', 'For complex work and everyday tasks'),
  choice('fable', 'Fable 5.1', 'For your toughest challenges'),
  choice('sonnet', 'Sonnet 5.5', 'Most efficient for simpler tasks'),
  choice('haiku', 'Haiku 5.5', 'Fastest for quick answers'),
  choice('haiku-4-5', 'Haiku 4.5', 'Fastest for quick answers'),
  choice('sonnet-5', 'Sonnet 5', 'Efficient for everyday tasks'),
];

const session = {
  live: true,
  options: [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      current: 'auto',
      via: 'option',
      choices: [
        choice('default', 'Manual', 'Always ask before making changes'),
        choice('acceptEdits', 'Accept edits', 'Automatically accept all file edits'),
        choice('plan', 'Plan', 'Claude can analyze but not modify files or execute commands'),
        choice('auto', 'Auto', 'Claude handles permission decisions'),
        choice('bypassPermissions', 'Bypass permissions', 'Accepts all permissions'),
      ],
    },
    // The model pill names the model in use: the default resolves to Opus 5.5.
    { id: 'model', name: 'Model', category: 'model', type: 'select', current: 'default', via: 'option', choices: MODELS },
    { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', current: 'low', via: 'option', choices: ['Low', 'Medium', 'High', 'Xhigh', 'Max'].map((n) => choice(n.toLowerCase(), n)) },
    { id: 'ultracode', name: 'Ultracode', description: 'Longer, deeper runs on hard problems', category: 'model_config', type: 'boolean', current: false, choices: [], via: 'option' },
  ],
  commands: [
    { name: 'clear', description: 'Clear the conversation' },
    { name: 'compact', description: 'Clear conversation history but keep a summary in context' },
    { name: 'review', description: 'Review a pull request' },
  ],
  usage: { used: 431_500, size: 1_000_000 },
};

export function referenceFixture(now = Date.now()) {
  const s = (sec) => now - sec * 1000;
  const items = [
    { kind: 'user', text: PROMPT, images: [], checkpoint: 'turn-1' },
    { kind: 'thought', text: 'The composer row needs the model and effort pills; the map opens from the agents pill.' },
    {
      kind: 'tool',
      id: 'toolu_bash',
      title: 'Bash',
      toolKind: 'execute',
      status: 'completed',
      locations: [],
      cmd: { line: HEREDOC },
      about: 'Drop the old controls and run the composer tests',
      out: [{ t: 'text', text: '```console\n Test Files  1 passed (1)\n      Tests  5 passed (5)\n```' }],
      exit: 0,
      ms: 2400,
    },
    { kind: 'thought', text: 'Now the pill styles.' },
    { kind: 'tool', id: 'toolu_read', title: 'Read src/webview/composerMenus.tsx', toolKind: 'read', status: 'completed', locations: [`${ROOT}/extensions/friedliver-agents/src/webview/composerMenus.tsx`] },
    {
      kind: 'tool',
      id: 'toolu_edit',
      title: 'Edit src/webview/composerMenus.tsx',
      toolKind: 'edit',
      status: 'completed',
      locations: [`${ROOT}/extensions/friedliver-agents/src/webview/composerMenus.tsx`],
      out: [
        {
          t: 'diff',
          path: `${ROOT}/extensions/friedliver-agents/src/webview/composerMenus.tsx`,
          added: 2,
          removed: 1,
          isNew: false,
          more: 0,
          lines: [
            { op: ' ', text: '      <button type="button" class="cc-pill cc-model" onClick={() => open(\'model\')}>' },
            { op: '-', text: '        {choiceName(model)}' },
            { op: '+', text: '        {choiceName(model) ?? AGENT_FACES[chat.agent].name}' },
            { op: '+', text: '        {effort && <span class="cc-pill-sub">{choiceName(effort)}</span>}' },
            { op: ' ', text: '      </button>' },
          ],
        },
      ],
    },
    {
      kind: 'agent',
      text: [
        'The composer now has one row: `+`, `/`, the agents pill and the model pill on the left, the mode and send on the right.',
        '',
        '- The model pill opens **Select a model**, with effort and Ultracode under the list.',
        '- The agents pill opens the **Agent map**; each agent opens its card or chat.',
        '- `Shift+Tab` cycles the modes, as in Claude Code.',
        '',
        '```ts',
        "export const MODE_NAMES = { ask: 'Manual', edits: 'Edit automatically', plan: 'Plan', full: 'Auto' };",
        '```',
      ].join('\n'),
    },
  ];
  const chat = {
    id: 'chat-ref',
    agent: 'claude',
    label: 'Claude 1',
    title: 'IDE identification question',
    cwd: ROOT,
    createdAt: s(3600),
    busy: false,
    approval: 'full',
    changedFiles: 1,
    items,
    depth: 0,
    files: [],
    lastActivity: s(30),
    turns: 3,
    session,
  };
  const linked = AGENTS.map(([title, secs, tokens, busy], n) => ({
    id: `chat-a${n}`,
    agent: 'claude',
    label: `Claude ${n + 2}`,
    title,
    cwd: ROOT,
    createdAt: s(secs + 60),
    busy: !!busy,
    changedFiles: 0,
    items: [],
    depth: 1,
    files: [],
    lastActivity: s(60),
    turns: 1,
    origin: { kind: 'handoff', chatId: 'chat-ref', by: 'agent' },
    session: { live: true, options: [], commands: [], usage: { used: tokens, size: 1_000_000 } },
  }));
  // Busy agents' time runs to now: pin the first one's start so it reads 15m 57s.
  linked[0].createdAt = s(957);
  // A prompt of 3,000 characters, then enough of a turn to scroll it out of view.
  const long = {
    ...chat,
    id: 'chat-long',
    title: 'A very long prompt',
    approval: 'ask',
    items: [
      { kind: 'user', text: LONG_PROMPT, images: [], checkpoint: 'turn-l1' },
      ...[1, 2, 3, 4, 5, 6].flatMap((n) => items.slice(1).map((i) => (i.kind === 'tool' ? { ...i, id: `${i.id}-${n}` } : i))),
    ],
  };
  return { state: { chats: [chat, long, ...linked], images: [], links: [] }, ids: { chat: chat.id } };
}
