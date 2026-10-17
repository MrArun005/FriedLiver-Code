import type * as acp from '@agentclientprotocol/sdk';
import type { Attachment } from '../shared/messages';
import { MAX_LINK_DEPTH, lastReply, type Action, type AgentKey, type AppState, type ChatLink, type ChatView, type LinkItem } from '../shared/model';
import type { ApprovalLevel } from '../shared/session';
import { consultBrief, forwardText, handoffContext, handoffSummary } from './transcript';

/** Forwards one pipe makes before it pauses, so two agents can't keep each other busy forever. */
export const MAX_PIPE_FORWARDS = 20;

export interface NewChat {
  /** Shown as the chat's title; also names a new worktree. */
  title?: string;
  /** Give the chat its own git worktree. */
  worktree?: boolean;
  /** Names the worktree's branch instead of the title. */
  worktreeName?: string;
  /** Work in this chat's worktree (or folder) too. */
  shareWorktreeOf?: string;
  origin?: ChatView['origin'];
  depth?: number;
  group?: string;
  /** Session settings to apply once the agent's session starts: optionKey → value (see shared/session.ts). */
  choices?: Record<string, string | boolean>;
  /** The chat's approval level; the user's default when not given. Full auto must already be confirmed. */
  approval?: ApprovalLevel;
  /** Continue this agent session (one started outside FriedLiver) in one of the workspace folders. */
  resume?: { sessionId: string; cwd: string };
  /** Answers only: no FriedLiver tools, and every write, read, command, permission and question is refused up front. */
  readOnly?: boolean;
}

/** How a turn ended, and what the agent said in it. */
export interface TurnResult {
  /** Null when the turn failed before the agent answered. */
  stopReason: acp.StopReason | null;
  reply: string;
}

/** What connections need from the core. */
export interface ChatHost {
  readonly state: AppState;
  dispatch(action: Action): void;
  id(prefix: string): string;
  createChat(agent: AgentKey, options: NewChat): Promise<ChatView>;
  /** Runs one turn with these blocks, after the chat's hand-off context if it has one waiting. */
  prompt(chatId: string, blocks: acp.ContentBlock[]): Promise<TurnResult>;
  /** Puts text in front of the next message the chat is given. */
  preamble(chatId: string, text: string): void;
}

export interface ConsultOptions {
  /** Ask this chat, instead of the consultation the source already has with `agent` or a new one. */
  chatId?: string;
  images?: Attachment[];
  /** Called once the consulted chat is known, before its turn starts. */
  started?(chatId: string): void;
}

/**
 * Chats working together: a hand-off continues one chat's work with another
 * agent, a consultation asks another agent and brings its answer back, a pipe
 * forwards each finished turn to another chat. Every message that crosses
 * shows in both chats as a link item.
 */
export class Connections {
  /** Pipes whose target was busy: the newest forward waits until it is idle. */
  private readonly held = new Map<string, string>();
  /** Forwards each pipe made since it was last turned on. */
  private readonly used = new Map<string, number>();

  constructor(private readonly host: ChatHost) {}

  /** A new chat for `agent` that continues `chatId`'s work, in the same folder. Spends no turn. */
  async handoff(chatId: string, agent: AgentKey): Promise<ChatView> {
    const source = this.require(chatId);
    const target = await this.host.createChat(agent, {
      shareWorktreeOf: source.id,
      title: source.title === 'New chat' ? undefined : source.title,
      origin: { kind: 'handoff', chatId: source.id, by: 'user' },
      depth: source.depth,
    });
    const link = this.addLink('handoff', source.id, target.id, 'user', 1);
    const summary = handoffSummary(source);
    this.carry(link, source, target, 'handoff-to', 'handoff-from', summary, 'user');
    this.host.preamble(target.id, handoffContext(source));
    return this.require(target.id);
  }

  /**
   * Asks another agent from a chat and resolves with its answer, which also
   * lands in the source chat. The consulted chat is an ordinary chat:
   * reviews and approvals apply there.
   */
  async consult(chatId: string, agent: AgentKey, text: string, by: 'user' | 'agent', options: ConsultOptions = {}): Promise<string> {
    const source = this.require(chatId);
    let target = options.chatId ? this.require(options.chatId) : this.consultation(source.id, agent);
    if (target?.id === source.id) throw new Error('A chat cannot ask itself.');
    if (target && target.agent !== agent) throw new Error(`${target.label} is a ${target.agent} chat, not ${agent}.`);
    if (target?.busy) throw new Error(`${target.label} is still working. Wait for it to finish, or ask again later.`);
    if (!target) {
      const depth = source.depth + 1;
      if (by === 'agent' && depth > MAX_LINK_DEPTH) {
        throw new Error(`Too many hops: agents may start chats only ${MAX_LINK_DEPTH} steps away from one the user started. Answer without asking further.`);
      }
      target = await this.host.createChat(agent, {
        shareWorktreeOf: source.id,
        title: text,
        origin: { kind: 'consult', chatId: source.id, by },
        depth,
      });
    }
    const link = this.linkBetween(source.id, target.id, 'consult') ?? this.addLink('consult', source.id, target.id, by, 0);
    options.started?.(target.id);
    this.carry(link, source, target, 'asked', 'consulted', text, by);
    const blocks: acp.ContentBlock[] = [
      { type: 'text', text: consultBrief(source) },
      { type: 'text', text },
      ...(options.images ?? []).map((img): acp.ContentBlock => ({ type: 'image', data: img.data, mimeType: img.mimeType })),
    ];
    const result = await this.host.prompt(target.id, blocks);
    const answered = this.chat(target.id);
    if (!answered) throw new Error(`${target.label} was closed before it answered.`);
    if (!result.reply) {
      const why = result.stopReason && result.stopReason !== 'end_turn' ? ` (${result.stopReason})` : '';
      this.notice(source.id, `${answered.label} stopped without answering${why}.`);
      throw new Error(`${answered.label} stopped without answering${why}.`);
    }
    this.items(source.id, [this.linkItem(link, answered, 'reply', result.reply, by)]);
    this.count(link.id);
    return result.reply;
  }

  /** The consultation a chat already has with an agent, if it can take another question. */
  consultation(chatId: string, agent: AgentKey): ChatView | undefined {
    for (const l of this.host.state.links) {
      if (l.kind !== 'consult' || l.from !== chatId) continue;
      const c = this.chat(l.to);
      if (c && c.agent === agent && !c.archived) return c;
    }
    return undefined;
  }

  /** Forwards each finished turn of `from` to `to` from now on. Turning a paused pipe on again resets its limit. */
  pipe(from: string, to: string, by: 'user' | 'agent'): ChatLink {
    const a = this.require(from);
    const b = this.require(to);
    if (from === to) throw new Error('A chat cannot pipe into itself.');
    const existing = this.host.state.links.find((l) => l.kind === 'pipe' && l.from === from && l.to === to);
    if (existing?.active) return existing;
    if (pipeReaches(this.host.state.links, to, from)) {
      throw new Error(`That would make a loop: ${b.label} already forwards to ${a.label}, directly or through other chats.`);
    }
    if (existing) {
      this.used.set(existing.id, 0);
      this.host.dispatch({ t: 'linkPatch', linkId: existing.id, patch: { active: true } });
      return this.host.state.links.find((l) => l.id === existing.id)!;
    }
    const link = this.addLink('pipe', from, to, by, 0);
    this.used.set(link.id, 0);
    return link;
  }

  unlink(linkId: string): void {
    this.held.delete(linkId);
    this.used.delete(linkId);
    this.host.dispatch({ t: 'unlink', linkId });
  }

  /** Sends `from`'s last reply into `to`, e.g. a consultant's answer back to the main chat. */
  async forward(from: string, to: string): Promise<TurnResult> {
    const source = this.require(from);
    const text = lastReply(source);
    if (!text) throw new Error(`${source.label} has no reply to forward yet.`);
    return this.message(from, to, text, 'user');
  }

  /**
   * Gives `to` a message from `from`, shown in both chats, and runs its turn.
   * Pipes pass their link; otherwise any link between the two chats counts it.
   */
  message(from: string, to: string, text: string, by: 'user' | 'agent', link?: ChatLink): Promise<TurnResult> {
    const source = this.require(from);
    const target = this.require(to);
    if (from === to) throw new Error('A chat cannot message itself.');
    if (target.busy) throw new Error(`${target.label} is busy. Wait for it to finish, or stop it.`);
    const via = link ?? this.linkBetween(from, to) ?? this.linkBetween(to, from);
    const linkId = via?.id ?? this.host.id('msg');
    this.items(from, [{ kind: 'link', linkId, role: 'piped-out', chatId: to, agent: target.agent, label: target.label, text, by }]);
    this.items(to, [{ kind: 'link', linkId, role: 'piped-in', chatId: from, agent: source.agent, label: source.label, text, by }]);
    if (via) this.count(via.id);
    return this.host.prompt(to, [{ type: 'text', text: forwardText(source, text) }]);
  }

  /** Called by the core when a chat's turn ends: pipes forward it, and a forward held for this chat goes in. */
  turnEnded(chatId: string, result: TurnResult): void {
    if (result.stopReason === 'end_turn' && result.reply) {
      for (const link of this.host.state.links) {
        if (link.kind === 'pipe' && link.active && link.from === chatId) this.pipeForward(link, result.reply);
      }
    }
    this.releaseHeld(chatId);
  }

  /** The chat is gone: drop what waits on it. Its links go with it in the state. */
  forget(chatId: string): void {
    for (const l of this.host.state.links) {
      if (l.from === chatId || l.to === chatId) {
        this.held.delete(l.id);
        this.used.delete(l.id);
      }
    }
  }

  private pipeForward(link: ChatLink, text: string): void {
    const to = this.chat(link.to);
    if (!to) return;
    if (to.busy) {
      this.held.set(link.id, text);
      return;
    }
    this.deliver(link, text);
  }

  private releaseHeld(chatId: string): void {
    for (const [linkId, text] of this.held) {
      const link = this.host.state.links.find((l) => l.id === linkId);
      if (!link?.active) {
        this.held.delete(linkId);
        continue;
      }
      if (link.to !== chatId) continue;
      if (this.chat(chatId)?.busy) return;
      this.held.delete(linkId);
      // One at a time; the next waits for this turn to end.
      this.deliver(link, text);
      return;
    }
  }

  private deliver(link: ChatLink, text: string): void {
    const n = (this.used.get(link.id) ?? 0) + 1;
    this.used.set(link.id, n);
    try {
      // A failed turn says why in its own notice.
      this.message(link.from, link.to, text, link.by, link).catch(() => {});
    } catch (err) {
      this.notice(link.from, `Couldn't forward to the other chat: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (n >= MAX_PIPE_FORWARDS) {
      this.host.dispatch({ t: 'linkPatch', linkId: link.id, patch: { active: false } });
      const to = this.chat(link.to);
      this.notice(link.from, `Paused the pipe to ${to?.label ?? 'the other chat'} after ${MAX_PIPE_FORWARDS} messages, so the agents can't keep each other going forever. Pipe it again to continue.`);
    }
  }

  // ---- Helpers ----

  private chat(chatId: string): ChatView | undefined {
    return this.host.state.chats.find((c) => c.id === chatId);
  }

  private require(chatId: string): ChatView {
    const chat = this.chat(chatId);
    if (!chat) throw new Error(`Unknown chat ${chatId}`);
    return chat;
  }

  private linkBetween(from: string, to: string, kind?: ChatLink['kind']): ChatLink | undefined {
    return this.host.state.links.find((l) => l.from === from && l.to === to && (!kind || l.kind === kind));
  }

  private addLink(kind: ChatLink['kind'], from: string, to: string, by: 'user' | 'agent', count: number): ChatLink {
    const link: ChatLink = { id: this.host.id('link'), kind, from, to, by, createdAt: Date.now(), active: true, count };
    this.host.dispatch({ t: 'link', link });
    return link;
  }

  private count(linkId: string): void {
    const link = this.host.state.links.find((l) => l.id === linkId);
    if (link) this.host.dispatch({ t: 'linkPatch', linkId, patch: { count: link.count + 1 } });
  }

  /** The same message in both chats, each naming the other. */
  private carry(link: ChatLink, source: ChatView, target: ChatView, sourceRole: LinkItem['role'], targetRole: LinkItem['role'], text: string, by: 'user' | 'agent'): void {
    this.items(source.id, [this.linkItem(link, target, sourceRole, text, by)]);
    this.items(target.id, [this.linkItem(link, source, targetRole, text, by)]);
    if (link.kind !== 'handoff') this.count(link.id);
  }

  private linkItem(link: ChatLink, other: ChatView, role: LinkItem['role'], text: string, by: 'user' | 'agent'): LinkItem {
    return { kind: 'link', linkId: link.id, role, chatId: other.id, agent: other.agent, label: other.label, text, by };
  }

  private items(chatId: string, items: LinkItem[]): void {
    this.host.dispatch({ t: 'items', chatId, items, at: Date.now() });
  }

  private notice(chatId: string, text: string): void {
    this.host.dispatch({ t: 'items', chatId, items: [{ kind: 'notice', tone: 'info', text }], at: Date.now() });
  }
}

/** Whether active pipes already lead from `from` to `to`; a new pipe the other way would close a loop. */
export function pipeReaches(links: readonly ChatLink[], from: string, to: string): boolean {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const at = queue.shift()!;
    if (at === to) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const l of links) if (l.kind === 'pipe' && l.active && l.from === at) queue.push(l.to);
  }
  return false;
}
