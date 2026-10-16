// Drives the demo agent through the real editor: chat, edit review in the
// diff editor, command approval, undo, then a task in its own worktree that
// is merged into main. Takes screenshots when an X display is available.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import type { Controller } from '../extension';
import type { Surface } from '../host/webviews';

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

  step('task in its own worktree');
  c.openTasks();
  await c.handle(fake, { type: 'createTask', agent: 'demo', prompt: 'tour', worktree: true });
  await waitFor(() => c.core.snapshot.chats.length === 2, 'the task chat');
  const task = c.core.snapshot.chats[1];
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
