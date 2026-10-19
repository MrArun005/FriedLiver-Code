// The image viewer's arithmetic: where a key moves to in the set, and how far it zooms and pans. Pure, for the tests.

/** The most the viewer zooms in: 8× the image's own size. */
export const MAX_SCALE = 8;
const STEP = 1.25;

/** The index a key moves to (the arrows stop at the ends), or undefined for any other key. */
export function navTo(key: string, at: number, n: number): number | undefined {
  if (key === 'ArrowRight') return Math.min(n - 1, at + 1);
  if (key === 'ArrowLeft') return Math.max(0, at - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return undefined;
}

/** The scale that shows the whole image in the stage; small images stay at 100%. */
export function fitScale(w: number, h: number, stageW: number, stageH: number): number {
  return Math.min(1, stageW / Math.max(1, w), stageH / Math.max(1, h));
}

/** The next scale: a step in or out (never smaller than fit), back to fit, or fit <-> 100% (double-click; 2× for a small image). */
export function zoomTo(how: 'in' | 'out' | 'fit' | 'toggle', scale: number, fit: number): number {
  if (how === 'fit') return fit;
  // At fit, the image's own size; an image already shown whole at 100% goes to 2×.
  if (how === 'toggle') return Math.abs(scale - fit) < 1e-6 ? (fit < 1 ? 1 : 2) : fit;
  const next = how === 'in' ? scale * STEP : scale / STEP;
  return Math.min(MAX_SCALE, Math.max(fit, next));
}

/** The pan offset from the centre, kept to how far the scaled image overhangs the stage. */
export function clampPan(x: number, y: number, w: number, h: number, stageW: number, stageH: number): { x: number; y: number } {
  const mx = Math.max(0, (w - stageW) / 2);
  const my = Math.max(0, (h - stageH) / 2);
  return { x: Math.max(-mx, Math.min(mx, x)) || 0, y: Math.max(-my, Math.min(my, y)) || 0 };
}
