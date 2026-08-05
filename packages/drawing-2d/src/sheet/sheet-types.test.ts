/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * calculateDrawingTransform() characterisation (drift risk flagged on PR
 * #2119: this is one of four "world metres -> paper millimetres at scale N"
 * transforms in the codebase, see also svg-exporter.test.ts and
 * pdf-scale.test.ts).
 *
 * Unlike the other three, this transform is a FIT-TO-VIEWPORT preview: it
 * computes `fitScale = min(scaleX, scaleY, 1)` and silently SHRINKS the
 * effective scale (never enlarges past 1:1 of the nominal scale) when the
 * drawing does not fit the viewport at the nominal scale. That is correct
 * for an on-screen sheet preview (consumed identically by
 * `Drawing2DCanvas.tsx` and `useDrawingExport.ts`'s `generateSheetSVG`,
 * both via `x * scaleFactor + translateX` / `y * scaleFactor + translateY`)
 * but would be WRONG for a document meant to be measured at an exact scale
 * — which is exactly why `pdf-scale.ts` (#2042) does not reuse this
 * function. These tests pin both branches: no-shrink-needed, and the
 * shrink actually firing.
 */

import { describe, expect, it } from 'vitest';
import { calculateDrawingTransform, calculateViewportBounds } from './sheet-types.js';
import { COMMON_SCALES } from '../styles.js';
import type { PaperSizeDefinition } from './paper-sizes.js';
import type { DrawingFrame } from './frame-types.js';
import { createTitleBlock } from './title-block-types.js';
import type { TitleBlockConfig, TitleBlockPosition } from './title-block-types.js';

const scale100 = COMMON_SCALES.find((s) => s.factor === 100)!;

describe('calculateDrawingTransform', () => {
  it('does not shrink or enlarge when the drawing fits the viewport at nominal scale', () => {
    // 4m x 3m drawing at 1:100 -> 40mm x 30mm on paper; comfortably fits a
    // 200x150mm viewport at 0.95 padding (scaleX = scaleY = 4.75), so
    // fitScale clamps to 1 and scaleFactor stays at the nominal 10mm/m.
    const { translateX, translateY, scaleFactor } = calculateDrawingTransform(
      { minX: 0, minY: 0, maxX: 4, maxY: 3 },
      { x: 0, y: 0, width: 200, height: 150 },
      scale100
    );
    expect(scaleFactor).toBeCloseTo(10, 10); // nominal 1000/100, unshrunk
    expect(translateX).toBeCloseTo(80, 6); // (200 - 4*10)/2 - 0*10
    expect(translateY).toBeCloseTo(90, 6); // (150 - 3*10)/2 + 3*10
  });

  it('uses drawingBounds.minX / .maxY (not the drawing center) to position the translate', () => {
    // Same size (4m x 3m) and viewport as above, but shifted in space —
    // pins that translateX keys off minX and translateY off maxY.
    const { translateX, translateY, scaleFactor } = calculateDrawingTransform(
      { minX: 2, minY: 5, maxX: 6, maxY: 8 },
      { x: 0, y: 0, width: 200, height: 150 },
      scale100
    );
    expect(scaleFactor).toBeCloseTo(10, 10);
    expect(translateX).toBeCloseTo(60, 6); // 80 - 2*10
    expect(translateY).toBeCloseTo(140, 6); // 60 + 8*10
  });

  it('adds the viewport origin (x, y) into the translate', () => {
    const { translateX, translateY } = calculateDrawingTransform(
      { minX: 0, minY: 0, maxX: 4, maxY: 3 },
      { x: 10, y: 20, width: 200, height: 150 },
      scale100
    );
    expect(translateX).toBeCloseTo(90, 6); // 80 + 10
    expect(translateY).toBeCloseTo(110, 6); // 90 + 20
  });

  it('SILENTLY SHRINKS scaleFactor below nominal when the drawing does not fit the viewport at nominal scale', () => {
    // 30m x 20m drawing at 1:100 -> 300mm x 200mm, which does not fit a
    // 200x150mm viewport. scaleX = (200*0.95)/300 = 19/30 ~= 0.6333,
    // scaleY = (150*0.95)/200 = 0.7125 -> fitScale = min(...) = 19/30.
    // scaleFactor = 10 * 19/30 = 19/3 ~= 6.3333 (NOT the nominal 10).
    const { scaleFactor, translateX, translateY } = calculateDrawingTransform(
      { minX: 0, minY: 0, maxX: 30, maxY: 20 },
      { x: 0, y: 0, width: 200, height: 150 },
      scale100
    );
    expect(scaleFactor).toBeCloseTo(19 / 3, 6);
    expect(scaleFactor).toBeLessThan(10); // the silent shrink: this is NOT 1:100 anymore
    expect(translateX).toBeCloseTo(5, 6); // (200 - 30*19/3)/2
    expect(translateY).toBeCloseTo(415 / 3, 6); // (150 - 20*19/3)/2 + 20*19/3
  });

  it('never scales UP beyond the nominal 1:N when the drawing is much smaller than the viewport', () => {
    // 0.1m x 0.1m drawing at 1:1 would want scaleX/scaleY >> 1 to fill a
    // large viewport; fitScale is clamped to 1, so scaleFactor stays at
    // the nominal paperScale (1000/1 = 1000) rather than being enlarged.
    const scale1 = COMMON_SCALES.find((s) => s.factor === 1)!;
    const { scaleFactor } = calculateDrawingTransform(
      { minX: 0, minY: 0, maxX: 0.1, maxY: 0.1 },
      { x: 0, y: 0, width: 2000, height: 2000 },
      scale1
    );
    expect(scaleFactor).toBeCloseTo(1000, 6);
  });
});

/**
 * `calculateViewportBounds` had no test at all, despite being the function
 * that decides where drawing content lands on the sheet — `sheetSlice.ts`
 * in the viewer calls it at five separate sites (sheet creation, paper
 * change, frame change, title-block change, scale change).
 *
 * Its `right-strip` branch is additionally unreachable from every shipped
 * preset: all four entries of `TITLE_BLOCK_PRESETS` use `bottom-right` or
 * `bottom-full`, so only a hand-built config exercises it.
 */
describe('calculateViewportBounds', () => {
  const paper: PaperSizeDefinition = {
    id: 'TEST',
    name: 'Test',
    category: 'custom',
    widthMm: 400,
    heightMm: 300,
    orientation: 'landscape',
    defaultMarginMm: 10,
  };

  // Deliberately asymmetric: every margin, the binding margin and the
  // border gap are distinct, so dropping any one term moves the result.
  const frame: DrawingFrame = {
    style: 'custom',
    margins: { top: 7, right: 11, bottom: 13, left: 17, bindingMargin: 3 },
    border: {
      outerLineWeight: 0.7,
      innerLineWeight: 0.35,
      borderGap: 2,
      showFoldMarks: false,
      showTrimMarks: false,
    },
    showZoneReferences: false,
    horizontalZones: 0,
    verticalZones: 0,
    zoneFontSize: 3,
  };

  const titleBlock = (
    position: TitleBlockPosition,
    widthMm: number,
    heightMm: number
  ): TitleBlockConfig => ({
    ...createTitleBlock('standard'),
    position,
    widthMm,
    heightMm,
  });

  // frameInnerLeft   = 17 + 3 + 2 = 22
  // frameInnerRight  = 400 - 11 - 2 = 387
  // frameInnerTop    =  7 + 2 =  9
  // frameInnerBottom = 300 - 13 - 2 = 285
  const INNER_LEFT = 22;
  const INNER_RIGHT = 387;
  const INNER_TOP = 9;
  const INNER_BOTTOM = 285;
  const PADDING = 5;

  it('insets the origin by left margin + binding margin + border gap', () => {
    // The binding margin is the hole-punch allowance; folding it out shifts
    // every drawing 3mm left, straight into the punched edge.
    const v = calculateViewportBounds(paper, frame, titleBlock('bottom-right', 180, 55));
    expect(v.x).toBe(INNER_LEFT);
    expect(v.y).toBe(INNER_TOP);
  });

  it('reserves title-block height (plus padding) for a bottom-right block', () => {
    const v = calculateViewportBounds(paper, frame, titleBlock('bottom-right', 180, 55));
    expect(v.width).toBe(INNER_RIGHT - INNER_LEFT);
    expect(v.height).toBe(INNER_BOTTOM - INNER_TOP - 55 - PADDING);
  });

  it('reserves title-block height (plus padding) for a bottom-full block', () => {
    const v = calculateViewportBounds(paper, frame, titleBlock('bottom-full', 0, 70));
    expect(v.width).toBe(INNER_RIGHT - INNER_LEFT);
    expect(v.height).toBe(INNER_BOTTOM - INNER_TOP - 70 - PADDING);
  });

  it('reserves title-block WIDTH (plus padding) for a right-strip block, leaving height full', () => {
    const v = calculateViewportBounds(paper, frame, titleBlock('right-strip', 60, 200));
    expect(v.width).toBe(INNER_RIGHT - INNER_LEFT - 60 - PADDING);
    expect(v.height).toBe(INNER_BOTTOM - INNER_TOP);
  });

  it('reserves along exactly one axis per position — never both, never neither', () => {
    const full = {
      width: INNER_RIGHT - INNER_LEFT,
      height: INNER_BOTTOM - INNER_TOP,
    };
    const bottom = calculateViewportBounds(paper, frame, titleBlock('bottom-right', 60, 55));
    expect(bottom.width).toBe(full.width);
    expect(bottom.height).toBeLessThan(full.height);

    const strip = calculateViewportBounds(paper, frame, titleBlock('right-strip', 60, 55));
    expect(strip.width).toBeLessThan(full.width);
    expect(strip.height).toBe(full.height);
  });

  it('shrinks the reserved axis as the title block grows', () => {
    const small = calculateViewportBounds(paper, frame, titleBlock('bottom-right', 180, 20));
    const large = calculateViewportBounds(paper, frame, titleBlock('bottom-right', 180, 80));
    expect(small.height - large.height).toBe(60);

    const narrow = calculateViewportBounds(paper, frame, titleBlock('right-strip', 40, 55));
    const wide = calculateViewportBounds(paper, frame, titleBlock('right-strip', 90, 55));
    expect(narrow.width - wide.width).toBe(50);
  });
});
