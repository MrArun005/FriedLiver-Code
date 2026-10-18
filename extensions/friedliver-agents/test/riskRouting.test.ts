// The host keeps careful requests one at a time whatever a view sends (no "don't ask again", no
// Always allow, no remembered rule, no notification Allow), lists what a force push would drop, and
// counts routine requests down only when the user turned that on, with Stop.
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { remoteOnlyCommits } from '@friedliver/main/workspace/git';
import type { Item } from '../src/shared/model';
import { disposeCores, gitRepo, makeCore, memoryPermissions, waitFor } from './helpers';

afterEach(disposeCores);

const perm = (core: ReturnType<typeof makeCore>, chatId: string) =>
  core.chat(chatId)!.items.find((i): i is Extract<Item, { kind: 'permission' }> => i.kind === 'permission');

describe('careful requests stay one at a time', () => {
  it('refuses the agent’s own “don’t ask again” and Always allow for a careful command; a plain yes works', async () => {
    const dir = await gitRepo();
    const permissions = memoryPermissions();
    const asked: { allow?: unknown }[] = [];
    const core = makeCore(dir, { permissions, ui: { showReview: () => {}, closeReview: () => {}, askPermission: (a) => void asked.push(a), confirmRule: async () => true } });
    const chat = await core.createChat('demo');
    const turn = core.send(chat.id, `native-perm execute ${JSON.stringify({ command: 'rm -rf build' })}`);
    await waitFor(() => core.decisions().length === 1);
    const p = perm(core, chat.id)!;
    // No Allow button on its notification: it is allowed by holding on its card.
    expect(asked[0]).not.toHaveProperty('allow');
    core.answerPermission(p.requestId, 'always');
    await core.allowAlways({ requestId: p.requestId }, { kind: 'exact', command: 'rm -rf build' });
    expect(core.decisions()).toHaveLength(1);
    expect(permissions.list()).toEqual([]);
    core.answerPermission(p.requestId, 'allow');
    await turn;
    expect(perm(core, chat.id)?.answer).toBe('Yes');
  });

  it('a remembered rule never answers a careful command', async () => {
    const dir = await gitRepo();
    const permissions = memoryPermissions();
    expect(permissions.add({ kind: 'prefix', command: 'git push' })).toBe(true);
    const core = makeCore(dir, { permissions });
    const chat = await core.createChat('demo');
    const turn = core.send(chat.id, `native-perm execute ${JSON.stringify({ command: 'git push --force origin main' })}`);
    await waitFor(() => core.decisions().length === 1);
    expect(perm(core, chat.id)?.auto).toBeUndefined();
    core.answerPermission(perm(core, chat.id)!.requestId, 'reject');
    await turn;
    // The same rule still answers an ordinary push.
    const again = core.send(chat.id, `native-perm execute ${JSON.stringify({ command: 'git push origin main' })}`);
    await again;
    expect(core.chat(chat.id)!.items.filter((i) => i.kind === 'permission').at(-1)).toMatchObject({ auto: 'Always allowed: git push …' });
  });
});

describe('a force push lists what it would drop', () => {
  it('the remote-only commits, newest first, as of the last fetch', async () => {
    const remote = await mkdtemp(path.join(os.tmpdir(), 'fl-remote-'));
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: remote });
    const dir = await gitRepo();
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', 'origin', 'main');
    // Someone else pushes two commits; we fetch them, then go our own way.
    const other = await mkdtemp(path.join(os.tmpdir(), 'fl-other-'));
    git(other, 'clone', '-q', remote, '.');
    git(other, 'config', 'user.email', 'p@example.com');
    git(other, 'config', 'user.name', 'Priya');
    for (const msg of ['fix(reports): CSV escaping', 'feat(checkout): order note']) {
      await writeFile(path.join(other, `${msg.length}.txt`), msg);
      git(other, 'add', '.');
      git(other, 'commit', '-qm', msg);
    }
    git(other, 'push', '-q', 'origin', 'main');
    git(dir, 'fetch', '-q', 'origin');
    await writeFile(path.join(dir, 'mine.txt'), 'x');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'mine');
    const dropped = await remoteOnlyCommits(dir, 'origin', undefined);
    expect(dropped?.ref).toBe('origin/main');
    expect(dropped?.commits.map((c) => [c.subject, c.author])).toEqual([
      ['feat(checkout): order note', 'Priya'],
      ['fix(reports): CSV escaping', 'Priya'],
    ]);
    expect(dropped?.more).toBe(0);
    // Odd names are never passed to git, and a branch with no tracking ref gives nothing.
    expect(await remoteOnlyCommits(dir, '--upload-pack=x', 'main')).toBeNull();
    expect(await remoteOnlyCommits(dir, 'origin', 'nope')).toBeNull();
  });
});

describe('routine countdown', () => {
  it('is off unless set; when set, a routine request allows itself once after the countdown', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir, { autoRoutineSeconds: () => 0.05 });
    const chat = await core.createChat('demo');
    await core.send(chat.id, 'native-run');
    expect(perm(core, chat.id)).toMatchObject({ answer: 'Yes', auto: 'Routine, allowed after the countdown' });
  });

  it('counts down only the exact allowlist: a routine-looking command with any extra word waits', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir, { autoRoutineSeconds: () => 0.05 });
    const chat = await core.createChat('demo');
    for (const command of ['ls -la', 'npm test; rm -rf ~', 'git -c core.pager=sh log']) {
      const turn = core.send(chat.id, `native-perm execute ${JSON.stringify({ command })}`);
      await waitFor(() => core.decisions().length === 1);
      const p = core.chat(chat.id)!.items.filter((i): i is Extract<Item, { kind: 'permission' }> => i.kind === 'permission').at(-1)!;
      expect(p.autoAt, command).toBeUndefined();
      await new Promise((r) => setTimeout(r, 100));
      expect(core.decisions(), command).toHaveLength(1);
      core.answerPermission(p.requestId, 'reject');
      await turn;
    }
  });

  it('never counts down a request outside the workspace: a command’s folder or a read’s file', async () => {
    const dir = await gitRepo();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'fl-outside-'));
    await writeFile(path.join(outside, 'notes.txt'), 'x');
    const core = makeCore(dir, { autoRoutineSeconds: () => 0.05 });
    const chat = await core.createChat('demo');
    for (const [kind, input] of [
      ['execute', { command: 'git status', cwd: outside }],
      ['read', { file_path: path.join(outside, 'notes.txt'), locations: [path.join(outside, 'notes.txt')] }],
    ] as const) {
      const turn = core.send(chat.id, `native-perm ${kind} ${JSON.stringify(input)}`);
      await waitFor(() => core.decisions().length === 1);
      const p = core.chat(chat.id)!.items.filter((i): i is Extract<Item, { kind: 'permission' }> => i.kind === 'permission').at(-1)!;
      expect(p.autoAt, kind).toBeUndefined();
      await new Promise((r) => setTimeout(r, 100));
      expect(core.decisions(), kind).toHaveLength(1);
      core.answerPermission(p.requestId, 'reject');
      await turn;
    }
    // The same read inside the workspace does count down.
    await writeFile(path.join(dir, 'inside.txt'), 'x');
    await core.send(chat.id, `native-perm read ${JSON.stringify({ file_path: path.join(dir, 'inside.txt'), locations: [path.join(dir, 'inside.txt')] })}`);
    expect(core.chat(chat.id)!.items.filter((i) => i.kind === 'permission').at(-1)).toMatchObject({ auto: 'Routine, allowed after the countdown' });
  });

  it('never counts down a review or careful request', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir, { autoRoutineSeconds: () => 0.05 });
    const chat = await core.createChat('demo');
    const turn = core.send(chat.id, `native-perm execute ${JSON.stringify({ command: 'npm install left-pad' })}`);
    await waitFor(() => core.decisions().length === 1);
    expect(perm(core, chat.id)?.autoAt).toBeUndefined();
    await new Promise((r) => setTimeout(r, 120));
    expect(core.decisions()).toHaveLength(1);
    core.answerPermission(perm(core, chat.id)!.requestId, 'reject');
    await turn;
  });

  it('Stop ends it: the request waits like any other', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir, { autoRoutineSeconds: () => 1 });
    const chat = await core.createChat('demo');
    const turn = core.send(chat.id, 'native-run');
    await waitFor(() => core.decisions().length === 1);
    const p = perm(core, chat.id)!;
    expect(p.autoAt).toBeGreaterThan(Date.now());
    core.stopAuto(p.requestId);
    expect(perm(core, chat.id)?.autoAt).toBeUndefined();
    await new Promise((r) => setTimeout(r, 1100));
    expect(core.decisions()).toHaveLength(1);
    core.answerPermission(p.requestId, 'reject');
    await turn;
  });

  it('without the setting, nothing counts down', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir);
    const chat = await core.createChat('demo');
    const turn = core.send(chat.id, 'native-run');
    await waitFor(() => core.decisions().length === 1);
    expect(perm(core, chat.id)?.autoAt).toBeUndefined();
    core.answerPermission(perm(core, chat.id)!.requestId, 'allow');
    await turn;
  });
});
