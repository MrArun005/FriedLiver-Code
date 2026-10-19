// The Demo agent's "heavy" prompt reports steps the way Claude's adapter does: the
// whole command as the title and in rawInput, output in a ```console block, heredocs
// that write files. The transcript keeps what the step timeline and Run in terminal need.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src/shared/markdown';
import type { Item } from '../src/shared/model';
import { shownCommand, stepOutput, stepSummary } from '../src/shared/steps';
import { disposeCores, gitRepo, makeCore, waitFor } from './helpers';

afterEach(disposeCores);

type Tool = Extract<Item, { kind: 'tool' }>;
type Permission = Extract<Item, { kind: 'permission' }>;

describe('long shell steps from the Demo agent', () => {
  it('keeps each command whole, reads its output and the files its heredocs write', async () => {
    const dir = await gitRepo();
    const core = makeCore(dir);
    const chat = await core.createChat('demo');
    const turn = core.send(chat.id, 'heavy');
    // Ask mode: each command waits for a yes, with the command on the card.
    for (let n = 1; n <= 5; n++) {
      await waitFor(() => core.chat(chat.id)!.items.some((i): i is Permission => i.kind === 'permission' && !i.answer));
      const ask = core.chat(chat.id)!.items.find((i): i is Permission => i.kind === 'permission' && !i.answer)!;
      expect(ask.detail?.command?.line.split('\n').length).toBeGreaterThan(0);
      core.answerPermission(ask.requestId, 'allow');
    }
    await turn;
    const items = core.chat(chat.id)!.items;
    const tools = items.filter((i): i is Tool => i.kind === 'tool');
    expect(tools).toHaveLength(5);
    const heavy = path.join(dir, 'agent_heavy');
    expect(tools.map((t) => stepSummary(t)).map((s) => `${s.verb} ${s.text}${s.lines ? ` (${s.lines} lines)` : ''}`)).toEqual([
      'Run python3 minidb.py test.sql 2>&1',
      'Run cat << EOF | python3 minidb.py (15 lines)',
      'Run ls -lh agent_heavy/ && wc -l minidb.py test.sql',
      'Write demo_advanced.sql, then python3 minidb.py demo_advanced.sql (16 lines)',
      'Write README.md (22 lines)',
    ]);
    const pipe = tools[1];
    expect(pipe.cmd?.line).toBe(pipe.title);
    expect(pipe.about).toBe('Try the engine with queries from stdin');
    expect(pipe.ms).toBeGreaterThanOrEqual(0);
    const out = pipe.out?.[0];
    expect(out?.t === 'text' && stepOutput(out.text)).toMatchObject({ lang: 'console', text: expect.stringContaining('| id | email               | age |') });
    // What its heredocs write is on disk.
    expect(await readFile(path.join(heavy, 'README.md'), 'utf8')).toMatch(/^# Mini SQL Database Engine\n/);
    expect(await readFile(path.join(heavy, 'demo_advanced.sql'), 'utf8')).toContain('GROUP BY product_id');
    // Run in terminal takes only what the chat showed.
    expect(shownCommand(items, pipe.cmd!.line)).toBe(true);
    expect(shownCommand(items, `${pipe.cmd!.line}\nrm -rf ~`)).toBe(false);
    // The summary is plain text with labels, ✓ lists and paths.
    const reply = items.filter((i) => i.kind === 'agent').at(-1);
    const blocks = parseMarkdown(reply?.kind === 'agent' ? reply.text : '');
    expect(blocks.filter((b) => b.t === 'label').map((b) => (b.t === 'label' && b.inline[0].t === 'text' ? b.inline[0].v : ''))).toEqual(['FEATURES IMPLEMENTED & VERIFIED', 'TEST RESULTS', 'FILES']);
    expect(blocks.some((b) => b.t === 'ol' && b.items[0].lists?.[0].items[0].mark === '✓')).toBe(true);
  });
});
