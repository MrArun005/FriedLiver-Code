import { describe, expect, it } from 'vitest';
import { MAX_SCALE, clampPan, fitScale, navTo, zoomTo } from '../src/shared/viewer';

describe('the image viewer', () => {
  it('moves through the set with the arrows, Home and End, stopping at the ends', () => {
    expect(navTo('ArrowRight', 2, 12)).toBe(3);
    expect(navTo('ArrowLeft', 2, 12)).toBe(1);
    expect(navTo('ArrowRight', 11, 12)).toBe(11);
    expect(navTo('ArrowLeft', 0, 12)).toBe(0);
    expect(navTo('Home', 7, 12)).toBe(0);
    expect(navTo('End', 3, 12)).toBe(11);
    expect(navTo('x', 3, 12)).toBeUndefined();
  });

  it('fits an image in the stage, never past 100%', () => {
    expect(fitScale(2000, 1000, 1000, 800)).toBe(0.5);
    expect(fitScale(400, 300, 1000, 800)).toBe(1);
  });

  it('zooms by steps between fit and 8×, 0 back to fit', () => {
    const fit = 0.5;
    expect(zoomTo('in', 0.5, fit)).toBeCloseTo(0.625);
    expect(zoomTo('out', 0.5, fit)).toBe(0.5);
    expect(zoomTo('in', 7.5, fit)).toBe(MAX_SCALE);
    expect(zoomTo('fit', 3, fit)).toBe(fit);
    // Double-click: fit <-> 100%.
    expect(zoomTo('toggle', fit, fit)).toBe(1);
    expect(zoomTo('toggle', 1, fit)).toBe(fit);
    // A small image is already at 100% when fitted: the toggle shows it at 2×.
    expect(zoomTo('toggle', 1, 1)).toBe(2);
  });

  it('pans only as far as the image overhangs the stage', () => {
    expect(clampPan(500, -50, 1600, 900, 1000, 800)).toEqual({ x: 300, y: -50 });
    expect(clampPan(40, 40, 800, 600, 1000, 800)).toEqual({ x: 0, y: 0 });
  });
});
