import { stat } from 'node:fs/promises';
import { isImagePath } from '../shared/stepImages';
import { insideRoots } from './paths';

/** Bigger images show as their name only. */
export const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;

/**
 * The file, when a webview may show it: an image file of at most
 * MAX_PREVIEW_BYTES inside one of `roots` (also after symlinks), else null.
 */
export async function previewableImage(file: string, roots: readonly string[]): Promise<string | null> {
  if (!isImagePath(file)) return null;
  const inside = insideRoots(file, roots);
  if (!inside) return null;
  const info = await stat(inside).catch(() => null);
  return info?.isFile() && info.size <= MAX_PREVIEW_BYTES ? inside : null;
}
