// What FriedLiver Remote may do through the core: the same calls as the
// desktop, except that anything that keeps allowing (Auto, "Always allow")
// waits for the user's OK on the Mac.
import { realpathSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentCore, CoreUi } from '../src/host/core';
import type { Item } from '../src/shared/model';
import { disposeCores, gitRepo, makeCore, memoryPermissions, waitFor } from './helpers';

afterEach(disposeCores);

type Permission = Extract<Item, { kind: 'permission' }>;
const open = (c: AgentCore, chatId: string) => c.chat(chatId)!.items.find((i): i is Permission => i.kind === 'permission' && !i.answer);

function setup(dir: string, remoteAnswer: boolean | undefined) {
  const asked = { remote: [] as string[], desktopFull: 0, desktopRule: 0 };
  const permissions = memoryPermissions();
  const ui: Partial<CoreUi> = {
    confirmFullAuto: async () => (asked.desktopFull++, true),
    confirmRule: async () => (asked.desktopRule++, true),
    ...(remoteAnswer === undefined ? {} : { confirmRemote: async (a: { title: string }) => (asked.remote.push(a.title), remoteAnswer) }),
  };
  const c = makeCore(dir, { permissions, ui: { showReview: () => {}, closeReview: () => {}, askCommand: () => {}, ...ui } });
  return { c, asked, permissions };
}

describe('Auto from the phone', () => {
  it('needs the OK on the Mac every time, even for a chat the desktop already confirmed', async () => {
    const dir = await gitRepo();
    const { c, asked } = setup(dir, false);
    const chat = await c.createChat('demo');
    await c.setApproval(chat.id, 'full', 'remote');
    expect(c.chat(chat.id)!.approval).toBeUndefined();
    expect(asked.remote).toEqual(['Run Demo in Auto? Your phone asks.']);
    expect(asked.desktopFull).toBe(0);

    await c.setApproval(chat.id, 'full');
    expect(c.chat(chat.id)!.approval).toBe('full');
    await c.setApproval(chat.id, 'ask', 'remote');
    expect(c.chat(chat.id)!.approval ?? 'ask').toBe('ask');
    await c.setApproval(chat.id, 'full', 'remote');
    expect(asked.remote).toHaveLength(2);
    expect(c.chat(chat.id)!.approval ?? 'ask').toBe('ask');
  });

  it('is refused when the editor has no way to ask', async () => {
    const dir = await gitRepo();
    const { c } = setup(dir, undefined);
    const chat = await c.createChat('demo');
    await c.setApproval(chat.id, 'full', 'remote');
    expect(c.chat(chat.id)!.approval).toBeUndefined();
  });

  it('happens once the Mac says yes; lower levels need no OK', async () => {
    const dir = await gitRepo();
    const { c, asked } = setup(dir, true);
    const chat = await c.createChat('demo');
    await c.setApproval(chat.id, 'edits', 'remote');
    expect(asked.remote).toEqual([]);
    expect(c.chat(chat.id)!.approval).toBe('edits');
    await c.setApproval(chat.id, 'full', 'remote');
    expect(c.chat(chat.id)!.approval).toBe('full');
  });
});

describe('"Always allow" from the phone', () => {
  it('asks on the Mac, not the desktop rule dialog, and a no leaves the request waiting', async () => {
    const dir = await gitRepo();
    const { c, asked, permissions } = setup(dir, false);
    const chat = await c.createChat('demo');
    const turn = c.send(chat.id, 'native-run');
    await waitFor(() => !!open(c, chat.id));
    const p = open(c, chat.id)!;
    await c.allowAlways({ requestId: p.requestId }, { kind: 'exact', command: 'node --version' }, 'remote');
    expect(asked.remote).toEqual(['Always allow node --version? Your phone asks.']);
    expect(asked.desktopRule).toBe(0);
    expect(permissions.commands()).toEqual([]);
    expect(open(c, chat.id)?.requestId).toBe(p.requestId);
    c.answerPermission(p.requestId, null);
    await turn;
  });

  it('remembers a folder only after the OK, and only one the card offered', async () => {
    const dir = realpathSync(await gitRepo());
    const { c, asked, permissions } = setup(dir, true);
    const chat = await c.createChat('demo');
    const turn = c.send(chat.id, 'native-edit README.md');
    await waitFor(() => !!open(c, chat.id));
    const p = open(c, chat.id)!;
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'fl-other-'));
    await c.allowAlways({ requestId: p.requestId }, { kind: 'folder', folder: elsewhere, access: 'write' }, 'remote');
    expect(asked.remote).toEqual([]);
    await c.allowAlways({ requestId: p.requestId }, { kind: 'folder', folder: dir, access: 'write' }, 'remote');
    expect(asked.remote).toEqual([`Always allow changing files in ${dir}? Your phone asks.`]);
    await turn;
    expect(permissions.list()).toMatchObject([{ grant: { kind: 'folder', folder: dir } }]);
  });
});

describe('new chats from the phone', () => {
  it('start in a workspace folder the phone picks, and only in one', async () => {
    const a = await gitRepo();
    const b = await gitRepo();
    const c = makeCore(a, { folders: () => [a, b] });
    expect((await c.createChat('demo', { cwd: b })).cwd).toBe(b);
    expect((await c.createChat('demo', { cwd: os.homedir() })).cwd).toBe(a);
  });
});
