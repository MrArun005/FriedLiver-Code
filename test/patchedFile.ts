import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(__dirname, '..');

/** The full text of a file that `patches/<patch>` adds (a `new file` diff), so tests can run code a patch ships. */
export function newFileFromPatch(patch: string, file: string): string {
  // CRLF: Windows CI checks out with git's default autocrlf.
  const text = fs.readFileSync(path.join(root, 'patches', patch), 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf(`diff --git a/${file} b/${file}\n`);
  if (start < 0) throw new Error(`${patch} does not touch ${file}`);
  const end = text.indexOf('\ndiff --git ', start + 1);
  const section = text.slice(start, end < 0 ? undefined : end + 1);
  if (!section.includes('\nnew file mode ')) throw new Error(`${patch} changes ${file} but does not add it`);
  return section.slice(section.indexOf('\n@@')).split('\n').slice(2)
    .filter(line => line.startsWith('+'))
    .map(line => line.slice(1))
    .join('\n') + '\n';
}

/** Writes that file to a temp dir and returns its file URL (Windows paths aren't import specifiers), for `await import()`. */
export function writePatchedFile(patch: string, file: string): string {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fl-patch-')), path.basename(file));
  fs.writeFileSync(out, newFileFromPatch(patch, file));
  return pathToFileURL(out).href;
}
