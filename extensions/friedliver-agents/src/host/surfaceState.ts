import { waitingItems, type Action, type AppState, type ChatView, type ImageItem } from '../shared/model';

/** The kinds of webview: the chat (side view or center panel), the Agent Manager, the Images view, the Welcome page. */
export type SurfaceKind = 'chat' | 'tasks' | 'images' | 'welcome';

/**
 * Images are data: URIs of up to 8 MB, and each webview holds its own copy
 * of what it is sent. The Images view and the Agent Manager (its Images tab)
 * show them all; a chat only the ones you attached (in your messages). Image
 * files steps read are not among them: the gallery asks for their thumbnails.
 */
export function showsImage(kind: SurfaceKind, image: ImageItem): boolean {
  return kind === 'welcome' ? false : kind !== 'chat' || image.from === 'you';
}

/** The state as a surface of this kind gets it. */
export function stateFor(kind: SurfaceKind, state: AppState): AppState {
  if (kind === 'tasks' || kind === 'images' || state.images.every((i) => showsImage(kind, i))) return state;
  return { ...state, images: state.images.filter((i) => showsImage(kind, i)) };
}

/** The actions a surface of this kind gets: the same, less images it doesn't show. Folded in order, they keep it at stateFor(kind, host state). */
export function actionsFor(kind: SurfaceKind, actions: Action[]): Action[] {
  if (kind === 'tasks' || kind === 'images') return actions;
  let out: Action[] | undefined;
  actions.forEach((a, n) => {
    const next = a.t === 'image' ? (showsImage(kind, a.image) ? a : null) : a.t === 'restore' ? { ...a, state: stateFor(kind, a.state) } : a;
    if (next === a) {
      out?.push(a);
      return;
    }
    out ??= actions.slice(0, n);
    if (next) out.push(next);
  });
  return out ?? actions;
}

/**
 * Whether a webview puts this chat in front of the user: a visible chat view
 * showing it, or the Agent Manager, which shows every chat. The side bar's
 * chat list shows none, though it remembers which one is selected.
 */
export function showsChat(s: { kind: SurfaceKind; list?: boolean; selected?: string; visible(): boolean }, chatId: string, lastSelected?: string): boolean {
  return s.visible() && (s.kind === 'tasks' || (s.kind === 'chat' && !s.list && (s.selected ?? lastSelected) === chatId));
}

/** Items a chat tab keeps of every chat but its own: enough for their status, titles and the strip. */
export const OTHER_CHAT_ITEMS = 30;

/**
 * A chat's own editor tab draws one chat. It used to be sent every chat's whole transcript (up to MAX_ITEMS
 * each: megabytes, serialised, copied to the webview and parsed again on every show), only to read the other
 * chats' titles, files and status. They come trimmed: every decision waiting (needs-you) and the last
 * OTHER_CHAT_ITEMS items (the last error, whether the agent has answered), in their order.
 */
export function slimFor(state: AppState, chatId: string): AppState {
  if (state.chats.every((c) => c.id === chatId || c.items.length <= OTHER_CHAT_ITEMS)) return state;
  return { ...state, chats: state.chats.map((c) => (c.id === chatId ? c : trimmed(c))) };
}

function trimmed(chat: ChatView): ChatView {
  if (chat.items.length <= OTHER_CHAT_ITEMS) return chat;
  const waiting = new Set(waitingItems(chat.items));
  const from = chat.items.length - OTHER_CHAT_ITEMS;
  return { ...chat, items: chat.items.filter((item, n) => n >= from || waiting.has(item)) };
}

/** The same for actions: a full `restore` (a reload of the whole state) is trimmed like the snapshot. */
export function slimActions(actions: Action[], chatId: string): Action[] {
  return actions.some((a) => a.t === 'restore') ? actions.map((a) => (a.t === 'restore' ? { ...a, state: slimFor(a.state, chatId) } : a)) : actions;
}
