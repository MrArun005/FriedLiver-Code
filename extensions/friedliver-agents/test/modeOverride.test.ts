// The mode button must never say "Manual" while the agent itself runs in a mode that doesn't ask.
import { describe, expect, it } from 'vitest';
import { agentOverride, type ChatSession } from '../src/shared/session';

const session = (current: string) =>
  ({
    live: true,
    commands: [],
    options: [
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        via: 'mode',
        current,
        choices: [
          { value: 'default', name: 'Default' },
          { value: 'acceptEdits', name: 'Accept edits' },
          { value: 'plan', name: 'Plan' },
          { value: 'auto', name: 'Auto' },
          { value: 'bypassPermissions', name: 'Bypass permissions', description: 'Accepts all permissions' },
        ],
      },
    ],
  }) as unknown as ChatSession;

describe('agentOverride', () => {
  it('Ask + the agent in Bypass permissions: the agent mode wins, loud', () => {
    expect(agentOverride('ask', session('bypassPermissions'))).toEqual({ name: 'Bypass permissions', tone: 'full', cls: 'full' });
  });
  it('Ask or Edits + the agent in Auto: Auto wins', () => {
    expect(agentOverride('ask', session('auto'))?.tone).toBe('auto');
    expect(agentOverride('edits', session('auto'))?.name).toBe('Auto');
  });
  it('no override when the agent is no more permissive than the level', () => {
    expect(agentOverride('ask', session('default'))).toBeUndefined();
    expect(agentOverride('edits', session('acceptEdits'))).toBeUndefined();
    expect(agentOverride('full', session('bypassPermissions'))).toBeUndefined();
    expect(agentOverride('full', session('auto'))).toBeUndefined();
    expect(agentOverride('ask', undefined)).toBeUndefined();
  });
});
