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
    expect(await actions.run({ type: 'permission', requestId: p.requestId, optionId: 'made-up' })).toEqual({ ok: false, error: 'The agent did not offer that answer.' });
    expect(await actions.run({ type: 'permission', requestId: p.requestId, optionId: 'allow' })).toEqual({ ok: true });
    await turn;
    expect(core.chat(chat.id)!.items.find((i) => i.kind === 'permission')).toMatchObject({ answer: 'Yes' });
    expect(confirms).toEqual([]);
    expect(await actions.run({ type: 'permission', requestId: p.requestId, optionId: 'allow' })).toMatchObject({ ok: false });
  });

  it('need the Mac’s OK for an agent’s “don’t ask again”, and leave the card waiting without it', async () => {
    const { core, actions, confirms } = await setup(false);
    const chat = await core.createChat('demo');
    const turn = core.send(chat.id, 'native-run');
    await waitFor(() => !!open(core, chat.id));
    const p = open(core, chat.id)!;
    const always = p.options.find((o) => o.kind === 'allow_always')!;
    expect(await actions.run({ type: 'permission', requestId: p.requestId, optionId: always.optionId })).toEqual({ ok: false, error: 'Not confirmed on the Mac.' });
    expect(confirms).toHaveLength(1);
    expect(open(core, chat.id)?.requestId).toBe(p.requestId);
    expect(await actions.run({ type: 'permission', requestId: p.requestId, optionId: null })).toEqual({ ok: true });
    await turn;
  });

  it('cannot reach a chat the phone may not see, or its requests', async () => {
    const { core, actions, hidden } = await setup(true);
    const chat = await core.createChat('demo');
    const turn = core.send(chat.id, 'native-run');
    await waitFor(() => !!open(core, chat.id));
    hidden.add(chat.id);
    const p = open(core, chat.id)!;
    expect(await actions.run({ type: 'permission', requestId: p.requestId, optionId: 'allow' })).toMatchObject({ ok: false });
    expect(await actions.run({ type: 'send', chatId: chat.id, text: 'hi' })).toMatchObject({ ok: false });
    expect(await actions.run({ type: 'stop', chatId: chat.id })).toMatchObject({ ok: false });
    expect(await actions.run({ type: 'approval', chatId: chat.id, level: 'edits' })).toMatchObject({ ok: false });
    expect(phoneChats(core.snapshot, (id) => hidden.has(id))).toEqual([]);
    hidden.clear();
    await actions.run({ type: 'stop', chatId: chat.id });
    await turn;
  });

  it('turn on Auto only after the Mac says yes', async () => {
    const no = await setup(false);
    const chat = await no.core.createChat('demo');
    await no.actions.run({ type: 'approval', chatId: chat.id, level: 'full' });
    expect(no.core.chat(chat.id)!.approval).toBeUndefined();
    expect(no.confirms).toEqual(['Run Demo in Auto? Your phone asks.']);
  });

  it('send, stop, and start a chat in one of the window’s folders with one of the shown agents', async () => {
    const { core, actions, dir } = await setup();
    expect(await actions.run({ type: 'newChat', agent: 'codex', folder: dir, text: '' })).toMatchObject({ ok: false });
    expect(await actions.run({ type: 'newChat', agent: 'demo', folder: '/etc', text: '' })).toMatchObject({ ok: false });
    const made = await actions.run({ type: 'newChat', agent: 'demo', folder: dir, text: 'say hello' });
    expect(made).toMatchObject({ ok: true, chatId: expect.any(String) });
    const chatId = (made as { chatId: string }).chatId;
    await waitFor(() => !core.chat(chatId)!.busy && core.chat(chatId)!.items.some((i) => i.kind === 'agent'));
    expect(core.chat(chatId)!.items[0]).toMatchObject({ kind: 'user', text: 'say hello' });
    await actions.run({ type: 'send', chatId, text: 'wait' });
    await waitFor(() => core.chat(chatId)!.busy);
    await actions.run({ type: 'stop', chatId });
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
    expect(await actions.run({ type: 'review', reviewId: id, action: 'reject' })).toEqual({ ok: true });
    expect(reviews).toEqual([`reject ${id}`]);
    core.decideReview(id, false);
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
    expect(item?.k === 'permission' && item.options.find((o) => o.kind === 'allow_always')?.escalates).toBe(true);
    core.answerPermission(open(core, chat.id)!.requestId, null);
    await turn;
  });
});

describe('parsing what the phone sends', () => {
  it('takes only the actions a phone may send, well formed', () => {
    expect(parseRemoteAction({ type: 'send', chatId: 'chat-1', text: 'hi' })).toEqual({ type: 'send', chatId: 'chat-1', text: 'hi' });
    expect(parseRemoteAction({ type: 'send', chatId: 'chat-1', text: 'hi', images: [{ name: 'x', mimeType: 'image/png', data: 'AA==' }] })).toEqual({ type: 'send', chatId: 'chat-1', text: 'hi' });
    expect(parseRemoteAction({ type: 'review', reviewId: 'review-1', action: 'open' })).toBeNull();
    for (const t of ['openFile', 'runInTerminal', 'insert', 'copy', 'removeChat', 'merge', 'setOption', 'fanout', 'createTask', 'revokeAllPermissions', 'openText']) {
      expect(parseRemoteAction({ type: t, chatId: 'chat-1', path: '/etc/passwd', command: 'ls', text: 'x' }), t).toBeNull();
    }
    expect(parseRemoteAction({ type: 'approval', chatId: 'chat-1', level: 'full' })).toEqual({ type: 'approval', chatId: 'chat-1', level: 'full' });
    expect(parseRemoteAction({ type: 'newChat', agent: 'claude', folder: '/w', text: 'x' })).toEqual({ type: 'newChat', agent: 'claude', folder: '/w', text: 'x' });
    expect(parseRemoteAction({ type: 'newChat', agent: 'evil', folder: '/w', text: '' })).toBeNull();
    expect(parseRemoteAction([])).toBeNull();
    expect(parseRemoteAction(null)).toBeNull();
  });
});
