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
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', inline: parseInline(para.join('\n')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i]);
      blocks.push({ t: 'pre', lang: fence[1], code: code.join('\n') });
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flush();
      blocks.push({ t: 'h', level: heading[1].length as 1 | 2 | 3, inline: parseInline(heading[2]) });
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/);
    if (bullet) {
      flush();
      const t = bullet[1] ? 'ol' : 'ul';
      const prev = blocks.at(-1);
      const item = parseInline(bullet[2]);
      if (prev && prev.t === t) prev.items.push(item);
      else blocks.push({ t, items: [item] });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
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
