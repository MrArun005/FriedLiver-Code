// Light syntax colouring for code in replies and for commands: keywords,
// strings, numbers and comments, enough to read a block at a glance. Not a
// parser: one pass with a few patterns per language, and nothing for code
// longer than MAX_LINES, which stays plain.

export type TokenKind = 'kw' | 'str' | 'num' | 'com' | 'fn' | 'var' | 'lit' | 'type' | 'prop' | 'op';
export interface Token {
  /** Undefined for plain text. */
  k?: TokenKind;
  v: string;
}

/** Code longer than this stays plain, so a huge block draws at once. */
export const MAX_LINES = 2000;
const MAX_CHARS = 200_000;

type Lang = 'sh' | 'js' | 'json' | 'py' | 'sql';

const ALIASES: Record<string, Lang> = {
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  shell: 'sh',
  console: 'sh',
  shellsession: 'sh',
  'shell-session': 'sh',
  ksh: 'sh',
  js: 'js',
  javascript: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  ts: 'js',
  typescript: 'js',
  tsx: 'js',
  mts: 'js',
  cts: 'js',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  py: 'py',
  python: 'py',
  python3: 'py',
  sql: 'sql',
  sqlite: 'sql',
  postgres: 'sql',
  postgresql: 'sql',
  psql: 'sql',
  mysql: 'sql',
};

/** The language a file name's extension says, for colouring a file a heredoc writes. */
export function langOf(file: string): string {
  const ext = file.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return ({ py: 'python', ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', json: 'json', sql: 'sql', sh: 'sh', bash: 'bash', zsh: 'zsh', md: 'markdown', yml: 'yaml', yaml: 'yaml' } as Record<string, string>)[ext] ?? '';
}

const words = (s: string) => new Set(s.split(' '));
const JS_KW = words(
  'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface keyof let namespace new of private protected public readonly return satisfies set static super switch throw try type typeof var void while with yield',
);
const JS_LIT = words('true false null undefined NaN Infinity this');
const JS_TYPE = words('string number boolean bigint symbol object any unknown never void Promise Record Partial Readonly Array Map Set');
const PY_KW = words('and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield');
const PY_LIT = words('True False None self cls');
const SQL_KW = words(
  'ADD ALL ALTER AND AS ASC BEGIN BETWEEN BY CASCADE CASE CHECK COLUMN COMMIT CONSTRAINT CREATE CROSS DATABASE DEFAULT DELETE DESC DISTINCT DROP ELSE END EXCEPT EXISTS EXPLAIN FOREIGN FROM FULL GROUP HAVING IF IN INDEX INNER INSERT INTERSECT INTO IS JOIN KEY LEFT LIKE LIMIT NOT NULL OFFSET ON OR ORDER OUTER PRIMARY REFERENCES REPLACE RETURNING RIGHT ROLLBACK SELECT SET TABLE THEN TRANSACTION TRIGGER UNION UNIQUE UPDATE USING VALUES VIEW WHEN WHERE WITH',
);
const SQL_TYPE = words('INT INTEGER BIGINT SMALLINT TINYINT TEXT FLOAT REAL DOUBLE NUMERIC DECIMAL VARCHAR CHAR BOOLEAN BOOL DATE TIME TIMESTAMP DATETIME BLOB SERIAL JSON JSONB UUID');
const SQL_LIT = words('TRUE FALSE NULL');
const SH_KW = words('if then else elif fi for while until do done case esac in function select return exit export local readonly declare unset shift break continue time');

const NUM = String.raw`\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?)\b|\B\.\d+\b`;
const DQ = String.raw`"(?:[^"\\\n]|\\.)*"?`;
const SQ = String.raw`'(?:[^'\\\n]|\\.)*'?`;

/** Each language: one regex of alternatives, each a capture group, and what each group is. */
interface Grammar {
  re: RegExp;
  kinds: (TokenKind | 'word')[];
  /** What a word is, from itself, the character after it and the text before it. */
  word?: (w: string, next: string, before: string) => TokenKind | undefined;
}

function grammar(parts: [TokenKind | 'word', string][], word?: Grammar['word'], flags = 'g'): Grammar {
  return { re: new RegExp(parts.map(([, src]) => `(${src})`).join('|'), flags), kinds: parts.map(([k]) => k), word };
}

const GRAMMARS: Record<Exclude<Lang, 'sh'>, Grammar> = {
  js: grammar(
    [
      ['com', String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`],
      ['str', `${DQ}|${SQ}|` + '`(?:[^`\\\\]|\\\\[\\s\\S])*`?'],
      ['num', NUM],
      ['word', String.raw`[A-Za-z_$][\w$]*`],
    ],
    (w, next) => (JS_KW.has(w) ? 'kw' : JS_LIT.has(w) ? 'lit' : JS_TYPE.has(w) ? 'type' : next === '(' ? 'fn' : /^[A-Z]/.test(w) && /[a-z]/.test(w) ? 'type' : undefined),
  ),
  json: grammar(
    [
      ['prop', String.raw`"(?:[^"\\\n]|\\.)*"(?=\s*:)`],
      ['str', DQ],
      ['num', String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b`],
      ['lit', String.raw`\b(?:true|false|null)\b`],
      ['com', String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`],
    ],
  ),
  py: grammar(
    [
      ['com', String.raw`#[^\n]*`],
      ['str', String.raw`[rRbBuUfF]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|${DQ}|${SQ})`],
      ['fn', String.raw`@[A-Za-z_][\w.]*`],
      ['num', NUM],
      ['word', String.raw`[A-Za-z_]\w*`],
    ],
    (w, next) => (PY_KW.has(w) ? 'kw' : PY_LIT.has(w) ? 'lit' : next === '(' ? 'fn' : /^[A-Z][a-z]/.test(w) ? 'type' : undefined),
  ),
  sql: grammar(
    [
      ['com', String.raw`--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`],
      ['str', String.raw`'(?:[^']|'')*'?`],
      ['prop', String.raw`"[^"\n]*"?|` + '`[^`\\n]*`?'],
      ['num', NUM],
      ['word', String.raw`[A-Za-z_]\w*`],
    ],
    (w, next) => {
      const u = w.toUpperCase();
      return SQL_KW.has(u) ? 'kw' : SQL_TYPE.has(u) ? 'type' : SQL_LIT.has(u) ? 'lit' : next === '(' ? 'fn' : undefined;
    },
  ),
};

const SH = grammar([
  ['com', String.raw`(?<![^\s;|&(])#[^\n]*`],
  ['str', String.raw`\$?'[^']*'?|"(?:[^"\\]|\\[\s\S])*"?`],
  ['var', String.raw`\$(?:\{[^}\n]*\}?|[A-Za-z_]\w*|[@*#?$!0-9-])`],
  ['op', String.raw`&&|\|\||[|;&]|<<-?|>>?|<|(?<![\w-])--?[A-Za-z][\w-]*`],
  ['num', String.raw`(?<![\w.-])\d+(?:\.\d+)?(?![\w.])`],
  ['word', String.raw`[A-Za-z_][\w.+-]*`],
]);

function push(out: Token[], v: string, k?: TokenKind): void {
  if (!v) return;
  const last = out.at(-1);
  if (last && last.k === k) last.v += v;
  else out.push(k ? { k, v } : { v });
}

function scan(code: string, g: Grammar, out: Token[], word = g.word): void {
  let at = 0;
  g.re.lastIndex = 0;
  for (let m = g.re.exec(code); m; m = g.re.exec(code)) {
    if (!m[0]) {
      g.re.lastIndex++;
      continue;
    }
    push(out, code.slice(at, m.index));
    const group = m.findIndex((v, n) => n > 0 && v !== undefined) - 1;
    const kind = g.kinds[group];
    if (kind === 'word') {
      const end = m.index + m[0].length;
      const next = code.slice(end).match(/^\s*(\S)/)?.[1] ?? '';
      push(out, m[0], word?.(m[0], next, (m.index > 40 ? '\u0000' : '') + code.slice(Math.max(0, m.index - 40), m.index)));
    } else push(out, m[0], kind);
    at = m.index + m[0].length;
  }
  push(out, code.slice(at));
}

/** Where a shell word is the program a command runs: at the start, after |, &&, ;, ( or a keyword such as then. */
const COMMAND_AT = /(?:^|[|;&(`{]|\$\(|\b(?:then|do|else|elif|if|while|until|time|exec|sudo|xargs|env|nohup)[ \t]+)[ \t]*$/;

function shellLine(line: string, out: Token[]): void {
  scan(line, SH, out, (w, _next, before) => {
    // Keywords only where a command starts ("echo done" prints a word), and "in" after "for x".
    if (w === 'in' && /\b(?:for|case|select)[ \t]+\S+[ \t]+$/.test(before)) return 'kw';
    if (!COMMAND_AT.test(before)) return undefined;
    return SH_KW.has(w) ? 'kw' : 'fn';
  });
}

const HEREDOC = /(?<!<)<<-?\s*(['"]?)([A-Za-z_][\w.-]*)\1/;

function shell(code: string): Token[] {
  const out: Token[] = [];
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i) push(out, '\n');
    const line: Token[] = [];
    shellLine(lines[i], line);
    for (const t of line) push(out, t.v, t.k);
    const doc = lines[i].match(HEREDOC);
    if (!doc) continue;
    // The heredoc's text is data, not shell: plain, up to its delimiter.
    const tabs = /<<-/.test(lines[i]);
    let end = i + 1;
    while (end < lines.length && (tabs ? lines[end].replace(/^\t+/, '') : lines[end]).trimEnd() !== doc[2]) end++;
    if (end > i + 1) push(out, `\n${lines.slice(i + 1, end).join('\n')}`);
    if (end < lines.length) {
      push(out, '\n');
      push(out, lines[end], 'kw');
    }
    i = end;
  }
  return out;
}

/** Tokens for `code` in `lang`, or undefined when the language isn't known or the code is too long to colour. */
export function highlight(code: string, lang: string): Token[] | undefined {
  const l = ALIASES[lang.toLowerCase()];
  if (!l || code.length > MAX_CHARS) return undefined;
  let lines = 1;
  for (let i = code.indexOf('\n'); i >= 0; i = code.indexOf('\n', i + 1)) if (++lines > MAX_LINES) return undefined;
  if (l === 'sh') return shell(code);
  const out: Token[] = [];
  scan(code, GRAMMARS[l], out);
  return out;
}
