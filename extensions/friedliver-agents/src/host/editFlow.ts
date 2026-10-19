// Edit with Agent, without the editor: which chat an edit goes to, and what
// came of its turn. editor.ts adds the input box, progress and decorations.
import { lastReply, type AgentKey, type ChatView, type CodeRef, type Item } from '../shared/model';
import type { AgentCore } from './core';

/**
 * The chat each agent does editor edits in. The next edit with that agent
 * continues there while it is idle, so the agent keeps what it learned about
 * the code; a busy, archived or closed one gets a new chat.
 */
export class EditChats {
  private readonly last = new Map<AgentKey, string>();

  constructor(private readonly core: AgentCore) {}

  async chatFor(agent: AgentKey, title: string): Promise<ChatView> {
    const id = this.last.get(agent);
    const chat = id ? this.core.chat(id) : undefined;
    if (chat && chat.agent === agent && !chat.busy && !chat.archived && !chat.branch) return chat;
    const created = await this.core.createChat(agent, { title });
    this.last.set(agent, created.id);
    return created;
  }

  /** Whether `chatId` is one of the edit chats. */
  has(chatId: string): boolean {
    return [...this.last.values()].includes(chatId);
  }
}

export interface EditMessage {
  instruction: string;
  /** The file, the lines and the code (editorPrompt.ts). */
  context: string;
  ref: CodeRef;
}

export interface EditOutcome {
  chatId: string;
  /** What became of each edit the agent proposed in this turn. */
  reviews: { reviewId: string; path: string; state: 'pending' | 'accepted' | 'rejected' }[];
  /** What the agent said in the turn. */
  reply: string;
  /** Why the turn failed (not installed, not signed in, an error), if it did. */
  error?: string;
}

/** Sends one edit request and resolves when the agent's turn ends, with what it did. */
export async function runEdit(core: AgentCore, chat: ChatView, message: EditMessage): Promise<EditOutcome> {
  await core.send(chat.id, message.instruction, [], { context: message.context, refs: [message.ref], title: message.instruction });
  const after = core.chat(chat.id);
  if (!after) return { chatId: chat.id, reviews: [], reply: '', error: 'The chat was closed.' };
  const turn = itemsOfLastTurn(after.items);
  const error = turn.filter((i) => i.kind === 'notice' && i.tone === 'error').at(-1);
  return {
    chatId: chat.id,
    reviews: turn.flatMap((i) => (i.kind === 'review' ? [{ reviewId: i.reviewId, path: i.path, state: i.state }] : [])),
    reply: lastReply(after),
    error: error?.kind === 'notice' ? error.text : undefined,
  };
}

/** Items after the last message the user sent: the turn that answered it. */
function itemsOfLastTurn(items: Item[]): Item[] {
  const at = items.map((i) => i.kind).lastIndexOf('user');
  return items.slice(at + 1);
}
