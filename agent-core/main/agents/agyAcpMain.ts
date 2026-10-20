// dist/agy-acp.js: the Antigravity adapter (agyAcp.ts) on stdin/stdout. core.ts passes the agy
// binary it found and the user's extra arguments in the environment.
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { agyAgent } from './agyAcp';

let extraArgs: string[] = [];
try {
  const parsed: unknown = JSON.parse(process.env.FRIEDLIVER_AGY_ARGS ?? '[]');
  if (Array.isArray(parsed)) extraArgs = parsed.filter((a): a is string => typeof a === 'string');
} catch {
  // No extras.
}
const env = { ...process.env };
delete env.FRIEDLIVER_AGY;
delete env.FRIEDLIVER_AGY_ARGS;

agyAgent({
  command: process.env.FRIEDLIVER_AGY || 'agy',
  extraArgs,
  env,
  settingsFile: path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json'),
}).connect(acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
