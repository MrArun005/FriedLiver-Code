import { describe, expect, it } from 'vitest';
import { actionsFor, showsChat, stateFor, type SurfaceKind } from '../src/host/surfaceState';
import { EMPTY_STATE, reduce, type Action, type AppState, type ImageItem } from '../src/shared/model';

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
