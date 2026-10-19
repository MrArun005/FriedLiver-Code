import { describe, expect, it } from 'vitest';
import { MAX_LINES, highlight, langOf, type Token } from '../src/shared/highlight';

/** The tokens of a kind, as text. */
const of = (tokens: Token[] | undefined, k: Token['k']) => (tokens ?? []).filter((t) => t.k === k).map((t) => t.v);
const joined = (tokens: Token[] | undefined) => (tokens ?? []).map((t) => t.v).join('');

describe('syntax colouring', () => {
  it('keeps the text exactly, in every language', () => {
    const samples: [string, string][] = [
      ['ts', 'const a: string = "x"; // note\nexport function f(n = 0x1f) { return `t${n}`; }'],
      ['py', 'def f(x):\n    """doc"""\n    return x + 1.5  # inc\n@cache\nclass A: pass'],
      ['sql', "SELECT name, COUNT(*) FROM users WHERE age > 26 AND email = 'a''b' -- c\nGROUP BY name;"],
      ['json', '{ "a": 1, "b": [true, null, "s"], "c": -2.5e3 }'],
      ['bash', 'cd /tmp && FOO=1 python3 x.py --flag "$HOME" 2>&1 | tee out.txt # done'],
    ];
    for (const [lang, code] of samples) expect(joined(highlight(code, lang)), lang).toBe(code);
  });

  it('marks keywords, strings, numbers and comments', () => {
    const ts = highlight('const a = "x"; // note\nif (a) return 42;', 'typescript');
    expect(of(ts, 'kw')).toEqual(['const', 'if', 'return']);
    expect(of(ts, 'str')).toEqual(['"x"']);
    expect(of(ts, 'num')).toEqual(['42']);
    expect(of(ts, 'com')).toEqual(['// note']);
    const py = highlight('def f():\n    return None  # nothing', 'python');
    expect(of(py, 'kw')).toEqual(['def', 'return']);
    expect(of(py, 'lit')).toEqual(['None']);
    expect(of(py, 'fn')).toEqual(['f']);
    expect(of(py, 'com')).toEqual(['# nothing']);
    const sql = highlight("select * from users where email = 'a@b.c' limit 1", 'sql');
    expect(of(sql, 'kw')).toEqual(['select', 'from', 'where', 'limit']);
    expect(of(sql, 'str')).toEqual(["'a@b.c'"]);
    expect(of(highlight('CREATE TABLE t (id INT, name TEXT)', 'sql'), 'type')).toEqual(['INT', 'TEXT']);
    const json = highlight('{"key": "value", "n": 3, "ok": false}', 'json');
    expect(of(json, 'prop')).toEqual(['"key"', '"n"', '"ok"']);
    expect(of(json, 'str')).toEqual(['"value"']);
    expect(of(json, 'lit')).toEqual(['false']);
  });

  it('marks each command a shell line runs, its variables and flags, and leaves a heredoc text plain', () => {
    const sh = highlight("cd /tmp/x && ls -la $DIR | grep -v '^d' ; echo done\ncat << 'EOF' | python3 minidb.py\nSELECT 'not a shell string';\nEOF\nnpm test", 'bash');
    expect(of(sh, 'fn')).toEqual(['cd', 'ls', 'grep', 'echo', 'cat', 'python3', 'npm']);
    expect(of(sh, 'var')).toEqual(['$DIR']);
    expect(of(sh, 'str')).toEqual(["'^d'", "'EOF'"]);
    expect(of(sh, 'kw')).toEqual(['EOF']);
    expect(joined(sh)).toContain("\nSELECT 'not a shell string';\n");
    expect(of(highlight('if [ -f a ]; then rm a; fi', 'sh'), 'kw')).toEqual(['if', 'then', 'fi']);
  });

  it('leaves unknown languages and very long code plain', () => {
    expect(highlight('whatever', 'brainfuck')).toBeUndefined();
    expect(highlight('', '')).toBeUndefined();
    expect(highlight('x\n'.repeat(MAX_LINES + 1), 'js')).toBeUndefined();
    expect(highlight('x\n'.repeat(MAX_LINES - 1), 'js')).toBeDefined();
  });

  it('names a language from a file name', () => {
    expect(langOf('/tmp/a/demo_advanced.sql')).toBe('sql');
    expect(langOf('minidb.py')).toBe('python');
    expect(langOf('README.md')).toBe('markdown');
    expect(langOf('Makefile')).toBe('');
  });
});
