// The `friedliver-browser` MCP server Claude Code starts (over stdio) from its
// ~/.claude.json entry. The entry holds no secret and no port: each request
// reads FriedLiver's current token file (argv[2], 0600 in its storage). If the
// pid in it is dead, nothing touches the network. Before the first message to a
// url+pid, a body-less handshake must come back signed with the token; only then
// are messages sent, each signed (never the token itself) and each answer's
// proof checked; a bad proof forgets the handshake. A process that grabbed a
// stale port gets no token and no payload. Otherwise: "FriedLiver isn't running".
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { sign } from './http';
import { BRIDGE_LIMITS } from './protocol';

const NOT_RUNNING = "FriedLiver isn't running (or was restarted). Start FriedLiver, then start a new Claude Code session.";
const file = process.argv[2];
/** One per process: Claude Code starts one per session, so "Allow for this session" means this one. */
const session = randomBytes(16).toString('hex');

function current(): { url: string; token: string; pid: number } | undefined {
  try {
    const { url, token, pid } = JSON.parse(readFileSync(file!, 'utf8')) as { url?: unknown; token?: unknown; pid?: unknown };
    if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(url) || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return undefined;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
    process.kill(pid, 0); // throws when that process is gone (EPERM, someone else's pid, counts as gone too)
    return { url, token, pid };
  } catch {
    // Missing, unreadable, or FriedLiver's process is gone: not running.
  }
  return undefined;
}

const proven = (proof: unknown, want: string) =>
  typeof proof === 'string' && /^[0-9a-f]{64}$/.test(proof) && timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(want, 'hex'));

/** The url+pid whose handshake succeeded; a different one, or a bad proof, needs a new handshake. */
let verified: string | undefined;

/** Body-less: a nonce goes out, and the server must sign it with the token. */
function handshake(now: { url: string; token: string; pid: number }): Promise<boolean> {
  const nonce = randomBytes(16).toString('hex');
  return new Promise((resolve) => {
    const req = http.request(now.url, { method: 'POST', agent: false, headers: { 'x-friedliver-probe': nonce, 'content-length': '0' } }, (res) => {
      res.resume();
      resolve(res.statusCode === 204 && proven(res.headers['x-friedliver-proof'], sign(now.token, 'probe', nonce)));
    });
    req.setTimeout(5_000, () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

if (!file || !current()) {
  process.stderr.write(`${NOT_RUNNING}\n`);
  process.exit(1);
}

/** The server's reply body, or an error when nothing proved it is FriedLiver. */
async function forward(body: string): Promise<{ status: number; text: string } | Error> {
  const now = current();
  if (!now) return new Error(NOT_RUNNING);
  const key = `${now.url} ${now.pid}`;
  if (verified !== key) {
    verified = undefined;
    if (!(await handshake(now))) return new Error(NOT_RUNNING);
    verified = key;
  }
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
        if (!proven(res.headers['x-friedliver-proof'], sign(now.token, 'server', nonce))) {
          verified = undefined;
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
