// The phone's actions, end to end with the Demo agent: the same core calls as
// the desktop, only on chats and requests the phone may see, and the Mac's OK
// for anything that keeps allowing.
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentCore } from '../src/host/core';
import { RemoteActions } from '../src/remote/actions';
import { phoneChat, phoneChats, phoneList } from '../src/remote/phoneView';
import { parseRemoteAction } from '../src/remote/protocol';
import type { Item } from '../src/shared/model';
import { disposeCores, gitRepo, makeCore, memoryPermissions, waitFor } from './helpers';

afterEach(disposeCores);

type Permission = Extract<Item, { kind: 'permission' }>;
const open = (c: AgentCore, chatId: string) => c.chat(chatId)!.items.find((i): i is Permission => i.kind === 'permission' && !i.answer);

const PHONE = { id: 'd1', name: 'Arun’s iPhone' };

async function setup(confirmAnswer = false) {
  const dir = await gitRepo();
  const confirms: string[] = [];
  const reviews: string[] = [];
  const hidden = new Set<string>();
  const core = makeCore(dir, { permissions: memoryPermissions(), ui: { showReview: () => {}, closeReview: () => {}, askCommand: () => {}, confirmRemote: async (a) => (confirms.push(a.title), confirmAnswer) } });
  const actions = new RemoteActions({
    core,
    folders: () => [dir],
    agents: () => ['claude', 'demo'],
    reviews: { accept: (id) => (reviews.push(`accept ${id}`), true), reject: (id) => (reviews.push(`reject ${id}`), true) },
    confirm: async (a) => (confirms.push(a.title), confirmAnswer),
    hidden: (id) => hidden.has(id),
  });
  return { dir, core, actions, confirms, reviews, hidden };
}

describe('phone actions', () => {
  it('answer a permission through the core, with an option the agent offered', async () => {
    const { core, actions, confirms } = await setup();
    const chat = await core.createChat('demo');
    const turn = core.send(chat.id, 'native-run');
    await waitFor(() => !!open(core, chat.id));
    const p = open(core, chat.id)!;
    expect(await actions.run({ type: 'permission', requestId: p.requestId, optionId: 'made-up' }, PHONE)).toEqual({ ok: false, error: 'The agent did not offer that answer.' });
    expect(await actions.run({ type: 'permission', requestId: p.requestId, optionId: 'allow', shown: 'node --version' }, PHONE)).toEqual({ ok: true });
    await turn;
    expect(core.chat(chat.id)!.items.find((i) => i.kind === 'permission')).toMatchObject({ answer: 'Yes' });
    expect(confirms).toEqual([]);
    expect(await actions.run({ type: 'permission', requestId: p.requestId, optionId: 'allow', shown: 'node --version' }, PHONE)).toMatchObject({ ok: false });
  });

  it('need the Mac’s OK for an agent’s “don’t ask again”, and leave the card waiting without it', async () => {
    const { core, actions, confirms } = await setup(false);
    const chat = await core.createChat('demo');
    const turn = core.send(chat.id, 'native-run');
    await waitFor(() => !!open(core, chat.id));
    const p = open(core, chat.id)!;
    const always = p.options.find((o) => o.kind === 'allow_always')!;
    expect(await actions.run({ type: 'permission', requestId: p.requestId, optionId: always.optionId, shown: 'node --version' }, PHONE)).toEqual({ ok: false, error: 'Not confirmed on the Mac.' });
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toBe('Phone “Arun’s iPhone” asks: Answer “Yes, and don\'t ask again for this session” for Demo?');
    expect(open(core, chat.id)?.requestId).toBe(p.requestId);
    expect(await actions.run({ type: 'permission', requestId: p.requestId, optionId: null }, PHONE)).toEqual({ ok: true });
    await turn;
  });

  it('cannot reach a chat the phone may not see, or its requests', async () => {
    const { core, actions, hidden } = await setup(true);
    const chat = await core.createChat('demo');
    const turn = core.send(chat.id, 'native-run');
    await waitFor(() => !!open(core, chat.id));
    hidden.add(chat.id);
    const p = open(core, chat.id)!;
    expect(await actions.run({ type: 'permission', requestId: p.requestId, optionId: 'allow', shown: 'node --version' }, PHONE)).toMatchObject({ ok: false });
    expect(await actions.run({ type: 'send', chatId: chat.id, text: 'hi' }, PHONE)).toMatchObject({ ok: false });
    expect(await actions.run({ type: 'stop', chatId: chat.id }, PHONE)).toMatchObject({ ok: false });
    expect(await actions.run({ type: 'approval', chatId: chat.id, level: 'edits' }, PHONE)).toMatchObject({ ok: false });
    expect(phoneChats(core.snapshot, (id) => hidden.has(id))).toEqual([]);
    hidden.clear();
    await actions.run({ type: 'stop', chatId: chat.id }, PHONE);
    await turn;
  });

  it('turn on Auto or auto-accept edits only after the Mac says yes', async () => {
    const no = await setup(false);
    const chat = await no.core.createChat('demo');
    await no.actions.run({ type: 'approval', chatId: chat.id, level: 'full' }, PHONE);
    expect(no.core.chat(chat.id)!.approval).toBeUndefined();
    expect(no.confirms).toEqual(['Phone “Arun’s iPhone” asks: Run Demo in Auto?']);
    await no.actions.run({ type: 'approval', chatId: chat.id, level: 'edits' }, PHONE);
    expect(no.core.chat(chat.id)!.approval).toBeUndefined();
    expect(no.confirms).toHaveLength(2);
  });

  it('send, stop, and start a chat in one of the window’s folders with one of the shown agents', async () => {
    const { core, actions, dir } = await setup();
    expect(await actions.run({ type: 'newChat', agent: 'codex', folder: dir, text: '' }, PHONE)).toMatchObject({ ok: false });
    expect(await actions.run({ type: 'newChat', agent: 'demo', folder: '/etc', text: '' }, PHONE)).toMatchObject({ ok: false });
    const made = await actions.run({ type: 'newChat', agent: 'demo', folder: dir, text: 'say hello' }, PHONE);
    expect(made).toMatchObject({ ok: true, chatId: expect.any(String) });
    const chatId = (made as { chatId: string }).chatId;
    await waitFor(() => !core.chat(chatId)!.busy && core.chat(chatId)!.items.some((i) => i.kind === 'agent'));
    expect(core.chat(chatId)!.items[0]).toMatchObject({ kind: 'user', text: 'say hello' });
    await actions.run({ type: 'send', chatId, text: 'wait' }, PHONE);
    await waitFor(() => core.chat(chatId)!.busy);
    await actions.run({ type: 'stop', chatId }, PHONE);
    await waitFor(() => !core.chat(chatId)!.busy);
  });

  it('accept or reject a pending edit through the desktop’s review path', async () => {
    const { core, actions, reviews } = await setup();
    const chat = await core.createChat('demo');
    void core.send(chat.id, 'edit README.md');
    await waitFor(() => !!open(core, chat.id));
    core.answerPermission(open(core, chat.id)!.requestId, 'allow');
    await waitFor(() => core.chat(chat.id)!.items.some((i) => i.kind === 'review' && i.state === 'pending'));
    const r = core.chat(chat.id)!.items.find((i) => i.kind === 'review')!;
    const id = r.kind === 'review' ? r.reviewId : '';
    const view = phoneChat(core.snapshot, core.chat(chat.id)!, (rid) => {
      const p = core.review(rid);
      return p && { before: p.before, proposed: p.proposed };
    });
    expect(view.items.find((i) => i.k === 'review')).toMatchObject({ k: 'review', id, state: 'pending', file: { path: 'README.md', lines: expect.arrayContaining([expect.objectContaining({ op: '+' })]) } });
    expect(await actions.run({ type: 'review', reviewId: id, action: 'reject' }, PHONE)).toEqual({ ok: true });
    expect(reviews).toEqual([`reject ${id}`]);
    core.decideReview(id, false);
  });
});

/** A core with one chat holding the given waiting items, recording what was called. */
function fakeCore(items: Item[]) {
  const calls: string[] = [];
  const chat = { id: 'chat-1', agent: 'claude', label: 'Claude', title: 'Fix it', cwd: '/w', createdAt: 0, busy: true, changedFiles: 0, items, depth: 0, files: [], lastActivity: 0, turns: 0 };
  const core = {
    snapshot: { chats: [chat], images: [], links: [] },
    answerPermission: (id: string, opt: string | null) => calls.push(`permission ${id} ${opt}`),
    decideCommand: (id: string, ok: boolean) => calls.push(`command ${id} ${ok}`),
    answerBridge: (id: string, a: string) => calls.push(`bridge ${id} ${a}`),
  } as unknown as AgentCore;
  return { core, calls };
}

function fakeActions(items: Item[], confirmAnswer: boolean, paired = () => true) {
  const { core, calls } = fakeCore(items);
  const confirms: string[] = [];
  const actions = new RemoteActions({
    core,
    folders: () => [],
    agents: () => [],
    reviews: { accept: () => true, reject: () => true },
    confirm: async (a) => (confirms.push(a.title), confirmAnswer),
    paired,
  });
  return { actions, calls, confirms };
}

describe('phone actions, the strict cases', () => {
  it('confirm any allow but the plain one-time yes, however the agent names it', async () => {
    const perm: Item = {
      kind: 'permission',
      requestId: 'perm-1',
      title: 'Run make',
      options: [
        { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
        { optionId: 'session', name: 'Yes, for this session', kind: 'allow_once' },
        { optionId: 'no', name: 'No', kind: 'reject_once' },
      ],
    };
    const { actions, calls, confirms } = fakeActions([perm], false);
    expect(await actions.run({ type: 'permission', requestId: 'perm-1', optionId: 'session' }, PHONE)).toMatchObject({ ok: false });
    expect(confirms).toHaveLength(1);
    expect(await actions.run({ type: 'permission', requestId: 'perm-1', optionId: 'no' }, PHONE)).toEqual({ ok: true });
    expect(await actions.run({ type: 'permission', requestId: 'perm-1', optionId: 'yes' }, PHONE)).toEqual({ ok: true });
    expect(confirms).toHaveLength(1);
    // That card names no command, so nothing has to match.
    expect(calls).toEqual(['permission perm-1 no', 'permission perm-1 yes']);
  });

  it('allow a careful request only once, whatever the Mac would say', async () => {
    const perm: Item = {
      kind: 'permission',
      requestId: 'perm-2',
      title: 'Run git push --force origin main',
      toolKind: 'execute',
      detail: { command: { line: 'git push --force origin main', cwd: '/w' } },
      options: [
        { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
        { optionId: 'always', name: 'Yes, and don’t ask again', kind: 'allow_always' },
        { optionId: 'no', name: 'No', kind: 'reject_once' },
      ],
    };
    const { actions, calls, confirms } = fakeActions([perm], true);
    expect(await actions.run({ type: 'permission', requestId: 'perm-2', optionId: 'always' }, PHONE)).toEqual({ ok: false, error: 'This one can only be allowed once.' });
    expect(await actions.run({ type: 'allowAlways', requestId: 'perm-2', grant: { kind: 'exact', command: 'git push --force origin main' } }, PHONE)).toEqual({ ok: false, error: 'This one can only be allowed once.' });
    expect(confirms).toEqual([]);
    const view = phoneChat({ chats: [] }, { id: 'c', agent: 'claude', label: 'Claude', title: 't', cwd: '/w', createdAt: 0, busy: true, changedFiles: 0, items: [perm], depth: 0, files: [], lastActivity: 0, turns: 0 }).items[0];
    expect(view).toMatchObject({ k: 'permission', verb: 'Run', target: 'git push --force origin main', risk: { level: 'careful', label: 'Rewrites shared history' }, once: 'yes', deny: 'no', always: [] });
    expect(view.k === 'permission' && view.chat).toBeUndefined();
    expect(view.k === 'permission' && view.options).toEqual([]);
    expect(await actions.run({ type: 'permission', requestId: 'perm-2', optionId: 'yes', shown: 'git push --force origin main' }, PHONE)).toEqual({ ok: true });
    expect(calls).toEqual(['permission perm-2 yes']);
  });

  it('allow a command only with the exact text the phone showed, so a changed request is not approved blind', async () => {
    const perm: Item = {
      kind: 'permission',
      requestId: 'perm-5',
      title: 'Run make',
      toolKind: 'execute',
      detail: { command: { line: 'make test', cwd: '/w' } },
      options: [
        { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
        { optionId: 'no', name: 'No', kind: 'reject_once' },
      ],
    };
    const cmd: Item = { kind: 'command', commandId: 'c9', commandLine: 'npm test', cwd: '/w', outside: false, state: 'awaiting', output: '' };
    const { actions, calls } = fakeActions([perm, cmd], true);
    const changed = { ok: false, error: 'The command changed. Review it again.' };
    expect(await actions.run({ type: 'permission', requestId: 'perm-5', optionId: 'yes' }, PHONE)).toEqual(changed);
    expect(await actions.run({ type: 'permission', requestId: 'perm-5', optionId: 'yes', shown: 'make' }, PHONE)).toEqual(changed);
    expect(await actions.run({ type: 'command', commandId: 'c9', approve: true, shown: 'npm test && rm -rf ~' }, PHONE)).toEqual(changed);
    expect(await actions.run({ type: 'allowAlways', commandId: 'c9', grant: { kind: 'exact', command: 'npm test' } }, PHONE)).toEqual(changed);
    // Saying no needs nothing shown.
    expect(await actions.run({ type: 'command', commandId: 'c9', approve: false }, PHONE)).toEqual({ ok: true });
    expect(await actions.run({ type: 'permission', requestId: 'perm-5', optionId: 'yes', shown: 'make test' }, PHONE)).toEqual({ ok: true });
    expect(calls).toEqual(['command c9 false', 'permission perm-5 yes']);
  });

  it('confirm “For this chat” on an agent’s request too, since it keeps allowing', async () => {
    const bridge: Item = { kind: 'bridge', requestId: 'br-1', tool: 'browser_open', target: { browser: true }, text: 'https://example.com', state: 'awaiting' };
    const { actions, calls, confirms } = fakeActions([bridge], false);
    expect(await actions.run({ type: 'bridge', requestId: 'br-1', answer: 'allowChat' }, PHONE)).toMatchObject({ ok: false });
    expect(confirms).toHaveLength(1);
    expect(await actions.run({ type: 'bridge', requestId: 'br-1', answer: 'allow' }, PHONE)).toEqual({ ok: true });
    expect(calls).toEqual(['bridge br-1 allow']);
  });

  it('allow a once-only system request once, never for the chat or always', async () => {
    const sys: Item = { kind: 'bridge', requestId: 'sys-1', tool: 'system_clipboard_read', target: { system: '' }, text: '', state: 'awaiting', once: true };
    const { actions, calls, confirms } = fakeActions([sys], true);
    expect(await actions.run({ type: 'bridge', requestId: 'sys-1', answer: 'allowChat' }, PHONE)).toMatchObject({ ok: false, error: expect.stringContaining('once') });
    expect(confirms).toHaveLength(0);
    expect(await actions.run({ type: 'bridge', requestId: 'sys-1', answer: 'allow' }, PHONE)).toEqual({ ok: true });
    expect(calls).toEqual(['bridge sys-1 allow']);
  });

  it('refuse to approve a command the phone can’t show whole and plain', async () => {
    const cmd = (id: string, line: string): Item => ({ kind: 'command', commandId: id, commandLine: line, cwd: '/w', outside: false, state: 'awaiting', output: '' });
    const { actions, calls } = fakeActions([cmd('c1', 'rm -rf build \u202e; echo ok'), cmd('c2', `echo ${'x'.repeat(5000)}`), cmd('c3', 'npm test')], true);
    expect(await actions.run({ type: 'command', commandId: 'c1', approve: true }, PHONE)).toMatchObject({ ok: false, error: expect.stringContaining('Mac') });
    expect(await actions.run({ type: 'command', commandId: 'c2', approve: true }, PHONE)).toMatchObject({ ok: false });
    expect(await actions.run({ type: 'command', commandId: 'c1', approve: false }, PHONE)).toEqual({ ok: true });
    expect(await actions.run({ type: 'command', commandId: 'c3', approve: true, shown: 'npm test' }, PHONE)).toEqual({ ok: true });
    expect(calls).toEqual(['command c1 false', 'command c3 true']);
  });

  it('drop an OK that comes after the phone was revoked', async () => {
    let paired = true;
    const bridge: Item = { kind: 'bridge', requestId: 'br-1', tool: 'browser_open', target: { browser: true }, text: 'x', state: 'awaiting', always: 'https://example.com' };
    const { core, calls } = fakeCore([bridge]);
    const actions = new RemoteActions({
      core,
      folders: () => [],
      agents: () => [],
      reviews: { accept: () => true, reject: () => true },
      confirm: async () => ((paired = false), true),
      paired: () => paired,
    });
    expect(await actions.run({ type: 'bridge', requestId: 'br-1', answer: 'allowAlways' }, PHONE)).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });
});

describe('what the phone sees', () => {
  it('lists chats by status, with the folders and agents for a new one', async () => {
    const { core, dir } = await setup();
    const chat = await core.createChat('demo');
    await core.send(chat.id, 'hi');
    const list = phoneList(phoneChats(core.snapshot), ['demo'], [dir], 5);
    expect(list.groups.map((g) => g.title)).toEqual(['Done']);
    expect(list.groups[0].chats[0]).toMatchObject({ id: chat.id, label: 'Demo', approval: 'ask', waiting: 0 });
    expect(list.agents).toEqual([{ key: 'demo', name: 'Demo' }]);
  });

  it('shows a waiting command with its folder and the Always allow it would offer', async () => {
    const { core } = await setup();
    const chat = await core.createChat('demo');
    const turn = core.send(chat.id, 'native-run');
    await waitFor(() => !!open(core, chat.id));
    const item = phoneChat(core.snapshot, core.chat(chat.id)!).items.find((i) => i.k === 'permission');
    expect(item).toMatchObject({ command: { line: 'node --version' }, always: [{ grant: { kind: 'exact', command: 'node --version' } }] });
    // The agent's "don't ask again for this session" is the This chat scope; its plain yes and no are Once and Deny.
    expect(item).toMatchObject({ once: 'allow', chat: 'always', deny: 'reject', options: [], risk: { level: 'routine' } });
    core.answerPermission(open(core, chat.id)!.requestId, null);
    await turn;
  });
});

describe('slash commands from the phone', () => {
  /** A chat of this agent that advertises these commands, and a phone whose Mac answers `ok`. */
  function slashSetup(agent: 'claude' | 'codex' | 'gemini', commands: string[], ok: boolean) {
    const sent: string[] = [];
    const confirms: string[] = [];
    const chat = { id: 'chat-1', agent, label: agent, title: 't', cwd: '/w', createdAt: 0, busy: false, changedFiles: 0, items: [], depth: 0, files: [], lastActivity: 0, turns: 0, session: { options: [], commands: commands.map((name) => ({ name, description: '' })), live: true } };
    const core = { snapshot: { chats: [chat], images: [], links: [] }, send: async (_id: string, text: string) => void sent.push(text) } as unknown as AgentCore;
    const actions = new RemoteActions({ core, folders: () => [], agents: () => [], reviews: { accept: () => true, reject: () => true }, confirm: async (a) => (confirms.push(a.title), ok) });
    const send = (text: string) => actions.run({ type: 'send', chatId: 'chat-1', text }, PHONE);
    return { send, sent, confirms };
  }

  it('Claude: harmless ones go, permission and settings ones are refused, others wait for the Mac', async () => {
    const { send, sent, confirms } = slashSetup('claude', ['help', 'cost', 'status', 'clear', 'compact', 'permissions', 'config', 'model', 'review'], false);
    expect(await send('/help')).toEqual({ ok: true });
    expect(await send('  /cost')).toEqual({ ok: true });
    for (const c of ['/permissions', '/config', '/allowed-tools Bash', '/dangerously-skip-permissions', '/bypass']) {
      expect(await send(c), c).toMatchObject({ ok: false, error: expect.stringContaining('on your Mac') });
    }
    expect(await send('/clear')).toEqual({ ok: false, error: 'Not confirmed on the Mac.' });
    expect(await send('/model opus')).toEqual({ ok: false, error: 'Not confirmed on the Mac.' });
    expect(confirms).toEqual(['Phone “Arun’s iPhone” asks: Send /clear to claude?', 'Phone “Arun’s iPhone” asks: Send /model to claude?']);
    expect(sent).toEqual(['/help', '  /cost']);
  });

  it('Codex: /approvals and /mode are refused; an OK on the Mac sends the rest', async () => {
    const { send, sent, confirms } = slashSetup('codex', ['approvals', 'mode', 'init', 'diff'], true);
    expect(await send('/approvals full-access')).toMatchObject({ ok: false });
    expect(await send('/mode')).toMatchObject({ ok: false });
    expect(await send('/init')).toEqual({ ok: true });
    expect(confirms).toEqual(['Phone “Arun’s iPhone” asks: Send /init to codex?']);
    expect(sent).toEqual(['/init']);
  });

  it('Gemini: /yolo and /settings are refused, unknown commands wait for the Mac, and an @mention doesn’t hide one', async () => {
    const { send, sent, confirms } = slashSetup('gemini', ['about', 'memory'], false);
    expect(await send('/yolo')).toMatchObject({ ok: false, error: expect.stringContaining('on your Mac') });
    expect(await send('/settings')).toMatchObject({ ok: false });
    expect(await send('@claude /permissions')).toMatchObject({ ok: false, error: expect.stringContaining('on your Mac') });
    expect(await send('/made-up thing')).toEqual({ ok: false, error: 'Not confirmed on the Mac.' });
    expect(confirms[0]).toContain('/made-up');
    expect(await send('use a/b paths, not /tmp')).toEqual({ ok: true });
    expect(sent).toEqual(['use a/b paths, not /tmp']);
  });

  it('applies to a new chat’s first message too', async () => {
    const created: string[] = [];
    const core = { snapshot: { chats: [], images: [], links: [] }, createChat: async () => (created.push('chat'), { id: 'chat-9' }), send: async () => {} } as unknown as AgentCore;
    const actions = new RemoteActions({ core, folders: () => ['/w'], agents: () => ['claude'], reviews: { accept: () => true, reject: () => true }, confirm: async () => false });
    expect(await actions.run({ type: 'newChat', agent: 'claude', folder: '/w', text: '/permissions' }, PHONE)).toMatchObject({ ok: false });
    expect(created).toEqual([]);
  });
});

describe('a disguised command on the phone', () => {
  it('is spelled out, and offers no Run or Always allow there', () => {
    const { core } = fakeCore([{ kind: 'command', commandId: 'c1', commandLine: 'ls \u202eexe.sh', cwd: '/w', outside: false, state: 'awaiting', output: '' }]);
    const item = phoneChat(core.snapshot, core.snapshot.chats[0]).items[0];
    expect(item).toMatchObject({ k: 'command', line: 'ls ⟨U+202E⟩exe.sh', onMac: true });
  });
});

describe('parsing what the phone sends', () => {
  it('takes only the actions a phone may send, well formed', () => {
    expect(parseRemoteAction({ type: 'send', chatId: 'chat-1', text: 'hi' })).toEqual({ type: 'send', chatId: 'chat-1', text: 'hi' });
    expect(parseRemoteAction({ type: 'send', chatId: 'chat-1', text: 'hi', images: [{ name: 'x', mimeType: 'image/png', data: 'AA==' }] })).toEqual({ type: 'send', chatId: 'chat-1', text: 'hi' });
    expect(parseRemoteAction({ type: 'review', reviewId: 'review-1', action: 'open' })).toBeNull();
    for (const t of ['openFile', 'runInTerminal', 'insert', 'copy', 'removeChat', 'merge', 'setOption', 'plan', 'fanout', 'createTask', 'revokeAllPermissions', 'openText']) {
      expect(parseRemoteAction({ type: t, chatId: 'chat-1', path: '/etc/passwd', command: 'ls', text: 'x' }), t).toBeNull();
    }
    expect(parseRemoteAction({ type: 'approval', chatId: 'chat-1', level: 'full' })).toEqual({ type: 'approval', chatId: 'chat-1', level: 'full' });
    expect(parseRemoteAction({ type: 'command', commandId: 'c1', approve: true, shown: 'npm test' })).toEqual({ type: 'command', commandId: 'c1', approve: true, shown: 'npm test' });
    expect(parseRemoteAction({ type: 'command', commandId: 'c1', approve: true, shown: 5 })).toBeNull();
    expect(parseRemoteAction({ type: 'newChat', agent: 'claude', folder: '/w', text: 'x' })).toEqual({ type: 'newChat', agent: 'claude', folder: '/w', text: 'x' });
    expect(parseRemoteAction({ type: 'newChat', agent: 'evil', folder: '/w', text: '' })).toBeNull();
    expect(parseRemoteAction([])).toBeNull();
    expect(parseRemoteAction(null)).toBeNull();
  });
});
