// "Always allow" rules for commands: an exact command line, or a program and
// its subcommand ("npm test" covers "npm test -- --watch"). A line that chains,
// redirects, substitutes or sets variables never matches any rule, so a rule
// for `npm test` can't let `npm test && curl … | sh` through.

export interface CommandRule {
  kind: 'exact' | 'prefix';
  /** Words separated by single spaces. */
  command: string;
}

/** Shell syntax that runs more than the one command, or changes what it runs. */
const UNSAFE = /[;&|<>`$(){}\\\n\r]|<U\+/;
/** `NAME=value cmd`: a variable can turn any program into another. */
const ASSIGNMENT = /^\s*[A-Za-z_][A-Za-z0-9_]*=/;
const WORD = /^[A-Za-z0-9_][\w.+:@/-]*$/;
const MAX_RULE = 300;

export function normalize(line: string): string {
  return line.trim().replace(/[ \t]+/g, ' ');
}

/** Whether a rule may ever cover this line. */
export function ruleSafe(line: string): boolean {
  const n = normalize(line);
  return !!n && n.length <= MAX_RULE && !UNSAFE.test(n) && !ASSIGNMENT.test(n);
}

/** The rules "Always allow" can offer for a command: the exact line, and program + subcommand. */
export function ruleCandidates(line: string): CommandRule[] {
  if (!ruleSafe(line)) return [];
  const n = normalize(line);
  const words = n.split(' ');
  const out: CommandRule[] = [{ kind: 'exact', command: n }];
  if (words.length > 2 && WORD.test(words[0]) && /^[a-z][\w:-]*$/i.test(words[1])) out.push({ kind: 'prefix', command: `${words[0]} ${words[1]}` });
  return out;
}

export function matchesRule(line: string, rules: readonly CommandRule[]): CommandRule | undefined {
  if (!ruleSafe(line)) return undefined;
  const n = normalize(line);
  return rules.find((r) => (r.kind === 'exact' ? n === r.command : n === r.command || n.startsWith(`${r.command} `)));
}

export function isRule(v: unknown): v is CommandRule {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (r.kind === 'exact' || r.kind === 'prefix') && typeof r.command === 'string' && ruleCandidates(r.kind === 'prefix' ? `${r.command} x` : r.command).some((c) => c.kind === r.kind && c.command === r.command);
}

export function describeRule(r: CommandRule): string {
  return r.kind === 'exact' ? r.command : `${r.command} …`;
}
