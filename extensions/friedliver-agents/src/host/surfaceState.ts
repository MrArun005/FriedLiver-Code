import type { Action, AppState, ImageItem } from '../shared/model';

/** The kinds of webview: the chat (side view or center panel), the Agent Manager, the Images view. */
export type SurfaceKind = 'chat' | 'tasks' | 'images';

/**
 * Images are data: URIs of up to 8 MB, and each webview holds its own copy
 * of what it is sent. Only the Images view shows them all; a chat shows only
 * the ones you attached (in your messages), and the Agent Manager none.
 */
export function showsImage(kind: SurfaceKind, image: ImageItem): boolean {
  return kind === 'images' || (kind === 'chat' && image.from === 'you');
}

/** The state as a surface of this kind gets it. */
export function stateFor(kind: SurfaceKind, state: AppState): AppState {
  if (kind === 'images' || state.images.every((i) => showsImage(kind, i))) return state;
  return { ...state, images: state.images.filter((i) => showsImage(kind, i)) };
}

/** The actions a surface of this kind gets: the same, less images it doesn't show. Folded in order, they keep it at stateFor(kind, host state). */
export function actionsFor(kind: SurfaceKind, actions: Action[]): Action[] {
  if (kind === 'images') return actions;
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
