// Which waiting card the decision keys (1–9, Ctrl/Cmd+Enter, Ctrl/Cmd+Shift+Backspace) act on, per chat.
// The target is the card marked on screen. It changes only when you click or focus another card, or
// when the marked one is answered (then the oldest still waiting); a request that arrives later never
// takes it over. Every change starts a short grace period in which the keys do nothing, so a key
// already on its way can't approve a card you haven't seen yet.

/** How long the keys wait after the target changes. */
export const KEY_GRACE_MS = 600;

export class DecisionTargets {
  private readonly chosen = new Map<string, { id: string; at: number }>();

  /** The target among `waiting` (ids, oldest first), keeping the one already marked while it waits. */
  target(chatId: string, waiting: readonly string[], now: number): { id: string; at: number } | undefined {
    const current = this.chosen.get(chatId);
    if (current && waiting.includes(current.id)) return current;
    if (!waiting.length) {
      this.chosen.delete(chatId);
      return undefined;
    }
    const next = { id: waiting[0], at: now };
    this.chosen.set(chatId, next);
    return next;
  }

  /** You clicked or focused a card; only one waiting in this chat (`waiting`) becomes the target. */
  choose(chatId: string, id: string, waiting: readonly string[], now: number): void {
    if (this.chosen.get(chatId)?.id === id || !waiting.includes(id)) return;
    this.chosen.set(chatId, { id, at: now });
  }

  /** Whether the keys act now: something waits, and the target has been marked for the grace period. */
  armed(chatId: string, waiting: readonly string[], now: number): boolean {
    const t = this.target(chatId, waiting, now);
    return !!t && now - t.at >= KEY_GRACE_MS;
  }
}
