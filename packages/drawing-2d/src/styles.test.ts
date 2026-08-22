import { describe, it, expect } from 'vitest';
import { getRecommendedScale, COMMON_SCALES } from './styles.js';

// A3 landscape, the function's own default, is 420 x 297 mm. The usable area
// is 90% of that: 378 x 267.3 mm.
describe('getRecommendedScale', () => {
  it('picks a plan scale for a building, not full size', () => {
    // 30 x 20 m at 1:100 is 300 x 200 mm, inside 378 x 267.3.
    // At 1:50 it is 600 x 400 mm, outside. So 1:100 is the tightest fit.
    expect(getRecommendedScale(30, 20).name).toBe('1:100');
  });

  it('picks a coarser scale for a site than for a building', () => {
    const building = getRecommendedScale(30, 20).factor;
    const site = getRecommendedScale(300, 200).factor;
    expect(site).toBeGreaterThan(building);
  });

  it('only ever returns full size for something that is actually full size', () => {
    // 1:1 must mean the model fits the sheet in millimetres. 0.3 x 0.2 m is
    // 300 x 200 mm, which does. A 30 m building does not, and the metre/mm
    // confusion is exactly what used to say otherwise.
    expect(getRecommendedScale(0.3, 0.2).name).toBe('1:1');
    expect(getRecommendedScale(30, 20).name).not.toBe('1:1');
  });

  it('respects the 10% margin rather than the raw sheet', () => {
    // 0.378 m is 378 mm, exactly the 90% width. It fits at 1:1.
    expect(getRecommendedScale(0.378, 0.2).name).toBe('1:1');
    // 0.379 m is 379 mm, just past it, so 1:1 must be rejected.
    expect(getRecommendedScale(0.379, 0.2).name).not.toBe('1:1');
  });

  it('lets the height bind when it is the tighter dimension', () => {
    // 0.3 x 0.28 m: width fits 1:1 (300 <= 378), height does not (280 > 267.3).
    expect(getRecommendedScale(0.3, 0.28).name).not.toBe('1:1');
  });

  it('honours an explicit paper size', () => {
    // A4 portrait, 210 x 297. 0.3 m is 300 mm, past 189 mm of usable width.
    expect(getRecommendedScale(0.3, 0.2, 210, 297).name).not.toBe('1:1');
  });

  it('falls back to the coarsest scale for something too big for any of them', () => {
    // Written as a literal on purpose. Taking the expected value from
    // COMMON_SCALES[length - 1] would be an oracle built from the same array
    // the code indexes, so it would agree with the code however the array is
    // ordered and pin nothing.
    expect(getRecommendedScale(1e6, 1e6).name).toBe('1:1000');
  });

  // The loop returns the FIRST scale that fits and calls it the tightest.
  // That is only true while the table runs finest to coarsest, and four
  // consumers now depend on that ordering: this loop, plus positional reads
  // COMMON_SCALES[5] and [6] in svg-exporter.ts and sheetSlice.ts, plus the
  // sheet setup dropdown which renders it in order. Nothing enforced it.
  it('keeps COMMON_SCALES ordered finest to coarsest, which the search relies on', () => {
    const factors = COMMON_SCALES.map(s => s.factor);
    expect(factors).toStrictEqual([...factors].sort((a, b) => a - b));
    expect(new Set(factors).size).toBe(factors.length);
  });

  // Every comparison in the search is `<=`, and NaN loses all of them, so
  // before the guard an unusable input fell through the whole table and
  // returned the coarsest scale: a plausible 1:1000 indistinguishable from a
  // real answer. These pin that an unusable input is now loud.
  it.each<[string, number, number]>([
    ['NaN width', NaN, 20],
    ['undefined height', 30, undefined as unknown as number],
    ['Infinity width', Infinity, 20],
    ['zero width', 0, 20],
    ['negative height', 30, -20],
  ])('throws on %s instead of returning a plausible scale', (_label, w, h) => {
    expect(() => getRecommendedScale(w, h)).toThrow(/positive finite number/);
  });

  it('names which argument was bad', () => {
    expect(() => getRecommendedScale(30, 20, 0, 297)).toThrow(/paperWidth/);
    expect(() => getRecommendedScale(30, 20, 420, NaN)).toThrow(/paperHeight/);
    expect(() => getRecommendedScale(-1, 20)).toThrow(/boundsWidth/);
    expect(() => getRecommendedScale(30, -1)).toThrow(/boundsHeight/);
  });
});
