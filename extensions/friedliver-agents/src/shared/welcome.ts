// The Welcome page's one sentence of state and its three lists (COMPONENTS.md v2 §2.38), from the chats:
// one source, so the page never disagrees with the board.
import type { ChatView } from './model';
import { needsYou, statusOf } from './view';

export interface WelcomeSummary {
  needs: ChatView[];
  working: ChatView[];
  /** Finished since local midnight, newest first. */
  done: ChatView[];
  /** "Two agents are working and three things need you. 5 tasks done today, $4.20 spent." */
  sentence: string;
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const count = (n: number, one: string, many: string) => `${n < WORDS.length ? WORDS[n] : n} ${n === 1 ? one : many}`;

export function welcomeSummary(chats: ChatView[], now: number): WelcomeSummary {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const since = midnight.getTime();
  const needs = chats.filter(needsYou);
  const working = chats.filter((c) => c.busy && !needsYou(c));
  const done = chats.filter((c) => statusOf(c) === 'done' && c.lastActivity >= since).sort((a, b) => b.lastActivity - a.lastActivity);
  const costs = chats.flatMap((c) => (c.usageLog ?? []).filter((u) => u.at >= since && u.cost).map((u) => u.cost!));
  const currency = costs[0]?.currency;
  const spent = currency ? costs.filter((c) => c.currency === currency).reduce((n, c) => n + c.amount, 0) : 0;
  const parts: string[] = [];
  if (working.length || needs.length) {
    const w = working.length ? `${count(working.length, 'agent is', 'agents are')} working` : '';
    const n = needs.length ? `${count(needs.length, 'thing needs', 'things need')} you` : '';
    const s = [w, n].filter(Boolean).join(' and ');
    parts.push(`${s.charAt(0).toUpperCase()}${s.slice(1)}.`);
  } else parts.push(chats.length ? 'Your agents are idle.' : 'Describe a task and an agent starts on it.');
  const tail = [done.length ? `${done.length} task${done.length === 1 ? '' : 's'} done today` : '', currency && spent > 0 ? `${new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(spent)} spent` : ''].filter(Boolean);
  if (tail.length) parts.push(`${tail.join(', ')}.`);
  return { needs, working, done, sentence: parts.join(' ') };
}
