import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';

/** ACP `fs/read_text_file`: `line` is 1-based, `limit` is a line count. */
export async function readTextFile(req: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
  const text = await readFile(req.path, 'utf8');
  if (req.line == null && req.limit == null) return { content: text };
  const lines = text.split('\n');
  const start = Math.max(0, (req.line ?? 1) - 1);
  const end = req.limit == null ? lines.length : start + req.limit;
  return { content: lines.slice(start, end).join('\n') };
}

/** Reads a file for a before/after diff; a missing file reads as null. */
export async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeTextFile(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}
