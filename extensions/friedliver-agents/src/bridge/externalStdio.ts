// The `friedliver-browser` MCP server Claude Code starts (over stdio) from its
// ~/.claude.json entry. The entry holds no secret and no port: each request
// reads FriedLiver's current token file (argv[2], 0600 in its storage), signs a
// fresh nonce with the token instead of sending it, and forwards the message to
// the URL in the file only after the server signs the nonce back. A process that
// grabbed a stale port gets no token and its answers are dropped. No file, no
// answer, or a wrong proof: "FriedLiver isn't running".
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { sign } from './http';
import { BRIDGE_LIMITS } from './protocol';

const NOT_RUNNING = "FriedLiver isn't running (or was restarted). Start FriedLiver, then start a new Claude Code session.";
const file = process.argv[2];
/** One per process: Claude Code starts one per session, so "Allow for this session" means this one. */
const session = randomBytes(16).toString('hex');

function current(): { url: string; token: string } | undefined {
  try {
    const { url, token } = JSON.parse(readFileSync(file!, 'utf8')) as { url?: unknown; token?: unknown };
    if (typeof url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(url) && typeof token === 'string' && /^[0-9a-f]{64}$/.test(token)) return { url, token };
  } catch {
    // Missing or unreadable: not running.
  }
  return undefined;
}

if (!file || !current()) {
  process.stderr.write(`${NOT_RUNNING}\n`);
  process.exit(1);
}

/** The server's reply body, or an error when nothing proved it is FriedLiver. */
function forward(body: string): Promise<{ status: number; text: string } | Error> {
  const now = current();
  if (!now) return Promise.resolve(new Error(NOT_RUNNING));
  const nonce = randomBytes(16).toString('hex');
  return new Promise((resolve) => {
    const req = http.request(
      now.url,
      {
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-friedliver-nonce': nonce,
          'x-friedliver-session': session,
          authorization: `FriedLiver-HMAC ${sign(now.token, 'client', nonce, session)}`,
        },
      },
      (res) => {
        const proof = String(res.headers['x-friedliver-proof'] ?? '');
        const want = Buffer.from(sign(now.token, 'server', nonce), 'hex');
        if (!/^[0-9a-f]{64}$/.test(proof) || !timingSafeEqual(Buffer.from(proof, 'hex'), want)) {
          res.destroy();
          return resolve(new Error(NOT_RUNNING));
        }
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          text += c;
          if (text.length > BRIDGE_LIMITS.line) res.destroy();
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        res.on('error', () => resolve(new Error(NOT_RUNNING)));
      },
    );
    req.on('error', () => resolve(new Error(NOT_RUNNING)));
    req.end(body);
  });
}

const write = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);

async function onLine(line: string): Promise<void> {
  if (!line.trim()) return;
  let id: unknown;
  try {
    id = (JSON.parse(line) as { id?: unknown }).id;
  } catch {
    return;
  }
  const r = await forward(line);
  const fail = (message: string) => {
    if (typeof id === 'string' || typeof id === 'number') write({ jsonrpc: '2.0', id, error: { code: -32000, message } });
  };
  if (r instanceof Error) return fail(r.message);
  if (r.status === 202 || !r.text) return;
  try {
    const parsed = JSON.parse(r.text) as object | object[];
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) write(m);
  } catch {
    fail(NOT_RUNNING);
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  input += chunk;
  for (let nl = input.indexOf('\n'); nl >= 0; nl = input.indexOf('\n')) {
    const line = input.slice(0, nl);
    input = input.slice(nl + 1);
    void onLine(line);
  }
  if (input.length > BRIDGE_LIMITS.line) input = '';
});
process.stdin.on('end', () => process.exit(0));
