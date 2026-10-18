import { isBrowserCall, isExternal, isIndexCall, isSystemCall, type BridgeCall, type BrowserCall, type SystemCall } from '../bridge/protocol';
import type { IndexCall } from './projectIndex';
import { browserNeedsApproval, checkBrowserUrl } from './browserRules';
import { AGENT_FACES, BRIDGE_TIMEOUT_MS, BROWSER_VERBS, bridgeTitle, MAX_LINK_DEPTH, type Action, type AgentKey, type AppState, type BridgeItem, type ChatView } from '../shared/model';
import { siteOrigin, type Grant, type ToolGrant } from '../shared/permissions';
import { browserRisk } from '../shared/risk';
import { alwaysAllowable, describeTarget, SYSTEM_LIMITS, SYSTEM_VERBS, type SystemTool } from '../shared/system';
import type { Permissions } from './permissions';
import { auditLine, RateLimit, type Prepared } from './system';
import { agentList, chatList, renderChat } from './transcript';

/** Whether agents may reach other agents and chats through the FriedLiver tools. */
export type AgentToAgent = 'ask' | 'allow' | 'off';

/** The user's answer: once, for this chat (or external session), always (remembered), or no. */
export type BridgeAnswer = 'allow' | 'allowChat' | 'allowAlways' | 'deny';

/** Who asked, as Manage Permissions names it. */
export const EXTERNAL_AGENT = 'Claude Code (outside FriedLiver)';

const APPROVAL_TIMEOUT_MS = BRIDGE_TIMEOUT_MS;
const DEFAULT_READ = 10;
/** Requests one chat may have waiting on the user, so an agent can't bury its chat in questions. */
export const MAX_WAITING_PER_CHAT = 3;

/** What the tools need from the core. */
export interface ToolHost {
  readonly state: AppState;
  policy(): AgentToAgent;
  dispatch(action: Action): void;
  id(prefix: string): string;
  /** Tells the user an agent waits for their answer, when they may not see the chat. */
  /** `careful`: once only, held on its card; `once`: Allow (once) and Deny only. A popup offers Allow and Deny, nothing wider, for either. */
  notify(ask: { chatId: string; requestId: string; title: string; detail?: string; always?: string; careful?: boolean; once?: boolean }): void;
  /** The consultation `chatId` already has with `agent`, if any. */
  consultation(chatId: string, agent: AgentKey): ChatView | undefined;
  /** Asks another agent and resolves with its answer; `started` gets the consulted chat. */
  consult(chatId: string, agent: AgentKey, text: string, targetChatId: string | undefined, started: (chatId: string) => void): Promise<string>;
  /** Gives another chat a message and starts its turn without waiting for it. */
  message(chatId: string, targetChatId: string, text: string): void;
  cancel(chatId: string): Promise<void>;
  /** Does a browser tool call for the chat (browser.ts); absent when the editor has no built-in browser. */
  browser?(chatId: string, call: BrowserCall, signal: AbortSignal, expectOrigin?: string): Promise<string>;
  /** Appends a fact to the project's memory (sharedRules.ts remember); absent when there is no trusted folder. */
  remember?(fact: string): Promise<string>;
  /** Whether browser actions by the external client (EXTERNAL_CLIENT) skip the user's OK. Default no. */
  externalAutoApprove?(): boolean;
  /** The open page's origin, and whether `selector` there is a password field (unknown counts as one). */
  browserPage?(selector?: string): Promise<{ origin?: string; password: boolean }>;
  /** Answers the read-only index_* tools (projectIndexHost.ts); absent when there is no project index. */
  index?(call: IndexCall): Promise<string>;
  /** Remembered "Always allow" answers (permissions.ts); without them nothing is offered or remembered. */
  permissions?: Pick<Permissions, 'site' | 'tool' | 'add'> & Partial<Pick<Permissions, 'system'>>;
  /** The system_* tools (system.ts, with the user's settings); absent when this editor has none. */
  system?: SystemHost;
}

/** What the system_* tools need: the user's settings, the checks and actions (system.ts), the audit log and the status bar. */
export interface SystemHost {
  settings(): { enabled: boolean; fullAutoAllowed: boolean; tools: Record<SystemTool, boolean> };
  prepare(call: SystemCall): Promise<Prepared>;
  /** One line for the "FriedLiver: System Actions" output channel. */
  audit(line: string): void;
  /** An action ran: "Agent used: Open Spotify" in the status bar. */
  done(summary: string): void;
}

type Always = { grant: Grant; agent: string };

type ChatCall = Exclude<BridgeCall, BrowserCall | IndexCall | SystemCall | { tool: 'list_agents' | 'list_chats' | 'remember' }>;

type Answer = 'allowed' | 'denied' | 'timeout';

/**
 * Requests agents make through the FriedLiver tools. Listing agents and chats
 * is always fine; asking an agent, messaging a chat or reading one waits for
 * the user under "ask". Agents can't reach their own chat, a chat that is
 * waiting on them, or a busy chat, and can't start chats past MAX_LINK_DEPTH,
 * so they can't loop or deadlock each other.
 */
export class BridgeRequests {
  /** `careful` / `once`: allowed once only; "for this chat" and "always" are refused for it. */
  private readonly pending = new Map<string, { chatId: string; allowKey: string; always?: Always; careful?: boolean; once?: boolean; resolve(answer: Answer): void }>();
  /** System actions per chat or external session, per minute. */
  private readonly systemRate = new RateLimit();
  /**
   * What "Allow for this chat" allowed for the rest of this window: `<chatId>`, `<chatId> browser`, or for an
   * external MCP session `<callerId> browser <origin>`, so a new session or another site asks again.
   */
  private readonly allowedChats = new Set<string>();
  /** For each chat, the chats it is waiting on through ask_agent. */
  private readonly waits = new Map<string, Set<string>>();

  constructor(private readonly host: ToolHost) {}

  async call(chatId: string, call: BridgeCall, signal: AbortSignal): Promise<string> {
    if (this.host.policy() === 'off') throw new Error('The user turned off agent-to-agent connections in FriedLiver.');
    if (isExternal(chatId)) {
      if (isSystemCall(call)) return this.system(chatId, undefined, call, signal);
      if (!isBrowserCall(call)) throw new Error('Only the browser_* and system_* tools are open to clients outside FriedLiver.');
      return this.external(chatId, call, signal);
    }
    const caller = this.chat(chatId);
    if (!caller) throw new Error('This chat was closed in FriedLiver.');
    if (caller.readOnly) throw new Error('This chat only proposes text: FriedLiver tools are off in it.');
    if (isSystemCall(call)) return this.system(chatId, caller, call, signal);
    if (call.tool === 'list_agents') return agentList();
    if (call.tool === 'list_chats') return chatList(this.host.state, chatId);
    // Read-only and local to the project, like reading a file: no approval.
    if (isIndexCall(call)) return this.host.index ? this.host.index(call) : 'No project index in this editor. Search the files another way.';
    if (isBrowserCall(call)) return this.browser(caller, call, signal);
    if (call.tool === 'remember') return this.memory(caller, call.fact, signal);

    this.check(caller, call);
    this.room(chatId);
    const item: BridgeItem = {
      kind: 'bridge',
      requestId: this.host.id('bridge'),
      tool: call.tool,
      target: call.tool === 'ask_agent' && !call.chatId ? { agent: call.agent } : { chatId: call.chatId! },
      text: call.tool === 'ask_agent' ? call.prompt : call.tool === 'send_to_chat' ? call.message : '',
      state: 'awaiting',
    };
    settled(await this.approve(caller, item, this.host.policy() === 'allow' || this.allowedChats.has(caller.id), signal, this.toolGrant(call.tool)));
    // The state may have changed while the user decided.
    this.check(caller, call);

    switch (call.tool) {
      case 'ask_agent': {
        let target: string | undefined;
        const stop = () => {
          if (target) void this.host.cancel(target);
        };
        signal.addEventListener('abort', stop, { once: true });
        try {
          return await this.host.consult(chatId, call.agent, call.prompt, call.chatId, (id) => {
            target = id;
            this.wait(chatId, id, true);
          });
        } finally {
          signal.removeEventListener('abort', stop);
          if (target) this.wait(chatId, target, false);
        }
      }
      case 'send_to_chat': {
        const target = this.chat(call.chatId)!;
        this.host.message(chatId, target.id, call.message);
        return `Sent to ${target.label} (${target.id}). It is working on it now; use read_chat later to see its reply.`;
      }
      case 'read_chat':
        return renderChat(this.chat(call.chatId)!, call.last ?? DEFAULT_READ);
    }
  }

  /** remember: waits for the user like the other chat tools, then appends to .friedliver/memory.md. */
  private async memory(caller: ChatView, fact: string, signal: AbortSignal): Promise<string> {
    if (!this.host.remember) throw new Error('There is no trusted project folder open, so FriedLiver keeps no memory for it.');
    const key = `${caller.id} memory`;
    const auto = this.host.policy() === 'allow' || this.allowedChats.has(key);
    if (!auto && !this.host.permissions?.tool('remember')) this.room(caller.id);
    const item: BridgeItem = { kind: 'bridge', requestId: this.host.id('bridge'), tool: 'remember', target: { memory: true }, text: fact, state: 'awaiting' };
    settled(await this.approve(caller, item, auto, signal, this.toolGrant('remember')));
    if (this.host.policy() === 'off') throw new Error('The user turned off the FriedLiver tools.');
    return `Remembered: ${await this.host.remember(fact)}`;
  }

  /**
   * A browser tool call. Looking (snapshot, screenshot, console) goes ahead; acting (open, click,
   * type, back, reload) waits for the user unless the chat is on Full auto or they allowed the
   * browser for this chat. Only http and https URLs are opened.
   */
  private async browser(caller: ChatView, call: BrowserCall, signal: AbortSignal): Promise<string> {
    if (!this.host.browser) throw new Error("FriedLiver's built-in browser isn't available in this editor.");
    if (call.tool === 'browser_open') call = { ...call, url: checkBrowserUrl(call.url) };
    if (!browserNeedsApproval(call.tool, undefined)) return this.host.browser(caller.id, call, signal);
    const text =
      call.tool === 'browser_open' ? call.url : call.tool === 'browser_click' ? (call.selector ?? `"${call.text}"`) : call.tool === 'browser_type' ? `${call.selector} ← ${call.text}` : '';
    // A purchase or a form submit asks every time: only Full auto lets it through, never "this chat" or a remembered site.
    const careful = browserRisk(call.tool, call.tool === 'browser_click' ? `${call.selector ?? ''} ${call.text ?? ''}` : text).tone === 'careful';
    const allowed = !browserNeedsApproval(call.tool, caller.approval) || (!careful && this.allowedChats.has(`${caller.id} browser`));
    // The site it acts on: what "Always allow" remembers, and what browser.ts checks again just before acting.
    const origin = allowed || !this.host.permissions ? undefined : call.tool === 'browser_open' ? siteOrigin(call.url) : siteOrigin((await this.host.browserPage?.().catch(() => undefined))?.origin ?? '');
    const remembered = origin && !careful ? this.host.permissions?.site(origin) : undefined;
    const auto = allowed || !!remembered;
    if (!auto) this.room(caller.id);
    const item: BridgeItem = {
      kind: 'bridge',
      requestId: this.host.id('bridge'),
      tool: call.tool as BridgeItem['tool'],
      target: { browser: true },
      text,
      state: 'awaiting',
      ...(remembered ? { auto: `Always allowed: ${origin}` } : {}),
    };
    // Careful: no grant to remember, but the origin still rides along for the card and browser.ts's recheck.
    settled(await this.approve(caller, careful ? { ...item, ...(origin ? { always: origin } : {}) } : item, auto, signal, origin && !careful ? { kind: 'site', origin } : undefined, careful));
    // Either can change while the user decides.
    if (this.host.policy() === 'off') throw new Error('The user turned off the FriedLiver tools.');
    if (!this.chat(caller.id)) throw new Error('This chat was closed in FriedLiver.');
    return this.host.browser(caller.id, call, signal, origin && call.tool !== 'browser_open' ? origin : undefined);
  }

  /**
   * A browser call from outside FriedLiver (Claude Code). Like a chat on Ask, but the popup says
   * exactly what it will do and where, and "Allow for this session" holds for this MCP session on
   * this origin only. Skips asking only under friedliver.browser.externalAutoApprove.
   */
  private async external(id: string, call: BrowserCall, signal: AbortSignal): Promise<string> {
    if (!this.host.browser) throw new Error("FriedLiver's built-in browser isn't available in this editor.");
    if (call.tool === 'browser_open') call = { ...call, url: checkBrowserUrl(call.url) };
    if (browserNeedsApproval(call.tool, undefined)) {
      const page = (await this.host.browserPage?.(call.tool === 'browser_type' ? call.selector : undefined).catch(() => undefined)) ?? { password: true };
      const origin = call.tool === 'browser_open' ? new URL(call.url).origin : (page.origin ?? 'an unknown page');
      const allowKey = `${id} browser ${origin}`;
      // 'an unknown page' is no origin: it never matches a rule and can't be always allowed.
      const site = siteOrigin(origin);
      // A purchase or a form submit asks every time, once only: never this session's OK or a remembered site.
      const careful = call.tool === 'browser_click' && browserRisk(call.tool, `${call.selector ?? ''} ${call.text ?? ''}`).tone === 'careful';
      if (!this.host.externalAutoApprove?.() && (careful || (!this.allowedChats.has(allowKey) && !(site && this.host.permissions?.site(site))))) {
        this.room(id);
        const title = `Claude Code wants to ${BROWSER_VERBS[call.tool as BridgeItem['tool']] ?? 'use'} in the browser`;
        const always = site && this.host.permissions && !careful ? { grant: { kind: 'site' as const, origin: site }, agent: EXTERNAL_AGENT } : undefined;
        settled(await this.waitFor(id, allowKey, title, `${clean(origin)}: ${externalDetail(call, page.password)}`, signal, always, careful));
        if (this.host.policy() === 'off') throw new Error('The user turned off the FriedLiver tools.');
      }
      if (!this.host.externalAutoApprove?.() && call.tool !== 'browser_open') {
        // The OK was for this origin: if the page moved on meanwhile, nothing happens. browser.ts checks again just before it acts.
        const now = (await this.host.browserPage?.().catch(() => undefined))?.origin;
        if (now !== origin) throw new Error(`The page changed to ${clean(now ?? 'an unknown page')} after you approved; ask again.`);
        return this.host.browser(id, call, signal, origin);
      }
    }
    return this.host.browser(id, call, signal);
  }

  /** A system_* call from a chat (`caller`) or an external session; every attempt goes in the audit log. */
  private async system(id: string, caller: ChatView | undefined, call: SystemCall, signal: AbortSignal): Promise<string> {
    const agent = caller ? AGENT_FACES[caller.agent].name : EXTERNAL_AGENT;
    const log = (result: string) => this.host.system?.audit(auditLine({ at: Date.now(), agent, chat: caller?.id ?? id, call, result }));
    try {
      const { text, summary } = await this.systemCall(id, caller, call, signal);
      log(`ok: ${summary}`);
      return text;
    } catch (err) {
      log(`not done: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /**
   * Asks unless the chat (or session) allowed exactly this tool on exactly this target, the user
   * always allowed it, or the chat is on Full auto and friedliver.system.fullAutoAllowed is on. The
   * clipboard, screenshots and terminal-like apps are asked for every time, whatever the rest says.
   * Checks again just before acting.
   */
  private async systemCall(id: string, caller: ChatView | undefined, call: SystemCall, signal: AbortSignal): Promise<{ text: string; summary: string }> {
    const sys = this.host.system;
    if (!sys) throw new Error("FriedLiver's Mac & Windows control isn't available in this editor.");
    const on = () => {
      const s = sys.settings();
      if (!s.enabled) throw new Error('The user turned off Mac & Windows control in FriedLiver.');
      if (!s.tools[call.tool]) throw new Error(`The user turned off ${call.tool} in FriedLiver's settings.`);
      return s;
    };
    const settings = on();
    if (!this.systemRate.take(id)) throw new Error(`Too many system actions: at most ${SYSTEM_LIMITS.perMinute} a minute. Wait a moment before the next.`);
    const prepared = await sys.prepare(call);
    const once = !alwaysAllowable(call.tool, prepared.target);
    const allowKey = `${id} system ${call.tool} ${prepared.target}`;
    const grant: Grant | undefined = !once && this.host.permissions ? { kind: 'system', tool: call.tool, target: prepared.target } : undefined;
    const remembered = grant ? this.host.permissions?.system?.(call.tool, prepared.target) : undefined;
    const fullAuto = !!caller && caller.approval === 'full' && settings.fullAutoAllowed;
    const auto = !once && (fullAuto || this.allowedChats.has(allowKey) || !!remembered);
    // Names come from disk (an app's folder name): no control or direction characters that could make it read as another.
    const shown = clean(prepared.target.replace(/^(app|url|file):/, ''), 300);
    if (caller) {
      if (!auto) this.room(id);
      const item: BridgeItem = {
        kind: 'bridge',
        requestId: this.host.id('bridge'),
        tool: call.tool,
        target: { system: shown },
        // The title already names an app or a Shortcut.
        text: prepared.text === shown ? '' : prepared.text,
        state: 'awaiting',
        ...(once ? { once: true as const } : {}),
        ...(remembered ? { auto: `Always allowed${prepared.target ? `: ${shown}` : ''}` } : fullAuto ? { auto: 'Full auto' } : {}),
      };
      settled(await this.approve(caller, item, auto, signal, grant, false, allowKey));
      if (!this.chat(caller.id)) throw new Error('This chat was closed in FriedLiver.');
    } else if (!auto) {
      this.room(id);
      const title = `Claude Code wants to ${SYSTEM_VERBS[call.tool]}${call.tool === 'system_open' || call.tool === 'system_focus' || call.tool === 'system_shortcut' ? ` ${clean(shown, 60)}` : ''}`;
      settled(await this.waitFor(id, allowKey, title, clean(prepared.text || prepared.summary, 300), signal, grant ? { grant, agent: EXTERNAL_AGENT } : undefined, false, once));
    }
    if (this.host.policy() === 'off') throw new Error('The user turned off the FriedLiver tools.');
    on();
    // The file, app or window may have changed while the user decided: act only on what they saw.
    const now = await sys.prepare(call);
    if (now.target !== prepared.target || now.text !== prepared.text) throw new Error('What this would act on changed after the user approved it. Ask again.');
    const text = await now.run(signal);
    sys.done(now.summary);
    return { text, summary: now.summary };
  }

  /** Waits for the user's answer to a request no chat holds. */
  private waitFor(chatId: string, allowKey: string, title: string, detail: string, signal: AbortSignal, always?: Always, careful = false, once = false): Promise<Answer> {
    const requestId = this.host.id('bridge');
    return new Promise((resolve) => {
      const done = (answer: Answer) => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(answer);
      };
      const onAbort = () => done('denied');
      const timer = setTimeout(() => done('timeout'), APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(requestId, { chatId, allowKey, always, careful, once, resolve: done });
      if (signal.aborted) return done('denied');
      signal.addEventListener('abort', onAbort, { once: true });
      this.host.notify({ chatId, requestId, title, detail, ...(always && !careful && !once ? { always: alwaysWords(always.grant) } : {}), ...(careful ? { careful } : {}), ...(once ? { once: true } : {}) });
    });
  }

  /** Every external session's token use stops: nothing of theirs waits, nothing stays allowed. */
  forgetExternal(): void {
    for (const p of [...this.pending.values()]) if (isExternal(p.chatId)) p.resolve('denied');
    for (const key of [...this.allowedChats]) if (isExternal(key.split(' ')[0])) this.allowedChats.delete(key);
  }

  /** Throws when the chat already has as many requests waiting on the user as it may. */
  private room(chatId: string): void {
    if ([...this.pending.values()].filter((p) => p.chatId === chatId).length >= MAX_WAITING_PER_CHAT) {
      throw new Error(`${MAX_WAITING_PER_CHAT} of your requests already wait for the user. Wait for their answers before asking again.`);
    }
  }

  /** The user's answer from a chat view or a notification. */
  answer(requestId: string, answer: BridgeAnswer): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    // A careful or once-only request is allowed once: a wider answer (from a stale view) does nothing more.
    if (p.careful && (answer === 'allowChat' || answer === 'allowAlways')) return;
    if (answer === 'allowChat' && !p.once) this.allowedChats.add(p.allowKey);
    // Remembered for every chat and later session; a request that offered nothing to remember is allowed once.
    if (answer === 'allowAlways' && p.always && !p.once) this.host.permissions?.add(p.always.grant, p.always.agent);
    p.resolve(answer === 'deny' ? 'denied' : 'allowed');
  }

  /**
   * The chat's turn ended or was stopped: nothing it asked for still waits on
   * the user. When stopped, the consultations it waits on stop too.
   */
  settle(chatId: string, stopped: boolean): void {
    for (const p of [...this.pending.values()]) if (p.chatId === chatId) p.resolve('denied');
    if (!stopped) return;
    for (const target of this.waits.get(chatId) ?? []) void this.host.cancel(target);
  }

  /** The tools were turned off: nothing still waiting on the user goes ahead. */
  refuseAll(): void {
    for (const p of [...this.pending.values()]) p.resolve('denied');
  }

  forget(chatId: string): void {
    this.settle(chatId, true);
    this.allowedChats.delete(chatId);
    this.allowedChats.delete(`${chatId} browser`);
    this.allowedChats.delete(`${chatId} memory`);
    for (const key of [...this.allowedChats]) if (key.startsWith(`${chatId} system `)) this.allowedChats.delete(key);
    this.systemRate.forget(chatId);
    this.waits.delete(chatId);
  }

  /** Throws, with a message for the agent, when the call must not go ahead. */
  private check(caller: ChatView, call: ChatCall): void {
    if (call.tool === 'ask_agent' && !call.chatId) {
      const existing = this.host.consultation(caller.id, call.agent);
      if (existing) {
        this.reachable(caller, existing);
      } else if (caller.depth + 1 > MAX_LINK_DEPTH) {
        throw new Error(`Too many hops: agents may start chats only ${MAX_LINK_DEPTH} steps away from one the user started. Answer without asking further.`);
      }
      return;
    }
    const target = this.chat(call.chatId!);
    if (!target) throw new Error(`There is no chat ${call.chatId}. Use list_chats to see the open ones.`);
    if (call.tool === 'read_chat') {
      if (target.id === caller.id) throw new Error('That is this chat; you already have its history.');
      return;
    }
    if (call.tool === 'ask_agent' && target.agent !== call.agent) throw new Error(`${target.id} is a ${target.agent} chat, not ${call.agent}.`);
    this.reachable(caller, target);
  }

  /** Whether a chat may take a message from the caller: not itself, not part of a wait between them, and idle. */
  private reachable(caller: ChatView, target: ChatView): void {
    if (target.id === caller.id) throw new Error('That is this chat. Answer the user directly instead.');
    if (this.linked(caller.id).has(target.id)) {
      throw new Error(`${target.label} is waiting on this chat, or this chat on it, so asking it now would deadlock.`);
    }
    if (target.busy) throw new Error(`${target.label} is busy. Try again when it is idle, or carry on without it.`);
  }

  /** Every chat joined to `chatId` by waits, either way round. */
  private linked(chatId: string): Set<string> {
    const out = new Set<string>();
    const walk = (from: string, next: (id: string) => Iterable<string>) => {
      const queue = [from];
      while (queue.length) {
        for (const id of next(queue.shift()!)) {
          if (!out.has(id) && id !== chatId) {
            out.add(id);
            queue.push(id);
          }
        }
      }
    };
    walk(chatId, (id) => this.waits.get(id) ?? []);
    walk(chatId, (id) => [...this.waits].filter(([, targets]) => targets.has(id)).map(([caller]) => caller));
    return out;
  }

  private wait(chatId: string, target: string, on: boolean): void {
    const set = this.waits.get(chatId) ?? new Set<string>();
    if (on) set.add(target);
    else set.delete(target);
    if (set.size) this.waits.set(chatId, set);
    else this.waits.delete(chatId);
  }

  /** The rule "Always allow" remembers for an agent tool, when remembering is on. */
  private toolGrant(tool: ToolGrant): Grant | undefined {
    return this.host.permissions ? { kind: 'tool', tool } : undefined;
  }

  /**
   * Records the request in the caller's chat and, unless `auto` or a remembered `grant` covers it,
   * waits for the user, who may then remember `grant`.
   */
  private approve(caller: ChatView, item: BridgeItem, auto: boolean, signal: AbortSignal, grant?: Grant, careful = false, systemKey?: string): Promise<Answer> {
    const requestId = item.requestId;
    if (!auto && grant?.kind === 'tool' && this.host.permissions?.tool(grant.tool)) {
      auto = true;
      item = { ...item, auto: 'Always allowed' };
    }
    if (!auto && grant && !item.once) item = { ...item, always: alwaysWords(grant) };
    if (auto) {
      this.host.dispatch({ t: 'items', chatId: caller.id, items: [{ ...item, state: 'allowed' }], at: Date.now() });
      return Promise.resolve('allowed');
    }
    return new Promise((resolve) => {
      const done = (answer: Answer) => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.host.dispatch({ t: 'bridge', requestId, state: answer === 'allowed' ? 'allowed' : 'denied' });
        resolve(answer);
      };
      const onAbort = () => done('denied');
      const timer = setTimeout(() => done('timeout'), APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      const allowKey = systemKey ?? ('browser' in item.target ? `${caller.id} browser` : 'memory' in item.target ? `${caller.id} memory` : caller.id);
      const always = grant && !item.once ? { grant, agent: AGENT_FACES[caller.agent].name } : undefined;
      this.pending.set(requestId, { chatId: caller.id, allowKey, always, careful, once: !!item.once, resolve: done });
      this.host.dispatch({ t: 'items', chatId: caller.id, items: [item], at: Date.now() });
      if (signal.aborted) return done('denied');
      signal.addEventListener('abort', onAbort, { once: true });
      this.host.notify({ chatId: caller.id, requestId, title: bridgeTitle(this.host.state, this.chat(caller.id) ?? caller, item), ...(careful ? { careful } : {}), ...(item.once ? { once: true } : {}) });
    });
  }

  private chat(chatId: string): ChatView | undefined {
    return this.host.state.chats.find((c) => c.id === chatId);
  }
}

/** Text from an agent, safe to show in a popup: no control or direction characters, at most ~120 characters. */
export function clean(text: string, max = 120): string {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ');
  return plain.length > max ? `${plain.slice(0, max)}…` : plain;
}

/** What an external browser action will do, for its popup; typing into a password field shows no text. */
export function externalDetail(call: BrowserCall, password: boolean): string {
  switch (call.tool) {
    case 'browser_open':
      return `open ${clean(call.url)}`;
    case 'browser_click':
      return call.selector ? `click ${clean(call.selector)}` : `click "${clean(call.text ?? '')}"`;
    case 'browser_type':
      return `type ${password ? '•••••••• (a password field)' : `"${clean(call.text)}"`} into ${clean(call.selector)}`;
    case 'browser_back':
      return 'go back';
    case 'browser_reload':
      return 'reload';
    default:
      return call.tool;
  }
}

/** What "Always allow" would cover, in words: a site's origin, an app, a link's site or a file, or "in every chat". */
function alwaysWords(g: Grant): string {
  if (g.kind === 'site') return g.origin;
  if (g.kind === 'system' && g.target) return describeTarget(g.target);
  return 'in every chat';
}

/** Throws, for the agent, unless the user allowed it. */
function settled(answer: Answer): void {
  if (answer === 'timeout') throw new Error('Nobody answered within 10 minutes, so FriedLiver did not allow it. Carry on without it.');
  if (answer === 'denied') throw new Error('The user did not allow this. Carry on without it, or ask the user about it in your reply.');
}
