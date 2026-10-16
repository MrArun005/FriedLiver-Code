import { execFileSync } from 'node:child_process';
import { existsSync, symlinkSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentCore, type CoreUi, type PendingReview } from '../src/host/core';
import type { CommandItem } from '../src/shared/model';

const DEMO_AGENT = path.resolve(__dirname, '../../../agent-core/demo/fakeAgent.mjs');

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

  it('works like a busy agent on "busy <seconds>": streamed markdown, tool calls, a plan and file reads, nothing to decide', async () => {
    const dir = await gitRepo();
    const reads: string[] = [];
    const { core } = makeCore(dir, { unsavedText: (f) => void reads.push(f) });
    const chat = await core.createChat('demo');
    let actions = 0;
    core.onAction(() => actions++);
    await core.send(chat.id, 'busy 3 stamp');

    const items = core.chat(chat.id)!.items;
    const text = items.flatMap((i) => (i.kind === 'agent' ? [i.text] : [])).join('');
    expect(text).toContain('### Part 1');
    expect(text).toMatch(/`t=\d{13}`/);
    expect(text).toMatch(/Done after 3 s: 1 tool calls, 1 files read\.$/);
    expect(items.filter((i) => i.kind === 'tool')).toEqual([expect.objectContaining({ title: 'Read package.json', toolKind: 'read', status: 'completed' })]);
    const plan = items.find((i) => i.kind === 'plan');
    expect(plan?.kind === 'plan' && plan.entries.map((e) => e.status)).toEqual(Array(6).fill('completed'));
    expect(reads).toEqual([path.join(dir, 'package.json')]);
    expect(actions).toBeGreaterThan(12);
    expect(core.decisions()).toEqual([]);

    // Long enough for a code block; and Stop ends it at once.
    const long = await core.createChat('demo');
    const turn = core.send(long.id, 'busy 60');
    await new Promise((r) => setTimeout(r, 9500));
    await core.cancel(long.id);
    await turn;
    const after = core.chat(long.id)!.items;
    expect(after.flatMap((i) => (i.kind === 'agent' ? [i.text] : [])).join('')).toContain('```ts\nexport function formatCents');
    expect(after.at(-1)).toMatchObject({ kind: 'notice', text: 'Stopped (cancelled).' });
  }, 30_000);

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

describe('AgentCore against hostile repositories and agents', () => {
  /** A repo with `link` pointing at a folder outside it that holds secret.txt; null where links can't be made. */
  async function repoWithLinkOut(): Promise<{ dir: string; outside: string } | null> {
    const dir = await gitRepo();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'fl-outside-'));
    await writeFile(path.join(outside, 'secret.txt'), 'secret\n');
    try {
      symlinkSync(outside, path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : undefined);
    } catch {
      return null;
    }
    return { dir, outside };
  }

  it('neither reads nor writes through a symlink that leads out of the workspace', async (ctx) => {
    const repo = await repoWithLinkOut();
    if (!repo) return ctx.skip();
    try {
      symlinkSync(path.join(repo.outside, 'secret.txt'), path.join(repo.dir, 'NOTES.md'));
    } catch {
      return ctx.skip();
    }
    const { core, seen } = makeCore(repo.dir);
    const chat = await core.createChat('demo');
    // The tour reads NOTES.md, then proposes to write it.
    await core.send(chat.id, 'tour');
    expect(seen.reviews).toHaveLength(0);
    expect(await readFile(path.join(repo.outside, 'secret.txt'), 'utf8')).toBe('secret\n');
    expect(core.chat(chat.id)!.items.some((i) => i.kind === 'agent' && i.text.includes('nothing was written'))).toBe(true);
  });

  it('refuses a new file under a linked folder', async (ctx) => {
    const repo = await repoWithLinkOut();
    if (!repo) return ctx.skip();
    const { core, seen } = makeCore(repo.dir);
    const chat = await core.createChat('demo');
    const turn = core.send(chat.id, `edit ${path.join(repo.dir, 'link', 'planted.txt')}`);
    await waitFor(() => core.decisions().length === 1);
    core.answerPermission(core.decisions()[0].id, 'allow');
    await turn;
    expect(seen.reviews).toHaveLength(0);
    expect(existsSync(path.join(repo.outside, 'planted.txt'))).toBe(false);
  });

  it('refuses writes into .git, where config and hooks run programs', async () => {
    const dir = await gitRepo();
    const { core, seen } = makeCore(dir);
    const chat = await core.createChat('demo');
    const before = await readFile(path.join(dir, '.git', 'config'), 'utf8');
    const turn = core.send(chat.id, `edit ${path.join(dir, '.git', 'config')}`);
    await waitFor(() => core.decisions().length === 1);
    core.answerPermission(core.decisions()[0].id, 'allow');
    await turn;
    expect(seen.reviews).toHaveLength(0);
    expect(await readFile(path.join(dir, '.git', 'config'), 'utf8')).toBe(before);
  });

  it('ignores an answer the agent did not offer', async () => {
    const dir = await gitRepo();
    const { core } = makeCore(dir);
    const chat = await core.createChat('demo');
    const turn = core.send(chat.id, `edit ${path.join(dir, 'x.txt')}`);
    await waitFor(() => core.decisions().length === 1);
    const { id } = core.decisions()[0];
    core.answerPermission(id, 'allow_always_everything');
    expect(core.decisions().map((d) => d.id)).toEqual([id]);
    core.answerPermission(id, 'reject');
    await turn;
    expect(existsSync(path.join(dir, 'x.txt'))).toBe(false);
  });

  it('names the agent, not a command, in the install action', async () => {
    const dir = await gitRepo();
    const c = new AgentCore({
      folders: () => [dir],
      clientVersion: 'test',
      demoAgentScript: DEMO_AGENT,
      agentCommand: () => ({ command: 'fl-agent-that-is-not-installed', args: [] }),
      apiKey: () => undefined,
      limits: () => ({ maxRunning: 2, idleStopMinutes: 0 }),
      ui: { showReview: () => {}, closeReview: () => {} },
    });
    core = c;
    const chat = await c.createChat('claude');
    await c.send(chat.id, 'hi');
    const notice = c.chat(chat.id)!.items.at(-1);
    expect(notice).toMatchObject({ kind: 'notice', tone: 'error' });
    const install = notice?.kind === 'notice' ? notice.actions?.find((a) => a.do === 'install') : undefined;
    expect(install).toEqual({ label: 'Install in terminal', do: 'install', agent: 'claude' });
  });

  it('keeps two agents that pick the same session ID apart', async () => {
    const dir = await gitRepo();
    // "Claude" here is a second copy of the demo agent: both name their first session fake-session-1.
    const c = new AgentCore({
      folders: () => [dir],
      clientVersion: 'test',
      demoAgentScript: DEMO_AGENT,
      agentCommand: () => ({ command: process.execPath, args: [DEMO_AGENT] }),
      apiKey: () => undefined,
      limits: () => ({ maxRunning: 2, idleStopMinutes: 0 }),
      ui: { showReview: () => {}, closeReview: () => {} },
    });
    core = c;
    const a = await c.createChat('claude');
    const b = await c.createChat('demo');
    await c.send(a.id, 'first');
    await c.send(b.id, 'second');
    await c.send(a.id, 'third');
    const replies = (id: string) => c.chat(id)!.items.flatMap((i) => (i.kind === 'agent' ? [i.text] : []));
    expect(replies(a.id).join(' ')).toContain('first');
    expect(replies(a.id).join(' ')).toContain('third');
    expect(replies(a.id).join(' ')).not.toContain('second');
    expect(replies(b.id).join(' ')).toContain('second');
    expect(replies(b.id).join(' ')).not.toMatch(/first|third/);
  });
});
