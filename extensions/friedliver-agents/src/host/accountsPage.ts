import * as vscode from 'vscode';
import {
  CLI_ACCOUNTS,
  KEY_SETUPS,
  activeMethod,
  isVendor,
  modelChoices,
  parseAccountsMessage,
  shownAgents,
  signInMethodsFor,
  type AccountCard,
  type AccountsMessage,
  type AccountsView,
  type KeyView,
} from '../shared/accounts';
import { AGENT_FACES, type AgentKey } from '../shared/model';
import type { Accounts } from './accounts';
import { messageOf, type AgentCore } from './core';
import { plainText } from './notify';
import { installCommandFor } from './signin';
import { webviewHtml, webviewOptions } from './webviews';

export const ACCOUNTS_PANEL = 'friedliver.accountsPanel';

type HostToPage = { type: 'accounts'; view: AccountsView };

/**
 * Agents & Accounts: one card per agent with its sign-in, its keys, its CLI's
 * own login and the model and effort its new chats start with. Shows what is
 * already known (accounts.ts); only the user's Check, Refresh, sign-in or
 * sign-out starts an agent. Messages from the page are checked
 * (parseAccountsMessage) and never carry a secret either way.
 */
export class AccountsPage implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private focus?: { agent: AgentKey; n: number };
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly accounts: Accounts,
    private readonly core: () => AgentCore,
    private readonly showDemo: () => boolean,
    private readonly log: (line: string) => void,
  ) {
    this.disposables.push(
      accounts.onDidUpdate(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('friedliver.links.openIn') && this.refresh()),
    );
  }

  /** Opens the page, or brings it forward, on the agent's card when given. */
  show(agent?: AgentKey): void {
    this.focus = agent ? { agent, n: (this.focus?.n ?? 0) + 1 } : this.focus;
    if (this.panel) {
      this.panel.reveal();
      this.refresh();
      return;
    }
    this.adopt(vscode.window.createWebviewPanel(ACCOUNTS_PANEL, 'Agents & Accounts', vscode.ViewColumn.Active, { retainContextWhenHidden: false }));
  }

  /** A panel the editor restored after a reload, or one just made. */
  adopt(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    this.ready = false;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'agents.svg');
    panel.webview.options = webviewOptions(this.extensionUri);
    panel.webview.html = webviewHtml(panel.webview, this.extensionUri, 'accounts', 'Agents & Accounts');
    const sub = panel.webview.onDidReceiveMessage((raw: unknown) => {
      const m = parseAccountsMessage(raw, shownAgents(this.showDemo()));
      if (!m) {
        this.log('Ignored a malformed message from the Agents & Accounts page.');
        return;
      }
      void this.handle(m).catch((err: unknown) => void vscode.window.showErrorMessage(plainText(messageOf(err))));
    });
    panel.onDidDispose(() => {
      sub.dispose();
      if (this.panel === panel) this.panel = undefined;
    });
  }

  /** Draws the page again: a record, a key, a default or a setting changed. */
  refresh(): void {
    if (this.panel && this.ready) this.post({ type: 'accounts', view: this.view() });
  }

  view(): AccountsView {
    const showDemo = this.showDemo();
    const defaults = this.core().agentDefaults();
    const cards = shownAgents(showDemo).map((agent): AccountCard => {
      const record = this.accounts.record(agent);
      const keys = isVendor(agent) ? this.keyViews(agent) : [];
      const envKey = isVendor(agent) && !keys.some((k) => k.active) ? KEY_SETUPS[agent].flatMap((s) => s.fields).find((f) => f.secret && process.env[f.env])?.env : undefined;
      const card: AccountCard = {
        agent,
        name: AGENT_FACES[agent].name,
        ...(record ? { record } : {}),
        ...(this.accounts.isChecking(agent) ? { checking: true } : {}),
        ...(this.accounts.busyText(agent) ? { busy: this.accounts.busyText(agent) } : {}),
        ...(installCommandFor(agent) ? { installCommand: installCommandFor(agent)! } : {}),
        signIn: signInMethodsFor(record?.methods),
        keys,
        ...(envKey ? { envKey } : {}),
        ...(isVendor(agent) ? { cli: CLI_ACCOUNTS[agent] } : {}),
        ...modelChoices(defaults[agent]),
      };
      const active = activeMethod(card);
      return active ? { ...card, active } : card;
    });
    const links = vscode.workspace.getConfiguration('friedliver.links').get('openIn') === 'external' ? 'external' : 'builtin';
    return { cards, showDemo, links, ...(this.focus ? { focus: this.focus } : {}) };
  }

  private keyViews(agent: Exclude<AgentKey, 'demo'>): KeyView[] {
    const saved = this.accounts.savedSetup(agent);
    return KEY_SETUPS[agent].map((setup) => {
      const mine = saved?.setup === setup.id ? saved : undefined;
      return {
        id: setup.id,
        name: setup.name,
        description: setup.description,
        fields: setup.fields.map((f) => ({
          env: f.env,
          label: f.label,
          secret: f.secret,
          set: !!mine?.set[f.env],
          ...(mine?.plain[f.env] ? { value: mine.plain[f.env] } : {}),
        })),
        active: !!mine,
      };
    });
  }

  private async handle(m: AccountsMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.refresh();
        return;
      case 'setLinks':
        await vscode.workspace.getConfiguration('friedliver.links').update('openIn', m.mode, vscode.ConfigurationTarget.Global);
        return;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'friedliver.showDemoAgent');
        return;
      case 'check':
        await this.accounts.check(m.agent);
        return;
      case 'signIn':
        // Only a method the agent itself offered when it was last checked.
        if (!this.accounts.offers(m.agent, m.methodId)) {
          this.log(`Agents & Accounts: ${m.agent} didn't offer the sign-in method ${m.methodId}.`);
          return;
        }
        await this.accounts.signIn(m.agent, m.methodId);
        return;
      case 'setKey':
        await this.accounts.setKey(m.agent, m.setup);
        return;
      case 'clearKey': {
        const name = AGENT_FACES[m.agent].name;
        const ok = await vscode.window.showWarningMessage(`Remove the key FriedLiver keeps for ${name}?`, { modal: true, detail: `${name}'s own CLI login, if any, stays.` }, 'Remove');
        if (ok === 'Remove') await this.accounts.clearKey(m.agent);
        return;
      }
      case 'signOut':
        if (this.accounts.record(m.agent)?.logout) await this.accounts.signOut(m.agent);
        return;
      case 'terminal':
        this.accounts.runInTerminal(m.agent, m.what);
        return;
      case 'copy': {
        const line = this.accounts.cliLine(m.agent, m.what);
        if (line) await vscode.env.clipboard.writeText(line);
        return;
      }
      case 'setDefault':
        if (!this.core().setDefaultChoice(m.agent, m.key, m.value)) this.log(`Agents & Accounts: ${m.agent} didn't offer ${m.key} ${m.value}.`);
        this.refresh();
        return;
    }
  }

  private post(message: HostToPage): void {
    void this.panel?.webview.postMessage(message).then(undefined, () => {});
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
