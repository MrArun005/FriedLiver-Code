import { describe, expect, it, vi } from 'vitest';
import { ChatTabs, restoredChats, tabTitle, type TabPanel } from '../src/host/chatTabs';

const panel = () => ({ reveal: vi.fn<TabPanel['reveal']>(), dispose: vi.fn<TabPanel['dispose']>() });

function setup() {
  const made: string[] = [];
  const tabs: ChatTabs<ReturnType<typeof panel>> = new ChatTabs((chatId) => {
    made.push(chatId);
    tabs.adopt(chatId, panel());
  });
  return { tabs, made };
}

describe('chats as editor tabs', () => {
  it('opens a tab for a chat, then reveals that tab instead of making another', () => {
    const { tabs, made } = setup();
    tabs.open('a');
    tabs.open('b', 2);
    tabs.open('a', 1, true);
    expect(made).toEqual(['a', 'b']);
    expect(tabs.size).toBe(2);
    expect(tabs.get('a')!.reveal).toHaveBeenCalledWith(1, true);
  });

  it('closes a second tab restored for a chat that already has one', () => {
    const { tabs } = setup();
    const first = panel();
    const dupe = panel();
    expect(tabs.adopt('a', first)).toBe(true);
    expect(tabs.adopt('a', dupe)).toBe(false);
    expect(dupe.dispose).toHaveBeenCalled();
    expect(tabs.get('a')).toBe(first);
    expect(tabs.adopt('a', first)).toBe(true);
  });

  it('forgets a closed tab, so opening the chat again makes a new one', () => {
    const { tabs, made } = setup();
    tabs.open('a');
    const old = tabs.get('a')!;
    tabs.closed('a', panel());
    expect(tabs.get('a')).toBe(old);
    tabs.closed('a', old);
    expect(tabs.size).toBe(0);
    tabs.open('a');
    expect(made).toEqual(['a', 'a']);
  });

  it('restores a tab to its chat, and a tab from before to every chat its strip had', () => {
    expect(restoredChats({ chat: 'c1', openTabs: ['x'] })).toEqual(['c1']);
    expect(restoredChats({ openTabs: ['c1', 3, '', 'c2'] })).toEqual(['c1', 'c2']);
    expect(restoredChats(undefined)).toEqual([]);
    expect(restoredChats({ chat: 7 })).toEqual([]);
  });

  it('marks a tab working, waiting on you or failed, and leaves a quiet one plain', () => {
    expect(tabTitle('Fix login', 'working')).toBe('◌ Fix login');
    expect(tabTitle('Fix login', 'needs-you')).toBe('● Fix login');
    expect(tabTitle('Fix login', 'error')).toBe('⚠ Fix login');
    expect(tabTitle('Fix login', 'done')).toBe('Fix login');
    expect(tabTitle('New chat')).toBe('New chat');
  });
});
