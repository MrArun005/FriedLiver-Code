// FriedLiver's browser: the editor's own integrated browser (VS Code 1.142's
// Electron WebContentsView, opened as an editor tab through the `browser` API
// proposal), on the right of the window, driven for agents over its CDP
// session. A real browser surface, not an iframe, so pages that send
// X-Frame-Options or CSP frame-ancestors still load. Its cookies live in the
// integrated browser's own persistent session (workbench.browser.dataStorage),
// never the user's system browser. It opens only when the user asks
// (FriedLiver: Open Browser) or allows an agent's browser_open.
import { mkdir } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { BrowserCall } from '../bridge/protocol';
import { userSetting } from './settings';
import { clampBrowserWidth, ownTab, saveScreenshot, relaxLocalhostCors, type PausedResponse } from './browserRules';

const WIDTH_KEY = 'friedliver.browser.width';
const URL_KEY = 'friedliver.browser.lastUrl';
const LOAD_TIMEOUT_MS = 15_000;
const CDP_TIMEOUT_MS = 30_000;
const CONSOLE_LINES = 100;
const LOCAL_PATTERNS = ['http://localhost*', 'https://localhost*', 'http://127.0.0.1*', 'https://127.0.0.1*', 'http://[::1]*', 'https://[::1]*'];

type CdpMessage = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string }; sessionId?: string };

/** One CDP session on one browser tab, attached to its page target. */
class Cdp {
  private n = 0;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private sessionId?: string;
  private loads: (() => void)[] = [];
  readonly console: string[] = [];
  closed = false;

  private constructor(
    private readonly session: vscode.BrowserCDPSession,
    private readonly corsRelaxed: () => boolean,
  ) {
    session.onDidReceiveMessage((m) => this.receive(m as CdpMessage));
    session.onDidClose(() => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('The browser page closed.'));
      this.pending.clear();
    });
  }

  static async attach(tab: vscode.BrowserTab, corsRelaxed: () => boolean): Promise<Cdp> {
    const cdp = new Cdp(await tab.startCDPSession(), corsRelaxed);
    const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: { targetId: string; type: string }[] };
    const page = targetInfos.find((t) => t.type === 'page') ?? targetInfos[0];
    if (!page) throw new Error('The browser tab has no page to drive.');
    const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })) as { sessionId: string };
    cdp.sessionId = sessionId;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.cors();
    return cdp;
  }

  /** Turns the localhost CORS relaxation on or off to match the setting. */
  async cors(): Promise<void> {
    if (this.corsRelaxed()) await this.send('Fetch.enable', { patterns: LOCAL_PATTERNS.map((urlPattern) => ({ urlPattern, requestStage: 'Response' })) });
    else await this.send('Fetch.disable').catch(() => {});
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('The browser page closed.'));
    const id = ++this.n;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser did not answer ${method} in time.`));
      }, CDP_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.session.sendMessage({ id, method, params, ...(this.sessionId ? { sessionId: this.sessionId } : {}) }).then(undefined, (err: unknown) => {
        this.pending.get(id)?.reject(err instanceof Error ? err : new Error(String(err)));
        this.pending.delete(id);
      });
    });
  }

  /** Resolves on the page's next load event, or after the timeout (a slow page is still usable). */
  nextLoad(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.loads = this.loads.filter((l) => l !== done);
        resolve();
      };
      const timer = setTimeout(done, LOAD_TIMEOUT_MS);
      this.loads.push(done);
    });
  }

  /** The value of a page expression; a page exception becomes the error. */
  async evaluate<T>(expression: string): Promise<T> {
    const r = (await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as {
      result?: { value?: T };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text ?? 'The page threw an error.');
    return r.result?.value as T;
  }

  private receive(m: CdpMessage): void {
    if (typeof m.id === 'number') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message ?? 'CDP error'));
      else p.resolve(m.result);
      return;
    }
    const params = m.params ?? {};
    switch (m.method) {
      case 'Page.loadEventFired':
        for (const l of [...this.loads]) l();
        return;
      case 'Runtime.consoleAPICalled': {
        const args = (params.args as { value?: unknown; description?: string }[] | undefined) ?? [];
        this.log(`[${String(params.type)}] ${args.map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ''))).join(' ')}`);
        return;
      }
      case 'Runtime.exceptionThrown': {
        const d = params.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined;
        this.log(`[uncaught] ${d?.exception?.description ?? d?.text ?? ''}`);
        return;
      }
      case 'Fetch.requestPaused':
        void this.paused(params as unknown as PausedResponse & { requestId: string });
        return;
    }
  }

  private async paused(p: PausedResponse & { requestId: string }): Promise<void> {
    const relaxed = this.corsRelaxed() ? relaxLocalhostCors(p) : null;
    try {
      if (!relaxed) await this.send('Fetch.continueRequest', { requestId: p.requestId });
      else if (relaxed.fulfill) await this.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 204, responseHeaders: relaxed.headers });
      else await this.send('Fetch.continueResponse', { requestId: p.requestId, responseHeaders: relaxed.headers });
    } catch {
      // The request went away (navigation, closed tab).
    }
  }

  private log(line: string): void {
    this.console.push(line.slice(0, 2000));
    if (this.console.length > CONSOLE_LINES) this.console.splice(0, this.console.length - CONSOLE_LINES);
  }
}

/** The page as text: title, URL, the elements an agent can act on (each with a selector), then the visible text. */
const SNAPSHOT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const name = (el) => (el.getAttribute('aria-label') || (el.type === 'password' ? '' : el.value) || el.innerText || el.placeholder || el.title || el.alt || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
  window.__flN = window.__flN || 0;
  const lines = [];
  for (const el of document.querySelectorAll('a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[contenteditable=true]')) {
    if (el.type === 'hidden' || !vis(el)) continue;
    if (!el.dataset.fl) el.dataset.fl = String(++window.__flN);
    const sel = el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1 ? '#' + CSS.escape(el.id) : '[data-fl="' + el.dataset.fl + '"]';
    const kind = el.getAttribute('role') || (el.tagName.toLowerCase() + (el.type && el.tagName !== 'BUTTON' ? '[' + el.type + ']' : ''));
    lines.push(sel + '  ' + kind + ' "' + name(el) + '"' + (el.href ? ' -> ' + el.href : ''));
    if (lines.length >= 300) { lines.push('…more elements not listed'); break; }
  }
  const text = document.body ? document.body.innerText.replace(/\\n{3,}/g, '\\n\\n').slice(0, 20000) : '';
  return 'Title: ' + document.title + '\\nURL: ' + location.href + '\\n\\nElements:\\n' + lines.join('\\n') + '\\n\\nText:\\n' + text;
})()`;

/** Finds the element to act on, scrolls it into view, and returns its center and a description. */
function locate(selector: string | undefined, text: string | undefined, focus: boolean): string {
  return `((selector, text, focus) => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().replace(/\\s+/g, ' ');
  let el;
  if (selector) el = document.querySelector(selector);
  else {
    const want = text.trim().replace(/\\s+/g, ' ').toLowerCase();
    const all = [...document.querySelectorAll('a,button,input[type=submit],input[type=button],input[type=checkbox],input[type=radio],label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[onclick]')].filter(vis);
    el = all.find((e) => label(e).toLowerCase() === want) || all.find((e) => label(e).toLowerCase().includes(want));
  }
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  if (focus) {
    el.focus();
    if (typeof el.select === 'function') el.select();
    else if (el.isContentEditable) document.execCommand('selectAll');
  }
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, what: el.tagName.toLowerCase() + ' "' + label(el).slice(0, 60) + '"' };
})(${JSON.stringify(selector ?? null)}, ${JSON.stringify(text ?? null)}, ${focus})`;
}

export class BrowserPanel implements vscode.Disposable {
  private tab?: vscode.BrowserTab;
  private cdp?: Promise<Cdp>;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (line: string) => void,
  ) {
    if (!this.supported()) return;
    this.subscriptions.push(
      vscode.window.onDidCloseBrowserTab((t) => {
        if (t !== this.tab) return;
        this.tab = undefined;
        this.cdp = undefined;
      }),
      vscode.window.onDidChangeBrowserTabState((t) => {
        if (t === this.tab && /^https?:/.test(t.url)) void this.context.globalState.update(URL_KEY, t.url);
      }),
      // The user dragged the sash or rearranged the groups: remember the width, back within its bounds.
      vscode.window.tabGroups.onDidChangeTabGroups(() => void this.rememberWidth()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('friedliver.browser.relaxLocalhostCors')) void this.cdp?.then((c) => c.cors()).catch(() => {});
      }),
    );
  }

  /** Whether this editor has the integrated browser and lets FriedLiver use it. */
  supported(): boolean {
    try {
      return typeof vscode.window.openBrowserTab === 'function' && Array.isArray(vscode.window.browserTabs);
    } catch {
      return false;
    }
  }

  /** The user's "Open Browser": shows the browser on the right, at the last page, or opens it there. */
  async show(): Promise<void> {
    if (!this.supported()) {
      void vscode.window.showWarningMessage("FriedLiver's browser needs the FriedLiver app (VS Code 1.142 or newer with the integrated browser).");
      return;
    }
    if (this.live()) {
      await vscode.window.openBrowserTab(this.tab!.url, { viewColumn: vscode.ViewColumn.Two }).then(undefined, () => {});
      return;
    }
    await this.openTab(this.context.globalState.get<string>(URL_KEY) ?? 'about:blank', false);
  }

  /** One agent tool call (bridgeRequests.ts already checked the URL and got the user's OK). */
  async call(call: BrowserCall, signal: AbortSignal): Promise<string> {
    if (!this.supported()) throw new Error("FriedLiver's built-in browser isn't available in this editor.");
    if (signal.aborted) throw new Error('Cancelled.');
    switch (call.tool) {
      case 'browser_open': {
        if (!this.live()) await this.openTab(call.url, true);
        const cdp = await this.page();
        const loaded = cdp.nextLoad();
        const r = (await cdp.send('Page.navigate', { url: call.url })) as { errorText?: string };
        if (r.errorText) throw new Error(`Could not open ${call.url}: ${r.errorText}`);
        await loaded;
        return this.where(cdp, 'Opened');
      }
      case 'browser_snapshot':
        return (await this.page()).evaluate<string>(SNAPSHOT);
      case 'browser_click': {
        const cdp = await this.page();
        const at = await this.find(cdp, call.selector, call.text, false);
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
          await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
        }
        await settle();
        return this.where(cdp, `Clicked ${at.what}.`);
      }
      case 'browser_type': {
        const cdp = await this.page();
        const at = await this.find(cdp, call.selector, undefined, true);
        if (call.text) await cdp.send('Input.insertText', { text: call.text });
        else await cdp.evaluate('document.execCommand("delete")');
        return `Typed into ${at.what}.`;
      }
      case 'browser_screenshot': {
        const cdp = await this.page();
        const { data } = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
        const base = this.context.globalStorageUri.fsPath;
        await mkdir(base, { recursive: true, mode: 0o700 });
        const file = await saveScreenshot(base, Buffer.from(data, 'base64'));
        return `${await this.where(cdp, 'Screenshot of')}\nSaved to ${file}. Read that file to see it.`;
      }
      case 'browser_console': {
        const lines = (await this.page()).console;
        return lines.length ? lines.join('\n') : 'No console messages since FriedLiver attached to the page.';
      }
      case 'browser_back': {
        const cdp = await this.page();
        const h = (await cdp.send('Page.getNavigationHistory')) as { currentIndex: number; entries: { id: number }[] };
        if (h.currentIndex <= 0) return 'There is no earlier page to go back to.';
        const loaded = cdp.nextLoad();
        await cdp.send('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex - 1].id });
        await loaded;
        return this.where(cdp, 'Went back to');
      }
      case 'browser_reload': {
        const cdp = await this.page();
        const loaded = cdp.nextLoad();
        await cdp.send('Page.reload');
        await loaded;
        return this.where(cdp, 'Reloaded');
      }
    }
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
  }

  private live(): boolean {
    return !!this.tab && vscode.window.browserTabs.includes(this.tab);
  }

  /** Opens the browser in the right-hand editor group, at the remembered width. */
  private async openTab(url: string, background: boolean): Promise<void> {
    this.tab = await vscode.window.openBrowserTab(url, { viewColumn: vscode.ViewColumn.Two, preserveFocus: true, background });
    this.cdp = undefined;
    await this.layout(clampBrowserWidth(this.context.globalState.get(WIDTH_KEY)));
  }

  /** The CDP session on FriedLiver's own tab; never a tab the user opened. */
  private page(): Promise<Cdp> {
    let tab: vscode.BrowserTab;
    try {
      tab = ownTab(this.tab, vscode.window.browserTabs);
    } catch (err) {
      return Promise.reject(err);
    }
    const cdp = this.cdp?.then((c) => (c.closed ? Cdp.attach(tab, () => this.corsRelaxed()) : c));
    this.cdp = cdp ?? Cdp.attach(tab, () => this.corsRelaxed());
    this.cdp.catch(() => (this.cdp = undefined));
    return this.cdp;
  }

  private async find(cdp: Cdp, selector: string | undefined, text: string | undefined, focus: boolean): Promise<{ x: number; y: number; what: string }> {
    let at: { x: number; y: number; what: string } | null;
    try {
      at = await cdp.evaluate(locate(selector, text, focus));
    } catch (err) {
      throw new Error(`Could not use the selector ${selector}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (!at) throw new Error(selector ? `Nothing on the page matches ${selector}.` : `No link, button or label on the page says "${text}". Use browser_snapshot to see what is there.`);
    return at;
  }

  private async where(cdp: Cdp, verb: string): Promise<string> {
    const { title, url } = await cdp.evaluate<{ title: string; url: string }>('({ title: document.title, url: location.href })');
    return `${verb} ${url}${title ? ` (“${title}”)` : ''}`;
  }

  private corsRelaxed(): boolean {
    return userSetting(vscode.workspace.getConfiguration('friedliver').inspect<boolean>('browser.relaxLocalhostCors')).value === true;
  }

  /** Two groups side by side, the browser taking `fraction` of the width. */
  private async layout(fraction: number): Promise<void> {
    if (vscode.window.tabGroups.all.length !== 2) return;
    await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{ size: 1 - fraction }, { size: fraction }] }).then(undefined, (err: unknown) => {
      this.log(`FriedLiver browser: could not set the layout (${String(err)}).`);
    });
  }

  private async rememberWidth(): Promise<void> {
    if (!this.live() || vscode.window.tabGroups.all.length !== 2) return;
    const l = await vscode.commands.executeCommand<{ orientation?: number; groups?: { size?: number }[] }>('vscode.getEditorLayout').then(undefined, () => undefined);
    const [left, right] = l?.groups ?? [];
    if (l?.orientation !== 0 || !left?.size || !right?.size) return;
    const raw = right.size / (left.size + right.size);
    const clamped = clampBrowserWidth(raw);
    await this.context.globalState.update(WIDTH_KEY, clamped);
    if (Math.abs(raw - clamped) > 0.005) await this.layout(clamped);
  }
}

/** A click may start a navigation or a re-render; give it a moment before reading the page. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 400));
}
