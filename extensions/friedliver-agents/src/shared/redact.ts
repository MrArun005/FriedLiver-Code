// Takes obvious secrets out of text FriedLiver shows from someone else's transcript (a Claude Code subagent's
// commands, inputs and outputs): token shapes vendors publish, JWTs, private keys, credentials in URLs, and the
// value after a secret-named key or flag. A heuristic: it errs toward showing code (`token: string` stays).
//
// Every pattern runs in linear time on hostile text (the host would freeze otherwise), and none caps a secret's
// own length (a capped value leaks its tail): each starts at a fixed keyword or prefix, the name part around it is
// bounded, and a value is one unbounded character class up to a fixed delimiter, which can't backtrack.
const R = '[redacted]';
/** Text longer than this is cut to its start first; what is shown is cut far shorter after redaction. */
export const MAX_REDACT = 1024 * 1024;

/** Token shapes with a fixed prefix: Anthropic/OpenAI, GitHub, GitLab, Slack, AWS, Google, npm, Stripe. */
const TOKENS =
  /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,})\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
/** To its END line, or to the end of the text when it has none. */
const PEM = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g;
const AUTH = /\b(Bearer|Basic|Token)[ \t]+[A-Za-z0-9._~+/=-]{12,}/g;
/** scheme://user:password@host */
const URL_CRED = /(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]+:)[^\s@/]+@/gi;
// The match starts at the keyword (GITHUB_TOKEN matches at TOKEN), never at a class: a class before the keyword is
// tried at every word boundary and backtracked quadratically on long identifier-like text (a ReDoS on the host).
const NAME = '(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]{0,40}';
/** NAME=value, NAME: value, "name": "value"; the value redacted when quoted, or when it mixes digits in (a literal, not a type, a call or a count). */
const ASSIGN = new RegExp(`(${NAME})(["']?[ \\t]{0,8}[:=][ \\t]{0,8})(["']?)([^\\s'"\`&,;)}\\]]{4,})`, 'gi');
/** --password value, --token=value */
const FLAG = /(--?(?:password|passwd|token|secret|api-?key)(?:=|[ \t]{1,8}))(['"]?)([^\s'"]+)/gi;

export function redactSecrets(text: string): string {
  if (!text) return text;
  // One pass over the whole text, so no secret straddles a seam; only its length is capped, before redacting.
  if (text.length > MAX_REDACT) text = `${text.slice(0, MAX_REDACT)}\n…`;
  return text
    .replace(PEM, '[redacted private key]')
    .replace(TOKENS, R)
    .replace(JWT, R)
    .replace(AUTH, `$1 ${R}`)
    .replace(URL_CRED, `$1${R}@`)
    .replace(FLAG, (_m, flag: string, q: string) => `${flag}${q}${R}`)
    .replace(ASSIGN, (m, name: string, sep: string, q: string, value: string) => (value === R || (!q && (!/\d/.test(value) || /^[\d.]+$/.test(value))) ? m : `${name}${sep}${q}${R}`));
}
