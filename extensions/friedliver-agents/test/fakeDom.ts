// A tolerant HTML parser into the small DOM subset extractPage (src/host/pageText.ts) walks, so the
// page script is tested without a browser, plus the old snapshot (elements + innerText) emulated on
// the same tree as the token bench's "before". Test-only; not a conforming HTML parser.

export interface FakeNode {
  nodeType: 1 | 3;
  nodeName: string;
  nodeValue: string | null;
  childNodes: FakeNode[];
  parentNode: FakeNode | null;
  attrs: Map<string, string>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

const VOID = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'SOURCE', 'TRACK', 'WBR']);
const RAW = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'TITLE']);
/** Opening one of these closes an open element of the listed kinds (a minimal implied-end-tag rule). */
const CLOSES: Record<string, string[]> = { P: ['P'], LI: ['LI', 'P'], TR: ['TR', 'TD', 'TH'], TD: ['TD', 'TH'], TH: ['TD', 'TH'], DT: ['DT', 'DD'], DD: ['DT', 'DD'], OPTION: ['OPTION'] };
const BLOCKS = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'UL', 'OL', 'TABLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'FORM', 'BLOCKQUOTE']);

function node(nodeType: 1 | 3, nodeName: string, nodeValue: string | null = null): FakeNode {
  const attrs = new Map<string, string>();
  return {
    nodeType,
    nodeName,
    nodeValue,
    childNodes: [],
    parentNode: null,
    attrs,
    getAttribute: (n) => attrs.get(n.toLowerCase()) ?? null,
    setAttribute: (n, v) => void attrs.set(n.toLowerCase(), v),
  };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
  );

export function parseHtml(html: string): { document: FakeNode; title: string } {
  const doc = node(1, '#document');
  const stack: FakeNode[] = [doc];
  const top = () => stack[stack.length - 1];
  const append = (n: FakeNode) => {
    n.parentNode = top();
    top().childNodes.push(n);
  };
  const close = (name: string) => {
    const i = stack.map((n) => n.nodeName).lastIndexOf(name);
    if (i > 0) stack.length = i;
  };
  let title = '';
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[i] === '<' && /[!?/A-Za-z]/.test(html[i + 1] ?? '')) {
      const end = html.indexOf('>', i);
      if (end < 0) break;
      const tag = html.slice(i + 1, end);
      i = end + 1;
      if (tag[0] === '!' || tag[0] === '?') continue;
      if (tag[0] === '/') {
        close(tag.slice(1).trim().toUpperCase());
        continue;
      }
      const m = /^([A-Za-z][\w:-]*)([\s\S]*?)\/?$/.exec(tag);
      if (!m) continue;
      const name = m[1].toUpperCase();
      for (const c of CLOSES[name] ?? []) if (stack.some((n) => n.nodeName === c)) close(c);
      if (BLOCKS.has(name) && stack.some((n) => n.nodeName === 'P')) close('P');
      const el = node(1, name);
      for (const a of m[2].matchAll(/([^\s=/]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) el.setAttribute(a[1], decode(a[3] ?? a[4] ?? a[5] ?? ''));
      append(el);
      if (RAW.has(name)) {
        const close = html.toLowerCase().indexOf(`</${name.toLowerCase()}`, i);
        const raw = html.slice(i, close < 0 ? html.length : close);
        if (name === 'TITLE') title ||= decode(raw).trim();
        else if (raw) {
          const t = node(3, '#text', name === 'TEXTAREA' ? decode(raw) : raw);
          t.parentNode = el;
          el.childNodes.push(t);
        }
        i = close < 0 ? html.length : html.indexOf('>', close) + 1;
        continue;
      }
      if (!VOID.has(name)) stack.push(el);
      continue;
    }
    const next = html.indexOf('<', i + 1);
    const text = html.slice(i, next < 0 ? html.length : next);
    i = next < 0 ? html.length : next;
    if (text) append(node(3, '#text', decode(text)));
  }
  return { document: doc, title };
}

/** Hidden by the markup itself: what a test can know of computed style. */
export const fakeVisible = (el: FakeNode): boolean => {
  if (el.getAttribute('hidden') !== null || el.getAttribute('aria-hidden') === 'true') return false;
  if (el.nodeName === 'INPUT' && el.getAttribute('type') === 'hidden') return false;
  return !/display\s*:\s*none|visibility\s*:\s*hidden/i.test(el.getAttribute('style') ?? '');
};

const INNER_BLOCK = new Set([...BLOCKS, 'P', 'LI', 'TR', 'BR', 'DT', 'DD', 'HR', 'FIGURE', 'FIGCAPTION']);

/** What the old browser_snapshot returned: elements with selectors, then document.body.innerText (≤ 20,000 chars). */
export function oldSnapshot(doc: FakeNode, title: string, url: string): string {
  const all: FakeNode[] = [];
  const visit = (n: FakeNode) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 1 && fakeVisible(c)) {
        all.push(c);
        visit(c);
      }
    }
  };
  visit(doc);
  const textOf = (n: FakeNode): string => (n.nodeType === 3 ? (n.nodeValue ?? '') : n.childNodes.map(textOf).join(''));
  const lines: string[] = [];
  let k = 0;
  for (const el of all) {
    const tag = el.nodeName.toLowerCase();
    const role = el.getAttribute('role');
    const act = (tag === 'a' && el.getAttribute('href') !== null) || ['button', 'input', 'textarea', 'select', 'summary'].includes(tag) || /^(button|link|checkbox|tab|menuitem)$/.test(role ?? '');
    if (!act) continue;
    const type = el.getAttribute('type');
    const kind = role || tag + (type && tag !== 'button' ? `[${type}]` : '');
    const name = (el.getAttribute('aria-label') || (type === 'password' ? '' : el.getAttribute('value')) || textOf(el) || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const href = el.getAttribute('href');
    const abs = href ? (() => { try { return new URL(href, url).href; } catch { return href; } })() : '';
    lines.push(`[data-fl="${++k}"]  ${kind} "${name}"${abs ? ` -> ${abs}` : ''}`);
    if (lines.length >= 300) {
      lines.push('…more elements not listed');
      break;
    }
  }
  const inner = (n: FakeNode): string => {
    if (n.nodeType === 3) return (n.nodeValue ?? '').replace(/\s+/g, ' ');
    if (!fakeVisible(n) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD'].includes(n.nodeName)) return '';
    const body = n.childNodes.map(inner).join('');
    return INNER_BLOCK.has(n.nodeName) ? `\n${body}\n` : n.nodeName === 'TD' || n.nodeName === 'TH' ? `${body}\t` : body;
  };
  const text = inner(doc).replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000);
  return `Title: ${title}\nURL: ${url}\n\nElements:\n${lines.join('\n')}\n\nText:\n${text}`;
}
