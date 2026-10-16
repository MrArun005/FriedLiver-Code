import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import type { VendorAgentId } from '@friedliver/main/agents/registry';
import { Accounts } from './host/accounts';
import { ActionBatcher } from './host/batch';
import type { AgentToAgent } from './host/bridgeRequests';
import { registerBeforeProvider, viewChanges } from './host/changes';
import { AgentCore, VENDOR_AGENTS, messageOf } from './host/core';
import { commandNotice, plainText } from './host/notify';
import { insideRoots } from './host/paths';
import { StateFile } from './host/persist';
import { ReviewUi } from './host/review';
import { userSetting } from './host/settings';
import { installCommandFor } from './host/signin';
import { startUpdateChecks } from './host/updates';
import { attachSurface, post, type Script, type Surface } from './host/webviews';
import { LIMITS, type Attachment, type WebviewMessage } from './shared/messages';
import { AGENT_FACES, AGENT_KEYS, isAgentKey, type Action, type AgentKey, type ChatView, type NoticeAction } from './shared/model';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

let controller: Controller | undefined;

export async function activate(context: vscode.ExtensionContext) {
  controller = new Controller(context);
  await controller.start();
  context.subscriptions.push(startUpdateChecks(context, controller.log));
  void revealOnFirstStart(context);
  // Integration tests drive the same controller the views use.
  return context.extensionMode === vscode.ExtensionMode.Test ? controller : undefined;
}

/**
 * In the FriedLiver fork, a folder opened for the first time restores the right side bar to
 * upstream's chat container, which is empty there, so the bar shows blank. Open the Agents
 * panel instead, once per folder; the editor remembers it after that. Other editors keep the
 * panel in the activity bar: show it once after install so people find it.
 */
async function revealOnFirstStart(context: vscode.ExtensionContext): Promise<void> {
  if (context.extensionMode === vscode.ExtensionMode.Test) return;
  const fork = vscode.env.appName.startsWith('FriedLiver');
  const store = fork && vscode.workspace.workspaceFolders ? context.workspaceState : context.globalState;
  if (store.get<boolean>('friedliver.revealed')) return;
  await store.update('friedliver.revealed', true);
  await vscode.commands.executeCommand('workbench.view.extension.friedliver');
  // Opening the container takes focus; give it back to the file being edited.
  if (vscode.window.activeTextEditor) await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
}

export async function deactivate(): Promise<void> {
  await controller?.dispose();
  controller = undefined;
}

/** Connects the agent core to VS Code: views, panels, diff review, notifications, settings. */
export class Controller {
  readonly core: AgentCore;
  readonly reviews: ReviewUi;
  readonly accounts: Accounts;
  readonly log = vscode.window.createOutputChannel('FriedLiver Agents', { log: true });
  private readonly surfaces = new Set<Surface>();
  private readonly statusItem = vscode.window.createStatusBarItem('friedliver.decisions', vscode.StatusBarAlignment.Right, 100);
  private agentsView?: vscode.WebviewView;
  private chatPanel?: vscode.WebviewPanel;
  private tasksPanel?: vscode.WebviewPanel;
  /** The chat last shown anywhere, so moving between side and center keeps it. */
  private lastSelected?: string;
  private agentConfig = this.readAgentConfig();
  private readonly asked = new Set<string>();
  /** Open notifications for waiting decisions, closed once the decision is made anywhere. */
  private readonly notified = new Map<string, () => void>();
  /** Commands whose open notification offers Run; the Run link approves nothing else. */
  private readonly runnable = new Set<string>();
  /** Actions on their way to the webviews, sent in batches while agents stream. */
  private readonly batcher = new ActionBatcher((actions) => this.sendActions(actions));
  /** This folder's saved chats; unset when restoring is off or no folder is open. */
  private stateFile?: StateFile;
  private warnedAgentToAgent = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.accounts = new Accounts(
      context.secrets,
      () => this.core,
      () => this.folders()[0],
      (agent) => void this.core.reconfigure([agent]),
    );
    this.core = new AgentCore({
      folders: () => this.folders(),
      clientVersion: String(context.extension.packageJSON.version ?? '0.0.0'),
      demoAgentScript: context.asAbsolutePath(path.join('dist', 'demo-agent.js')),
      bridgeScript: context.asAbsolutePath(path.join('dist', 'bridge.js')),
      agentToAgent: () => this.agentToAgent(),
      agentCommand: (id) => this.agentConfig[id],
      apiKey: (id) => this.accounts.apiKey(id),
      limits: () => {
        const c = vscode.workspace.getConfiguration('friedliver');
        return { maxRunning: clamp(c.get<number>('maxRunningAgents', 2), 1, 6), idleStopMinutes: clamp(c.get<number>('idleStopMinutes', 10), 0, 240) };
      },
      log: (line) => this.log.info(line),
      ui: {
        showReview: (review) => void this.reviews.show(review),
        closeReview: (id) => void this.reviews.close(id),
        askCommand: (ask) => void this.askCommand(ask),
        askPermission: (ask) => void this.askPermission(ask),
        askBridge: (ask) => void this.askBridge(ask),
        signInUrl: (agent, url) => void this.offerSignInUrl(agent, url),
        unsavedText: (file) => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === file && d.isDirty)?.getText(),
      },
    });
    this.reviews = new ReviewUi(() => this.core);
    this.statusItem.name = 'FriedLiver decisions';
    this.statusItem.command = 'friedliver.nextDecision';
    this.statusItem.color = new vscode.ThemeColor('friedliver.decision');
  }

  async start(): Promise<void> {
    const { context } = this;
    await this.accounts.loadKeys();
    // Before any view asks for a snapshot, so restored chats are in the first one.
    await this.openStateFile(true);
    const command = (id: string, fn: (...args: never[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

    context.subscriptions.push(
      this.log,
      this.statusItem,
      this.reviews,
      this.accounts,
      vscode.window.registerTreeDataProvider('friedliver.accounts', this.accounts),
      vscode.window.registerWebviewViewProvider(
        'friedliver.agents',
        { resolveWebviewView: (view) => this.resolveView(view, 'chat', 'Agents') },
        { webviewOptions: { retainContextWhenHidden: false } },
      ),
      vscode.window.registerWebviewViewProvider('friedliver.images', { resolveWebviewView: (view) => this.resolveView(view, 'images', 'Images') }),
      vscode.window.registerWebviewPanelSerializer('friedliver.tasks', { deserializeWebviewPanel: async (panel) => this.adoptPanel(panel, 'tasks') }),
      vscode.window.registerWebviewPanelSerializer('friedliver.chatPanel', { deserializeWebviewPanel: async (panel) => this.adoptPanel(panel, 'chat') }),
      vscode.workspace.onDidChangeConfiguration((e) => this.onConfig(e)),
      registerBeforeProvider(() => this.core),
    );
    const unsubscribe = this.core.onAction((action) => {
      this.batcher.push(action);
      this.stateFile?.schedule();
    });
    context.subscriptions.push({ dispose: unsubscribe });

    command('friedliver.newChat', (agent?: unknown) => this.newChat(isAgentKey(agent) ? agent : undefined));
    command('friedliver.moveToCenter', () => this.moveToCenter());
    command('friedliver.moveToSide', () => this.moveToSide());
    command('friedliver.openTasks', () => this.openTasks());
    command('friedliver.nextDecision', () => this.nextDecision());
    command('friedliver.review.accept', (reviewId?: unknown) => {
      if (!this.reviews.accept(typeof reviewId === 'string' ? reviewId : undefined)) void vscode.window.showInformationMessage('No agent edit is waiting here.');
    });
    command('friedliver.review.reject', (reviewId?: unknown) => {
      if (!this.reviews.reject(typeof reviewId === 'string' ? reviewId : undefined)) void vscode.window.showInformationMessage('No agent edit is waiting here.');
    });
    command('friedliver.accounts', () => this.accounts.pickAndCheck());
    command('friedliver.accounts.check', (node?: { agent?: unknown }) => {
      if (isAgentKey(node?.agent)) void this.accounts.check(node.agent);
      else void this.accounts.pickAndCheck();
    });
    command('friedliver.signIn', (agent: unknown, methodId: unknown) => {
      if (isAgentKey(agent) && typeof methodId === 'string') void this.accounts.signIn(agent, methodId);
    });
    command('friedliver.setApiKey', (node?: { agent?: unknown }) =>
      this.accounts.setApiKey(VENDOR_AGENTS.find((a) => a === node?.agent)),
    );
    command('friedliver.stopAgents', () => this.core.stopAll());
    // Targets of the links in decision notifications.
    command('friedliver.command.approve', (id: unknown) => typeof id === 'string' && this.runnable.has(id) && this.core.decideCommand(id, true));
    command('friedliver.command.deny', (id: unknown) => typeof id === 'string' && this.core.decideCommand(id, false));
    command('friedliver.command.show', (chatId: unknown, itemId: unknown) => {
      if (typeof chatId === 'string' && typeof itemId === 'string') void this.showChat(chatId, itemId);
    });
    command('friedliver.bridge.answer', (requestId: unknown, answer: unknown) => {
      if (typeof requestId === 'string' && (answer === 'allow' || answer === 'allowChat' || answer === 'deny')) this.core.answerBridge(requestId, answer);
    });
    command('friedliver.handoff', (chatId?: unknown) => this.handoffCommand(typeof chatId === 'string' ? chatId : undefined));
    command('friedliver.consult', (chatId?: unknown) => this.consultCommand(typeof chatId === 'string' ? chatId : undefined));
    command('friedliver.fanout', () => this.fanoutCommand());
    command('friedliver.pipe', (chatId?: unknown) => this.pipeCommand(typeof chatId === 'string' ? chatId : undefined));
    this.updateDecisions();
  }

  async dispose(): Promise<void> {
    // Save before the core shuts down: stopping cancels running turns, and a
    // restored chat should read "stopped when the window closed", not "cancelled".
    await this.stateFile?.flush();
    this.stateFile?.stop();
    this.batcher.dispose();
    await this.core.dispose();
  }

  /** Brings back this folder's chats (once, at startup) and saves them from then on. */
  private async openStateFile(restore: boolean): Promise<void> {
    const dir = this.context.storageUri?.fsPath;
    if (!dir) return;
    const file = new StateFile(path.join(dir, 'chats.json'), () => this.core.exportState(), (line) => this.log.warn(line));
    if (!vscode.workspace.getConfiguration('friedliver').get<boolean>('restoreChats', true)) {
      // Turned off while the window was closed: nothing stays on disk.
      await file.clear();
      return;
    }
    if (restore) {
      const saved = await file.load();
      if (saved?.state.chats.length) {
        try {
          this.core.restore(saved);
        } catch (err) {
          this.log.warn(`Couldn't restore chats: ${messageOf(err)}`);
        }
      }
    }
    this.stateFile = file;
  }

  private sendActions(actions: Action[]): void {
    const message = actions.length === 1 ? ({ type: 'action', action: actions[0] } as const) : ({ type: 'actions', actions } as const);
    for (const s of this.surfaces) post(s, message);
    this.updateDecisions();
    this.closeAnswered();
  }

  folders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
  }

  // ---- Surfaces ----

  private resolveView(view: vscode.WebviewView, kind: Script, title: string): void {
    const surface: Surface = {
      kind,
      webview: view.webview,
      selected: kind === 'chat' ? this.lastSelected : undefined,
      ready: false,
      visible: () => view.visible,
      reveal: () => view.show(true),
    };
    if (kind === 'chat') this.agentsView = view;
    this.addSurface(surface, title, view);
    this.updateDecisions();
  }

  private adoptPanel(panel: vscode.WebviewPanel, kind: Script): void {
    const surface: Surface = {
      kind,
      webview: panel.webview,
      selected: kind === 'chat' ? this.lastSelected : undefined,
      ready: false,
      visible: () => panel.visible,
      reveal: () => panel.reveal(),
    };
    if (kind === 'chat') this.chatPanel = panel;
    else this.tasksPanel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'agents.svg');
    this.addSurface(surface, panel.title, panel);
    panel.onDidDispose(() => {
      if (this.chatPanel === panel) this.chatPanel = undefined;
      if (this.tasksPanel === panel) this.tasksPanel = undefined;
    });
  }

  private addSurface(surface: Surface, title: string, owner: { onDidDispose: vscode.Event<void> }): void {
    this.surfaces.add(surface);
    const sub = attachSurface(surface, this.context.extensionUri, title, (s, m) => void this.handle(s, m), (line) => this.log.warn(line));
    owner.onDidDispose(() => {
      sub.dispose();
      this.surfaces.delete(surface);
      if (surface.webview === this.agentsView?.webview) this.agentsView = undefined;
    });
  }

  private chatSurfaces(): Surface[] {
    return [...this.surfaces].filter((s) => s.kind === 'chat');
  }

  /** Shows a chat where the user is looking: the center panel if open, else the side view. */
  private async showChat(chatId: string, revealItem?: string): Promise<void> {
    this.lastSelected = chatId;
    const center = this.chatSurfaces().find((s) => s.webview === this.chatPanel?.webview);
    if (center) center.reveal();
    else await vscode.commands.executeCommand('friedliver.agents.focus');
    for (const s of this.chatSurfaces()) {
      s.selected = chatId;
      post(s, { type: 'select', chatId });
      if (revealItem) post(s, { type: 'reveal', chatId, id: revealItem });
    }
  }

  // ---- Messages from webviews (already validated) ----

  async handle(surface: Surface, m: WebviewMessage): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          // Queued actions are already in the snapshot: send them first, while this surface isn't ready, so it never gets them twice.
          this.batcher.flush();
          surface.ready = true;
          post(surface, { type: 'snapshot', state: this.core.snapshot, selected: surface.selected ?? this.lastSelected, now: Date.now() });
          return;
        case 'newChat':
          await this.newChat(m.agent, surface);
          return;
        case 'select':
          surface.selected = m.chatId;
          this.lastSelected = m.chatId;
          return;
        case 'send':
          void this.core.send(m.chatId, m.text, m.images).catch((err: unknown) => this.error(err));
          return;
        case 'stop':
          await this.core.cancel(m.chatId);
          return;
        case 'permission':
          this.core.answerPermission(m.requestId, m.optionId);
          return;
        case 'review':
          if (m.action === 'open') await this.reviews.open(m.reviewId);
          else if (m.action === 'accept') this.reviews.accept(m.reviewId);
          else this.reviews.reject(m.reviewId);
          return;
        case 'command':
          this.core.decideCommand(m.commandId, m.approve);
          return;
        case 'undo': {
          const files = await this.core.undo(m.chatId, m.turnId);
          void vscode.window.showInformationMessage(`Restored ${files.length} file${files.length === 1 ? '' : 's'}.`);
          return;
        }
        case 'notice':
          await this.noticeAction(m.chatId, m.action);
          return;
        case 'attach':
          post(surface, { type: 'attached', images: await this.pickImages() });
          return;
        case 'openFile': {
          const file = insideRoots(m.path, this.core.roots());
          if (file) await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
          return;
        }
        case 'createTask': {
          const chat = await this.core.createChat(m.agent, { worktree: m.worktree, title: m.prompt });
          void this.core.send(chat.id, m.prompt).catch((err: unknown) => this.error(err));
          return;
        }
        case 'openChat':
          await this.showChat(m.chatId);
          return;
        case 'merge':
          await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Merging the task into the main checkout…' }, () =>
            this.core.merge(m.chatId),
          );
          void vscode.window.showInformationMessage('Merged into the main checkout.');
          return;
        case 'removeWorktree': {
          const ok = await vscode.window.showWarningMessage(
            'Delete this task’s worktree and branch? Unmerged work in it is lost.',
            { modal: true },
            'Delete worktree',
          );
          if (ok) await this.core.removeWorktree(m.chatId);
          return;
        }
        case 'moveToCenter':
          await this.moveToCenter();
          return;
        case 'openTasks':
          this.openTasks();
          return;
        case 'handoff': {
          const chat = await this.core.handoff(m.chatId, m.agent);
          this.selectOn(surface, chat.id);
          return;
        }
        case 'consult':
          void this.core.consult(m.chatId, m.agent, m.text).catch((err: unknown) => this.error(err));
          return;
        case 'pipe':
          this.core.pipe(m.from, m.to);
          return;
        case 'unlink':
          this.core.unlink(m.linkId);
          return;
        case 'forward':
          void this.core.forward(m.fromChatId, m.toChatId).catch((err: unknown) => this.error(err));
          return;
        case 'fanout':
          await this.fanout(m.agents, m.prompt, m.worktree);
          return;
        case 'bridge':
          this.core.answerBridge(m.requestId, m.answer);
          return;
        case 'archive':
          this.core.archive(m.chatId, m.archived);
          return;
        case 'removeChat':
          await this.core.removeChat(m.chatId);
          return;
        case 'viewChanges':
          await viewChanges(this.core, m.chatId);
          return;
      }
    } catch (err) {
      this.error(err);
    }
  }

  /** Shows a chat on the surface that asked for it. */
  private selectOn(surface: Surface, chatId: string): void {
    surface.selected = chatId;
    this.lastSelected = chatId;
    post(surface, { type: 'select', chatId });
  }

  private async noticeAction(chatId: string, action: NoticeAction): Promise<void> {
    const retry = () => void this.core.retry(chatId).catch((err: unknown) => this.error(err));
    switch (action.do) {
      case 'retry':
        retry();
        return;
      case 'signIn':
        await this.accounts.signIn(action.agent, action.methodId, retry);
        return;
      case 'apiKey':
        if (action.agent !== 'demo') await this.accounts.setApiKey(action.agent);
        return;
      case 'install': {
        // FriedLiver's own install line for that agent, typed but not run: the user reads it and
        // presses Enter. It has no line break, so typing it can't run anything by itself.
        const line = installCommandFor(action.agent);
        if (!line) return;
        const terminal = vscode.window.createTerminal({ name: 'Install agent', cwd: this.folders()[0] });
        terminal.show();
        terminal.sendText(line, false);
        return;
      }
    }
  }

  // ---- Commands ----

  async newChat(agent?: AgentKey, surface?: Surface): Promise<string | undefined> {
    const chosen =
      agent ??
      (
        await vscode.window.showQuickPick(
          AGENT_KEYS.map((a) => ({ label: AGENT_FACES[a].name, description: a === 'demo' ? 'offline, no sign-in' : undefined, agent: a })),
          { title: 'New chat with…' },
        )
      )?.agent;
    if (!chosen) return undefined;
    try {
      const chat = await this.core.createChat(chosen);
      if (surface) this.selectOn(surface, chat.id);
      else await this.showChat(chat.id);
      return chat.id;
    } catch (err) {
      this.error(err);
      return undefined;
    }
  }

  async moveToCenter(): Promise<void> {
    if (this.chatPanel) {
      this.chatPanel.reveal();
    } else {
      const panel = vscode.window.createWebviewPanel('friedliver.chatPanel', 'Agents', vscode.ViewColumn.Active, { retainContextWhenHidden: false });
      this.adoptPanel(panel, 'chat');
    }
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  }

  async moveToSide(): Promise<void> {
    this.chatPanel?.dispose();
    await vscode.commands.executeCommand('friedliver.agents.focus');
  }

  openTasks(): void {
    if (this.tasksPanel) {
      this.tasksPanel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('friedliver.tasks', 'Agent Manager', vscode.ViewColumn.Active, { retainContextWhenHidden: false });
    this.adoptPanel(panel, 'tasks');
  }

  // ---- Connections ----

  async handoffCommand(chatId?: string): Promise<void> {
    const source = await this.pickChat('Hand off which chat?', chatId);
    if (!source) return;
    const agent = await this.pickAgent(`Continue “${source.title}” with…`, source.agent);
    if (!agent) return;
    try {
      const chat = await this.core.handoff(source.id, agent);
      await this.showChat(chat.id);
    } catch (err) {
      this.error(err);
    }
  }

  async consultCommand(chatId?: string): Promise<void> {
    const source = await this.pickChat('Ask from which chat?', chatId);
    if (!source) return;
    const agent = await this.pickAgent('Ask which agent?', source.agent);
    if (!agent) return;
    const text = await vscode.window.showInputBox({
      title: `Ask ${AGENT_FACES[agent].name}`,
      prompt: `The answer comes back into ${source.label}.`,
      validateInput: (v) => (v.trim() ? undefined : 'Type a question.'),
    });
    if (!text?.trim()) return;
    void this.core.consult(source.id, agent, text).catch((err: unknown) => this.error(err));
    await this.showChat(source.id);
  }

  /** "Run a Task on Several Agents": one prompt, a chat per agent, to compare. */
  async fanoutCommand(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      AGENT_KEYS.map((a) => ({ label: AGENT_FACES[a].name, description: a === 'demo' ? 'offline, no sign-in' : undefined, agent: a, picked: a !== 'demo' })),
      { title: 'Run a task on which agents?', canPickMany: true },
    );
    if (!picked?.length) return;
    const prompt = await vscode.window.showInputBox({ title: 'Run a Task on Several Agents', prompt: 'Each agent gets this same message.', validateInput: (v) => (v.trim() ? undefined : 'Describe the task.') });
    if (!prompt?.trim()) return;
    const where = await vscode.window.showQuickPick(
      [
        { label: 'Each in Its Own Worktree', description: 'separate git branches, so their edits never mix', worktree: true },
        { label: 'All in This Folder', description: 'they may edit the same files', worktree: false },
      ],
      { title: 'Where should they work?' },
    );
    if (!where) return;
    await this.fanout(
      picked.map((p) => p.agent),
      prompt,
      where.worktree,
    );
  }

  private async fanout(agents: AgentKey[], prompt: string, worktree: boolean): Promise<void> {
    try {
      // Resolves once the chats exist; their turns run on, and the board shows them side by side.
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Starting ${agents.length} agents…` }, () =>
        this.core.fanout(agents.slice(0, LIMITS.fanout), prompt, worktree),
      );
      this.openTasks();
    } catch (err) {
      this.error(err);
    }
  }

  async pipeCommand(chatId?: string): Promise<void> {
    const from = await this.pickChat('Pipe which chat’s replies?', chatId);
    if (!from) return;
    const to = await this.pickChat(`Send each reply from ${from.label} to…`, undefined, from.id);
    if (!to) return;
    try {
      this.core.pipe(from.id, to.id);
      void vscode.window.showInformationMessage(`Each reply from ${from.label} now goes to ${to.label}.`);
    } catch (err) {
      this.error(err);
    }
  }

  /** The given chat, else the one on screen if the caller didn't need a choice, else the user's pick. */
  private async pickChat(title: string, chatId?: string, exclude?: string): Promise<ChatView | undefined> {
    const given = chatId ? this.core.chat(chatId) : undefined;
    if (given) return given;
    const chats = this.core.snapshot.chats.filter((c) => !c.archived && c.id !== exclude);
    if (!chats.length) {
      void vscode.window.showInformationMessage(exclude ? 'Start another chat first.' : 'Start a chat first.');
      return undefined;
    }
    const items = chats
      .map((c) => ({ label: c.label, description: c.title, chat: c }))
      .sort((a, b) => (b.chat.id === this.lastSelected ? 1 : 0) - (a.chat.id === this.lastSelected ? 1 : 0));
    return (await vscode.window.showQuickPick(items, { title }))?.chat;
  }

  /** Another agent first: these commands are for reaching a different one. */
  private async pickAgent(title: string, current: AgentKey): Promise<AgentKey | undefined> {
    const order = [...AGENT_KEYS.filter((a) => a !== current && a !== 'demo'), ...AGENT_KEYS.filter((a) => a === current || a === 'demo')];
    return (
      await vscode.window.showQuickPick(
        order.map((a) => ({ label: AGENT_FACES[a].name, description: a === current ? 'same agent' : a === 'demo' ? 'offline, no sign-in' : undefined, agent: a })),
        { title },
      )
    )?.agent;
  }

  /** Jumps to the oldest thing an agent is waiting on: a diff to review, a command or a question. */
  async nextDecision(): Promise<void> {
    const next = this.core.decisions()[0];
    if (!next) {
      void vscode.window.showInformationMessage('Nothing is waiting for you.');
      return;
    }
    if (next.kind === 'review') await this.reviews.open(next.id);
    else await this.showChat(next.chatId, next.id);
  }

  private updateDecisions(): void {
    const waiting = this.core.decisions();
    const n = waiting.length;
    if (n === 0) {
      this.statusItem.hide();
    } else {
      this.statusItem.text = `$(bell-dot) ${n} decision${n === 1 ? '' : 's'} waiting`;
      this.statusItem.tooltip = new vscode.MarkdownString(['**Agents are waiting for you**', ...waiting.map((d) => `- ${d.title.replace(/[\\`*_[\]<>]/g, '\\$&')}`)].join('\n'));
      this.statusItem.accessibilityInformation = { label: `${n} agent decision${n === 1 ? '' : 's'} waiting. Go to the next one.` };
      this.statusItem.show();
    }
    // A zero badge hides it; clearing with undefined can leave the old count on the container.
    if (this.agentsView) this.agentsView.badge = { value: n, tooltip: n ? `${n} decision${n === 1 ? '' : 's'} waiting` : '' };
  }

  // ---- Asking the user ----

  /**
   * Commands are asked in the transcript and with a notification; whichever
   * answers first wins. A progress notification, unlike a message, can be
   * closed from code, so it goes away once the command is answered anywhere.
   * Cancel denies.
   */
  private askCommand(ask: { chatId?: string; commandId: string; agentLabel: string; commandLine: string }): Promise<void> {
    // Run only when the notification shows the whole command as it will run; otherwise it's
    // approved in the chat, where it shows in full.
    const shown = commandNotice(ask.commandLine);
    const links = [
      ...(shown.runnable ? [`[Run](${commandLink('friedliver.command.approve', ask.commandId)})`] : []),
      `[Deny](${commandLink('friedliver.command.deny', ask.commandId)})`,
      ...(ask.chatId ? [`[Show](${commandLink('friedliver.command.show', ask.chatId, ask.commandId)})`] : []),
    ];
    const title = `${plainText(ask.agentLabel)} wants to run ${shown.text}${shown.runnable ? '' : ' (open the chat to see all of it)'}`;
    if (shown.runnable) this.runnable.add(ask.commandId);
    return this.waitingNotification(ask.commandId, title, links.join(' · '), () => this.core.decideCommand(ask.commandId, false)).finally(() =>
      this.runnable.delete(ask.commandId),
    );
  }

  /** Questions show in the transcript; a notification only when no chat view is on screen. */
  private askPermission(ask: { chatId: string; requestId: string; agentLabel: string; title: string }): Promise<void> {
    if (this.chatSurfaces().some((s) => s.visible())) return Promise.resolve();
    const show = `[Show](${commandLink('friedliver.command.show', ask.chatId, ask.requestId)})`;
    return this.waitingNotification(ask.requestId, `${plainText(ask.agentLabel)} asks: ${plainText(ask.title)}`, show, () => {});
  }

  /** Like questions: shown in the chat, with a notification only when no chat view is on screen. */
  private askBridge(ask: { chatId: string; requestId: string; title: string }): Promise<void> {
    if (this.chatSurfaces().some((s) => s.visible())) return Promise.resolve();
    const links = [
      `[Allow](${commandLink('friedliver.bridge.answer', ask.requestId, 'allow')})`,
      `[Deny](${commandLink('friedliver.bridge.answer', ask.requestId, 'deny')})`,
      `[Show](${commandLink('friedliver.command.show', ask.chatId, ask.requestId)})`,
    ];
    return this.waitingNotification(ask.requestId, plainText(ask.title), links.join(' · '), () => {});
  }

  private waitingNotification(id: string, title: string, message: string, onCancel: () => void): Promise<void> {
    return Promise.resolve(
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) => {
        progress.report({ message });
        return new Promise<void>((resolve) => {
          this.notified.set(id, resolve);
          token.onCancellationRequested(() => {
            onCancel();
            resolve();
          });
          // Answered before the notification even showed.
          if (!this.core.decisions().some((d) => d.id === id)) resolve();
        }).finally(() => this.notified.delete(id));
      }),
    );
  }

  /** Closes notifications for decisions that were made in a view, the board or the diff editor. */
  private closeAnswered(): void {
    if (this.notified.size === 0) return;
    const open = new Set(this.core.decisions().map((d) => d.id));
    for (const [id, close] of this.notified) if (!open.has(id)) close();
  }

  private async offerSignInUrl(agent: AgentKey, url: string): Promise<void> {
    if (this.asked.has(url)) return;
    this.asked.add(url);
    const open = await vscode.window.showInformationMessage(`${AGENT_FACES[agent].name} printed a sign-in link.`, 'Open sign-in page');
    if (open) await vscode.env.openExternal(vscode.Uri.parse(url, true));
  }

  private async pickImages(): Promise<Attachment[]> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach',
      filters: { Images: Object.keys(IMAGE_MIME) },
      defaultUri: this.folders()[0] ? vscode.Uri.file(this.folders()[0]) : undefined,
    });
    const out: Attachment[] = [];
    for (const uri of picked ?? []) {
      const mimeType = IMAGE_MIME[path.extname(uri.fsPath).slice(1).toLowerCase()];
      if (!mimeType || (await stat(uri.fsPath)).size > MAX_IMAGE_BYTES) continue;
      out.push({ name: path.basename(uri.fsPath), mimeType, data: (await readFile(uri.fsPath)).toString('base64') });
    }
    return out;
  }

  // ---- Settings ----

  /** From the user's own settings only: a repository must not choose the program run as an agent. */
  private readAgentConfig(): Record<VendorAgentId, { command: string; args: string[] }> {
    const c = vscode.workspace.getConfiguration('friedliver.agents');
    const read = <T>(key: string): T | undefined => {
      const { value, ignored } = userSetting(c.inspect<T>(key));
      if (ignored) this.log.warn(`Ignored friedliver.agents.${key} from the workspace settings; only your user settings choose the agent program.`);
      return value;
    };
    const one = (id: VendorAgentId) => {
      const command = read<unknown>(`${id}.command`);
      const args = read<unknown>(`${id}.args`);
      return {
        command: typeof command === 'string' ? command : '',
        args: Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string') : [],
      };
    };
    return { claude: one('claude'), codex: one('codex'), gemini: one('gemini') };
  }

  /** From the user's own settings only: a repository must not let its agents reach other chats unasked. */
  private agentToAgent(): AgentToAgent {
    const { value, ignored } = userSetting(vscode.workspace.getConfiguration('friedliver.connections').inspect<unknown>('agentToAgent'));
    if (ignored && !this.warnedAgentToAgent) {
      this.warnedAgentToAgent = true;
      this.log.warn('Ignored friedliver.connections.agentToAgent from the workspace settings; only your user settings decide it.');
    }
    return value === 'allow' || value === 'off' ? value : 'ask';
  }

  private onConfig(e: vscode.ConfigurationChangeEvent): void {
    if (!e.affectsConfiguration('friedliver')) return;
    if (e.affectsConfiguration('friedliver.restoreChats')) {
      if (vscode.workspace.getConfiguration('friedliver').get<boolean>('restoreChats', true)) {
        if (!this.stateFile) void this.openStateFile(false).then(() => this.stateFile?.schedule());
      } else {
        // Off means nothing stays on disk either.
        void this.stateFile?.clear();
        this.stateFile = undefined;
      }
    }
    const before = this.agentConfig;
    this.agentConfig = this.readAgentConfig();
    // A running agent keeps the command it started with; stop it so the next message starts the new one.
    const restart = VENDOR_AGENTS.filter((id) => JSON.stringify(before[id]) !== JSON.stringify(this.agentConfig[id]));
    void this.core.reconfigure(restart);
  }

  private error(err: unknown): void {
    const message = messageOf(err);
    this.log.error(message);
    // Errors carry agent and git output; in a notification that text must not become a link.
    void vscode.window.showErrorMessage(plainText(message));
  }
}

function commandLink(command: string, ...args: string[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.round(value), min), max) : min;
}
