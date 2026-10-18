import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactOutput, TerminalManager } from '@friedliver/main/agents/terminals';
import { estimateTokens } from '../src/shared/tokens';

describe('compactOutput', () => {
  it('strips colors and spinner frames, keeping the text', () => {
    expect(compactOutput('\x1b[32m✓\x1b[0m ok\n⠋ building\r⠙ building\r✔ built\n').text).toBe('✓ ok\n✔ built\n');
  });

  it('collapses repeated lines', () => {
    const out = compactOutput(`start\n${'warning: deprecated API\n'.repeat(50)}end\n`).text;
    expect(out).toBe('start\nwarning: deprecated API\n… the line above 49 more times\nend\n');
  });

  it('keeps a stack trace\'s own frames and folds library and runtime ones', () => {
    const trace = [
      'Error: boom',
      '    at parse (/app/src/parse.ts:10:5)',
      ...Array.from({ length: 12 }, (_, i) => `    at fn${i} (/app/node_modules/lib/index.js:${i}:1)`),
      '    at main (/app/src/main.ts:3:1)',
      '    at node:internal/modules/cjs/loader:1:1',
      '    at node:internal/main/run_main_module:2:2',
    ].join('\n');
    const out = compactOutput(trace).text;
    expect(out).toBe(['Error: boom', '    at parse (/app/src/parse.ts:10:5)', '    … 12 frames in node_modules', '    at main (/app/src/main.ts:3:1)', '    … 2 runtime frames'].join('\n'));
  });

  it('keeps the head and tail of long output, saying how many lines it left out', () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n');
    const r = compactOutput(text, { head: 50, tail: 100 });
    expect(r.omitted).toBe(850);
    const lines = r.text.split('\n');
    expect(lines[49]).toBe('line 50');
    expect(lines[50]).toMatch(/^… 850 lines left out \(51-900\)/);
    expect(lines.at(-1)).toBe('line 1000');
    expect(estimateTokens(r.text)).toBeLessThan(estimateTokens(text) / 4);
  });

  it('leaves short, clean output alone', () => {
    expect(compactOutput('a\nb\n')).toEqual({ text: 'a\nb\n', omitted: 0 });
    expect(compactOutput('x'.repeat(5000)).text).toBe('x'.repeat(5000));
  });
});

describe('terminal output for agents', () => {
  it('is compacted, with the whole output saved where the agent can read it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fl-out-'));
    let saved = '';
    const counted: [number, number][] = [];
    const m = new TerminalManager(dir, {
      onStart: () => {},
      onData: () => {},
      onExit: () => {},
      compacted: (_info, raw, sent) => counted.push([raw.length, sent.length]),
      saveOutput: async (_info, text) => {
        saved = path.join(dir, 'out.txt');
        await (await import('node:fs/promises')).writeFile(saved, text);
        return saved;
      },
    });
    const { terminalId } = await m.create({ sessionId: 's', command: process.execPath, args: ['-e', 'for (let i = 1; i <= 2000; i++) console.log("test " + i + " passed")'] });
    await m.waitForExit({ sessionId: 's', terminalId });
    const r = await m.output({ sessionId: 's', terminalId });
    expect(r.output).toContain('test 1 passed');
    expect(r.output).toContain('test 2000 passed');
    expect(r.output).toMatch(/… \d+ lines left out \(\d+-\d+\); the whole output: .*out\.txt/);
    expect(r.output.split('\n').length).toBeLessThan(200);
    expect((await readFile(saved, 'utf8')).split('\n').length).toBe(2001);
    expect(counted.length).toBe(1);
    expect(counted[0][0]).toBeGreaterThan(counted[0][1] * 5);
  });
});
