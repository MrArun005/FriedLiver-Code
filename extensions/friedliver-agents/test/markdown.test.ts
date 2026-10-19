import { describe, expect, it } from 'vitest';
import { isLabel, lineCount, parseDoc, parseInline, parseMarkdown, wholePath, type Block, type Inline, type ListBlock, type MarkdownDoc } from '../src/shared/markdown';

const REPLY = [
  '### Part 1\n\n',
  'Some *text* with `code` and a [link](https://example.com).\n',
  'Same paragraph, next line.\n\n',
  '- one\n- two\n\n- three, same list\n',
  '1. first\n2) second\n',
  'After the list.\r\n\r\n',
  '```ts\nconst a = 1;\n\nconst b = 2;\n```\n',
  '## Heading\nText right under it\n',
  '```\nunclosed fence\n- not a list\n',
].join('');

/** Feeds `text` in pieces of `size` characters, as a stream would. */
function stream(text: string, size: number): { doc: MarkdownDoc; steps: number } {
  let doc: MarkdownDoc | undefined;
  let steps = 0;
  for (let end = Math.min(size, text.length); ; end = Math.min(end + size, text.length)) {
    const next = parseDoc(text.slice(0, end), doc);
    expect(next.blocks, `after ${end} characters`).toEqual(parseMarkdown(text.slice(0, end)));
    doc = next;
    steps++;
    if (end === text.length) return { doc, steps };
  }
}

describe('markdown parsed as it streams', () => {
  it('gives the same blocks as parsing the whole text, for every way of cutting it', () => {
    for (const size of [1, 2, 3, 5, 7, 13, 64, REPLY.length]) stream(REPLY, size);
  });

  it('gives the same blocks for random replies cut at random places', () => {
    const pieces = [
      'word ', 'two words', '\n', '\n\n', '- ', '1. ', '* item', '```', '```js', '# ', '### H', '**b**', '`c`', '\r\n', '  ', '_e_',
      '✓ ', '✗ ', '   ', 'FILES:', 'Test Results:', '| a | b |', '|---|---|', '+---+---+', '│ x │', 'src/a.ts:12', '/tmp/x.py', '  a  b', '\t',
    ];
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      let text = '';
      for (let n = 0; n < 40; n++) text += pieces[rand(pieces.length)];
      stream(text, 1 + rand(9));
    }
  });

  it('keeps the blocks that are done as the same objects, and starts over when the text is replaced', () => {
    const first = parseDoc('# Title\n\nFirst paragraph.\n\nSecond');
    const next = parseDoc('# Title\n\nFirst paragraph.\n\nSecond paragraph.', first);
    expect(next.blocks[0]).toBe(first.blocks[0]);
    expect(next.blocks[1]).toBe(first.blocks[1]);
    expect(next.blocks[2]).not.toBe(first.blocks[2]);
    expect(parseDoc('# Title\n\nFirst paragraph.\n\nSecond paragraph.', next)).toBe(next);
    const other = parseDoc('Something else', next);
    expect(other.blocks).toEqual(parseMarkdown('Something else'));
  });

  it('never changes a block an earlier document still shows', () => {
    // A lone "-" is a paragraph until its text comes; then it is a bullet that joins the list before it.
    const first = parseDoc('- a\n\n-');
    const list = first.blocks[0];
    const before = structuredClone(list);
    const next = parseDoc('- a\n\n- b', first);
    expect(list).toEqual(before);
    expect(next.blocks[0]).not.toBe(list);
    expect(next.blocks).toEqual([{ t: 'ul', items: [{ inline: [{ t: 'text', v: 'a' }] }, { inline: [{ t: 'text', v: 'b' }] }] }]);
  });
});

const text = (v: string): Inline => ({ t: 'text', v });
const items = (b: Block) => (b as ListBlock).items;

const SUMMARY = [
  'tmp/agent_heavy/minidb.py (561 lines)',
  'FEATURES IMPLEMENTED & VERIFIED:',
  '✓ DDL (Data Definition Language)',
  '  - CREATE TABLE (INT, TEXT, FLOAT types)',
  '  - DROP TABLE',
  '✓ DML',
  '✗ JOIN',
  'TEST RESULTS:',
  '1. test.sql - Core features (22 queries)',
  '   ✓ CREATE TABLE × 2',
  '2. demo.sql - More',
  'FILES:',
  '/tmp/agent_heavy/minidb.py (561 lines) - Main implementation',
  '/tmp/agent_heavy/test.sql - Tests',
].join('\n');

describe('plain-text replies keep their shape', () => {
  it('reads a structured summary as labels, nested lists with their symbols, and lines', () => {
    const blocks = parseMarkdown(SUMMARY);
    expect(blocks.map((b) => b.t)).toEqual(['p', 'label', 'ul', 'label', 'ol', 'label', 'p']);
    expect(blocks[1]).toEqual({ t: 'label', inline: [text('FEATURES IMPLEMENTED & VERIFIED')] });
    const features = items(blocks[2]);
    expect(features.map((i) => [i.mark, i.tone])).toEqual([
      ['✓', 'ok'],
      ['✓', 'ok'],
      ['✗', 'bad'],
    ]);
    expect(features[0].inline).toEqual([text('DDL (Data Definition Language)')]);
    expect(features[0].lists).toEqual([{ t: 'ul', items: [{ inline: [text('CREATE TABLE (INT, TEXT, FLOAT types)')] }, { inline: [text('DROP TABLE')] }] }]);
    const tests = items(blocks[4]);
    expect(tests).toHaveLength(2);
    expect(tests[0].inline[0]).toEqual({ t: 'path', v: 'test.sql', ref: { path: 'test.sql' } });
    expect(tests[0].lists?.[0].items[0]).toEqual({ inline: [text('CREATE TABLE × 2')], mark: '✓', tone: 'ok' });
    const files = (blocks[6] as { inline: Inline[] }).inline;
    expect(files.filter((i) => i.t === 'br')).toHaveLength(1);
    expect(files[0]).toEqual({ t: 'path', v: '/tmp/agent_heavy/minidb.py', ref: { path: '/tmp/agent_heavy/minidb.py' } });
    expect(files[1]).toEqual(text(' (561 lines) - Main implementation'));
  });

  it('keeps single newlines as line breaks', () => {
    expect(parseMarkdown('one\ntwo\n\nthree')).toEqual([
      { t: 'p', inline: [text('one'), { t: 'br' }, text('two')] },
      { t: 'p', inline: [text('three')] },
    ]);
  });

  it('makes lists of every bullet and symbol, and starts numbered lists where they start', () => {
    for (const mark of ['✓', '✔', '✗', '✘', '•', '→', '▸']) expect(items(parseMarkdown(`${mark} a\n${mark} b`)[0])).toHaveLength(2);
    expect(parseMarkdown('+ a\n* b')[0]).toMatchObject({ t: 'ul', items: [{}, {}] });
    expect(parseMarkdown('3. c\n4. d')[0]).toMatchObject({ t: 'ol', start: 3 });
    expect(parseMarkdown('- a\n1. b').map((b) => b.t)).toEqual(['ul', 'ol']);
    // A symbol needs a space after it to be a bullet.
    expect(parseMarkdown('→next')[0].t).toBe('p');
  });

  it('nests by indentation, continues items on indented lines, and ends at a fence', () => {
    const [list, code, rest] = parseMarkdown('1. Install:\n   on macOS too\n   ```bash\n   npm i\n   ```\n2. Run\n   - fast\n      - faster\n   - slow');
    expect(items(list)[0].inline).toEqual([text('Install:'), { t: 'br' }, text('on macOS too')]);
    expect(code).toEqual({ t: 'pre', lang: 'bash', code: '   npm i' });
    expect(rest).toMatchObject({ t: 'ol', start: 2 });
    const sub = items(rest)[0].lists![0];
    expect(sub.items.map((i) => i.inline)).toEqual([[text('fast')], [text('slow')]]);
    expect(sub.items[0].lists?.[0].items[0].inline).toEqual([text('faster')]);
  });

  it('makes short capital or Title Case lines ending in ":" labels, and nothing else', () => {
    for (const l of ['FILES:', 'TEST RESULTS:', 'FEATURES IMPLEMENTED & VERIFIED:', 'Next Steps:', 'Summary of the Changes:', 'Q4 RESULTS:']) expect(isLabel(l), l).toBe(true);
    for (const l of ['The following files changed:', 'Example output:', 'see https://x.com:', 'FILES: a.ts', '`code`:', 'a:', 'x'.repeat(70) + ':', '2024:', '      INDENTED:'])
      expect(isLabel(l), l).toBe(false);
  });

  it('renders GitHub tables with their alignment, and pads short rows', () => {
    expect(parseMarkdown('| File | Lines |\n|:---|---:|\n| a.py | 561 |\n| b |\nafter')).toEqual([
      { t: 'table', align: ['left', 'right'], head: [[text('File')], [text('Lines')]], rows: [[[{ t: 'path', v: 'a.py', ref: { path: 'a.py' } }], [text('561')]], [[text('b')], []]] },
      { t: 'p', inline: [text('after')] },
    ]);
  });

  it('keeps ASCII and box tables and aligned columns monospace, as they are', () => {
    const ascii = '+----+-------+\n| id | email |\n+----+-------+\n| 1  | a@b.c |\n+----+-------+';
    expect(parseMarkdown(`The rows:\n${ascii}\n(1 row)`)).toEqual([
      { t: 'p', inline: [text('The rows:')] },
      { t: 'mono', text: ascii },
      { t: 'p', inline: [text('(1 row)')] },
    ]);
    expect(parseMarkdown('┌──┐\n│ a│\n└──┘')).toEqual([{ t: 'mono', text: '┌──┐\n│ a│\n└──┘' }]);
    expect(parseMarkdown('NAME     AGE\nalice    28\nbob      35')).toEqual([{ t: 'mono', text: 'NAME     AGE\nalice    28\nbob      35' }]);
    // Two spaces in different places are prose, and rows without a border are text.
    expect(parseMarkdown('One.  Two.\nThree four.  Five.')[0].t).toBe('p');
    expect(parseMarkdown('| not | a table |')[0].t).toBe('p');
  });

  it('turns file paths into references with their line, and leaves other words alone', () => {
    expect(parseInline('see src/format.ts:12:3, then /tmp/agent_heavy/minidb.py.')).toEqual([
      text('see '),
      { t: 'path', v: 'src/format.ts:12:3', ref: { path: 'src/format.ts', line: 12, col: 3 } },
      text(', then '),
      { t: 'path', v: '/tmp/agent_heavy/minidb.py', ref: { path: '/tmp/agent_heavy/minidb.py' } },
      text('.'),
    ]);
    expect(parseInline('README.md and ./run.sh and C:\\work\\a.ts')).toEqual([
      { t: 'path', v: 'README.md', ref: { path: 'README.md' } },
      text(' and '),
      { t: 'path', v: './run.sh', ref: { path: './run.sh' } },
      text(' and '),
      { t: 'path', v: 'C:\\work\\a.ts', ref: { path: 'C:\\work\\a.ts' } },
    ]);
    for (const plain of ['561 lines', 'and/or', 'Node.js', 'alice@example.com', 'https://example.com/a/b.js', '2024/01/02', 'e.g. this', 'v1.2.3', 'I/O', '/tmp'])
      expect(parseInline(plain).some((i) => i.t === 'path'), plain).toBe(false);
    expect(parseInline('open `src/a.ts:4`')).toEqual([text('open '), { t: 'code', v: 'src/a.ts:4', ref: { path: 'src/a.ts', line: 4 } }]);
    expect(parseInline('run `npm test`')[1]).toEqual({ t: 'code', v: 'npm test' });
    expect(wholePath('docs/a.md:9')).toEqual({ path: 'docs/a.md', line: 9 });
  });

  it('keeps links https-only and fences with their language', () => {
    expect(parseInline('[a](file:///etc/passwd) [b](https://x.dev)')).toEqual([text('a'), text(' '), { t: 'link', v: 'b', href: 'https://x.dev' }]);
    expect(parseMarkdown('```c#\nvar a;\n```')).toEqual([{ t: 'pre', lang: 'c#', code: 'var a;' }]);
  });

  it('counts lines for collapsing long replies', () => {
    expect(lineCount('a')).toBe(1);
    expect(lineCount('a\nb\n')).toBe(3);
    expect(lineCount('x\n'.repeat(41))).toBe(42);
  });

  it('parses a streamed structured summary to the same blocks at every cut, reusing finished ones', () => {
    const reply = `${SUMMARY}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n+--+\n|x |\n+--+\n- last\n\n- joined`;
    for (const size of [1, 2, 3, 7, 19]) stream(reply, size);
    const first = parseDoc(reply.slice(0, reply.indexOf('TEST RESULTS:')));
    const next = parseDoc(reply, first);
    expect(next.blocks[0]).toBe(first.blocks[0]);
    expect(next.blocks[1]).toBe(first.blocks[1]);
  });
});
