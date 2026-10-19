import { describe, expect, it } from 'vitest';
import { commandsApi, describeForApproval, downloadLine, withAgentDownloads, type DownloadInfo, type DownloadsApi } from '../src/host/browserDownloads';
import { BridgeRequests, type ToolHost } from '../src/host/bridgeRequests';
import { approvalOf } from '../src/shared/approval';
import { EMPTY_STATE, reduce, type Action, type AppState, type ChatView } from '../src/shared/model';

const MB = 1024 * 1024;
const dl = (over: Partial<DownloadInfo> = {}): DownloadInfo => ({
  id: 'd1',
  url: 'https://github.com/o/r/releases/download/v1/tool.zip',
  filename: 'tool.zip',
  path: '',
  state: 'awaiting',
  waitingFor: 'agent',
  byAgent: true,
  receivedBytes: 0,
  totalBytes: 2 * MB,
  startTime: Date.now(),
  ...over,
});

/** The editor's side: downloads that start during `act`, and what they end as once allowed. */
function fakeEditor(started: DownloadInfo[], finished: (d: DownloadInfo) => DownloadInfo = (d) => ({ ...d, state: 'completed', path: `/dl/${d.filename}`, receivedBytes: d.totalBytes, sha256: 'ab'.repeat(32) })) {
  const log: string[] = [];
  const list: DownloadInfo[] = [];
  const claimed = new Set<string>();
  const api: DownloadsApi = {
    list: async () => list.map((d) => ({ ...d })),
    scope: async (active) => void log.push(`scope ${active}`),
    claim: async (id) => (claimed.has(id) ? false : (claimed.add(id), true)),
    approve: async (id, allow) => {
      log.push(`approve ${id} ${allow}`);
      const d = list.find((x) => x.id === id)!;
      Object.assign(d, allow ? finished(d) : { state: 'cancelled' });
    },
    waitFor: async (id) => list.find((x) => x.id === id),
  };
  const act = async () => {
    log.push('act');
    list.push(...started);
    return 'Clicked a "Download".';
  };
  return { api, act, log, list };
}

describe('a download an agent starts', () => {
  it('waits for the OK, then reports path, size and sha256', async () => {
    const { api, act, log } = fakeEditor([dl()]);
    const asked: string[] = [];
    const out = await withAgentDownloads(api, act, { ask: async (d) => (asked.push(d.filename), true), settleMs: 0 });
    expect(asked).toEqual(['tool.zip']);
    expect(log).toEqual(['scope true', 'act', 'scope false', 'approve d1 true']);
    expect(out).toBe(`Clicked a "Download".\nDownloaded tool.zip to /dl/tool.zip (2.0 MB, ${2 * MB} bytes, sha256 ${'ab'.repeat(32)}).`);
  });

  it('is cancelled before a byte is kept when the user says no', async () => {
    const { api, act, log, list } = fakeEditor([dl()]);
    const out = await withAgentDownloads(api, act, { ask: async () => false, settleMs: 0 });
    expect(log).toContain('approve d1 false');
    expect(list[0].state).toBe('cancelled');
    expect(out).toMatch(/the user did not allow it, so nothing was saved/);
  });

  it('is cancelled when nobody can ask, or the ask throws', async () => {
    for (const ask of [undefined, async () => { throw new Error('3 requests already wait'); }]) {
      const { api, act, list } = fakeEditor([dl()]);
      await withAgentDownloads(api, act, { ask, settleMs: 0 });
      expect(list[0].state).toBe('cancelled');
    }
  });

  it('leaves downloads alone that the user started or another caller claimed', async () => {
    const mine = dl({ id: 'a' });
    const users = dl({ id: 'b', byAgent: false, state: 'progressing', waitingFor: undefined });
    const old = dl({ id: 'c', startTime: Date.now() - 60_000 });
    const { api, act, log } = fakeEditor([mine, users, old]);
    await api.claim('a');
    const out = await withAgentDownloads(api, act, { ask: async () => true, settleMs: 0 });
    expect(log.filter((l) => l.startsWith('approve'))).toEqual([]);
    expect(out).toBe('Clicked a "Download".');
  });

  it('tells the agent about a download the editor refused', async () => {
    const { api, act } = fakeEditor([dl({ state: 'failed', error: 'Only http and https downloads are allowed', url: 'data:text/plain,x' })]);
    const out = await withAgentDownloads(api, act, { ask: async () => true, settleMs: 0 });
    expect(out).toMatch(/download of tool\.zip failed: Only http and https downloads are allowed/);
  });

  it('reports one still running after the wait', async () => {
    const { api, act } = fakeEditor([dl({ totalBytes: 900 * MB })], (d) => ({ ...d, state: 'progressing', path: '/dl/tool.zip', receivedBytes: 100 * MB }));
    const out = await withAgentDownloads(api, act, { ask: async () => true, settleMs: 0, waitMs: 0 });
    expect(out).toMatch(/tool\.zip is still downloading to \/dl\/tool\.zip \(100 MB of 900 MB\)/);
  });

  it('ends the agent scope even when the action throws', async () => {
    const { api, log } = fakeEditor([]);
    await expect(withAgentDownloads(api, async () => { throw new Error('page closed'); }, { settleMs: 0 })).rejects.toThrow('page closed');
    expect(log).toEqual(['scope true', 'scope false']);
  });

  it('just acts in an editor without downloads (stock VS Code)', async () => {
    const api = commandsApi(() => Promise.reject(new Error("command '_friedliver.browser.downloads.agentScope' not found")));
    await expect(withAgentDownloads(api, async () => 'Opened x', { settleMs: 0 })).resolves.toBe('Opened x');
    await expect(withAgentDownloads(undefined, async () => 'Opened y')).resolves.toBe('Opened y');
  });

  it('calls the editor commands with plain arguments', async () => {
    const calls: unknown[][] = [];
    const api = commandsApi(async (...args) => (calls.push(args), args[0] === '_friedliver.browser.downloads.claim' ? true : []));
    await api.scope(true);
    expect(await api.claim('x')).toBe(true);
    await api.approve('x', false);
    expect(await api.list()).toEqual([]);
    expect(calls).toEqual([
      ['_friedliver.browser.downloads.agentScope', true],
      ['_friedliver.browser.downloads.claim', 'x'],
      ['_friedliver.browser.downloads.approve', 'x', false],
      ['_friedliver.browser.downloads.list'],
    ]);
  });

  it('describes itself for the approval and the agent', () => {
    expect(describeForApproval(dl())).toBe('tool.zip (2.0 MB) from github.com');
    expect(describeForApproval(dl({ totalBytes: 0 }))).toBe('tool.zip from github.com');
    expect(downloadLine(dl({ state: 'cancelled' }))).toBe('The download of tool.zip was cancelled.');
  });
});

// ---- The approval in the agent's chat ----

const chat = (id: string, over: Partial<ChatView> = {}): ChatView => ({
  id, agent: 'demo', label: id, title: 'Task', cwd: '/w', createdAt: 0, busy: false, changedFiles: 0, items: [], depth: 0, files: [], lastActivity: 0, turns: 0, ...over,
});

function setup(approval?: 'ask' | 'edits' | 'full', downloads: DownloadInfo[] = [dl()]) {
  let state: AppState = [chat('chat-1')].reduce((s, c) => reduce(s, { t: 'created', chat: c }), EMPTY_STATE);
  let n = 0;
  const answers: boolean[] = [];
  const h: ToolHost = {
    get state() {
      return state;
    },
    policy: () => 'ask',
    dispatch: (action: Action) => {
      state = reduce(state, action);
    },
    id: (prefix) => `${prefix}-${++n}`,
    notify: () => {},
    consultation: () => undefined,
    consult: async () => 'answer',
    message: () => {},
    cancel: async () => {},
    browser: async (_chatId, _call, _signal, _origin, askDownload) => {
      for (const d of downloads) answers.push(await askDownload!(d).catch(() => false));
      return 'ok';
    },
  };
  if (approval) h.dispatch({ t: 'approval', chatId: 'chat-1', level: approval });
  const requests = new BridgeRequests(h);
  const items = () => h.state.chats[0].items.filter((i) => i.kind === 'bridge');
  return { h, requests, items, answers, signal: new AbortController().signal };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('download approvals in the chat', () => {
  it('asks like other browser actions, with the file, size and site', async () => {
    const { requests, items, answers, signal } = setup('ask');
    const call = requests.call('chat-1', { tool: 'browser_click', text: 'Download' }, signal);
    const [click] = items();
    if (click.kind === 'bridge') requests.answer(click.requestId, 'allow');
    await flush();
    const dlItem = items().at(-1)!;
    expect(dlItem).toMatchObject({ tool: 'browser_download', target: { browser: true }, text: 'tool.zip (2.0 MB) from github.com', state: 'awaiting', always: 'https://github.com' });
    if (dlItem.kind === 'bridge') requests.answer(dlItem.requestId, 'deny');
    await call;
    expect(answers).toEqual([false]);
  });

  it('goes ahead on Full auto, and is recorded in the chat', async () => {
    const { requests, items, answers, signal } = setup('full');
    await requests.call('chat-1', { tool: 'browser_click', text: 'Download' }, signal);
    expect(answers).toEqual([true]);
    expect(items().at(-1)).toMatchObject({ tool: 'browser_download', state: 'allowed' });
  });

  it('asks over 500 MB even on Full auto, once only', async () => {
    const { requests, items, answers, signal } = setup('full', [dl({ totalBytes: 600 * MB })]);
    const call = requests.call('chat-1', { tool: 'browser_click', text: 'Download' }, signal);
    await flush();
    const dlItem = items().at(-1)!;
    expect(dlItem).toMatchObject({ tool: 'browser_download', state: 'awaiting', once: true, text: 'tool.zip (600 MB) from github.com' });
    if (dlItem.kind === 'bridge') requests.answer(dlItem.requestId, 'allowChat');
    await call;
    expect(answers).toEqual([true]);
  });

  it('"Allow downloads for this chat" covers later downloads, not other browser actions', async () => {
    const { requests, items, answers, signal } = setup('ask', [dl(), dl({ id: 'd2', filename: 'b.zip' })]);
    const call = requests.call('chat-1', { tool: 'browser_reload' }, signal);
    const [reload] = items();
    if (reload.kind === 'bridge') requests.answer(reload.requestId, 'allow');
    await flush();
    const first = items().at(-1)!;
    if (first.kind === 'bridge') requests.answer(first.requestId, 'allowChat');
    await call;
    expect(answers).toEqual([true, true]);
    expect(items().at(-1)).toMatchObject({ text: 'b.zip (2.0 MB) from github.com', state: 'allowed' });
    void requests.call('chat-1', { tool: 'browser_back' }, signal).catch(() => {});
    expect(items().at(-1)).toMatchObject({ tool: 'browser_back', state: 'awaiting' });
  });

  it('never offers "Always allow" on a download card', () => {
    const { h } = setup();
    const item = { kind: 'bridge' as const, requestId: 'r', tool: 'browser_download' as const, target: { browser: true as const }, text: 'tool.zip (2.0 MB) from github.com', state: 'awaiting' as const, always: 'https://github.com' };
    const a = approvalOf(item, h.state.chats[0]);
    expect(a.verb).toBe('Download');
    expect(a.allow.always).toBeUndefined();
    expect(a.allow.chat).toBeDefined();
    expect(a.risk.label).toBe('Saves a file');
    expect(approvalOf({ ...item, once: true }, h.state.chats[0]).allow.chat).toBeUndefined();
  });
});
