import type { BridgeCall } from '../bridge/protocol';
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
}

type Answer = 'allowed' | 'denied' | 'timeout';

/**
 * Requests agents make through the FriedLiver tools. Listing agents and chats
 * is always fine; asking an agent, messaging a chat or reading one waits for
 * the user under "ask". Agents can't reach their own chat, a chat that is
 * waiting on them, or a busy chat, and can't start chats past MAX_LINK_DEPTH,
 * so they can't loop or deadlock each other.
 */
export class BridgeRequests {
  private readonly pending = new Map<string, { chatId: string; resolve(answer: Answer): void }>();
  /** Chats whose agent the user allowed for the rest of this window. */
  private readonly allowedChats = new Set<string>();
  /** For each chat, the chats it is waiting on through ask_agent. */
  private readonly waits = new Map<string, Set<string>>();

  constructor(private readonly host: ToolHost) {}

  async call(chatId: string, call: BridgeCall, signal: AbortSignal): Promise<string> {
    if (this.host.policy() === 'off') throw new Error('The user turned off agent-to-agent connections in FriedLiver.');
    const caller = this.chat(chatId);
    if (!caller) throw new Error('This chat was closed in FriedLiver.');
    if (call.tool === 'list_agents') return agentList();
    if (call.tool === 'list_chats') return chatList(this.host.state, chatId);

    this.check(caller, call);
    if ([...this.pending.values()].filter((p) => p.chatId === chatId).length >= MAX_WAITING_PER_CHAT) {
      throw new Error(`${MAX_WAITING_PER_CHAT} of your requests already wait for the user. Wait for their answers before asking again.`);
    }
    const answer = await this.approve(caller, call, signal);
    if (answer === 'timeout') throw new Error('Nobody answered within 10 minutes, so FriedLiver did not allow it. Carry on without it.');
    if (answer === 'denied') throw new Error('The user did not allow this. Carry on without it, or ask the user about it in your reply.');
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

  /** The user's answer from a chat view or a notification. */
  answer(requestId: string, answer: 'allow' | 'allowChat' | 'deny'): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    if (answer === 'allowChat') this.allowedChats.add(p.chatId);
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

  forget(chatId: string): void {
    this.settle(chatId, true);
    this.allowedChats.delete(chatId);
    this.waits.delete(chatId);
  }

  /** Throws, with a message for the agent, when the call must not go ahead. */
  private check(caller: ChatView, call: Exclude<BridgeCall, { tool: 'list_agents' | 'list_chats' }>): void {
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

  /** Records the request in the caller's chat and, under "ask", waits for the user. */
  private approve(caller: ChatView, call: Exclude<BridgeCall, { tool: 'list_agents' | 'list_chats' }>, signal: AbortSignal): Promise<Answer> {
    const requestId = this.host.id('bridge');
    const item: BridgeItem = {
      kind: 'bridge',
      requestId,
      tool: call.tool,
      target: call.tool === 'ask_agent' && !call.chatId ? { agent: call.agent } : { chatId: call.chatId! },
      text: call.tool === 'ask_agent' ? call.prompt : call.tool === 'send_to_chat' ? call.message : '',
      state: 'awaiting',
    };
    if (this.host.policy() === 'allow' || this.allowedChats.has(caller.id)) {
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
      this.pending.set(requestId, { chatId: caller.id, resolve: done });
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
