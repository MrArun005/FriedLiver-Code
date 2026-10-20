// A stand-in for FriedLiver's tools server (dist/bridge.js) over stdio, for the agy adapter tests:
// answers the index_* tools with canned text and logs each call to FAKE_BRIDGE_LOG as a JSON line.
// index_read of big/* answers 10,000 characters; of missing.ts, an error.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-bridge', version: '0' } } });
  if (msg.method !== 'tools/call') return;
  const { name, arguments: args } = msg.params;
  if (process.env.FAKE_BRIDGE_LOG) appendFileSync(process.env.FAKE_BRIDGE_LOG, `${JSON.stringify({ name, args })}\n`);
  if (args.path === 'missing.ts') return send({ id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'No such file in the index.' }] } });
  const text = args.path?.startsWith('big/') ? 'x'.repeat(10_000) : `${name} ${JSON.stringify(args)}`;
  send({ id: msg.id, result: { content: [{ type: 'text', text }] } });
});
