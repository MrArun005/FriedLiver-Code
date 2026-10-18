// What a paired phone may do, through the same core calls the desktop makes.
// Only chats the phone may see; only requests waiting in them; and anything
// that keeps allowing (Auto, "Always allow", an agent's "don't ask again")
// waits for the user's OK on the Mac first.
import type { AgentCore } from '../host/core';
import { parseMention, waitingItems, type AgentKey, type ChatView, type Item } from '../shared/model';
import { approvalOf } from '../shared/approval';
import { agentName, chatRef } from '../shared/names';
import { primaryOption } from '../shared/tools';
import { commandRisk, requestRisk } from './risk';
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
  /** Whether the device is still paired: an OK on the Mac that arrives after a revoke does nothing. */
  paired?(deviceId: string): boolean;
  /** Chats the phone must not see (an inline edit's). */
  hidden?(chatId: string): boolean;
  error?(err: unknown): void;
}

export type ActionResult = { ok: true; chatId?: string } | { ok: false; error: string };

const idOf = (i: Item) => (i.kind === 'permission' || i.kind === 'question' || i.kind === 'bridge' ? i.requestId : i.kind === 'command' ? i.commandId : i.kind === 'review' ? i.reviewId : undefined);
/** Longest command the phone shows whole; anything longer is approved on the Mac. */
export const MAX_PHONE_COMMAND = 4000;
/** Characters that could make a command read differently from what runs: controls (but tab and newline), bidi and zero-width. */
export const DISGUISE = /(?![\t\n])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** The phone shows this command whole and as it runs, so approving it there is informed. */
export const plainCommand = (line: string) => line.length <= MAX_PHONE_COMMAND && !DISGUISE.test(line);
/** Slash commands that only show information: they go from a phone without asking. */
const HARMLESS_SLASH = new Set(['help', 'cost', 'status', 'usage', 'context', 'about', 'stats']);
/** Slash commands that change permissions, approvals, modes or settings: never from a phone. */
const SETTINGS_SLASH = /^(permissions?|allowed-?tools|approvals?|mode|modes|yolo|config|settings|sandbox|hooks|mcp|login|logout|auth|privacy|trust|dangerously.*|bypass.*|full-?access|auto(-?accept)?|accept-?edits|plan|agents|ide|terminal-setup|add-dir|directory|dir)$/i;

/** The slash command a message would run (after any @mention), or undefined. */
export function slashCommand(text: string): string | undefined {
  const body = parseMention(text)?.text ?? text;
  return /^\s*\/([^\s/]+)/.exec(body)?.[1].toLowerCase();
}

const CHANGED = 'The command changed. Review it again.';

const ON_MAC = 'Approve this one on your Mac: the phone can’t show the whole command plainly.';

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
      const item = waitingItems(chat.items).find((i) => i.kind === kind && idOf(i) === id);
      if (item) return { chat, item: item as Extract<Item, { kind: K }> };
    }
    return undefined;
  }

  /**
   * A message from the phone that runs one of the agent's own slash commands: information-only ones go,
   * ones that change permissions or settings are refused, anything else (advertised or not) needs the
   * Mac's OK naming the command. Undefined: go ahead.
   */
  private async slashAllowed(text: string, chat: Pick<ChatView, 'agent' | 'title' | 'session'>, confirm: (ask: { title: string; detail: string; button: string }) => Promise<boolean>): Promise<ActionResult | undefined> {
    const name = slashCommand(text);
    if (!name || HARMLESS_SLASH.has(name)) return undefined;
    if (SETTINGS_SLASH.test(name)) return refused(`Run /${name} on your Mac: from a phone, commands that change permissions or settings are refused.`);
    const known = chat.session?.commands.some((c) => c.name.replace(/^\//, '').toLowerCase() === name);
    const ok = await confirm({
      title: `Send /${name} to ${chatRef(chat)}?`,
      detail: known ? `It is one of ${agentName(chat.agent)}'s own commands and may change the chat or its settings.` : `${agentName(chat.agent)} didn't list this command; it may still run one.`,
      button: 'Send',
    });
    return ok ? undefined : refused('Not confirmed on the Mac.');
  }

  /** `device`: the paired phone, named on the Mac when it asks for an OK. */
  async run(a: RemoteAction, device: { id: string; name: string }): Promise<ActionResult> {
    const { core } = this.deps;
    const stillPaired = () => this.deps.paired?.(device.id) ?? true;
    const via = { device: device.name, valid: stillPaired };
    const confirm = async (ask: { title: string; detail: string; button: string }) =>
      (await this.deps.confirm({ ...ask, title: `Phone “${device.name}” asks: ${ask.title}` })) && stillPaired();
    switch (a.type) {
      case 'send': {
        const chat = this.chat(a.chatId);
        if (!chat) return refused('No such chat.');
        const slash = await this.slashAllowed(a.text, chat, confirm);
        if (slash) return slash;
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
        const allows = option?.kind.startsWith('allow');
        const line = found.item.detail?.command?.line;
        if (allows && line !== undefined && !plainCommand(line)) return refused(ON_MAC);
        if (allows && option !== primaryOption(found.item.options) && requestRisk(found.item.detail).level === 'careful') return refused('This one can only be allowed once.');
        // The phone allows only the command it showed: the same text, whole.
        if (allows && line !== undefined && a.shown !== line) return refused(CHANGED);
        // Only the plain one-time yes goes ahead: every other allow keeps allowing or changes how the agent asks.
        if (option && allows && option !== primaryOption(found.item.options)) {
          const ok = await confirm({
            title: `Answer “${option.name}” in ${chatRef(found.chat)}?`,
            detail: `${found.item.title}. This answer keeps allowing, or changes how ${agentName(found.chat.agent)} asks from now on.`,
            button: 'Allow',
          });
          if (!ok) return refused('Not confirmed on the Mac.');
        }
        core.answerPermission(a.requestId, a.optionId);
        return { ok: true };
      }
      case 'command': {
        const found = this.waiting('command', a.commandId);
        if (!found) return refused('That command is no longer waiting.');
        if (a.approve && !plainCommand(found.item.commandLine)) return refused(ON_MAC);
        if (a.approve && a.shown !== found.item.commandLine) return refused(CHANGED);
        core.decideCommand(a.commandId, a.approve);
        return { ok: true };
      }
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
        if (a.answer === 'allowAlways' && !found.item.always) return refused('Always allow is not offered here.');
        // What the desktop card locks (careful, or asked every time) is allowed once from the phone too.
        const locked = approvalOf(found.item, found.chat).locked;
        if ((a.answer === 'allowChat' && locked.chat) || (a.answer === 'allowAlways' && locked.always)) return refused('This one can only be allowed once.');
        if (a.answer === 'allowAlways' || a.answer === 'allowChat') {
          const ok = await confirm(
            a.answer === 'allowAlways'
              ? { title: `Always allow ${found.item.always}?`, detail: `The request in ${chatRef(found.chat)}, and the same again later, without asking.`, button: 'Always allow' }
              : { title: `Allow this for the rest of ${chatRef(found.chat)}?`, detail: 'Requests like this one in that chat would go ahead without asking.', button: 'Allow for this chat' },
          );
          if (!ok) return refused('Not confirmed on the Mac.');
        }
        core.answerBridge(a.requestId, a.answer);
        return { ok: true };
      }
      case 'allowAlways': {
        const id = a.requestId ?? a.commandId!;
        const found = a.requestId ? this.waiting('permission', id) : this.waiting('command', id);
        if (!found) return refused('That request is no longer waiting.');
        const line = found.item.kind === 'command' ? found.item.commandLine : found.item.kind === 'permission' ? found.item.detail?.command?.line : undefined;
        if (line !== undefined && !plainCommand(line)) return refused(ON_MAC);
        const risk = found.item.kind === 'command' ? commandRisk(found.item.commandLine) : found.item.kind === 'permission' ? requestRisk(found.item.detail) : undefined;
        if (risk?.level === 'careful') return refused('This one can only be allowed once.');
        if (line !== undefined && a.shown !== line) return refused(CHANGED);
        await core.allowAlways(a.requestId ? { requestId: a.requestId } : { commandId: a.commandId! }, a.grant, via);
        return { ok: true };
      }
      case 'approval':
        if (!this.chat(a.chatId)) return refused('No such chat.');
        await core.setApproval(a.chatId, a.level, via);
        return { ok: true };
      case 'newChat': {
        if (!this.deps.agents().includes(a.agent)) return refused('That agent is not available.');
        if (!this.deps.folders().includes(a.folder)) return refused('Pick one of the window’s folders.');
        const slash = await this.slashAllowed(a.text, { agent: a.agent, title: 'a new chat' } as ChatView, confirm);
        if (slash) return slash;
        const chat = await core.createChat(a.agent, { cwd: a.folder, ...(a.text.trim() ? { title: a.text } : {}) });
        if (a.text.trim()) void core.send(chat.id, a.text).catch((err: unknown) => this.deps.error?.(err));
        return { ok: true, chatId: chat.id };
      }
    }
  }
}
