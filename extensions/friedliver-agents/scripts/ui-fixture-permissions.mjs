// "Always allow": a Claude chat waiting on three approvals (reading a file on the Desktop, opening
// IRCTC in the browser, asking Codex), and what Manage Permissions lists after a week of
// remembering. Only the UI harness uses it (?fixture=permissions).

const HOME = '/Users/arun';

export function permissionsFixture(now = Date.now()) {
  const s = (sec) => now - sec * 1000;
  const items = [
    { kind: 'user', text: 'Find tomorrow’s Delhi–Agra trains for the trip in my Desktop notes, and check seats on IRCTC.', images: [] },
    { kind: 'agent', text: 'I’ll read your trip notes first, then look the trains up.' },
    {
      kind: 'permission',
      requestId: 'perm-read',
      toolCallId: 'tc-read',
      title: `Read ${HOME}/Desktop/trip/plan.txt`,
      toolKind: 'read',
      options: [
        { optionId: 'allow', name: 'Yes', kind: 'allow_once' },
        { optionId: 'always', name: "Yes, and don't ask again for this session", kind: 'allow_always' },
        { optionId: 'reject', name: 'No', kind: 'reject_once' },
      ],
      detail: {
        locations: [`${HOME}/Desktop/trip/plan.txt`],
        always: [
          { kind: 'folder', folder: `${HOME}/Desktop/trip`, access: 'read' },
          { kind: 'folder', folder: `${HOME}/Desktop`, access: 'read' },
        ],
      },
    },
    { kind: 'bridge', requestId: 'bridge-irctc', tool: 'browser_open', target: { browser: true }, text: 'https://www.irctc.co.in/nget/train-search', state: 'awaiting', always: 'https://www.irctc.co.in' },
    { kind: 'bridge', requestId: 'bridge-codex', tool: 'ask_agent', target: { agent: 'codex' }, text: 'Which of these trains has the best on-time record this month?', state: 'awaiting', always: 'in every chat' },
    { kind: 'bridge', requestId: 'bridge-spotify', tool: 'system_open', target: { system: 'Spotify' }, text: '', state: 'awaiting', always: 'Spotify' },
    { kind: 'bridge', requestId: 'bridge-clip', tool: 'system_clipboard_read', target: { system: '' }, text: '', state: 'awaiting', once: true },
    { kind: 'bridge', requestId: 'bridge-done', tool: 'browser_click', target: { browser: true }, text: '"Find trains"', state: 'allowed', auto: 'Always allowed: https://www.irctc.co.in' },
  ];
  const chat = {
    id: 'chat-trip',
    agent: 'claude',
    label: 'Claude 1',
    title: 'Delhi–Agra trains',
    cwd: `${HOME}/code/trips`,
    createdAt: s(300),
    busy: true,
    changedFiles: 0,
    items,
    depth: 0,
    files: [],
    lastActivity: s(3),
    turns: 1,
  };
  const day = 86_400;
  const rules = [
    { id: 'site https://www.irctc.co.in', grant: { kind: 'site', origin: 'https://www.irctc.co.in' }, scope: 'user', at: s(2 * 60), agent: 'Claude' },
    { id: 'site http://localhost:3000', grant: { kind: 'site', origin: 'http://localhost:3000' }, scope: 'user', at: s(3 * day), agent: 'Claude Code (outside FriedLiver)' },
    { id: 'system system_open app:Spotify', grant: { kind: 'system', tool: 'system_open', target: 'app:Spotify' }, scope: 'user', at: s(5 * 60), agent: 'Claude' },
    { id: 'tool ask_agent', grant: { kind: 'tool', tool: 'ask_agent' }, scope: 'user', at: s(day), agent: 'Gemini' },
    { id: `folder-read ${HOME}/Desktop`, grant: { kind: 'folder', folder: `${HOME}/Desktop`, access: 'read' }, scope: 'workspace', at: s(60 * 60), agent: 'Claude' },
    { id: `folder-write ${HOME}/code/trips`, grant: { kind: 'folder', folder: `${HOME}/code/trips`, access: 'write' }, scope: 'workspace', at: s(2 * day), agent: 'Codex' },
    { id: 'command-prefix npm test', grant: { kind: 'prefix', command: 'npm test' }, scope: 'workspace', at: s(6 * day), agent: 'Claude' },
    { id: 'command-exact git status', grant: { kind: 'exact', command: 'git status' }, scope: 'workspace' },
  ];
  return { state: { chats: [chat], images: [], links: [] }, rules, ids: { chat: chat.id } };
}
