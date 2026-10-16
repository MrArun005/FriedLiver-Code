// Drives the demo agent through the real editor: chat, edit review in the
// diff editor, command approval, undo, then a task in its own worktree that
// is merged into main, then connected chats: a hand-off, an @mention, and an
// agent asking another through the FriedLiver tools, then the editor commands:
// Edit with Agent on a selection, Ask About Selection, a code reference from
// the composer, Review My Changes and Fix with Agent. Takes screenshots when
// an X display is available.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import type { Controller } from '../extension';
import type { EditOutcome } from '../host/editFlow';
import type { Surface } from '../host/webviews';
import { lastReply, type ChatView } from '../shared/model';

const shots = process.env.FRIEDLIVER_SCREENSHOTS;
const workspace = process.env.FRIEDLIVER_WORKSPACE!;

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<Controller>('friedliver.friedliver-agents');
  if (!ext) throw new Error('Extension not found');
  const c = await ext.activate();
  const step = (text: string) => console.log(`[suite] ${text}`);
  // Webview messages go through the same handler the views use.
  const fake: Surface = { kind: 'chat', webview: undefined as never, ready: false, visible: () => true, reveal: () => {} };

  await vscode.commands.executeCommand('friedliver.agents.focus');
  // Startup toasts ("running as root", "extensions disabled") would cover the view.
  await vscode.commands.executeCommand('notifications.clearAll');
  await pause(1500);
  await screenshot('01-empty');

  step('chat with the demo agent');
  const chatId = await c.newChat('demo');
  if (!chatId) throw new Error('No chat');
  await c.handle(fake, { type: 'send', chatId, text: 'tour', images: [] });

  step('edit review in the diff editor');
  await waitFor(() => c.core.decisions()[0]?.kind === 'review', 'a review');
  await waitFor(() => c.reviews.activeReviewId() !== undefined, 'the diff editor');
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (!(tab?.input instanceof vscode.TabInputTextDiff) || tab.input.modified.scheme !== 'friedliver-proposed') throw new Error('No diff editor');
  await pause(1500);
  await screenshot('02-review-diff');
  await vscode.commands.executeCommand('friedliver.review.accept');
  const notes = path.join(workspace, 'NOTES.md');
  await waitFor(() => existsSync(notes), 'NOTES.md written');
  if (!(await readFile(notes, 'utf8')).includes('demo agent was here')) throw new Error('Wrong NOTES.md');

  step('command approval');
  await waitFor(() => c.core.decisions()[0]?.kind === 'command', 'a command');
  await pause(1000);
  await screenshot('03-command-ask');
  await c.handle(fake, { type: 'command', commandId: c.core.decisions()[0].id, approve: true });
  await waitFor(() => !c.core.chat(chatId)!.busy, 'the turn to end', 20_000);
  const items = c.core.chat(chatId)!.items;
  const command = items.find((i) => i.kind === 'command');
  if (command?.kind !== 'command' || command.exitCode !== 0 || !command.output.includes('hello from terminal')) {
    throw new Error(`Command did not run: ${JSON.stringify(command)}`);
  }
  if (!c.core.snapshot.images.length) throw new Error('No image collected');
  await vscode.commands.executeCommand('notifications.clearAll');
  await pause(1000);
  await screenshot('04-turn-done');

  step('undo the turn');
  const changes = items.find((i) => i.kind === 'changes');
  if (changes?.kind !== 'changes') throw new Error('No changes card');
  await c.handle(fake, { type: 'undo', chatId, turnId: changes.turnId });
  await waitFor(() => !existsSync(notes), 'NOTES.md removed by undo');

  step('session controls: options before the first message, model, approval level');
  const controls = await c.newChat('demo');
  if (!controls) throw new Error('No chat');
  await waitFor(() => c.core.chat(controls)?.session?.live === true && (c.core.chat(controls)?.session?.commands.length ?? 0) > 0, 'the session to start before any message');
  await c.handle(fake, { type: 'setOption', chatId: controls, optionId: 'model', value: 'demo-small' });
  await c.handle(fake, { type: 'approval', chatId: controls, level: 'edits' });
  await waitFor(() => c.core.chat(controls)!.session!.options.find((o) => o.id === 'mode')?.current === 'acceptEdits', "the agent's mode to follow the level");
  await c.handle(fake, { type: 'send', chatId: controls, text: 'hi', images: [] });
  await waitFor(() => lastReply(c.core.chat(controls)!) === 'You said: hi (demo-small · medium)', 'the reply with the chosen model');
  await pause(800);
  await screenshot('11-session-controls');

  step('a permission request is the review, for an agent that writes files itself');
  await c.handle(fake, { type: 'approval', chatId: controls, level: 'ask' });
  const readme = path.join(workspace, 'README.md');
  const before = await readFile(readme, 'utf8');
  await c.handle(fake, { type: 'send', chatId: controls, text: 'perm-edit README.md', images: [] });
  await waitFor(() => c.core.decisions()[0]?.kind === 'permission', 'the edit request');
  const ask = c.core.chat(controls)!.items.find((i) => i.kind === 'permission' && !i.answer);
  if (ask?.kind !== 'permission' || !ask.detail?.files?.[0]?.full) throw new Error(`No diff on the request: ${JSON.stringify(ask)}`);
  await c.handle(fake, { type: 'permissionDiff', requestId: ask.requestId, path: readme });
  await waitFor(() => {
    const t = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return t instanceof vscode.TabInputTextDiff && t.modified.scheme === 'friedliver-proposed';
  }, 'the read-only diff of the request');
  await pause(800);
  await screenshot('12-permission-diff');
  await c.handle(fake, { type: 'permission', requestId: ask.requestId, optionId: 'approved' });
  await waitFor(() => !c.core.chat(controls)!.busy, 'the edit turn to end');
  if ((await readFile(readme, 'utf8')) === before) throw new Error('The agent did not write README.md');
  const card = c.core.chat(controls)!.items.filter((i) => i.kind === 'changes').at(-1);
  if (card?.kind !== 'changes' || !card.files.includes(readme)) throw new Error(`No changes card for the agent's own write: ${JSON.stringify(card)}`);
  await c.handle(fake, { type: 'undo', chatId: controls, turnId: card.turnId });
  await waitFor(() => existsSync(readme), 'README.md');
  if ((await readFile(readme, 'utf8')) !== before) throw new Error('Undo did not restore README.md');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  step('task in its own worktree');
  c.openTasks();
  await c.handle(fake, { type: 'createTask', agent: 'demo', prompt: 'tour', worktree: true });
  await waitFor(() => c.core.snapshot.chats.length === 3, 'the task chat');
  const task = c.core.snapshot.chats[2];
  if (!task.branch) throw new Error('Task has no branch');
  await waitFor(() => c.core.decisions()[0]?.kind === 'review', 'the task review');
  c.openTasks();
  await pause(1500);
  await screenshot('05-board-needs-you');
  await vscode.commands.executeCommand('friedliver.review.accept', c.core.decisions()[0].id);
  await waitFor(() => c.core.decisions()[0]?.kind === 'command', 'the task command');
  c.core.decideCommand(c.core.decisions()[0].id, true);
  await waitFor(() => !c.core.chat(task.id)!.busy, 'the task to finish', 20_000);
  await pause(1000);
  await screenshot('06-board-done');

  step('merge into main');
  await c.core.merge(task.id);
  if (!existsSync(notes)) throw new Error('Merge did not bring NOTES.md into main');
  await c.core.removeWorktree(task.id);
  if (existsSync(task.cwd)) throw new Error('Worktree still there');

  step('connections: hand-off, @mention, and an agent asking another');
  const main = await c.newChat('demo');
  if (!main) throw new Error('No chat');
  await c.handle(fake, { type: 'send', chatId: main, text: 'hello', images: [] });
  await waitFor(() => c.core.chat(main)!.turns === 1, 'the first reply');
  await c.handle(fake, { type: 'handoff', chatId: main, agent: 'demo' });
  const next = c.core.snapshot.chats.find((x) => x.origin?.kind === 'handoff');
  if (!next) throw new Error('No hand-off chat');
  await c.handle(fake, { type: 'send', chatId: next.id, text: 'go on', images: [] });
  await waitFor(() => lastReply(c.core.chat(next.id)!).includes('taking over a task'), 'the hand-off context');
  await c.handle(fake, { type: 'send', chatId: main, text: '@demo second opinion?', images: [] });
  await waitFor(() => c.core.chat(main)!.items.some((i) => i.kind === 'link' && i.role === 'reply'), 'the consulted reply');
  // The real dist/bridge.js, started by the agent with the editor's own runtime.
  await c.handle(fake, { type: 'send', chatId: main, text: 'ask demo hi', images: [] });
  await waitFor(() => c.core.decisions()[0]?.kind === 'bridge', 'the request to ask another agent');
  await pause(800);
  await screenshot('09-bridge-ask');
  await c.handle(fake, { type: 'bridge', requestId: c.core.decisions()[0].id, answer: 'allow' });
  await waitFor(() => lastReply(c.core.chat(main)!).startsWith('Demo says:'), 'the answer through the FriedLiver tools', 30_000);

  await editorCommands(c, fake, main, step);

  step('center panel and images');
  await c.moveToCenter();
  await pause(1500);
  await screenshot('07-chat-center');
  await c.moveToSide();
  await vscode.commands.executeCommand('friedliver.images.focus');
  await pause(1200);
  await screenshot('08-images');
  step('all passed');
}

/** Edit with Agent, Ask About Selection, references, Review My Changes and Fix with Agent, with the demo agent. */
async function editorCommands(c: Controller, fake: Surface, askChat: string, step: (text: string) => void): Promise<void> {
  step('Edit with Agent on a selection');
  const src = path.join(workspace, 'src', 'format.ts');
  await mkdir(path.dirname(src), { recursive: true });
  await writeFile(src, 'export function format(name: string) {\n  const greeting = "hello";\n  return `${greeting}, ${name}`;\n}\n');
  const doc = await vscode.workspace.openTextDocument(src);
  const editor = await vscode.window.showTextDocument(doc);
  editor.selection = new vscode.Selection(1, 0, 2, doc.lineAt(2).text.length);
  const edited = vscode.commands.executeCommand<EditOutcome | undefined>('friedliver.editSelection', { instruction: 'uppercase', agent: 'demo' });
  await waitFor(() => c.core.decisions()[0]?.kind === 'review', 'the edit to review');
  const reviewId = c.core.decisions()[0].id;
  await waitFor(() => c.reviews.activeReviewId() === reviewId, 'the diff where the user is looking');
  // Focused, so Accept and Reject work from the keyboard right away.
  await waitFor(() => vscode.window.activeTextEditor?.document.uri.scheme === 'friedliver-proposed', `the diff to take focus (on ${vscode.window.activeTextEditor?.document.uri.toString()})`, 5000);
  if ((await readFile(src, 'utf8')).includes('GREETING')) throw new Error('Written before Accept');
  await pause(800);
  await screenshot('10-edit-with-agent-review');
  await vscode.commands.executeCommand('friedliver.review.accept');
  const outcome = await edited;
  if (outcome?.reviews[0]?.state !== 'accepted') throw new Error(`Edit not accepted: ${JSON.stringify(outcome)}`);
  const after = await readFile(src, 'utf8');
  if (!after.includes('  CONST GREETING = "HELLO";') || !after.startsWith('export function format')) throw new Error(`Wrong edit: ${after}`);
  const editChat = c.core.chat(outcome.chatId)!;
  if (editChat.title !== 'uppercase' || !editChat.items.some((i) => i.kind === 'user' && i.refs?.[0]?.startLine === 2)) throw new Error('Edit chat without its title or reference');

  step('Ask About Selection');
  // The editor shows the accepted edit once VS Code sees the file change.
  await waitFor(() => doc.getText().includes('CONST GREETING'), 'the editor to show the edit');
  const again = await vscode.window.showTextDocument(doc);
  again.selection = new vscode.Selection(0, 0, 0, 10);
  await vscode.commands.executeCommand('friedliver.askSelection', { question: 'Why export it?', chatId: askChat });
  const asked = (chat?: ChatView) => chat?.items.some((i) => i.kind === 'user' && i.text === 'Why export it?' && i.refs?.[0]?.path === src);
  await waitFor(() => !!asked(c.core.chat(askChat)) && !c.core.chat(askChat)!.busy, 'the question with its reference');
  const answer = lastReply(c.core.chat(askChat)!);
  if (!answer.includes('src/format.ts:1\n```typescript\nexport function format')) throw new Error(`The agent did not get the code: ${answer}`);

  step('a code reference sent from the composer');
  await c.handle(fake, { type: 'send', chatId: askChat, text: 'And this?', images: [], refs: [{ path: src, startLine: 3, endLine: 3 }] });
  await waitFor(() => lastReply(c.core.chat(askChat)!).includes('src/format.ts:3\n```typescript\n  RETURN'), 'the reference read from the file');

  step('Review My Changes');
  const reviewChat = await vscode.commands.executeCommand<string | undefined>('friedliver.reviewChanges', { agent: 'demo' });
  if (!reviewChat) throw new Error('No review chat');
  await waitFor(() => lastReply(c.core.chat(reviewChat)!).includes('I read the diff of'), 'the review');
  if (c.core.chat(reviewChat)!.title !== 'Review: main') throw new Error(`Review chat is titled ${c.core.chat(reviewChat)!.title}`);

  step('Fix with Agent on a problem');
  const problems = vscode.languages.createDiagnosticCollection('friedliver-test');
  const problem = new vscode.Diagnostic(new vscode.Range(1, 2, 1, 7), 'Unexpected const.', vscode.DiagnosticSeverity.Error);
  problems.set(doc.uri, [problem]);
  await vscode.window.showTextDocument(doc);
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(1, 3, 1, 3));
  // With TypeScript's own problems on the line too, each action names its problem.
  const fix = actions.find((a) => a.title === 'Fix with Agent' || a.title === 'Fix with Agent: Unexpected const.');
  if (!fix?.command?.arguments) throw new Error(`No Fix with Agent: ${actions.map((a) => a.title).join(', ')}`);
  const fixing = vscode.commands.executeCommand<EditOutcome | undefined>(fix.command.command, ...fix.command.arguments);
  await waitFor(() => c.core.decisions()[0]?.kind === 'review', 'the fix to review');
  const fixId = c.core.decisions()[0].id;
  const proposed = c.core.review(fixId)!.proposed;
  if (!proposed.includes('  // Fix this error: Unexpected const.')) throw new Error(`Wrong fix: ${proposed}`);
  // Reject works on the diff in front of you, so wait until it is.
  await waitFor(() => c.reviews.activeReviewId() === fixId, 'the fix diff where the user is looking');
  await vscode.commands.executeCommand('friedliver.review.reject');
  if ((await fixing)?.reviews[0]?.state !== 'rejected') throw new Error('Fix not rejected');
  problems.dispose();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(check: () => boolean, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await pause(50);
  }
}

async function screenshot(name: string): Promise<void> {
  if (!shots || !process.env.DISPLAY) return;
  await mkdir(shots, { recursive: true });
  await new Promise<void>((resolve) => {
    execFile('import', ['-window', 'root', path.join(shots, `${name}.png`)], () => resolve());
  });
}
