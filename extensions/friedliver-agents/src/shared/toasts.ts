// Error notices as toasts: a failed turn, a refused option, a model the account can't use show for a
// moment and go; the transcript keeps them (and the host log), so "N errors" in the chat's menu reopens them.
// A notice that blocks work on a decision (sign in) stays inline.
import type { Item } from './model';

export type NoticeItem = Extract<Item, { kind: 'notice' }>;

/** How long an error toast stays, unless hovered or focused. */
export const TOAST_SECONDS = 8;
/** At most this many toasts at once; older ones stay reachable from "N errors". */
export const MAX_TOASTS = 3;

const BLOCKING = new Set(['signIn', 'apiKey', 'accounts']);

/** An error or warning notice that toasts instead of sitting in the transcript. */
export const isToastNotice = (i: Item): i is NoticeItem => i.kind === 'notice' && i.tone === 'error' && !i.actions?.some((a) => BLOCKING.has(a.do));

/** The toasts after `incoming` arrive: newest last, each once, at most MAX_TOASTS. */
export function addToasts<T>(shown: T[], incoming: T[]): T[] {
  return [...shown.filter((t) => !incoming.includes(t)), ...incoming].slice(-MAX_TOASTS);
}

/** Calls `done` after `seconds`; paused, it keeps the time left until resumed. */
export function dismissTimer(seconds: number, done: () => void) {
  let left = seconds * 1000;
  let started = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pause = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    left -= Date.now() - started;
  };
  const resume = () => {
    if (timer !== undefined) return;
    started = Date.now();
    timer = setTimeout(done, Math.max(0, left));
  };
  resume();
  return { pause, resume, clear: pause };
}
