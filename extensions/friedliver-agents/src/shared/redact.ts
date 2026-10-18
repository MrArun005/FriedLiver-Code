// Takes obvious secrets out of text FriedLiver shows from someone else's transcript (a Claude Code subagent's
// commands, inputs and outputs): token shapes vendors publish, JWTs, private keys, credentials in URLs, and the
// value after a secret-named key or flag. A heuristic: it errs toward showing code (`token: string` stays).
const R = '[redacted]';

/** Token shapes with a fixed prefix: Anthropic/OpenAI, GitHub, GitLab, Slack, AWS, Google, npm, Stripe. */
const TOKENS =
  /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,})\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const AUTH = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/g;
/** scheme://user:password@host */
const URL_CRED = /(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{1,256}:)[^\s@/]{1,256}@/gi;
// The match starts at the keyword (GITHUB_TOKEN matches at TOKEN), never at a class: a class before the keyword is
// tried at every word boundary and backtracked quadratically on long identifier-like text (a ReDoS on the host).
const NAME = '(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]{0,40}';
/** NAME=value, NAME: value, "name": "value"; the value redacted when quoted, or when it mixes digits in (a literal, not a type, a call or a count). */
const ASSIGN = new RegExp(`(${NAME})(["']?[ \\t]{0,8}[:=][ \\t]{0,8})(["']?)([^\\s'"\`&,;)}\\]]{4,512})`, 'gi');
/** --password value, --token=value */
const FLAG = /(--?(?:password|passwd|token|secret|api-?key)(?:=|[ \t]{1,8}))(['"]?)([^\s'"]{1,512})/gi;
/** Longer text is redacted a piece at a time, cut at line ends. */
const PIECE = 64 * 1024;

export function redactSecrets(text: string): string {
  if (!text || text.length <= PIECE) return redactPiece(text);
  // ponytail: a 64 KB line with a secret right on the cut can slip through; callers keep text far shorter (2–100 KB).
  let out = '';
  for (let at = 0; at < text.length; ) {
    let end = Math.min(text.length, at + PIECE);
    const nl = end < text.length ? text.lastIndexOf('\n', end) : -1;
    if (nl > at + PIECE / 2) end = nl + 1;
    out += redactPiece(text.slice(at, end));
    at = end;
  }
  return out;
}

function redactPiece(text: string): string {
  if (!text) return text;
  return text
    .replace(PEM, '[redacted private key]')
    .replace(TOKENS, R)
    .replace(JWT, R)
    .replace(AUTH, `$1 ${R}`)
    .replace(URL_CRED, `$1${R}@`)
    .replace(FLAG, (_m, flag: string, q: string) => `${flag}${q}${R}`)
    .replace(ASSIGN, (m, name: string, sep: string, q: string, value: string) => (value === R || (!q && (!/\d/.test(value) || /^[\d.]+$/.test(value))) ? m : `${name}${sep}${q}${R}`));
}
