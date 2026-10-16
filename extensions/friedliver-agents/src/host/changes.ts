import path from 'node:path';
import * as vscode from 'vscode';
import * as git from '@friedliver/main/workspace/git';
import type { AgentCore } from './core';

/** Read-only documents with a file's content from before a chat changed it. */
export const BEFORE_SCHEME = 'friedliver-before';

function beforeUri(chatId: string, file: string): vscode.Uri {
  return vscode.Uri.from({ scheme: BEFORE_SCHEME, path: `/${chatId}/${path.basename(file)}`, query: new URLSearchParams({ file }).toString() });
}

/** Serves the "before" side of a chat's diffs from its turn log. */
export function registerBeforeProvider(core: () => AgentCore): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, {
    provideTextDocumentContent(uri) {
      const chatId = uri.path.split('/')[1];
      const file = new URLSearchParams(uri.query).get('file');
      if (!chatId || !file || !core().chat(chatId)) return '';
      // Only files the chat touched, so this can't be used to read anything else.
      if (!core().touchedFiles(chatId).includes(file)) return '';
      return core().beforeChat(chatId, file) ?? '';
    },
  });
}

/**
 * What a chat changed, in VS Code's multi-file diff: a task's worktree
 * against the main checkout, or the files a chat touched against how they
 * were before it. Falls back to a list of the files when there is no record
 * of before (a chat restored from an earlier window).
 */
export async function viewChanges(core: AgentCore, chatId: string): Promise<void> {
  const chat = core.chat(chatId);
  if (!chat) return;
  const wt = core.worktree(chatId);
  if (wt) {
    const files = await git.worktreeChanges(wt.repo, wt);
    if (!files.length) {
      void vscode.window.showInformationMessage('Nothing has changed in this task’s worktree yet.');
      return;
    }
    const list = files.map((f) => {
      const main = vscode.Uri.file(path.join(wt.repo, f.path));
      const task = vscode.Uri.file(path.join(wt.path, f.path));
      return [task, f.status === 'A' ? undefined : main, f.status === 'D' ? undefined : task];
    });
    await vscode.commands.executeCommand('vscode.changes', `${chat.label}: ${wt.branch} vs the main checkout`, list);
    return;
  }

  const touched = core.touchedFiles(chatId);
  if (!touched.length) {
    void vscode.window.showInformationMessage(`${chat.label} hasn’t changed any files.`);
    return;
  }
  const known = touched.filter((f) => core.beforeChat(chatId, f) !== undefined);
  if (known.length) {
    const list = known.map((f) => [vscode.Uri.file(f), core.beforeChat(chatId, f) === null ? undefined : beforeUri(chatId, f), vscode.Uri.file(f)]);
    await vscode.commands.executeCommand('vscode.changes', `${chat.label}: changes since the chat started`, list);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    touched.map((f) => ({ label: path.basename(f), description: vscode.workspace.asRelativePath(f), file: f })),
    { title: `Files ${chat.label} touched`, placeHolder: 'Open a file' },
  );
  if (picked) await vscode.window.showTextDocument(vscode.Uri.file(picked.file), { preview: true });
}
