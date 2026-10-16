import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentCore, type CoreUi, type PendingReview } from '../src/host/core';
import type { CommandItem } from '../src/shared/model';

const DEMO_AGENT = path.resolve(__dirname, '../../../../test/fixtures/fakeAgent.mjs');

let core: AgentCore | undefined;
afterEach(async () => {
  await core?.dispose();
  core = undefined;
});

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fl-ext-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await writeFile(path.join(dir, 'README.md'), '# test\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

/** A core whose UI accepts every review and approves every command, recording what it saw. */
function makeCore(folder: string, ui: Partial<CoreUi> = {}) {
  const seen = { reviews: [] as PendingReview[], commands: [] as string[], closed: [] as string[] };
  const c: AgentCore = new AgentCore({
    folders: () => [folder],
    clientVersion: 'test',
    demoAgentScript: DEMO_AGENT,
    agentCommand: () => ({ command: '', args: [] }),
    apiKey: () => undefined,
    limits: () => ({ maxRunning: 2, idleStopMinutes: 0 }),
    ui: {
      showReview: (r) => {
        seen.reviews.push(r);
        setTimeout(() => c.decideReview(r.reviewId, true), 10);
      },
      closeReview: (id) => seen.closed.push(id),
      askCommand: (a) => {
        seen.commands.push(a.commandLine);
        setTimeout(() => c.decideCommand(a.commandId, true), 10);
      },
      ...ui,
    },
  });
  core = c;
  return { core: c, seen };
}

describe('AgentCore with the demo agent', () => {
  it('runs the tour: reviewed edit, approved command, image, then undo', async () => {
    const dir = await gitRepo();
    const { core, seen } = makeCore(dir);
    const chat = await core.createChat('demo');

    await core.send(chat.id, 'tour');

    const notes = path.join(dir, 'NOTES.md');
    expect(await readFile(notes, 'utf8')).toContain('FriedLiver demo agent was here.');
    expect(seen.reviews.map((r) => r.path)).toEqual([notes]);
    expect(seen.reviews[0].before).toBeNull();
    expect(seen.closed).toHaveLength(1);

    const items = core.chat(chat.id)!.items;
    const review = items.find((i) => i.kind === 'review');
    expect(review).toMatchObject({ state: 'accepted', isNew: true, added: 3, removed: 0 });
    const command = items.find((i): i is CommandItem => i.kind === 'command');
    expect(command).toMatchObject({ state: 'exited', exitCode: 0 });
    expect(command!.output).toContain('hello from terminal');
    expect(command!.durationMs).toBeGreaterThanOrEqual(0);
    expect(items.some((i) => i.kind === 'plan')).toBe(true);
    expect(core.snapshot.images.map((i) => i.from)).toEqual(['agent']);
    expect(core.decisions()).toEqual([]);

    const changes = items.find((i) => i.kind === 'changes');
    expect(changes).toMatchObject({ files: [notes] });
    const restored = await core.undo(chat.id, changes!.kind === 'changes' ? changes!.turnId : '');
    expect(restored).toEqual([notes]);
    expect(existsSync(notes)).toBe(false);
    expect(core.chat(chat.id)!.items.find((i) => i.kind === 'changes')).toMatchObject({ undone: true });
  });

  it('holds writes and commands until the user decides, and lists them as decisions', async () => {
    const dir = await gitRepo();
    const { core } = makeCore(dir, { showReview: () => {}, askCommand: () => {} });
    const chat = await core.createChat('demo');
    const turn = core.send(chat.id, 'tour');

    await waitFor(() => core.decisions().length === 1);
    expect(core.decisions()[0]).toMatchObject({ kind: 'review', chatId: chat.id });
    expect(existsSync(path.join(dir, 'NOTES.md'))).toBe(false);
    core.decideReview(core.decisions()[0].id, true, '# Edited by the user\n');

    await waitFor(() => core.decisions()[0]?.kind === 'command');
    const commandId = core.decisions()[0].id;
    core.decideCommand(commandId, false);
    await turn;

    expect(await readFile(path.join(dir, 'NOTES.md'), 'utf8')).toBe('# Edited by the user\n');
    const command = core.chat(chat.id)!.items.find((i) => i.kind === 'command');
    expect(command).toMatchObject({ state: 'denied' });
    expect(core.chat(chat.id)!.items.some((i) => i.kind === 'agent' && i.text.includes('You denied the command'))).toBe(true);
  });

  it('refuses writes outside the workspace', async () => {
    const dir = await gitRepo();
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'fl-outside-'));
    const target = path.join(elsewhere, 'a.txt');
    const { core, seen } = makeCore(dir);
    const chat = await core.createChat('demo');
    const turn = core.send(chat.id, `edit ${target}`);
    await waitFor(() => core.decisions().length === 1);
    expect(core.decisions()[0].kind).toBe('permission');
    core.answerPermission(core.decisions()[0].id, 'allow');
    await turn;

    expect(existsSync(target)).toBe(false);
    expect(seen.reviews).toHaveLength(0);
    expect(core.chat(chat.id)!.items.at(-1)).toMatchObject({ kind: 'notice', tone: 'error' });
  });

  it('runs a task in its own worktree and merges it into main', async () => {
    const dir = await gitRepo();
    const { core } = makeCore(dir);
    const chat = await core.createChat('demo', { worktree: true, title: 'Add notes' });
    expect(chat.branch).toMatch(/^friedliver\/add-notes-/);
    expect(chat.cwd).not.toBe(dir);

    await core.send(chat.id, 'tour');
    expect(existsSync(path.join(chat.cwd, 'NOTES.md'))).toBe(true);
    expect(existsSync(path.join(dir, 'NOTES.md'))).toBe(false);

    await core.merge(chat.id);
    expect(existsSync(path.join(dir, 'NOTES.md'))).toBe(true);
    expect(core.chat(chat.id)!.merged).toBe(true);

    await core.removeWorktree(chat.id);
    expect(existsSync(chat.cwd)).toBe(false);
    expect(core.chat(chat.id)!.branch).toBeUndefined();
  });

  it('passes an API key only to its own agent', () => {
    const c = new AgentCore({
      folders: () => [],
      clientVersion: 'test',
      demoAgentScript: DEMO_AGENT,
      agentCommand: (id) => ({ command: id === 'codex' ? 'my-codex' : '', args: [] }),
      apiKey: (id) => (id === 'claude' ? 'sk-test' : undefined),
      limits: () => ({ maxRunning: 2, idleStopMinutes: 10 }),
      ui: { showReview: () => {}, closeReview: () => {} },
    });
    core = c;
    expect(c.spec('claude').env).toEqual({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(c.spec('gemini').env).toEqual({});
    expect(c.spec('gemini').command).toBe('gemini');
    expect(c.spec('codex').command).toBe('my-codex');
  });
});

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}
