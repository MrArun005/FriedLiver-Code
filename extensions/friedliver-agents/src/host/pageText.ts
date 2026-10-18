// browser_snapshot as readable text: the page's main content as compact markdown (headings, lists,
// links, code, tables) without navigation, footers, banners and other chrome, the interactive
// elements apart and only when asked (with short ids, e12, for browser_click and browser_type),
// a token budget, and on a re-snapshot of the same page only what changed.
// extractPage runs in the page (its source is sent as is, so it uses nothing outside itself);
// the rest runs in the extension host. No vscode here, so all of it is tested.
import { unifiedDiff } from '../shared/diff';
import { estimateTokens } from '../shared/tokens';

export interface PageData {
  title: string;
  url: string;
  /** Markdown lines of the main content, links with their full URLs. */
  lines: string[];
  /** `e12 button "Save"` lines. */
  elements: string[];
  /** The last element id given out, so ids stay stable across snapshots of the page. */
  next: number;
}

/** The DOM this needs: a real document in the page, a parsed fake in tests. */
interface El {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<El>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

export const SNAPSHOT_LIMITS = { budget: 2500, minBudget: 200, maxBudget: 20000, elements: 300 };

/**
 * Walks the page in the browser. `visible` says whether an element is shown (computed style and
 * size in the page). Must stay self-contained: its source is evaluated in the page.
 */
export function extractPage(doc: El, visible: (el: El) => boolean, info: { title: string; url: string; start: number }): PageData {
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|IFRAME|HEAD|META|LINK|OBJECT|EMBED)$/;
  const CHROME_TAG = /^(NAV|FOOTER|ASIDE|DIALOG)$/;
  const CONTROL = /^(BUTTON|INPUT|SELECT|TEXTAREA|OPTION)$/;
  const CHROME_ROLE = /^(navigation|banner|contentinfo|complementary|search|dialog|alertdialog|menu|menubar|toolbar)$/;
  const NOISE = /(^|[\s_-])(cookies?|consent|gdpr|advert|ads?|promo|newsletter|subscribe|share|sharing|social|related|related-articles|sidebar|breadcrumbs?|skip-link|popup|modal|feedback|rating|comments?)([\s_-]|$)/i;
  const BLOCK = /^(P|DIV|SECTION|ARTICLE|MAIN|HEADER|UL|OL|LI|TABLE|THEAD|TBODY|TFOOT|TR|PRE|BLOCKQUOTE|DL|DT|DD|FIGURE|FIGCAPTION|H[1-6]|HR|BR|FORM|FIELDSET|DETAILS|SUMMARY|ADDRESS)$/;
  const kids = (el: El): El[] => Array.prototype.slice.call(el.childNodes) as El[];
  const textOf = (el: El): string => (el.nodeType === 3 ? (el.nodeValue ?? '') : el.nodeType === 1 && !SKIP.test(el.nodeName) ? kids(el).map(textOf).join('') : '');
  const squash = (s: string) => s.replace(/\s+/g, ' ');
  const isChrome = (el: El, inMain: boolean) => {
    const role = el.getAttribute('role') ?? '';
    const marks = `${el.getAttribute('class') ?? ''} ${el.getAttribute('id') ?? ''}`;
    return CHROME_TAG.test(el.nodeName) || (el.nodeName === 'HEADER' && !inMain) || CHROME_ROLE.test(role) || NOISE.test(marks) || el.getAttribute('aria-hidden') === 'true';
  };
  const href = (el: El) => {
    const h = el.getAttribute('href');
    if (!h || /^\s*(javascript|data|vbscript):/i.test(h) || h.startsWith('#')) return '';
    try {
      return new URL(h, info.url).href;
    } catch {
      return '';
    }
  };

  // The main content: <main>/role=main, else the one <article>, else the element whose paragraphs hold the most text.
  let body: El = doc;
  const all: El[] = [];
  const collect = (el: El) => {
    for (const c of kids(el)) {
      if (c.nodeType !== 1 || SKIP.test(c.nodeName)) continue;
      all.push(c);
      if (c.nodeName === 'BODY') body = c;
      collect(c);
    }
  };
  collect(doc);
  let root = all.find((e) => e.nodeName === 'MAIN' || e.getAttribute('role') === 'main');
  const articles = all.filter((e) => e.nodeName === 'ARTICLE');
  if (!root && articles.length === 1) root = articles[0];
  if (!root) {
    const score = new Map<El, number>();
    const parent = new Map<El, El>();
    const link = (el: El) => {
      for (const c of kids(el)) {
        if (c.nodeType !== 1) continue;
        parent.set(c, el);
        link(c);
      }
    };
    link(doc);
    for (const p of all) {
      if (p.nodeName !== 'P' && p.nodeName !== 'PRE') continue;
      const n = squash(textOf(p)).length;
      const up = parent.get(p);
      if (up) score.set(up, (score.get(up) ?? 0) + n);
      const up2 = up && parent.get(up);
      if (up2) score.set(up2, (score.get(up2) ?? 0) + n / 2);
    }
    let best: El | undefined;
    for (const [el, s] of score) if (s >= 200 && (!best || s > score.get(best)!)) best = el;
    root = best ?? body;
  }
  const inMain = root !== body;

  const lines: string[] = [];
  let buf = '';
  let prefix = '';
  const flush = () => {
    const t = squash(buf).trim();
    if (t) lines.push(prefix + t);
    buf = '';
  };
  const inline = (el: El): string => {
    if (el.nodeType === 3) return el.nodeValue ?? '';
    if (el.nodeType !== 1 || SKIP.test(el.nodeName) || CONTROL.test(el.nodeName) || !visible(el)) return '';
    const inner = () => kids(el).map(inline).join('');
    switch (el.nodeName) {
      case 'A': {
        const t = squash(inner()).trim();
        const h = href(el);
        return t && h ? `[${t}](${h})` : t;
      }
      case 'CODE':
      case 'KBD':
      case 'SAMP': {
        const t = squash(textOf(el)).trim();
        return t ? `\`${t}\`` : '';
      }
      case 'BR':
        return '\n';
      case 'IMG': {
        const alt = squash(el.getAttribute('alt') ?? '').trim();
        return alt ? `(image: ${alt})` : '';
      }
      default:
        return inner();
    }
  };
  const walk = (el: El, depth: number, quote: string) => {
    for (const c of kids(el)) {
      if (c.nodeType === 3) {
        buf += c.nodeValue ?? '';
        continue;
      }
      // Controls are listed as elements, not read as content.
      if (c.nodeType !== 1 || SKIP.test(c.nodeName) || CONTROL.test(c.nodeName) || !visible(c) || isChrome(c, inMain)) continue;
      const tag = c.nodeName;
      if (!BLOCK.test(tag)) {
        buf += inline(c);
        continue;
      }
      flush();
      if (/^H[1-6]$/.test(tag)) {
        prefix = `${quote}${'#'.repeat(Number(tag[1]))} `;
        buf = inline(c);
        flush();
      } else if (tag === 'UL' || tag === 'OL') {
        let n = 0;
        for (const li of kids(c)) {
          if (li.nodeType !== 1 || li.nodeName !== 'LI' || !visible(li) || isChrome(li, inMain)) continue;
          prefix = `${quote}${'  '.repeat(depth)}${tag === 'OL' ? `${++n}.` : '-'} `;
          walk(li, depth + 1, quote);
          flush();
        }
      } else if (tag === 'PRE') {
        const code = textOf(c).replace(/\n+$/, '').split('\n');
        lines.push('```', ...code.slice(0, 120), ...(code.length > 120 ? [`… ${code.length - 120} more lines`] : []), '```');
      } else if (tag === 'TABLE') {
        const rows: string[] = [];
        const visit = (e: El) => {
          for (const r of kids(e)) {
            if (r.nodeType !== 1) continue;
            if (r.nodeName === 'TR') {
              const cells = kids(r).filter((d) => d.nodeType === 1 && (d.nodeName === 'TD' || d.nodeName === 'TH'));
              rows.push(cells.map((d) => squash(kids(d).map(inline).join('')).trim()).join(' | '));
            } else if (/^(THEAD|TBODY|TFOOT)$/.test(r.nodeName)) visit(r);
          }
        };
        visit(c);
        lines.push(...rows.slice(0, 60).map((r) => quote + r), ...(rows.length > 60 ? [`… ${rows.length - 60} more rows`] : []));
      } else if (tag === 'BLOCKQUOTE') {
        prefix = `${quote}> `;
        walk(c, depth, `${quote}> `);
        flush();
      } else if (tag === 'HR' || tag === 'BR') {
        // A break: the flush above did it.
      } else {
        const keep = prefix;
        walk(c, depth, quote);
        flush();
        prefix = keep;
        continue;
      }
      prefix = quote ? `${quote}` : '';
    }
  };
  walk(root, 0, '');
  flush();

  // Every interactive element on the page, in order, each with a stable id in data-fl.
  let next = info.start;
  const elements: string[] = [];
  const ACT = /^(A|BUTTON|INPUT|TEXTAREA|SELECT|SUMMARY)$/;
  const ROLE = /^(button|link|checkbox|radio|tab|menuitem|switch|combobox|textbox|option)$/;
  const scan = (el: El, shown: boolean) => {
    for (const c of kids(el)) {
      if (c.nodeType !== 1 || SKIP.test(c.nodeName)) continue;
      const on = shown && visible(c);
      if (!on) continue;
      const role = c.getAttribute('role') ?? '';
      const type = (c.getAttribute('type') ?? '').toLowerCase();
      const act = (ACT.test(c.nodeName) && !(c.nodeName === 'A' && c.getAttribute('href') === null) && type !== 'hidden') || ROLE.test(role) || c.getAttribute('contenteditable') === 'true';
      if (act && elements.length < 300) {
        let id = c.getAttribute('data-fl');
        if (!id) c.setAttribute('data-fl', (id = String(++next)));
        const kind = role || (c.nodeName === 'A' ? 'link' : c.nodeName.toLowerCase() + (type && c.nodeName === 'INPUT' ? `[${type}]` : ''));
        const value = type === 'password' || c.nodeName !== 'INPUT' ? '' : (c.getAttribute('value') ?? '');
        const name = squash(c.getAttribute('aria-label') || value || textOf(c) || c.getAttribute('placeholder') || c.getAttribute('title') || c.getAttribute('alt') || '')
          .trim()
          .slice(0, 80);
        const checked = type === 'checkbox' || type === 'radio' ? (c.getAttribute('checked') !== null ? ' [x]' : ' [ ]') : '';
        const h = c.nodeName === 'A' ? href(c) : '';
        elements.push(`e${id} ${kind}${checked} "${name}"${h ? ` → ${h}` : ''}`);
      }
      scan(c, on);
    }
  };
  scan(doc, true);
  return { title: info.title, url: info.url, lines, elements, next };
}

/** A link for the agent: same-site ones as a path, no tracking parameters, long ones cut. Empty for script URLs. */
export function shortUrl(href: string, base: string): string {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'mailto:') return '';
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$)/i.test(k)) u.searchParams.delete(k);
  let s = u.href;
  try {
    if (u.origin === new URL(base).origin) s = u.pathname + u.search + u.hash;
  } catch {
    // A base that isn't a URL: keep the absolute link.
  }
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

/** An element id from browser_snapshot (e12) as the selector it stands for; anything else as is. */
export const toSelector = (s: string): string => (/^e\d{1,7}$/.test(s) ? `[data-fl="${s.slice(1)}"]` : s);

/** The page as the agent gets it: title, URL, content, and the elements or a count of them, within `budget` tokens. */
export function renderPage(page: PageData, opts: { elements?: boolean; budget?: number }): string {
  const budget = opts.budget ?? SNAPSHOT_LIMITS.budget;
  const link = (line: string) =>
    line
      .replace(/\]\(([^)\s]+)\)/g, (_m, h: string) => `](${shortUrl(h, page.url)})`)
      .replace(/\[([^\]]*)\]\(\)/g, '$1');
  const target = (line: string) => line.replace(/ → (\S+)$/, (_m, h: string) => (shortUrl(h, page.url) ? ` → ${shortUrl(h, page.url)}` : ''));
  const head = `# ${page.title || '(untitled)'}\nURL: ${page.url}`;
  const body = opts.elements
    ? [`Elements (${page.elements.length}${page.elements.length >= SNAPSHOT_LIMITS.elements ? '+' : ''}), for browser_click and browser_type as selector:`, ...page.elements.map(target)]
    : [...page.lines.map(link), '', `Interactive: ${page.elements.length} elements (browser_snapshot with elements: true lists them)`];
  const out = [head];
  let used = estimateTokens(head) + 30;
  for (let i = 0; i < body.length; i++) {
    const t = estimateTokens(body[i]) + 1;
    if (used + t > budget) {
      const rest = body.slice(i).reduce((n, l) => n + estimateTokens(l) + 1, 0);
      out.push(`… cut at the ${budget}-token budget: about ${rest} more tokens (raise budget)`);
      break;
    }
    used += t;
    out.push(body[i]);
  }
  return out.join('\n');
}

/** Each chat's last snapshot of a page, so a re-snapshot can be just the change. */
export class PageMemory {
  private readonly last = new Map<string, { url: string; text: string }>();

  answer(chatId: string, page: PageData, opts: { elements?: boolean; budget?: number; full?: boolean }): string {
    // The diff sees the whole page (a large budget); what is sent keeps to the asked budget.
    const text = renderPage(page, { ...opts, budget: Math.max(opts.budget ?? SNAPSHOT_LIMITS.budget, SNAPSHOT_LIMITS.maxBudget) });
    const key = `${chatId}\0${opts.elements ? 'e' : 't'}`;
    const prev = this.last.get(key);
    this.last.delete(key);
    this.last.set(key, { url: page.url, text });
    if (this.last.size > 64) this.last.delete(this.last.keys().next().value!);
    if (!opts.full && prev && prev.url === page.url) {
      if (prev.text === text) return `# ${page.title}\nURL: ${page.url}\nNo change since your last snapshot of this page (full: true for all of it).`;
      const d = unifiedDiff(prev.text, text, 1);
      if (d && estimateTokens(d.text) < estimateTokens(text) / 2) {
        return `# ${page.title}\nURL: ${page.url}\nChanged since your last snapshot of this page (+${d.added} -${d.removed}; full: true for all of it):\n${d.text}`;
      }
    }
    return renderPage(page, opts);
  }
}
