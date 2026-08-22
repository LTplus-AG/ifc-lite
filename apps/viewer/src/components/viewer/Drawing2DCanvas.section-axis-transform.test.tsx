/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review gap on the "centre section sheets on the X axis" fix: every
 * viewer-level test of the sheet preview fixed `sectionAxis` to `'down'`,
 * where `flipX` is false. Mutating `Drawing2DCanvas`'s call into the shared
 * transform resolver to pass `flipX: false` — i.e. recreating exactly the
 * off-centre 'side' section the fix exists to prevent — left all of them
 * green (verified by running the mutation). The 'side' behaviour was
 * asserted only by reading a one-line pass-through.
 *
 * This file drives the REAL `Drawing2DCanvas` on every axis and asserts,
 * absolutely, WHERE THE LINE IS PAINTED — the recording 2D context stub
 * below captures each `moveTo`/`lineTo`, and the component is given an
 * identity view transform so a recorded coordinate IS a paper-mm
 * coordinate. Asserting only the transform written into the pinned cache
 * would miss a consumer that computed the right transform and then applied
 * the wrong flips to each point.
 *
 * The expected numbers are arithmetic written out below, not a second call
 * into the production helper — which is why the fixture overrides
 * `viewportBounds` with round values instead of taking them from
 * `calculateViewportBounds`. `sheet-transform.test.ts` covers the resolver
 * itself; this file covers the wiring from this consumer INTO it.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  GraphicOverrideEngine,
  PAPER_SIZE_REGISTRY,
  FRAME_PRESETS,
  TITLE_BLOCK_PRESETS,
  DEFAULT_TITLE_BLOCK_FIELDS,
  DEFAULT_SCALE_BAR,
  DEFAULT_NORTH_ARROW,
} from '@ifc-lite/drawing-2d';
import type { Drawing2D, DrawingSheet } from '@ifc-lite/drawing-2d';
import { Drawing2DCanvas } from './Drawing2DCanvas.js';
import { sheetTransformCacheKeyOf, type CachedSheetTransform } from '@/lib/drawing/sheet-geometry-key.js';

installLayout();

interface Segment { x1: number; y1: number; x2: number; y2: number }

/** A 2D context that is a no-op except that it RECORDS every
 *  `moveTo`/`lineTo` pair, so the test can read back where the drawing's
 *  line was actually painted — not merely what transform was computed.
 *  Mirrors the stub in `Drawing2DCanvas.stale-pinned-transform.test.tsx`,
 *  plus the recording. */
function installCanvasStub(): { restore: () => void; segments: Segment[] } {
  const segments: Segment[] = [];
  let pen: { x: number; y: number } | null = null;
  const ctx = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'measureText') return (text: string) => ({ width: String(text).length * 7 });
        if (prop === 'canvas') return { width: 800, height: 600 };
        if (prop === 'moveTo') return (x: number, y: number) => { pen = { x, y }; };
        if (prop === 'lineTo') return (x: number, y: number) => {
          if (pen) segments.push({ x1: pen.x, y1: pen.y, x2: x, y2: y });
          pen = { x, y };
        };
        return () => undefined;
      },
      set() {
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;

  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = ((kind: string) =>
    kind === '2d' ? ctx : null) as unknown as typeof HTMLCanvasElement.prototype.getContext;

  return { restore: () => { HTMLCanvasElement.prototype.getContext = original; }, segments };
}

/** Viewport centre is exactly (110, 60) mm on paper. */
const VIEWPORT = { x: 10, y: 10, width: 200, height: 100 };

/** Bounds asymmetric about BOTH axes (x 2..12, y 5..11), so neither flip
 *  correction can be dropped without moving the drawing. A drawing centred
 *  on the origin would make this untestable.
 *
 *  Y is 5..11 rather than 3..9 because at 3..9 the corrected 'down'
 *  translateY comes out to exactly 0 on this viewport (120 - (9+3)*10), and a
 *  zero translate is indistinguishable from no translate at all: every 'down'
 *  assertion reduces to `y * scaleFactor`, and an implementation returning a
 *  hard 0 for the unflipped axis passed this file, `sheet-transform.test.ts`
 *  and `useDrawingExport.pdfSheet.test.tsx` together — verified by mutation.
 *  At 5..11 the corrected value is -20mm and has to be computed. */
const BOUNDS = { min: { x: 2, y: 5 }, max: { x: 12, y: 11 } };

function buildDrawing(): Drawing2D {
  return {
    config: {
      plane: { axis: 'y', position: 0, flipped: false },
      projectionDepth: 10,
      includeHiddenLines: true,
      creaseAngle: 30,
      scale: 100,
    },
    lines: [
      {
        line: { start: { x: BOUNDS.min.x, y: BOUNDS.min.y }, end: { x: BOUNDS.max.x, y: BOUNDS.max.y } },
        category: 'projection',
        visibility: 'visible',
        entityId: 1,
        ifcType: 'IfcWall',
        modelIndex: 0,
        depth: 0,
      },
    ],
    cutPolygons: [],
    projectionPolygons: [],
    bounds: BOUNDS,
    stats: {
      cutLineCount: 0,
      projectionLineCount: 1,
      hiddenLineCount: 0,
      silhouetteLineCount: 0,
      polygonCount: 0,
      totalTriangles: 0,
      processingTimeMs: 0,
    },
  };
}

/** A real, fully-populated `DrawingSheet` with `viewportBounds` replaced by
 *  the round `VIEWPORT` — see the module doc. 1:100 -> 10mm per metre. */
function buildSheet(id = 'sheet-side'): DrawingSheet {
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
    scale: { name: '1:100', factor: 100, useCase: '' },
    northArrow: { ...DEFAULT_NORTH_ARROW },
    viewportBounds: { ...VIEWPORT },
    revisions: [],
  };
}

/**
 * Hand-computed, per `calculateDrawingTransform` + the per-axis correction
 * (identical arithmetic to `sheet-transform.test.ts`, restated here so this
 * file's expectations do not depend on that one):
 *
 *   paperScale      = 1000/100                          = 10 mm/m
 *   fitScale        = min(200*.95/100, 100*.95/60, 1)   = 1
 *   scaleFactor     = 10
 *   base.translateX = 10 + (200-100)/2 - 2*10           = 40
 *   base.translateY = 10 + (100-60)/2 + 11*10           = 140
 *
 *   'down'  (flipX=false, flipY=false): translateX 40,  translateY -20
 *   'front' (flipX=false, flipY=true) : translateX 40,  translateY 140
 *   'side'  (flipX=true,  flipY=true) : translateX 180, translateY 140
 */
const EXPECTED: Record<'down' | 'front' | 'side', {
  translateX: number;
  translateY: number;
  /** where the fixture's line, (2,5) -> (12,11), is painted in paper mm */
  segment: { x1: number; y1: number; x2: number; y2: number };
}> = {
  // (2,5) -> (2*10+40, 5*10-20)      = (60, 30)  ; (12,11) -> (160, 90)
  down: { translateX: 40, translateY: -20, segment: { x1: 60, y1: 30, x2: 160, y2: 90 } },
  // (2,5) -> (2*10+40, -5*10+140)    = (60, 90)  ; (12,11) -> (160, 30)
  front: { translateX: 40, translateY: 140, segment: { x1: 60, y1: 90, x2: 160, y2: 30 } },
  // (2,5) -> (-2*10+180, -5*10+140)  = (160, 90) ; (12,11) -> (60, 30)
  side: { translateX: 180, translateY: 140, segment: { x1: 160, y1: 90, x2: 60, y2: 30 } },
};

/** Assert exactly one recorded segment matches `want`. The frame, grid and
 *  title block paint many other segments; this looks for the drawing's own
 *  line among them, and fails loudly (dumping the candidates) when the
 *  drawing landed somewhere else. */
function assertPainted(segments: Segment[], want: Segment, what: string): void {
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const hit = segments.filter(
    (s) => near(s.x1, want.x1) && near(s.y1, want.y1) && near(s.x2, want.x2) && near(s.y2, want.y2),
  );
  assert.equal(
    hit.length,
    1,
    `${what}: expected exactly one painted segment ${JSON.stringify(want)}; found ${hit.length}. ` +
      `Painted segments were ${JSON.stringify(segments)}`,
  );
}

/** Render the canvas once for `axis` and hand back both the placement it
 *  wrote into the cache and every segment it painted. `transform` is passed
 *  as identity ({x:0, y:0, scale:1}), so `mmToScreenX/Y` are the identity
 *  too and a recorded segment IS a paper-mm coordinate. */
function draw(
  axis: 'down' | 'front' | 'side',
  sheet: DrawingSheet,
  seedCache: CachedSheetTransform | null = null,
  isPinned = true,
): { written: CachedSheetTransform | null; segments: Segment[] } {
  const stub = installCanvasStub();
  const cachedSheetTransformRef: React.MutableRefObject<CachedSheetTransform | null> = { current: seedCache };
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  try {
    act(() => {
      root = createRoot(container);
      root.render(
        <Drawing2DCanvas
          drawing={buildDrawing()}
          transform={{ x: 0, y: 0, scale: 1 }}
          showHiddenLines={false}
          overrideEngine={new GraphicOverrideEngine()}
          overridesEnabled={false}
          entityColorMap={new Map()}
          useIfcMaterials={false}
          sectionAxis={axis}
          sheetEnabled
          activeSheet={sheet}
          isPinned={isPinned}
          cachedSheetTransformRef={cachedSheetTransformRef}
        />,
      );
    });
    return { written: cachedSheetTransformRef.current, segments: stub.segments };
  } finally {
    if (root) act(() => { root!.unmount(); });
    container.remove();
    stub.restore();
  }
}

function closeTo(actual: number, expected: number, what: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: expected ${expected}, got ${actual}`);
}

describe('Drawing2DCanvas sheet placement is axis-correct, including the flipX axes', () => {
  for (const axis of ['down', 'front', 'side'] as const) {
    it(`paints a '${axis}' section's line at its hand-computed paper mm`, () => {
      const sheet = buildSheet();
      const { written, segments } = draw(axis, sheet);
      assertPainted(segments, EXPECTED[axis].segment, `${axis} drawing line`);
      assert.ok(written, 'the draw effect must report the placement it drew with');
      closeTo(written.scaleFactor, 10, `${axis} scaleFactor`);
      closeTo(written.translateX, EXPECTED[axis].translateX, `${axis} translateX`);
      closeTo(written.translateY, EXPECTED[axis].translateY, `${axis} translateY`);
      assert.equal(
        written.key,
        sheetTransformCacheKeyOf(sheet, axis),
        `${axis} cache entry must be tagged with this sheet's key AND this axis`,
      );
    });
  }

  it("keeps 'side' distinct from 'front' — the X correction is not a no-op on this fixture", () => {
    // Guards the fixture, not the code: if BOUNDS were symmetric about X=0
    // the flipX correction term `(minX + maxX) * scaleFactor` would be zero
    // and the assertions above could not fail.
    assert.notEqual(EXPECTED.side.translateX, EXPECTED.front.translateX);
    assert.notEqual(EXPECTED.side.segment.x1, EXPECTED.front.segment.x1);
    const side = draw('side', buildSheet());
    const front = draw('front', buildSheet());
    assert.notEqual(side.written!.translateX, front.written!.translateX);
  });

  it('reuses a pinned placement rather than recomputing, and does not rewrite it', () => {
    const sheet = buildSheet();
    const held: CachedSheetTransform = {
      key: sheetTransformCacheKeyOf(sheet, 'side'),
      translateX: 33,
      translateY: 44,
      scaleFactor: 5,
    };
    const { written, segments } = draw('side', sheet, { ...held }, true);
    assert.deepEqual(written, held, 'a pinned draw with a valid cache entry must keep the held placement untouched');
    // Absolute: 'side' flips both axes, so with the held placement
    // (2,5) -> (-2*5 + 33, -5*5 + 44) = (23, 19) and
    // (12,11) -> (-12*5 + 33, -11*5 + 44) = (-27, -11).
    assertPainted(segments, { x1: 23, y1: 19, x2: -27, y2: -11 }, 'held placement drawing line');
  });

  it('recomputes when NOT pinned, even with a key-valid cache entry present', () => {
    const sheet = buildSheet();
    const held: CachedSheetTransform = {
      key: sheetTransformCacheKeyOf(sheet, 'side'),
      translateX: 33,
      translateY: 44,
      scaleFactor: 5,
    };
    const { written, segments } = draw('side', sheet, { ...held }, false);
    assert.ok(written);
    closeTo(written.translateX, EXPECTED.side.translateX, 'unpinned translateX');
    closeTo(written.translateY, EXPECTED.side.translateY, 'unpinned translateY');
    assertPainted(segments, EXPECTED.side.segment, 'unpinned drawing line');
  });
});
