import { describe, expect, it } from 'vitest';
import { actionsFor, OTHER_CHAT_ITEMS, showsChat, slimActions, slimFor, stateFor, type SurfaceKind } from '../src/host/surfaceState';
import { chatStatus, EMPTY_STATE, reduce, type Action, type AppState, type ChatView, type ImageItem, type Item } from '../src/shared/model';

const image = (id: string, from: ImageItem['from']): ImageItem => ({ id, src: `data:image/png;base64,${id}`, title: id, from });
const start: AppState = { ...EMPTY_STATE, images: [image('a1', 'agent'), image('y1', 'you')] };
const actions: Action[] = [
  { t: 'image', image: image('a2', 'agent') },
  { t: 'title', chatId: 'chat-1', title: 'x' },
  { t: 'image', image: image('y2', 'you') },
  { t: 'restore', state: { ...EMPTY_STATE, images: [image('a3', 'agent'), image('y3', 'you')] } },
  { t: 'image', image: image('a4', 'agent') },
];

describe('what each webview is sent', () => {
  it('sends the Images view and the Agent Manager everything, a chat only your images', () => {
    expect(stateFor('images', start)).toBe(start);
    expect(stateFor('tasks', start)).toBe(start);
    expect(stateFor('chat', start).images.map((i) => i.id)).toEqual(['y1']);
    expect(stateFor('chat', { ...start, images: [image('y1', 'you')] }).images).toHaveLength(1);
    expect(actionsFor('images', actions)).toBe(actions);
    expect(actionsFor('tasks', actions)).toBe(actions);
    expect(actionsFor('chat', actions).map((a) => a.t)).toEqual(['title', 'image', 'restore']);
    const noImages: Action[] = [{ t: 'title', chatId: 'chat-1', title: 'x' }];
    expect(actionsFor('chat', noImages)).toBe(noImages);
  });

  it('keeps each webview at its share of the host state as the actions fold', () => {
    for (const kind of ['chat', 'tasks', 'images'] as SurfaceKind[]) {
      const host = actions.reduce(reduce, start);
      const view = actionsFor(kind, actions).reduce(reduce, stateFor(kind, start));
      expect(view, kind).toEqual(stateFor(kind, host));
    }
  });
});

describe('whether a chat is on screen', () => {
  const surface = (kind: SurfaceKind, over: { list?: boolean; selected?: string; visible?: boolean } = {}) => ({ kind, ...over, visible: () => over.visible ?? true });

  it('counts a visible chat view showing that chat, and the Agent Manager', () => {
    expect(showsChat(surface('chat', { selected: 'chat-1' }), 'chat-1')).toBe(true);
    expect(showsChat(surface('chat'), 'chat-1', 'chat-1')).toBe(true);
    expect(showsChat(surface('tasks'), 'chat-1')).toBe(true);
  });

  it('does not count a hidden view, another chat, or the Images view', () => {
    expect(showsChat(surface('chat', { selected: 'chat-1', visible: false }), 'chat-1')).toBe(false);
    expect(showsChat(surface('chat', { selected: 'chat-2' }), 'chat-1')).toBe(false);
    expect(showsChat(surface('images'), 'chat-1')).toBe(false);
  });

  it('never counts the side bar chat list, which shows no chat (it hid the "finished" notification)', () => {
    expect(showsChat(surface('chat', { list: true, selected: 'chat-1' }), 'chat-1')).toBe(false);
    expect(showsChat(surface('chat', { list: true }), 'chat-1', 'chat-1')).toBe(false);
  });
});

describe("a chat's own tab", () => {
  const chat = (id: string, items: Item[], over: Partial<ChatView> = {}): ChatView =>
    ({ id, agent: 'claude', label: 'Claude', title: id, cwd: '/w', createdAt: 0, busy: false, changedFiles: 0, items, depth: 0, files: [], lastActivity: 0, turns: 1, ...over }) as ChatView;
  const said = (n: number): Item => ({ kind: 'user', text: `m${n}`, images: [] });
  const many = (n: number) => Array.from({ length: n }, (_, i) => said(i));
  const waiting: Item = { kind: 'command', commandId: 'cmd-1', commandLine: 'npm test', cwd: '/w', outside: false, state: 'awaiting', output: '' };
  const error: Item = { kind: 'notice', tone: 'error', text: 'sign-in expired' };
  const full: AppState = {
    ...EMPTY_STATE,
    chats: [chat('mine', many(500)), chat('waits', [waiting, ...many(400)]), chat('failed', [...many(300), error]), chat('short', many(3))],
  };

  it('keeps its own chat whole and trims the others to their tail and every decision waiting', () => {
    const slim = slimFor(full, 'mine');
    const of = (id: string) => slim.chats.find((c) => c.id === id)!;
    expect(of('mine').items).toBe(full.chats[0].items);
    expect(of('waits').items).toHaveLength(OTHER_CHAT_ITEMS + 1);
    expect(of('waits').items[0]).toBe(waiting);
    expect(of('failed').items).toHaveLength(OTHER_CHAT_ITEMS);
    expect(of('failed').items.at(-1)).toBe(error);
    expect(of('short')).toBe(full.chats[3]);
    // Every chat reads the same status from what it is sent.
    for (const c of full.chats) expect(chatStatus(of(c.id))).toBe(chatStatus(c));
    const others = (st: AppState) => JSON.stringify(st.chats.filter((c) => c.id !== 'mine')).length;
    expect(others(slim)).toBeLessThan(others(full) / 5);
  });

  it('sends the same state when nothing is long, and trims a full restore like the snapshot', () => {
    const small: AppState = { ...EMPTY_STATE, chats: [chat('mine', many(500)), chat('short', many(3))] };
    expect(slimFor(small, 'mine')).toBe(small);
    const plain: Action[] = [{ t: 'busy', chatId: 'waits', busy: true }];
    expect(slimActions(plain, 'mine')).toBe(plain);
    const [restore] = slimActions([{ t: 'restore', state: full } as Action], 'mine') as Extract<Action, { t: 'restore' }>[];
    expect(restore.state.chats.find((c) => c.id === 'waits')!.items).toHaveLength(OTHER_CHAT_ITEMS + 1);
  });
});
