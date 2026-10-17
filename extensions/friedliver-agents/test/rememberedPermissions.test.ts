// "Always allow" end to end with the Demo agent: a folder or website remembered from one request
// answers the agent's next requests (its own permission prompts) in every chat, for every agent,
// after a restart; nothing outside what the card offered, and nothing sensitive, is remembered.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentCore } from '../src/host/core';
import type { Grant } from '../src/shared/permissions';
import type { Action, Item } from '../src/shared/model';
import { disposeCores, gitRepo, makeCore, memoryPermissions, memoryStore, waitFor } from './helpers';

afterEach(disposeCores);

type Permission = Extract<Item, { kind: 'permission' }>;

function fakeHome() {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fl-home-')));
  for (const d of ['Desktop/trip', '.ssh']) mkdirSync(path.join(home, d), { recursive: true });
  writeFileSync(path.join(home, 'Desktop/trip/plan.txt'), 'Delhi to Agra\n');
  return home;
}

function setup(dir: string, stores = { user: memoryStore(), workspace: memoryStore() }, home = fakeHome()) {
  const permissions = memoryPermissions({ ...stores, home });
  const c = makeCore(dir, {
    permissions,
    ui: { showReview: () => {}, closeReview: () => {}, askCommand: () => {}, confirmRule: async () => true },
  });
  return { c, permissions, stores, home };
}

const open = (c: AgentCore, chatId: string) => c.chat(chatId)!.items.find((i): i is Permission => i.kind === 'permission' && !i.answer);
const last = (c: AgentCore, chatId: string) => c.chat(chatId)!.items.filter((i): i is Permission => i.kind === 'permission').at(-1)!;

/** Sends `text`, waits for its permission card and returns it with the turn. */
async function ask(c: AgentCore, chatId: string, text: string) {
  const turn = c.send(chatId, text);
  await waitFor(() => !!open(c, chatId));
  return { card: open(c, chatId)!, turn };
}

describe('remembered folders', () => {
  it('answer the next edit in that folder for the agent, in another chat and agent, and after a restart', async () => {
    const dir = realpathSync(await gitRepo());
    mkdirSync(path.join(dir, 'src'));
    const { c, permissions, stores, home } = setup(dir);
    const chat = await c.createChat('demo');
    const { card, turn } = await ask(c, chat.id, 'native-edit src/a.txt');
    // The file's folder first, then the project.
    expect(card.detail?.always).toEqual([
      { kind: 'folder', folder: path.join(dir, 'src'), access: 'write' },
      { kind: 'folder', folder: dir, access: 'write' },
    ]);
    await c.allowAlways({ requestId: card.requestId }, { kind: 'folder', folder: dir, access: 'write' });
    await turn;
    expect(last(c, chat.id).answer).toBe('Yes');
    expect(permissions.list()).toMatchObject([{ grant: { kind: 'folder', folder: dir, access: 'write' }, agent: 'Demo', scope: 'workspace' }]);

    // Another chat with another agent: the agent's own prompt is answered with its one-time allow.
    const other = await c.createChat('claude');
    await c.send(other.id, 'native-edit src/b.txt');
    expect(last(c, other.id)).toMatchObject({ answer: 'Yes', auto: `Always allowed: ${dir}` });

    // A restart: a new core over the same storage.
    const again = setup(dir, stores, home).c;
    const third = await again.createChat('demo');
    await again.send(third.id, 'native-edit README.md');
    expect(last(again, third.id)).toMatchObject({ answer: 'Yes', auto: `Always allowed: ${dir}` });
  });

  it('read separately from write, outside the workspace too (~/Desktop)', async () => {
    const dir = realpathSync(await gitRepo());
    const { c, home } = setup(dir);
    const chat = await c.createChat('demo');
    const plan = path.join(home, 'Desktop/trip/plan.txt');
    const { card, turn } = await ask(c, chat.id, `native-read ${plan}`);
    expect(card.detail?.always).toEqual([
      { kind: 'folder', folder: path.join(home, 'Desktop/trip'), access: 'read' },
      { kind: 'folder', folder: path.join(home, 'Desktop'), access: 'read' },
    ]);
    await c.allowAlways({ requestId: card.requestId }, { kind: 'folder', folder: path.join(home, 'Desktop'), access: 'read' });
    await turn;
    await c.send(chat.id, `native-read ${path.join(home, 'Desktop/notes.txt')}`);
    expect(last(c, chat.id)).toMatchObject({ answer: 'Yes', auto: `Always allowed: ${path.join(home, 'Desktop')}` });

    // Reading doesn't cover changing.
    const edit = await ask(c, chat.id, `native-edit ${plan}`);
    expect(edit.card.answer).toBeUndefined();
    c.answerPermission(edit.card.requestId, null);
    await edit.turn;
  });

  it('remember only what the card offered, and never a sensitive place', async () => {
    const dir = realpathSync(await gitRepo());
    const { c, permissions, home } = setup(dir);
    const chat = await c.createChat('demo');
    const { card, turn } = await ask(c, chat.id, 'native-edit README.md');
    for (const g of [{ kind: 'folder', folder: '/', access: 'write' }, { kind: 'folder', folder: path.dirname(dir), access: 'write' }, { kind: 'site', origin: 'https://a.example' }] as Grant[]) {
      await c.allowAlways({ requestId: card.requestId }, g);
    }
    expect(permissions.list()).toEqual([]);
    expect(open(c, chat.id)?.requestId).toBe(card.requestId);
    c.answerPermission(card.requestId, null);
    await turn;

    // Git internals and keys: Allow once only.
    for (const target of [path.join(dir, '.git/config'), path.join(home, '.ssh/authorized_keys')]) {
      const sensitive = await ask(c, chat.id, `native-edit ${target}`);
      expect(sensitive.card.detail?.always, target).toBeUndefined();
      await c.allowAlways({ requestId: sensitive.card.requestId }, { kind: 'folder', folder: path.dirname(target), access: 'write' });
      expect(permissions.list()).toEqual([]);
      c.answerPermission(sensitive.card.requestId, null);
      await sensitive.turn;
    }
  });
});

describe('config that runs code or steers agents', () => {
  it('a write to .vscode/settings.json or CLAUDE.md under an always-allowed folder still asks, and offers Allow once only', async () => {
    const dir = realpathSync(await gitRepo());
    const { c, permissions } = setup(dir);
    permissions.add({ kind: 'folder', folder: dir, access: 'write' });
    const chat = await c.createChat('demo');
    for (const target of ['.vscode/settings.json', 'CLAUDE.md']) {
      const { card, turn } = await ask(c, chat.id, `native-edit ${target}`);
      expect(card.answer, target).toBeUndefined();
      expect(card.detail?.always, target).toBeUndefined();
      c.answerPermission(card.requestId, null);
      await turn;
    }
    await c.send(chat.id, 'native-edit src/ok.txt');
    expect(last(c, chat.id)).toMatchObject({ answer: 'Yes', auto: `Always allowed: ${dir}` });
  });
});

describe('remembered websites', () => {
  it('answer the agent’s next fetch on that exact origin, and no other', async () => {
    const dir = await gitRepo();
    const { c, permissions } = setup(dir);
    const chat = await c.createChat('demo');
    const { card, turn } = await ask(c, chat.id, 'native-fetch https://www.irctc.co.in/nget/train-search');
    expect(card.detail?.always).toEqual([{ kind: 'site', origin: 'https://www.irctc.co.in' }]);
    await c.allowAlways({ requestId: card.requestId }, { kind: 'site', origin: 'https://www.irctc.co.in' });
    await turn;
    expect(permissions.site('https://www.irctc.co.in')).toBeDefined();
    await c.send(chat.id, 'native-fetch https://www.irctc.co.in/pnr');
    expect(last(c, chat.id)).toMatchObject({ answer: 'Yes', auto: 'Always allowed: https://www.irctc.co.in' });

    const other = await ask(c, chat.id, 'native-fetch http://www.irctc.co.in/');
    expect(other.card.answer).toBeUndefined();
    c.answerPermission(other.card.requestId, null);
    await other.turn;
  });
});

describe('what stays as it was', () => {
  it('a read-only chat is refused before any rule, and remembers nothing', async () => {
    const dir = realpathSync(await gitRepo());
    const { c, permissions } = setup(dir);
    permissions.add({ kind: 'folder', folder: dir, access: 'write' });
    const chat = await c.createChat('demo', { readOnly: true });
    await c.send(chat.id, 'native-edit README.md');
    expect(c.chat(chat.id)!.items.some((i) => i.kind === 'permission')).toBe(false);
    expect(permissions.list()).toHaveLength(1);
  });
});

describe('writes that come as a review', () => {
  it('a remembered folder accepts an agent write that asked nothing first (Gemini-style), recorded for undo', async () => {
    const dir = realpathSync(await gitRepo());
    const shown: string[] = [];
    const permissions = memoryPermissions();
    const c = makeCore(dir, { permissions, ui: { showReview: (r) => shown.push(r.path), closeReview: () => {}, askCommand: () => {} } });
    const chat = await c.createChat('demo');
    await waitFor(() => c.chat(chat.id)?.session?.live === true);
    // Like Gemini, whose Ask is its Auto Edit mode: the agent writes without asking, FriedLiver's level stays Ask.
    await c.setOption(chat.id, 'mode', 'acceptEdits');
    (c as unknown as { dispatch(a: Action): void }).dispatch({ t: 'approval', chatId: chat.id, level: 'ask' });
    permissions.add({ kind: 'folder', folder: dir, access: 'write' });
    await c.send(chat.id, 'edit README.md');
    expect(shown).toEqual([]);
    expect(c.chat(chat.id)!.items.find((i) => i.kind === 'review')).toMatchObject({ state: 'accepted', auto: `Always allowed: ${dir}` });
    // Without the rule, the same write waits in a diff.
    permissions.revokeAll();
    void c.send(chat.id, 'edit README.md');
    await waitFor(() => shown.length === 1);
  });
});

describe('no folder open', () => {
  it('agents (and their sign-in checks) start in FriedLiver’s own empty folder, not home, so their start-up scan never reaches Desktop or Documents', () => {
    const empty = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fl-no-folder-')));
    const cwd = (c: AgentCore) => (c as unknown as { hub: { options: { cwd: string } } }).hub.options.cwd;
    expect(cwd(makeCore('', { folders: () => [], noFolderCwd: empty }))).toBe(empty);
    expect(cwd(makeCore('/w', { noFolderCwd: empty }))).toBe('/w');
  });
});
