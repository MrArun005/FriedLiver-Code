// The chat tab strip: a mark per agent on every tab, tabs that shrink before they scroll,
// an overflow list of every open tab, and keyboard switching (COMPONENTS.md §2.18, §2.22b).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_KEYS, type ChatView } from '../src/shared/model';
import { TAB_MIN, switcherGroups, tabFit, tabForKey, tabTip } from '../src/shared/view';
import { FRIEDLIVER_MARK } from '../src/webview/ui/friedliverMark';
import { MARKS, markFor } from '../src/webview/ui/marks';

const chat = (id: string, over: Partial<ChatView> = {}): ChatView => ({
  id,
  agent: 'claude',
  label: 'Claude',
  title: id,
  cwd: '/w',
  createdAt: 0,
  busy: false,
  changedFiles: 0,
  items: [],
  depth: 0,
  files: [],
  lastActivity: 0,
  turns: 0,
  ...over,
});

describe('a mark on every tab', () => {
  it('gives every agent kind its own mark, and anything else the generic one', () => {
    const marks = AGENT_KEYS.map((a) => markFor(a));
    expect(new Set(marks).size).toBe(AGENT_KEYS.length);
    expect(marks).not.toContain(MARKS.agent);
    expect(markFor('cursor')).toBe(MARKS.agent);
    expect(markFor('')).toBe(MARKS.agent);
  });

  it('draws Demo with the FriedLiver mark, which lives in one file', () => {
    expect(markFor('demo')).toBe(FRIEDLIVER_MARK);
  });

  it('the editor tab of a chat panel shows the same mark (media/agent-<kind>.svg)', () => {
    for (const a of AGENT_KEYS) {
      const svg = readFileSync(path.join(__dirname, `../media/agent-${a}.svg`), 'utf8');
      const m = markFor(a);
      expect(svg, a).toContain(`d="${m.d}"`);
      if (m.fill) expect(svg, a).toContain(`d="${m.fill}"`);
    }
  });

  it('every mark is a 16-grid drawing (crisp at 1x and 2x)', () => {
    for (const m of Object.values(MARKS)) {
      expect(m.d.length).toBeGreaterThan(0);
      expect(m.viewBox ?? '0 0 16 16').toMatch(/^-?\d+ -?\d+ \d+ \d+$/);
    }
  });
});

describe('tabs shrink before they scroll', () => {
  // The open tab is counted at TAB_MIN.open (a title of at least 110), the others at their fit's minimum, 4 apart.
  it('keeps titles while each tab can have its full minimum', () => {
    expect(tabFit(600, 2)).toBe('full');
    expect(tabFit(420, 2)).toBe('full');
    expect(tabFit(300, 2)).toBe('full');
    expect(tabFit(600, 4)).toBe('full');
  });

  it('squeezes titles next', () => {
    expect(tabFit(660, 6)).toBe('compact');
    expect(tabFit(400, 3)).toBe('compact');
  });

  it('drops to marks only (the open tab keeps its title) when even that is too tight', () => {
    expect(tabFit(299, 2)).toBe('compact');
    expect(tabFit(275, 2)).toBe('icon');
    expect(tabFit(214, 2)).toBe('icon');
    expect(tabFit(600, 6)).toBe('icon');
    expect(tabFit(300, 6)).toBe('icon');
    expect(tabFit(600, 15)).toBe('icon');
  });

  it('a zero-width (not yet laid out) strip or no tabs is full', () => {
    expect(tabFit(0, 4)).toBe('full');
    expect(tabFit(300, 0)).toBe('full');
  });

  it('the open tab leaves at least 110 for its title beside its mark, Auto pill and dot', () => {
    // padding 8 + mark 16 + gap 4 + Auto 22 + gap 4 + dot 8 + gap 4 + padding 8 = 74
    expect(TAB_MIN.open - 74).toBeGreaterThanOrEqual(110);
  });

  it('the thresholds are the tokens the CSS uses', () => {
    const tokens = readFileSync(path.join(__dirname, '../media/tokens.css'), 'utf8');
    expect(tokens).toContain(`--tab-min: ${TAB_MIN.full}px;`);
    expect(tokens).toContain(`--tab-min-compact: ${TAB_MIN.compact}px;`);
    expect(tokens).toContain(`--tab-open-min: ${TAB_MIN.open}px;`);
  });
});

describe('a mark-only tab says what it is', () => {
  it('its tooltip has the title, the agent and the status', () => {
    expect(tabTip(chat('a', { title: 'Fix the flaky test', agent: 'codex' }))).toBe('Fix the flaky test · Codex · Idle');
    expect(tabTip(chat('a', { title: 'Ship it', busy: true }))).toBe('Ship it · Claude · Working');
  });

  it('and says Auto when edits and commands go through without asking', () => {
    expect(tabTip(chat('a', { title: 'Ship it', approval: 'full' }))).toBe('Ship it · Claude · Idle · Auto');
  });
});

describe('the overflow list holds every open tab', () => {
  const chats = [chat('a', { title: 'alpha' }), chat('b', { title: 'beta', archived: true }), chat('c', { title: 'gamma' }), chat('d', { title: 'delta' })];

  it('lists the open tabs first, in strip order, archived ones too; the rest follow without them', () => {
    const groups = switcherGroups(chats, '', ['c', 'b', 'a']);
    expect(groups[0].title).toBe('Open tabs');
    expect(groups[0].chats.map((c) => c.id)).toEqual(['c', 'b', 'a']);
    expect(groups.slice(1).flatMap((g) => g.chats.map((c) => c.id))).toEqual(['d']);
  });

  it('searches the open tabs too', () => {
    const groups = switcherGroups(chats, 'gamma', ['c', 'b', 'a']);
    expect(groups.map((g) => g.chats.map((c) => c.id))).toEqual([['c']]);
  });

  it('without tabs it is the chat list it was', () => {
    expect(switcherGroups(chats, '').some((g) => g.title === 'Open tabs')).toBe(false);
  });
});

describe('keyboard switching', () => {
  const strip = ['a', 'b', 'c', 'd'];
  const key = (k: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}, mac = true) =>
    tabForKey(strip, 'b', { key: k, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift, altKey: !!mods.alt }, mac);

  it('Ctrl+Tab and Ctrl+Shift+Tab cycle, on every platform', () => {
    expect(key('Tab', { ctrl: true })).toBe('c');
    expect(key('Tab', { ctrl: true, shift: true })).toBe('a');
    expect(tabForKey(strip, 'd', { key: 'Tab', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, false)).toBe('a');
    expect(tabForKey(strip, 'a', { key: 'Tab', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, false)).toBe('d');
  });

  it('Cmd+1..8 (Ctrl on Windows and Linux) pick that tab; 9 is the last', () => {
    expect(key('1', { meta: true })).toBe('a');
    expect(key('3', { meta: true })).toBe('c');
    expect(key('8', { meta: true })).toBeUndefined();
    expect(key('9', { meta: true })).toBe('d');
    expect(key('2', { ctrl: true }, false)).toBe('b');
    expect(key('2', { ctrl: true }, true)).toBeUndefined();
    expect(key('2', { meta: true }, false)).toBeUndefined();
  });

  it('leaves every other key alone', () => {
    expect(key('Tab')).toBeUndefined();
    expect(key('1')).toBeUndefined();
    expect(key('1', { meta: true, alt: true })).toBeUndefined();
    expect(key('1', { meta: true, shift: true })).toBeUndefined();
    expect(tabForKey([], undefined, { key: 'Tab', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, true)).toBeUndefined();
  });
});
