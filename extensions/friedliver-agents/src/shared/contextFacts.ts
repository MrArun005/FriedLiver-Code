// The context rail's facts (COMPONENTS.md v2 §2.34): one source for what a chat page's right column says
// (who, when it started, what it cost, how long, the files it changed and read, where Rewind can go).
import type { ChatView } from './model';
import { clip, relativePath, shortDuration } from './view';

export interface RewindPoint {
  checkpoint: string;
  label: string;
  at?: number;
}

export interface ChatFacts {
  started: number;
  /** "$0.62", or undefined when the agent reported no cost. */
  cost?: string;
  /** "54k tokens", or undefined when the agent reported none. */
  tokens?: string;
  /** "6m 12s" from the start to the last activity (to now while it works). */
  time: string;
  changed: string[];
  read: string[];
  rewind: RewindPoint[];
}

/** 950 → "950", 54_210 → "54k", 1_250_000 → "1.3M". */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function chatFacts(chat: ChatView, now: number): ChatFacts {
  const log = chat.usageLog ?? [];
  const costs = log.flatMap((u) => (u.cost ? [u.cost] : []));
  const currency = costs[0]?.currency;
  const total = costs.filter((c) => c.currency === currency).reduce((n, c) => n + c.amount, 0);
  const tokens = log.reduce((n, u) => n + u.input + u.output + u.cacheRead + u.cacheWrite, 0);
  const money = currency ? new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(total) : undefined;
  const end = chat.busy ? now : Math.max(chat.lastActivity, chat.createdAt);
  const read = new Set<string>();
  for (const i of chat.items) if (i.kind === 'tool' && i.toolKind === 'read') for (const l of i.locations) read.add(relativePath(chat.cwd, l));
  const rewind: RewindPoint[] = [];
  for (const i of chat.items) if (i.kind === 'user' && i.checkpoint) rewind.push({ checkpoint: i.checkpoint, label: `Before “${clip(i.text.trim().split('\n')[0], 28)}”`, at: i.at });
  return {
    started: chat.createdAt,
    cost: money,
    tokens: tokens ? `${compactCount(tokens)} tokens` : undefined,
    time: shortDuration(Math.max(0, end - chat.createdAt)),
    changed: [...chat.files],
    read: [...read],
    rewind: rewind.reverse(),
  };
}
