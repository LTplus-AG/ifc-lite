/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The printed scale record of a to-scale sheet (issue #2042).
 *
 * DEFECT CLASS 1 — a scale bar that is not to scale. A bar is worth exactly as
 * much as the claim that the length it labels "1 m" really is 1000/N mm of
 * paper. So nothing here counts rectangles: every assertion multiplies a
 * label's own metre value by the layout's own `worldToMm` and demands the
 * label be there.
 *
 * DEFECT CLASS 2 — furniture that re-fits the drawing. `calculateDrawingTransform`
 * in this same folder shrinks a drawing to fit (`min(scaleX, scaleY, 1)`);
 * routing a stamped sheet through anything like it would leave a page that
 * looks right, carries a printed "1:100", and measures wrong. The test below
 * measures a real distance between two projected world points with the stamp on
 * and off and demands it not move by so much as an ulp.
 *
 * DEFECT CLASS 3 — a sheet that lies about its scale in text. 1:99.5 must print
 * "1:99.5"; rounding it to "1:100" misreports the sheet by half a percent,
 * which is the error nobody thinks to look for (#2119). And where two decimals
 * genuinely cannot hold the factor — "as displayed" delivers 1:87.3456 — the
 * text has to SAY it rounded, because a bare "1:87.35" is a number an engineer
 * would trust and should not.
 */

import { describe, expect, it } from 'vitest';
import { addScaleStamp, buildScaleStamp, SCALE_STAMP_HEIGHT_MM } from './scale-stamp.js';
import {
  computePdfScaleLayout,
  formatScaleFactorLabel,
  worldPointToPdfMm,
} from '../pdf-scale.js';
import type { Bounds2D } from '../types.js';

/** 12 m x 8 m of drawing: at 1:100 that is 120 x 80 mm, page 140 x 100 mm. */
const BOUNDS: Bounds2D = { min: { x: 0, y: 0 }, max: { x: 12, y: 8 } };
const MARGIN_MM = 10;

/** mm of paper per metre of world at 1:N. */
const worldToMmAt = (scaleFactor: number): number => 1000 / scaleFactor;

describe('buildScaleStamp: the bar is drawn to scale (#2042)', () => {
  it('puts every tick label exactly its own metre value from the bar origin', () => {
    const worldToMm = worldToMmAt(100);
    const stamp = buildScaleStamp({
      worldToMm,
      availableWidthMm: 120,
      originXMm: 10,
      originYMm: 90,
    });

    const ticks = stamp.texts.filter((t) => t.metres !== null);
    expect(ticks.length).toBe(stamp.bar.divisions + 1);
    for (const tick of ticks) {
      expect(tick.xMm - stamp.bar.xMm).toBeCloseTo((tick.metres ?? 0) * worldToMm, 12);
    }

    // The claim in plain words: a division labelled "1 m" measures exactly
    // 1000/scaleFactor mm of paper. At 1:100 the 12 m drawing takes 4 divisions
    // of 1 m, so a label reading "1" sits 10.000 mm along the bar.
    expect(stamp.bar.divisionMetres).toBe(1);
    expect(stamp.bar.divisionWidthMm).toBeCloseTo(10, 12);
    const oneMetre = ticks.find((t) => t.metres === 1);
    expect(oneMetre?.text).toBe('1');
    expect((oneMetre?.xMm ?? 0) - stamp.bar.xMm).toBeCloseTo(10, 12);

    // And the bar as a whole: 4 divisions of 1 m at 10 mm/m.
    expect(stamp.bar.widthMm).toBeCloseTo(stamp.bar.divisions * 10, 12);
    expect(stamp.rects.length).toBe(stamp.bar.divisions);
    for (const rect of stamp.rects) {
      expect(rect.widthMm).toBeCloseTo(stamp.bar.divisionWidthMm, 12);
    }
  });

  it('keeps a division to scale when the scale changes, at half the ratio', () => {
    // A bar is allowed to pick a different division LENGTH at a different
    // scale (that is what keeps it readable), but whatever it picks must be
    // printed at exactly `divisionMetres * worldToMm`.
    for (const scaleFactor of [10, 20, 50, 100, 200, 500, 99.5]) {
      const worldToMm = worldToMmAt(scaleFactor);
      const stamp = buildScaleStamp({
        worldToMm,
        availableWidthMm: 120,
        originXMm: 10,
        originYMm: 90,
      });
      expect(stamp.bar.divisionWidthMm).toBeCloseTo(stamp.bar.divisionMetres * worldToMm, 12);
      expect(stamp.bar.widthMm).toBeCloseTo(
        stamp.bar.divisions * stamp.bar.divisionMetres * worldToMm,
        12,
      );
      // Readable: never shorter than the 20 mm floor, and it stops at the paper
      // it was given whenever a bar that long exists at this scale.
      expect(stamp.bar.widthMm).toBeGreaterThanOrEqual(20);
      expect(stamp.bar.widthMm).toBeLessThanOrEqual(120);
    }
  });

  it('states the exact ratio, never a rounded one', () => {
    const stamp = buildScaleStamp({
      worldToMm: worldToMmAt(99.5),
      availableWidthMm: 120,
      originXMm: 10,
      originYMm: 90,
    });
    expect(stamp.scaleLabel).toBe('1:99.5');
    expect(stamp.texts.some((t) => t.text === 'Scale 1:99.5')).toBe(true);
    expect(stamp.texts.some((t) => t.text.includes('1:100'))).toBe(false);
  });

  it('says "about" for a factor two decimals cannot hold, and draws it unrounded', () => {
    // "As displayed" hands over whatever the viewport sits at. 87.3456 prints
    // as "87.35" whatever we do — two decimals is what the filename carries and
    // the two must agree — so the sheet says the ratio is the nearest hundredth
    // instead of stating a scale the drawing was not drawn at.
    const factor = 87.3456;
    const worldToMm = worldToMmAt(factor);
    const stamp = buildScaleStamp({
      worldToMm,
      availableWidthMm: 120,
      originXMm: 10,
      originYMm: 90,
    });

    expect(stamp.scaleLabel).toBe('about 1:87.35');
    expect(stamp.texts.some((t) => t.text === 'Scale about 1:87.35')).toBe(true);
    // The hedge is the whole point: an unhedged "Scale 1:87.35" is the number
    // an engineer would trust and should not.
    expect(stamp.texts.some((t) => t.text === 'Scale 1:87.35')).toBe(false);

    // And the bar is laid out at the factor the drawing was DRAWN at, not the
    // one printed beside it. The two differ by 5.8e-4 mm per 10 mm of bar,
    // which is far above the tolerance below — so this fails if the layout ever
    // starts from the rounded label.
    expect(stamp.bar.divisionWidthMm).toBeCloseTo(stamp.bar.divisionMetres * worldToMm, 12);
    expect(stamp.bar.divisionWidthMm).not.toBeCloseTo(
      stamp.bar.divisionMetres * worldToMmAt(87.35),
      9,
    );
  });

  it('states a preset ratio flat, with no hedge to erode it', () => {
    // The hedge has to be rare or it stops meaning anything. Every drafting
    // preset, and any factor two decimals hold exactly, prints bare.
    for (const factor of [10, 20, 50, 100, 200, 500, 99.5, 87.35]) {
      const stamp = buildScaleStamp({
        worldToMm: worldToMmAt(factor),
        availableWidthMm: 120,
        originXMm: 10,
        originYMm: 90,
      });
      expect(stamp.scaleLabel).toBe(`1:${formatScaleFactorLabel(factor)}`);
      expect(stamp.scaleLabel.includes('about')).toBe(false);
    }
  });

  it('prints a readable bar rather than a to-scale sliver on a narrow sheet', () => {
    // 1 m of drawing at 1:100 is 10 mm of paper. A bar that fitted it would be
    // in scale, present, and useless; the shortest readable bar wins instead
    // and the caller's page grows to hold it.
    const stamp = buildScaleStamp({
      worldToMm: worldToMmAt(100),
      availableWidthMm: 10,
      originXMm: 10,
      originYMm: 90,
    });
    expect(stamp.bar.widthMm).toBeGreaterThanOrEqual(20);
    // Still to scale, which is the part that may never be traded away.
    expect(stamp.bar.divisionWidthMm).toBeCloseTo(stamp.bar.divisionMetres * 10, 12);
  });

  it('refuses a scale that is not a scale', () => {
    const placement = { availableWidthMm: 120, originXMm: 10, originYMm: 90 };
    expect(() => buildScaleStamp({ ...placement, worldToMm: 0 })).toThrow(/scale/i);
    expect(() => buildScaleStamp({ ...placement, worldToMm: Number.NaN })).toThrow(/scale/i);
    expect(() => buildScaleStamp({ ...placement, worldToMm: -10 })).toThrow(/scale/i);
    expect(() =>
      buildScaleStamp({ ...placement, worldToMm: 10, originYMm: Number.POSITIVE_INFINITY }),
    ).toThrow(/finite/i);
  });
});

describe('addScaleStamp: the drawing does not move (#2042)', () => {
  it('measures the same distance between two world points with the stamp and without', () => {
    const base = computePdfScaleLayout(BOUNDS, 100, MARGIN_MM);
    const stamped = addScaleStamp(base, { marginMm: MARGIN_MM });

    // Two world points 7 m apart on each axis, mapped through each layout's own
    // transform. This is the whole contract: furniture may grow the paper, and
    // may not touch a millimetre of the drawing.
    const a = { x: 2, y: 1 };
    const b = { x: 9, y: 8 };
    const baseA = worldPointToPdfMm(a, base.transform);
    const baseB = worldPointToPdfMm(b, base.transform);
    const stampedA = worldPointToPdfMm(a, stamped.transform);
    const stampedB = worldPointToPdfMm(b, stamped.transform);

    expect(stampedA).toEqual(baseA);
    expect(stampedB).toEqual(baseB);
    expect(Math.hypot(stampedB.x - stampedA.x, stampedB.y - stampedA.y)).toBe(
      Math.hypot(baseB.x - baseA.x, baseB.y - baseA.y),
    );
    // 7 m at 1:100 is 70 mm, whatever else is on the sheet.
    expect(stampedB.x - stampedA.x).toBeCloseTo(70, 12);
    expect(stamped.transform.worldToMm).toBe(base.transform.worldToMm);
  });

  it('grows the page downward by the band and leaves the drawing where it was', () => {
    const base = computePdfScaleLayout(BOUNDS, 100, MARGIN_MM);
    const stamped = addScaleStamp(base, { marginMm: MARGIN_MM });

    expect(base.page.widthMm).toBeCloseTo(140, 12);
    expect(base.page.heightMm).toBeCloseTo(100, 12);
    expect(stamped.page.heightMm).toBeCloseTo(100 + SCALE_STAMP_HEIGHT_MM, 12);
    // The bar is 120 mm of a 140 mm page, so nothing forces the page wider.
    expect(stamped.page.widthMm).toBeCloseTo(140, 12);

    // The band sits below the drawing's bottom edge (page height minus margin)
    // and above the new bottom margin, so it can never overlap the ink.
    const drawingBottomMm = base.page.heightMm - MARGIN_MM;
    const bandBottomMm = stamped.page.heightMm - MARGIN_MM;
    for (const rect of stamped.stamp.rects) {
      expect(rect.yMm).toBeGreaterThanOrEqual(drawingBottomMm);
      expect(rect.yMm + rect.heightMm).toBeLessThanOrEqual(bandBottomMm);
      expect(rect.xMm).toBeGreaterThanOrEqual(MARGIN_MM);
      expect(rect.xMm + rect.widthMm).toBeLessThanOrEqual(stamped.page.widthMm - MARGIN_MM);
    }
    for (const text of stamped.stamp.texts) {
      expect(text.yMm).toBeGreaterThan(drawingBottomMm);
      expect(text.yMm).toBeLessThanOrEqual(bandBottomMm);
    }
  });

  it('widens the page only when the band is wider than the drawing', () => {
    // A 1 m x 1 m drawing at 1:100 is 10 x 10 mm: far narrower than the
    // shortest readable bar, so the page has to grow sideways to carry the
    // scale record. It still may not grow the DRAWING.
    const tiny: Bounds2D = { min: { x: 0, y: 0 }, max: { x: 1, y: 1 } };
    const base = computePdfScaleLayout(tiny, 100, MARGIN_MM);
    const stamped = addScaleStamp(base, { marginMm: MARGIN_MM });

    expect(base.page.widthMm).toBeCloseTo(30, 12);
    expect(stamped.page.widthMm).toBeGreaterThan(base.page.widthMm);
    expect(stamped.page.widthMm).toBeCloseTo(
      MARGIN_MM * 2 + stamped.stamp.widthMm,
      12,
    );
    const p = worldPointToPdfMm({ x: 1, y: 1 }, stamped.transform);
    expect(p.x).toBeCloseTo(MARGIN_MM + 10, 12);
    expect(p.y).toBeCloseTo(MARGIN_MM, 12);
  });

  it('refuses an unusable margin or page instead of stamping a broken sheet', () => {
    const base = computePdfScaleLayout(BOUNDS, 100, MARGIN_MM);
    expect(() => addScaleStamp(base, { marginMm: -1 })).toThrow(/margin/i);
    expect(() => addScaleStamp(base, { marginMm: Number.NaN })).toThrow(/margin/i);
    expect(() =>
      addScaleStamp(
        { transform: base.transform, page: { widthMm: 0, heightMm: 0 } },
        { marginMm: MARGIN_MM },
      ),
    ).toThrow(/no usable size/i);
  });
});
