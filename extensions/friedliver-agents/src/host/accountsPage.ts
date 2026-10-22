import * as vscode from 'vscode';
import {
  CLI_ACCOUNTS,
  KEY_SETUPS,
  activeMethod,
  isVendor,
  modelChoices,
  parseAccountsMessage,
  shownAgents,
  unavailableOn,
  signInMethodsFor,
  type AccountCard,
  type AccountsMessage,
  type AccountsView,
  type KeyView,
  type VendorKey,
} from '../shared/accounts';
import { draftToEntry, entryToDraft, splitArgs, validateDraft, type AgentDraft, type AgentTestResult, type DraftErrors } from '../shared/agentForm';
import { agentFace, customAgent, customAgents, type AgentKey } from '../shared/model';
import { testAgentConnection, withEntry, withoutEntry, type CustomAgentConfig, type CustomSecrets } from './customAgents';
import { SYSTEM_WORDS, unsupportedOn, type SystemSettingsView, type SystemTool } from '../shared/system';
import type { Accounts } from './accounts';
import { messageOf, type AgentCore } from './core';
import { plainText } from './notify';
import { installCommandFor } from './signin';
import { systemPlatform, systemSettings } from './system';
import { webviewHtml, webviewOptions } from './webviews';

export const ACCOUNTS_PANEL = 'friedliver.accountsPanel';

type HostToPage =
  | { type: 'accounts'; view: AccountsView }
  | { type: 'agentSaved'; ok: true; id: string }
  | { type: 'agentSaved'; ok: false; errors: DraftErrors }
  | { type: 'agentTest'; result: AgentTestResult };

/** What the page needs for custom agents: the host's list (with commands), their secrets, and the client's version. */
export interface CustomAgentsHost {
  configs(): CustomAgentConfig[];
  secrets: CustomSecrets;
  clientVersion: string;
}

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
  private form = 0;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly accounts: Accounts,
    private readonly core: () => AgentCore,
    private readonly showDemo: () => boolean,
    private readonly log: (line: string) => void,
    private readonly custom?: CustomAgentsHost,
  ) {
    this.disposables.push(
      accounts.onDidUpdate(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('friedliver.links.openIn') && this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('friedliver.system') && this.refresh()),
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

  /** Opens the page on the "Add an agent" form (FriedLiver: Add Agent…, "Add an agent…" in the pickers). */
  showForm(): void {
    this.form++;
    this.show();
    this.refresh();
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
    const defaults = this.core().agentDefaults();
    // Every agent, the ones this platform can't run too: their card says so instead of vanishing.
    const cards = shownAgents(this.showDemo(), 'darwin').map((agent): AccountCard => {
      if (unavailableOn(agent, process.platform)) return { agent, name: agentFace(agent).name, signIn: [], keys: [], chosen: {}, unavailable: 'macOS only for now' };
      const record = this.accounts.record(agent);
      const keys = isVendor(agent) ? this.keyViews(agent) : [];
      const envKey = isVendor(agent) && !keys.some((k) => k.active) ? KEY_SETUPS[agent].flatMap((s) => s.fields).find((f) => f.secret && process.env[f.env])?.env : undefined;
      const card: AccountCard = {
        agent,
        name: agentFace(agent).name,
        ...(record ? { record } : {}),
        ...(this.accounts.isChecking(agent) ? { checking: true } : {}),
        ...(this.accounts.busyText(agent) ? { busy: this.accounts.busyText(agent) } : {}),
        ...(installCommandFor(agent) ? { installCommand: installCommandFor(agent)! } : {}),
        signIn: signInMethodsFor(record?.methods),
        keys,
        ...(envKey ? { envKey } : {}),
        ...(isVendor(agent) ? { cli: CLI_ACCOUNTS[agent] } : {}),
        ...(customAgent(agent)?.signIn ? { hint: customAgent(agent)!.signIn } : {}),
        ...this.customDraft(agent),
        ...modelChoices(defaults[agent]),
      };
      const active = activeMethod(card);
      return active ? { ...card, active } : card;
    });
    const links = vscode.workspace.getConfiguration('friedliver.links').get('openIn') === 'external' ? 'external' : 'builtin';
    const custom = customAgents();
    return { cards, links, system: this.systemView(), ...(this.focus ? { focus: this.focus } : {}), ...(custom.length ? { custom: [...custom] } : {}), ...(this.form ? { form: this.form } : {}) };
  }

  /** A custom agent's settings for the form's Edit; its secret variables by name only. */
  private customDraft(agent: AgentKey): { custom?: AgentDraft } {
    const c = this.custom?.configs().find((x) => x.key === agent);
    return c ? { custom: entryToDraft(c, this.custom!.secrets.names(c.id)) } : {};
  }

  private systemView(): SystemSettingsView {
    const platform = systemPlatform() ?? 'other';
    const settings = systemSettings((key) => vscode.workspace.getConfiguration('friedliver.system').inspect<unknown>(key));
    const off = new Set(unsupportedOn(platform));
    const tools = Object.fromEntries(Object.entries(settings.tools).map(([t, on]) => [t, on && !off.has(t as SystemTool)])) as Record<SystemTool, boolean>;
    return { supported: platform !== 'other', platform, enabled: settings.enabled, fullAutoAllowed: settings.fullAutoAllowed, tools };
  }

  /** Writes the user's own settings (never the workspace's); letting Full auto cover these asks first. */
  private async setSystem(key: 'enabled' | 'fullAutoAllowed' | SystemTool, value: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('friedliver.system');
    if (key === 'fullAutoAllowed' && value) {
      const ok = await vscode.window.showWarningMessage(
        'Let Full auto chats act on your computer without asking?',
        {
          modal: true,
          detail:
            'Agents in chats on Full auto will open apps, files and links, bring apps to the front, copy to the clipboard, show notifications, change the volume and run Shortcuts without asking. Reading the clipboard, window screenshots and terminal-like apps still ask every time. Every action is logged in "FriedLiver: System Actions".',
        },
        'Allow on Full auto',
      );
      if (ok !== 'Allow on Full auto') return this.refresh();
    }
    if (key === 'enabled' || key === 'fullAutoAllowed') {
      await config.update(key, value, vscode.ConfigurationTarget.Global);
      return;
    }
    const tools = { ...(userSettingObject(config.inspect<unknown>('tools')?.globalValue)), [key]: value };
    await config.update('tools', tools, vscode.ConfigurationTarget.Global);
    this.log(`Mac & Windows control: ${SYSTEM_WORDS[key]} turned ${value ? 'on' : 'off'}.`);
  }

  private keyViews(agent: VendorKey): KeyView[] {
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
      case 'setSystem':
        await this.setSystem(m.key, m.value);
        return;
      case 'systemLog':
        await vscode.commands.executeCommand('friedliver.system.showLog');
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
        const name = agentFace(m.agent).name;
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
      case 'saveAgent':
        await this.saveAgent(m.draft, m.editing);
        return;
      case 'removeAgent':
        await this.removeAgent(m.agent);
        return;
      case 'testAgent':
        this.post({ type: 'agentTest', result: await this.testAgent(m.draft, m.editing) });
        return;
      case 'setDefault':
        if (!this.core().setDefaultChoice(m.agent, m.key, m.value)) this.log(`Agents & Accounts: ${m.agent} didn't offer ${m.key} ${m.value}.`);
        this.refresh();
        return;
    }
  }

  /**
   * Writes the agent into the user's friedliver.agents.custom (never a workspace's): secrets first, so the
   * agent never starts without them. An agent keeps its id: chats find it by that.
   */
  private async saveAgent(draft: AgentDraft, editing?: string): Promise<void> {
    if (!this.custom) return;
    if (editing && editing !== draft.id) return this.post({ type: 'agentSaved', ok: false, errors: { id: 'An agent keeps its id. Remove it and add a new one to change it.' } });
    const taken = this.custom.configs().map((c) => c.id).filter((id) => id !== editing);
    const errors = validateDraft(draft, taken);
    if (Object.keys(errors).length) return this.post({ type: 'agentSaved', ok: false, errors });
    const { entry, secrets, keep } = draftToEntry(draft);
    const old = editing ? this.custom.secrets.env(editing) : {};
    await this.custom.secrets.set(draft.id, { ...Object.fromEntries(keep.filter((k) => k in old).map((k) => [k, old[k]])), ...secrets });
    const config = vscode.workspace.getConfiguration('friedliver.agents');
    await config.update('custom', withEntry(config.inspect<unknown>('custom')?.globalValue, entry, editing), vscode.ConfigurationTarget.Global);
    this.log(`Agents & Accounts: ${editing ? 'updated' : 'added'} the agent "${draft.id}" in your user settings.`);
    this.post({ type: 'agentSaved', ok: true, id: draft.id });
  }

  private async removeAgent(agent: AgentKey): Promise<void> {
    const c = this.custom?.configs().find((x) => x.key === agent);
    if (!c || !this.custom) return;
    const ok = await vscode.window.showWarningMessage(
      `Remove ${c.name}?`,
      { modal: true, detail: `It goes from your friedliver.agents.custom setting, with any variables FriedLiver keeps for it. Its chats stay; they can't start until you add it again.` },
      'Remove',
    );
    if (ok !== 'Remove') return;
    const config = vscode.workspace.getConfiguration('friedliver.agents');
    await config.update('custom', withoutEntry(config.inspect<unknown>('custom')?.globalValue, c.id), vscode.ConfigurationTarget.Global);
    await this.custom.secrets.remove(c.id);
  }

  /** Test connection: the draft as it would run (with the secrets it keeps), in an empty folder. */
  private async testAgent(draft: AgentDraft, editing?: string): Promise<AgentTestResult> {
    if (!this.custom) return { ok: false, error: 'Not available here.' };
    const { command, args, env } = validateDraft({ ...draft, id: draft.id || 'test' }, []);
    const problem = command ?? args ?? env;
    if (problem) return { ok: false, error: problem };
    const { entry, secrets, keep } = draftToEntry(draft);
    const old = editing ? this.custom.secrets.env(editing) : {};
    const kept = Object.fromEntries(keep.filter((k) => k in old).map((k) => [k, old[k]]));
    const label = draft.name.trim() || draft.command.trim();
    return testAgentConnection(
      { id: `custom:${draft.id || 'test'}`, label, command: draft.command.trim(), args: splitArgs(draft.args) ?? [], env: { ...(entry.env as Record<string, string> | undefined), ...kept, ...secrets }, installCommand: draft.install.trim(), loginHint: '' },
      this.custom.clientVersion,
    );
  }

  private post(message: HostToPage): void {
    void this.panel?.webview.postMessage(message).then(undefined, () => {});
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** A stored object setting, or {} for anything else. */
function userSettingObject(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
