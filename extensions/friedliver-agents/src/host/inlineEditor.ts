// Inline edit in the editor: Ctrl/Cmd+I, type an instruction, watch the
// proposal stream into an inline diff, then Accept (Ctrl/Cmd+Enter), Reject
// (Esc) or Retry with a follow-up. The file changes only on Accept, through a
// WorkspaceEdit, so Ctrl/Cmd+Z undoes it. The logic is in inlineEdit.ts.
import * as vscode from 'vscode';
import { AGENT_FACES, isAgentKey, type AgentKey } from '../shared/model';
import type { AgentCore } from './core';
import type { Span } from './editorPrompt';
import { applyReplacement, inlinePrompt, runInline, type InlineRun } from './inlineEdit';
import { testAgentsOn, userSetting } from './settings';

const SCHEME = 'friedliver-inline';
const PENDING = 'friedliver.inlineEdit.pending';
const RUNNING = 'friedliver.inlineEdit.running';

interface Pending {
  doc: vscode.TextDocument;
  version: number;
  range: vscode.Range;
  instruction: string;
  agent: AgentKey;
  proposal: string;
  preview: vscode.Uri;
  run?: InlineRun;
}

export class InlineEditor implements vscode.Disposable {
  private current: Pending | undefined;
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly mark = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
    isWholeLine: false,
  });

  constructor(
    private readonly core: AgentCore,
    /** Chats the inline edits own; the extension keeps their reviews and prompts off screen. */
    readonly owned: Set<string>,
  ) {
    const command = (id: string, fn: () => unknown) => this.disposables.push(vscode.commands.registerCommand(id, fn));
    command('friedliver.inlineEdit', () => this.start());
    command('friedliver.inlineEdit.accept', () => this.accept());
    command('friedliver.inlineEdit.reject', () => this.reject());
    command('friedliver.inlineEdit.retry', () => this.retry());
    this.disposables.push(
      this.changed,
      this.mark,
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
        onDidChange: this.changed.event,
        provideTextDocumentContent: () => (this.current ? applyReplacement(this.current.doc.getText(), spanOf(this.current.range), this.current.proposal) : ''),
      }),
    );
  }

  dispose(): void {
    void this.reject();
    for (const d of this.disposables) d.dispose();
  }

  private agent(): AgentKey {
    const v = userSetting(vscode.workspace.getConfiguration('friedliver').inspect<string>('inlineEdit.agent')).value;
    return isAgentKey(v) && (v !== 'demo' || testAgentsOn()) ? v : 'antigravity';
  }

  async start(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return;
    await this.reject();
    const agent = this.agent();
    const instruction = await vscode.window.showInputBox({
      title: `Inline edit with ${AGENT_FACES[agent].name}`,
      placeHolder: editor.selection.isEmpty ? 'What should go at the cursor?' : 'Describe the change to the selection',
      prompt: 'Ctrl/Cmd+Enter accepts the proposal, Esc rejects it.',
      ignoreFocusOut: true,
    });
    if (!instruction?.trim()) return;
    const doc = editor.document;
    const range = new vscode.Range(editor.selection.start, editor.selection.end);
    this.current = { doc, version: doc.version, range, instruction: instruction.trim(), agent, proposal: '', preview: vscode.Uri.from({ scheme: SCHEME, path: doc.uri.path, query: String(Date.now()) }) };
    editor.setDecorations(this.mark, [range]);
    await this.propose();
  }

  /** Runs the agent for the current request and shows its proposal as it streams. */
  private async propose(previous?: { replacement: string; followUp: string }): Promise<void> {
    const p = this.current;
    if (!p) return;
    const folder = vscode.workspace.getWorkspaceFolder(p.doc.uri)?.uri.fsPath ?? p.doc.uri.fsPath;
    let context: string;
    try {
      context = inlinePrompt({ cwd: folder, file: p.doc.uri.fsPath, languageId: p.doc.languageId, text: p.doc.getText(), span: spanOf(p.range), previous });
    } catch (err) {
      void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
      return this.reject();
    }
    let shown = false;
    const show = async () => {
      if (shown) return;
      shown = true;
      await vscode.commands.executeCommand('vscode.diff', p.doc.uri, p.preview, `${AGENT_FACES[p.agent].name}: ${p.instruction} (Accept ⌘/Ctrl+Enter · Reject Esc)`, { preview: true });
    };
    const run = runInline(this.core, p.agent, context, p.instruction, (partial) => {
      if (this.current !== p) return;
      p.proposal = partial;
      void show().then(() => this.changed.fire(p.preview));
    }, this.owned);
    p.run = run;
    void vscode.commands.executeCommand('setContext', RUNNING, true);
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `${AGENT_FACES[p.agent].name} is proposing an edit…` }, () => run.done);
    void vscode.commands.executeCommand('setContext', RUNNING, false);
    if (this.current !== p) return;
    p.run = undefined;
    if (!result) return this.reject();
    if (result.error || result.replacement === undefined) {
      void vscode.window.showWarningMessage(result.error ?? 'The agent proposed no code.');
      return this.reject();
    }
    p.proposal = result.replacement;
    await show();
    this.changed.fire(p.preview);
    void vscode.commands.executeCommand('setContext', PENDING, true);
  }

  async accept(): Promise<void> {
    const p = this.current;
    if (!p || p.run) return;
    if (p.doc.version !== p.version) {
      void vscode.window.showWarningMessage('The file changed since the edit was proposed; nothing was applied. Retry to get a fresh proposal.');
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(p.doc.uri, p.range, p.proposal);
    await this.close();
    // One WorkspaceEdit: a single Ctrl/Cmd+Z undoes it.
    if (!(await vscode.workspace.applyEdit(edit))) void vscode.window.showWarningMessage("Couldn't apply the edit.");
  }

  /** Esc: stops a running proposal, or drops a finished one. The file is never touched. */
  async reject(): Promise<void> {
    this.current?.run?.cancel();
    await this.close();
  }

  async retry(): Promise<void> {
    const p = this.current;
    if (!p || p.run) return;
    const followUp = await vscode.window.showInputBox({ title: 'Retry with a follow-up', placeHolder: 'What should change in the proposal?', ignoreFocusOut: true });
    if (followUp === undefined || this.current !== p) return;
    void vscode.commands.executeCommand('setContext', PENDING, false);
    await this.propose({ replacement: p.proposal, followUp: followUp.trim() || 'Try again, differently.' });
  }

  private async close(): Promise<void> {
    const p = this.current;
    this.current = undefined;
    void vscode.commands.executeCommand('setContext', PENDING, false);
    void vscode.commands.executeCommand('setContext', RUNNING, false);
    if (!p) return;
    for (const e of vscode.window.visibleTextEditors) if (e.document === p.doc) e.setDecorations(this.mark, []);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === p.preview.toString());
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
  }
}

const spanOf = (r: vscode.Range): Span => ({ start: { line: r.start.line, character: r.start.character }, end: { line: r.end.line, character: r.end.character } });
