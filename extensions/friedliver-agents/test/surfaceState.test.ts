import { describe, expect, it } from 'vitest';
import { actionsFor, stateFor, type SurfaceKind } from '../src/host/surfaceState';
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
  it('sends the Images view everything, a chat only your images, the Agent Manager none', () => {
    expect(stateFor('images', start)).toBe(start);
    expect(stateFor('chat', start).images.map((i) => i.id)).toEqual(['y1']);
    expect(stateFor('tasks', start).images).toEqual([]);
    expect(stateFor('chat', { ...start, images: [image('y1', 'you')] }).images).toHaveLength(1);
    expect(actionsFor('images', actions)).toBe(actions);
    expect(actionsFor('tasks', actions).map((a) => a.t)).toEqual(['title', 'restore']);
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
