// Bounds on what agents send, so a buggy or hostile agent can't fill the editor's memory
// or have something other than an image shown as one.
import type * as acp from '@agentclientprotocol/sdk';
import { IMAGE_MIME, LIMITS } from '../shared/messages';

/** The largest file an agent may read through FriedLiver in one request. */
export const MAX_AGENT_READ_BYTES = 64 * 1024 * 1024;
/** Tool input and output kept in updates the webviews get; larger ones are left out. */
export const MAX_RAW_JSON = 64 * 1024;
/** Characters of each side of a diff in a tool call the webviews get; the transcript shows a short preview of it. */
export const MAX_DIFF_TEXT = 256 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * A data: URI for an image an agent sent, or null when it isn't one of the
 * image types the views show, isn't base64, or is larger than an attachment may be.
 * The views show it only through <img>, where even SVG can't run script.
 */
export function imageDataUri(mimeType: unknown, data: unknown): string | null {
  if (typeof mimeType !== 'string' || !IMAGE_MIME.test(mimeType)) return null;
  if (typeof data !== 'string' || !data || data.length > LIMITS.imageData || !BASE64.test(data)) return null;
  return `data:${mimeType};base64,${data}`;
}

/**
 * An update as the webviews get it. Every update goes to every view, and the
 * transcript never shows media payloads (images reach the Images view on their
 * own) or very large raw tool input and output, so those are left out.
 */
export function compactUpdate(update: acp.SessionUpdate): acp.SessionUpdate {
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      return { ...update, content: compactBlock(update.content) };
    case 'tool_call':
    case 'tool_call_update': {
      const out = { ...update };
      if (update.content) out.content = update.content.map((c) => (c.type === 'content' ? { ...c, content: compactBlock(c.content) } : c.type === 'diff' ? compactDiff(c) : c));
      if (tooLarge(update.rawInput)) delete out.rawInput;
      if (tooLarge(update.rawOutput)) delete out.rawOutput;
      return out;
    }
    default:
      return update;
  }
}

function compactDiff(diff: acp.Diff & { type: 'diff' }): acp.Diff & { type: 'diff' } {
  const cut = (t: string) => (t.length > MAX_DIFF_TEXT ? t.slice(0, MAX_DIFF_TEXT) : t);
  if ((diff.oldText?.length ?? 0) <= MAX_DIFF_TEXT && (diff.newText?.length ?? 0) <= MAX_DIFF_TEXT) return diff;
  return { ...diff, oldText: diff.oldText == null ? diff.oldText : cut(diff.oldText), newText: cut(diff.newText ?? '') };
}

function compactBlock(block: acp.ContentBlock): acp.ContentBlock {
  if (block.type === 'image' || block.type === 'audio') return { ...block, data: '' };
  if (block.type === 'resource' && 'blob' in block.resource) return { ...block, resource: { ...block.resource, blob: '' } };
  return block;
}

function tooLarge(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  try {
    return JSON.stringify(value).length > MAX_RAW_JSON;
  } catch {
    return true;
  }
}
