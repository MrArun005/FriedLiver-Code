import { watch, type FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { VendorAgentId } from '@friedliver/main/agents/registry';
import { Accounts } from './host/accounts';
import { BrowserPanel } from './host/browser';
import { ActionBatcher } from './host/batch';
import { encodeCwd, listClaudeSessions } from './host/claudeSessions';
import { claudeEntry, registerClaude, removeTokenFile, unregisterClaude, writeTokenFile } from './host/externalBrowser';
import { isExternal } from './bridge/protocol';
import type { AgentToAgent } from './host/bridgeRequests';
import { registerBeforeProvider, viewChanges } from './host/changes';
import { AgentCore, VENDOR_AGENTS, messageOf } from './host/core';
import { OTHER_AGENTS } from './host/otherAgents';
import { startDictation } from './host/dictation';
import { EditorAgent } from './host/editor';
import { imagePreview } from './host/imageAccess';
import { commandNotice, plainText } from './host/notify';
import { insideRoots } from './host/paths';
import { StateFile } from './host/persist';
import { ReviewUi } from './host/review';
import { userSetting } from './host/settings';
import { installCommandFor } from './host/signin';
import { actionsFor, stateFor } from './host/surfaceState';
import { startUpdateChecks } from './host/updates';
import { attachSurface, post, type Script, type Surface } from './host/webviews';
import { LIMITS, type Attachment, type ClaudeSession, type HostMessage, type TaskChoices, type WebviewMessage } from './shared/messages';
import { AGENT_FACES, AGENT_KEYS, isAgentKey, type Action, type AgentKey, type ChatView, type CodeRef, type Item, type NoticeAction } from './shared/model';
import { describeRule, isRule, type CommandRule } from './shared/rules';
import { APPROVAL_HINTS, type AgentDefaults, type ApprovalLevel } from './shared/session';
import { shownCommand } from './shared/steps';
import { isImagePath } from './shared/stepImages';
import { clip } from './shared/view';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** How long a code reference for a composer waits for a chat view to load. */
const COMPOSER_WAIT_MS = 10_000;
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
/** Each agent's last known options and the user's choices: the user's own storage, never a workspace's. */
const DEFAULTS_KEY = 'friedliver.agentDefaults';
/** "Always allow" command rules: this workspace's storage in the user's profile, never the repository. */
const RULES_KEY = 'friedliver.commandRules';
const MAX_RULES = 100;

let controller: Controller | undefined;

/** Claude Code's user-scope config, where its MCP servers for every project live. */
const CLAUDE_CONFIG = () => path.join(os.homedir(), '.claude.json');

export async function activate(context: vscode.ExtensionContext) {
  controller = new Controller(context);
  await controller.start();
  context.subscriptions.push(startUpdateChecks(context));
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
  /** The editor commands: Edit with Agent, Ask About Selection, Review My Changes. */
  editor?: EditorAgent;
  readonly log = vscode.window.createOutputChannel('FriedLiver Agents', { log: true });
  /** The built-in browser on the right (host/browser.ts). */
  private readonly browser: BrowserPanel;
  /** The last code editor shown in the left group, for the code/chat toggle. */
  private lastLeftEditor?: vscode.TextDocument;
  private readonly surfaces = new Set<Surface>();
  private readonly statusItem = vscode.window.createStatusBarItem('friedliver.decisions', vscode.StatusBarAlignment.Right, 100);
  /** "2 agents working", and a warning while any chat runs in Full auto. */
  private readonly workingItem = vscode.window.createStatusBarItem('friedliver.working', vscode.StatusBarAlignment.Right, 99);
  private readonly autoItem = vscode.window.createStatusBarItem('friedliver.fullAuto', vscode.StatusBarAlignment.Right, 101);
  private shownStatus?: string;
  private agentsView?: vscode.WebviewView;
  private chatPanel?: vscode.WebviewPanel;
  private tasksPanel?: vscode.WebviewPanel;
  /** Claude Code sessions from outside FriedLiver, as the Manager last got them. */
  private claudeSessions: ClaudeSession[] = [];
  private claudeWatchers: FSWatcher[] = [];
  private claudeTimer?: ReturnType<typeof setTimeout>;
  /** The chat last shown anywhere, so moving between side and center keeps it. */
  private lastSelected?: string;
  private agentConfig = this.readAgentConfig();
  private readonly asked = new Set<string>();
  /** Decisions with a notification of their own still open; later ones are counted in one summary. */
  private readonly toasts = new Set<string>();
  private summaryOpen = false;
  /** Commands whose open notification offers Run; its Run button approves nothing else. */
  private readonly runnable = new Set<string>();
  /** Actions on their way to the webviews, sent in batches while agents stream. */
  private readonly batcher = new ActionBatcher((actions) => this.sendActions(actions));
  /** This folder's saved chats; unset when restoring is off or no folder is open. */
  private stateFile?: StateFile;
  private warnedAgentToAgent = false;
  private warnedApprovals = false;
  /** References for a composer, sent again to a chat view that (re)loads soon after; the view drops duplicates. */
  private composerRefs: { message: HostMessage; until: number }[] = [];
  /** What the status item and the badge show now, so a batch that changes nothing there costs no update. */
  private shownDecisions?: { key: string; view?: vscode.WebviewView };

  constructor(private readonly context: vscode.ExtensionContext) {
    this.browser = new BrowserPanel(context, (line) => this.log.info(line));
    context.subscriptions.push(
      this.browser,
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e && e.viewColumn === vscode.ViewColumn.One && e.document.uri.scheme !== 'output') this.lastLeftEditor = e.document;
      }),
    );
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
      browser: (_chatId, call, signal, expectOrigin) => this.browser.call(call, signal, expectOrigin),
      externalAutoApprove: () => this.browserSetting('externalAutoApprove', false),
      browserPage: (selector) => this.browser.inspect(selector),
      approvalDefault: () => this.approvalDefault(),
      defaults: {
        get: (agent) => this.context.globalState.get<Partial<Record<AgentKey, AgentDefaults>>>(DEFAULTS_KEY)?.[agent],
        set: (agent, value) => {
          const all = { ...this.context.globalState.get<Partial<Record<AgentKey, AgentDefaults>>>(DEFAULTS_KEY), [agent]: value };
          void this.context.globalState.update(DEFAULTS_KEY, all);
          this.postDefaults();
        },
      },
      rules: {
        get: () => this.rules(),
        add: (rule) => {
          const rules = [...this.rules().filter((r) => !(r.kind === rule.kind && r.command === rule.command)), rule].slice(-MAX_RULES);
          void this.context.workspaceState.update(RULES_KEY, rules);
        },
      },
      agentCommand: (id) => this.agentConfig[id],
      apiKey: (id) => this.accounts.apiKey(id),
      limits: () => {
        const c = vscode.workspace.getConfiguration('friedliver');
        return { maxRunning: clamp(c.get<number>('maxRunningAgents', 3), 1, 6), idleStopMinutes: clamp(c.get<number>('idleStopMinutes', 10), 0, 240) };
      },
      log: (line) => this.log.info(line),
      ui: {
        showReview: (review) => void this.reviews.show(review, this.editor?.reviewPlacement(review)),
        closeReview: (id) => void this.reviews.close(id),
        askCommand: (ask) => void this.askCommand(ask),
        askPermission: (ask) => void this.askPermission(ask),
        askBridge: (ask) => void this.askBridge(ask),
        askQuestion: (ask) =>
          this.notifyDecision(ask.requestId, ask.chatId, `${plainText(ask.agentLabel)} asks: ${plainText(ask.message.split('\n')[0].slice(0, 200))}`, [
            { title: 'Show', run: () => void this.showChat(ask.chatId, ask.requestId) },
          ]),
        showProposal: (p) => void this.reviews.showProposal(p),
        turnEnded: (t) => this.turnEnded(t),
        confirmFullAuto: (ask) => this.confirmFullAuto(ask),
        confirmRule: async (rule) =>
          (await vscode.window.showWarningMessage(
            `Always allow ${describeRule(rule)}?`,
            {
              modal: true,
              detail: `${rule.kind === 'exact' ? 'This exact command' : `Any command that starts with "${rule.command}"`} will run without asking, in every chat in this workspace. Lines that chain commands, redirect or set variables still ask. Remove it with "FriedLiver: Always-Allowed Commands".`,
            },
            'Always allow',
          )) === 'Always allow',
        signInUrl: (agent, url) => void this.offerSignInUrl(agent, url),
        unsavedText: (file) => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === file && d.isDirty)?.getText(),
      },
    });
    this.reviews = new ReviewUi(() => this.core);
    this.statusItem.name = 'FriedLiver decisions';
    this.statusItem.command = 'friedliver.nextDecision';
    this.statusItem.color = new vscode.ThemeColor('friedliver.decision');
    this.workingItem.name = 'FriedLiver agents working';
    this.workingItem.command = 'friedliver.openTasks';
    this.autoItem.name = 'FriedLiver Full auto';
    this.autoItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
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
      this.workingItem,
      this.autoItem,
      this.reviews,
      this.accounts,
      vscode.window.registerTreeDataProvider('friedliver.accounts', this.accounts),
      vscode.window.registerWebviewViewProvider(
        'friedliver.agents',
        { resolveWebviewView: (view) => this.resolveView(view, 'chat', 'Agents') },
        { webviewOptions: { retainContextWhenHidden: false } },
      ),
      vscode.window.registerWebviewViewProvider('friedliver.chats', { resolveWebviewView: (view) => this.resolveView(view, 'chat', 'Chats', true) }),
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
    command('friedliver.openBrowser', () => this.browser.show());
    command('friedliver.connectClaudeBrowser', () => this.connectClaude(true));
    // Integration tests must not write the developer's ~/.claude.json.
    if (context.extensionMode !== vscode.ExtensionMode.Test) void this.connectClaude(false);
    command('friedliver.toggleCodeAndChat', () => this.toggleCodeAndChat());
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
    command('friedliver.otherAgents', () => this.otherAgents());
    command('friedliver.approvals.rules', () => this.manageRules());
    command('friedliver.review.acceptAll', (chatId?: unknown) => this.decideAll(typeof chatId === 'string' ? chatId : undefined, 'accept'));
    command('friedliver.review.rejectAll', (chatId?: unknown) => this.decideAll(typeof chatId === 'string' ? chatId : undefined, 'reject'));
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
    this.editor = new EditorAgent(context, {
      core: this.core,
      showChat: (chatId, revealItem) => this.showChat(chatId, revealItem),
      currentChat: () => this.lastSelected,
      addToComposer: (chatId, ref) => this.addToComposer(chatId, ref),
      error: (err) => this.error(err),
    });
    context.subscriptions.push(this.editor);
    this.updateDecisions();
  }

  async dispose(): Promise<void> {
    // Save before the core shuts down: stopping cancels running turns, and a
    // restored chat should read "stopped when the window closed", not "cancelled".
    await this.stateFile?.flush();
    this.stateFile?.stop();
    this.batcher.dispose();
    clearTimeout(this.claudeTimer);
    this.watchClaudeSessions(false);
    // The entry stays (it holds no secret or port); without the token file it answers "FriedLiver isn't running".
    await removeTokenFile(this.context.globalStorageUri.fsPath).catch(() => {});
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
    // Each kind of surface gets the actions it shows; the Agent Manager, for one, no images.
    const byKind = new Map<Script, Action[]>();
    for (const s of this.surfaces) {
      let mine = byKind.get(s.kind);
      if (!mine) byKind.set(s.kind, (mine = actionsFor(s.kind, actions)));
      if (mine.length) post(s, mine.length === 1 ? { type: 'action', action: mine[0] } : { type: 'actions', actions: mine });
    }
    this.updateDecisions();
    this.closeAnswered();
  }

  folders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
  }

  // ---- Surfaces ----

  private resolveView(view: vscode.WebviewView, kind: Script, title: string, list = false): void {
    const surface: Surface = {
      kind,
      ...(list ? { list } : {}),
      webview: view.webview,
      selected: kind === 'chat' ? this.lastSelected : undefined,
      ready: false,
      visible: () => view.visible,
      reveal: () => view.show(true),
    };
    if (kind === 'chat' && !list) this.agentsView = view;
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

  /** Where the images steps show may come from: the workspace and task worktrees, the browser's screenshots, the temp folders agents write to. */
  private imageRoots(): string[] {
    return [...new Set([...this.core.roots(), this.context.globalStorageUri.fsPath, os.tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])])];
  }

  private addSurface(surface: Surface, title: string, owner: { onDidDispose: vscode.Event<void> }): void {
    this.surfaces.add(surface);
    const sub = attachSurface(surface, this.context.extensionUri, title, (s, m) => void this.handle(s, m), (line) => this.log.warn(line));
    owner.onDidDispose(() => {
      sub.dispose();
      this.surfaces.delete(surface);
      if (surface.webview === this.agentsView?.webview) this.agentsView = undefined;
      if (surface.kind === 'tasks') this.refreshClaudeSessions();
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
          post(surface, { type: 'snapshot', state: stateFor(surface.kind, this.core.snapshot), selected: surface.selected ?? this.lastSelected, now: Date.now(), defaults: this.core.agentDefaults() });
          if (surface.kind === 'tasks') this.refreshClaudeSessions();
          if (surface.kind === 'chat') {
            this.composerRefs = this.composerRefs.filter((r) => r.until > Date.now());
            for (const r of this.composerRefs) post(surface, r.message);
          }
          return;
        case 'newChat':
          await this.newChat(m.agent, surface.list ? undefined : surface);
          return;
        case 'select':
          surface.selected = m.chatId;
          this.lastSelected = m.chatId;
          return;
        case 'send': {
          const extra = m.refs && (await this.editor?.referencesFor(m.chatId, m.refs));
          if (!extra && !m.text.trim() && !m.images.length) return;
          void this.core.send(m.chatId, m.text, m.images, extra || undefined).catch((err: unknown) => this.error(err));
          return;
        }
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
        case 'undo':
          // The turn's card says "Turn undone"; a file left alone gets a notice in the chat.
          await this.core.undo(m.chatId, m.turnId);
          return;
        case 'notice':
          await this.noticeAction(m.chatId, m.action);
          return;
        case 'imageSrc': {
          const src = await imagePreview(m.path, this.imageRoots());
          post(surface, { type: 'imageSrc', path: m.path, ...(src ? { src } : {}) });
          return;
        }
        case 'openImage':
          // The editor's image preview shows it (no scripts, SVG included); outside the roots too, since the user asked.
          if (isImagePath(m.path) && path.isAbsolute(m.path)) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(m.path), vscode.ViewColumn.Beside);
          return;
        case 'dictate':
          await startDictation({
            platform: process.platform,
            run: (command) => vscode.commands.executeCommand(command),
            toast: (text, button) => vscode.window.showInformationMessage(text, button),
            openUrl: (url) => vscode.env.openExternal(vscode.Uri.parse(url, true)),
          });
          return;
        case 'attach':
          post(surface, { type: 'attached', images: await this.pickImages(), ...(m.chatId ? { chatId: m.chatId } : {}) });
          return;
        case 'openFile': {
          const file = insideRoots(m.path, this.core.roots());
          if (!file) return;
          // A path a reply names may be a folder, or not exist (yet).
          const kind = await stat(file).then((st) => (st.isDirectory() ? 'folder' : 'file'), () => 'missing');
          if (kind === 'folder') {
            await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(file));
            return;
          }
          if (kind === 'missing') {
            void vscode.window.showInformationMessage(`${path.basename(file)} isn't there: ${file}`);
            return;
          }
          await (this.editor ? this.editor.open(file, m.line, m.endLine) : vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true }));
          return;
        }
        case 'createTask': {
          const approval = await this.taskApproval(m.approval, [m.agent]);
          if (approval === null) return;
          const chat = await this.core.createChat(m.agent, { worktree: m.worktree, title: m.prompt, choices: m.choices?.[m.agent], approval });
          void this.core.send(chat.id, m.prompt).catch((err: unknown) => this.error(err));
          return;
        }
        case 'openChat':
          // From the side bar's list: into the chat tab, opening one when there is none.
          if (surface.list && !this.chatPanel) await this.moveToCenter();
          await this.showChat(m.chatId, m.item);
          return;
        case 'openClaudeSession': {
          // Only a session this window listed, so a webview can't name some other folder's.
          const found = this.claudeSessions.find((s) => s.id === m.sessionId);
          if (!found) return;
          const chat = await this.core.createChat('claude', { title: found.title, resume: { sessionId: found.id, cwd: found.cwd } });
          this.refreshClaudeSessions();
          await this.showChat(chat.id);
          return;
        }
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
        case 'fanout': {
          const approval = await this.taskApproval(m.approval, m.agents);
          if (approval !== null) await this.fanout(m.agents, m.prompt, m.worktree, m.choices, approval);
          return;
        }
        case 'bridge':
          this.core.answerBridge(m.requestId, m.answer);
          return;
        case 'archive':
          this.core.archive(m.chatId, m.archived);
          return;
        case 'star':
          this.core.star(m.chatId, m.starred);
          return;
        case 'renameChat': {
          const chat = this.core.chat(m.chatId);
          if (!chat) return;
          const title = await vscode.window.showInputBox({ title: 'Rename chat', value: chat.title, prompt: 'A name you give stays; the chat stops renaming itself.' });
          if (title !== undefined) this.core.renameChat(m.chatId, title);
          return;
        }
        case 'removeChat': {
          const chat = this.core.chat(m.chatId);
          if (!chat) return;
          const ok = await vscode.window.showWarningMessage(`Remove ${chat.label}: “${chat.title}”?`, { modal: true, detail: 'Its history goes. A worktree it had stays on disk.' }, 'Remove');
          if (ok) await this.core.removeChat(m.chatId);
          return;
        }
        case 'viewChanges':
          await viewChanges(this.core, m.chatId);
          return;
        case 'setOption':
          await this.core.setOption(m.chatId, m.optionId, m.value);
          return;
        case 'approval':
          await this.core.setApproval(m.chatId, m.level);
          return;
        case 'plan':
          await this.core.setPlan(m.chatId, m.on);
          return;
        case 'permissionDiff':
          if (!this.core.showProposal(m.requestId, m.path)) void vscode.window.showInformationMessage("FriedLiver couldn't build the whole file for this change. The card shows the agent's own diff.");
          return;
        case 'allowAlways':
          await this.core.allowAlways(m.requestId !== undefined ? { requestId: m.requestId } : { commandId: m.commandId! }, m.rule);
          return;
        case 'reviewAll':
          this.decideAll(m.chatId, m.action);
          return;
        case 'unqueue':
          this.core.unqueue(m.chatId, m.id);
          return;
        case 'steer':
          await this.core.sendNow(m.chatId, m.id);
          return;
        case 'copy':
          await vscode.env.clipboard.writeText(m.text);
          return;
        case 'otherAgents':
          await this.otherAgents();
          return;
        case 'answerQuestion':
          this.core.answerQuestion(m.requestId, m.action, m.values);
          return;
        case 'insert': {
          const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'file');
          if (!editor) {
            void vscode.window.showInformationMessage('Open a file to insert the code into.');
            return;
          }
          await editor.edit((b) => b.replace(editor.selection, m.text));
          await vscode.window.showTextDocument(editor.document, editor.viewColumn);
          return;
        }
        case 'runInTerminal':
          this.runInTerminal(m.chatId, m.command, m.cwd);
          return;
        case 'findFiles': {
          const files = await this.workspaceFiles();
          post(surface, { type: 'foundFiles', chatId: m.chatId, query: m.query, files: this.core.fileMatches(m.chatId, files, m.query) });
          return;
        }
      }
    } catch (err) {
      this.error(err);
    }
  }

  /**
   * Puts a code reference into a chat's composer. A view that is still loading
   * gets it once it is ready, and so does one that reloads in the next seconds
   * (a hidden view loses its content); the view ignores one it already has.
   */
  private addToComposer(chatId: string, ref: CodeRef): void {
    const message: HostMessage = { type: 'addRef', chatId, ref };
    for (const s of this.chatSurfaces()) if (s.visible()) post(s, message);
    this.composerRefs = [...this.composerRefs.filter((r) => r.until > Date.now()), { message, until: Date.now() + COMPOSER_WAIT_MS }];
  }

  /**
   * Types a command into a new terminal named after the chat and presses Enter: the user clicked Run
   * under it. Only a command the chat showed in full runs (a step's command, a shell block in a
   * reply), in the step's folder when that is in the workspace, otherwise the chat's.
   */
  private runInTerminal(chatId: string, command: string, cwd?: string): void {
    const chat = this.core.snapshot.chats.find((c) => c.id === chatId);
    if (!chat || !shownCommand(chat.items, command)) {
      this.log.warn(`Run in terminal: ${chat ? 'that command is not in the chat' : 'no such chat'}`);
      return;
    }
    const roots = this.core.roots();
    const folder = (cwd ? insideRoots(cwd, roots) : null) ?? insideRoots(chat.cwd, roots) ?? this.folders()[0];
    const terminal = vscode.window.createTerminal({ name: `${chat.label}: ${clip(chat.title, 40)}`, cwd: folder });
    terminal.show();
    terminal.sendText(command, true);
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

  async moveToCenter(column?: vscode.ViewColumn): Promise<void> {
    if (this.chatPanel) {
      this.chatPanel.reveal(column);
    } else {
      const panel = vscode.window.createWebviewPanel('friedliver.chatPanel', 'Agents', column ?? vscode.ViewColumn.Active, { retainContextWhenHidden: false });
      this.adoptPanel(panel, 'chat');
    }
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  }

  /**
   * The left of the window swaps between the code and the agent chat (the browser keeps the right):
   * the chat moves into the first editor group, or the last code editor there comes back.
   */
  async toggleCodeAndChat(): Promise<void> {
    const chatShown = this.chatPanel?.visible && this.chatPanel.viewColumn === vscode.ViewColumn.One;
    if (!chatShown) return this.moveToCenter(vscode.ViewColumn.One);
    if (this.lastLeftEditor && !this.lastLeftEditor.isClosed) {
      await vscode.window.showTextDocument(this.lastLeftEditor, vscode.ViewColumn.One);
    } else {
      await vscode.commands.executeCommand('workbench.action.openPreviousRecentlyUsedEditorInGroup');
    }
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

  private async fanout(agents: AgentKey[], prompt: string, worktree: boolean, choices?: TaskChoices, approval?: ApprovalLevel): Promise<void> {
    try {
      // Resolves once the chats exist; their turns run on, and the board shows them side by side.
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Starting ${agents.length} agents…` }, () =>
        this.core.fanout(agents.slice(0, LIMITS.fanout), prompt, worktree, { choices, approval }),
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
    this.updateStatus();
    const waiting = this.core.decisions();
    // Every batch of agent updates comes here; most change nothing the status item or the badge show.
    const key = JSON.stringify(waiting.map((d) => d.title));
    if (this.shownDecisions?.key === key && this.shownDecisions.view === this.agentsView) return;
    this.shownDecisions = { key, view: this.agentsView };
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

  /** Agents working, and chats in Full auto, which must never go unseen. */
  private updateStatus(): void {
    const chats = this.core.snapshot.chats.filter((c) => !c.archived);
    const busy = chats.filter((c) => c.busy);
    const full = chats.filter((c) => c.approval === 'full');
    const key = `${busy.map((c) => c.id).join()}|${full.map((c) => c.id).join()}`;
    if (key === this.shownStatus) return;
    this.shownStatus = key;
    if (busy.length) {
      this.workingItem.text = `$(sync~spin) ${busy.length} working`;
      this.workingItem.tooltip = `${busy.map((c) => c.label).join(', ')} ${busy.length === 1 ? 'is' : 'are'} working. Open the Agent Manager.`;
      this.workingItem.show();
    } else {
      this.workingItem.hide();
    }
    if (full.length) {
      this.autoItem.text = `$(zap) Full auto: ${full.length === 1 ? full[0].label : `${full.length} chats`}`;
      this.autoItem.tooltip = `${full.map((c) => c.label).join(', ')} edit${full.length === 1 ? 's' : ''} and run${full.length === 1 ? 's' : ''} commands without asking. Click to see.`;
      this.autoItem.command = { command: 'friedliver.command.show', title: 'Show', arguments: [full[0].id, ''] };
      this.autoItem.show();
    } else {
      this.autoItem.hide();
    }
  }

  // ---- Asking the user ----

  /**
   * Whether the user can see this chat's question right now: the window has
   * focus and a visible chat view shows that chat, or the Agent Manager is up.
   * Then the card on screen is enough and no notification pops up.
   */
  private onScreen(chatId?: string): boolean {
    if (!vscode.window.state.focused || !chatId) return false;
    return [...this.surfaces].some((s) => s.visible() && (s.kind === 'tasks' || (s.kind === 'chat' && (s.selected ?? this.lastSelected) === chatId)));
  }

  /**
   * One notification per decision, with real buttons, only when its chat isn't
   * on screen. Dismissing it decides nothing. While one is open, later ones are
   * counted in a single "N decisions waiting" notification instead of piling up.
   * A button pressed after the decision was made elsewhere does nothing.
   */
  private notifyDecision(id: string, chatId: string | undefined, message: string, buttons: { title: string; run(): void }[]): void {
    if (!vscode.workspace.getConfiguration('friedliver.notify').get<boolean>('decisions', true) || this.onScreen(chatId)) return;
    if (this.toasts.size > 0) {
      this.notifySummary();
      return;
    }
    this.toasts.add(id);
    void vscode.window.showWarningMessage(message, ...buttons.map((b) => b.title)).then((picked) => {
      this.toasts.delete(id);
      const button = buttons.find((b) => b.title === picked);
      if (!button) return;
      if (button.title !== 'Show' && !this.core.decisions().some((d) => d.id === id)) return;
      button.run();
    });
  }

  private notifySummary(): void {
    if (this.summaryOpen) return;
    this.summaryOpen = true;
    const n = this.core.decisions().length;
    void vscode.window.showWarningMessage(`${n} decision${n === 1 ? '' : 's'} waiting`, 'Show').then((picked) => {
      this.summaryOpen = false;
      if (picked) void this.nextDecision();
    });
  }

  /** Commands wait in the chat; a notification offers Run only when it shows the whole command exactly as it will run. */
  private askCommand(ask: { chatId?: string; commandId: string; agentLabel: string; commandLine: string }): void {
    const shown = commandNotice(ask.commandLine);
    if (shown.runnable) this.runnable.add(ask.commandId);
    const buttons = [
      ...(shown.runnable ? [{ title: 'Run', run: () => this.runnable.has(ask.commandId) && this.core.decideCommand(ask.commandId, true) }] : []),
      { title: 'Deny', run: () => this.core.decideCommand(ask.commandId, false) },
      ...(ask.chatId ? [{ title: 'Show', run: () => void this.showChat(ask.chatId!, ask.commandId) }] : []),
    ];
    const text = `${plainText(ask.agentLabel)} wants to run: ${shown.text}${shown.runnable ? '' : ' (open the chat to see all of it)'}`;
    this.notifyDecision(ask.commandId, ask.chatId, text, buttons);
  }

  /**
   * An agent's question. Allow and Deny are its own one-time options; a
   * question that runs a command gets Allow only when the command shows in full,
   * and a plan only Show, since it has to be read.
   */
  private askPermission(ask: { chatId: string; requestId: string; agentLabel: string; title: string; allow?: { optionId: string; name: string }; deny?: { optionId: string; name: string } }): void {
    const item = this.core.chat(ask.chatId)?.items.find((i): i is Extract<Item, { kind: 'permission' }> => i.kind === 'permission' && i.requestId === ask.requestId);
    const command = item?.detail?.command?.line;
    const shown = command ? commandNotice(command) : undefined;
    const allowed = ask.allow && !item?.detail?.plan && item?.toolKind !== 'switch_mode' && (!shown || shown.runnable);
    const text = shown ? `${plainText(ask.agentLabel)} wants to run: ${shown.text}` : `${plainText(ask.agentLabel)} asks: ${plainText(ask.title)}`;
    this.notifyDecision(ask.requestId, ask.chatId, text, [
      ...(allowed ? [{ title: 'Allow', run: () => this.core.answerPermission(ask.requestId, ask.allow!.optionId) }] : []),
      ...(ask.deny ? [{ title: 'Deny', run: () => this.core.answerPermission(ask.requestId, ask.deny!.optionId) }] : []),
      { title: 'Show', run: () => void this.showChat(ask.chatId, ask.requestId) },
    ]);
  }

  private askBridge(ask: { chatId: string; requestId: string; title: string; detail?: string }): void {
    if (isExternal(ask.chatId)) {
      // No chat holds this request, so it always gets its own popup, whatever else is waiting.
      const buttons = { Allow: 'allow', 'Allow for this session': 'allowChat', Deny: 'deny' } as const;
      // Not modal; the detail (bridgeRequests.externalDetail) says exactly what and where, so consent isn't blind.
      void vscode.window.showWarningMessage(`${plainText(ask.title)}: ${plainText(ask.detail ?? '')}`, ...Object.keys(buttons)).then((picked) => {
        if (picked) this.core.answerBridge(ask.requestId, buttons[picked as keyof typeof buttons]);
      });
      return;
    }
    this.notifyDecision(ask.requestId, ask.chatId, plainText(ask.title), [
      { title: 'Allow', run: () => this.core.answerBridge(ask.requestId, 'allow') },
      { title: 'Allow for this chat', run: () => this.core.answerBridge(ask.requestId, 'allowChat') },
      { title: 'Deny', run: () => this.core.answerBridge(ask.requestId, 'deny') },
      { title: 'Show', run: () => void this.showChat(ask.chatId, ask.requestId) },
    ]);
  }

  /** Decisions made in a view, the board or the diff editor no longer hold their notification's place. */
  private closeAnswered(): void {
    if (this.toasts.size === 0 && this.runnable.size === 0) return;
    const open = new Set(this.core.decisions().map((d) => d.id));
    for (const id of [...this.toasts]) if (!open.has(id)) this.toasts.delete(id);
    for (const id of [...this.runnable]) if (!open.has(id)) this.runnable.delete(id);
  }

  /**
   * A turn ended in a chat the user isn't looking at: "Claude 2 finished",
   * or its error with what to do about it. Turns started by another chat (a
   * consultation) answer there instead. VS Code has no stable API for an OS
   * notification or taskbar flash, so an unfocused window gets these toasts only.
   */
  private turnEnded(t: { chatId: string; label: string; title: string; stopReason: string | null; failure?: Item; files: number; byUser: boolean }): void {
    if (!t.byUser || this.onScreen(t.chatId)) return;
    const open = { title: 'Open', run: () => void this.showChat(t.chatId) };
    if (t.failure?.kind === 'notice') {
      const actions = (t.failure.actions ?? []).slice(0, 2).map((a) => ({ title: a.label, run: () => void this.noticeAction(t.chatId, a).catch((err: unknown) => this.error(err)) }));
      void vscode.window.showErrorMessage(`${plainText(t.label)}: ${plainText(t.failure.text)}`, ...[...actions, open].map((b) => b.title)).then((picked) => {
        [...actions, open].find((b) => b.title === picked)?.run();
      });
      return;
    }
    if (t.stopReason === 'cancelled' || !vscode.workspace.getConfiguration('friedliver.notify').get<boolean>('finished', true)) return;
    const changed = t.files ? ` · ${t.files} file${t.files === 1 ? '' : 's'} changed` : '';
    const buttons = [open, ...(t.files ? [{ title: 'View changes', run: () => void viewChanges(this.core, t.chatId) }] : [])];
    void vscode.window.showInformationMessage(`${plainText(t.label)} finished: ${plainText(t.title)}${changed}`, ...buttons.map((b) => b.title)).then((picked) => {
      buttons.find((b) => b.title === picked)?.run();
    });
  }

  /** Full auto, once per chat: the agent edits and runs commands without asking until switched back. */
  private async confirmFullAuto(ask: { label: string; agent: string; mode?: string }): Promise<boolean> {
    const mode = ask.mode ? ` FriedLiver switches ${ask.agent} to its "${ask.mode}" mode.` : '';
    const picked = await vscode.window.showWarningMessage(
      `Run ${ask.label} in Full auto?`,
      {
        modal: true,
        detail: `${APPROVAL_HINTS.full}, until you switch the chat back.${mode} In that mode the agent itself may not ask at all; FriedLiver still asks before commands in folders outside the workspace and before plans. Each turn can still be undone from its "Changed files" card.`,
      },
      'Use Full auto',
    );
    return picked === 'Use Full auto';
  }

  /** A new task's level: Full auto is confirmed once for all its chats, here. Null: the user said no; undefined: the default. */
  private async taskApproval(level: ApprovalLevel | undefined, agents: AgentKey[]): Promise<ApprovalLevel | null | undefined> {
    if (level !== 'full') return level;
    const who = agents.map((a) => AGENT_FACES[a].name).join(', ');
    return (await this.confirmFullAuto({ label: agents.length > 1 ? `these ${agents.length} agents (${who})` : who, agent: who })) ? 'full' : null;
  }

  /** Accept all / Reject all for a chat (the one shown, from the command palette): what waits now and the rest of its turn. */
  private decideAll(chatId: string | undefined, action: 'accept' | 'reject'): void {
    const id = chatId ?? (this.reviews.activeReviewId() && this.core.review(this.reviews.activeReviewId()!)?.chatId) ?? this.lastSelected;
    if (!id || !this.core.chat(id)) {
      void vscode.window.showInformationMessage('No agent edit is waiting here.');
      return;
    }
    for (const reviewId of this.core.decideAll(id, action)) {
      if (action === 'accept') this.reviews.accept(reviewId);
      else this.reviews.reject(reviewId);
    }
  }

  /** Other agent extensions, from the extension gallery (Open VSX in FriedLiver), unchanged and installed only when asked. */
  async otherAgents(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      OTHER_AGENTS.map((a) => ({
        label: a.name,
        description: `${a.publisher}${vscode.extensions.getExtension(a.id) ? ' · installed' : ''}`,
        detail: a.what,
        agent: a,
      })),
      { title: 'Get another agent extension', placeHolder: 'They run on their own, outside FriedLiver’s reviews and approvals' },
    );
    if (!picked) return;
    const action = await vscode.window.showQuickPick(
      [
        { label: 'Open its page', description: 'read about it first', install: false },
        { label: 'Install', description: `${picked.agent.id} from the extension gallery`, install: true },
      ],
      { title: picked.agent.name },
    );
    if (!action) return;
    if (!action.install) {
      await vscode.commands.executeCommand('extension.open', picked.agent.id);
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Install ${picked.agent.name}?`,
      { modal: true, detail: `${picked.agent.name} by ${picked.agent.publisher} comes from the extension gallery as its publisher made it. It works on its own: FriedLiver's reviews, approvals and undo don't cover it.` },
      'Install',
    );
    if (ok === 'Install') await vscode.commands.executeCommand('workbench.extensions.installExtension', picked.agent.id);
  }

  /** The workspace's files for the "#" picker, kept a few seconds so typing doesn't search again on every key. */
  private fileList?: { at: number; files: Promise<string[]> };
  private workspaceFiles(): Promise<string[]> {
    if (!this.fileList || Date.now() - this.fileList.at > 10_000) {
      const files = vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}', 5000).then((uris) => uris.filter((u) => u.scheme === 'file').map((u) => u.fsPath));
      this.fileList = { at: Date.now(), files: Promise.resolve(files) };
    }
    return this.fileList.files;
  }

  private rules(): CommandRule[] {
    const saved = this.context.workspaceState.get<unknown[]>(RULES_KEY) ?? [];
    return (Array.isArray(saved) ? saved : []).filter(isRule).slice(-MAX_RULES);
  }

  /** "Always-Allowed Commands": the rules for this workspace, to remove. */
  private async manageRules(): Promise<void> {
    const rules = this.rules();
    if (!rules.length) {
      void vscode.window.showInformationMessage('No commands are always allowed in this workspace. "Always allow" on a command adds one.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      rules.map((r) => ({ label: describeRule(r), description: r.kind === 'exact' ? 'exactly this command' : 'and anything after it', rule: r })),
      { title: 'Always-allowed commands in this workspace', placeHolder: 'Pick the ones to remove', canPickMany: true },
    );
    if (!picked?.length) return;
    const gone = new Set(picked.map((p) => p.rule));
    await this.context.workspaceState.update(RULES_KEY, rules.filter((r) => !gone.has(r)));
    void vscode.window.showInformationMessage(`Removed ${picked.length} rule${picked.length === 1 ? '' : 's'}.`);
  }

  private postDefaults(): void {
    const message: HostMessage = { type: 'defaults', defaults: this.core.agentDefaults() };
    for (const s of this.surfaces) post(s, message);
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

  /** From the user's own settings only: a repository must never make its agents run without asking. */
  private approvalDefault(): 'ask' | 'edits' {
    const { value, ignored } = userSetting(vscode.workspace.getConfiguration('friedliver.approvals').inspect<unknown>('default'));
    if (ignored && !this.warnedApprovals) {
      this.warnedApprovals = true;
      this.log.warn('Ignored friedliver.approvals.default from the workspace settings; only your user settings decide it.');
    }
    return value === 'edits' ? 'edits' : 'ask';
  }

  /** friedliver.browser.<key> from the user's own settings only: a repository must not open the browser to outside clients. */
  private browserSetting(key: 'externalClients' | 'externalAutoApprove', fallback: boolean): boolean {
    const { value } = userSetting(vscode.workspace.getConfiguration('friedliver.browser').inspect<unknown>(key));
    return typeof value === 'boolean' ? value : fallback;
  }

  /**
   * Lets Claude Code (the extension, or the CLI in a terminal) use the browser tools: writes this
   * launch's token file and the secret-free `friedliver-browser` stdio entry in ~/.claude.json. With
   * the setting off, revokes the token and removes both. `show` reports the result (the Connect command).
   */
  private async connectClaude(show: boolean): Promise<void> {
    const say = (text: string, error = false) => {
      if (error) this.log.warn(text);
      else this.log.info(text);
      if (show) void (error ? vscode.window.showErrorMessage(text) : vscode.window.showInformationMessage(text));
    };
    try {
      if (!this.browserSetting('externalClients', true)) {
        this.core.revokeExternal();
        await removeTokenFile(this.context.globalStorageUri.fsPath);
        await unregisterClaude(CLAUDE_CONFIG());
        return say('Claude Code is not connected to the browser: friedliver.browser.externalClients is off.');
      }
      const storage = this.context.globalStorageUri.fsPath;
      // First, before anything can fail: an older http entry points at a port another process may hold now.
      await unregisterClaude(CLAUDE_CONFIG(), true);
      const access = await this.core.externalAccess();
      if (!access) {
        await removeTokenFile(storage);
        return say('Claude Code is not connected to the browser: the FriedLiver tools are off or unavailable.', show);
      }
      const tokenFile = await writeTokenFile(storage, access.url, access.token);
      const script = this.context.asAbsolutePath(path.join('dist', 'externalStdio.js'));
      // Replaces an older http entry (token and port in the config) with this secret-free one.
      const result = await registerClaude(CLAUDE_CONFIG(), claudeEntry(process.execPath, script, tokenFile));
      say(`Claude Code can use FriedLiver's browser (MCP server "friedliver-browser", ${result}). Start a new Claude Code session to pick it up.`);
    } catch (err) {
      say(`Could not connect Claude Code to the browser: ${messageOf(err)}`, true);
    }
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

  /** Reads the Claude Code sessions again soon, at most every half second while a session streams, and sends them to the Manager. */
  private refreshClaudeSessions(): void {
    if (this.claudeTimer) return;
    this.claudeTimer = setTimeout(() => {
      this.claudeTimer = undefined;
      void this.readClaudeSessions().catch((err: unknown) => this.log.warn(`Claude Code sessions: ${messageOf(err)}`));
    }, 500);
  }

  private async readClaudeSessions(): Promise<void> {
    const on = vscode.workspace.getConfiguration('friedliver').get<boolean>('showClaudeCodeSessions', true) && [...this.surfaces].some((s) => s.kind === 'tasks');
    this.watchClaudeSessions(on);
    const owned = new Set(Object.values(this.core.exportState().chats).flatMap((c) => (c.sessionId ? [c.sessionId] : [])));
    this.claudeSessions = on ? await listClaudeSessions({
          home: os.homedir(),
          folders: this.folders(),
          skip: owned,
          showAll: vscode.workspace.getConfiguration('friedliver.claudeSessions').get<boolean>('showAll', false),
        }) : [];
    for (const s of this.surfaces) if (s.kind === 'tasks' && s.ready) post(s, { type: 'claudeSessions', sessions: this.claudeSessions });
  }

  /** Watches the folders' Claude Code project folders while the Manager is open; a folder made later is picked up on the next read. */
  private watchClaudeSessions(on: boolean): void {
    for (const w of this.claudeWatchers) w.close();
    this.claudeWatchers = [];
    if (!on) return;
    for (const folder of this.folders()) {
      try {
        const w = watch(path.join(os.homedir(), '.claude', 'projects', encodeCwd(folder)), () => this.refreshClaudeSessions());
        w.on('error', () => w.close());
        this.claudeWatchers.push(w);
      } catch {
        // No sessions for this folder yet.
      }
    }
  }

  private onConfig(e: vscode.ConfigurationChangeEvent): void {
    if (!e.affectsConfiguration('friedliver')) return;
    if (e.affectsConfiguration('friedliver.showClaudeCodeSessions') || e.affectsConfiguration('friedliver.claudeSessions')) this.refreshClaudeSessions();
    if (e.affectsConfiguration('friedliver.connections.agentToAgent') && this.agentToAgent() === 'off') this.core.toolsOff();
    if (e.affectsConfiguration('friedliver.browser.externalClients')) void this.connectClaude(false);
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

  error(err: unknown): void {
    const message = messageOf(err);
    this.log.error(message);
    // Errors carry agent and git output; in a notification that text must not become a link.
    void vscode.window.showErrorMessage(plainText(message), 'Show log').then((picked) => {
      if (picked) this.log.show(true);
    });
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.round(value), min), max) : min;
}
