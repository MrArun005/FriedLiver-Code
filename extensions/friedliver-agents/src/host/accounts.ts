import * as vscode from 'vscode';
import { launchFor } from '@friedliver/main/agents/processes';
import type { VendorAgentId } from '@friedliver/main/agents/registry';
import {
  CLI_ACCOUNTS,
  KEY_SETUPS,
  SIGN_IN_TEXT,
  acpMethodFor,
  isVendor,
  keySetup,
  noteAccount,
  offeredMethod,
  setupComplete,
  setupEnv,
  shownAgents,
  validKeyValue,
  type AccountRecord,
  type CliWhat,
  type KeySetup,
  type VendorKey,
} from '../shared/accounts';
import { AGENT_FACES, type AgentKey } from '../shared/model';
import { KEY_ENV, VENDOR_AGENTS, messageOf, type AgentCore } from './core';
import { plainText } from './notify';
import { cliLineFor, installCommandFor } from './signin';

type Node = { agent: AgentKey } | { agent: AgentKey; method: NonNullable<AccountRecord['methods']>[number] } | { other: true } | { page: true };

/** globalState: the last known sign-in per agent (shared/accounts.ts AccountRecord). Never a secret. */
const RECORDS_KEY = 'friedliver.accounts';

/** A saved credential setup: which one, and its values (secrets included; memory and SecretStorage only). */
interface Saved {
  setup: KeySetup['id'];
  values: Record<string, string>;
}

/**
 * Sign-in, the same flows as the app (docs/ACCOUNTS.md): the agent's own CLI
 * login in a terminal, ACP authenticate for browser logins, or an API key
 * (or Gemini's Vertex AI settings) kept in SecretStorage and given only to
 * that agent. Checking starts the agent, so it only happens when the user asks;
 * what was learned is kept, so the page and the pickers show it without one.
 */
export class Accounts implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly checking = new Set<AgentKey>();
  private readonly busy = new Map<AgentKey, string>();
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  /** Fires when a record, a key or what is going on changes: the page and the pickers draw again. */
  private readonly updated = new vscode.EventEmitter<AgentKey | undefined>();
  readonly onDidUpdate = this.updated.event;
  private readonly saved = new Map<VendorAgentId, Saved>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly memento: vscode.Memento,
    private readonly core: () => AgentCore,
    private readonly cwd: () => string | undefined,
    private readonly keyChanged: (agent: VendorAgentId) => void,
    private readonly showDemo: () => boolean,
  ) {
    this.disposables.push(
      this.changed,
      this.updated,
      secrets.onDidChange(async (e) => {
        const agent = VENDOR_AGENTS.find((a) => secretNames(a).includes(e.key));
        if (!agent) return;
        await this.loadKey(agent);
        this.keyChanged(agent);
        this.fire(agent);
      }),
    );
  }

  async loadKeys(): Promise<void> {
    await Promise.all(VENDOR_AGENTS.map((a) => this.loadKey(a)));
  }

  /** The agent's API key, when that is the setup saved for it. */
  apiKey(agent: VendorAgentId): string | undefined {
    const s = this.saved.get(agent);
    const env = KEY_ENV[agent];
    return s?.setup === 'apiKey' && env ? s.values[env] : undefined;
  }

  /** Any other saved setup (Gemini's Vertex AI), as the agent's environment. */
  credentialEnv(agent: VendorAgentId): Record<string, string> {
    const s = this.saved.get(agent);
    const setup = s && s.setup !== 'apiKey' ? keySetup(agent, s.setup) : undefined;
    return setup && s ? setupEnv(setup, s.values) : {};
  }

  /** Which setup is saved, and per field whether it is set (and a non-secret field's value). Never a secret. */
  savedSetup(agent: VendorKey): { setup: KeySetup['id']; set: Record<string, boolean>; plain: Record<string, string> } | undefined {
    const s = this.saved.get(agent);
    const setup = s && keySetup(agent, s.setup);
    if (!s || !setup) return undefined;
    const set: Record<string, boolean> = {};
    const plain: Record<string, string> = {};
    for (const f of setup.fields) {
      set[f.env] = !!s.values[f.env];
      if (!f.secret && s.values[f.env]) plain[f.env] = s.values[f.env];
    }
    return { setup: s.setup, set, plain };
  }

  record(agent: AgentKey): AccountRecord | undefined {
    return this.records()[agent];
  }

  records(): Partial<Record<AgentKey, AccountRecord>> {
    return this.memento.get<Partial<Record<AgentKey, AccountRecord>>>(RECORDS_KEY) ?? {};
  }

  isChecking(agent: AgentKey): boolean {
    return this.checking.has(agent);
  }

  busyText(agent: AgentKey): string | undefined {
    return this.busy.get(agent);
  }

  /**
   * Keeps what was just learned about an agent. A chat's session says
   * "signed in" each time; that changes nothing, so it writes nothing.
   */
  note(agent: AgentKey, patch: Partial<AccountRecord>): void {
    const all = this.records();
    const prev = all[agent];
    const next = noteAccount(prev, patch);
    const same = prev && JSON.stringify({ ...prev, at: 0 }) === JSON.stringify({ ...next, at: 0 });
    if (same && Date.now() - prev.at < 60 * 60_000) return;
    void this.memento.update(RECORDS_KEY, { ...all, [agent]: next });
    this.fire(agent);
  }

  // ---- The Accounts tree in the side bar ----

  getTreeItem(node: Node): vscode.TreeItem {
    if ('page' in node) {
      const item = new vscode.TreeItem('Agents & Accounts…');
      item.description = 'sign-in, keys, models';
      item.iconPath = new vscode.ThemeIcon('account');
      item.command = { command: 'friedliver.accounts', title: 'Agents & Accounts' };
      return item;
    }
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
    const s = this.record(node.agent);
    const item = new vscode.TreeItem(AGENT_FACES[node.agent].name);
    const key = isVendor(node.agent) && this.saved.has(node.agent) ? ' · key saved' : '';
    const version = s?.version ? ` · ${s.update ? `${s.version}, update it` : s.version}` : '';
    item.description = (this.checking.has(node.agent) ? 'Checking…' : s ? SIGN_IN_TEXT[s.status] : 'Not checked') + version + key;
    item.tooltip = (s?.update ?? s?.message) ? (s.update ?? s.message) : 'Click to check. Checking starts the agent.';
    item.contextValue = node.agent === 'demo' ? 'agent-demo' : 'agent-vendor';
    const methods = s?.status === 'needs-sign-in' ? (s.methods ?? []) : [];
    item.collapsibleState = methods.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
    item.command = { command: 'friedliver.accounts.check', title: 'Check sign-in', arguments: [node] };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) return [{ page: true as const }, ...shownAgents(this.showDemo()).map((agent) => ({ agent })), { other: true as const }];
    if ('other' in node || 'page' in node || 'method' in node) return [];
    const s = this.record(node.agent);
    return s?.status === 'needs-sign-in' ? (s.methods ?? []).map((method) => ({ agent: node.agent, method })) : [];
  }

  /** The tree draws again, e.g. after friedliver.showDemoAgent changed. */
  refresh(): void {
    this.fire(undefined);
  }

  // ---- Actions ----

  /** Starts the agent and a short session: sign-in, version, sign-in methods, and its models. */
  async check(agent: AgentKey): Promise<AccountRecord | undefined> {
    if (this.checking.has(agent)) return this.record(agent);
    this.checking.add(agent);
    this.fire(agent);
    try {
      const s = await vscode.window.withProgress(
        { location: { viewId: 'friedliver.accounts' }, title: `Checking ${AGENT_FACES[agent].name}` },
        () => this.core().checkAccount(agent),
      );
      this.note(agent, {
        status: s.status,
        methods: s.methods,
        ...(s.message ? { message: s.message } : {}),
        ...(s.version ? { version: s.version } : {}),
        ...(s.update ? { update: s.update } : {}),
        ...(s.logout !== undefined ? { logout: s.logout } : {}),
      });
    } finally {
      this.checking.delete(agent);
      this.fire(agent);
    }
    return this.record(agent);
  }

  /** One of the agent's own sign-in methods, by id: a browser login through ACP, or its CLI in a terminal. */
  async signIn(agent: AgentKey, methodId: string, after?: () => void): Promise<void> {
    const label = AGENT_FACES[agent].name;
    try {
      const method = (await this.core().authMethods(agent)).find((m) => m.id === methodId);
      if (!method) throw new Error('That sign-in method is no longer offered by the agent.');
      if (method.kind === 'key') {
        const setup = isVendor(agent) ? KEY_SETUPS[agent].find((s) => s.acpMethods.includes(method.id)) ?? KEY_SETUPS[agent][0] : undefined;
        if (setup && isVendor(agent)) await this.setKey(agent, setup.id);
        return;
      }
      if (method.kind === 'terminal') {
        await this.terminalSignIn(agent, methodId, method.name, after);
        return;
      }
      this.busy.set(agent, `Signing in with ${method.name}. Finish in your browser…`);
      this.fire(agent);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Signing in to ${label}. Finish in your browser…`, cancellable: true },
        (_progress, token) =>
          this.core().signInWithBrowser(agent, methodId, new Promise<void>((resolve) => token.onCancellationRequested(() => resolve()))),
      );
      void vscode.window.showInformationMessage(`Signed in to ${label}.`);
      this.note(agent, { status: 'signed-in', via: method.name });
      after?.();
    } catch (err) {
      // The agent's own error text: in a notification it must not become a link.
      void vscode.window.showErrorMessage(`${label} sign-in: ${plainText(messageOf(err))}`);
    } finally {
      if (this.busy.delete(agent)) this.fire(agent);
    }
  }

  /** The agent's own sign-out (ACP logout), after asking. FriedLiver deletes none of its files. */
  async signOut(agent: AgentKey): Promise<void> {
    const label = AGENT_FACES[agent].name;
    const ok = await vscode.window.showWarningMessage(
      `Sign out of ${label}?`,
      { modal: true, detail: `${label} signs itself out. Its chats need a sign-in before their next message.` },
      'Sign Out',
    );
    if (ok !== 'Sign Out') return;
    this.busy.set(agent, 'Signing out…');
    this.fire(agent);
    try {
      await this.core().signOut(agent);
      this.note(agent, { status: 'needs-sign-in', via: undefined, identity: undefined });
      void vscode.window.showInformationMessage(`Signed out of ${label}.`);
    } catch (err) {
      void vscode.window.showErrorMessage(`${label} sign-out: ${plainText(messageOf(err))}`);
    } finally {
      this.busy.delete(agent);
      this.fire(agent);
    }
  }

  /**
   * Asks for an API key (or Gemini's Vertex AI settings) in the editor's own
   * input boxes, so the page never sees it; keeps it in SecretStorage, and
   * replaces any other setup saved for the agent. Then, when the agent has an
   * ACP method for it (Gemini, Codex), tells the agent to use it and checks.
   */
  async setKey(agent?: VendorKey, setupId?: KeySetup['id']): Promise<void> {
    const id =
      agent ??
      (
        await vscode.window.showQuickPick(
          VENDOR_AGENTS.filter((a) => KEY_SETUPS[a].length).map((a) => ({ label: AGENT_FACES[a].name, description: KEY_SETUPS[a].map((s) => s.name).join(', '), agent: a })),
          { title: 'Set an API key' },
        )
      )?.agent;
    if (!id) return;
    const setups = KEY_SETUPS[id];
    const setup =
      keySetup(id, setupId) ??
      (setups.length === 1
        ? setups[0]
        : (await vscode.window.showQuickPick(setups.map((s) => ({ label: s.name, detail: s.description, setup: s })), { title: `${AGENT_FACES[id].name}: how to sign in` }))?.setup);
    if (!setup) return;
    const name = AGENT_FACES[id].name;
    const prev = this.saved.get(id);
    const values: Record<string, string> = {};
    for (const field of setup.fields) {
      const kept = prev?.setup === setup.id ? prev.values[field.env] : undefined;
      const value = await vscode.window.showInputBox({
        title: `${name}: ${setup.name} · ${field.label}`,
        prompt: field.secret
          ? `Stored in the editor's secret storage and given only to ${name} as ${field.env}.${kept ? ' Leave empty to keep the saved one.' : ''}`
          : `Given to ${name} as ${field.env}.`,
        value: field.secret ? undefined : kept,
        placeHolder: field.placeholder,
        password: field.secret,
        ignoreFocusOut: true,
        validateInput: (v) => validKeyValue(field, v),
      });
      if (value === undefined) return;
      const v = value.trim() || (field.secret ? kept : undefined);
      if (v) values[field.env] = v;
    }
    if (!setupComplete(setup, values)) {
      const need = (setup.requires ?? [setup.fields.map((f) => f.env)]).map((g) => g.join(' and ')).join(', or ');
      void vscode.window.showWarningMessage(`${name}: ${setup.name} needs ${need}. Nothing was saved.`);
      return;
    }
    await this.clearSecrets(id);
    await this.secrets.store(secretName(id, setup.id), setup.id === 'apiKey' ? values[setup.fields[0].env] : JSON.stringify(values));
    await this.loadKey(id);
    // A running agent still has the old environment.
    await this.core().stopAgent(id);
    this.note(id, { via: setup.name });
    const method = acpMethodFor(setup, this.record(id)?.methods ?? (await this.core().authMethods(id).catch(() => [])));
    if (method) {
      this.busy.set(id, `Telling ${name} to use the ${setup.name}…`);
      this.fire(id);
      try {
        await this.core().signInWithBrowser(id, method, new Promise<void>(() => {}));
      } catch (err) {
        void vscode.window.showErrorMessage(`${name}: ${plainText(messageOf(err))}`);
      } finally {
        this.busy.delete(id);
      }
    }
    await this.check(id);
  }

  /** Removes the key or settings FriedLiver keeps for the agent; the agent's own CLI login stays. */
  async clearKey(agent: VendorKey): Promise<void> {
    if (!this.saved.has(agent)) return;
    await this.clearSecrets(agent);
    await this.loadKey(agent);
    await this.core().stopAgent(agent);
    const r = this.record(agent);
    if (r?.identity?.kind === 'api_key' || KEY_SETUPS[agent].some((s) => s.name === r?.via)) this.note(agent, { via: undefined, identity: undefined, status: 'needs-sign-in' });
    void vscode.window.showInformationMessage(`Removed ${AGENT_FACES[agent].name}'s saved key. Check again to see how it signs in now.`);
  }

  /** The line FriedLiver would type for an agent: its install command or its own CLI's sign-in or sign-out. */
  cliLine(agent: VendorKey, what: CliWhat): string | null {
    return what === 'install' ? installCommandFor(agent) : (CLI_ACCOUNTS[agent][what] ? cliLineFor(CLI_ACCOUNTS[agent][what]!.command) : null);
  }

  /**
   * Runs one of FriedLiver's own lines for the agent in a terminal the user
   * sees: the install command, or its CLI's own sign-in or sign-out. Checked
   * again when the terminal closes, since the CLI may have changed the login.
   */
  runInTerminal(agent: VendorKey, what: CliWhat): void {
    const line = this.cliLine(agent, what);
    if (!line) return;
    const name = AGENT_FACES[agent].name;
    const terminal = vscode.window.createTerminal({
      name: what === 'install' ? `Install ${name}` : `${name} ${what === 'signIn' ? 'sign-in' : 'sign-out'}`,
      cwd: this.cwd(),
    });
    terminal.show();
    terminal.sendText(line, true);
    const then = what === 'install' ? undefined : CLI_ACCOUNTS[agent][what]?.then;
    if (then) void vscode.window.showInformationMessage(`${name}: ${then}`);
    const done = vscode.window.onDidCloseTerminal(async (t) => {
      if (t !== terminal) return;
      done.dispose();
      await this.core().stopAgent(agent);
      void this.check(agent);
    });
    this.disposables.push(done);
  }

  /** Runs the agent's own login (e.g. `claude-agent-acp --cli`) in a terminal the user can see. */
  private async terminalSignIn(agent: AgentKey, methodId: string, methodName: string, after?: () => void): Promise<void> {
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
    this.busy.set(agent, `Finish signing in in the “${label} sign-in” terminal.`);
    this.fire(agent);
    const done = vscode.window.onDidCloseTerminal(async (t) => {
      if (t !== terminal) return;
      done.dispose();
      this.busy.delete(agent);
      // The CLI saved its credentials; a fresh agent process picks them up.
      await this.core().stopAgent(agent);
      if (t.exitStatus?.code === 0) {
        this.note(agent, { via: methodName });
        void vscode.window.showInformationMessage(`${label} login finished.`);
        after?.();
      } else {
        void vscode.window.showWarningMessage(`${label} login exited before finishing.`);
      }
      void this.check(agent);
    });
    this.disposables.push(done);
  }

  /** Whether the method id is one the agent last offered (the page may only ask for those). */
  offers(agent: AgentKey, methodId: string): boolean {
    return !!offeredMethod(this.record(agent)?.methods, methodId);
  }

  private async clearSecrets(agent: VendorAgentId): Promise<void> {
    await Promise.all(secretNames(agent).map((n) => this.secrets.delete(n)));
  }

  private async loadKey(agent: VendorAgentId): Promise<void> {
    for (const setup of KEY_SETUPS[agent]) {
      const value = await this.secrets.get(secretName(agent, setup.id));
      if (!value) continue;
      const values = setup.id === 'apiKey' ? { [setup.fields[0].env]: value } : parseValues(value);
      if (values) {
        this.saved.set(agent, { setup: setup.id, values });
        return;
      }
    }
    this.saved.delete(agent);
  }

  private fire(agent: AgentKey | undefined): void {
    this.changed.fire(undefined);
    this.updated.fire(agent);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

/** The plain API key keeps the name it always had; other setups are JSON under their own name. */
function secretName(agent: VendorAgentId, setup: KeySetup['id'] = 'apiKey'): string {
  return setup === 'apiKey' ? `friedliver.apiKey.${agent}` : `friedliver.credentials.${agent}.${setup}`;
}

function secretNames(agent: VendorAgentId): string[] {
  return KEY_SETUPS[agent].map((s) => secretName(agent, s.id));
}

function parseValues(text: string): Record<string, string> | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return undefined;
  }
}
