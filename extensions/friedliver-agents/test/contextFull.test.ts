import { afterEach, describe, expect, it } from 'vitest';
import { disposeCores, gitRepo, makeCore, waitFor } from './helpers';

afterEach(disposeCores);

const notices = (core: ReturnType<typeof makeCore>, id: string) => core.chat(id)!.items.filter((i) => i.kind === 'notice' && /context is \d+% full/.test(i.text));

describe('a chat near its context limit', () => {
  it('is offered the agent\'s own /compact once per climb, and compacting works', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir);
    const chat = await core.createChat('demo');
    await core.send(chat.id, 'hello');
    await waitFor(() => !!core.chat(chat.id)!.session?.commands.some((c) => c.name === 'compact'));
    expect(notices(core, chat.id)).toHaveLength(0);
    await core.send(chat.id, 'fill 176000');
    expect(notices(core, chat.id)).toHaveLength(1);
    expect(notices(core, chat.id)[0]).toMatchObject({ actions: [{ label: 'Compact now', do: 'compact' }] });
    await core.send(chat.id, 'fill 180000');
    expect(notices(core, chat.id)).toHaveLength(1);
    await core.compact(chat.id);
    expect(core.chat(chat.id)!.session?.usage?.used).toBeLessThan(10_000);
    await core.send(chat.id, 'fill 190000');
    expect(notices(core, chat.id)).toHaveLength(2);
  }, 30_000);
});
