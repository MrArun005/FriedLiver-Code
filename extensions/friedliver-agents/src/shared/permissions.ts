// What "Always allow" can remember, beyond one chat: a website (its exact origin), a folder (and
// everything below it, reading or changing files), a command (rules.ts), or one of the FriedLiver
// tools agents use to reach each other. Every agent (Claude, Codex, Gemini, Claude Code outside
// FriedLiver) gets the same answers. Pure, so the webviews use it too; matching folders on disk
// is in host/permissions.ts.
import { describeRule, isRule, type CommandRule } from './rules';
import { alwaysAllowable, describeTarget, isSystemTool, SYSTEM_WORDS, type SystemTool } from './system';

export type Access = 'read' | 'write';
export const TOOL_GRANTS = ['ask_agent', 'send_to_chat', 'read_chat', 'remember'] as const;
export type ToolGrant = (typeof TOOL_GRANTS)[number];

/** An OS action (shared/system.ts) on one target: `app:Spotify`, `url:<origin>`, `file:<path>`, a Shortcut's name, or '' for any. */
export type SystemGrant = { kind: 'system'; tool: SystemTool; target: string };

export type Grant =
  | CommandRule
  | { kind: 'site'; origin: string }
  | { kind: 'folder'; folder: string; access: Access }
  | { kind: 'tool'; tool: ToolGrant }
  | SystemGrant;

/** A remembered grant, with when and from which agent's request; `scope` says where it is kept. */
export interface Remembered {
  id: string;
  grant: Grant;
  at?: number;
  agent?: string;
  scope: 'user' | 'workspace';
}

const TOOL_WORDS: Record<ToolGrant, string> = {
  ask_agent: 'Ask another agent',
  send_to_chat: 'Message another chat',
  read_chat: 'Read another chat',
  remember: 'Add to project memory',
};

/** The origin of an http(s) URL (https://www.irctc.co.in), or undefined for anything else. */
export function siteOrigin(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

const ABSOLUTE = /^(\/|[A-Za-z]:[\\/])/;

export function isGrant(v: unknown): v is Grant {
  if (!v || typeof v !== 'object') return false;
  const g = v as Record<string, unknown>;
  switch (g.kind) {
    case 'exact':
    case 'prefix':
      return isRule(v);
    case 'site':
      return typeof g.origin === 'string' && siteOrigin(g.origin) === g.origin;
    case 'folder':
      return (
        typeof g.folder === 'string' &&
        g.folder.length <= 4096 &&
        ABSOLUTE.test(g.folder) &&
        !g.folder.includes('\0') &&
        !g.folder.split(/[\\/]/).includes('..') &&
        (g.access === 'read' || g.access === 'write')
      );
    case 'tool':
      return (TOOL_GRANTS as readonly unknown[]).includes(g.tool);
    case 'system':
      // A stored or posted grant for something never always allowed (the clipboard, a terminal) is no grant.
      return (
        isSystemTool(g.tool) &&
        typeof g.target === 'string' &&
        g.target.length <= 4096 &&
        // eslint-disable-next-line no-control-regex
        !/[\u0000-\u001f\u007f]/.test(g.target) &&
        alwaysAllowable(g.tool, g.target)
      );
    default:
      return false;
  }
}

/** Only the grant's own fields: nothing extra from a message or storage comes along. */
export function cleanGrant(g: Grant): Grant {
  switch (g.kind) {
    case 'site':
      return { kind: 'site', origin: g.origin };
    case 'folder':
      return { kind: 'folder', folder: g.folder, access: g.access };
    case 'tool':
      return { kind: 'tool', tool: g.tool };
    case 'system':
      return { kind: 'system', tool: g.tool, target: g.target };
    default:
      return { kind: g.kind, command: g.command };
  }
}

export function grantId(g: Grant): string {
  switch (g.kind) {
    case 'site':
      return `site ${g.origin}`;
    case 'folder':
      return `folder-${g.access} ${g.folder}`;
    case 'tool':
      return `tool ${g.tool}`;
    case 'system':
      return `system ${g.tool} ${g.target}`;
    default:
      return `command-${g.kind} ${g.command}`;
  }
}

export const sameGrant = (a: Grant, b: Grant) => grantId(a) === grantId(b);

/** What the grant lets agents do, and where, in words for the approval menu and Manage Permissions. */
export function describeGrant(g: Grant): { what: string; scope: string } {
  switch (g.kind) {
    case 'site':
      return { what: 'Use this website in the browser', scope: g.origin };
    case 'folder':
      return { what: g.access === 'read' ? 'Read files in this folder' : 'Change files in this folder', scope: g.folder };
    case 'tool':
      return { what: TOOL_WORDS[g.tool], scope: 'any chat' };
    case 'system':
      return { what: SYSTEM_WORDS[g.tool], scope: describeTarget(g.target) };
    default:
      return { what: g.kind === 'exact' ? 'Run this exact command' : 'Run this command and anything after it', scope: describeRule(g) };
  }
}
