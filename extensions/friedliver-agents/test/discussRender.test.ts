// The /discuss card draws in every layout and state without throwing, on a tiny stand-in DOM (just
// what Preact touches), and switching friedliver.discuss.layout redraws an open card at once.
import { createElement as h } from 'preact';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DiscussTurn, DiscussionItem, Speaker } from '../src/shared/discuss';
import { DISCUSS_LAYOUTS, discussLayouts } from '../src/shared/discussView';
import type { AgentKey, ChatView } from '../src/shared/model';

class Node_ {
  childNodes: Node_[] = [];
  parentNode: Node_ | null = null;
  constructor(
    public nodeType: number,
    public localName: string,
    public data = '',
  ) {}
  get nodeName() {
    return this.localName.toUpperCase();
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get nextSibling(): Node_ | null {
    const s = this.parentNode?.childNodes;
    return s ? (s[s.indexOf(this) + 1] ?? null) : null;
  }
  ownerDocument = undefined as unknown;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  attributes = new Map<string, string>();
  style = { cssText: '', setProperty() {} };
  insertBefore(n: Node_, ref: Node_ | null) {
    n.remove();
    n.parentNode = this;
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at < 0) this.childNodes.push(n);
    else this.childNodes.splice(at, 0, n);
    return n;
  }
  appendChild(n: Node_) {
    return this.insertBefore(n, null);
  }
  remove() {
    const p = this.parentNode;
    if (p) p.childNodes.splice(p.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  setAttribute(k: string, v: string) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attributes.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attributes.delete(k);
  }
  addEventListener() {}
  removeEventListener() {}
  get textContent(): string {
    return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.childNodes = [];
    if (v) this.appendChild(new Node_(3, '#text', v));
  }
  /** Every element under this one with the class. */
  all(cls: string): Node_[] {
    const out: Node_[] = [];
    const walk = (n: Node_) => {
      if ((n.attributes.get('class') ?? '').split(' ').includes(cls)) out.push(n);
      n.childNodes.forEach(walk);
    };
    this.childNodes.forEach(walk);
    return out;
  }
}

let render: typeof import('preact').render;
let Card: typeof import('../src/webview/discussion').DiscussionCard;
let act: typeof import('preact/test-utils').act;

beforeAll(async () => {
  const doc = {
    createElementNS: (_ns: string, tag: string) => new Node_(1, tag),
    createElement: (tag: string) => new Node_(1, tag),
    createTextNode: (text: string) => new Node_(3, '#text', text),
    addEventListener() {},
    getElementById: () => null,
  };
  Object.assign(globalThis, {
    document: doc,
    window: Object.assign(globalThis, { addEventListener() {}, matchMedia: () => ({ matches: false }) }),
    acquireVsCodeApi: () => ({ postMessage() {}, getState: () => undefined, setState() {} }),
    requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
    cancelAnimationFrame: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
  });
  ({ render } = await import('preact'));
  ({ act } = await import('preact/test-utils'));
  ({ DiscussionCard: Card } = await import('../src/webview/discussion'));
});

const turn = (by: Speaker, round: number, side: string, confidence: number, re?: Speaker): DiscussTurn => ({
  by,
  round,
  text: `${by} holds ${side}. More reasons follow here.`,
  stance: { position: `${side} it is`, side, agree: [], disagree: ['x'], confidence, parsed: true, ...(re ? { re: { agent: re, quote: 'their words' } } : {}) },
});
const base = (agents: AgentKey[], turns: DiscussTurn[], over: Partial<DiscussionItem> = {}): DiscussionItem => ({
  kind: 'discussion',
  id: 'discuss-1',
  question: 'Postgres or MySQL for the audit log (13-month retention, 50M rows)?',
  participants: agents.map((agent) => ({ agent })),
  maxRounds: 3,
  round: 3,
  state: 'done',
  ended: 'rounds',
  turns,
  tokens: 0,
  budget: 60000,
  ...over,
});
const three = [turn('claude', 1, 'Postgres', 0.75), turn('gemini', 1, 'MySQL', 0.7), turn('codex', 1, 'Postgres', 0.65), { by: 'you' as const, round: 2, text: 'Under 2 s.' }, turn('claude', 2, 'Postgres', 0.8, 'codex'), turn('gemini', 2, 'MySQL', 0.6, 'claude')];
const STATES: Record<string, DiscussionItem> = {
  running: base(['claude', 'gemini', 'codex'], three, { state: 'running', ended: undefined, round: 2, speaking: 'codex', points: ['Budget is fixed.'] }),
  summarizing: base(['claude', 'gemini', 'codex'], three, { state: 'summarizing', ended: undefined, speaking: 'claude' }),
  split: base(['claude', 'gemini', 'codex'], [...three, turn('codex', 2, 'Postgres', 0.75, 'gemini')], {
    round: 2,
    maxRounds: 2,
    conclusion: { agreed: ['Monthly partitions'], disagreed: [{ point: 'Is a second engine worth it?', sides: [{ agent: 'claude', view: 'Yes.' }, { agent: 'gemini', view: 'Only if budgeted.' }] }], next: 'Prototype it.', by: 'claude', carryOut: 'codex', rounds: [{ round: 2, trend: 'stuck', on: 'ops cost' }] },
  }),
  agreed: base(['claude', 'codex'], [turn('claude', 1, 'Backoff', 0.7), turn('codex', 1, 'Fixed retries', 0.6), turn('claude', 2, 'Backoff', 0.85, 'codex'), turn('codex', 2, 'Backoff', 0.85, 'claude')], {
    question: 'How should the worker retry?',
    round: 2,
    ended: 'agreed',
    carried: 'claude',
    conclusion: { agreed: ['Retry 5xx only'], disagreed: [], next: 'Add the policy.', by: 'claude' },
  }),
  // Saved before sides, replies and trends: positions only from the options in the prose.
  old: base(['claude', 'gemini'], [
    { by: 'claude', round: 1, text: 'P', stance: { position: 'Postgres, for jsonb', agree: [], disagree: [], parsed: true } },
    { by: 'gemini', round: 1, text: 'Could not answer', failed: true },
  ], { round: 1, ended: 'stopped', conclusion: { agreed: [], disagreed: [], next: 'Decide.', by: 'friedliver' } }),
  empty: base(['claude', 'gemini'], [], { round: 1, ended: 'failed', conclusion: { agreed: [], disagreed: [], next: 'Nobody answered.', by: 'friedliver' } }),
};
const chat = { id: 'chat-1', cwd: '/w' } as ChatView;

describe('/discuss card renders', () => {
  for (const layout of DISCUSS_LAYOUTS)
    for (const [name, d] of Object.entries(STATES))
      it(`${layout} · ${name}`, () => {
        discussLayouts.set(layout);
        const root = new Node_(1, 'div');
        act(() => render(h(Card, { item: d, chat }), root as unknown as Element));
        const card = root.all('fl-discuss')[0];
        expect(card.getAttribute('data-layout')).toBe(layout);
        const text = root.textContent;
        expect(text).toContain(name === 'agreed' ? 'How should the worker retry?' : 'Postgres or MySQL for the audit log?');
        if (d.state !== 'done') {
          expect(root.all('fl-discuss__add')).toHaveLength(1);
          expect(text).toContain('Stop');
          expect(root.all('fl-btn--primary')).toHaveLength(0);
        } else {
          expect(root.all('fl-discuss__hero')).toHaveLength(1);
          expect(text).toContain(d.conclusion!.next);
          expect(root.all('fl-discuss__meter').length > 0).toBe((layout === 'board+meter' || layout === 'meter') && name !== 'empty');
        }
        if (name === 'split') expect(text).toContain('stuck on ops cost');
        if (name === 'running' && layout !== 'meter') expect(text).toContain('Budget is fixed.');
        render(null, root as unknown as Element);
      });

  it('changing the layout redraws an open card', () => {
    discussLayouts.set('board');
    const root = new Node_(1, 'div');
    act(() => render(h(Card, { item: STATES.running, chat }), root as unknown as Element));
    expect(root.all('fl-discuss__board')).toHaveLength(1);
    expect(root.all('fl-discuss__thread')).toHaveLength(0);
    act(() => discussLayouts.set('timeline'));
    expect(root.all('fl-discuss__board')).toHaveLength(0);
    expect(root.all('fl-discuss__thread').length).toBeGreaterThan(0);
    expect(root.all('fl-discuss')[0].getAttribute('data-layout')).toBe('timeline');
    render(null, root as unknown as Element);
    discussLayouts.set('board+meter');
  });
});

describe('/discuss card: the same agent on two models', () => {
  const OPUS = 'claude/claude-opus-4-5';
  const SONNET = 'claude/claude-sonnet-4-5';
  const d: DiscussionItem = {
    ...base([], [turn(OPUS, 1, 'Postgres', 0.8), turn(SONNET, 1, 'MySQL', 0.6, OPUS), turn('gemini', 1, 'MySQL', 0.7, SONNET)], {
      round: 1,
      maxRounds: 1,
      conclusion: { agreed: [], disagreed: [{ point: 'Which engine?', sides: [{ agent: OPUS, view: 'Postgres.' }, { agent: SONNET, view: 'MySQL.' }] }], next: 'Prototype.', by: OPUS, carryOut: SONNET },
    }),
    participants: [
      { agent: 'claude', model: 'claude-opus-4-5', modelName: 'Opus 4.5', chatId: 'chat-1' },
      { agent: 'claude', model: 'claude-sonnet-4-5', modelName: 'Sonnet 4.5' },
      { agent: 'gemini' },
    ],
  };

  for (const layout of DISCUSS_LAYOUTS)
    it(`names each by agent and model (${layout})`, () => {
      discussLayouts.set(layout);
      const root = new Node_(1, 'div');
      act(() => render(h(Card, { item: d, chat }), root as unknown as Element));
      const text = root.textContent;
      expect(text).toContain('Claude · Opus 4.5');
      expect(text).toContain('Claude · Sonnet 4.5');
      expect(text).toContain('Carry out with Claude · Sonnet 4.5');
      // No raw key anywhere but the fixture turns' own prose ("claude/… holds …").
      expect(text.replace(/claude\/claude-[\w-]+ holds/g, '')).not.toMatch(/claude\/claude/);
      render(null, root as unknown as Element);
    });

  it('while it runs, the speaker is named by model too', () => {
    discussLayouts.set('timeline');
    const root = new Node_(1, 'div');
    act(() => render(h(Card, { item: { ...d, state: 'running', ended: undefined, conclusion: undefined, speaking: SONNET }, chat }), root as unknown as Element));
    expect(root.textContent).toContain('Claude · Sonnet 4.5 is speaking');
    render(null, root as unknown as Element);
    discussLayouts.set('board+meter');
  });
});
