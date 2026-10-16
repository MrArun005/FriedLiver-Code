// What the Demo agent does with requests that come from the editor (Edit with
// Agent, Review My Changes), so those flows can be tried and tested offline.
// The markers and line formats match extensions/friedliver-agents/src/host/
// editorPrompt.ts and gitChanges.ts.
import path from 'node:path';

const EDIT_MARK = '[FriedLiver] Edit in the editor';
const REVIEW_MARK = '[FriedLiver] Review request';

/** The editor request among a prompt's text blocks, or null. */
export function editorRequest(texts) {
  const edit = texts.find((t) => t.startsWith(EDIT_MARK));
  if (edit) {
    const file = edit.match(/^File: (.+)$/m)?.[1];
    const lines = edit.match(/^Lines: (\d+)(?:-(\d+))?/m);
    if (file && lines) {
      const language = edit.match(/^Language: (.*)$/m)?.[1] ?? '';
      return { kind: 'edit', file, startLine: Number(lines[1]), endLine: Number(lines[2] ?? lines[1]), language };
    }
  }
  const review = texts.find((t) => t.startsWith(REVIEW_MARK));
  if (review) {
    const list = review.match(/^Changed files \(\d+\):\n((?:- .*\n?)*)/m)?.[1] ?? '';
    return { kind: 'review', files: [...list.matchAll(/^- (.+?) \(/gm)].map((m) => m[1]) };
  }
  return null;
}

/**
 * Edits the requested lines the way the instruction says ("uppercase",
 * "lowercase", "sort", "comment out"; anything else adds a note above them),
 * writing through the client so the edit is reviewed. A question gets an
 * answer and no edit. A review request gets a stand-in review.
 */
export async function handleEditorRequest(request, instruction, { cwd, read, write, say }) {
  if (request.kind === 'review') {
    const names = request.files.slice(0, 8).map((f) => `\`${f}\``).join(', ');
    await say(
      `I read the diff of ${request.files.length} changed file${request.files.length === 1 ? '' : 's'}: ${names}.\n\n` +
        "The Demo agent can't really review code. A real agent lists bugs, edge cases and missing tests here, each with its file and line. " +
        'Say **fix it** and it makes the changes, each one a diff for you to accept or reject.',
    );
    return;
  }
  const range = request.startLine === request.endLine ? `line ${request.startLine}` : `lines ${request.startLine}-${request.endLine}`;
  if (/\?\s*$/.test(instruction) || /^(explain|what|why|how)\b/i.test(instruction)) {
    await say(`You asked about ${range} of \`${request.file}\`. The Demo agent only pretends to explain; a real agent answers here without editing the file.`);
    return;
  }
  const file = path.resolve(cwd, request.file);
  let text;
  try {
    text = await read(file);
  } catch (err) {
    await say(`I couldn't read \`${request.file}\`: ${err.message}`);
    return;
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = Math.min(request.startLine, lines.length) - 1;
  const count = Math.max(1, Math.min(request.endLine, lines.length) - start);
  const [changed, what] = transform(lines.slice(start, start + count), instruction, request.language);
  lines.splice(start, count, ...changed);
  // A moment of "editing…", as a real agent would take.
  await new Promise((r) => setTimeout(r, 300));
  try {
    await write(file, lines.join(eol));
    await say(`Done: I ${what} (${range} of \`${request.file}\`).`);
  } catch {
    await say('You rejected the edit, so nothing changed.');
  }
}

const HASH = new Set(['python', 'shellscript', 'ruby', 'perl', 'yaml', 'toml', 'dockerfile', 'makefile', 'r', 'powershell', 'elixir', 'julia', 'coffeescript']);
const DASHES = new Set(['sql', 'lua', 'haskell']);
const commentMark = (language) => (HASH.has(language) ? '#' : DASHES.has(language) ? '--' : '//');
const indentOf = (line) => line.match(/^\s*/)[0];

function transform(lines, instruction, language) {
  const w = instruction.toLowerCase();
  if (/upper ?case|capitali[sz]e/.test(w)) return [lines.map((l) => l.toUpperCase()), 'upper-cased the code'];
  if (/lower ?case/.test(w)) return [lines.map((l) => l.toLowerCase()), 'lower-cased the code'];
  if (/\bsort\b/.test(w)) return [[...lines].sort(), 'sorted the lines'];
  const mark = commentMark(language);
  if (/\bcomment\b/.test(w)) return [lines.map((l) => (l.trim() ? `${indentOf(l)}${mark} ${l.trimStart()}` : l)), 'commented out the code'];
  const note = instruction.replace(/\s+/g, ' ').trim().slice(0, 120);
  return [[`${indentOf(lines[0] ?? '')}${mark} ${note} (Demo agent)`, ...lines], 'added a note above the code'];
}
