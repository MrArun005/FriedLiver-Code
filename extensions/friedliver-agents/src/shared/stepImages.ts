import type { Item } from './model';

/** Image files a step can preview. SVG too: the webview shows it only as an <img>, where its scripts don't run. */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

export const isImagePath = (p: string): boolean => IMAGE_EXT.test(p);

export interface StepImage {
  path: string;
  title: string;
}

/** A file name as a title: no folder or extension, separators as spaces, a capital first. */
export function humanTitle(file: string): string {
  const name = (file.split(/[\\/]/).pop() ?? file).replace(/\.[^.]+$/, '');
  const words = name.replace(/[-_.\s]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

/** The image a step reads or makes: an image location, or the file a browser screenshot saved. */
export function stepImage(t: Extract<Item, { kind: 'tool' }>): StepImage | null {
  const text = t.out?.find((o) => o.t === 'text')?.text ?? '';
  const saved = /^Saved to (.+?\.(?:png|jpe?g|gif|webp|svg))\. /im.exec(text)?.[1];
  const file = t.locations.find(isImagePath) ?? saved;
  if (!file) return null;
  const shot = saved && /^(Screenshot of .+)$/m.exec(text)?.[1];
  return { path: file, title: t.about?.trim() || shot || humanTitle(file) };
}

/** Every image the chat's steps read or made, once each, in order. */
export function chatImages(items: readonly Item[]): StepImage[] {
  const seen = new Set<string>();
  const out: StepImage[] = [];
  for (const item of items) {
    if (item.kind !== 'tool') continue;
    const img = stepImage(item);
    if (img && !seen.has(img.path)) {
      seen.add(img.path);
      out.push(img);
    }
  }
  return out;
}
