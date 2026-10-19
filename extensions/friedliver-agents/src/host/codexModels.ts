import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModelVisibility } from '../shared/session';

/**
 * Which models Codex lets this account use, from the cache Codex keeps of the
 * server's model list (~/.codex/models_cache.json, or $CODEX_HOME). Only read,
 * never written. Undefined when there is none or it can't be read.
 */
export async function codexModelVisibility(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')): Promise<ModelVisibility | undefined> {
  try {
    const raw = JSON.parse(await readFile(path.join(home, 'models_cache.json'), 'utf8')) as { models?: unknown };
    if (!Array.isArray(raw.models)) return undefined;
    const out: ModelVisibility = { listed: [], hidden: [] };
    for (const m of raw.models as { slug?: unknown; visibility?: unknown }[]) {
      if (typeof m?.slug !== 'string') continue;
      if (m.visibility === 'list') out.listed.push(m.slug);
      else if (m.visibility === 'hide') out.hidden.push(m.slug);
    }
    return out.listed.length || out.hidden.length ? out : undefined;
  } catch {
    return undefined;
  }
}
