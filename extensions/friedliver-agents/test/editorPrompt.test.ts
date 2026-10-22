import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AROUND_LINES,
  EDIT_AGENT_HINT,
  EDIT_MARK,
  PROMPT_LIMITS,
  REFS_MARK,
  editPrompt,
  fence,
  formatLines,
  lineSpan,
  parseEditInput,
  problemInstruction,
  promptPath,
  refLabel,
  referenceBlock,
  referencesContext,
  textOf,
  type EditRequest,
} from '../src/host/editorPrompt';

const cwd = path.resolve('/work/app');
const file = path.join(cwd, 'src', 'format.ts');
const doc = Array.from({ length: 30 }, (_, n) => `line ${n + 1}`).join('\n') + '\n';

function request(over: Partial<EditRequest> = {}): EditRequest {
  return { cwd, file, languageId: 'typescript', text: doc, span: { start: { line: 11, character: 2 }, end: { line: 17, character: 4 } }, kind: 'selection', ...over };
}

describe('the edit box', () => {
  it('reads a leading @mention as the agent', () => {
    expect(parseEditInput('@gpt make it async')).toEqual({ agent: 'codex', instruction: 'make it async' });
    expect(parseEditInput('  @Gemini, add a test ')).toEqual({ agent: 'gemini', instruction: 'add a test' });
    expect(parseEditInput('@claude: rename it')).toEqual({ agent: 'claude', instruction: 'rename it' });
    expect(parseEditInput('@demo')).toEqual({ agent: 'demo', instruction: '' });
  });

  it('takes the last of several mentions, so the instruction never starts with one', () => {
    expect(parseEditInput('@claude @gemini fix it')).toEqual({ agent: 'gemini', instruction: 'fix it' });
  });

  it('leaves unknown names and mentions later in the text alone', () => {
    expect(parseEditInput('@someone fix it')).toEqual({ agent: undefined, instruction: '@someone fix it' });
    expect(parseEditInput('ask @gemini later')).toEqual({ agent: undefined, instruction: 'ask @gemini later' });
    expect(parseEditInput('@gpt-4 style')).toEqual({ agent: undefined, instruction: '@gpt-4 style' });
    expect(parseEditInput('make it faster')).toEqual({ agent: undefined, instruction: 'make it faster' });
  });
});

describe('ranges', () => {
  it('counts lines from 1 and leaves out a line the selection only touches at its start', () => {
    expect(lineSpan({ start: { line: 11, character: 0 }, end: { line: 18, character: 0 } })).toEqual({ startLine: 12, endLine: 18 });
    expect(lineSpan({ start: { line: 11, character: 3 }, end: { line: 11, character: 3 } })).toEqual({ startLine: 12, endLine: 12 });
    expect(lineSpan({ start: { line: 4, character: 0 }, end: { line: 4, character: 0 } })).toEqual({ startLine: 5, endLine: 5 });
  });

  it('formats one line or a range', () => {
    expect(formatLines({ startLine: 12, endLine: 12 })).toBe('12');
    expect(formatLines({ startLine: 12, endLine: 18 })).toBe('12-18');
    expect(refLabel({ path: file, startLine: 12, endLine: 18 })).toBe('format.ts:12–18');
  });

  it('takes exactly the selected text', () => {
    const lines = ['abcdef', 'ghijkl', 'mnopqr'];
    expect(textOf(lines, { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } })).toBe('cd');
    expect(textOf(lines, { start: { line: 0, character: 4 }, end: { line: 2, character: 2 } })).toBe('ef\nghijkl\nmn');
  });
});

describe('paths the agent sees', () => {
  it('are relative to its folder, with forward slashes', () => {
    expect(promptPath(cwd, file)).toBe('src/format.ts');
    expect(promptPath(cwd, path.join(cwd, '..notes'))).toBe('..notes');
  });

  it('stay absolute outside it', () => {
    const other = path.resolve('/work/other/a.ts');
    expect(promptPath(cwd, other)).toBe(other);
    expect(promptPath(cwd, cwd)).toBe(cwd);
  });
});

describe('fences', () => {
  it('outgrow any backticks in the code', () => {
    expect(fence('const a = 1;\n', 'ts')).toBe('```ts\nconst a = 1;\n```');
    expect(fence('```js\nx\n```', 'markdown')).toBe('````markdown\n```js\nx\n```\n````');
    expect(fence('x', 'c++; rm -rf')).toMatch(/^```c\+\+rm-rf\n/);
  });
});

describe('an edit request', () => {
  it('names the file relative to the agent, the language and the lines', () => {
    const text = editPrompt(request());
    expect(text.startsWith(`${EDIT_MARK}\n`)).toBe(true);
    expect(text).toContain('File: src/format.ts\nLanguage: typescript\nLines: 12-18 (selected, from 12:3 to 18:5)');
    expect(text).not.toContain(cwd);
    expect(text).toMatch(/only in this file, unless they say otherwise/);
  });

  it('carries the selection and a few lines around it', () => {
    const text = editPrompt(request());
    expect(text).toContain('Code:\n```typescript\nne 12\nline 13\nline 14\nline 15\nline 16\nline 17\nline\n```');
    expect(text).toContain(`Before it (lines ${12 - AROUND_LINES}-11):\n\`\`\`typescript\nline 7\n`);
    expect(text).toContain('After it (lines 19-23):\n```typescript\nline 19\n');
    expect(text).not.toContain('line 6\n');
    expect(text).not.toContain('line 24');
  });

  it('says when it took the function or the line because nothing was selected', () => {
    const fn = editPrompt(request({ kind: 'function', span: { start: { line: 2, character: 0 }, end: { line: 4, character: 6 } } }));
    expect(fn).toContain('Lines: 3-5 (the function around the cursor; nothing is selected)');
    expect(fn).toContain('Code:\n```typescript\nline 3\nline 4\nline 5\n```');
    expect(fn).toContain('Before it (lines 1-2)');
    const one = editPrompt(request({ kind: 'line', span: { start: { line: 29, character: 0 }, end: { line: 29, character: 7 } } }));
    expect(one).toContain('Lines: 30 (the line with the cursor; nothing is selected)');
    // The file's final line break isn't an "after".
    expect(one).not.toContain('After it');
  });

  it('caps long selections and long surrounding lines', () => {
    const long = Array.from({ length: 4000 }, (_, n) => `const value${n} = ${n}; // padding padding`).join('\n');
    const text = editPrompt(request({ text: `${'x'.repeat(5000)}\n${long}`, kind: 'function', span: { start: { line: 1, character: 0 }, end: { line: 4000, character: 10 } } }));
    expect(text.length).toBeLessThan(PROMPT_LIMITS.code + 4000);
    expect(text).toContain('[… cut here: the code goes on to line 4001. Read the file for the rest.]');
    expect(text).toContain(`${'x'.repeat(PROMPT_LIMITS.line)} [… line cut]`);
  });
});

describe('Fix with Agent', () => {
  it('turns a problem into one plain instruction', () => {
    expect(problemInstruction({ severity: 'error', message: "Type 'string' is not\nassignable to type 'number'.", source: 'ts', code: 2322 })).toBe(
      "Fix this error: Type 'string' is not assignable to type 'number'. (ts 2322)",
    );
    expect(problemInstruction({ severity: 'warning', message: 'Unused variable' })).toBe('Fix this warning: Unused variable');
    expect(problemInstruction({ severity: 'error', message: 'x'.repeat(5000) }).length).toBeLessThan(PROMPT_LIMITS.problem + 40);
  });
});

describe('code references', () => {
  it('are a path:lines header over the code in a fence', () => {
    const block = referenceBlock(cwd, { path: file, startLine: 3, endLine: 4 }, 'a\nb', 'typescript');
    expect(block).toBe('src/format.ts:3-4\n```typescript\na\nb\n```');
    expect(referencesContext([block])).toBe(`${REFS_MARK}:\n\n${block}`);
  });

  it('stop at the size cap and say how many were left out', () => {
    const big = 'y'.repeat(PROMPT_LIMITS.references - 3);
    const text = referencesContext([big, 'second', 'third']);
    expect(text).toContain(big);
    expect(text).not.toContain('second');
    expect(text).toContain('[2 more references left out: too long.]');
  });
});

describe('the Edit with Agent hint', () => {
  it('names each agent as its mention everywhere else does (@codex, not @gpt), and each one parses', () => {
    const mentions = EDIT_AGENT_HINT.match(/@\w+/g)!;
    expect(mentions).toEqual(['@claude', '@codex', '@gemini', '@antigravity', '@copilot']);
    for (const m of mentions) expect(parseEditInput(`${m} tidy`).agent).toBe(m.slice(1));
  });
});
