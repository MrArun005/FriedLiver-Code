// Agents where the code is: Edit with Agent (Ctrl/Cmd+I), Ask About
// Selection, Add Selection to Chat, Review My Changes, and the "Fix with
// Agent" and "Explain with Agent" code actions. Each goes through an ordinary
// chat, so an edit is a diff you accept or reject and a command waits for you,
// as anywhere else.
import path from 'node:path';
import * as vscode from 'vscode';
import { AGENT_FACES, AGENT_KEYS, isAgentKey, type Action, type AgentKey, type ChatView, type CodeRef } from '../shared/model';
import { agentName, chatName, chatRef } from '../shared/names';
import type { AgentCore, PendingReview, SendOptions } from './core';

import { EditChats, runEdit, type EditOutcome } from './editFlow';
import { EDIT_AGENT_HINT, editPrompt, lineSpan, parseEditInput, problemInstruction, refLabel, referenceBlock, referencesContext, type SpanKind } from './editorPrompt';
import { branchName, collectChanges, reviewMessage, reviewPrompt } from './gitChanges';
import { insideRoots } from './paths';
import type { ReviewPlacement } from './review';
import { testAgentsOn, userSetting } from './settings';

/** An agent a setting or saved choice may name: not the removed Demo agent, outside tests. */
const usable = (v: unknown): v is AgentKey => isAgentKey(v) && (v !== 'demo' || testAgentsOn());

/** The agent last used for edits in this workspace. */
const LAST_AGENT = 'friedliver.edit.lastAgent';
/** A function longer than this isn't "the code at the cursor"; its line is. */
const MAX_FUNCTION_LINES = 400;
const SYMBOLS_TIMEOUT_MS = 1500;
const EXPLAIN = vscode.CodeActionKind.Empty.append('friedliver').append('explain');

/** What the editor features need from the controller. */
export interface EditorHost {
  readonly core: AgentCore;
  /** Shows a chat where the user is looking, optionally scrolled to an item. */
  showChat(chatId: string, revealItem?: string): Promise<void>;
  /** The chat last shown in a chat view. */
  currentChat(): string | undefined;
  /** Puts a code reference into a chat's composer without sending it. */
  addToComposer(chatId: string, ref: CodeRef): void;
  /** The agents pickers offer (Demo only when turned on); every agent when absent. */
  shownAgents?(): AgentKey[];
  error(err: unknown): void;
}

export interface EditArgs {
  instruction?: string;
  agent?: AgentKey;
  uri?: vscode.Uri;
  range?: vscode.Range;
  kind?: SpanKind;
}

export interface AskArgs {
  question?: string;
  chatId?: string;
  uri?: vscode.Uri;
  range?: vscode.Range;
}

interface Target {
  editor: vscode.TextEditor;
  doc: vscode.TextDocument;
  /** Inside the workspace, checked by real location. */
  file: string;
}

/** An edit asked for from the editor, while its agent works on it. */
interface Session {
  chatId: string;
  /** "Claude", "format.ts": for the status bar. */
  name: string;
  file: string;
  /** Reviews this edit opened that wait for the user. */
  reviews: Set<string>;
  uri: vscode.Uri;
  range: vscode.Range;
  viewColumn?: vscode.ViewColumn;
  status: vscode.StatusBarItem;
  cancelled: boolean;
}

export class EditorAgent implements vscode.Disposable {
  private readonly chats: EditChats;
  private readonly sessions = new Map<string, Session>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('friedliver.agentEditBackground'),
    overviewRulerColor: new vscode.ThemeColor('progressBar.background'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: EditorHost,
  ) {
    this.chats = new EditChats(host.core);
    const command = (id: string, fn: (arg?: unknown) => unknown) => this.disposables.push(vscode.commands.registerCommand(id, fn));
    command('friedliver.editSelection', (arg) => this.edit(editArgs(arg)));
    command('friedliver.askSelection', (arg) => this.ask(askArgs(arg)));
    command('friedliver.addSelectionToChat', (arg) => this.addToChat(askArgs(arg)));
    command('friedliver.reviewChanges', (arg) => this.reviewChanges(arg));
    command('friedliver.edit.stop', (chatId) => typeof chatId === 'string' && this.stop(chatId));
    const unsubscribe = host.core.onAction((action) => this.onAction(action));
    this.disposables.push(
      this.decoration,
      { dispose: unsubscribe },
      vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new AgentCodeActions(), { providedCodeActionKinds: AgentCodeActions.kinds }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
    );
  }

  dispose(): void {
    for (const s of this.sessions.values()) s.status.dispose();
    this.sessions.clear();
    for (const d of this.disposables) d.dispose();
  }

  /** An edit asked for from the editor opens its diff where the user is looking, focused. */
  reviewPlacement(review: PendingReview): ReviewPlacement | undefined {
    const session = review.chatId ? this.sessions.get(review.chatId) : undefined;
    return session && { viewColumn: session.viewColumn, focus: true };
  }

  // ---- Edit with Agent ----

  async edit(args: EditArgs = {}): Promise<EditOutcome | undefined> {
    const target = await this.target(args.uri);
    if (!target) return undefined;
    let at = await this.locate(target, args.range, args.kind);
    let agent = args.agent ?? this.lastAgent();
    let instruction = args.instruction?.trim();
    if (!instruction) {
      const answer = await this.askInstruction(agent, refLabel(refOf(target.file, at.range)));
      if (!answer) return undefined;
      ({ agent, instruction } = answer);
    }
    void this.context.workspaceState.update(LAST_AGENT, agent);
    // The agent reads what is on screen, but the diff compares with the file on disk.
    if (target.doc.isDirty) {
      const version = target.doc.version;
      if (!(await target.doc.save())) {
        void vscode.window.showWarningMessage("Couldn't save the file, so the agent wasn't asked.");
        return undefined;
      }
      // Format on save may have moved the code; the editor's selection moved with it.
      if (target.doc.version !== version && !args.range) at = await this.locate(target);
    }
    let chat: ChatView;
    try {
      chat = await this.chats.chatFor(agent, instruction);
    } catch (err) {
      this.host.error(err);
      return undefined;
    }
    const ref = refOf(target.file, at.range);
    const context = editPrompt({ cwd: chat.cwd, file: target.file, languageId: target.doc.languageId, text: target.doc.getText(), span: at.range, kind: at.kind });
    const session = this.begin(chat, agent, target, at.range);
    let outcome: EditOutcome | undefined;
    try {
      outcome = await runEdit(this.host.core, chat, { instruction, context, ref });
    } catch (err) {
      this.host.error(err);
    } finally {
      this.end(chat.id);
    }
    // No diff came: the agent answered, or couldn't start. Show it in the chat.
    if (outcome && !session.cancelled && !outcome.reviews.length) await this.host.showChat(chat.id);
    return outcome;
  }

  /** "Describe the change", with the agent in the title; @agent or the button switches it. */
  private askInstruction(agent: AgentKey, where: string): Promise<{ agent: AgentKey; instruction: string } | undefined> {
    const box = vscode.window.createInputBox();
    const change: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('arrow-swap'), tooltip: 'Change Agent' };
    let chosen = agent;
    let switching = false;
    const refresh = () => {
      box.title = `Edit with ${AGENT_FACES[parseEditInput(box.value).agent ?? chosen].name} · ${where}`;
    };
    box.placeholder = 'Describe the change';
    box.prompt = EDIT_AGENT_HINT;
    box.buttons = [change];
    refresh();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: { agent: AgentKey; instruction: string } | undefined) => {
        if (settled) return;
        settled = true;
        resolve(value);
        box.dispose();
      };
      box.onDidChangeValue(() => {
        box.validationMessage = undefined;
        refresh();
      });
      box.onDidAccept(() => {
        const parsed = parseEditInput(box.value);
        if (!parsed.instruction) {
          box.validationMessage = 'Describe the change.';
          return;
        }
        finish({ agent: parsed.agent ?? chosen, instruction: parsed.instruction });
      });
      box.onDidTriggerButton(async () => {
        switching = true;
        const typed = box.value;
        box.hide();
        const picked = await this.pickAgent('Edit with which agent?', chosen);
        switching = false;
        if (picked) {
          chosen = picked;
          box.value = parseEditInput(typed).instruction;
        }
        refresh();
        box.show();
      });
      box.onDidHide(() => {
        if (!switching) finish(undefined);
      });
      box.show();
    });
  }

  private begin(chat: ChatView, agent: AgentKey, target: Target, range: vscode.Range): Session {
    const name = AGENT_FACES[agent].name;
    const file = path.basename(target.file);
    const status = vscode.window.createStatusBarItem(`friedliver.edit.${chat.id}`, vscode.StatusBarAlignment.Left, 0);
    status.name = 'FriedLiver edit';
    status.command = { command: 'friedliver.edit.stop', title: 'Stop', arguments: [chat.id] };
    const session: Session = { chatId: chat.id, name, file, reviews: new Set(), uri: target.doc.uri, range, viewColumn: target.editor.viewColumn, status, cancelled: false };
    this.sessions.set(chat.id, session);
    this.showStatus(session, refLabel(refOf(target.file, range)));
    status.show();
    this.decorate();
    return session;
  }

  /** "Claude is editing format.ts…", or, while its diff waits, "Review Claude's edit". A click stops the agent. */
  private showStatus(s: Session, where?: string): void {
    const mac = process.platform === 'darwin';
    if (s.reviews.size) {
      s.status.text = `$(diff) Review ${s.name}'s edit to ${s.file}`;
      s.status.tooltip = `Accept with ${mac ? 'Cmd' : 'Ctrl'}+Alt+Y, reject with ${mac ? 'Cmd' : 'Ctrl'}+Alt+N. Click to stop ${s.name}.`;
      s.status.accessibilityInformation = { label: `${s.name}'s edit to ${s.file} waits for your review. Activate to stop ${s.name}.` };
      return;
    }
    s.status.text = `$(loading~spin) ${s.name} is editing ${s.file}…`;
    s.status.tooltip = `${s.name} is working on ${where ?? s.file}. The edit opens as a diff for you to accept or reject. Click to stop.`;
    s.status.accessibilityInformation = { label: `${s.name} is editing ${s.file}. Activate to stop.` };
  }

  private end(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (!session) return;
    this.sessions.delete(chatId);
    session.status.dispose();
    this.decorate();
  }

  /** The status bar item's click: stops the chat, which also closes its diff. */
  private stop(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (session) session.cancelled = true;
    void this.host.core.cancel(chatId).catch((err: unknown) => this.host.error(err));
  }

  /** A subtle mark on the lines an agent is working on, in every editor showing them. */
  private decorate(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const ranges = [...this.sessions.values()].filter((s) => s.uri.toString() === editor.document.uri.toString()).map((s) => s.range);
      editor.setDecorations(this.decoration, ranges);
    }
  }

  /** Follows the edit's turn: its diffs for the status bar; a question or tool request is answered in the chat, so bring it up. */
  private onAction(action: Action): void {
    if (action.t === 'review') {
      for (const s of this.sessions.values()) if (s.reviews.delete(action.reviewId)) this.showStatus(s);
      return;
    }
    const session = action.t === 'items' ? this.sessions.get(action.chatId) : undefined;
    if (!session || action.t !== 'items') return;
    for (const item of action.items) {
      if (item.kind === 'review' && item.state === 'pending') {
        session.reviews.add(item.reviewId);
        this.showStatus(session);
      }
    }
    const asks = action.items.find((i) => i.kind === 'permission' || i.kind === 'bridge' || i.kind === 'question');
    if (asks && (asks.kind === 'permission' || asks.kind === 'bridge' || asks.kind === 'question') && !(asks.kind === 'permission' && asks.answer)) void this.host.showChat(action.chatId, asks.requestId);
  }

  // ---- Ask About Selection, Add Selection to Chat ----

  async ask(args: AskArgs = {}): Promise<void> {
    const target = await this.target(args.uri);
    if (!target) return;
    const at = await this.locate(target, args.range);
    const ref = refOf(target.file, at.range);
    let chat = (args.chatId ? this.host.core.chat(args.chatId) : undefined) ?? this.current(true) ?? (await this.pickChat('Ask which chat?', true));
    if (!chat) return;
    let question = args.question?.trim();
    if (!question) {
      const answer = await this.askQuestion(chat, refLabel(ref));
      if (!answer) return;
      ({ chat, question } = answer);
    }
    const context = referencesContext([referenceBlock(chat.cwd, ref, linesOf(target.doc, ref), target.doc.languageId)]);
    await this.host.showChat(chat.id);
    void this.host.core.send(chat.id, question, [], { context, refs: [ref] }).catch((err: unknown) => this.host.error(err));
  }

  private askQuestion(chat: ChatView, where: string): Promise<{ chat: ChatView; question: string } | undefined> {
    const box = vscode.window.createInputBox();
    const other: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('comment-discussion'), tooltip: 'Choose Another Chat' };
    let target = chat;
    let switching = false;
    const refresh = () => {
      box.title = `Ask ${chatRef(target)} about ${where}`;
    };
    box.placeholder = 'Ask a question';
    box.prompt = `Goes to “${target.title}” with the code.`;
    box.buttons = [other];
    refresh();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: { chat: ChatView; question: string } | undefined) => {
        if (settled) return;
        settled = true;
        resolve(value);
        box.dispose();
      };
      box.onDidChangeValue(() => (box.validationMessage = undefined));
      box.onDidAccept(() => {
        if (!box.value.trim()) {
          box.validationMessage = 'Type a question.';
          return;
        }
        finish({ chat: target, question: box.value.trim() });
      });
      box.onDidTriggerButton(async () => {
        switching = true;
        box.hide();
        const picked = await this.pickChat('Ask which chat?', true);
        switching = false;
        if (picked) {
          target = picked;
          box.prompt = `Goes to “${target.title}” with the code.`;
        }
        refresh();
        box.show();
      });
      box.onDidHide(() => {
        if (!switching) finish(undefined);
      });
      box.show();
    });
  }

  async addToChat(args: AskArgs = {}): Promise<void> {
    const target = await this.target(args.uri);
    if (!target) return;
    const at = await this.locate(target, args.range);
    const ref = refOf(target.file, at.range);
    const chat = (args.chatId ? this.host.core.chat(args.chatId) : undefined) ?? this.current(false) ?? (await this.pickChat('Add to which chat?', false));
    if (!chat) return;
    await this.host.showChat(chat.id);
    this.host.addToComposer(chat.id, ref);
  }

  /**
   * Code references in a message from the chat view: the current text of
   * those lines (unsaved edits included) goes to the agent with it. References
   * outside the workspace are dropped.
   */
  async referencesFor(chatId: string, refs: readonly CodeRef[]): Promise<SendOptions | undefined> {
    const chat = this.host.core.chat(chatId);
    if (!chat) return undefined;
    const kept: CodeRef[] = [];
    const blocks: string[] = [];
    for (const r of refs) {
      const file = insideRoots(r.path, this.host.core.roots());
      if (!file) continue;
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        const ref = { ...r, path: file };
        blocks.push(referenceBlock(chat.cwd, ref, linesOf(doc, ref), doc.languageId));
        kept.push(ref);
      } catch {
        // Deleted since, or not a text file.
      }
    }
    return kept.length ? { refs: kept, context: referencesContext(blocks) } : undefined;
  }

  /** Opens a file from a chat, with a reference's lines selected. `file` is checked already. */
  async open(file: string, line?: number, endLine?: number): Promise<void> {
    if (!line) {
      await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const last = Math.max(1, Math.min(endLine ?? line, doc.lineCount));
    const first = Math.max(1, Math.min(line, last));
    const selection = new vscode.Range(first - 1, 0, last - 1, doc.lineAt(last - 1).text.length);
    await vscode.window.showTextDocument(doc, { preview: true, selection });
  }

  // ---- Review My Changes ----

  /** Asks an agent to review the working tree's changes in a new chat. Resolves with that chat's id. */
  async reviewChanges(arg?: unknown): Promise<string | undefined> {
    const folder = this.reviewFolder(arg);
    if (!folder) {
      void vscode.window.showInformationMessage('Open a folder first. Agents work inside the folder you open.');
      return undefined;
    }
    let changes: Awaited<ReturnType<typeof collectChanges>>;
    try {
      changes = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Reading your changes…' }, () => collectChanges(folder));
    } catch (err) {
      this.host.error(err);
      return undefined;
    }
    if (!changes) {
      void vscode.window.showInformationMessage("This folder isn't a git repository, so there are no changes to review.");
      return undefined;
    }
    if (!changes.files.length) {
      void vscode.window.showInformationMessage('Nothing to review: nothing has changed since the last commit.');
      return undefined;
    }
    const given = arg && typeof arg === 'object' ? (arg as { agent?: unknown }).agent : undefined;
    const n = changes.files.length;
    const agent = isAgentKey(given) ? given : await this.pickAgent(`Review ${n} changed file${n === 1 ? '' : 's'} with…`, this.lastAgent());
    if (!agent) return undefined;
    const title = `Review: ${branchName(changes)}`;
    try {
      const chat = await this.host.core.createChat(agent, { title });
      await this.host.showChat(chat.id);
      void this.host.core.send(chat.id, reviewMessage(changes), [], { context: reviewPrompt(changes, chat.cwd), title }).catch((err: unknown) => this.host.error(err));
      return chat.id;
    } catch (err) {
      this.host.error(err);
      return undefined;
    }
  }

  /** The repository to review: the Source Control view's, the active file's folder, or the first folder. */
  private reviewFolder(arg: unknown): string | undefined {
    const roots = this.host.core.roots();
    const scm = arg && typeof arg === 'object' ? (arg as { rootUri?: unknown }).rootUri : undefined;
    if (scm instanceof vscode.Uri && scm.scheme === 'file') {
      // That repository, if it is the workspace or holds it (a repository opened from a parent folder).
      const root = scm.fsPath;
      if (insideRoots(root, roots) || roots.some((r) => insideRoots(r, [root]))) return root;
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    const folder = active && vscode.workspace.getWorkspaceFolder(active);
    if (folder?.uri.scheme === 'file') return folder.uri.fsPath;
    return roots[0];
  }

  // ---- Picking things ----

  /** The agent for edits: the last one used here, else friedliver.edit.defaultAgent from the user's settings. */
  lastAgent(): AgentKey {
    const remembered = this.context.workspaceState.get<unknown>(LAST_AGENT);
    if (usable(remembered)) return remembered;
    const { value } = userSetting(vscode.workspace.getConfiguration('friedliver.edit').inspect<unknown>('defaultAgent'));
    return usable(value) ? value : 'claude';
  }

  private async pickAgent(title: string, current?: AgentKey): Promise<AgentKey | undefined> {
    const order = [...(this.host.shownAgents?.() ?? AGENT_KEYS)].sort((a, b) => Number(b === current) - Number(a === current));
    const items = order.map((a) => ({
      label: AGENT_FACES[a].name,
      description: [a === 'codex' ? 'GPT' : '', a === current ? 'last used' : '', a === 'demo' ? 'fake local agent, no account' : ''].filter(Boolean).join(' · ') || undefined,
      agent: a,
    }));
    return (await vscode.window.showQuickPick(items, { title }))?.agent;
  }

  /** The chat on screen, if it can take the message. */
  private current(needIdle: boolean): ChatView | undefined {
    const id = this.host.currentChat();
    const chat = id ? this.host.core.chat(id) : undefined;
    return chat && !chat.archived && !(needIdle && chat.busy) ? chat : undefined;
  }

  /** An open chat, or a new one with the agent picked. */
  private async pickChat(title: string, needIdle: boolean): Promise<ChatView | undefined> {
    const core = this.host.core;
    const current = this.host.currentChat();
    const open = core.snapshot.chats
      .filter((c) => !c.archived)
      .sort((a, b) => Number(b.id === current) - Number(a.id === current) || b.lastActivity - a.lastActivity);
    type Pick = vscode.QuickPickItem & { chat?: ChatView; agent?: AgentKey };
    const items: Pick[] = [
      ...open.map((c) => ({ label: chatName(c), description: [agentName(c.agent), c.busy ? 'working' : ''].filter(Boolean).join(' · '), chat: c })),
      { label: 'New chat', kind: vscode.QuickPickItemKind.Separator },
      ...(this.host.shownAgents?.() ?? AGENT_KEYS).map((a) => ({ label: `$(add) New Chat with ${AGENT_FACES[a].name}`, description: a === 'demo' ? 'fake local agent, no account' : undefined, agent: a })),
    ];
    const picked = await vscode.window.showQuickPick(items, { title, matchOnDescription: true });
    if (picked?.chat) {
      const chat = core.chat(picked.chat.id);
      if (chat && needIdle && chat.busy) {
        void vscode.window.showInformationMessage(`${chatRef(chat)} is still working. Ask when it's done, or pick another chat.`);
        return undefined;
      }
      return chat;
    }
    if (!picked?.agent) return undefined;
    try {
      return await core.createChat(picked.agent);
    } catch (err) {
      this.host.error(err);
      return undefined;
    }
  }

  /** The file to work on: the given one or the active editor's, a file on disk inside the workspace. */
  private async target(uri?: vscode.Uri): Promise<Target | undefined> {
    // From the walkthrough or another non-text tab: the one file on screen, if there is just one.
    const visible = vscode.window.visibleTextEditors.filter((e) => e.document.uri.scheme === 'file');
    let editor = vscode.window.activeTextEditor ?? (visible.length === 1 ? visible[0] : undefined);
    if (uri && editor?.document.uri.toString() !== uri.toString()) {
      editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString()) ?? (await vscode.window.showTextDocument(uri));
    }
    if (!editor) {
      void vscode.window.showInformationMessage('Open a file and select some code first.');
      return undefined;
    }
    const doc = editor.document;
    if (doc.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage(
        doc.isUntitled ? 'Save the file in the open folder first: agents work on files on disk.' : 'Agents work on files in the open folder, not on this editor.',
      );
      return undefined;
    }
    const file = insideRoots(doc.uri.fsPath, this.host.core.roots());
    if (!file) {
      void vscode.window.showInformationMessage(
        this.host.core.roots().length ? 'This file is outside the open folder, so agents can’t work on it.' : 'Open a folder first. Agents work inside the folder you open.',
      );
      return undefined;
    }
    return { editor, doc, file };
  }

  /** The code to work on: the given range, the selection, else the function around the cursor, else its line. */
  private async locate(t: Target, range?: vscode.Range, kind?: SpanKind): Promise<{ range: vscode.Range; kind: SpanKind }> {
    if (range) return { range: kind && kind !== 'selection' ? fullLines(t.doc, range) : range, kind: kind ?? 'selection' };
    const sel = t.editor.selection;
    if (!sel.isEmpty) return { range: new vscode.Range(sel.start, sel.end), kind: 'selection' };
    const fn = await functionAt(t.doc, sel.active);
    if (fn && fn.end.line - fn.start.line < MAX_FUNCTION_LINES) return { range: fullLines(t.doc, fn), kind: 'function' };
    return { range: fullLines(t.doc, new vscode.Range(sel.active, sel.active)), kind: 'line' };
  }
}

/** "Fix with Agent" on errors and warnings at the cursor, "Explain with Agent" on a selection. No work until one is picked. */
class AgentCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix, EXPLAIN];

  provideCodeActions(doc: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext): vscode.CodeAction[] {
    if (doc.uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(doc.uri)) return [];
    const out: vscode.CodeAction[] = [];
    if (wants(context, vscode.CodeActionKind.QuickFix)) {
      const problems = context.diagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning).slice(0, 3);
      for (const d of problems) {
        const title = problems.length > 1 ? `Fix with Agent: ${clip(d.message, 50)}` : 'Fix with Agent';
        const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [d];
        const code = typeof d.code === 'object' ? d.code.value : d.code;
        const instruction = problemInstruction({ severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning', message: d.message, source: d.source, code });
        action.command = { command: 'friedliver.editSelection', title, arguments: [{ uri: doc.uri, range: d.range, kind: 'problem', instruction } satisfies EditArgs] };
        out.push(action);
      }
    }
    if (!range.isEmpty && wants(context, EXPLAIN)) {
      const action = new vscode.CodeAction('Explain with Agent', EXPLAIN);
      action.command = { command: 'friedliver.askSelection', title: 'Explain with Agent', arguments: [{ uri: doc.uri, range: new vscode.Range(range.start, range.end), question: 'Explain this code.' } satisfies AskArgs] };
      out.push(action);
    }
    return out;
  }
}

function wants(context: vscode.CodeActionContext, kind: vscode.CodeActionKind): boolean {
  return !context.only || context.only.contains(kind) || kind.contains(context.only);
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function refOf(file: string, range: vscode.Range): CodeRef {
  return { path: file, ...lineSpan(range) };
}

/** Whole lines from the start of `range`'s first line to the end of its last. */
function fullLines(doc: vscode.TextDocument, range: vscode.Range): vscode.Range {
  const last = Math.min(range.end.line, doc.lineCount - 1);
  return new vscode.Range(range.start.line, 0, last, doc.lineAt(last).text.length);
}

/** A reference's lines as the document has them now. */
function linesOf(doc: vscode.TextDocument, ref: CodeRef): string {
  const last = Math.min(ref.endLine, doc.lineCount);
  const first = Math.min(ref.startLine, last);
  return doc.getText(new vscode.Range(first - 1, 0, last - 1, doc.lineAt(last - 1).text.length));
}

const FUNCTIONS = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor]);

/** The innermost function or method around `pos`, from the language's outline; nothing if it is slow or absent. */
async function functionAt(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Range | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let symbols: unknown;
  try {
    symbols = await Promise.race([
      vscode.commands.executeCommand<unknown>('vscode.executeDocumentSymbolProvider', doc.uri),
      new Promise((resolve) => (timer = setTimeout(() => resolve(undefined), SYMBOLS_TIMEOUT_MS))),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
  if (!Array.isArray(symbols)) return undefined;
  let best: vscode.Range | undefined;
  const walk = (list: readonly unknown[]) => {
    for (const s of list as { kind?: vscode.SymbolKind; range?: vscode.Range; location?: vscode.Location; children?: unknown[] }[]) {
      const r = s.range ?? s.location?.range;
      if (!(r instanceof vscode.Range) || !r.contains(pos)) continue;
      if (s.kind !== undefined && FUNCTIONS.has(s.kind) && (!best || best.contains(r))) best = r;
      if (Array.isArray(s.children)) walk(s.children);
    }
  };
  walk(symbols);
  return best;
}

function rangeOf(v: unknown): vscode.Range | undefined {
  if (v instanceof vscode.Range) return v;
  const r = v as { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } } | undefined;
  const n = (x: unknown) => typeof x === 'number' && Number.isInteger(x) && x >= 0;
  if (r && n(r.start?.line) && n(r.start?.character) && n(r.end?.line) && n(r.end?.character)) {
    return new vscode.Range(r.start!.line as number, r.start!.character as number, r.end!.line as number, r.end!.character as number);
  }
  return undefined;
}

/** Arguments from a code action or a test; a menu passes the file's URI, which says nothing more than the active editor. */
function editArgs(arg: unknown): EditArgs {
  if (!arg || typeof arg !== 'object' || arg instanceof vscode.Uri) return {};
  const a = arg as Record<string, unknown>;
  const kinds: SpanKind[] = ['selection', 'function', 'line', 'problem'];
  return {
    instruction: typeof a.instruction === 'string' ? a.instruction : undefined,
    agent: isAgentKey(a.agent) ? a.agent : undefined,
    uri: a.uri instanceof vscode.Uri ? a.uri : undefined,
    range: rangeOf(a.range),
    kind: kinds.find((k) => k === a.kind),
  };
}

function askArgs(arg: unknown): AskArgs {
  if (!arg || typeof arg !== 'object' || arg instanceof vscode.Uri) return {};
  const a = arg as Record<string, unknown>;
  return {
    question: typeof a.question === 'string' ? a.question : undefined,
    chatId: typeof a.chatId === 'string' ? a.chatId : undefined,
    uri: a.uri instanceof vscode.Uri ? a.uri : undefined,
    range: rangeOf(a.range),
  };
}
