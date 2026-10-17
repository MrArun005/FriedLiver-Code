// The session controls, approvals and checkpoints, end to end with the Demo
// agent: what each agent advertises, choices applied and remembered, the
// permission card as the review, auto-approve levels and rules, undo for edits
// an agent makes itself, and messages queued while it works.
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoreOptions, CoreUi } from '../src/host/core';
import type { AgentDefaults } from '../src/shared/session';
import { lastReply, type AgentKey, type Item } from '../src/shared/model';
import { disposeCores, gitRepo, makeCore, memoryPermissions, waitFor } from './helpers';

afterEach(disposeCores);

type Permission = Extract<Item, { kind: 'permission' }>;

function memoryDefaults(): NonNullable<CoreOptions['defaults']> & { all: Partial<Record<AgentKey, AgentDefaults>> } {
  const all: Partial<Record<AgentKey, AgentDefaults>> = {};
  return { all, get: (a) => all[a], set: (a, v) => (all[a] = v) };
}


/** A core whose UI records what it was asked and decides nothing by itself. */
function core(folder: string, over: Partial<CoreOptions> = {}, ui: Partial<CoreUi> = {}) {
  const seen = { reviews: [] as string[], commands: [] as string[], proposals: [] as { path: string; after: string }[], ended: [] as string[], confirms: 0 };
  const c = makeCore(folder, {
    ...over,
    ui: {
      showReview: (r) => seen.reviews.push(r.path),
      closeReview: () => {},
      askCommand: (a) => seen.commands.push(a.commandLine),
      showProposal: (p) => seen.proposals.push({ path: p.path, after: p.after }),
      turnEnded: (t) => seen.ended.push(`${t.label}:${t.stopReason}:${t.files}`),
      confirmFullAuto: async () => {
        seen.confirms++;
        return true;
      },
      confirmRule: async () => true,
      ...ui,
    },
  });
  return { core: c, seen };
}

const live = (c: ReturnType<typeof core>['core'], chatId: string) => c.chat(chatId)?.session?.live === true;
const option = (c: ReturnType<typeof core>['core'], chatId: string, id: string) => c.chat(chatId)?.session?.options.find((o) => o.id === id);
const permission = (c: ReturnType<typeof core>['core'], chatId: string) => c.chat(chatId)!.items.find((i): i is Permission => i.kind === 'permission' && !i.answer);

describe('what the agent advertises', () => {
  it('starts the session when the chat is created, with no model turn, and keeps its options, commands and usage', async () => {
    const dir = await gitRepo();
    const { core: c } = core(dir);
    const chat = await c.createChat('demo');
    await waitFor(() => live(c, chat.id) && (c.chat(chat.id)!.session!.commands.length ?? 0) > 0);
    const s = c.chat(chat.id)!.session!;
    expect(s.options.map((o) => [o.id, o.category, o.type])).toEqual([
      ['mode', 'mode', 'select'],
      ['model', 'model', 'select'],
      ['effort', 'thought_level', 'select'],
      // FriedLiver takes boolean options, so Fast mode is a toggle.
      ['fast', 'model_config', 'boolean'],
    ]);
    expect(s.options[1].choices.map((x) => x.group)).toEqual(['Thorough', 'Quick']);
    expect(s.commands.map((x) => x.name)).toEqual(['help', 'compact', 'review']);
    expect(s.steering).toBe(true);
    expect(c.chat(chat.id)!.turns).toBe(0);

    await c.send(chat.id, 'hi');
    expect(c.chat(chat.id)!.session!.usage).toMatchObject({ size: 200_000 });
    expect(c.chat(chat.id)!.session!.usage!.used).toBeGreaterThan(0);
  });

  it('sets the model and effort, and the effort levels follow the model', async () => {
    const dir = await gitRepo();
    const { core: c } = core(dir);
    const chat = await c.createChat('demo');
    await waitFor(() => live(c, chat.id));
    expect(option(c, chat.id, 'effort')!.choices.map((x) => x.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    await c.setOption(chat.id, 'effort', 'max');
    await c.setOption(chat.id, 'model', 'demo-small');
    expect(option(c, chat.id, 'effort')!.choices.map((x) => x.value)).toEqual(['low', 'medium']);
    expect(option(c, chat.id, 'effort')!.current).toBe('medium');
    await c.setOption(chat.id, 'fast', true);
    // A value the agent didn't offer is ignored.
    await c.setOption(chat.id, 'effort', 'max');
    await c.send(chat.id, 'hi');
    expect(lastReply(c.chat(chat.id)!)).toBe('You said: hi (demo-small · medium · fast)');
  });

  it('works with only the older modes and Gemini’s models, through session/set_model', async () => {
    const dir = await gitRepo();
    process.env.FAKE_AGENT_LEGACY = '1';
    try {
      const { core: c } = core(dir);
      const chat = await c.createChat('gemini');
      await waitFor(() => live(c, chat.id));
      const opts = c.chat(chat.id)!.session!.options;
      expect(opts.map((o) => [o.id, o.via])).toEqual([
        ['mode', 'mode'],
        ['model', 'model'],
      ]);
      await c.setOption(chat.id, 'model', 'demo-small');
      await c.send(chat.id, 'hi');
      expect(lastReply(c.chat(chat.id)!)).toBe('You said: hi (demo-small · medium)');
    } finally {
      delete process.env.FAKE_AGENT_LEGACY;
    }
  });

  it('remembers the last choices per agent and applies them to new chats', async () => {
    const dir = await gitRepo();
    const defaults = memoryDefaults();
    const { core: c } = core(dir, { defaults });
    const first = await c.createChat('demo');
    await waitFor(() => live(c, first.id));
    await c.setOption(first.id, 'model', 'demo-small');
    await c.setOption(first.id, 'effort', 'low');
    await c.setApproval(first.id, 'edits');
    expect(defaults.all.demo?.chosen).toEqual({ model: 'demo-small', thought_level: 'low' });
    expect(defaults.all.demo?.approval).toBe('edits');
    expect(defaults.all.demo?.options.map((o) => o.id)).toEqual(['model', 'effort', 'fast']);

    const second = await c.createChat('demo');
    // The pickers show the remembered options before the session answers.
    expect(c.chat(second.id)!.session?.options.length).toBeGreaterThan(0);
    expect(c.chat(second.id)!.approval).toBe('edits');
    await waitFor(() => live(c, second.id) && option(c, second.id, 'effort')?.current === 'low');
    expect(option(c, second.id, 'model')!.current).toBe('demo-small');
    expect(option(c, second.id, 'mode')!.current).toBe('acceptEdits');
  });

  it('remembers the agent’s commands and shows them in a new chat before its session starts', async () => {
    const dir = await gitRepo();
    const defaults = memoryDefaults();
    const { core: c } = core(dir, { defaults });
    const first = await c.createChat('demo');
    await waitFor(() => live(c, first.id) && (defaults.all.demo?.commands?.length ?? 0) > 0);
    expect(defaults.all.demo!.commands!.map((x) => x.name)).toEqual(['help', 'compact', 'review']);

    const second = await c.createChat('demo');
    expect(c.chat(second.id)!.session?.commands.map((x) => x.name)).toEqual(['help', 'compact', 'review']);
  });

  it('says the agent is starting until its session is live', async () => {
    const dir = await gitRepo();
    const { core: c } = core(dir);
    const chat = await c.createChat('demo');
    expect(c.chat(chat.id)!.session).toMatchObject({ live: false, starting: true });
    await waitFor(() => live(c, chat.id));
    expect(c.chat(chat.id)!.session!.starting).toBeFalsy();
  });

  it('shows a failed start with Try again, every time, and Try again starts it again', async () => {
    const dir = await gitRepo();
    const { core: c } = core(dir, { agentCommand: () => ({ command: path.join(dir, 'no-such-agent'), args: [] }) });
    const chat = await c.createChat('claude');
    const notices = () => c.chat(chat.id)!.items.filter((i) => i.kind === 'notice' && i.tone === 'error');
    await waitFor(() => notices().length === 1);
    expect(c.chat(chat.id)!.session?.starting).toBeFalsy();
    expect(notices()[0]).toMatchObject({ actions: expect.arrayContaining([{ label: 'Try again', do: 'retry' }]) });
    await c.retry(chat.id);
    await waitFor(() => notices().length === 2);
  });

  it('applies a new task’s choices when its session starts', async () => {
    const dir = await gitRepo();
    const { core: c } = core(dir);
    const chat = await c.createChat('demo', { choices: { model: 'demo-small', thought_level: 'low', 'id:nope': 'x' } });
    await c.send(chat.id, 'hi');
    expect(lastReply(c.chat(chat.id)!)).toBe('You said: hi (demo-small · low)');
  });
});

describe('approval levels and the agent’s own modes', () => {
  it('sets the agent’s mode for the chat’s level, instead of keeping the agent’s default', async () => {
    const dir = await gitRepo();
    const { core: c, seen } = core(dir, { approvalDefault: () => 'edits' });
    // "Codex" here is the Demo program: its modes are matched by what they say they do.
    const chat = await c.createChat('codex');
    await waitFor(() => option(c, chat.id, 'mode')?.current === 'acceptEdits');
    await c.setApproval(chat.id, 'ask');
    expect(option(c, chat.id, 'mode')!.current).toBe('default');
    await c.setApproval(chat.id, 'full');
    expect(seen.confirms).toBe(1);
    expect(option(c, chat.id, 'mode')!.current).toBe('bypassPermissions');
    expect(c.chat(chat.id)!.approval).toBe('full');
    // Confirmed once per chat.
    await c.setApproval(chat.id, 'ask');
    await c.setApproval(chat.id, 'full');
    expect(seen.confirms).toBe(1);
  });

  it('asks before Full auto, and keeps the chat as it was when the user says no', async () => {
    const dir = await gitRepo();
    const { core: c } = core(dir, {}, { confirmFullAuto: async () => false });
    const chat = await c.createChat('demo');
    await waitFor(() => live(c, chat.id));
    await c.setApproval(chat.id, 'full');
    // Choosing a full-access mode directly is Full auto too.
    await c.setOption(chat.id, 'mode', 'bypassPermissions');
    expect(c.chat(chat.id)!.approval).toBeUndefined();
    expect(option(c, chat.id, 'mode')!.current).toBe('default');
  });

  it('switches Plan on and off, and back to the level’s mode', async () => {
    const dir = await gitRepo();
    const { core: c } = core(dir);
    const chat = await c.createChat('demo');
    await waitFor(() => live(c, chat.id));
    await c.setApproval(chat.id, 'edits');
    await c.setPlan(chat.id, true);
    expect(option(c, chat.id, 'mode')!.current).toBe('plan');
    await c.setPlan(chat.id, false);
    expect(option(c, chat.id, 'mode')!.current).toBe('acceptEdits');
  });

  it('Auto-accept edits writes without a diff, records the turn, and Undo still works', async () => {
    const dir = await gitRepo();
    const { core: c, seen } = core(dir, { approvalDefault: () => 'edits' });
    const chat = await c.createChat('demo');
    const turn = c.send(chat.id, 'tour');
    await waitFor(() => c.decisions()[0]?.kind === 'command');
    c.decideCommand(c.decisions()[0].id, true);
    await turn;
    expect(seen.reviews).toEqual([]);
    const review = c.chat(chat.id)!.items.find((i) => i.kind === 'review');
    expect(review).toMatchObject({ state: 'accepted', auto: 'Edit automatically' });
    const changes = c.chat(chat.id)!.items.find((i) => i.kind === 'changes');
    expect(changes).toMatchObject({ files: [path.join(dir, 'NOTES.md')] });
    await c.undo(chat.id, changes!.kind === 'changes' ? changes!.turnId : '');
    expect(existsSync(path.join(dir, 'NOTES.md'))).toBe(false);
  });

  it('Full auto runs edits and commands without asking, but not commands outside the workspace', async () => {
    const dir = await gitRepo();
    const { core: c, seen } = core(dir);
    const chat = await c.createChat('demo', { approval: 'full' });
    await c.send(chat.id, 'tour');
    expect(seen.reviews).toEqual([]);
    expect(seen.commands).toEqual([]);
    const command = c.chat(chat.id)!.items.find((i) => i.kind === 'command');
    expect(command).toMatchObject({ state: 'exited', exitCode: 0, auto: 'Auto' });
    expect(c.chat(chat.id)!.items.some((i) => i.kind === 'review' && i.auto === 'Auto')).toBe(true);
  });
});

describe('the permission request is the review', () => {
  it('fills in a request that names only its tool call, shows the whole diff, and opens it read-only', async () => {
    const dir = await gitRepo();
    const { core: c, seen } = core(dir);
    const chat = await c.createChat('demo');
    const file = path.join(dir, 'README.md');
    const turn = c.send(chat.id, 'perm-edit README.md');
    await waitFor(() => !!permission(c, chat.id));
    const p = permission(c, chat.id)!;
    expect(p).toMatchObject({ title: 'Edit files', toolKind: 'edit' });
    expect(p.detail?.files).toEqual([expect.objectContaining({ path: file, added: 1, removed: 0, full: true, isNew: false })]);
    expect(p.detail!.files![0].lines.map((l) => l.op + l.text)).toEqual([' # test', '+patched by the demo agent']);
    expect(c.showProposal(p.requestId, file)).toBe(true);
    expect(seen.proposals).toEqual([{ path: file, after: '# test\npatched by the demo agent\n' }]);
    // The loud yes is the first one-time allow, never "don't ask again".
    c.answerPermission(p.requestId, 'approved');
    await turn;
    expect(await readFile(file, 'utf8')).toBe('# test\npatched by the demo agent\n');
    // The agent wrote it itself; the git checkpoint still finds it, and Undo puts it back.
    const changes = c.chat(chat.id)!.items.find((i) => i.kind === 'changes');
    expect(changes).toMatchObject({ files: [file] });
    expect(c.chat(chat.id)!.files).toEqual(['README.md']);
    await c.undo(chat.id, changes!.kind === 'changes' ? changes!.turnId : '');
    expect(await readFile(file, 'utf8')).toBe('# test\n');
  });

  it('shows the command and its folder, and an "Always allow" rule answers the next one', async () => {
    const dir = await gitRepo();
    const permissions = memoryPermissions();
    const { core: c } = core(dir, { permissions });
    const chat = await c.createChat('demo');
    let turn = c.send(chat.id, 'native-run');
    await waitFor(() => !!permission(c, chat.id));
    const p = permission(c, chat.id)!;
    expect(p.detail?.command).toEqual({ line: 'node --version', cwd: dir });
    await c.allowAlways({ requestId: p.requestId }, { kind: 'exact', command: p.detail!.command!.line });
    await turn;
    expect(permissions.commands()).toMatchObject([{ kind: 'exact', command: 'node --version' }]);
    expect(permissions.list()[0].agent).toBe('Demo');
    const tool = c.chat(chat.id)!.items.find((i) => i.kind === 'tool' && i.id === 'native-run-1');
    expect(tool?.kind === 'tool' && tool.out?.[0]).toMatchObject({ t: 'text', text: expect.stringMatching(/^v\d+\./) });

    turn = c.send(chat.id, 'native-run');
    await turn;
    const answered = c.chat(chat.id)!.items.filter((i): i is Permission => i.kind === 'permission').at(-1);
    expect(answered).toMatchObject({ answer: 'Yes', auto: expect.stringContaining('Always allowed') });
  });

  it('never answers a plan for you, and follows the mode the agent switches to', async () => {
    const dir = await gitRepo();
    const { core: c } = core(dir);
    const chat = await c.createChat('demo', { approval: 'full' });
    const turn = c.send(chat.id, 'plan');
    await waitFor(() => !!permission(c, chat.id));
    expect(option(c, chat.id, 'mode')!.current).toBe('plan');
    const p = permission(c, chat.id)!;
    expect(p.toolKind).toBe('switch_mode');
    expect(p.detail?.plan).toContain('## Plan');
    c.answerPermission(p.requestId, 'exit-plan-accept-edits');
    await turn;
    expect(option(c, chat.id, 'mode')!.current).toBe('acceptEdits');
  });

  it('asks once for a write it already showed: the permission card, not a second review', async () => {
    const dir = await gitRepo();
    const { core: c, seen } = core(dir);
    const chat = await c.createChat('demo');
    const file = path.join(dir, 'x.txt');
    const turn = c.send(chat.id, `edit ${file}`);
    await waitFor(() => !!permission(c, chat.id));
    expect(permission(c, chat.id)!.detail?.files?.[0]).toMatchObject({ isNew: true, full: true });
    c.answerPermission(permission(c, chat.id)!.requestId, 'allow');
    await turn;
    expect(seen.reviews).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe('edited by fake agent\n');
    expect(c.chat(chat.id)!.items.find((i) => i.kind === 'review')).toMatchObject({ state: 'accepted', auto: 'Approved above' });
  });

  it('undoes an edit the agent made itself outside git, from the content its request showed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fl-nogit-'));
    const file = path.join(dir, 'a.txt');
    await writeFile(file, 'one\n');
    const { core: c } = core(dir);
    const chat = await c.createChat('demo');
    const turn = c.send(chat.id, 'native-edit a.txt');
    await waitFor(() => !!permission(c, chat.id));
    c.answerPermission(permission(c, chat.id)!.requestId, 'allow');
    await turn;
    expect(await readFile(file, 'utf8')).toBe('one\nedited by the demo agent itself\n');
    const changes = c.chat(chat.id)!.items.find((i) => i.kind === 'changes');
    expect(changes).toMatchObject({ files: [file] });
    await c.undo(chat.id, changes!.kind === 'changes' ? changes!.turnId : '');
    expect(await readFile(file, 'utf8')).toBe('one\n');
  });

  it('leaves a file alone on Undo when it changed again after the turn', async () => {
    const dir = await gitRepo();
    const { core: c } = core(dir, { approvalDefault: () => 'edits' });
    const chat = await c.createChat('demo');
    await c.send(chat.id, 'native-edit README.md');
    const file = path.join(dir, 'README.md');
    await writeFile(file, 'mine now\n');
    const changes = c.chat(chat.id)!.items.find((i) => i.kind === 'changes');
    await c.undo(chat.id, changes!.kind === 'changes' ? changes!.turnId : '');
    expect(await readFile(file, 'utf8')).toBe('mine now\n');
    expect(c.chat(chat.id)!.items.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('README.md') });
  });
});

describe('messages while the agent works', () => {
  it('queues a message, sends it when the turn ends, and can drop one', async () => {
    const dir = await gitRepo();
    const { core: c } = core(dir);
    const chat = await c.createChat('demo');
    const first = c.send(chat.id, 'native-run');
    await waitFor(() => !!permission(c, chat.id));
    const second = c.send(chat.id, 'second');
    const third = c.send(chat.id, 'third');
    await waitFor(() => c.chat(chat.id)!.queue?.length === 2);
    c.unqueue(chat.id, c.chat(chat.id)!.queue![1].id);
    c.answerPermission(permission(c, chat.id)!.requestId, 'allow');
    await first;
    await second;
    await third;
    await waitFor(() => !c.chat(chat.id)!.busy);
    expect(lastReply(c.chat(chat.id)!)).toBe('You said: second');
    expect(c.chat(chat.id)!.items.filter((i) => i.kind === 'user').map((i) => (i.kind === 'user' ? i.text : ''))).toEqual(['native-run', 'second']);
    expect(c.chat(chat.id)!.queue).toBeUndefined();
  });

  it('steers a queued message into the running turn where the agent takes that', async () => {
    const dir = await gitRepo();
    const { core: c } = core(dir);
    const chat = await c.createChat('demo');
    const turn = c.send(chat.id, 'wait');
    // The agent has the turn once it says it waits.
    await waitFor(() => c.chat(chat.id)!.items.some((i) => i.kind === 'thought'));
    void c.send(chat.id, 'look at the tests too');
    await waitFor(() => c.chat(chat.id)!.queue?.length === 1);
    await c.sendNow(chat.id, c.chat(chat.id)!.queue![0].id);
    expect(c.chat(chat.id)!.queue).toBeUndefined();
    await turn;
    const said = c.chat(chat.id)!.items.flatMap((i) => (i.kind === 'agent' ? [i.text] : []));
    expect(said).toContain('Steered: look at the tests too');
    expect(c.chat(chat.id)!.items.filter((i) => i.kind === 'user').map((i) => (i.kind === 'user' ? i.text : ''))).toEqual(['wait', 'look at the tests too']);
  });

  it('says when a turn ends, for the editor to notify', async () => {
    const dir = await gitRepo();
    const { core: c, seen } = core(dir);
    const chat = await c.createChat('demo');
    await c.send(chat.id, 'hi');
    expect(seen.ended).toEqual(['Demo:end_turn:0']);
  });
});

describe('questions and file references', () => {
  it('shows a form question and sends back only an answer that fits it', async () => {
    const dir = await gitRepo();
    const { core: c } = core(dir);
    const chat = await c.createChat('demo');
    const turn = c.send(chat.id, 'question');
    await waitFor(() => c.decisions()[0]?.kind === 'question');
    const q = c.chat(chat.id)!.items.find((i) => i.kind === 'question');
    expect(q).toMatchObject({ message: 'Which database should the store use?', state: 'awaiting' });
    expect(q?.kind === 'question' && q.fields.map((f) => [f.key, f.type, f.required ?? false])).toEqual([
      ['db', 'choice', true],
      ['note', 'text', false],
    ]);
    const id = c.decisions()[0].id;
    c.answerQuestion(id, 'accept', { db: 'mysql' });
    c.answerQuestion(id, 'accept', { note: 'no db' });
    expect(c.decisions().map((d) => d.id)).toEqual([id]);
    c.answerQuestion(id, 'accept', { db: 'sqlite', note: 'keep it simple' });
    await turn;
    expect(lastReply(c.chat(chat.id)!)).toBe('You picked sqlite (keep it simple).');
    expect(c.chat(chat.id)!.items.find((i) => i.kind === 'question')).toMatchObject({ state: 'answered', summary: 'Database: SQLite · Other: keep it simple' });
  });

  it("gets Claude's real AskUserQuestion answer back to the agent: a click's option, or the typed Other (owner bug)", async () => {
    const dir = await gitRepo();
    const { core: c } = core(dir);
    const chat = await c.createChat('demo');
    for (const [values, said] of [
      [{ question_0: 'SQLite' }, 'You answered: SQLite.'],
      [{ question_0_custom: 'Postgres' }, 'You answered: Postgres.'],
    ] as const) {
      const turn = c.send(chat.id, 'ask-user');
      await waitFor(() => c.decisions()[0]?.kind === 'question');
      const q = c.chat(chat.id)!.items.findLast((i) => i.kind === 'question');
      expect(q?.kind === 'question' && q.fields.map((f) => f.key)).toEqual(['question_0', 'question_0_custom']);
      c.answerQuestion(c.decisions()[0].id, 'accept', values);
      await turn;
      expect(lastReply(c.chat(chat.id)!)).toBe(said);
    }
    const turn = c.send(chat.id, 'ask-user 2');
    await waitFor(() => c.decisions()[0]?.kind === 'question');
    c.answerQuestion(c.decisions()[0].id, 'accept', { question_0: 'Memory', question_1: 'LRU' });
    await turn;
    expect(lastReply(c.chat(chat.id)!)).toBe('You answered: Memory, LRU.');
  });

  it('declines a question when the turn is stopped', async () => {
    const dir = await gitRepo();
    const { core: c } = core(dir);
    const chat = await c.createChat('demo');
    const turn = c.send(chat.id, 'question');
    await waitFor(() => c.decisions()[0]?.kind === 'question');
    await c.cancel(chat.id);
    await turn;
    expect(c.decisions()).toEqual([]);
  });

  it('sends files named with # as resource links, only inside the workspace', async () => {
    const dir = await gitRepo();
    const { core: c } = core(dir);
    const chat = await c.createChat('demo');
    await c.send(chat.id, 'links #README.md #../../etc/passwd #missing.txt');
    expect(lastReply(c.chat(chat.id)!)).toBe('Linked: README.md');
    expect(c.fileMatches(chat.id, [path.join(dir, 'README.md'), path.join(dir, 'src', 'readme-notes.ts'), '/etc/passwd'], 'readme')).toEqual(['README.md', 'src/readme-notes.ts']);
  });
});


describe('rewind', () => {
  const userTurns = (c: ReturnType<typeof core>['core'], chatId: string) =>
    c.chat(chatId)!.items.flatMap((i) => (i.kind === 'user' && i.checkpoint ? [i.checkpoint] : []));

  it('restores code and conversation to before a message, and says the agent starts a new session', async () => {
    const dir = await gitRepo();
    const { core: c } = core(dir, { approvalDefault: () => 'edits' });
    const chat = await c.createChat('demo');
    const file = path.join(dir, 'README.md');
    await c.send(chat.id, 'native-edit README.md');
    await c.send(chat.id, 'native-edit README.md');
    expect(await readFile(file, 'utf8')).toBe('# test\nedited by the demo agent itself\nedited by the demo agent itself\n');
    const [first] = userTurns(c, chat.id);
    expect(c.checkpointList(chat.id)).toHaveLength(2);
    const plan = await c.rewindPlan(chat.id, first);
    expect(plan.files).toEqual([{ file: 'README.md', added: 0, removed: 2, conflict: false }]);

    await c.rewind(chat.id, first, 'both');
    expect(await readFile(file, 'utf8')).toBe('# test\n');
    const items = c.chat(chat.id)!.items;
    expect(items.some((i) => i.kind === 'user')).toBe(false);
    expect(items.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('new session') });
    expect(c.checkpointList(chat.id)).toEqual([]);
  });

  it('restores code only and keeps a file you changed unless you pick the checkpoint', async () => {
    const dir = await gitRepo();
    const { core: c } = core(dir, { approvalDefault: () => 'edits' });
    const chat = await c.createChat('demo');
    await c.send(chat.id, 'native-edit README.md');
    const file = path.join(dir, 'README.md');
    await writeFile(file, 'mine now\n');
    const [first] = userTurns(c, chat.id);
    expect((await c.rewindPlan(chat.id, first)).files[0]).toMatchObject({ file: 'README.md', conflict: true });
    const kept = await c.rewind(chat.id, first, 'code');
    expect(kept.kept).toEqual([file]);
    expect(await readFile(file, 'utf8')).toBe('mine now\n');
    // The conversation stays; the turn's card says it was undone.
    expect(c.chat(chat.id)!.items.some((i) => i.kind === 'user')).toBe(true);
    expect(c.chat(chat.id)!.items.find((i) => i.kind === 'changes')).toMatchObject({ undone: true });
  });

  it('rewinds a folder outside git from snapshots in the checkpoint folder', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fl-nogit-'));
    const file = path.join(dir, 'a.txt');
    await writeFile(file, 'one\n');
    const { core: c } = core(dir, { approvalDefault: () => 'edits', checkpointDir: await mkdtemp(path.join(os.tmpdir(), 'fl-cpdir-')) });
    const chat = await c.createChat('demo');
    await c.send(chat.id, 'native-edit a.txt');
    const [first] = userTurns(c, chat.id);
    expect(first).toBeTruthy();
    await c.rewind(chat.id, first, 'code', []);
    expect(await readFile(file, 'utf8')).toBe('one\n');
  });
});
