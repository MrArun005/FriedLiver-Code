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
const URL_CRED = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;
const NAME = '[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*';
/** NAME=value, NAME: value, "name": "value"; the value redacted when quoted, or when it mixes digits in (a literal, not a type, a call or a count). */
const ASSIGN = new RegExp(`\\b(${NAME})(["']?\\s*[:=]\\s*)(["']?)([^\\s'"\`&,;)}\\]]{4,})`, 'gi');
/** --password value, --token=value */
const FLAG = /(--?(?:password|passwd|token|secret|api-?key)(?:=|\s+))(['"]?)([^\s'"]+)/gi;

export function redactSecrets(text: string): string {
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
