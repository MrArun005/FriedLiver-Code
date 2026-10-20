// The Demo agent is gone from the product: only tests and the UI harness run it, with
// FRIEDLIVER_TEST_AGENTS=1 (vitest.config.mts sets it for the other tests). These run as
// the packaged extension does, without it.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { testAgentsOn } from '../src/host/core';
import type { SavedState } from '../src/host/persist';
import { shownAgents } from '../src/shared/accounts';
import { EMPTY_STATE, type ChatView } from '../src/shared/model';
import { disposeCores, gitRepo, makeCore } from './helpers';

const EXT = path.join(__dirname, '..');
afterEach(async () => {
  vi.unstubAllEnvs();
  await disposeCores();
});
const packaged = () => vi.stubEnv('FRIEDLIVER_TEST_AGENTS', '');

it('the manifest never mentions Demo: no setting, enum entry or walkthrough step', () => {
  expect(readFileSync(path.join(EXT, 'package.json'), 'utf8')).not.toMatch(/demo/i);
});

it('pickers, New Chat, the roster and the Agent Manager leave Demo out', () => {
  packaged();
  expect(testAgentsOn()).toBe(false);
  expect(shownAgents(testAgentsOn())).not.toContain('demo');
});

it('a Demo chat cannot start', () => {
  packaged();
  expect(() => makeCore(EXT).spec('demo')).toThrow('The Demo agent was removed.');
});

it('saved Demo chats are dropped on restore; the others come back', async () => {
  packaged();
  const chat = (id: string, agent: ChatView['agent']): ChatView => ({
    id, agent, label: agent, title: 'Task', cwd: '/w', createdAt: 0, busy: false, changedFiles: 0, items: [], depth: 0, files: [], lastActivity: 0, turns: 0,
  });
  const chats = [chat('c1', 'demo'), chat('c2', 'claude')];
  const saved: SavedState = {
    version: 1,
    state: { ...EMPTY_STATE, chats },
    chats: Object.fromEntries(chats.map((c) => [c.id, { agent: c.agent, cwd: c.cwd }])),
    nextId: 3,
    chatCount: { demo: 1, claude: 1 },
  };
  const core = makeCore(await gitRepo());
  core.restore(saved);
  expect(core.snapshot.chats.map((c) => c.id)).toEqual(['c2']);
});

it('nothing that ships sets FRIEDLIVER_TEST_AGENTS (only the integration test runner does)', () => {
  const files = readdirSync(path.join(EXT, 'src'), { recursive: true, encoding: 'utf8' }).filter((f) => /\.tsx?$/.test(f) && !f.startsWith(`test${path.sep}`));
  // Outside comments the only mention allowed is the read in core.ts.
  const setters = files.filter((f) =>
    readFileSync(path.join(EXT, 'src', f), 'utf8')
      .split('\n')
      .some((line) => line.includes('FRIEDLIVER_TEST_AGENTS') && !/^\s*(\/\/|\*|\/\*)/.test(line) && !line.includes("process.env.FRIEDLIVER_TEST_AGENTS === '1'")),
  );
  expect(setters).toEqual([]);
  expect(readFileSync(path.join(EXT, 'esbuild.mjs'), 'utf8')).not.toContain('FRIEDLIVER_TEST_AGENTS');
});
