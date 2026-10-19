// Chats for tests and the token bench.
import type { ChatView, Item } from '../../src/shared/model';

export const chat = (id: string, over: Partial<ChatView> = {}): ChatView => ({
  id, agent: 'demo', label: 'Demo', title: 'Add rate limiting', cwd: '/w', createdAt: 0, busy: false, changedFiles: 0, items: [], depth: 0, files: [], lastActivity: 0, turns: 0, ...over,
});

/** A long working session: 40 turns of instructions and long replies. */
export function longChat(id = 'chat-1'): ChatView {
  const items: Item[] = [];
  for (let t = 0; t < 40; t++) {
    items.push({ kind: 'user', text: t === 0 ? 'Add rate limiting to the public API: 100 requests a minute per key, 429 with Retry-After.' : `Turn ${t}: also handle case ${t}, and keep the tests green.` } as Item);
    items.push({ kind: 'agent', text: `Done with step ${t}. ${'I looked at the middleware, the config loader and the tests, then changed the limiter so that the window slides correctly. '.repeat(12)}` } as Item);
  }
  items.push({ kind: 'agent', text: 'Everything passes except the Redis-backed store.\nShould the limit be per key or per IP when no key is sent?\nDo you want the 429 body in JSON?' } as Item);
  return chat(id, { items, files: ['src/limiter.ts', 'src/config.ts', 'test/limiter.test.ts'] });
}

