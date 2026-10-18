// FriedLiver Remote in the editor: the command, the pairing panel, the status
// bar item, the desktop confirmations, and the server's life. Off unless the
// user's own settings turn it on (friedliver.remote.enabled, application scope).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { AgentCore } from '../host/core';
import { plainText } from '../host/notify';
import { userSetting } from '../host/settings';
import type { Action, AgentKey } from '../shared/model';
import { RemoteActions } from './actions';
import { Devices, Lockout, PAIRING_TTL_MS, Pairing, type Device } from './auth';
import { fingerprint, loadCert } from './cert';
import { detectTailscale, lanAddresses, tailscaleCert, type Tailscale } from './net';
import { phoneChat, phoneChats, phoneList } from './phoneView';
import { pairingHtml, type PanelState } from './panel';
import { RemoteServer, type Endpoint } from './server';

const CONFIRM_MS = 2 * 60_000;

export interface RemoteDeps {
  core: AgentCore;
  folders(): string[];
  agents(): AgentKey[];
  reviews: { accept(id: string): boolean; reject(id: string): boolean };
  hidden(chatId: string): boolean;
  log(line: string): void;
}

export class RemoteControl implements vscode.Disposable {
  private server?: RemoteServer;
  private starting?: Promise<RemoteServer | undefined>;
  private readonly devices: Devices;
  private readonly pairing: Pairing;
  private readonly lockout = new Lockout();
  private readonly actions: RemoteActions;
  private readonly status = vscode.window.createStatusBarItem('friedliver.remote', vscode.StatusBarAlignment.Right, 98);
  private panel?: vscode.WebviewPanel;
  private panelState: PanelState = { via: 'lan' };
  private tailscale?: Tailscale;
  private lanUrl?: string;
  private tailscaleUrl?: string;
  private fp = '';
  private trustedTailscale = false;
  private known = new Set<string>();
  private changedChats = new Set<string>();
  private changeTimer?: ReturnType<typeof setTimeout>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: RemoteDeps,
  ) {
    this.devices = new Devices(context.globalState);
    this.pairing = new Pairing(this.devices);
    this.actions = new RemoteActions({
      core: deps.core,
      folders: deps.folders,
      agents: deps.agents,
      reviews: deps.reviews,
      confirm: (ask) => this.confirm(ask),
      hidden: deps.hidden,
      error: (err) => deps.log(`Remote: ${err instanceof Error ? err.message : String(err)}`),
    });
    this.status.name = 'FriedLiver Remote';
    this.status.command = 'friedliver.remote.open';
    this.subs.push(
      this.status,
      vscode.commands.registerCommand('friedliver.remote.open', () => this.open()),
      vscode.commands.registerCommand('friedliver.remote.stop', () => this.stop()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('friedliver.remote.enabled') && !this.enabled()) void this.stop();
        else if (e.affectsConfiguration('friedliver.remote.tailscale') && this.server) void this.restart();
      }),
    );
  }

  private enabled(): boolean {
    return userSetting(vscode.workspace.getConfiguration('friedliver.remote').inspect<boolean>('enabled')).value === true;
  }

  private tailscaleAllowed(): boolean {
    return userSetting(vscode.workspace.getConfiguration('friedliver.remote').inspect<boolean>('tailscale')).value === true;
  }

  /** Something in the core changed: the phones hear which chats, a moment later. */
  onAction(action: Action): void {
    if (!this.server) return;
    if ('chatId' in action && typeof action.chatId === 'string') this.changedChats.add(action.chatId);
    else for (const c of this.deps.core.snapshot.chats) this.changedChats.add(c.id);
    this.changeTimer ??= setTimeout(() => {
      this.changeTimer = undefined;
      const chats = [...this.changedChats];
      this.changedChats.clear();
      this.server?.changed(chats);
    }, 150);
  }

  /** The user's OK on the Mac for a phone's request that keeps allowing: a notification, two minutes at most. */
  confirm(ask: { title: string; detail: string; button: string }): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), CONFIRM_MS);
      void vscode.window.showWarningMessage(`${plainText(ask.title)} ${plainText(ask.detail)}`, ask.button, 'Deny').then((picked) => {
        clearTimeout(timer);
        resolve(picked === ask.button);
      });
    });
  }

  // ---- Starting and stopping ----

  private async open(): Promise<void> {
    if (!this.enabled()) {
      const on = await vscode.window.showWarningMessage(
        'Turn on FriedLiver Remote?',
        {
          modal: true,
          detail:
            'Phones you pair can read your chats, send messages, and answer approvals for your agents, over this network (and Tailscale, if you allow it). Nothing is exposed to the internet. You can revoke a phone at any time.',
        },
        'Turn On',
      );
      if (on !== 'Turn On') return;
      await vscode.workspace.getConfiguration('friedliver.remote').update('enabled', true, vscode.ConfigurationTarget.Global);
    }
    const server = await this.ensureServer();
    if (!server) return;
    this.showPanel();
    if (!this.pairing.active()) this.newCode();
  }

  private ensureServer(): Promise<RemoteServer | undefined> {
    if (this.server) return Promise.resolve(this.server);
    this.starting ??= this.startServer()
      .catch((err: unknown) => {
        void vscode.window.showErrorMessage(`FriedLiver Remote couldn't start: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      })
      .finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async startServer(): Promise<RemoteServer | undefined> {
    const lan = lanAddresses();
    this.tailscale = this.tailscaleAllowed() ? await detectTailscale() : undefined;
    if (!lan.length && !this.tailscale) throw new Error('This Mac has no private network address. Join a Wi-Fi network, or allow Tailscale.');
    const own = await loadCert(this.context.secrets, [...lan, ...(this.tailscale ? [this.tailscale.ip] : [])]);
    this.fp = fingerprint(own.cert);
    const endpoints: Endpoint[] = lan.map((host) => ({ host, names: [host], ...own }));
    this.trustedTailscale = false;
    if (this.tailscale) {
      const real = await tailscaleCert(this.tailscale);
      this.trustedTailscale = !!real;
      const names = real && this.tailscale.dnsName ? [this.tailscale.dnsName, this.tailscale.ip] : [this.tailscale.ip, ...(this.tailscale.dnsName ? [this.tailscale.dnsName] : [])];
      endpoints.push({ host: this.tailscale.ip, names, ...(real ?? own), trusted: !!real });
    }
    const dir = this.context.extensionUri.fsPath;
    const server = await RemoteServer.start({
      endpoints,
      devices: this.devices,
      pairing: this.pairing,
      lockout: this.lockout,
      host: {
        list: () => phoneList(phoneChats(this.deps.core.snapshot, this.deps.hidden), this.deps.agents(), this.deps.folders()),
        chat: (id) => {
          const chat = phoneChats(this.deps.core.snapshot, this.deps.hidden).find((c) => c.id === id);
          return chat && phoneChat(this.deps.core.snapshot, chat, (rid) => {
            const r = this.deps.core.review(rid);
            return r && { before: r.before, proposed: r.proposed };
          });
        },
        act: (action, device) => this.actions.run(action, device.name),
      },
      assets: {
        js: readFileSync(path.join(dir, 'media', 'dist', 'remote.js'), 'utf8'),
        css: readFileSync(path.join(dir, 'media', 'remote.css'), 'utf8'),
        icon: readFileSync(path.join(dir, 'media', 'remote-icon.svg'), 'utf8'),
        manifest: JSON.stringify({
          name: 'FriedLiver Remote',
          short_name: 'FriedLiver',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          background_color: '#121314',
          theme_color: '#121314',
          icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
        }),
      },
      onPaired: (device) => {
        this.panelState = { ...this.panelState, code: undefined, expires: undefined, paired: device.name };
        this.refreshPanel();
      },
      onConnections: (devices) => this.connections(devices),
      log: (line) => this.deps.log(line),
    });
    this.server = server;
    const urls = server.urls();
    this.lanUrl = lan.length ? urls[0] : undefined;
    this.tailscaleUrl = this.tailscale ? urls.at(-1) : undefined;
    this.panelState.via = this.lanUrl ? 'lan' : 'tailscale';
    this.deps.log(`Remote: listening on ${urls.join(', ')}`);
    this.connections([]);
    return server;
  }

  private async restart(): Promise<void> {
    await this.server?.dispose();
    this.server = undefined;
    if (await this.ensureServer()) this.refreshPanel();
  }

  private async stop(): Promise<void> {
    this.pairing.cancel();
    clearTimeout(this.changeTimer);
    this.changeTimer = undefined;
    await this.server?.dispose();
    this.server = undefined;
    this.known.clear();
    this.status.hide();
    this.panel?.dispose();
  }

  private connections(devices: Device[]): void {
    for (const d of devices) {
      if (this.known.has(d.id)) continue;
      void vscode.window.showInformationMessage(`${plainText(d.name)} connected to FriedLiver Remote.`, 'Revoke').then((picked) => {
        if (picked === 'Revoke') this.revoke(d.id);
      });
    }
    this.known = new Set(devices.map((d) => d.id));
    const n = devices.length;
    this.status.text = `$(broadcast) Remote · ${n} device${n === 1 ? '' : 's'}`;
    this.status.tooltip = `FriedLiver Remote is on: ${[this.lanUrl, this.tailscaleUrl].filter(Boolean).join(', ')}. Click to pair a phone or revoke one.`;
    this.status.show();
    this.refreshPanel();
  }

  private revoke(id: string): void {
    if (this.server) this.server.revoke(id);
    else this.devices.revoke(id);
    this.refreshPanel();
  }

  private newCode(): void {
    const { code, expires } = this.pairing.start();
    this.panelState = { ...this.panelState, code, expires, paired: undefined };
    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => this.refreshPanel(), PAIRING_TTL_MS + 50);
    this.refreshPanel();
  }

  // ---- The pairing panel ----

  private showPanel(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('friedliver.remote', 'FriedLiver Remote', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'agents.svg');
    this.panel = panel;
    panel.onDidDispose(() => {
      this.panel = undefined;
      // A code nobody can see any more stops working.
      this.pairing.cancel();
      this.panelState = { via: this.panelState.via };
    });
    panel.webview.onDidReceiveMessage((m: unknown) => this.panelMessage(m));
    this.refreshPanel();
  }

  private panelMessage(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const m = raw as { type?: unknown; id?: unknown; via?: unknown };
    switch (m.type) {
      case 'newCode':
        this.newCode();
        return;
      case 'revoke':
        if (typeof m.id === 'string' && /^[0-9a-f]{16}$/.test(m.id)) this.revoke(m.id);
        return;
      case 'revokeAll':
        void vscode.window.showWarningMessage('Revoke every paired phone?', { modal: true }, 'Revoke all').then((picked) => {
          if (picked !== 'Revoke all') return;
          if (this.server) this.server.revokeAll();
          else this.devices.revokeAll();
          this.refreshPanel();
        });
        return;
      case 'via':
        if ((m.via === 'lan' && this.lanUrl) || (m.via === 'tailscale' && this.tailscaleUrl)) {
          this.panelState.via = m.via;
          this.newCode();
        }
        return;
      case 'tailscale':
        void vscode.workspace.getConfiguration('friedliver.remote').update('tailscale', !this.tailscaleAllowed(), vscode.ConfigurationTarget.Global);
        return;
      case 'stop':
        void this.stop();
        return;
    }
  }

  private refreshPanel(): void {
    if (!this.panel) return;
    this.panel.webview.html = pairingHtml({
      nonce: randomBytes(16).toString('base64'),
      state: this.panelState,
      active: this.pairing.active(),
      url: this.panelState.via === 'tailscale' ? this.tailscaleUrl : this.lanUrl,
      pinned: !(this.panelState.via === 'tailscale' && this.trustedTailscale),
      fingerprint: this.fp,
      lanUrl: this.lanUrl,
      tailscaleUrl: this.tailscaleUrl,
      tailscaleAllowed: this.tailscaleAllowed(),
      tailscaleFound: !!this.tailscale,
      devices: this.devices.list(),
      connected: new Set(this.server?.connected().map((d) => d.id) ?? []),
    });
  }

  dispose(): void {
    clearTimeout(this.expiryTimer);
    void this.stop();
    for (const s of this.subs) s.dispose();
  }
}
