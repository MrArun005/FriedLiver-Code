// What a paired phone may do, through the same core calls the desktop makes.
// Only chats the phone may see; only requests waiting in them; and anything
// that keeps allowing (Auto, "Always allow", an agent's "don't ask again")
// waits for the user's OK on the Mac first.
import type { AgentCore } from '../host/core';
import type { AgentKey, ChatView, Item } from '../shared/model';
import { ESCALATING } from '../shared/tools';
import { phoneChats } from './phoneView';
import type { RemoteAction } from './protocol';

export interface RemoteActionsDeps {
  core: Pick<AgentCore, 'snapshot' | 'send' | 'cancel' | 'answerPermission' | 'decideCommand' | 'answerQuestion' | 'answerBridge' | 'allowAlways' | 'setApproval' | 'createChat'>;
  folders(): string[];
  agents(): AgentKey[];
  /** The desktop's own review path (the diff editor's Accept / Reject). */
  reviews: { accept(reviewId: string): boolean; reject(reviewId: string): boolean };
  /** The user's OK on the Mac, for anything that keeps allowing. */
  confirm(ask: { title: string; detail: string; button: string }): Promise<boolean>;
  /** Chats the phone must not see (an inline edit's). */
  hidden?(chatId: string): boolean;
  error?(err: unknown): void;
}

export type ActionResult = { ok: true; chatId?: string } | { ok: false; error: string };

const refused = (error: string): ActionResult => ({ ok: false, error });

export class RemoteActions {
  constructor(private readonly deps: RemoteActionsDeps) {}

  private visible(): ChatView[] {
    return phoneChats(this.deps.core.snapshot, (id) => this.deps.hidden?.(id) ?? false);
  }

  private chat(chatId: string): ChatView | undefined {
    return this.visible().find((c) => c.id === chatId);
  }

  /** The waiting request with this id, in a chat the phone may see. */
  private waiting<K extends Item['kind']>(kind: K, id: string): { chat: ChatView; item: Extract<Item, { kind: K }> } | undefined {
    for (const chat of this.visible()) {
      for (const i of chat.items) {
        if (i.kind !== kind) continue;
        const it = i as Extract<Item, { kind: K }>;
        const match =
          (it.kind === 'permission' && it.requestId === id && !it.answer) ||
          (it.kind === 'command' && it.commandId === id && it.state === 'awaiting') ||
          (it.kind === 'question' && it.requestId === id && it.state === 'awaiting') ||
          (it.kind === 'review' && it.reviewId === id && it.state === 'pending') ||
          (it.kind === 'bridge' && it.requestId === id && it.state === 'awaiting');
        if (match) return { chat, item: it };
      }
    }
    return undefined;
  }

  async run(a: RemoteAction): Promise<ActionResult> {
    const { core } = this.deps;
    switch (a.type) {
      case 'send': {
        if (!this.chat(a.chatId)) return refused('No such chat.');
        void core.send(a.chatId, a.text).catch((err: unknown) => this.deps.error?.(err));
        return { ok: true };
      }
      case 'stop':
        if (!this.chat(a.chatId)) return refused('No such chat.');
        await core.cancel(a.chatId);
        return { ok: true };
      case 'permission': {
        const found = this.waiting('permission', a.requestId);
        if (!found) return refused('That request is no longer waiting.');
        const option = a.optionId === null ? undefined : found.item.options.find((o) => o.optionId === a.optionId);
        if (a.optionId !== null && !option) return refused('The agent did not offer that answer.');
        if (option && option.kind.startsWith('allow') && (option.kind === 'allow_always' || ESCALATING.test(option.name))) {
          const ok = await this.deps.confirm({
            title: `Answer “${option.name}” for ${found.chat.label}?`,
            detail: `${found.item.title}. This answer keeps allowing, or changes how ${found.chat.label} asks from now on.`,
            button: 'Allow',
          });
          if (!ok) return refused('Not confirmed on the Mac.');
        }
        core.answerPermission(a.requestId, a.optionId);
        return { ok: true };
      }
      case 'command':
        if (!this.waiting('command', a.commandId)) return refused('That command is no longer waiting.');
        core.decideCommand(a.commandId, a.approve);
        return { ok: true };
      case 'answerQuestion':
        if (!this.waiting('question', a.requestId)) return refused('That question is no longer waiting.');
        core.answerQuestion(a.requestId, a.action, a.values);
        return { ok: true };
      case 'review': {
        if (!this.waiting('review', a.reviewId)) return refused('That edit is no longer waiting.');
        const done = a.action === 'accept' ? this.deps.reviews.accept(a.reviewId) : this.deps.reviews.reject(a.reviewId);
        return done ? { ok: true } : refused('That edit is no longer waiting.');
      }
      case 'bridge': {
        const found = this.waiting('bridge', a.requestId);
        if (!found) return refused('That request is no longer waiting.');
        if (a.answer === 'allowAlways') {
          if (!found.item.always) return refused('Always allow is not offered here.');
          const ok = await this.deps.confirm({ title: `Always allow ${found.item.always}?`, detail: `${found.chat.label}'s request, and the same again later, without asking.`, button: 'Always allow' });
          if (!ok) return refused('Not confirmed on the Mac.');
        }
        core.answerBridge(a.requestId, a.answer);
        return { ok: true };
      }
      case 'allowAlways': {
        const id = a.requestId ?? a.commandId!;
        if (!(a.requestId ? this.waiting('permission', id) : this.waiting('command', id))) return refused('That request is no longer waiting.');
        await core.allowAlways(a.requestId ? { requestId: a.requestId } : { commandId: a.commandId! }, a.grant, 'remote');
        return { ok: true };
      }
      case 'approval':
        if (!this.chat(a.chatId)) return refused('No such chat.');
        await core.setApproval(a.chatId, a.level, 'remote');
        return { ok: true };
      case 'newChat': {
        if (!this.deps.agents().includes(a.agent)) return refused('That agent is not available.');
        if (!this.deps.folders().includes(a.folder)) return refused('Pick one of the window’s folders.');
        const chat = await core.createChat(a.agent, { cwd: a.folder, ...(a.text.trim() ? { title: a.text } : {}) });
        if (a.text.trim()) void core.send(chat.id, a.text).catch((err: unknown) => this.deps.error?.(err));
        return { ok: true, chatId: chat.id };
      }
    }
  }
}
