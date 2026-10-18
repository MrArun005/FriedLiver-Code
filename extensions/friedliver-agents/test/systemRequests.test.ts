// The system_* tools' approvals (bridgeRequests.ts): who is asked, what "this chat" and "Always"
// cover, what is asked every time, Full auto, the settings, the rate limit and the audit log.
import { describe, expect, it } from 'vitest';
import { EXTERNAL_CLIENT, type SystemCall } from '../src/bridge/protocol';
import { BridgeRequests, type SystemHost, type ToolHost } from '../src/host/bridgeRequests';
import type { Prepared } from '../src/host/system';
import { EMPTY_STATE, reduce, type Action, type AppState, type BridgeItem, type ChatView } from '../src/shared/model';
import { SYSTEM_LIMITS, SYSTEM_TOOLS, type SystemTool } from '../src/shared/system';
import { memoryPermissions } from './helpers';

const chat = (id: string, over: Partial<ChatView> = {}): ChatView => ({
  id,
  agent: 'claude',
  label: id,
  title: 'Task',
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

const allTools = (on = true) => Object.fromEntries(SYSTEM_TOOLS.map((t) => [t, on])) as Record<SystemTool, boolean>;

/** The target prepare() works out, as system.ts would. */
function targetOf(call: SystemCall): string {
  if ('app' in call) return `app:${call.app}`;
  if ('path' in call) return `file:${call.path}`;
  if ('url' in call) return `url:${new URL(call.url).origin}`;
  if (call.tool === 'system_shortcut') return call.name;
  if (call.tool === 'system_screenshot_window') return 'app:Safari';
  return '';
}

function setup(over: { policy?: 'ask' | 'allow' | 'off'; chats?: ChatView[]; permissions?: boolean } = {}) {
  let state: AppState = (over.chats ?? [chat('chat-1'), chat('chat-2')]).reduce((s, c) => reduce(s, { t: 'created', chat: c }), EMPTY_STATE);
  let n = 0;
  const ran: string[] = [];
  const audit: string[] = [];
  const flashes: string[] = [];
  const asks: Parameters<ToolHost['notify']>[0][] = [];
  const settings = { enabled: true, fullAutoAllowed: false, tools: allTools() };
  let drift = false;
  const system: SystemHost = {
    settings: () => settings,
    prepare: async (call): Promise<Prepared> => {
      const target = targetOf(call) + (drift ? '-moved' : '');
      return { tool: call.tool, target, text: target, summary: `Do ${call.tool}`, run: async () => (ran.push(`${call.tool} ${target}`), 'done') };
    },
    audit: (line) => audit.push(line),
    done: (summary) => flashes.push(summary),
  };
  const permissions = over.permissions === false ? undefined : memoryPermissions();
  const h: ToolHost = {
    get state() {
      return state;
    },
    policy: () => over.policy ?? 'ask',
    dispatch: (action: Action) => {
      state = reduce(state, action);
    },
    id: (prefix) => `${prefix}-${++n}`,
    notify: (ask) => asks.push(ask),
    consultation: () => undefined,
    consult: async () => 'answer',
    message: () => {},
    cancel: async () => {},
    system,
    ...(permissions ? { permissions } : {}),
  };
  const requests = new BridgeRequests(h);
  const signal = new AbortController().signal;
  const items = (chatId = 'chat-1') => h.state.chats.find((c) => c.id === chatId)!.items.filter((i): i is BridgeItem => i.kind === 'bridge');
  const last = (chatId = 'chat-1') => items(chatId).at(-1)!;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    h,
    requests,
    signal,
    ran,
    audit,
    flashes,
    asks,
    settings,
    permissions,
    items,
    last,
    flush,
    setDrift: (v: boolean) => (drift = v),
    setLevel: (level: 'ask' | 'edits' | 'full', chatId = 'chat-1') => h.dispatch({ t: 'approval', chatId, level }),
  };
}

const spotify: SystemCall = { tool: 'system_open', app: 'Spotify' };

describe('system tools in a chat', () => {
  it('ask first, and do nothing when denied', async () => {
    const s = setup();
    const call = s.requests.call('chat-1', spotify, s.signal);
    await s.flush();
    expect(s.last()).toMatchObject({ tool: 'system_open', target: { system: 'Spotify' }, state: 'awaiting', always: 'Spotify' });
    expect(s.last().once).toBeUndefined();
    s.requests.answer(s.last().requestId, 'deny');
    await expect(call).rejects.toThrow(/did not allow/);
    expect(s.ran).toEqual([]);
    expect(s.audit.at(-1)).toMatch(/Claude chat-1 system_open \{"app":"Spotify"\} → not done: The user did not allow/);
  });

  it('act once allowed, flash the status bar and log it', async () => {
    const s = setup();
    const call = s.requests.call('chat-1', spotify, s.signal);
    await s.flush();
    s.requests.answer(s.last().requestId, 'allow');
    await expect(call).resolves.toBe('done');
    expect(s.ran).toEqual(['system_open app:Spotify']);
    expect(s.flashes).toEqual(['Do system_open']);
    expect(s.audit.at(-1)).toMatch(/→ ok: Do system_open$/);
  });

  it('"Allow for this chat" covers the same tool on the same target only, in that chat only', async () => {
    const s = setup();
    const first = s.requests.call('chat-1', spotify, s.signal);
    await s.flush();
    s.requests.answer(s.last().requestId, 'allowChat');
    await first;
    await expect(s.requests.call('chat-1', spotify, s.signal)).resolves.toBe('done');
    expect(s.last()).toMatchObject({ state: 'allowed' });
    // Another app, another tool on the same app, another chat: asked.
    for (const [chatId, call] of [
      ['chat-1', { tool: 'system_open', app: 'Music' }],
      ['chat-1', { tool: 'system_focus', app: 'Spotify' }],
      ['chat-2', spotify],
    ] as [string, SystemCall][]) {
      void s.requests.call(chatId, call, s.signal).catch(() => {});
      await s.flush();
      expect(s.last(chatId).state).toBe('awaiting');
    }
  });

  it('"Always allow" remembers the tool and target for every chat', async () => {
    const s = setup();
    const first = s.requests.call('chat-1', spotify, s.signal);
    await s.flush();
    s.requests.answer(s.last().requestId, 'allowAlways');
    await first;
    expect(s.permissions!.list().map((r) => r.grant)).toEqual([{ kind: 'system', tool: 'system_open', target: 'app:Spotify' }]);
    await expect(s.requests.call('chat-2', spotify, s.signal)).resolves.toBe('done');
    expect(s.last('chat-2')).toMatchObject({ state: 'allowed', auto: 'Always allowed: Spotify' });
  });

  for (const call of [
    { tool: 'system_clipboard_read' },
    { tool: 'system_screenshot_window', window: 7 },
    { tool: 'system_open', app: 'Terminal' },
    { tool: 'system_open', app: 'iTerm' },
    { tool: 'system_open', app: 'Windows PowerShell' },
    { tool: 'system_focus', app: 'Command Prompt' },
    { tool: 'system_open', app: 'System Settings' },
    { tool: 'system_open', app: 'Keychain Access' },
    { tool: 'system_open', app: 'Registry Editor' },
    { tool: 'system_open', app: 'Task Manager' },
  ] as SystemCall[]) {
    it(`${call.tool} ${'app' in call ? call.app : ''}: only Allow once, every time, whatever the answer or the mode`, async () => {
      const s = setup();
      s.setLevel('full');
      s.settings.fullAutoAllowed = true;
      for (const answer of ['allowChat', 'allowAlways', 'allow'] as const) {
        const p = s.requests.call('chat-1', call, s.signal);
        await s.flush();
        expect(s.last()).toMatchObject({ state: 'awaiting', once: true });
        expect(s.last().always).toBeUndefined();
        s.requests.answer(s.last().requestId, answer);
        await expect(p).resolves.toBe('done');
      }
      expect(s.permissions!.list()).toEqual([]);
      expect(s.ran).toHaveLength(3);
    });
  }

  it('Full auto alone does not cover them; friedliver.system.fullAutoAllowed does', async () => {
    const s = setup();
    s.setLevel('full');
    void s.requests.call('chat-1', spotify, s.signal).catch(() => {});
    await s.flush();
    expect(s.last().state).toBe('awaiting');
    s.settings.fullAutoAllowed = true;
    await expect(s.requests.call('chat-1', spotify, s.signal)).resolves.toBe('done');
    expect(s.last()).toMatchObject({ state: 'allowed', auto: 'Full auto' });
    // Only on Full auto: an Ask chat still asks.
    void s.requests.call('chat-2', spotify, s.signal).catch(() => {});
    await s.flush();
    expect(s.last('chat-2').state).toBe('awaiting');
  });

  it('agent-to-agent "allow" does not cover them', async () => {
    const s = setup({ policy: 'allow' });
    void s.requests.call('chat-1', spotify, s.signal).catch(() => {});
    await s.flush();
    expect(s.last().state).toBe('awaiting');
  });

  it('are refused, before anything is looked at, when off, when the tool is off, or when the tools are off', async () => {
    const s = setup();
    s.settings.enabled = false;
    await expect(s.requests.call('chat-1', spotify, s.signal)).rejects.toThrow(/turned off Mac & Windows control/);
    s.settings.enabled = true;
    s.settings.tools.system_open = false;
    await expect(s.requests.call('chat-1', spotify, s.signal)).rejects.toThrow(/turned off system_open/);
    await expect(setup({ policy: 'off' }).requests.call('chat-1', spotify, s.signal)).rejects.toThrow(/turned off/);
    expect(s.items()).toEqual([]);
    expect(s.ran).toEqual([]);
  });

  it('stop if the setting is turned off while the user decides', async () => {
    const s = setup();
    const p = s.requests.call('chat-1', spotify, s.signal);
    await s.flush();
    s.settings.enabled = false;
    s.requests.answer(s.last().requestId, 'allow');
    await expect(p).rejects.toThrow(/turned off/);
    expect(s.ran).toEqual([]);
  });

  it('act only on what the user saw: a target that changed after approval is refused', async () => {
    const s = setup();
    const p = s.requests.call('chat-1', { tool: 'system_open', path: '/w/report.pdf' }, s.signal);
    await s.flush();
    s.setDrift(true);
    s.requests.answer(s.last().requestId, 'allow');
    await expect(p).rejects.toThrow(/changed after the user approved/);
    expect(s.ran).toEqual([]);
  });

  it('are not offered to read-only chats (inline edits)', async () => {
    const s = setup({ chats: [chat('chat-1', { readOnly: true })] });
    await expect(s.requests.call('chat-1', spotify, s.signal)).rejects.toThrow(/only proposes text/);
    expect(s.ran).toEqual([]);
  });

  it(`allow at most ${SYSTEM_LIMITS.perMinute} actions a minute per chat`, async () => {
    const s = setup();
    s.setLevel('full');
    s.settings.fullAutoAllowed = true;
    for (let i = 0; i < SYSTEM_LIMITS.perMinute; i++) await s.requests.call('chat-1', { tool: 'system_volume', action: 'get' }, s.signal);
    await expect(s.requests.call('chat-1', { tool: 'system_volume', action: 'get' }, s.signal)).rejects.toThrow(/Too many system actions/);
    expect(s.ran).toHaveLength(SYSTEM_LIMITS.perMinute);
    // Another chat has its own budget.
    s.setLevel('full', 'chat-2');
    await expect(s.requests.call('chat-2', { tool: 'system_volume', action: 'get' }, s.signal)).resolves.toBe('done');
  });

  it('log clipboard text as its length only', async () => {
    const s = setup();
    const p = s.requests.call('chat-1', { tool: 'system_clipboard_write', text: 'secret token 123' }, s.signal);
    await s.flush();
    s.requests.answer(s.last().requestId, 'allow');
    await p;
    expect(s.audit.join('\n')).not.toContain('secret');
    expect(s.audit.at(-1)).toContain('{"text":"<16 chars>"}');
  });

  it('forget what a closed chat was allowed', async () => {
    const s = setup();
    const p = s.requests.call('chat-1', spotify, s.signal);
    await s.flush();
    s.requests.answer(s.last().requestId, 'allowChat');
    await p;
    s.requests.forget('chat-1');
    void s.requests.call('chat-1', spotify, s.signal).catch(() => {});
    await s.flush();
    expect(s.last().state).toBe('awaiting');
  });
});

describe('system tools from Claude Code outside FriedLiver', () => {
  const S1 = `${EXTERNAL_CLIENT}:${'1'.repeat(32)}`;
  const S2 = `${EXTERNAL_CLIENT}:${'2'.repeat(32)}`;

  it('ask in a popup that says what and where; "this session" holds for that session, tool and target only', async () => {
    const s = setup();
    const p = s.requests.call(S1, spotify, s.signal);
    await s.flush();
    expect(s.asks.at(-1)).toMatchObject({ chatId: S1, title: 'Claude Code wants to open Spotify', detail: 'app:Spotify', always: 'Spotify' });
    expect(s.asks.at(-1)!.once).toBeUndefined();
    s.requests.answer(s.asks.at(-1)!.requestId, 'allowChat');
    await expect(p).resolves.toBe('done');
    await expect(s.requests.call(S1, spotify, s.signal)).resolves.toBe('done');
    expect(s.asks).toHaveLength(1);
    void s.requests.call(S2, spotify, s.signal).catch(() => {});
    await s.flush();
    expect(s.asks).toHaveLength(2);
    expect(s.audit.at(0)).toContain('Claude Code (outside FriedLiver)');
  });

  it('offer only Allow once for the clipboard, and remember nothing', async () => {
    const s = setup();
    const p = s.requests.call(S1, { tool: 'system_clipboard_read' }, s.signal);
    await s.flush();
    expect(s.asks.at(-1)).toMatchObject({ once: true });
    expect(s.asks.at(-1)!.always).toBeUndefined();
    s.requests.answer(s.asks.at(-1)!.requestId, 'allowChat');
    await p;
    void s.requests.call(S1, { tool: 'system_clipboard_read' }, s.signal).catch(() => {});
    await s.flush();
    expect(s.asks).toHaveLength(2);
  });

  it('are not covered by friedliver.browser.externalAutoApprove', async () => {
    const s = setup();
    s.h.externalAutoApprove = () => true;
    void s.requests.call(S1, spotify, s.signal).catch(() => {});
    await s.flush();
    expect(s.asks).toHaveLength(1);
  });

  it('still reach only browser_* and system_* tools', async () => {
    const s = setup();
    await expect(s.requests.call(S1, { tool: 'list_chats' }, s.signal)).rejects.toThrow(/browser_\* and system_\*/);
  });
});

describe('what the card shows', () => {
  it('spells out names from disk without direction or control characters', async () => {
    const s = setup();
    void s.requests.call('chat-1', { tool: 'system_open', app: 'Safari‮gnp.exe' }, s.signal).catch(() => {});
    await s.flush();
    expect(s.last().target).toEqual({ system: 'Safari gnp.exe' });
  });
});
