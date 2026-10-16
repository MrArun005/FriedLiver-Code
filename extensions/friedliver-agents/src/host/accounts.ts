import * as vscode from 'vscode';
import { launchFor } from '@friedliver/main/agents/processes';
import type { VendorAgentId } from '@friedliver/main/agents/registry';
import { AGENT_FACES, AGENT_KEYS, type AgentKey } from '../shared/model';
import { KEY_ENV, VENDOR_AGENTS, messageOf, type AccountStatus, type AgentCore } from './core';
import { plainText } from './notify';

const STATUS_TEXT: Record<AccountStatus['status'], string> = {
  'signed-in': 'Signed in',
  'needs-sign-in': 'Needs sign-in',
  'not-installed': 'Not installed',
  error: 'Problem',
};

type Node = { agent: AgentKey } | { agent: AgentKey; method: AccountStatus['methods'][number] } | { other: true };

/**
 * Sign-in, the same flows as the app (docs/adr/0001-agent-login.md): the
 * agent's own CLI login in a terminal, ACP authenticate for browser logins,
 * or an API key kept in SecretStorage and given only to that agent.
 * Checking starts the agent, so it only happens when the user asks.
 */
export class Accounts implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly status = new Map<AgentKey, AccountStatus | 'checking'>();
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly keys = new Map<VendorAgentId, string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly core: () => AgentCore,
    private readonly cwd: () => string | undefined,
    private readonly keyChanged: (agent: VendorAgentId) => void,
  ) {
    this.disposables.push(
      secrets.onDidChange(async (e) => {
        const agent = VENDOR_AGENTS.find((a) => secretName(a) === e.key);
        if (!agent) return;
        await this.loadKey(agent);
        this.keyChanged(agent);
        this.changed.fire(undefined);
      }),
    );
  }

  async loadKeys(): Promise<void> {
    await Promise.all(VENDOR_AGENTS.map((a) => this.loadKey(a)));
  }

  apiKey(agent: VendorAgentId): string | undefined {
    return this.keys.get(agent);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if ('other' in node) {
      const item = new vscode.TreeItem('Other agent extensions…');
      item.description = 'Claude Code, Cline, Roo Code…';
      item.tooltip = 'Install another agent extension from the gallery, as its publisher ships it. FriedLiver’s reviews and approvals don’t cover it.';
      item.iconPath = new vscode.ThemeIcon('extensions');
      item.command = { command: 'friedliver.otherAgents', title: 'Get Another Agent Extension' };
      return item;
    }
    if ('method' in node) {
      const item = new vscode.TreeItem(node.method.name);
      item.description = node.method.kind === 'terminal' ? 'in a terminal' : node.method.kind === 'key' ? 'API key' : 'in the browser';
      item.tooltip = node.method.description;
      item.command = { command: 'friedliver.signIn', title: 'Sign in', arguments: [node.agent, node.method.id] };
      return item;
    }
    const s = this.status.get(node.agent);
    const item = new vscode.TreeItem(AGENT_FACES[node.agent].name);
    const key = node.agent !== 'demo' && this.keys.has(node.agent) ? ' · API key saved' : '';
    const version = typeof s === 'object' && s.version ? ` · ${s.update ? `${s.version}, update it` : s.version}` : '';
    item.description = (s === 'checking' ? 'Checking…' : s ? STATUS_TEXT[s.status] : 'Not checked') + version + key;
    item.tooltip = typeof s === 'object' && (s.update ?? s.message) ? (s.update ?? s.message) : 'Click to check. Checking starts the agent.';
    item.contextValue = node.agent === 'demo' ? 'agent-demo' : 'agent-vendor';
    item.collapsibleState = typeof s === 'object' && s.methods.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
    item.command = { command: 'friedliver.accounts.check', title: 'Check sign-in', arguments: [node] };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) return [...AGENT_KEYS.map((agent) => ({ agent })), { other: true as const }];
    if ('other' in node) return [];
    const s = 'method' in node ? undefined : this.status.get(node.agent);
    return typeof s === 'object' ? s.methods.map((method) => ({ agent: node.agent, method })) : [];
  }

  async check(agent: AgentKey): Promise<AccountStatus> {
    this.status.set(agent, 'checking');
    this.changed.fire(undefined);
    const s = await vscode.window.withProgress(
      { location: { viewId: 'friedliver.accounts' }, title: `Checking ${AGENT_FACES[agent].name}` },
      () => this.core().checkAccount(agent),
    );
    this.status.set(agent, s);
    this.changed.fire(undefined);
    return s;
  }

  /** The Accounts command: pick an agent, check it, and offer its sign-in methods. */
  async pickAndCheck(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      AGENT_KEYS.map((agent) => ({ label: AGENT_FACES[agent].name, description: 'Check sign-in (starts the agent)', agent })),
      { title: 'FriedLiver accounts' },
    );
    if (!pick) return;
    const s = await this.check(pick.agent);
    if (s.status === 'signed-in') {
      if (s.update) void vscode.window.showWarningMessage(`${pick.label} is signed in, but its adapter (${s.version}) is old. ${s.update}`);
      else void vscode.window.showInformationMessage(`${pick.label} is signed in.`);
    } else if (s.status === 'needs-sign-in') {
      const method = await vscode.window.showQuickPick(
        s.methods.map((m) => ({ label: m.name, description: m.description, id: m.id })),
        { title: `Sign in to ${pick.label}` },
      );
      if (method) await this.signIn(pick.agent, method.id);
    } else {
      void vscode.window.showWarningMessage(plainText(s.message ?? STATUS_TEXT[s.status]));
    }
  }

  async signIn(agent: AgentKey, methodId: string, after?: () => void): Promise<void> {
    const label = AGENT_FACES[agent].name;
    try {
      const method = (await this.core().authMethods(agent)).find((m) => m.id === methodId);
      if (!method) throw new Error('That sign-in method is no longer offered by the agent.');
      if (method.kind === 'key') {
        if (agent !== 'demo') await this.setApiKey(agent);
        return;
      }
      if (method.kind === 'terminal') {
        await this.terminalSignIn(agent, methodId, after);
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Signing in to ${label}. Finish in your browser…`, cancellable: true },
        (_progress, token) =>
          this.core().signInWithBrowser(agent, methodId, new Promise<void>((resolve) => token.onCancellationRequested(() => resolve()))),
      );
      void vscode.window.showInformationMessage(`Signed in to ${label}.`);
      this.status.delete(agent);
      this.changed.fire(undefined);
      after?.();
    } catch (err) {
      // The agent's own error text: in a notification it must not become a link.
      void vscode.window.showErrorMessage(`${label} sign-in: ${plainText(messageOf(err))}`);
    }
  }

  async setApiKey(agent?: VendorAgentId): Promise<void> {
    const id =
      agent ??
      (
        await vscode.window.showQuickPick(
          VENDOR_AGENTS.map((a) => ({ label: AGENT_FACES[a].name, description: KEY_ENV[a], agent: a })),
          { title: 'Set an API key' },
        )
      )?.agent;
    if (!id) return;
    const value = await vscode.window.showInputBox({
      title: `${AGENT_FACES[id].name} API key`,
      prompt: `Stored in the editor's secret storage and given only to ${AGENT_FACES[id].name} as ${KEY_ENV[id]}. Leave empty to remove it.`,
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    if (value.trim()) await this.secrets.store(secretName(id), value.trim());
    else await this.secrets.delete(secretName(id));
  }

  /** Runs the agent's own login (e.g. `claude-agent-acp --cli`) in a terminal the user can see. */
  private async terminalSignIn(agent: AgentKey, methodId: string, after?: () => void): Promise<void> {
    const login = await this.core().terminalLogin(agent, methodId);
    if (!login) throw new Error('That sign-in method is no longer offered by the agent.');
    const launch = launchFor(login.command, login.args);
    const label = AGENT_FACES[agent].name;
    const terminal = vscode.window.createTerminal({
      name: `${label} sign-in`,
      shellPath: launch.file,
      // A cmd.exe line that launchFor already quoted must reach Windows as is.
      shellArgs: launch.windowsVerbatimArguments ? launch.args.join(' ') : launch.args,
      // On Windows, npm's .cmd wrappers run `node` by bare name; don't let cmd.exe find one in the workspace.
      env: process.platform === 'win32' ? { ...login.env, NoDefaultCurrentDirectoryInExePath: '1' } : login.env,
      cwd: this.cwd(),
    });
    terminal.show();
    const done = vscode.window.onDidCloseTerminal(async (t) => {
      if (t !== terminal) return;
      done.dispose();
      // The CLI saved its credentials; a fresh agent process picks them up.
      await this.core().stopAgent(agent);
      this.status.delete(agent);
      this.changed.fire(undefined);
      if (t.exitStatus?.code === 0) {
        void vscode.window.showInformationMessage(`${label} login finished.`);
        after?.();
      } else {
        void vscode.window.showWarningMessage(`${label} login exited before finishing.`);
      }
    });
    this.disposables.push(done);
  }

  private async loadKey(agent: VendorAgentId): Promise<void> {
    const value = await this.secrets.get(secretName(agent));
    if (value) this.keys.set(agent, value);
    else this.keys.delete(agent);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function secretName(agent: VendorAgentId): string {
  return `friedliver.apiKey.${agent}`;
}
