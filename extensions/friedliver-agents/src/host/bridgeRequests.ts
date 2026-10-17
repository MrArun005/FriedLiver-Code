import { EXTERNAL_CLIENT, isBrowserCall, type BridgeCall, type BrowserCall } from '../bridge/protocol';
import { browserNeedsApproval, checkBrowserUrl } from './browserRules';
import { bridgeTitle, MAX_LINK_DEPTH, type Action, type AgentKey, type AppState, type BridgeItem, type ChatView } from '../shared/model';
import { agentList, chatList, renderChat } from './transcript';

/** Whether agents may reach other agents and chats through the FriedLiver tools. */
export type AgentToAgent = 'ask' | 'allow' | 'off';

const APPROVAL_TIMEOUT_MS = 10 * 60_000;
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
  notify(ask: { chatId: string; requestId: string; title: string }): void;
  /** The consultation `chatId` already has with `agent`, if any. */
  consultation(chatId: string, agent: AgentKey): ChatView | undefined;
  /** Asks another agent and resolves with its answer; `started` gets the consulted chat. */
  consult(chatId: string, agent: AgentKey, text: string, targetChatId: string | undefined, started: (chatId: string) => void): Promise<string>;
  /** Gives another chat a message and starts its turn without waiting for it. */
  message(chatId: string, targetChatId: string, text: string): void;
  cancel(chatId: string): Promise<void>;
  /** Does a browser tool call for the chat (browser.ts); absent when the editor has no built-in browser. */
  browser?(chatId: string, call: BrowserCall, signal: AbortSignal): Promise<string>;
  /** Whether browser actions by the external client (EXTERNAL_CLIENT) skip the user's OK. Default no. */
  externalAutoApprove?(): boolean;
}

type ChatCall = Exclude<BridgeCall, BrowserCall | { tool: 'list_agents' | 'list_chats' }>;

type Answer = 'allowed' | 'denied' | 'timeout';

/**
 * Requests agents make through the FriedLiver tools. Listing agents and chats
 * is always fine; asking an agent, messaging a chat or reading one waits for
 * the user under "ask". Agents can't reach their own chat, a chat that is
 * waiting on them, or a busy chat, and can't start chats past MAX_LINK_DEPTH,
 * so they can't loop or deadlock each other.
 */
export class BridgeRequests {
  private readonly pending = new Map<string, { chatId: string; browser: boolean; resolve(answer: Answer): void }>();
  /** Chats whose agent the user allowed for the rest of this window, as `<chatId>` or, for the browser, `<chatId> browser`. */
  private readonly allowedChats = new Set<string>();
  /** For each chat, the chats it is waiting on through ask_agent. */
  private readonly waits = new Map<string, Set<string>>();

  constructor(private readonly host: ToolHost) {}

  async call(chatId: string, call: BridgeCall, signal: AbortSignal): Promise<string> {
    if (this.host.policy() === 'off') throw new Error('The user turned off agent-to-agent connections in FriedLiver.');
    if (chatId === EXTERNAL_CLIENT) {
      if (!isBrowserCall(call)) throw new Error('Only the browser_* tools are open to clients outside FriedLiver.');
      // Not a chat: it asks like one on "Ask", and skips asking only when the user opted in.
      const external = { id: EXTERNAL_CLIENT, label: 'Claude Code', approval: this.host.externalAutoApprove?.() ? 'full' : undefined } as ChatView;
      return this.browser(external, call, signal);
    }
    const caller = this.chat(chatId);
    if (!caller) throw new Error('This chat was closed in FriedLiver.');
    if (call.tool === 'list_agents') return agentList();
    if (call.tool === 'list_chats') return chatList(this.host.state, chatId);
    if (isBrowserCall(call)) return this.browser(caller, call, signal);

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
    settled(await this.approve(caller, item, this.host.policy() === 'allow' || this.allowedChats.has(caller.id), signal));
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

  /**
   * A browser tool call. Looking (snapshot, screenshot, console) goes ahead; acting (open, click,
   * type, back, reload) waits for the user unless the chat is on Full auto or they allowed the
   * browser for this chat. Only http and https URLs are opened.
   */
  private async browser(caller: ChatView, call: BrowserCall, signal: AbortSignal): Promise<string> {
    if (!this.host.browser) throw new Error("FriedLiver's built-in browser isn't available in this editor.");
    if (call.tool === 'browser_open') call = { ...call, url: checkBrowserUrl(call.url) };
    if (!browserNeedsApproval(call.tool, undefined)) return this.host.browser(caller.id, call, signal);
    const auto = !browserNeedsApproval(call.tool, caller.approval) || this.allowedChats.has(`${caller.id} browser`);
    if (!auto) this.room(caller.id);
    const text =
      call.tool === 'browser_open' ? call.url : call.tool === 'browser_click' ? (call.selector ?? `"${call.text}"`) : call.tool === 'browser_type' ? `${call.selector} ← ${call.text}` : '';
    const item: BridgeItem = { kind: 'bridge', requestId: this.host.id('bridge'), tool: call.tool as BridgeItem['tool'], target: { browser: true }, text, state: 'awaiting' };
    settled(await this.approve(caller, item, auto, signal));
    // Either can change while the user decides.
    if (this.host.policy() === 'off') throw new Error('The user turned off the FriedLiver tools.');
    if (caller.id !== EXTERNAL_CLIENT && !this.chat(caller.id)) throw new Error('This chat was closed in FriedLiver.');
    return this.host.browser(caller.id, call, signal);
  }

  /** Throws when the chat already has as many requests waiting on the user as it may. */
  private room(chatId: string): void {
    if ([...this.pending.values()].filter((p) => p.chatId === chatId).length >= MAX_WAITING_PER_CHAT) {
      throw new Error(`${MAX_WAITING_PER_CHAT} of your requests already wait for the user. Wait for their answers before asking again.`);
    }
  }

  /** The user's answer from a chat view or a notification. */
  answer(requestId: string, answer: 'allow' | 'allowChat' | 'deny'): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    if (answer === 'allowChat') this.allowedChats.add(p.browser ? `${p.chatId} browser` : p.chatId);
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

  /** Records the request in the caller's chat and, unless `auto`, waits for the user. */
  private approve(caller: ChatView, item: BridgeItem, auto: boolean, signal: AbortSignal): Promise<Answer> {
    const requestId = item.requestId;
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
      this.pending.set(requestId, { chatId: caller.id, browser: 'browser' in item.target, resolve: done });
      this.host.dispatch({ t: 'items', chatId: caller.id, items: [item], at: Date.now() });
      if (signal.aborted) return done('denied');
      signal.addEventListener('abort', onAbort, { once: true });
      this.host.notify({ chatId: caller.id, requestId, title: bridgeTitle(this.host.state, this.chat(caller.id) ?? caller, item) });
    });
  }

  private chat(chatId: string): ChatView | undefined {
    return this.host.state.chats.find((c) => c.id === chatId);
  }
}

/** Throws, for the agent, unless the user allowed it. */
function settled(answer: Answer): void {
  if (answer === 'timeout') throw new Error('Nobody answered within 10 minutes, so FriedLiver did not allow it. Carry on without it.');
  if (answer === 'denied') throw new Error('The user did not allow this. Carry on without it, or ask the user about it in your reply.');
}
