import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import type { VendorAgentId } from '@friedliver/main/agents/registry';
import { Accounts } from './host/accounts';
import { AgentCore, VENDOR_AGENTS, messageOf } from './host/core';
import { insideRoots } from './host/paths';
import { ReviewUi } from './host/review';
import { attachSurface, post, type Script, type Surface } from './host/webviews';
import type { Attachment, WebviewMessage } from './shared/messages';
import { AGENT_FACES, AGENT_KEYS, isAgentKey, shortCommand, type AgentKey, type NoticeAction } from './shared/model';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

let controller: Controller | undefined;

export async function activate(context: vscode.ExtensionContext) {
  controller = new Controller(context);
  await controller.start();
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
    );
    const unsubscribe = this.core.onAction((action) => {
      for (const s of this.surfaces) post(s, { type: 'action', action });
      this.updateDecisions();
      this.closeAnswered();
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
    command('friedliver.command.approve', (id: unknown) => typeof id === 'string' && this.core.decideCommand(id, true));
    command('friedliver.command.deny', (id: unknown) => typeof id === 'string' && this.core.decideCommand(id, false));
    command('friedliver.command.show', (chatId: unknown, itemId: unknown) => {
      if (typeof chatId === 'string' && typeof itemId === 'string') void this.showChat(chatId, itemId);
    });
    this.updateDecisions();
  }

  async dispose(): Promise<void> {
    await this.core.dispose();
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
      }
    } catch (err) {
      this.error(err);
    }
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
        // Typed, not run: the user reads it and presses Enter.
        const terminal = vscode.window.createTerminal({ name: 'Install agent', cwd: this.folders()[0] });
        terminal.show();
        terminal.sendText(action.command, false);
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
      if (surface) {
        surface.selected = chat.id;
        this.lastSelected = chat.id;
        post(surface, { type: 'select', chatId: chat.id });
      } else {
        await this.showChat(chat.id);
      }
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
    const links = [
      `[Run](${commandLink('friedliver.command.approve', ask.commandId)})`,
      `[Deny](${commandLink('friedliver.command.deny', ask.commandId)})`,
      ...(ask.chatId ? [`[Show](${commandLink('friedliver.command.show', ask.chatId, ask.commandId)})`] : []),
    ];
    return this.waitingNotification(ask.commandId, `${ask.agentLabel} wants to run ${shortCommand(ask.commandLine)}`, links.join(' · '), () =>
      this.core.decideCommand(ask.commandId, false),
    );
  }

  /** Questions show in the transcript; a notification only when no chat view is on screen. */
  private askPermission(ask: { chatId: string; requestId: string; agentLabel: string; title: string }): Promise<void> {
    if (this.chatSurfaces().some((s) => s.visible())) return Promise.resolve();
    const show = `[Show](${commandLink('friedliver.command.show', ask.chatId, ask.requestId)})`;
    return this.waitingNotification(ask.requestId, `${ask.agentLabel} asks: ${ask.title}`, show, () => {});
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
    if (open) await vscode.env.openExternal(vscode.Uri.parse(url));
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

  private readAgentConfig(): Record<VendorAgentId, { command: string; args: string[] }> {
    const c = vscode.workspace.getConfiguration('friedliver.agents');
    const one = (id: VendorAgentId) => ({
      command: c.get<string>(`${id}.command`, '') ?? '',
      args: (c.get<unknown[]>(`${id}.args`, []) ?? []).filter((a): a is string => typeof a === 'string'),
    });
    return { claude: one('claude'), codex: one('codex'), gemini: one('gemini') };
  }

  private onConfig(e: vscode.ConfigurationChangeEvent): void {
    if (!e.affectsConfiguration('friedliver')) return;
    const before = this.agentConfig;
    this.agentConfig = this.readAgentConfig();
    // A running agent keeps the command it started with; stop it so the next message starts the new one.
    const restart = VENDOR_AGENTS.filter((id) => JSON.stringify(before[id]) !== JSON.stringify(this.agentConfig[id]));
    void this.core.reconfigure(restart);
  }

  private error(err: unknown): void {
    const message = messageOf(err);
    this.log.error(message);
    void vscode.window.showErrorMessage(message);
  }
}

function commandLink(command: string, ...args: string[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.round(value), min), max) : min;
}
