// How careful a request needs the user to be, for the phone's approval cards
// (RESEARCH.md §3 C): routine, review, or careful. Careful ones are red, list
// what will happen, allow only once, and need a press-and-hold on the phone.
// ponytail: a phone-local pattern list; swap for the shared classifier from feat/modern-approvals once it lands.

export type RiskLevel = 'routine' | 'review' | 'careful';

export interface Risk {
  level: RiskLevel;
  /** Two or three words for the chip: "Rewrites shared history". */
  label: string;
  /** What will happen, for careful requests. */
  consequences: string[];
}

const CAREFUL_COMMANDS: [RegExp, string, string[]][] = [
  [/\bgit\s+push\b[^\n]*\s(--force(?!-with-lease)\b|-f\b)/, 'Rewrites shared history', ['Replaces commits on the remote that are not in your branch', 'Other people’s work there could be lost']],
  [/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*|--recursive)\b/, 'Deletes files', ['Removes files and folders without the trash', 'FriedLiver can’t undo it']],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f[a-zA-Z]*|checkout\s+--\s|stash\s+(drop|clear))\b/, 'Discards changes', ['Uncommitted work is thrown away']],
  [/(^|[\s;&|(])sudo\b/, 'Runs as administrator', ['The command can change anything on this Mac']],
  [/\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/, 'Runs a downloaded script', ['Code from the internet runs without review']],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bgh\s+release\s+create\b/, 'Publishes a package', ['Others can install what is published', 'A published version can’t be taken back']],
  [/\b(dd|mkfs|diskutil\s+erase)/, 'Writes to a disk', ['Data on the disk can be lost']],
];

const ROUTINE_COMMANDS = /^\s*((npx\s+)?(vitest|jest|pytest|tsc|eslint|prettier\s+--check)|(npm|pnpm|yarn)\s+(run\s+)?(test|lint|typecheck|build)|go\s+(test|vet|build)|cargo\s+(test|check|build)|git\s+(status|diff|log|show)|ls|cat|pwd|node\s+--version)\b/;

const SENSITIVE_PATHS: [RegExp, string][] = [
  [/(^|\/)\.env(\.|$)/, 'Secrets file'],
  [/(^|\/)\.ssh\/|id_(rsa|ed25519|ecdsa)/, 'SSH keys'],
  [/(^|\/)\.git(\/|$)/, 'Git internals'],
  [/(^|\/)\.(aws|gnupg|kube|docker)\//, 'Credentials'],
];

export function commandRisk(line: string): Risk {
  for (const [re, label, consequences] of CAREFUL_COMMANDS) if (re.test(line)) return { level: 'careful', label, consequences };
  if (/\bgit\s+push\b/.test(line)) return { level: 'review', label: 'Pushes to the remote', consequences: [] };
  if (ROUTINE_COMMANDS.test(line) && !/[;&|`$><]/.test(line)) return { level: 'routine', label: 'Routine', consequences: [] };
  return { level: 'review', label: 'Runs a command', consequences: [] };
}

/** Files an edit touches: careful when one is a secret, a key or git's own; else in or outside the workspace. */
export function pathRisk(paths: string[], outside = false): Risk {
  for (const p of paths) for (const [re, label] of SENSITIVE_PATHS) if (re.test(p)) return { level: 'careful', label, consequences: ['It holds secrets, or settings that run code', 'Allowed once only'] };
  return outside ? { level: 'careful', label: 'Outside the workspace', consequences: ['The file is outside the folders you opened'] } : { level: 'review', label: 'Inside the workspace', consequences: [] };
}

/** A permission request's risk, from what its card shows: the command, else the files, else a review. */
export function requestRisk(detail: { command?: { line: string }; files?: { path: string }[]; locations?: string[]; plan?: string } | undefined): Risk {
  if (detail?.command) return commandRisk(detail.command.line);
  const paths = [...(detail?.files ?? []).map((f) => f.path), ...(detail?.locations ?? [])];
  if (paths.length) return pathRisk(paths);
  return { level: 'review', label: detail?.plan ? 'Plan' : 'Needs a look', consequences: [] };
}
