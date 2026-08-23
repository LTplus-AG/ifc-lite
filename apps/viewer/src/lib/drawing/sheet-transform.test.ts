/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `resolveSheetTransform` is the ONE place the sheet preview
 * (`Drawing2DCanvas`) and the sheet print/export path
 * (`useDrawingExport`'s `generateSheetSVG`) decide where the drawing lands
 * on paper — both the per-axis flips and the cached-placement read.
 *
 * ABSOLUTE assertions, deliberately. Relative facts alone ("print equals
 * preview", "a plan section differs from a flipped one") do not pin this:
 * mutating the resolver to pass `!flipY` inverts the flip semantics
 * CONSISTENTLY in both paths, which no relative comparison can see. Nor is
 * "the drawing is centred in the viewport" enough — a mirrored drawing is
 * still centred, its centroid does not move.
 *
 * So every placement assertion below pins a KNOWN, OFF-CENTRE point (the
 * drawing's own min/max corners) at a hand-computed paper-mm coordinate,
 * and those expected numbers are arithmetic written out in the comments,
 * not a second call into the production helper. `!flipX` or `!flipY` sends
 * the corner to the opposite corner and fails.
 *
 * The fixture's numbers are chosen so the whole transform is computable by
 * hand (see `EXPECTED`), which is why `viewportBounds` is overridden with
 * round values instead of taken from `calculateViewportBounds`: an expected
 * value derived from the code under test asserts nothing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAPER_SIZE_REGISTRY,
  FRAME_PRESETS,
  TITLE_BLOCK_PRESETS,
  DEFAULT_TITLE_BLOCK_FIELDS,
  DEFAULT_SCALE_BAR,
  DEFAULT_NORTH_ARROW,
  type DrawingSheet,
} from '@ifc-lite/drawing-2d';
import { resolveSheetTransform } from './sheet-transform.js';
import {
  sheetGeometryKeyOf,
  sheetTransformCacheKeyOf,
  type CachedSheetTransform,
} from './sheet-geometry-key.js';
import type { SectionAxis } from '@/hooks/pdfSectionLayout';

/** Viewport: x=10, y=10, 200mm x 100mm — so the viewport centre is exactly
 *  (110, 60) mm on paper. */
const VIEWPORT = { x: 10, y: 10, width: 200, height: 100 };

/** 1:100 -> `paperScale` = 1000/100 = 10 mm per metre. */
const SCALE = { name: '1:100', factor: 100, useCase: 'test' };

/** A 10m x 6m drawing sitting at x 2..12, y 5..11 — asymmetric about BOTH
 *  axes, so dropping either flip correction (or either flip itself) moves
 *  the drawing measurably.
 *
 *  The Y range is 5..11 rather than 3..9 for a second reason: at 3..9 the
 *  corrected 'down' translateY works out to exactly 0 on this viewport
 *  (120 - (9+3)*10), and a zero translate is indistinguishable from no
 *  translate at all. Every 'down' assertion then reduces to `y * scaleFactor`
 *  and an implementation that simply returned 0 for the unflipped axis passed
 *  the whole file — verified by mutation. At 5..11 the corrected value is
 *  -20mm, so it has to be computed. */
const BOUNDS = { minX: 2, minY: 5, maxX: 12, maxY: 11 };

/**
 * Hand-computed from `calculateDrawingTransform` plus the per-axis
 * correction:
 *
 *   paperScale        = 1000 / 100                        = 10 mm/m
 *   drawing on paper  = 10m x 6m                          = 100mm x 60mm
 *   fitScale          = min(200*.95/100, 100*.95/60, 1)   = 1
 *   scaleFactor       = 10 * 1                            = 10
 *   base.translateX   = 10 + (200-100)/2 - 2*10           = 40
 *   base.translateY   = 10 + (100-60)/2 + 11*10           = 140
 *
 *   'down'  (flipX=false, flipY=false):
 *      translateY = 140 - (11+5)*10 = -20 ; translateX = 40
 *   'front' (flipX=false, flipY=true):
 *      translateY = 140                   ; translateX = 40
 *   'side'  (flipX=true,  flipY=true):
 *      translateY = 140                   ; translateX = 40 + (2+12)*10 = 180
 *
 * and the paper position of a model point is
 *   ((flipX ? -x : x) * scaleFactor + translateX,
 *    (flipY ? -y : y) * scaleFactor + translateY).
 */
const EXPECTED: Record<SectionAxis, {
  translateX: number;
  translateY: number;
  /** where the drawing's (minX, minY) corner lands, in paper mm */
  minCorner: { x: number; y: number };
  /** where the drawing's (maxX, maxY) corner lands, in paper mm */
  maxCorner: { x: number; y: number };
}> = {
  // (2,5) -> (2*10+40, 5*10-20)      = (60, 30)  ; (12,11) -> (160, 90)
  down: { translateX: 40, translateY: -20, minCorner: { x: 60, y: 30 }, maxCorner: { x: 160, y: 90 } },
  // (2,5) -> (2*10+40, -5*10+140)    = (60, 90)  ; (12,11) -> (160, 30)
  front: { translateX: 40, translateY: 140, minCorner: { x: 60, y: 90 }, maxCorner: { x: 160, y: 30 } },
  // (2,5) -> (-2*10+180, -5*10+140)  = (160, 90) ; (12,11) -> (60, 30)
  side: { translateX: 180, translateY: 140, minCorner: { x: 160, y: 90 }, maxCorner: { x: 60, y: 30 } },
};

const SCALE_FACTOR = 10;

/** A real, fully-populated `DrawingSheet` (the building blocks
 *  `sheetSlice.createDefaultSheet` uses) with `viewportBounds` replaced by
 *  the round `VIEWPORT` above — see the module doc for why. */
function buildSheet(id = 'sheet-under-test'): DrawingSheet {
  const paper = PAPER_SIZE_REGISTRY.A3_LANDSCAPE;
  const frame = { style: 'professional' as const, ...FRAME_PRESETS.professional };
  const titleBlock = {
    ...TITLE_BLOCK_PRESETS.standard,
    fields: DEFAULT_TITLE_BLOCK_FIELDS.map((f) => ({ ...f })),
    logo: null,
  };
  return {
    id,
    name: id,
    paper,
    frame,
    titleBlock,
    scaleBar: { ...DEFAULT_SCALE_BAR },
    scale: { ...SCALE },
    northArrow: { ...DEFAULT_NORTH_ARROW },
    viewportBounds: { ...VIEWPORT },
    revisions: [],
  };
}

/** Apply a resolved placement to a model point exactly as both consumers do
 *  (`modelToPaper` in `generateSheetSVG`, `modelToScreen` in
 *  `Drawing2DCanvas`) — using the flips the RESOLVER returned, which is the
 *  point of returning them. */
function place(
  resolved: ReturnType<typeof resolveSheetTransform>,
  x: number,
  y: number,
): { x: number; y: number } {
  const { flipX, flipY, transform } = resolved;
  return {
    x: (flipX ? -x : x) * transform.scaleFactor + transform.translateX,
    y: (flipY ? -y : y) * transform.scaleFactor + transform.translateY,
  };
}

function closeTo(actual: number, expected: number, what: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `${what}: expected ${expected}, got ${actual}`,
  );
}

const AXES: SectionAxis[] = ['down', 'front', 'side'];

describe('resolveSheetTransform — absolute placement per section axis', () => {
  for (const axis of AXES) {
    it(`places known off-centre corners at their hand-computed paper mm for '${axis}'`, () => {
      const resolved = resolveSheetTransform({
        sheet: buildSheet(),
        drawingBounds: BOUNDS,
        axis,
        isPinned: false,
        cached: null,
      });
      const expected = EXPECTED[axis];

      closeTo(resolved.transform.scaleFactor, SCALE_FACTOR, `${axis} scaleFactor`);
      closeTo(resolved.transform.translateX, expected.translateX, `${axis} translateX`);
      closeTo(resolved.transform.translateY, expected.translateY, `${axis} translateY`);

      const minCorner = place(resolved, BOUNDS.minX, BOUNDS.minY);
      closeTo(minCorner.x, expected.minCorner.x, `${axis} (minX,minY) paper x`);
      closeTo(minCorner.y, expected.minCorner.y, `${axis} (minX,minY) paper y`);

      const maxCorner = place(resolved, BOUNDS.maxX, BOUNDS.maxY);
      closeTo(maxCorner.x, expected.maxCorner.x, `${axis} (maxX,maxY) paper x`);
      closeTo(maxCorner.y, expected.maxCorner.y, `${axis} (maxX,maxY) paper y`);
    });
  }

  it("derives the flips from the axis alone, matching axisFlipForSection's contract", () => {
    const of = (axis: SectionAxis) => {
      const r = resolveSheetTransform({ sheet: buildSheet(), drawingBounds: BOUNDS, axis, isPinned: false, cached: null });
      return { flipX: r.flipX, flipY: r.flipY };
    };
    assert.deepEqual(of('down'), { flipX: false, flipY: false });
    assert.deepEqual(of('front'), { flipX: false, flipY: true });
    assert.deepEqual(of('side'), { flipX: true, flipY: true });
  });

  it('centres the drawing in the viewport on every axis (the property whose SIGN the corners above pin)', () => {
    // Centring alone cannot distinguish a consistently inverted flip — a
    // mirrored drawing is still centred. It is asserted here as the
    // user-visible property; the corner assertions above are what make the
    // orientation observable.
    for (const axis of AXES) {
      const resolved = resolveSheetTransform({ sheet: buildSheet(), drawingBounds: BOUNDS, axis, isPinned: false, cached: null });
      const centre = place(resolved, (BOUNDS.minX + BOUNDS.maxX) / 2, (BOUNDS.minY + BOUNDS.maxY) / 2);
      closeTo(centre.x, VIEWPORT.x + VIEWPORT.width / 2, `${axis} centroid paper x`);
      closeTo(centre.y, VIEWPORT.y + VIEWPORT.height / 2, `${axis} centroid paper y`);
    }
  });
});

describe('resolveSheetTransform — the pinned-placement cache', () => {
  const sheet = buildSheet();
  /** A held placement, tagged for the axis it was computed under — the cache
   *  key covers the axis as well as the sheet geometry, because the transform
   *  carries the axis's flips (see `sheetTransformCacheKeyOf`). */
  const heldFor = (axis: SectionAxis): CachedSheetTransform => ({
    key: sheetTransformCacheKeyOf(sheet, axis),
    translateX: 33,
    translateY: 44,
    scaleFactor: 5,
  });

  it('returns the HELD placement when pinned and the key matches — this is what pinning means', () => {
    const resolved = resolveSheetTransform({ sheet, drawingBounds: BOUNDS, axis: 'side', isPinned: true, cached: heldFor('side') });
    assert.equal(resolved.fromCache, true);
    assert.deepEqual(resolved.transform, { translateX: 33, translateY: 44, scaleFactor: 5 });
    // Absolute: the held placement is applied with the axis's own flips.
    // (2,5) -> (-2*5 + 33, -5*5 + 44) = (23, 19).
    const corner = place(resolved, BOUNDS.minX, BOUNDS.minY);
    closeTo(corner.x, 23, 'held placement, (minX,minY) paper x');
    closeTo(corner.y, 19, 'held placement, (minX,minY) paper y');
  });

  it('holds the placement across a bounds change — the regenerate-at-a-new-elevation case', () => {
    // `sheetGeometryKeyOf` deliberately does NOT cover the drawing bounds:
    // bounds are exactly what pinning holds constant. Two very different
    // bounds must therefore resolve to the SAME placement while pinned.
    const a = resolveSheetTransform({ sheet, drawingBounds: BOUNDS, axis: 'down', isPinned: true, cached: heldFor('down') });
    const b = resolveSheetTransform({
      sheet,
      drawingBounds: { minX: -500, minY: -500, maxX: 700, maxY: 300 },
      axis: 'down',
      isPinned: true,
      cached: heldFor('down'),
    });
    assert.deepEqual(a.transform, b.transform);
    assert.deepEqual(a.transform, { translateX: 33, translateY: 44, scaleFactor: 5 });
  });

  it('IGNORES the cache when not pinned — the unpinned path must still auto-fit', () => {
    const resolved = resolveSheetTransform({ sheet, drawingBounds: BOUNDS, axis: 'down', isPinned: false, cached: heldFor('down') });
    assert.equal(resolved.fromCache, false);
    closeTo(resolved.transform.translateX, EXPECTED.down.translateX, 'unpinned translateX');
    closeTo(resolved.transform.translateY, EXPECTED.down.translateY, 'unpinned translateY');
    closeTo(resolved.transform.scaleFactor, SCALE_FACTOR, 'unpinned scaleFactor');
  });

  it('rejects an entry tagged with a DIFFERENT sheet geometry, even when pinned', () => {
    const stale: CachedSheetTransform = {
      ...heldFor('down'),
      key: sheetTransformCacheKeyOf(buildSheet('some-other-sheet'), 'down'),
    };
    const resolved = resolveSheetTransform({ sheet, drawingBounds: BOUNDS, axis: 'down', isPinned: true, cached: stale });
    assert.equal(resolved.fromCache, false);
    closeTo(resolved.transform.translateX, EXPECTED.down.translateX, 'stale-key translateX');
    closeTo(resolved.transform.scaleFactor, SCALE_FACTOR, 'stale-key scaleFactor');
  });

  it('reports the key a caller that owns the cache must tag a fresh entry with', () => {
    const resolved = resolveSheetTransform({ sheet, drawingBounds: BOUNDS, axis: 'down', isPinned: false, cached: null });
    assert.equal(resolved.key, sheetTransformCacheKeyOf(sheet, 'down'));
  });

  it('never writes to the entry it was given — the preview owns the cache, export must not perturb it', () => {
    const entry: CachedSheetTransform = heldFor('side');
    const before = { ...entry };
    resolveSheetTransform({ sheet, drawingBounds: BOUNDS, axis: 'side', isPinned: true, cached: entry });
    resolveSheetTransform({ sheet, drawingBounds: BOUNDS, axis: 'side', isPinned: false, cached: entry });
    assert.deepEqual(entry, before, 'resolveSheetTransform must not mutate the cache entry');
    const resolved = resolveSheetTransform({ sheet, drawingBounds: BOUNDS, axis: 'side', isPinned: true, cached: entry });
    assert.notStrictEqual(resolved.transform, entry, 'must hand back a copy, not the live cache object');
  });
});

describe('resolveSheetTransform — the cache key covers the AXIS as well as the geometry', () => {
  const sheet = buildSheet();
  const MID_X = (BOUNDS.minX + BOUNDS.maxX) / 2;
  const MID_Y = (BOUNDS.minY + BOUNDS.maxY) / 2;

  it('refuses an entry computed under a DIFFERENT axis — the pairing returning the flips exists to prevent', () => {
    // The flips are an OUTPUT, so a consumer cannot pair one axis's flips
    // with another's transform. But the cached transform is a SECOND carrier
    // of the flips: `calculateDrawingTransformForAxis` folds `flipX` into
    // `translateX` ('down' gives 40, 'side' gives 180). An entry written by a
    // 'down' resolve and re-read by a pinned 'side' resolve on the SAME sheet
    // therefore reintroduces exactly that pairing.
    const down = resolveSheetTransform({ sheet, drawingBounds: BOUNDS, axis: 'down', isPinned: false, cached: null });
    const written: CachedSheetTransform = { key: down.key, ...down.transform };

    const side = resolveSheetTransform({ sheet, drawingBounds: BOUNDS, axis: 'side', isPinned: true, cached: written });
    assert.equal(side.fromCache, false, "a 'down' entry must not be served to a 'side' resolve");

    // What the served entry would have produced: 'side' flips X, so the
    // drawing centre would land at -7*10 + 40 = -30mm — 140mm from the
    // viewport centre at 110mm, i.e. off the left edge of the sheet.
    const centre = place(side, MID_X, MID_Y);
    closeTo(centre.x, VIEWPORT.x + VIEWPORT.width / 2, "recomputed 'side' centre paper x");
    closeTo(centre.y, VIEWPORT.y + VIEWPORT.height / 2, "recomputed 'side' centre paper y");
    closeTo(side.transform.translateX, EXPECTED.side.translateX, "recomputed 'side' translateX");
  });

  it('still SERVES an entry written under the same axis — the cache must not become useless', () => {
    // The other direction: scoping the key by axis must not turn every
    // ordinary pinned redraw into a miss. Pinning only means anything if the
    // held placement survives a re-resolve on the same axis and sheet.
    for (const axis of AXES) {
      const first = resolveSheetTransform({ sheet, drawingBounds: BOUNDS, axis, isPinned: false, cached: null });
      const written: CachedSheetTransform = { key: first.key, ...first.transform };
      const second = resolveSheetTransform({
        sheet,
        // Bounds moved underneath it, which is what pinning holds constant.
        drawingBounds: { minX: -500, minY: -500, maxX: 700, maxY: 300 },
        axis,
        isPinned: true,
        cached: written,
      });
      assert.equal(second.fromCache, true, `${axis} entry must still be served to a ${axis} resolve`);
      assert.deepEqual(second.transform, first.transform, `${axis} held placement must survive a bounds change`);
    }
  });

  it('tags a fresh entry with a key that distinguishes the axes', () => {
    const keys = AXES.map(
      (axis) => resolveSheetTransform({ sheet, drawingBounds: BOUNDS, axis, isPinned: false, cached: null }).key,
    );
    assert.equal(new Set(keys).size, AXES.length, 'each axis must produce its own cache key');
    for (const key of keys) {
      assert.ok(
        key !== null && key.startsWith(`${sheetGeometryKeyOf(sheet)}|`),
        'the axis-scoped key must still carry the whole sheet geometry key',
      );
    }
  });
});
