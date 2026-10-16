// Just enough Markdown for agent replies, parsed to data and rendered as
// elements (never innerHTML), so agent text can't inject markup.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; v: string }
  | { t: 'em'; v: string }
  | { t: 'link'; v: string; href: string };

export type Block =
  | { t: 'p'; inline: Inline[] }
  | { t: 'h'; level: 1 | 2 | 3; inline: Inline[] }
  | { t: 'ul' | 'ol'; items: Inline[][] }
  | { t: 'pre'; lang: string; code: string };

export function parseMarkdown(text: string): Block[] {
  return parseDoc(text).blocks;
}

/** A parsed reply, kept so the next, longer version of it parses only its tail. */
export interface MarkdownDoc {
  /** The text with \r\n line ends made \n. */
  text: string;
  blocks: Block[];
  /** Where each block's first line starts in `text`. */
  starts: number[];
}

/**
 * parseMarkdown, reusing `prev` when `text` only adds to the text it parsed:
 * a streamed reply grows a few words at a time, and parsing all of it again
 * for every chunk made long replies slower and slower. Every block but the
 * last is final (a later line can only extend the last one), so those are
 * kept, as the same objects, and parsing starts again at the last one. The
 * result is always what parseMarkdown(text) gives.
 */
export function parseDoc(text: string, prev?: MarkdownDoc): MarkdownDoc {
  const norm = text.includes('\r') ? text.replace(/\r\n/g, '\n') : text;
  if (prev && norm === prev.text) return prev;
  if (prev && prev.blocks.length > 0 && norm.startsWith(prev.text)) {
    const last = prev.blocks.length - 1;
    const doc = { text: norm, blocks: prev.blocks.slice(0, last), starts: prev.starts.slice(0, last) };
    parseFrom(doc, prev.starts[last]);
    return doc;
  }
  const doc = { text: norm, blocks: [], starts: [] };
  parseFrom(doc, 0);
  return doc;
}

/** Parses `doc.text` from `from`, a line start where no paragraph or code block is open, after `doc.blocks`. */
function parseFrom(doc: MarkdownDoc, from: number): void {
  const { blocks, starts } = doc;
  // Blocks before `kept` may be another document's too: copy before changing one.
  let kept = blocks.length;
  const lines = doc.text.slice(from).split('\n');
  let at = from;
  const offsets = lines.map((l) => {
    const o = at;
    at += l.length + 1;
    return o;
  });
  let para: string[] = [];
  let paraStart = 0;
  const push = (block: Block, start: number) => {
    blocks.push(block);
    starts.push(start);
  };
  const flush = () => {
    if (para.length) push({ t: 'p', inline: parseInline(para.join('\n')) }, paraStart);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      flush();
      const start = offsets[i];
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i]);
      push({ t: 'pre', lang: fence[1], code: code.join('\n') }, start);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flush();
      push({ t: 'h', level: heading[1].length as 1 | 2 | 3, inline: parseInline(heading[2]) }, offsets[i]);
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/);
    if (bullet) {
      flush();
      const t = bullet[1] ? 'ol' : 'ul';
      const n = blocks.length - 1;
      const prev = blocks[n];
      const item = parseInline(bullet[2]);
      if (prev && prev.t === t) {
        if (n < kept) {
          blocks[n] = { t, items: [...prev.items, item] };
          kept = n;
        } else prev.items.push(item);
      } else push({ t, items: [item] }, offsets[i]);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (!para.length) paraStart = offsets[i];
    para.push(line);
  }
  flush();
}

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|(?<![\w*])\*[^*\s][^*\n]*\*(?![\w*])|(?<!\w)_[^_\s][^_\n]*_(?!\w)|\[[^\]\n]+\]\([^)\s]+\))/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  for (const token of text.split(INLINE)) {
    if (!token) continue;
    if (token.length > 1 && token.startsWith('`') && token.endsWith('`')) out.push({ t: 'code', v: token.slice(1, -1) });
    else if (token.length > 4 && token.startsWith('**') && token.endsWith('**')) out.push({ t: 'strong', v: token.slice(2, -2) });
    else if (token.length > 2 && /^([*_]).*\1$/s.test(token)) out.push({ t: 'em', v: token.slice(1, -1) });
    else {
      const link = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      // Only web links become links; anything else (javascript:, file:, command:) stays text.
      if (link && /^https:\/\//i.test(link[2])) out.push({ t: 'link', v: link[1], href: link[2] });
      else if (link) out.push({ t: 'text', v: link[1] });
      else out.push({ t: 'text', v: token });
    }
  }
  return out;
}
