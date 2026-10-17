import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PendingReview } from '../src/host/core';
import { EditChats, runEdit } from '../src/host/editFlow';
import { editPrompt, lineSpan, referenceBlock, referencesContext, type Span } from '../src/host/editorPrompt';
import { collectChanges, reviewMessage, reviewPrompt } from '../src/host/gitChanges';
import { handoffContext } from '../src/host/transcript';
import { disposeCores, gitRepo, makeCore, waitFor } from './helpers';

afterEach(disposeCores);

const SOURCE = ['export function format(name: string) {', '  const greeting = "hello";', '  return `${greeting}, ${name}`;', '}', ''].join('\n');

async function workspace(): Promise<{ dir: string; file: string }> {
  const dir = await gitRepo();
  await mkdir(path.join(dir, 'src'));
  const file = path.join(dir, 'src', 'format.ts');
  await writeFile(file, SOURCE);
  return { dir, file };
}

/** Lines 2-3 of format.ts, selected from the start of line 2 to the end of line 3. */
const SPAN: Span = { start: { line: 1, character: 0 }, end: { line: 2, character: 30 } };

function message(dir: string, file: string, instruction: string, text = SOURCE) {
  return {
    instruction,
    context: editPrompt({ cwd: dir, file, languageId: 'typescript', text, span: SPAN, kind: 'selection' }),
    ref: { path: file, ...lineSpan(SPAN) },
  };
}

describe('Edit with Agent through the core, with the Demo agent', () => {
  it('proposes the edit as a review, and writes nothing before Accept', async () => {
    const { dir, file } = await workspace();
    const reviews: PendingReview[] = [];
    const core = makeCore(dir, { ui: { showReview: (r) => reviews.push(r), closeReview: () => {} } });
    const chats = new EditChats(core);
    const chat = await chats.chatFor('demo', 'uppercase');

    const turn = runEdit(core, chat, message(dir, file, 'uppercase'));
    await waitFor(() => reviews.length === 1);
    expect(reviews[0].path).toBe(file);
    expect(reviews[0].proposed.split('\n')).toEqual([
      'export function format(name: string) {',
      '  CONST GREETING = "HELLO";',
      '  RETURN `${GREETING}, ${NAME}`;',
      '}',
      '',
    ]);
    // Waiting for the user: the file on disk is as it was, and the edit is a decision.
    expect(await readFile(file, 'utf8')).toBe(SOURCE);
    expect(core.decisions()).toEqual([expect.objectContaining({ kind: 'review', chatId: chat.id })]);

    core.decideReview(reviews[0].reviewId, true);
    const outcome = await turn;
    expect(await readFile(file, 'utf8')).toContain('CONST GREETING');
    expect(outcome).toMatchObject({ chatId: chat.id, reviews: [{ path: file, state: 'accepted' }], error: undefined });
    expect(outcome.reply).toContain('upper-cased');

    // The chat is ordinary: named after the instruction, with the code as a chip.
    const view = core.chat(chat.id)!;
    expect(view.title).toBe('uppercase');
    expect(view.items.find((i) => i.kind === 'user')).toEqual({ kind: 'user', text: 'uppercase', images: [], refs: [{ path: file, startLine: 2, endLine: 3 }] });
    expect(view.files).toEqual(['src/format.ts']);
  });

  it('leaves the file alone when the edit is rejected', async () => {
    const { dir, file } = await workspace();
    const core = makeCore(dir, { ui: { showReview: (r) => setTimeout(() => core.decideReview(r.reviewId, false), 5), closeReview: () => {} } });
    const chat = await new EditChats(core).chatFor('demo', 'comment it out');
    const outcome = await runEdit(core, chat, message(dir, file, 'comment it out'));
    expect(outcome.reviews).toMatchObject([{ state: 'rejected' }]);
    expect(outcome.reply).toContain('rejected');
    expect(await readFile(file, 'utf8')).toBe(SOURCE);
  });

  it('answers a question without an edit', async () => {
    const { dir, file } = await workspace();
    const reviews: PendingReview[] = [];
    const core = makeCore(dir, { ui: { showReview: (r) => reviews.push(r), closeReview: () => {} } });
    const chat = await new EditChats(core).chatFor('demo', 'what does this do?');
    const outcome = await runEdit(core, chat, message(dir, file, 'what does this do?'));
    expect(reviews).toEqual([]);
    expect(outcome.reviews).toEqual([]);
    expect(outcome.reply).toContain('lines 2-3 of `src/format.ts`');
  });

  it('reads the unsaved text the user sees', async () => {
    const { dir, file } = await workspace();
    const unsaved = SOURCE.replace('hello', 'howdy');
    const reviews: PendingReview[] = [];
    const core = makeCore(dir, { ui: { showReview: (r) => reviews.push(r), closeReview: () => {}, unsavedText: (f) => (f === file ? unsaved : undefined) } });
    const chat = await new EditChats(core).chatFor('demo', 'uppercase');
    const turn = runEdit(core, chat, message(dir, file, 'uppercase', unsaved));
    await waitFor(() => reviews.length === 1);
    expect(reviews[0].proposed).toContain('"HOWDY"');
    core.decideReview(reviews[0].reviewId, false);
    await turn;
  });

  it('keeps one edit chat per agent while it is idle, and starts another while it works', async () => {
    const { dir, file } = await workspace();
    const reviews: PendingReview[] = [];
    const core = makeCore(dir, { ui: { showReview: (r) => reviews.push(r), closeReview: () => {} } });
    const chats = new EditChats(core);
    const first = await chats.chatFor('demo', 'one');
    expect((await chats.chatFor('demo', 'two')).id).toBe(first.id);

    const turn = runEdit(core, first, message(dir, file, 'sort'));
    await waitFor(() => core.chat(first.id)!.busy);
    const second = await chats.chatFor('demo', 'three');
    expect(second.id).not.toBe(first.id);
    expect(chats.has(second.id)).toBe(true);
    expect((await chats.chatFor('gemini', 'four')).agent).toBe('gemini');
    await waitFor(() => reviews.length === 1);
    core.decideReview(reviews[0].reviewId, false);
    await turn;
    // The newest edit chat for the agent is the one the next edit continues in.
    expect((await chats.chatFor('demo', 'five')).id).toBe(second.id);
  });

  it('puts the edit chat in the Agent Manager like any chat, and hands its references over', async () => {
    const { dir, file } = await workspace();
    const core = makeCore(dir);
    const chat = await new EditChats(core).chatFor('demo', 'add a note');
    await runEdit(core, chat, message(dir, file, 'add a note'));
    expect(core.snapshot.chats.map((c) => c.id)).toContain(chat.id);
    expect(await readFile(file, 'utf8')).toContain('  // add a note (Demo agent)\n  const greeting');
    expect(handoffContext(core.chat(chat.id)!)).toContain('User: add a note (about src/format.ts:2-3)');
  });
});

describe('Ask About Selection and Review My Changes through the core', () => {
  it('sends a reference with the question and shows it as a chip', async () => {
    const { dir, file } = await workspace();
    const core = makeCore(dir);
    const chat = await core.createChat('demo');
    const ref = { path: file, startLine: 2, endLine: 3 };
    const context = referencesContext([referenceBlock(chat.cwd, ref, SOURCE.split('\n').slice(1, 3).join('\n'), 'typescript')]);
    await core.send(chat.id, 'Why a template string?', [], { context, refs: [ref] });
    const view = core.chat(chat.id)!;
    expect(view.items[0]).toEqual({ kind: 'user', text: 'Why a template string?', images: [], refs: [ref] });
    // The demo agent echoes all it got: the reference first, then the question.
    const reply = view.items.find((i) => i.kind === 'agent');
    expect(reply?.kind === 'agent' && reply.text).toMatch(/src\/format\.ts:2-3\n```typescript\n {2}const greeting[\s\S]*Why a template string\?/);
    expect(view.title).toBe('Why template string');
  });

  it('gets a review of the working tree in a chat named after the branch', async () => {
    const { dir } = await workspace();
    const core = makeCore(dir);
    const changes = (await collectChanges(dir))!;
    const chat = await core.createChat('demo', { title: 'Review: main' });
    await core.send(chat.id, reviewMessage(changes), [], { context: reviewPrompt(changes, chat.cwd), title: 'Review: main' });
    const view = core.chat(chat.id)!;
    expect(view.title).toBe('Review: main');
    expect(view.items[0]).toMatchObject({ kind: 'user', text: 'Review my changes on main (1 file)' });
    const reply = view.items.find((i) => i.kind === 'agent');
    expect(reply?.kind === 'agent' && reply.text).toContain('I read the diff of 1 changed file: `src/format.ts`');
  });
});
