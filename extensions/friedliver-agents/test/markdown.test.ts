import { describe, expect, it } from 'vitest';
import { parseDoc, parseMarkdown, type MarkdownDoc } from '../src/shared/markdown';

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
    const pieces = ['word ', 'two words', '\n', '\n\n', '- ', '1. ', '* item', '```', '```js', '# ', '### H', '**b**', '`c`', '\r\n', '  ', '_e_'];
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
    expect(next.blocks).toEqual([{ t: 'ul', items: [[{ t: 'text', v: 'a' }], [{ t: 'text', v: 'b' }]] }]);
  });
});
