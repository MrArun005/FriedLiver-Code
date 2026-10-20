// The Antigravity adapter as dist/agy-acp.js runs it, for end-to-end tests: over stdio, but with
// the fake agy (Node and a script) and what the talk-only sandbox must also let Node read and write.
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { agyAgent } from '@friedliver/main/agents/agyAcp';

const list = (v: string | undefined): string[] => (v ? (JSON.parse(v) as string[]) : []);
agyAgent({
  command: process.execPath,
  baseArgs: [process.env.FAKE_AGY_SCRIPT ?? ''],
  talkRead: list(process.env.FAKE_TALK_READ),
  talkWrite: list(process.env.FAKE_TALK_WRITE),
}).connect(acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
