import type { ChatStatus } from '../shared/model';

/** What ChatTabs needs of an editor tab (a vscode.WebviewPanel). */
export interface TabPanel {
  reveal(viewColumn?: number, preserveFocus?: boolean): void;
  dispose(): void;
}

/**
 * Chats in the editor area: one editor tab per chat, in the editor's own tab row. Opening a chat
 * reveals its tab, or makes one; a chat never gets two (a duplicate that comes back on reload is closed).
 */
export class ChatTabs<P extends TabPanel> {
  private readonly tabs = new Map<string, P>();

  /** `create` makes the tab and hands it back through `adopt`. */
  constructor(private readonly create: (chatId: string, viewColumn?: number, preserveFocus?: boolean) => void) {}

  get size(): number {
    return this.tabs.size;
  }

  get(chatId: string): P | undefined {
    return this.tabs.get(chatId);
  }

  all(): P[] {
    return [...this.tabs.values()];
  }

  open(chatId: string, viewColumn?: number, preserveFocus?: boolean): void {
    const tab = this.tabs.get(chatId);
    if (tab) tab.reveal(viewColumn, preserveFocus);
    else this.create(chatId, viewColumn, preserveFocus);
  }

  /** A new or restored tab for this chat; false (and the tab closed) when the chat already has one. */
  adopt(chatId: string, panel: P): boolean {
    const held = this.tabs.get(chatId);
    if (held && held !== panel) {
      panel.dispose();
      return false;
    }
    this.tabs.set(chatId, panel);
    return true;
  }

  closed(chatId: string, panel: P): void {
    if (this.tabs.get(chatId) === panel) this.tabs.delete(chatId);
  }
}

/**
 * The chats a restored chat tab holds, from the state its webview kept: its own chat; or, from a
 * chat tab of before (one tab, its own strip of chats), every chat its strip had open.
 */
export function restoredChats(state: unknown): string[] {
  const s = (state ?? {}) as { chat?: unknown; openTabs?: unknown };
  if (typeof s.chat === 'string' && s.chat) return [s.chat];
  return Array.isArray(s.openTabs) ? s.openTabs.filter((id): id is string => typeof id === 'string' && !!id) : [];
}

/** A status mark before a chat tab's title, standing in for the strip's status dot: working, waiting on you, failed. */
const STATUS_MARK: Partial<Record<ChatStatus, string>> = { working: '◌ ', 'needs-you': '● ', error: '⚠ ' };

export function tabTitle(title: string, status?: ChatStatus): string {
  return `${(status && STATUS_MARK[status]) ?? ''}${title}`;
}
