import { mkdirSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { VendorAgentId } from '@friedliver/main/agents/registry';
import { Accounts } from './host/accounts';
import { ACCOUNTS_PANEL, AccountsPage } from './host/accountsPage';
import { BrowserPanel } from './host/browser';
import { ActionBatcher } from './host/batch';
import { runRewind } from './host/rewindFlow';
import { encodeCwd, listClaudeImages, listClaudeSessions } from './host/claudeSessions';
import { SubagentWatch } from './host/subagentDetail';
import { claudeEntry, registerClaude, removeTokenFile, unregisterClaude, writeTokenFile } from './host/externalBrowser';
import { isExternal } from './bridge/protocol';
import { ProjectIndexHost } from './host/projectIndexHost';
import type { AgentToAgent, BridgeAnswer } from './host/bridgeRequests';
import { registerBeforeProvider, viewChanges } from './host/changes';
import { AgentCore, VENDOR_AGENTS, messageOf } from './host/core';
import { OTHER_AGENTS } from './host/otherAgents';
import { DICTATION_SETTINGS, Dictation, PRIVACY_PANES, helperArgs, helperPath } from './host/dictation';
import { EditorAgent } from './host/editor';
import { InlineEditor } from './host/inlineEditor';
import { imagePreview, imageThumb, workerScaler } from './host/imageAccess';
import { ImageStore, sweepOld, type Copy, type GalleryRef, type Limits } from './host/imageStore';
import { commandNotice, plainText } from './host/notify';
import { insideRoots } from './host/paths';
import { ensureFile, importRules, loadRules, PROJECT_MEMORY, PROJECT_RULES, remember } from './host/sharedRules';
import { StateFile } from './host/persist';
import { SystemControl, systemSettings } from './host/system';
import { ReviewUi, type ReviewPlacement } from './host/review';
import { RemoteControl } from './remote/host';
import { userSetting } from './host/settings';
import { installCommandFor } from './host/signin';
import { actionsFor, showsChat, stateFor } from './host/surfaceState';
import { startUpdateChecks } from './host/updates';
import { attachSurface, post, webviewHtml, webviewOptions, type Script, type Surface } from './host/webviews';
import { installedOrUnknown, isVendor, preselectAgents, rosterOf, shownAgents } from './shared/accounts';
import { discussLayoutOf, type DiscussLayout } from './shared/discussView';
import { LIMITS, parseWebviewMessage, type Attachment, type ClaudeSession, type HostMessage, type TaskChoices, type WebviewMessage } from './shared/messages';
import { AGENT_FACES, isAgentKey, type Action, type AgentKey, type AppState, type ChatView, type CodeRef, type Item, type NoticeAction } from './shared/model';
import { describeRule } from './shared/rules';
import { appBundle, Permissions, userDataDir } from './host/permissions';
import { APPROVAL_HINTS, dailyWarning, usageTotals, type AgentDefaults, type ApprovalLevel } from './shared/session';
import { shownCommand } from './shared/steps';
import { isImagePath } from './shared/stepImages';
import { chatOfSession, clip, linkResumeChats, panelTitle } from './shared/view';
import { agentName, chatName, chatPick, statusTexts, turnEndedText, chatRef } from './shared/names';
import { linkDestination, linkTarget } from './shared/links';
import { codexModelVisibility } from './host/codexModels';

/** friedliver.links.openIn: where web links you click open. */
const linkMode = () => vscode.workspace.getConfiguration('friedliver.links').get('openIn');
/** The system browser, skipping FriedLiver's own link opener. */
const openInSystemBrowser = (url: string) => vscode.env.openExternal(vscode.Uri.parse(url, true), { allowContributedOpeners: false });
import { collectGallery, doneScope, type GalleryImage, type ImageStoreInfo, type OutsideImages } from './shared/gallery';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** How long a message for a chat view (a composer's code reference, an item to reveal) waits for one to load. */
const REPLAY_MS = 10_000;
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
/** Each agent's last known options and the user's choices: the user's own storage, never a workspace's. */
const DEFAULTS_KEY = 'friedliver.agentDefaults';

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
  /** Agents & Accounts (host/accountsPage.ts). */
  readonly accountsPage: AccountsPage;
  /** Chats an inline edit owns: their reviews and prompts are refused, never shown. */
  private readonly inlineChats = new Set<string>();
  /** The editor commands: Edit with Agent, Ask About Selection, Review My Changes. */
  editor?: EditorAgent;
  readonly log = vscode.window.createOutputChannel('FriedLiver Agents', { log: true });
  /** Every system_* attempt (host/system.ts auditLine): who, which chat, what, and how it ended; clipboard text only as its length. */
  private readonly systemLog = vscode.window.createOutputChannel('FriedLiver: System Actions');
  /** The built-in browser on the right (host/browser.ts). */
  private readonly browser: BrowserPanel;
  /** The last code editor shown in the left group, for the code/chat toggle. */
  private lastLeftEditor?: vscode.TextDocument;
  private readonly surfaces = new Set<Surface>();
  private readonly statusItem = vscode.window.createStatusBarItem('friedliver.decisions', vscode.StatusBarAlignment.Right, 100);
  /** "2 agents working", and a warning while any chat runs in Full auto. */
  private readonly workingItem = vscode.window.createStatusBarItem('friedliver.working', vscode.StatusBarAlignment.Right, 99);
  private projectIndex?: ProjectIndexHost;
  private readonly autoItem = vscode.window.createStatusBarItem('friedliver.fullAuto', vscode.StatusBarAlignment.Right, 101);
  private shownStatus?: string;
  /** Open Decision Inbox ran while the Agent Manager was loading. */
  private inboxWanted = false;
  private agentsView?: vscode.WebviewView;
  private chatPanel?: vscode.WebviewPanel;
  private tasksPanel?: vscode.WebviewPanel;
  /** Where the Diagnose Claude Code Sessions command writes. */
  private claudeReport?: vscode.OutputChannel;
  /** Claude Code sessions from outside FriedLiver, as the Manager last got them. */
  private claudeSessions: ClaudeSession[] = [];
  private claudeWatchers = new Map<string, FSWatcher>();
  /** The outside subagent whose detail sheet is open, and the Manager showing it. */
  private subagent?: { watch: SubagentWatch; surface: Surface };
  /** The images in those sessions, as the Images view and the Manager last got them. */
  private claudeImages: OutsideImages[] = [];
  /** Thumbnails are made one at a time, the scaling in a worker thread. */
  private thumbQueue: Promise<unknown> = Promise.resolve();
  private readonly scaler: ReturnType<typeof workerScaler>;
  /** FriedLiver's copies of the images agents read, take and make (host/imageStore.ts). */
  private readonly imageStore: ImageStore;
  /** Paths already copied this session, so the live copy looks at each once. */
  private readonly copied = new Set<string>();
  private imageTimers: { sync?: ReturnType<typeof setTimeout>; post?: ReturnType<typeof setTimeout>; commit?: ReturnType<typeof setTimeout> } = {};
  private claudeTimer?: ReturnType<typeof setTimeout>;
  /** Connecting Claude Code to the browser, one write of ~/.claude.json at a time. */
  private claudeLink: Promise<void> = Promise.resolve();
  /** The chat last shown anywhere, so moving between side and center keeps it. */
  private lastSelected?: string;
  private agentConfig = this.readAgentConfig();
  /** Remembered "Always allow" answers: the user's own storage (global for websites and agent tools, this workspace's for folders and commands). */
  readonly permissions: Permissions;
  private permissionsPanel?: { panel: vscode.WebviewPanel; ready: boolean };
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
  /** The day (its local midnight) the daily token warning last showed. */
  private usageWarned?: number;
  /**
   * Messages sent again to a chat view that (re)loads soon after: a composer's code references and the
   * item Open scrolls to. A hidden view loses its content and a new one isn't ready yet, so what was
   * posted to it then never arrived. The view drops duplicate references; a repeated scroll is harmless.
   */
  private replay: { message: HostMessage; until: number }[] = [];
  /** What the status item and the badge show now, so a batch that changes nothing there costs no update. */
  private shownDecisions?: { key: string; view?: vscode.WebviewView };
  /** FriedLiver Remote: phones paired over the LAN or Tailscale (remote/host.ts). */
  private remote?: RemoteControl;
  /** The composer's mic on macOS (host/dictation.ts). */
  private readonly dictation = new Dictation<Surface>({
    helper: () => helperPath(this.context.extensionUri.fsPath),
    args: () => {
      const voice = vscode.workspace.getConfiguration('friedliver.voice');
      return helperArgs(voice.get('language'), voice.get('silenceSeconds'));
    },
    post: (surface, chatId, update) => post(surface, { type: 'dictation', chatId, ...update }),
    denied: (code) => {
      void vscode.window.showWarningMessage('FriedLiver needs microphone and speech permission', 'Open System Settings').then((pick) => {
        if (pick) void vscode.env.openExternal(vscode.Uri.parse(PRIVACY_PANES[code], true));
      });
    },
    failed: (message) => void vscode.window.showWarningMessage(`Dictation stopped: ${message}`),
  });

  constructor(private readonly context: vscode.ExtensionContext) {
    this.scaler = workerScaler(path.join(context.extensionUri.fsPath, 'dist', 'thumbWorker.js'));
    this.imageStore = new ImageStore(path.join(context.globalStorageUri.fsPath, 'images'), {
      tempRoots: () => this.tempRoots(),
      scale: this.scaler,
      onChange: () => this.postImageStore(),
    });
    void this.imageStore
      .load()
      .then(() => this.tidyImages())
      .catch((err: unknown) => this.log.warn(`Image copies: ${messageOf(err)}`));
    this.browser = new BrowserPanel(context, (line) => this.log.info(line));
    context.subscriptions.push(
      this.browser,
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e && e.viewColumn === vscode.ViewColumn.One && e.document.uri.scheme !== 'output') this.lastLeftEditor = e.document;
      }),
    );
    this.accounts = new Accounts(
      context.secrets,
      context.globalState,
      () => this.core,
      () => this.folders()[0],
      (agent) => void this.core.reconfigure([agent]),
      () => this.showDemo(),
    );
    this.permissions = new Permissions({
      user: context.globalState,
      workspace: context.workspaceState,
      home: os.homedir(),
      // The app itself and its data (settings, extensions' storage, these rules): an agent never gets to change FriedLiver without asking.
      sensitive: [appBundle(vscode.env.appRoot), userDataDir(context.globalStorageUri.fsPath)],
      onChange: () => this.postPermissions(),
    });
    const noFolderCwd = path.join(context.globalStorageUri.fsPath, 'no-folder');
    try {
      mkdirSync(noFolderCwd, { recursive: true });
    } catch {
      // Without it agents start in home, as before.
    }
    const system = new SystemControl({
      home: os.homedir(),
      shotsBase: context.globalStorageUri.fsPath,
      // Never opened for agents, like the places "Always allow" never covers.
      sensitive: [appBundle(vscode.env.appRoot), userDataDir(context.globalStorageUri.fsPath)],
      links: () => (vscode.workspace.getConfiguration('friedliver.links').get('openIn') === 'external' ? 'external' : 'builtin'),
      openInBrowser: (url, signal) => this.browser.call({ tool: 'browser_open', url }, signal),
    });
    this.accountsPage = new AccountsPage(context.extensionUri, this.accounts, () => this.core, () => this.showDemo(), (line) => this.log.warn(line));
    this.core = new AgentCore({
      folders: () => this.folders(),
      noFolderCwd,
      permissions: this.permissions,
      clientVersion: String(context.extension.packageJSON.version ?? '0.0.0'),
      demoAgentScript: context.asAbsolutePath(path.join('dist', 'demo-agent.js')),
      agyAdapterScript: context.asAbsolutePath(path.join('dist', 'agy-acp.js')),
      bridgeScript: context.asAbsolutePath(path.join('dist', 'bridge.js')),
      agentToAgent: () => this.agentToAgent(),
      browser: (chatId, call, signal, expectOrigin) => this.browser.call(call, signal, expectOrigin, chatId),
      externalAutoApprove: () => this.browserSetting('externalAutoApprove', false),
      autoAllowLinkedReads: () => userSetting(vscode.workspace.getConfiguration('friedliver.chat').inspect<unknown>('autoAllowLinkedReads')).value === true,
      browserPage: (selector) => this.browser.inspect(selector),
      discussSettings: () => {
        const c = vscode.workspace.getConfiguration('friedliver.discuss');
        return { maxRounds: c.get<number>('maxRounds'), tokenBudget: c.get<number>('tokenBudget') };
      },
      index: async (call, chatId) => (this.projectIndex ? this.projectIndex.answer(call, chatId) : 'The project index is still starting. Try again shortly.'),
      indexEnabled: () => vscode.workspace.getConfiguration('friedliver.index').get<boolean>('enabled', true),
      indexSeen: (chatId, file) => this.projectIndex?.observe(chatId, file),
      indexTurnEnded: (chatId) => this.projectIndex?.turnEnded(chatId),
      primer: async (_chatId, text, maxTokens) => this.projectIndex?.primer(text, maxTokens),
      system: {
        settings: () => systemSettings((key) => vscode.workspace.getConfiguration('friedliver.system').inspect<unknown>(key)),
        prepare: (call) => system.prepare(call),
        audit: (line) => this.systemLog.appendLine(line),
        // Codicon syntax in an agent's words stays text.
        done: (summary) => void vscode.window.setStatusBarMessage(`$(device-desktop) Agent used: ${plainText(summary).replace(/\$\(/g, '$ (')}`, 5000),
      },
      approvalDefault: () => this.approvalDefault(),
      // Codex keeps which models the account may use; the other agents list only those already.
      modelVisibility: (agent) => (agent === 'codex' ? codexModelVisibility() : Promise.resolve(undefined)),
      // User settings only: a repository must not make requests allow themselves.
      autoRoutineSeconds: () => Number(userSetting(vscode.workspace.getConfiguration('friedliver.approvals').inspect<unknown>('autoRoutineSeconds')).value) || 0,
      sharedRules: (agent) => loadRules({ personalDir: this.context.globalStorageUri.fsPath, folder: this.folders()[0], trusted: vscode.workspace.isTrusted, agent }),
      remember: (fact) => {
        const folder = this.folders()[0];
        if (!folder || !vscode.workspace.isTrusted) return Promise.reject(new Error('This workspace is not trusted (or no folder is open), so FriedLiver keeps no project memory here.'));
        return remember(folder, fact);
      },
      defaults: {
        get: (agent) => this.context.globalState.get<Partial<Record<AgentKey, AgentDefaults>>>(DEFAULTS_KEY)?.[agent],
        set: (agent, value) => {
          const all = { ...this.context.globalState.get<Partial<Record<AgentKey, AgentDefaults>>>(DEFAULTS_KEY), [agent]: value };
          void this.context.globalState.update(DEFAULTS_KEY, all);
          this.postDefaults();
          this.accountsPage.refresh();
        },
      },
      agentCommand: (id) => this.agentConfig[id],
      apiKey: (id) => this.accounts.apiKey(id),
      credentialEnv: (id) => this.accounts.credentialEnv(id),
      accountSeen: (agent, patch) => this.accounts.note(agent, patch),
      limits: () => {
        const c = vscode.workspace.getConfiguration('friedliver');
        return { maxRunning: clamp(c.get<number>('maxRunningAgents', 3), 1, 6), idleStopMinutes: clamp(c.get<number>('idleStopMinutes', 10), 0, 240) };
      },
      log: (line) => this.log.info(line),
      checkpointDir: path.join(context.globalStorageUri.fsPath, 'checkpoints'),
      outputDir: path.join(context.globalStorageUri.fsPath, 'output'),
      ui: {
        showReview: (review) => !this.inlineChats.has(review.chatId ?? '') && void this.reviews.show(review, this.editor?.reviewPlacement(review) ?? this.besideManager()),
        closeReview: (id) => void this.reviews.close(id),
        askCommand: (ask) => !this.inlineChats.has(ask.chatId ?? '') && void this.askCommand(ask),
        askPermission: (ask) => !this.inlineChats.has(ask.chatId) && void this.askPermission(ask),
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
              detail: `${rule.kind === 'exact' ? 'This exact command' : `Any command that starts with "${rule.command}"`} will run without asking, in every chat in this workspace, for every agent. Lines that chain commands, redirect or set variables still ask. Revoke it in "FriedLiver: Manage Permissions".`,
            },
            'Always allow',
          )) === 'Always allow',
        confirmRemote: (ask) => this.remote?.confirm(ask) ?? Promise.resolve(false),
        signInUrl: (agent, url) => void this.offerSignInUrl(agent, url),
        unsavedText: (file) => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === file && d.isDirty)?.getText(),
      },
    });
    this.reviews = new ReviewUi(() => this.core);
    this.statusItem.name = 'FriedLiver decisions';
    this.statusItem.command = 'friedliver.openInbox';
    this.statusItem.color = new vscode.ThemeColor('friedliver.decision');
    this.workingItem.name = 'FriedLiver agents working';
    this.workingItem.command = 'friedliver.openTasks';
    this.autoItem.name = 'FriedLiver Auto mode';
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
      this.systemLog,
      this.statusItem,
      this.workingItem,
      this.autoItem,
      (this.projectIndex = new ProjectIndexHost(path.join(context.globalStorageUri.fsPath, 'index'), (m) => this.log.warn(m), context.extensionPath)),
      this.reviews,
      this.accounts,
      this.accountsPage,
      vscode.window.registerTreeDataProvider('friedliver.accounts', this.accounts),
      vscode.window.registerWebviewPanelSerializer(ACCOUNTS_PANEL, { deserializeWebviewPanel: async (panel) => this.accountsPage.adopt(panel) }),
      // Pickers show each agent's last known sign-in.
      this.accounts.onDidUpdate(() => this.postRoster()),
      vscode.window.registerWebviewViewProvider(
        'friedliver.agents',
        { resolveWebviewView: (view) => this.resolveView(view, 'chat', 'Agents') },
        { webviewOptions: { retainContextWhenHidden: false } },
      ),
      vscode.window.registerWebviewViewProvider('friedliver.chats', { resolveWebviewView: (view) => this.resolveView(view, 'chat', 'Chats', true) }),
      vscode.window.registerWebviewViewProvider('friedliver.images', { resolveWebviewView: (view) => this.resolveView(view, 'images', 'Images') }),
      { dispose: () => this.scaler.dispose() },
      vscode.window.registerWebviewPanelSerializer('friedliver.tasks', { deserializeWebviewPanel: async (panel) => this.adoptPanel(panel, 'tasks') }),
      vscode.window.registerWebviewPanelSerializer('friedliver.chatPanel', { deserializeWebviewPanel: async (panel) => this.adoptPanel(panel, 'chat') }),
      vscode.workspace.onDidChangeConfiguration((e) => this.onConfig(e)),
      registerBeforeProvider(() => this.core),
    );
    this.remote = new RemoteControl(context, {
      core: this.core,
      folders: () => this.folders(),
      agents: () => shownAgents(this.showDemo()),
      reviews: { accept: (id) => this.reviews.accept(id), reject: (id) => this.reviews.reject(id) },
      hidden: (chatId) => this.inlineChats.has(chatId),
      log: (line) => this.log.info(line),
    });
    context.subscriptions.push(this.remote);
    // What FriedLiver's compact answers saved, per chat, for the usage tooltip and the Agent Manager.
    const saved = (chatId: string, naive: number, sent: number) => this.core.noteTokens(chatId, { naive, sent });
    this.projectIndex!.onSaved = saved;
    this.browser.onSaved = saved;
    const unsubscribe = this.core.onAction((action, state) => {
      this.remote?.onAction(action);
      this.batcher.push(action);
      this.stateFile?.schedule();
      if (action.t === 'turnUsage') this.checkUsage(state);
    });
    context.subscriptions.push({ dispose: unsubscribe });

    command('friedliver.newChat', (agent?: unknown) => this.newChat(isAgentKey(agent) ? agent : undefined));
    command('friedliver.moveToCenter', () => this.moveToCenter());
    command('friedliver.moveToSide', () => this.moveToSide());
    command('friedliver.openBrowser', () => this.browser.show());
    command('friedliver.links.useBuiltin', () => vscode.workspace.getConfiguration('friedliver.links').update('openIn', 'builtin', vscode.ConfigurationTarget.Global));
    command('friedliver.links.useExternal', () => vscode.workspace.getConfiguration('friedliver.links').update('openIn', 'external', vscode.ConfigurationTarget.Global));
    this.browser.registerLinkOpener(linkMode);
    command('friedliver.system.showLog', () => this.systemLog.show(true));
    command('friedliver.connectClaudeBrowser', () => this.connectClaudeCommand());
    // Integration tests must not write the developer's ~/.claude.json.
    // Opt-in (friedliver.browser.externalClients, off by default): on, this launch's token is written and the
    // entry kept; off, an entry an earlier FriedLiver added is removed and ~/.claude.json is otherwise not touched.
    if (context.extensionMode !== vscode.ExtensionMode.Test) void this.connectClaude(false);
    command('friedliver.toggleCodeAndChat', () => this.toggleCodeAndChat());
    command('friedliver.openTasks', () => this.openTasks());
    command('friedliver.nextDecision', () => this.nextDecision());
    command('friedliver.openInbox', () => this.openInbox());
    command('friedliver.review.accept', (reviewId?: unknown) => {
      if (!this.reviews.accept(typeof reviewId === 'string' ? reviewId : undefined)) void vscode.window.showInformationMessage('No agent edit is waiting here.');
    });
    command('friedliver.review.reject', (reviewId?: unknown) => {
      if (!this.reviews.reject(typeof reviewId === 'string' ? reviewId : undefined)) void vscode.window.showInformationMessage('No agent edit is waiting here.');
    });
    command('friedliver.accounts', (agent?: unknown) => this.accountsPage.show(isAgentKey(agent) ? agent : undefined));
    command('friedliver.accounts.check', (node?: { agent?: unknown }) => {
      if (isAgentKey(node?.agent)) void this.accounts.check(node.agent);
      else this.accountsPage.show();
    });
    command('friedliver.signIn', (agent: unknown, methodId: unknown) => {
      if (isAgentKey(agent) && typeof methodId === 'string') void this.accounts.signIn(agent, methodId);
    });
    command('friedliver.setApiKey', (node?: { agent?: unknown }) => this.accounts.setKey(VENDOR_AGENTS.find((a) => a === node?.agent)));
    command('friedliver.stopAgents', () => this.core.stopAll());
    command('friedliver.otherAgents', () => this.otherAgents());
    command('friedliver.managePermissions', () => this.managePermissions());
    command('friedliver.rules.open', () => this.openRules());
    command('friedliver.rules.openMemory', () => this.openRuleFile(PROJECT_MEMORY));
    command('friedliver.rules.import', () => this.importRules());
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
    command('friedliver.rewind', (chatId?: unknown) => this.rewindCommand(typeof chatId === 'string' ? chatId : undefined));
    command('friedliver.pipe', (chatId?: unknown) => this.pipeCommand(typeof chatId === 'string' ? chatId : undefined));
    command('friedliver.diagnoseClaudeSessions', () => this.diagnoseClaudeSessions());
    this.editor = new EditorAgent(context, {
      core: this.core,
      showChat: (chatId, revealItem) => this.showChat(chatId, revealItem),
      currentChat: () => this.lastSelected,
      addToComposer: (chatId, ref) => this.addToComposer(chatId, ref),
      shownAgents: () => shownAgents(this.showDemo()),
      error: (err) => this.error(err),
    });
    context.subscriptions.push(this.editor, new InlineEditor(this.core, this.inlineChats));
    this.updateDecisions();
  }

  /** Opens a shared rules file (sharedRules.ts), creating it empty first. `rel` is in the folder; none means the personal one. */
  private async openRuleFile(rel?: string): Promise<void> {
    const folder = this.folders()[0];
    if (rel && !folder) return void vscode.window.showInformationMessage('Open a folder to keep project rules and memory.');
    const storage = this.context.globalStorageUri.fsPath;
    if (!rel) await mkdir(storage, { recursive: true });
    const file = await ensureFile(rel ? folder! : storage, rel ?? 'rules.md').catch((err: unknown) => void this.error(err));
    if (!file) return;
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  }

  /** Rules every agent follows: the project's, the user's own, and the project memory. */
  private async openRules(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Project rules', description: PROJECT_RULES, rel: PROJECT_RULES as string | undefined },
        { label: 'Personal rules', description: 'yours, in every project', rel: undefined },
        { label: 'Project memory', description: PROJECT_MEMORY, rel: PROJECT_MEMORY },
        { label: 'Import from CLAUDE.md / AGENTS.md / GEMINI.md', description: 'into ' + PROJECT_RULES, rel: 'import' },
      ],
      { title: 'Shared rules for Claude, Codex and Gemini' },
    );
    if (!pick) return;
    if (pick.rel === 'import') return this.importRules();
    await this.openRuleFile(pick.rel);
  }

  private async importRules(): Promise<void> {
    const folder = this.folders()[0];
    if (!folder) return void vscode.window.showInformationMessage('Open a folder to import its rules.');
    if (!vscode.workspace.isTrusted) return void vscode.window.showWarningMessage('Trust this workspace first: its rules files are only used in trusted workspaces.');
    const { added, sources } = await importRules(folder);
    if (!sources.length) return void vscode.window.showInformationMessage('No CLAUDE.md, AGENTS.md or GEMINI.md at the folder root.');
    void vscode.window.showInformationMessage(
      added ? `Imported ${added} new paragraph${added === 1 ? '' : 's'} from ${sources.join(', ')} into ${PROJECT_RULES}. The originals are unchanged.` : `${PROJECT_RULES} already has everything in ${sources.join(', ')}.`,
    );
    if (added) await this.openRuleFile(PROJECT_RULES);
  }

  async dispose(): Promise<void> {
    // Save before the core shuts down: stopping cancels running turns, and a
    // restored chat should read "stopped when the window closed", not "cancelled".
    await this.stateFile?.flush();
    this.stateFile?.stop();
    this.dictation.dispose();
    this.batcher.dispose();
    clearTimeout(this.claudeTimer);
    this.watchClaudeSessions(false);
    // Closing the window ends Done looking's undo time.
    for (const t of Object.values(this.imageTimers)) clearTimeout(t);
    await this.imageStore.commit(this.galleryImages()).catch(() => {});
    await this.imageStore.flush().catch(() => {});
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
    // Each kind of surface gets the actions it shows; a chat, for one, only the images you attached.
    const byKind = new Map<Script, Action[]>();
    for (const s of this.surfaces) {
      let mine = byKind.get(s.kind);
      if (!mine) byKind.set(s.kind, (mine = actionsFor(s.kind, actions)));
      if (mine.length) post(s, mine.length === 1 ? { type: 'action', action: mine[0] } : { type: 'actions', actions: mine });
    }
    this.updateDecisions();
    this.closeAnswered();
    this.retitle();
    this.scheduleImageCopies();
  }

  // ---- Image copies (host/imageStore.ts) ----

  private imageLimits(): Limits {
    const c = vscode.workspace.getConfiguration('friedliver.images');
    return { capBytes: Math.max(50, c.get<number>('storageLimitMB', 1024)) * 1024 * 1024, maxAgeMs: Math.max(1, c.get<number>('keepDays', 7)) * 86_400_000 };
  }

  /** Every image in the Images view (FriedLiver's chats and the outside sessions it has listed). */
  private galleryImages(): GalleryImage[] {
    return collectGallery(this.core.snapshot, this.claudeImages).images;
  }

  /**
   * Folders whose images Done looking may delete: FriedLiver's screenshot folders, and Claude Code's and
   * Gemini CLI's temp folders. Never the workspace. Candidates only: removeTemp drops any that fails
   * trustedRoot on every deletion (a symlink, someone else's, writable by others), so a /tmp/claude-<uid>
   * another user made first is never used. The per-user temp folder comes first.
   */
  private async tempRoots(): Promise<string[]> {
    const base = this.context.globalStorageUri.fsPath;
    const shots = (await readdir(base).catch(() => [] as string[])).filter((n) => /^shots-[A-Za-z0-9]{6}$/.test(n)).map((n) => path.join(base, n));
    const uid = process.getuid?.();
    const claude = uid === undefined ? [] : [...new Set([os.tmpdir(), '/tmp'])].map((d) => path.join(d, `claude-${uid}`));
    return [...shots, ...claude, path.join(os.homedir(), '.gemini', 'tmp')];
  }

  /** The safety net: copies past the age or over the cap go, and FriedLiver's own old screenshots. */
  private async tidyImages(): Promise<void> {
    const limits = this.imageLimits();
    await this.imageStore.enforce(limits);
    await sweepOld(this.context.globalStorageUri.fsPath, limits.maxAgeMs, this.imageStore.pinnedFiles());
  }

  /** Copies the images FriedLiver's chats read or made, soon after they appear, while their temp files still exist. */
  private scheduleImageCopies(): void {
    if (this.imageTimers.sync) return;
    this.imageTimers.sync = setTimeout(() => {
      this.imageTimers.sync = undefined;
      const hidden = new Set(this.imageStore.hidden());
      const fresh = collectGallery(this.core.snapshot).images.filter((i) => i.path && !hidden.has(i.key) && !this.copied.has(i.path));
      if (!fresh.length) return;
      void (async () => {
        for (const i of fresh) {
          this.copied.add(i.path!);
          await this.imageStore.ingest(i.path!, this.imageRoots()).catch(() => null);
        }
        await this.tidyImages();
      })().catch((err: unknown) => this.log.warn(`Image copies: ${messageOf(err)}`));
    }, 400);
  }

  private imageInfo(): ImageStoreInfo {
    return { used: this.imageStore.used(), cap: this.imageLimits().capBytes, pinned: this.imageStore.pinned(), hidden: this.imageStore.hidden() };
  }

  private postImageStore(): void {
    if (this.imageTimers.post) return;
    this.imageTimers.post = setTimeout(() => {
      this.imageTimers.post = undefined;
      const store = this.imageInfo();
      for (const s of this.surfaces) if (s.kind !== 'chat' && s.ready) post(s, { type: 'imageStore', store });
    }, 100);
  }

  /** The thumbnail or full image (`full`) from FriedLiver's copy, else from the file itself. */
  private async imageFor(file: string, full: boolean): Promise<string | null> {
    const copy: Copy | null = await this.imageStore.ingest(file, this.imageRoots()).catch(() => null);
    const thumb = (f: string, roots: string[]) => {
      const job = this.thumbQueue.then(() => imageThumb(f, roots, path.join(this.context.globalStorageUri.fsPath, 'thumbs'), this.scaler));
      this.thumbQueue = job.catch(() => {});
      return job.catch(() => null);
    };
    if (copy) {
      const src = full ? await imagePreview(copy.file, [this.imageStore.dir]) : await thumb(copy.preview ?? copy.file, [this.imageStore.dir]);
      if (src) return src;
    }
    return full ? imagePreview(file, this.imageRoots()) : thumb(file, this.imageRoots());
  }

  /** Each chat panel's and the Agents view's title follows the chat it has open: switched, renamed or titled by the agent. */
  private retitle(): void {
    for (const s of this.surfaces) s.retitle?.(this.core.chat(s.selected ?? this.lastSelected ?? ''));
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
    };
    if (kind === 'chat' && !list) {
      this.agentsView = view;
      // The view keeps its name; the open chat's topic goes beside it.
      surface.retitle = (chat) => {
        const description = chat ? panelTitle(chat).title : undefined;
        if (view.description !== description) view.description = description;
      };
    }
    this.addSurface(surface, title, view);
    this.retitle();
    this.updateDecisions();
  }

  private adoptPanel(panel: vscode.WebviewPanel, kind: Script): void {
    const surface: Surface = {
      kind,
      webview: panel.webview,
      selected: kind === 'chat' ? this.lastSelected : undefined,
      ready: false,
      visible: () => panel.visible,
    };
    if (kind === 'chat') this.chatPanel = panel;
    else this.tasksPanel = panel;
    const icon = (name: string) => vscode.Uri.joinPath(this.context.extensionUri, 'media', `${name}.svg`);
    panel.iconPath = icon('agents');
    // A chat tab is titled like Claude Code's: the topic of the chat it has open, with that agent's face.
    let shown = '';
    if (kind === 'chat')
      surface.retitle = (chat) => {
        const { title, agent } = panelTitle(chat);
        if (shown === `${title}\0${agent}`) return;
        shown = `${title}\0${agent}`;
        panel.title = title;
        panel.iconPath = agent ? icon(`agent-${agent}`) : icon('agents');
      };
    this.addSurface(surface, panel.title, panel);
    this.retitle();
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
      this.dictation.closed(surface);
      this.surfaces.delete(surface);
      if (surface.webview === this.agentsView?.webview) this.agentsView = undefined;
      if (surface.kind !== 'chat') this.refreshClaudeSessions();
    });
  }

  private chatSurfaces(): Surface[] {
    return [...this.surfaces].filter((s) => s.kind === 'chat');
  }

  /**
   * Open on a notification, a card or the Agent Manager: the chat in the chat tab, opening one when
   * there is none (or in the side Agents view when that is on screen instead). Selected before any
   * view opens, so a view that loads gets it in its snapshot, and the item to reveal is sent again
   * once it's ready. Never throws: its callers are notification buttons that can't show an error.
   */
  private async showChat(chatId: string, revealItem?: string): Promise<void> {
    if (!this.core.chat(chatId)) {
      void vscode.window.showInformationMessage('That chat is closed.');
      return;
    }
    this.lastSelected = chatId;
    const reveal: HostMessage | undefined = revealItem ? { type: 'reveal', chatId, id: revealItem } : undefined;
    if (reveal) this.remember(reveal);
    for (const s of this.chatSurfaces()) {
      s.selected = chatId;
      post(s, { type: 'select', chatId });
      if (reveal) post(s, reveal);
    }
    try {
      if (this.chatPanel || !this.agentsView?.visible) this.revealChatPanel();
    } catch (err) {
      this.error(err);
    }
  }

  /** Keeps a message for chat views that (re)load in the next seconds (see `replay`). */
  private remember(message: HostMessage): void {
    this.replay = [...this.replay.filter((r) => r.until > Date.now()), { message, until: Date.now() + REPLAY_MS }];
  }

  // ---- Messages from webviews (already validated) ----

  async handle(surface: Surface, m: WebviewMessage): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          // Queued actions are already in the snapshot: send them first, while this surface isn't ready, so it never gets them twice.
          this.batcher.flush();
          surface.ready = true;
          post(surface, {
            type: 'snapshot',
            state: stateFor(surface.kind, this.core.snapshot),
            selected: surface.selected ?? this.lastSelected,
            now: Date.now(),
            defaults: this.core.agentDefaults(),
            roster: this.roster(),
            discussLayout: this.discussLayout(),
          });
          if (surface.kind === 'tasks' && this.inboxWanted) {
            this.inboxWanted = false;
            post(surface, { type: 'showInbox' });
          }
          if (surface.kind !== 'chat') {
            if (this.claudeImages.length) post(surface, { type: 'claudeImages', sessions: this.claudeImages });
            post(surface, { type: 'imageStore', store: this.imageInfo() });
            this.refreshClaudeSessions();
          }
          if (surface.kind === 'chat') {
            this.replay = this.replay.filter((r) => r.until > Date.now());
            for (const r of this.replay) post(surface, r.message);
          }
          return;
        case 'newChat':
          await this.newChat(m.agent, surface.list ? undefined : surface);
          return;
        case 'select':
          surface.selected = m.chatId;
          this.lastSelected = m.chatId;
          this.retitle();
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
        case 'rewind':
          await this.rewindCommand(m.chatId, m.turnId);
          return;
        case 'undo':
          // The turn's card says "Turn undone"; a file left alone gets a notice in the chat.
          await this.core.undo(m.chatId, m.turnId);
          return;
        case 'notice':
          await this.noticeAction(m.chatId, m.action);
          return;
        case 'imageSrc':
        case 'imageThumb': {
          const src = await this.imageFor(m.path, m.type === 'imageSrc');
          post(surface, { type: m.type, path: m.path, ...(src ? { src } : {}) });
          return;
        }
        case 'imagesDone': {
          // The view names a scope only: which images and files that is, the host decides from its own state.
          const all = this.galleryImages();
          const hidden = new Set(this.imageStore.hidden());
          const scope = doneScope(all.filter((i) => !hidden.has(i.key)), new Set(this.imageStore.pinned()), m.chatId);
          const ref = (i: GalleryImage): GalleryRef => ({ key: i.key, ...(i.path ? { path: i.path } : {}) });
          await this.imageStore.done(scope.map(ref), all.map(ref));
          // If the view goes away before its undo time ends, this commits instead.
          clearTimeout(this.imageTimers.commit);
          this.imageTimers.commit = setTimeout(() => void this.imageStore.commit(this.galleryImages()).catch(() => {}), 60_000);
          return;
        }
        case 'imagesUndo':
          clearTimeout(this.imageTimers.commit);
          this.imageStore.undo();
          return;
        case 'imagesCommit': {
          clearTimeout(this.imageTimers.commit);
          const r = await this.imageStore.commit(this.galleryImages());
          if (r.copies || r.originals) this.log.info(`Done looking: removed ${r.copies} image copies and ${r.originals} temp files.`);
          return;
        }
        case 'imagePin': {
          const img = this.galleryImages().find((i) => i.key === m.key);
          if (m.pinned && !img) return;
          await this.imageStore.pin({ key: m.key, ...(img?.path ? { path: img.path } : {}) }, m.pinned);
          // A pinned image keeps a copy, also after its temp file is gone.
          if (m.pinned && img?.path) await this.imageStore.ingest(img.path, this.imageRoots()).catch(() => null);
          return;
        }
        case 'openImage':
          // The editor's image preview shows it (no scripts, SVG included); outside the roots too, since the user asked.
          if (isImagePath(m.path) && path.isAbsolute(m.path)) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(m.path), vscode.ViewColumn.Beside);
          return;
        case 'revealImage':
          // Only shows where the file is; nothing is opened or run.
          if (isImagePath(m.path) && path.isAbsolute(m.path)) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(m.path));
          return;
        case 'dictationSettings':
          await vscode.env.openExternal(vscode.Uri.parse(DICTATION_SETTINGS, true));
          return;
        case 'dictate':
          if (m.on) this.dictation.start(surface, m.chatId);
          else this.dictation.stop(m.chatId);
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
          const chat = await this.core.createChat(m.agent, { worktree: m.worktree, title: m.prompt, choices: m.choices?.[m.agent], approval, messageFollows: true });
          void this.core.send(chat.id, m.prompt).catch((err: unknown) => this.error(err));
          return;
        }
        case 'openChat':
          // From the side bar's list: into the chat tab, opening one when there is none.
          if (surface.list && !this.chatPanel) await this.moveToCenter();
          await this.showChat(m.chatId, m.item);
          return;
        case 'watchSubagent':
          this.subagent?.watch.stop();
          this.subagent = m.sessionId && m.id ? { watch: new SubagentWatch(m.sessionId, m.id), surface } : undefined;
          await this.pushSubagent();
          return;
        case 'openClaudeSession': {
          // Only a session this window listed, so a webview can't name some other folder's.
          const found = this.claudeSessions.find((s) => s.id === m.sessionId);
          if (!found) return;
          // A chat already continues it (one that only resumed it shows in its card): that chat, not another.
          const existing = found.chatId ?? chatOfSession(this.core.exportState(), found.id);
          if (existing) {
            await this.showChat(existing);
            return;
          }
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
        case 'openInbox':
          this.openInbox();
          return;
        case 'openTasks':
          this.openTasks();
          return;
        case 'handoff': {
          const chat = await this.core.handoff(m.chatId, m.agent, m.fresh);
          this.selectOn(surface, chat.id);
          return;
        }
        case 'consult':
          void this.core.consult(m.chatId, m.agent, m.text, 'user', [], m.fresh).catch((err: unknown) => this.error(err));
          return;
        case 'discuss':
          void this.core.discuss(m.chatId, m.participants, m.text).catch((err: unknown) => this.error(err));
          return;
        case 'discussion':
          if (m.act === 'point') return this.core.discussions.addPoint(m.id, m.text!);
          void (m.act === 'stop' ? this.core.discussions.stop(m.id) : m.act === 'continue' ? this.core.discussions.continue(m.id) : this.core.discussions.carryOut(m.id, m.agent!)).catch((err: unknown) =>
            this.error(err),
          );
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
        case 'openRules':
          void this.openRules();
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
          const ok = await vscode.window.showWarningMessage(`Remove ${chatRef(chat)} (${agentName(chat.agent)})?`, { modal: true, detail: 'Its history goes. A worktree it had stays on disk.' }, 'Remove');
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
        case 'stopAuto':
          this.core.stopAuto(m.id);
          return;
        case 'allowAlways':
          await this.core.allowAlways(m.requestId !== undefined ? { requestId: m.requestId } : { commandId: m.commandId! }, m.grant);
          return;
        case 'managePermissions':
          this.managePermissions();
          return;
        case 'revokePermission':
        case 'revokeAllPermissions':
          await this.permissionMessage(m);
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
        case 'openLink':
          await this.openLink(m.url, m.modifier);
          return;
        case 'openText': {
          // An untitled document in FriedLiver's output language, so it wraps; the user's own files keep their setting.
          const doc = await vscode.workspace.openTextDocument({ content: m.text, language: 'friedliver-output' });
          await vscode.window.showTextDocument(doc, { preview: true });
          return;
        }
        case 'otherAgents':
          await this.otherAgents();
          return;
        case 'openAccounts':
          this.accountsPage.show(m.agent);
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
    this.remember(message);
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
    const terminal = vscode.window.createTerminal({ name: `${agentName(chat.agent)}: ${clip(chatName(chat), 40)}`, cwd: folder });
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
      case 'compact':
        await this.core.compact(chatId).catch((err: unknown) => this.error(err));
        return;
      case 'setOption':
        // Only a value the agent offers; then the message that failed goes again.
        await this.core.setOption(chatId, action.optionId, action.value).catch((err: unknown) => this.error(err));
        retry();
        return;
      case 'signIn':
        await this.accounts.signIn(action.agent, action.methodId, retry);
        return;
      case 'apiKey':
        if (isVendor(action.agent)) await this.accounts.setKey(action.agent);
        return;
      case 'accounts':
        this.accountsPage.show(action.agent);
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
          shownAgents(this.showDemo()).map((a) => ({ label: AGENT_FACES[a].name, description: this.pickHint(a), agent: a })),
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
    this.revealChatPanel(column);
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  }

  /** The chat tab, opened when there is none. */
  private revealChatPanel(column?: vscode.ViewColumn): void {
    if (this.chatPanel) {
      this.chatPanel.reveal(column);
    } else {
      const panel = vscode.window.createWebviewPanel('friedliver.chatPanel', 'Agents', column ?? vscode.ViewColumn.Active, { retainContextWhenHidden: false });
      this.adoptPanel(panel, 'chat');
    }
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

  /** Open Decision Inbox: the Agent Manager on its Inbox; a Manager still loading turns to it once ready. */
  openInbox(): void {
    const live = [...this.surfaces].find((s) => s.kind === 'tasks' && s.ready && s.visible());
    this.openTasks();
    if (live) post(live, { type: 'showInbox' });
    else this.inboxWanted = true;
  }

  /** While you look at the Agent Manager, a diff an agent opens goes beside it, unfocused, instead of covering it. */
  private besideManager(): ReviewPlacement | undefined {
    return this.tasksPanel?.active ? { viewColumn: vscode.ViewColumn.Beside, focus: false } : undefined;
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
      prompt: `The answer comes back into ${chatRef(source)}.`,
      validateInput: (v) => (v.trim() ? undefined : 'Type a question.'),
    });
    if (!text?.trim()) return;
    void this.core.consult(source.id, agent, text).catch((err: unknown) => this.error(err));
    await this.showChat(source.id);
  }

  /** "Run a Task on Several Agents": one prompt, a chat per agent, to compare. */
  async fanoutCommand(): Promise<void> {
    // Preselected: the agents that can run (not ones the Accounts page found not installed); Demo only when nothing else can.
    const roster = this.roster();
    const vendors = roster.agents.filter((a) => a !== 'demo' && installedOrUnknown(roster, a));
    const preselected = vendors.length ? vendors : preselectAgents(roster, []);
    const picked = await vscode.window.showQuickPick(
      roster.agents.map((a) => ({ label: AGENT_FACES[a].name, description: this.pickHint(a), agent: a, picked: preselected.includes(a) })),
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
    const to = await this.pickChat(`Send each reply from ${chatRef(from)} to…`, undefined, from.id);
    if (!to) return;
    try {
      this.core.pipe(from.id, to.id);
      void vscode.window.showInformationMessage(`Each reply from ${chatRef(from)} now goes to ${chatRef(to)}.`);
    } catch (err) {
      this.error(err);
    }
  }

  /** "Rewind to here" from a message, or the chat's checkpoint list (the command, the ⋯ menu). */
  private async rewindCommand(chatId?: string, turnId?: string): Promise<void> {
    const chat = await this.pickChat('Rewind which chat?', chatId);
    if (!chat) return;
    if (chat.busy) {
      void vscode.window.showInformationMessage('Wait for the agent to finish, or stop it, before rewinding.');
      return;
    }
    try {
      await runRewind(this.core, {
        pick: async (title, items) => (await vscode.window.showQuickPick(items, { title, matchOnDetail: true }))?.value,
        confirm: async (message, detail, button) => (await vscode.window.showWarningMessage(message, { modal: true, detail }, button)) === button,
        info: (message) => void vscode.window.showInformationMessage(message),
      }, chat.id, turnId);
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
      .map((c) => ({ ...chatPick(c), chat: c }))
      .sort((a, b) => (b.chat.id === this.lastSelected ? 1 : 0) - (a.chat.id === this.lastSelected ? 1 : 0));
    return (await vscode.window.showQuickPick(items, { title }))?.chat;
  }

  /** Another agent first: these commands are for reaching a different one. */
  private async pickAgent(title: string, current: AgentKey): Promise<AgentKey | undefined> {
    const shown = shownAgents(this.showDemo());
    const order = [...shown.filter((a) => a !== current && a !== 'demo'), ...shown.filter((a) => a === current || a === 'demo')];
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
      this.statusItem.text = `$(inbox) Inbox · ${n}`;
      this.statusItem.tooltip = new vscode.MarkdownString(['**Agents are waiting for you**', ...waiting.map((d) => `- ${d.title.replace(/[\\`*_[\]<>]/g, '\\$&')}`)].join('\n'));
      this.statusItem.accessibilityInformation = { label: `${n} agent decision${n === 1 ? '' : 's'} waiting. Open the Inbox.` };
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
    const shown = statusTexts(busy, full);
    if (shown.working) {
      this.workingItem.text = shown.working.text;
      this.workingItem.tooltip = shown.working.tooltip;
      this.workingItem.show();
    } else {
      this.workingItem.hide();
    }
    if (shown.auto) {
      this.autoItem.text = shown.auto.text;
      this.autoItem.tooltip = shown.auto.tooltip;
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
    return [...this.surfaces].some((s) => showsChat(s, chatId, this.lastSelected));
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
      if (button.title !== 'Show' && button.title !== 'Manage' && !this.core.decisions().some((d) => d.id === id)) return;
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
  private askCommand(ask: { chatId?: string; commandId: string; agentLabel: string; commandLine: string; careful?: boolean }): void {
    // A careful command is allowed only by holding on its card: no Run here.
    const shown = { ...commandNotice(ask.commandLine), ...(ask.careful ? { runnable: false } : {}) };
    if (shown.runnable) this.runnable.add(ask.commandId);
    const buttons = [
      ...(shown.runnable ? [{ title: 'Run', run: () => this.runnable.has(ask.commandId) && this.core.decideCommand(ask.commandId, true) }] : []),
      { title: 'Deny', run: () => this.core.decideCommand(ask.commandId, false) },
      ...(ask.chatId ? [{ title: 'Show', run: () => void this.showChat(ask.chatId!, ask.commandId) }] : []),
      this.manageButton,
    ];
    const text = `${plainText(ask.agentLabel)} wants to run: ${shown.text}${ask.careful ? ' (careful: allow it in the chat)' : shown.runnable ? '' : ' (open the chat to see all of it)'}`;
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
      this.manageButton,
    ]);
  }

  /** On every approval toast: the remembered "Always allow" answers, to look over or revoke. */
  private readonly manageButton = { title: 'Manage', run: () => this.managePermissions() };

  private askBridge(ask: { chatId: string; requestId: string; title: string; detail?: string; always?: string; careful?: boolean; once?: boolean }): void {
    if (isExternal(ask.chatId)) {
      // No chat holds this request, so it always gets its own popup, whatever else is waiting. Careful: once only.
      const buttons: Record<string, BridgeAnswer | 'manage'> = {
        Allow: 'allow',
        ...(ask.careful || ask.once ? {} : { 'Allow for this session': 'allowChat' as const }),
        ...(ask.always && !ask.careful && !ask.once ? { [`Always allow ${plainText(ask.always)}`]: 'allowAlways' as const } : {}),
        Deny: 'deny',
        Manage: 'manage',
      };
      // Not modal; the detail (bridgeRequests.externalDetail) says exactly what and where, so consent isn't blind.
      void vscode.window.showWarningMessage(`${plainText(ask.title)}: ${plainText(ask.detail ?? '')}`, ...Object.keys(buttons)).then((picked) => {
        const answer = picked ? buttons[picked] : undefined;
        if (answer === 'manage') this.managePermissions();
        else if (answer) this.core.answerBridge(ask.requestId, answer);
      });
      return;
    }
    const item = this.core.chat(ask.chatId)?.items.find((i): i is Extract<Item, { kind: 'bridge' }> => i.kind === 'bridge' && i.requestId === ask.requestId);
    const always = item?.once ? undefined : item?.always;
    // A careful one (a purchase, a form submit) is allowed only by holding on its card; a once-only one never for the chat or always.
    this.notifyDecision(ask.requestId, ask.chatId, plainText(ask.title), [
      ...(ask.careful
        ? []
        : [
            { title: 'Allow', run: () => this.core.answerBridge(ask.requestId, 'allow') },
            ...(item?.once ? [] : [{ title: 'Allow for this chat', run: () => this.core.answerBridge(ask.requestId, 'allowChat') }]),
            ...(always ? [{ title: 'Always allow', run: () => this.core.answerBridge(ask.requestId, 'allowAlways') }] : []),
          ]),
      { title: 'Deny', run: () => this.core.answerBridge(ask.requestId, 'deny') },
      { title: 'Show', run: () => void this.showChat(ask.chatId, ask.requestId) },
      this.manageButton,
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
  private turnEnded(t: { chatId: string; agent: AgentKey; title: string; stopReason: string | null; failure?: Item; files: number; byUser: boolean }): void {
    if (!t.byUser || this.onScreen(t.chatId)) return;
    const open = { title: 'Open', run: () => void this.showChat(t.chatId) };
    if (t.failure?.kind === 'notice') {
      const actions = (t.failure.actions ?? []).slice(0, 2).map((a) => ({ title: a.label, run: () => void this.noticeAction(t.chatId, a).catch((err: unknown) => this.error(err)) }));
      void vscode.window.showErrorMessage(plainText(turnEndedText({ ...t, failure: t.failure.text })), ...[...actions, open].map((b) => b.title)).then((picked) => {
        [...actions, open].find((b) => b.title === picked)?.run();
      });
      return;
    }
    if (t.stopReason === 'cancelled' || !vscode.workspace.getConfiguration('friedliver.notify').get<boolean>('finished', true)) return;
    const buttons = [open, ...(t.files ? [{ title: 'View changes', run: () => void viewChanges(this.core, t.chatId) }] : [])];
    void vscode.window.showInformationMessage(plainText(turnEndedText({ agent: t.agent, title: t.title, files: t.files })), ...buttons.map((b) => b.title)).then((picked) => {
      buttons.find((b) => b.title === picked)?.run();
    });
  }

  /** Full auto, once per chat: the agent edits and runs commands without asking until switched back. */
  private async confirmFullAuto(ask: { label: string; agent: string; mode?: string }): Promise<boolean> {
    const mode = ask.mode ? ` FriedLiver switches ${ask.agent} to its "${ask.mode}" mode.` : '';
    const picked = await vscode.window.showWarningMessage(
      `Run ${ask.label} in Auto?`,
      {
        modal: true,
        detail: `${APPROVAL_HINTS.full}, until you switch the chat back.${mode} In that mode the agent itself may not ask at all; FriedLiver still asks before commands in folders outside the workspace and before plans. Each turn can still be undone from its "Changed files" card.`,
      },
      'Use Auto',
    );
    return picked === 'Use Auto';
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

  /** "FriedLiver: Manage Permissions": every remembered "Always allow", to revoke. */
  managePermissions(): void {
    if (this.permissionsPanel) {
      this.permissionsPanel.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('friedliver.permissions', 'Permissions', vscode.ViewColumn.Active, { retainContextWhenHidden: false });
    this.permissionsPanel = { panel, ready: false };
    panel.webview.options = webviewOptions(this.context.extensionUri);
    panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri, 'permissions', 'Permissions');
    const sub = panel.webview.onDidReceiveMessage((raw: unknown) => {
      const m = parseWebviewMessage(raw);
      if (m) void this.permissionMessage(m);
    });
    panel.onDidDispose(() => {
      sub.dispose();
      this.permissionsPanel = undefined;
    });
  }

  private async permissionMessage(m: WebviewMessage): Promise<void> {
    if (m.type === 'ready' && this.permissionsPanel) {
      this.permissionsPanel.ready = true;
      this.postPermissions();
    } else if (m.type === 'revokePermission') {
      this.permissions.revoke(m.id);
    } else if (m.type === 'revokeAllPermissions') {
      const n = this.permissions.list().length;
      if (!n) return;
      const ok = await vscode.window.showWarningMessage(
        `Revoke all ${n} remembered permission${n === 1 ? '' : 's'}?`,
        { modal: true, detail: 'Agents ask again before using these websites, folders, commands and tools.' },
        'Revoke all',
      );
      if (ok === 'Revoke all') this.permissions.revokeAll();
    }
  }

  private postPermissions(): void {
    if (!this.permissionsPanel?.ready) return;
    const message: HostMessage = { type: 'permissions', rules: this.permissions.list() };
    void this.permissionsPanel.panel.webview.postMessage(message).then(undefined, () => {});
  }

  /** Demo is a fake local agent for trying the UI; pickers offer it only when the user turned it on. */
  private showDemo(): boolean {
    return userSetting(vscode.workspace.getConfiguration('friedliver').inspect<unknown>('showDemoAgent')).value === true;
  }

  private roster() {
    return rosterOf(this.showDemo(), this.accounts.records());
  }

  private discussLayout(): DiscussLayout {
    return discussLayoutOf(vscode.workspace.getConfiguration('friedliver.discuss').get<unknown>('layout'));
  }

  private postRoster(): void {
    const message: HostMessage = { type: 'roster', roster: this.roster() };
    for (const s of this.surfaces) post(s, message);
  }

  /** A quick pick's note for an agent: Demo's nature, or a sign-in it was last known to need. */
  private pickHint(agent: AgentKey): string | undefined {
    if (agent === 'demo') return 'fake local agent, no account';
    const status = this.accounts.record(agent)?.status;
    return status === 'needs-sign-in' ? 'needs sign-in' : status === 'not-installed' ? 'not installed' : undefined;
  }

  private postDefaults(): void {
    const message: HostMessage = { type: 'defaults', defaults: this.core.agentDefaults() };
    for (const s of this.surfaces) post(s, message);
  }

  /** A web link the user clicked: FriedLiver's browser or the system's, by friedliver.links.openIn, the other way with Cmd/Ctrl. */
  private async openLink(url: string, modifier: boolean): Promise<void> {
    // Checked here too: a webview's word is never enough.
    const t = linkTarget(url);
    if (t?.kind !== 'web') return;
    if (linkDestination(linkMode(), modifier) === 'builtin' && this.browser.supported()) return this.browser.openUserTab(t.url);
    await openInSystemBrowser(t.url);
  }

  private async offerSignInUrl(agent: AgentKey, url: string): Promise<void> {
    if (this.asked.has(url)) return;
    this.asked.add(url);
    const open = await vscode.window.showInformationMessage(`${AGENT_FACES[agent].name} printed a sign-in link.`, 'Open sign-in page');
    // Sign-in pages talk back to the agent on this machine: the system browser, never FriedLiver's.
    if (open) await openInSystemBrowser(url);
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
    return { claude: one('claude'), codex: one('codex'), gemini: one('gemini'), antigravity: one('antigravity') };
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
  private connectClaude(show: boolean): Promise<void> {
    // One at a time: the command and the setting it turns on both get here, and both write ~/.claude.json.
    this.claudeLink = this.claudeLink.then(() => this.linkClaude(show));
    return this.claudeLink;
  }

  /** FriedLiver: Connect Claude Code to the browser: the explicit opt-in; turns friedliver.browser.externalClients on in your user settings. */
  private async connectClaudeCommand(): Promise<void> {
    if (!this.browserSetting('externalClients', false)) {
      // The setting's change connects (onConfig); this call reports the result.
      await vscode.workspace.getConfiguration('friedliver.browser').update('externalClients', true, vscode.ConfigurationTarget.Global);
    }
    await this.connectClaude(true);
  }

  private async linkClaude(show: boolean): Promise<void> {
    const say = (text: string, error = false) => {
      if (error) this.log.warn(text);
      else this.log.info(text);
      if (show) void (error ? vscode.window.showErrorMessage(text) : vscode.window.showInformationMessage(text));
    };
    try {
      if (!this.browserSetting('externalClients', false)) {
        this.core.revokeExternal();
        await removeTokenFile(this.context.globalStorageUri.fsPath);
        // Only the entry FriedLiver added, and only when there is one: otherwise the file isn't written.
        const removed = await unregisterClaude(CLAUDE_CONFIG());
        return say(`Claude Code is not connected to the browser: friedliver.browser.externalClients is off${removed ? '; removed the friedliver-browser entry FriedLiver had added to ~/.claude.json' : ''}.`);
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

  /** The optional daily spending warning (friedliver.usage.dailyTokenWarning; off by default), once a day. */
  private checkUsage(state: AppState): void {
    const limit = Number(userSetting(vscode.workspace.getConfiguration('friedliver.usage').inspect<unknown>('dailyTokenWarning')).value) || 0;
    if (!limit) return;
    const now = Date.now();
    const warn = dailyWarning(limit, usageTotals(state.chats, now).today.total, now, this.usageWarned);
    if (!warn) return;
    this.usageWarned = warn.day;
    void vscode.window.showWarningMessage(warn.text);
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

  /** Writes what the Manager's Claude Code lane reads, and why each session is shown or hidden, to an output channel. */
  private async diagnoseClaudeSessions(): Promise<void> {
    if (!this.claudeReport) {
      this.claudeReport = vscode.window.createOutputChannel('FriedLiver: Claude Code Sessions');
      this.context.subscriptions.push(this.claudeReport);
    }
    const out = this.claudeReport;
    const folders = this.folders();
    const owned = new Set(Object.values(this.core.exportState().chats).flatMap((c) => (c.sessionId ? [c.sessionId] : [])));
    const shown = vscode.workspace.getConfiguration('friedliver').get<boolean>('showClaudeCodeSessions', true);
    const showAll = vscode.workspace.getConfiguration('friedliver.claudeSessions').get<boolean>('showAll', false);
    const report: string[] = [];
    const sessions = await listClaudeSessions({ home: os.homedir(), folders, skip: owned, showAll, report });
    out.clear();
    out.appendLine(`Claude Code sessions, ${new Date().toISOString()}`);
    out.appendLine(`folders: ${folders.length ? folders.join(', ') : 'none (every project from the last week)'}`);
    out.appendLine(`friedliver.showClaudeCodeSessions: ${shown}, friedliver.claudeSessions.showAll: ${showAll}`);
    out.appendLine(`sessions FriedLiver's chats have: ${owned.size ? [...owned].join(', ') : 'none'}`);
    out.appendLine(`listed: ${sessions.length}; the Manager last got: ${this.claudeSessions.length}`);
    for (const line of report) out.appendLine(line);
    out.show(true);
  }

  private async readClaudeSessions(): Promise<void> {
    const shown = vscode.workspace.getConfiguration('friedliver').get<boolean>('showClaudeCodeSessions', true);
    const manager = shown && [...this.surfaces].some((s) => s.kind === 'tasks');
    // The Images view and the Manager's Images tab show what those sessions looked at.
    const gallery = shown && [...this.surfaces].some((s) => s.kind !== 'chat');
    this.watchClaudeSessions(gallery);
    const saved = this.core.exportState();
    const owned = new Set(Object.values(saved.chats).flatMap((c) => (c.sessionId ? [c.sessionId] : [])));
    const home = os.homedir();
    const folders = this.folders();
    this.claudeSessions = manager ? linkResumeChats(await listClaudeSessions({
          home,
          folders,
          skip: owned,
          showAll: vscode.workspace.getConfiguration('friedliver.claudeSessions').get<boolean>('showAll', false),
        }), saved) : [];
    for (const s of this.surfaces) if (s.kind === 'tasks' && s.ready) post(s, { type: 'claudeSessions', sessions: this.claudeSessions });
    await this.pushSubagent();
    const images = gallery ? await listClaudeImages({ home, folders, skip: owned }) : [];
    if (JSON.stringify(images) === JSON.stringify(this.claudeImages)) return;
    this.claudeImages = images;
    for (const s of this.surfaces) if (s.kind !== 'chat' && s.ready) post(s, { type: 'claudeImages', sessions: images });
  }

  /** Sends the open subagent detail what its transcript gained (the watcher above calls this, debounced, as it grows). */
  private async pushSubagent(): Promise<void> {
    const sub = this.subagent;
    if (!sub) return;
    if (!this.surfaces.has(sub.surface)) {
      sub.watch.stop();
      this.subagent = undefined;
      return;
    }
    const detail = await sub.watch.read();
    if (detail && this.subagent === sub && sub.surface.ready) post(sub.surface, { type: 'subagentDetail', detail });
  }

  /**
   * Watches the folders' Claude Code project folders while the Manager is open, subfolders included: subagents write to
   * <session>/subagents/. A watcher stays while its folder does; a project folder made later is picked up on the next read.
   * A window with no folder lists every project's sessions, so it watches all of ~/.claude/projects ('' below).
   */
  private watchClaudeSessions(on: boolean): void {
    const folders = this.folders();
    const want = new Set(on ? (folders.length ? folders : ['']) : []);
    for (const [folder, w] of this.claudeWatchers) {
      if (want.has(folder)) continue;
      w.close();
      this.claudeWatchers.delete(folder);
    }
    for (const folder of want) {
      if (this.claudeWatchers.has(folder)) continue;
      try {
        const dir = path.join(os.homedir(), '.claude', 'projects', folder ? encodeCwd(folder) : '');
        const w = watch(dir, { recursive: true }, () => this.refreshClaudeSessions());
        w.on('error', () => {
          w.close();
          if (this.claudeWatchers.get(folder) === w) this.claudeWatchers.delete(folder);
        });
        this.claudeWatchers.set(folder, w);
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
    if (e.affectsConfiguration('friedliver.discuss.layout')) {
      const message: HostMessage = { type: 'discussLayout', layout: this.discussLayout() };
      for (const s of this.surfaces) post(s, message);
    }
    if (e.affectsConfiguration('friedliver.images')) void this.tidyImages().finally(() => this.postImageStore());
    if (e.affectsConfiguration('friedliver.showDemoAgent')) {
      this.accounts.refresh();
      this.postRoster();
    }
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
