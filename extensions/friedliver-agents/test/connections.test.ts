import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_PIPE_FORWARDS } from '../src/host/connections';
import { chatStatus, lastReply, stateLine, type ChatView, type LinkItem } from '../src/shared/model';
import { disposeCores, gitRepo, makeCore, waitFor } from './helpers';

afterEach(disposeCores);

const links = (chat: ChatView | undefined) => (chat?.items ?? []).filter((i): i is LinkItem => i.kind === 'link');

describe('hand-off', () => {
  it('starts a chat for another agent that gets the transcript with its first message only', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir);
    const a = await core.createChat('demo');
    await core.send(a.id, 'hello there');

    const b = await core.handoff(a.id, 'claude');
    expect(b).toMatchObject({ agent: 'claude', cwd: a.cwd, title: 'hello there', origin: { kind: 'handoff', chatId: a.id, by: 'user' } });
    expect(core.snapshot.links).toEqual([expect.objectContaining({ kind: 'handoff', from: a.id, to: b.id, by: 'user' })]);
    expect(links(core.chat(a.id))).toEqual([expect.objectContaining({ role: 'handoff-to', chatId: b.id, label: 'Claude', text: '2 messages' })]);
    expect(links(core.chat(b.id))).toEqual([expect.objectContaining({ role: 'handoff-from', chatId: a.id, agent: 'demo' })]);
    expect(core.chat(b.id)!.turns).toBe(0);

    await core.send(b.id, 'continue');
    const first = lastReply(core.chat(b.id)!);
    expect(first).toContain('taking over a task from another coding agent, Demo');
    expect(first).toContain('User: hello there');
    expect(first).toContain('Demo: You said: hello there');
    expect(first).toMatch(/continue$/);

    await core.send(b.id, 'again');
    expect(lastReply(core.chat(b.id)!)).toBe('You said: again');
  });

  it('shares the source task worktree', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir);
    const a = await core.createChat('demo', { worktree: true, title: 'Notes' });
    const b = await core.handoff(a.id, 'gemini');
    expect(b.cwd).toBe(a.cwd);
    expect(b.branch).toBe(a.branch);
    await core.removeWorktree(b.id);
    expect(existsSync(a.cwd)).toBe(false);
    expect(core.chat(a.id)!.branch).toBeUndefined();
  });
});

describe('consult', () => {
  it('asks another agent and brings the reply back, reusing the consultation', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir);
    const a = await core.createChat('demo');
    await core.send(a.id, 'first');

    const answer = await core.consult(a.id, 'gemini', 'what next?');
    expect(answer).toContain('Demo, another coding agent working in this folder');
    expect(answer).toMatch(/what next\?$/);
    const c = core.snapshot.chats.find((x) => x.origin?.kind === 'consult')!;
    expect(c).toMatchObject({ agent: 'gemini', depth: 1, cwd: a.cwd, origin: { chatId: a.id, by: 'user' }, title: 'what next?' });
    expect(links(c)[0]).toMatchObject({ role: 'consulted', chatId: a.id, text: 'what next?' });
    expect(links(core.chat(a.id))).toEqual([
      expect.objectContaining({ role: 'asked', chatId: c.id, text: 'what next?', by: 'user' }),
      expect.objectContaining({ role: 'reply', chatId: c.id, text: answer }),
    ]);
    expect(core.snapshot.links).toEqual([expect.objectContaining({ kind: 'consult', from: a.id, to: c.id, count: 2 })]);

    await core.consult(a.id, 'gemini', 'and then?');
    expect(core.snapshot.chats).toHaveLength(2);
    expect(core.chat(c.id)!.turns).toBe(2);
    expect(core.snapshot.links[0].count).toBe(4);
  });

  it('routes a message starting with @gemini to a consultation', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir);
    const a = await core.createChat('demo');
    await core.send(a.id, '@gemini review this');
    const chat = core.chat(a.id)!;
    expect(chat.items.some((i) => i.kind === 'user')).toBe(false);
    expect(links(chat).map((l) => [l.role, l.text])).toEqual([
      ['asked', 'review this'],
      ['reply', expect.stringMatching(/review this$/)],
    ]);
    expect(core.snapshot.chats.map((c) => c.agent)).toEqual(['demo', 'gemini']);
    // The chat is named after its first question, and a later message doesn't rename it.
    expect(chat.title).toBe('review this');
    await core.send(a.id, 'now fix it');
    expect(core.chat(a.id)!.title).toBe('review this');

    // An @-question with an image takes the image along.
    const png = { name: 'shot.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' };
    await core.send(a.id, '@gemini what is this?', [png]);
    expect(links(core.chat(a.id)!).at(-1)).toMatchObject({ role: 'reply', text: expect.stringMatching(/what is this\? \(\+1 image\)$/) });
    expect(core.snapshot.images.map((i) => i.title)).toEqual(['shot.png']);
  });
});

describe('pipes and forwards', () => {
  it('forwards each finished turn, refuses a loop, and holds a forward while the target is busy', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir);
    const a = await core.createChat('demo');
    const b = await core.createChat('gemini');
    const link = core.pipe(a.id, b.id);
    expect(link).toMatchObject({ kind: 'pipe', active: true, count: 0 });
    expect(() => core.pipe(b.id, a.id)).toThrow(/loop/);

    await core.send(a.id, 'ping');
    await waitFor(() => core.chat(b.id)!.turns === 1);
    expect(links(core.chat(b.id))[0]).toMatchObject({ role: 'piped-in', chatId: a.id, text: 'You said: ping', by: 'user' });
    expect(links(core.chat(a.id))[0]).toMatchObject({ role: 'piped-out', chatId: b.id });
    expect(lastReply(core.chat(b.id)!)).toContain('From Demo');
    expect(core.snapshot.links[0].count).toBe(1);

    const busy = core.send(b.id, 'wait');
    await waitFor(() => core.chat(b.id)!.busy);
    await core.send(a.id, 'pong');
    expect(core.chat(b.id)!.items.filter((i) => i.kind === 'link')).toHaveLength(1);
    await core.cancel(b.id);
    await busy;
    await waitFor(() => core.chat(b.id)!.turns === 3);
    expect(lastReply(core.chat(b.id)!)).toContain('You said: pong');

    core.unlink(link.id);
    await core.send(a.id, 'no more');
    expect(core.chat(b.id)!.turns).toBe(3);
  });

  it(`pauses a pipe after ${MAX_PIPE_FORWARDS} forwards`, async () => {
    const dir = await gitRepo();
    const core = makeCore(dir);
    const a = await core.createChat('demo');
    const b = await core.createChat('demo');
    const link = core.pipe(a.id, b.id);
    for (let n = 1; n <= MAX_PIPE_FORWARDS + 1; n++) {
      await core.send(a.id, `m${n}`);
      await waitFor(() => !core.chat(b.id)!.busy);
    }
    expect(core.snapshot.links[0]).toMatchObject({ active: false, count: MAX_PIPE_FORWARDS });
    expect(core.chat(a.id)!.items.some((i) => i.kind === 'notice' && i.text.startsWith('Paused the pipe'))).toBe(true);
    expect(core.pipe(a.id, b.id).id).toBe(link.id);
    expect(core.snapshot.links[0].active).toBe(true);
  });

  it("forwards a chat's last reply into another chat", async () => {
    const dir = await gitRepo();
    const core = makeCore(dir);
    const a = await core.createChat('demo');
    const b = await core.createChat('claude');
    await expect(core.forward(a.id, b.id)).rejects.toThrow(/no reply/);
    await core.send(a.id, 'idea');
    await core.forward(a.id, b.id);
    expect(links(core.chat(b.id))[0]).toMatchObject({ role: 'piped-in', text: 'You said: idea', by: 'user' });
    expect(lastReply(core.chat(b.id)!)).toContain('You said: idea');
  });
});

describe('fan-out', () => {
  it('runs one task on several agents, each in its own worktree', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir);
    const { group, chats, done } = await core.fanout(['demo', 'claude', 'gemini'], 'hello all', true);
    expect(chats.map((c) => c.agent)).toEqual(['demo', 'claude', 'gemini']);
    expect(new Set(chats.map((c) => c.group))).toEqual(new Set([group]));
    expect(new Set(chats.map((c) => c.cwd)).size).toBe(3);
    expect(new Set(chats.map((c) => c.branch)).size).toBe(3);
    for (const c of chats) expect(existsSync(c.cwd) && c.cwd !== dir).toBe(true);
    await done;
    for (const c of chats) expect(lastReply(core.chat(c.id)!)).toBe('You said: hello all');
  });

  it('shares a folder that is not a git repository, and says so', async () => {
    const plain = await mkdtemp(path.join(os.tmpdir(), 'fl-plain-'));
    const core = makeCore(plain);
    const { chats, done } = await core.fanout(['demo', 'gemini'], 'hi', true);
    expect(chats.map((c) => c.cwd)).toEqual([plain, plain]);
    for (const c of chats) expect(core.chat(c.id)!.items[0]).toMatchObject({ kind: 'notice', text: expect.stringContaining("isn't a git repository") });
    await done;
  });
});

describe('chat housekeeping', () => {
  it('stops a turn when Stop comes while the agent is still starting', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir);
    const a = await core.createChat('gemini');
    for (const delay of [0, 5]) {
      // 0: Stop before the turn reaches the hub; 5 ms: while the hub starts the agent process.
      const turn = core.send(a.id, 'wait');
      await new Promise((r) => setTimeout(r, delay));
      await core.cancel(a.id);
      await turn;
      expect(core.chat(a.id)!.items.at(-1)).toMatchObject({ kind: 'notice', text: 'Stopped (cancelled).' });
    }
    await core.send(a.id, 'after');
    expect(lastReply(core.chat(a.id)!)).toBe('You said: after');
  });

  it('records touched files, archives, and removes a chat with its links', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir, {
      ui: {
        showReview: (r) => setTimeout(() => core.decideReview(r.reviewId, true), 5),
        closeReview: () => {},
        askPermission: (a) => setTimeout(() => core.answerPermission(a.requestId, 'allow'), 5),
      },
    });
    const a = await core.createChat('demo');
    const file = path.join(dir, 'src', 'new.txt');
    await core.send(a.id, `edit ${file}`);
    expect(core.chat(a.id)!.files).toEqual(['src/new.txt']);
    expect(core.touchedFiles(a.id)).toEqual([file]);
    expect(core.beforeChat(a.id, file)).toBeNull();

    core.archive(a.id, true);
    expect(core.chat(a.id)!.archived).toBe(true);
    const b = await core.createChat('demo');
    core.pipe(a.id, b.id);
    await core.removeChat(a.id);
    expect(core.chat(a.id)).toBeUndefined();
    expect(core.snapshot.links).toEqual([]);
  });
});

describe('connected chats on the board', () => {
  it('reads a consulted chat as done, and a waiting tool request as needing you', () => {
    const base: ChatView = { id: 'chat-2', agent: 'gemini', label: 'Gemini', title: 'Q', cwd: '/w', createdAt: 0, busy: false, changedFiles: 0, items: [], depth: 1, files: [], lastActivity: 0, turns: 1 };
    expect(chatStatus(base)).toBe('done');
    const given = (role: LinkItem['role']): ChatView => ({
      ...base,
      turns: 0,
      items: [{ kind: 'link', linkId: 'link-1', role, chatId: 'chat-1', agent: 'demo', label: 'Demo', text: 'x', by: 'user' }],
    });
    for (const role of ['consulted', 'piped-in', 'handoff-from'] as const) {
      expect(chatStatus(given(role))).toBe('done');
      expect(stateLine(given(role)).text).toBe('Done');
    }
    expect(chatStatus(given('asked'))).toBe('idle');
    expect(chatStatus({ ...base, turns: 0 })).toBe('idle');
    const asking: ChatView = {
      ...base,
      items: [{ kind: 'bridge', requestId: 'bridge-1', tool: 'ask_agent', target: { agent: 'claude' }, text: 'hi', state: 'awaiting' }],
    };
    expect(stateLine(asking)).toMatchObject({ text: 'Gemini wants to ask Claude', decision: { kind: 'bridge', id: 'bridge-1' } });
  });
});
