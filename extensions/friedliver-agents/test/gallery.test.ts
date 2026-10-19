import { describe, expect, it } from 'vitest';
import { MAX_GALLERY, bytesText, collectGallery, doneScope, filterGallery, isOutside, sourceCounts, type OutsideImages } from '../src/shared/gallery';
import { EMPTY_STATE, type AppState, type ChatView, type ImageItem, type Item } from '../src/shared/model';

type Tool = Extract<Item, { kind: 'tool' }>;
const tool = (id: string, file: string, over: Partial<Tool> = {}): Tool => ({ kind: 'tool', id, title: 'Read', locations: [file], ...over });
const chat = (id: string, items: Item[], over: Partial<ChatView> = {}): ChatView =>
  ({ id, agent: 'claude', label: 'Claude', title: `Topic ${id}`, cwd: '/w', createdAt: 1000, busy: false, changedFiles: 0, items, depth: 0, files: [], lastActivity: 9000, turns: 1, ...over }) as ChatView;

const img = (id: string, over: Partial<ImageItem> = {}): ImageItem => ({ id, src: 'data:image/png;base64,AA==', title: id, from: 'you', ...over });

function state(): AppState {
  return {
    ...EMPTY_STATE,
    images: [img('att-1', { title: 'mock.png' }), img('tool-9', { from: 'agent', chatId: 'b', stepId: 's9', title: 'Chart', at: 5000 }), img('/w/old.png', { from: 'agent' })],
    chats: [
      chat('a', [
        { kind: 'user', text: 'look', images: ['att-1'], at: 2000 },
        tool('s1', '/w/login.png', { startedAt: 2100 }),
        tool('s2', '/w/src/a.ts', { startedAt: 2200 }),
        tool('s3', '/w/login.png', { startedAt: 2300 }),
        { kind: 'agent', text: 'done', at: 3000 },
        tool('s4', '/w/shot.png', { title: 'browser_screenshot', out: [{ t: 'text', text: 'Screenshot of x\nSaved to /w/shot.png. Read it.' }] }),
      ]),
      chat('b', [tool('s5', '/w/chart.png', { toolKind: 'edit', startedAt: 4000 })], { agent: 'codex', title: 'Charts' }),
      chat('c', [{ kind: 'agent', text: 'no images here', at: 100 }]),
    ],
  };
}

const outside: OutsideImages[] = [{ id: 'sess-1', title: 'Fix the board', cwd: '/w', images: [{ path: '/w/board.png', title: 'Board', source: 'screenshot', at: 6000 }, { path: '/w/b2.png', title: 'Board 2', source: 'read', at: 1500 }] }];

describe('the Images view', () => {
  it('collects every chat’s images, each file once per chat, attached ones and tool output too', () => {
    const { images } = collectGallery(state());
    const a = images.filter((i) => i.chatId === 'a');
    expect(a.map((i) => [i.title, i.source, i.at])).toEqual([
      ['Screenshot of x', 'screenshot', 3000],
      ['Login', 'read', 2100],
      ['mock.png', 'attached', 2000],
    ]);
    expect(a.find((i) => i.source === 'read')).toMatchObject({ path: '/w/login.png', stepId: 's1' });
    expect(images.filter((i) => i.chatId === 'b').map((i) => [i.source, i.stepId ?? i.imageId])).toEqual([
      ['created', 's9'],
      ['created', 's5'],
    ]);
    // An old state's path image with no chat stays out: the step shows it.
    expect(images.some((i) => i.imageId === '/w/old.png')).toBe(false);
  });

  it('adds sessions outside FriedLiver, sorts newest first, tabs only for chats with images', () => {
    const { images, chats } = collectGallery(state(), outside);
    expect(images.map((i) => i.at)).toEqual([...images.map((i) => i.at)].sort((x, y) => y - x));
    expect(images[0]).toMatchObject({ chatId: 'claude:sess-1', path: '/w/board.png', source: 'screenshot' });
    expect(images[0].stepId).toBeUndefined();
    expect(chats.map((c) => [c.id, c.title, c.agent, c.count])).toEqual([
      ['claude:sess-1', 'Fix the board', 'claude', 2],
      ['b', 'Charts', 'codex', 2],
      ['a', 'Topic a', 'claude', 3],
    ]);
    expect(chats[0].outside).toBe(true);
    expect(isOutside('claude:sess-1') && !isOutside('a')).toBe(true);
  });

  it('counts follow the state: a new image raises its tab’s count', () => {
    const s = state();
    s.chats[2] = chat('c', [tool('n1', '/w/new.png', { startedAt: 99_000 })]);
    const { chats } = collectGallery(s);
    expect(chats[0]).toMatchObject({ id: 'c', count: 1 });
  });

  it('filters by tab, source and words in the title, file name, chat or agent', () => {
    const { images, chats } = collectGallery(state(), outside);
    const f = (tab: string | undefined, sources: Parameters<typeof filterGallery>[2]['sources'], query: string) => filterGallery(images, chats, { tab, sources, query }).map((i) => i.title);
    expect(f('a', [], '')).toEqual(['Screenshot of x', 'Login', 'mock.png']);
    expect(f(undefined, ['screenshot'], '')).toEqual(['Board', 'Screenshot of x']);
    expect(f(undefined, ['read', 'attached'], '')).toEqual(['Login', 'mock.png', 'Board 2']);
    expect(f(undefined, [], 'codex')).toEqual(['Chart', 'Chart']);
    expect(f(undefined, [], 'LOGIN.png')).toEqual(['Login']);
    expect(f(undefined, [], 'fix board 2')).toEqual(['Board 2']);
    expect(f('b', ['read'], '')).toEqual([]);
    expect(sourceCounts(images)).toEqual({ read: 2, screenshot: 2, attached: 1, created: 2 });
    expect(sourceCounts(images, 'a')).toEqual({ read: 1, screenshot: 1, attached: 1, created: 0 });
  });

  it('shows at most 2,000, the newest', () => {
    const many: OutsideImages[] = [{ id: 'big', title: 'Big', cwd: '/w', images: Array.from({ length: MAX_GALLERY + 50 }, (_, n) => ({ path: `/w/${n}.png`, title: `${n}`, source: 'read' as const, at: n })) }];
    const { images, chats } = collectGallery(EMPTY_STATE, many);
    const shown = filterGallery(images, chats, { sources: [], query: '' });
    expect(shown).toHaveLength(MAX_GALLERY);
    expect(shown[0].title).toBe(`${MAX_GALLERY + 49}`);
    expect(chats[0].count).toBe(MAX_GALLERY + 50);
  });
});

describe('Done looking scope and storage text', () => {
  it('covers one chat or every chat, never pinned images', () => {
    const { images } = collectGallery(state());
    expect(doneScope(images, new Set([images[0].key])).length).toBe(images.length - 1);
    expect(doneScope(images, new Set(), 'a').map((i) => i.key)).toEqual(images.filter((i) => i.chatId === 'a').map((i) => i.key));
  });

  it('writes sizes short', () => {
    expect([0, 300 * 1024, 212 * 1024 ** 2, 1024 ** 3, 1.25 * 1024 ** 3, 12 * 1024 ** 3].map(bytesText)).toEqual(['0 KB', '300 KB', '212 MB', '1 GB', '1.3 GB', '12 GB']);
  });
});
