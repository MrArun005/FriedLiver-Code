// The design system is the only place that draws controls (COMPONENTS.md §3, owner's rule).
//
//  1. View stylesheets (media/*.css other than tokens.css and components.css) may not hold raw
//     colours, raw px for radius / height / padding / font-size, or box-shadow / backdrop-filter
//     values that aren't a token; and may not restyle a button, pill, field or component — only
//     place it (margin, flex, grid, position, width, display).
//  2. Webview and phone-app TSX outside src/webview/ui/ may not draw a raw <button>, <input>, <textarea> or <select>.
//
// What the code did before the rule is the baseline (test/fixtures/ds-baseline.json). It is a
// ratchet: a count above it fails, and so does one below it until the baseline is lowered to
// match, so the improvement can't be lost. Lower it with:
//   DS_BASELINE=write npx vitest run test/designSystem.test.ts
// which refuses to raise anything. Merging a branch written before this rule: record its counts once,
// in the merge commit, with DS_BASELINE=write DS_BASELINE_INIT=1, then ratchet them down.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..');
const media = path.join(root, 'media');
const src = path.join(root, 'src');
// Every surface's TSX: the webviews and the phone app (FriedLiver Remote).
const SURFACES = [path.join(src, 'webview'), path.join(src, 'remote/phone')];
const baselineFile = path.join(__dirname, 'fixtures/ds-baseline.json');
const SYSTEM = new Set(['tokens.css', 'components.css']);

interface Decl {
  selector: string;
  prop: string;
  value: string;
}

/** Every declaration with its rule's selector; nested @media/@container/@supports/@keyframes flattened. */
export function declarations(css: string): Decl[] {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Decl[] = [];
  const walk = (text: string, outer: string) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      for (; j < text.length && depth; j++) depth += text[j] === '{' ? 1 : text[j] === '}' ? -1 : 0;
      const body = text.slice(open + 1, j - 1);
      if (prelude.startsWith('@keyframes')) walk(body, prelude);
      else if (prelude.startsWith('@')) walk(body, outer);
      else
        for (const d of body.split(';')) {
          const c = d.indexOf(':');
          if (c > 0) out.push({ selector: outer ? `${outer} ${prelude}` : prelude, prop: d.slice(0, c).trim().toLowerCase(), value: d.slice(c + 1).trim() });
        }
      i = j;
    }
  };
  walk(css, '');
  return out;
}

/** The value with every var(...) (fallbacks included) removed: what's left is literal. */
const withoutVars = (v: string) => {
  let s = v;
  for (let k = s.indexOf('var('); k >= 0; k = s.indexOf('var(')) {
    let depth = 0;
    let e = k + 3;
    for (; e < s.length; e++) {
      if (s[e] === '(') depth++;
      else if (s[e] === ')' && --depth === 0) break;
    }
    s = s.slice(0, k) + s.slice(e + 1);
  }
  return s;
};

const NAMED = /\b(white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|silver|navy|teal|maroon|olive|lime|aqua|fuchsia)\b/i;
const colourLiteral = (v: string) => /#[0-9a-f]{3,8}\b/i.test(v) || (/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i.test(v) && !/\(from var\(/.test(v)) || NAMED.test(v);
const SIZE_PROPS = /^(border(-[a-z]+)*-radius|height|min-height|max-height|padding(-[a-z]+)*|font-size|font|line-height)$/;
const pxLiteral = (d: Decl) =>
  SIZE_PROPS.test(d.prop) && (/\d(\.\d+)?px\b/.test(withoutVars(d.value)) || (d.prop === 'font-size' && /\d(\.\d+)?(em|rem|%)\b/.test(withoutVars(d.value)) && !/^0$/.test(d.value)));
const effectLiteral = (d: Decl) => /^(box-shadow|backdrop-filter|-webkit-backdrop-filter)$/.test(d.prop) && !/^(none|var\(--[\w-]+\)(\s*,\s*var\(--[\w-]+\))*)$/.test(d.value.trim());

// What a view may set on a component: where it sits, not what it looks like.
const LAYOUT =
  /^(margin(-[a-z]+)*|flex(-[a-z]+)*|order|align-self|justify-self|place-self|grid(-[a-z]+)*|position|top|right|bottom|left|inset(-[a-z]+)*|z-index|display|visibility|width|min-width|max-width|container(-[a-z]+)*|pointer-events|cursor|--[\w-]+)$/;
const CONTROL_ELEMENT = /(^|[\s>+~])(button|input|textarea|select)(?![\w-])/;
const CONTROL_CLASS = /\.(?:fl-[\w-]+|[\w-]*(?:btn|button|pill|chip|seg|switch|toggle|input|search|badge|count|kbd|tag|tab)(?:-[\w-]+)?)(?![\w-])/;
const CONTROL_ROLE = /\[role\^?=['"]?(menuitem|switch|tab|radio|checkbox|option)/;

/** The selector's subject (its last compound), with :has()/:not()/:is()/:where() bodies dropped. */
const subject = (sel: string) => {
  const flat = sel.replace(/:(has|not|is|where)\((?:[^()]|\([^()]*\))*\)/g, '');
  const parts = flat.trim().split(/\s*[\s>+~]\s*/);
  return ` ${parts[parts.length - 1]}`;
};
const restylesControl = (d: Decl) => {
  if (LAYOUT.test(d.prop) || d.selector.startsWith('@keyframes')) return false;
  return d.selector.split(',').some((part) => {
    const s = subject(part);
    return CONTROL_ELEMENT.test(s) || CONTROL_CLASS.test(s) || CONTROL_ROLE.test(s);
  });
};

function cssReport(file: string) {
  const ds = declarations(readFileSync(path.join(media, file), 'utf8'));
  const restyle = new Set<string>();
  for (const d of ds) if (restylesControl(d)) for (const part of d.selector.split(',')) if (restylesControl({ ...d, selector: part.trim() })) restyle.add(part.trim().replace(/\s+/g, ' '));
  return {
    colour: ds.filter((d) => !d.prop.startsWith('--') && colourLiteral(d.value)).length,
    px: ds.filter(pxLiteral).length,
    effect: ds.filter(effectLiteral).length,
    restyle: [...restyle].sort(),
  };
}

const tsxFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? (f === 'ui' ? [] : tsxFiles(p)) : f.endsWith('.tsx') ? [p] : [];
  });
const rawControls = (file: string) => (readFileSync(file, 'utf8').match(/<(button|input|textarea|select)\b/g) ?? []).length;

function current() {
  const css = Object.fromEntries(
    readdirSync(media)
      .filter((f) => f.endsWith('.css') && !SYSTEM.has(f))
      .sort()
      .map((f) => [f, cssReport(f)]),
  );
  const tsx = Object.fromEntries(
    SURFACES.flatMap(tsxFiles)
      .map((f) => [path.relative(src, f), rawControls(f)] as const)
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return { css, tsx };
}
type Report = ReturnType<typeof current>;

const totals = (r: Report) => ({
  colour: Object.values(r.css).reduce((n, c) => n + c.colour, 0),
  px: Object.values(r.css).reduce((n, c) => n + c.px, 0),
  effect: Object.values(r.css).reduce((n, c) => n + c.effect, 0),
  restyle: Object.values(r.css).reduce((n, c) => n + c.restyle.length, 0),
  rawControls: Object.values(r.tsx).reduce((n, c) => n + c, 0),
});

const now = current();

if (process.env.DS_BASELINE === 'write') {
  let old: Report | undefined;
  try {
    old = JSON.parse(readFileSync(baselineFile, 'utf8')) as Report;
  } catch {
    old = undefined;
  }
  if (old && process.env.DS_BASELINE_INIT !== '1') {
    const o = totals(old);
    const n = totals(now);
    for (const k of Object.keys(n) as (keyof typeof n)[]) if (n[k] > o[k]) throw new Error(`DS_BASELINE=write refuses to raise ${k}: ${o[k]} → ${n[k]}`);
    for (const [f, c] of Object.entries(now.css)) {
      const was = new Set(old.css[f]?.restyle ?? []);
      const added = c.restyle.filter((s) => !was.has(s));
      if (added.length) throw new Error(`DS_BASELINE=write refuses new restyling selectors in ${f}: ${added.join(' | ')}`);
    }
  }
  writeFileSync(baselineFile, `${JSON.stringify({ ...now, totals: totals(now) }, null, 2)}\n`);
}

const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')) as Report;
const lower = 'lower test/fixtures/ds-baseline.json: DS_BASELINE=write npx vitest run test/designSystem.test.ts';

describe('the design system draws every control', () => {
  for (const [file, c] of Object.entries(now.css)) {
    const b = baseline.css[file] ?? { colour: 0, px: 0, effect: 0, restyle: [] };
    it(`${file}: no new raw colours, px sizes or shadow literals (use tokens.css)`, () => {
      expect(c.colour, `raw colour literals in ${file}`).toBeLessThanOrEqual(b.colour);
      expect(c.px, `raw px for radius/height/padding/font-size in ${file}`).toBeLessThanOrEqual(b.px);
      expect(c.effect, `box-shadow/backdrop-filter literals in ${file}`).toBeLessThanOrEqual(b.effect);
      expect([c.colour, c.px, c.effect], `${file} got better: ${lower}`).toEqual([b.colour, b.px, b.effect]);
    });
    it(`${file}: restyles no button, pill, field or component (use components.css)`, () => {
      const was = new Set(b.restyle);
      expect(
        c.restyle.filter((s) => !was.has(s)),
        'new selectors that restyle a control: use a component, or add a variant to components.css',
      ).toEqual([]);
      expect(
        b.restyle.filter((s) => !c.restyle.includes(s)),
        `restyling selectors removed: ${lower}`,
      ).toEqual([]);
    });
  }

  it('webview TSX draws no raw <button>/<input>/<textarea>/<select> outside src/webview/ui/', () => {
    for (const [file, n] of Object.entries(now.tsx)) expect(n, `${file}: raw controls (use src/webview/ui)`).toBeLessThanOrEqual(baseline.tsx[file] ?? 0);
    expect(now.tsx, `fewer raw controls: ${lower}`).toEqual(baseline.tsx);
  });

  it('the checks catch what they should', () => {
    const r = declarations(
      `.x{color:#fff;border-radius:4px;box-shadow:0 1px 2px var(--a)} @media (x){.card button.sm{background:red;margin:0}} .ok{padding:var(--sp-2);box-shadow:var(--elev-1)} .y:has(.fl-dot){color:var(--fg)}`,
    );
    expect(r.filter((d) => colourLiteral(d.value)).length).toBe(2);
    expect(r.filter(pxLiteral).length).toBe(1);
    expect(r.filter(effectLiteral).length).toBe(1);
    expect(r.filter(restylesControl).map((d) => d.prop)).toEqual(['background']);
    expect(withoutVars('calc(var(--a, 4px) + 2px)')).toBe('calc( + 2px)');
  });
});

describe('component states that QA caught', () => {
  const sys = declarations(readFileSync(path.join(media, 'components.css'), 'utf8'));
  const parts = (d: Decl) => d.selector.split(',').map((s) => s.trim());

  it('no later state rule (selected, hover…) hides a control’s focus ring', () => {
    const hidden: string[] = [];
    sys.forEach((d, i) => {
      if (!d.prop.startsWith('outline') || d.prop === 'outline-offset') return;
      for (const p of parts(d)) {
        const m = /^([.\w-]+):focus-visible$/.exec(p);
        // Menu items show focus as the hover fill, not a ring (COMPONENTS.md §1.12).
        if (!m || m[1] === '.fl-menu__item') continue;
        for (const later of sys.slice(i + 1))
          if (later.prop.startsWith('outline') && later.prop !== 'outline-offset')
            for (const q of parts(later)) if (q.startsWith(m[1]) && /^[[:]/.test(q.slice(m[1].length)) && !q.includes('focus')) hidden.push(`${p} ← ${q}`);
      }
    });
    expect(hidden).toEqual([]);
  });

  it('a key inside a button is not dimmed below AA contrast', () => {
    expect(sys.filter((d) => d.selector.includes('.fl-kbd--inline') && d.prop === 'opacity' && Number(d.value) < 1)).toEqual([]);
  });

  it('a pill that shrinks ends its text in an ellipsis, and a decision count is a Count', () => {
    expect(sys.some((d) => d.selector === '.fl-pill' && d.prop === 'text-overflow' && d.value === 'ellipsis')).toBe(true);
    expect(readFileSync(path.join(src, 'webview/tasks.tsx'), 'utf8')).not.toMatch(/class="fl-pill"[^>]*>\s*\+\{[^}]*\}\s*<\/span>/);
  });

  it('a narrow banner puts its actions on their own row below the text (§2.26 Narrow), by its own width', () => {
    expect(sys.some((d) => d.selector === '.fl-banner' && d.prop === 'container' && d.value === 'fl-banner / inline-size')).toBe(true);
    const css = readFileSync(path.join(media, 'components.css'), 'utf8');
    const narrow = /@container fl-banner \(max-width: 560px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(narrow).toMatch(/\.fl-banner__actions \{[^}]*flex-basis: 100%/);
  });
});
