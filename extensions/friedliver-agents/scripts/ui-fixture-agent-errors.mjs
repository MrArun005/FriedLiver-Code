// Agent errors in plain words, and chats that agent-to-agent goes back to: a Claude chat
// that handed off to Gemini and consulted Codex; the Codex consultation failed because the
// account can't use its model (with one-click switches), and Gemini refused the mode the
// user picked in a folder it doesn't trust. The texts are the ones the real adapters gave
// on the owner's Mac (codex-acp, gemini-cli). Only the UI harness uses it (?fixture=agent-errors).

const ROOT = '/Users/arun/code/shop';

export function agentErrorsFixture(now = Date.now()) {
  const sec = (s) => now - s * 1000;
  const chat = (id, agent, label, title, items, over = {}) => ({
    id,
    agent,
    label,
    title,
    cwd: ROOT,
    createdAt: sec(1800),
    busy: false,
    changedFiles: 0,
    items,
    depth: 0,
    files: [],
    lastActivity: sec(30),
    turns: 1,
    ...over,
  });
  const refused = "The 'old-mini' model is not supported when using Codex with a ChatGPT account.";
  const modelOption = {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    current: 'old-mini',
    via: 'option',
    choices: [
      { value: 'luna', name: '6 Luna' },
      { value: 'terra', name: '5.6 Terra' },
    ],
  };
  const chats = [
    chat('chat-main', 'claude', 'Claude', 'Checkout totals round wrong', [
      { kind: 'user', text: 'Checkout totals are off by a cent for some carts. Find out why.', images: [], at: sec(1700) },
      { kind: 'agent', text: 'Line totals are rounded before they are summed. I’ll ask Codex to double-check the fix.', at: sec(1650) },
      { kind: 'link', linkId: 'link-ask', role: 'asked', chatId: 'chat-codex', agent: 'codex', label: 'Codex', text: 'Is rounding once at the end safe for tax lines?', by: 'agent' },
      { kind: 'notice', tone: 'error', text: "Codex couldn't answer. Codex can't use the model old-mini with this account." },
      { kind: 'notice', tone: 'error', text: "Gemini isn't installed.", detail: 'npm install -g @google/gemini-cli', detailKind: 'code' },
      { kind: 'link', linkId: 'link-handoff', role: 'handoff-to', chatId: 'chat-gemini', agent: 'gemini', label: 'Gemini', text: '4 messages', by: 'user' },
    ]),
    chat(
      'chat-codex',
      'codex',
      'Codex',
      'Is rounding once at the end safe for tax lines?',
      [
        { kind: 'link', linkId: 'link-ask', role: 'consulted', chatId: 'chat-main', agent: 'claude', label: 'Claude', text: 'Is rounding once at the end safe for tax lines?', by: 'agent' },
        {
          kind: 'notice',
          tone: 'error',
          text: "Codex can't use the model old-mini with this account.",
          detail: refused,
          actions: [
            { label: 'Use 6 Luna', do: 'setOption', optionId: 'model', value: 'luna' },
            { label: 'Use 5.6 Terra', do: 'setOption', optionId: 'model', value: 'terra' },
          ],
        },
      ],
      { depth: 1, origin: { kind: 'consult', chatId: 'chat-main', by: 'agent' }, session: { options: [modelOption], commands: [], live: true } },
    ),
    chat(
      'chat-gemini',
      'gemini',
      'Gemini',
      'Checkout totals round wrong',
      [
        { kind: 'link', linkId: 'link-handoff', role: 'handoff-from', chatId: 'chat-main', agent: 'claude', label: 'Claude', text: '4 messages', by: 'user' },
        { kind: 'user', text: 'Carry on: write the regression test.', images: [], at: sec(300) },
        { kind: 'agent', text: 'Added `rounds once per cart` to checkout.test.ts. It fails on main and passes with the fix.', at: sec(240) },
        { kind: 'notice', tone: 'error', text: "Gemini didn't change Mode to Auto Edit: Cannot enable privileged approval modes in an untrusted folder.", detail: "Trust this folder in Gemini: run `gemini` in it and choose to trust it, then pick the level again." },
      ],
      { origin: { kind: 'handoff', chatId: 'chat-main', by: 'user' } },
    ),
  ];
  const links = [
    { id: 'link-ask', kind: 'consult', from: 'chat-main', to: 'chat-codex', by: 'agent', createdAt: sec(1600), active: true, count: 1 },
    { id: 'link-handoff', kind: 'handoff', from: 'chat-main', to: 'chat-gemini', by: 'user', createdAt: sec(600), active: true, count: 1 },
  ];
  return { state: { chats, images: [], links } };
}
