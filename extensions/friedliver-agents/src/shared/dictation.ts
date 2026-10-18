// The composer's dictation: where the words being spoken sit in the message box.

export type DictationState = 'idle' | 'listening' | 'stopping';
/** What the host tells a chat's composer: its mic's state ('fallback': no helper, show the Fn Fn hint), or the words so far, or the input's loudness (0…1) for the visualizer. */
export type DictationUpdate = { state: DictationState | 'fallback' } | { text: string; final: boolean } | { level: number };

/** The spoken segment: from `start`, `len` characters of the box (at first, the selection it replaces). */
export interface Segment {
  start: number;
  len: number;
}

/**
 * Puts `spoken` (the whole transcription so far) in place of the segment: each partial replaces
 * the last one, so text appears live at the caret. A space keeps it off the words either side.
 * `max` caps the box. Returns the new text, the caret (after the spoken words) and the segment;
 * after a final one, the segment is empty at the caret, so more speech goes after it.
 */
export function spliceDictation(text: string, seg: Segment, spoken: string, final: boolean, max: number): { text: string; caret: number; seg: Segment } {
  const start = Math.min(seg.start, text.length);
  const before = text.slice(0, start);
  const after = text.slice(Math.min(start + seg.len, text.length));
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^\s/.test(after) ? ' ' : '';
  const room = Math.max(0, max - before.length - after.length - lead.length - trail.length);
  const words = spoken.replace(/\s+/g, ' ').trim().slice(0, room);
  const piece = words ? lead + words + trail : '';
  const caret = start + (words ? lead.length + words.length : 0);
  return { text: before + piece + after, caret, seg: final ? { start: caret, len: 0 } : { start, len: piece.length } };
}

/** Bars in the listening mic's visualizer. */
export const BARS = 6;
// ponytail: fixed bar shape (taller in the middle) plus a small wobble; real per-band levels would need an FFT in the helper.
const SHAPE = [0.5, 0.8, 1, 0.9, 0.7, 0.45];

/**
 * One visualizer frame: each bar's height (0.15…1 of the pill) from the shown level and the time.
 * `shown` eases toward the latest level and decays when no level came for a while.
 */
export function visualizerFrame(shown: number, latest: number, sinceLevelMs: number, t: number): { shown: number; bars: number[] } {
  const target = sinceLevelMs > 150 ? 0 : latest;
  const next = shown + (target - shown) * (target > shown ? 0.5 : 0.15);
  const bars = SHAPE.map((s, i) => 0.15 + 0.85 * Math.min(1, next * s * (0.85 + 0.15 * Math.sin(t / 90 + i * 1.7))));
  return { shown: next, bars };
}
