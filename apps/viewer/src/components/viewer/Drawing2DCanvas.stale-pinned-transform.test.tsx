/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PR #2853 review (coderabbit): `Drawing2DCanvas` reads
 * `cachedSheetTransformRef.current` in its drawing effect and reuses it
 * whenever `isPinned` is on. `useViewControls` is the hook that clears that
 * ref when the sheet's geometry changes (`useViewControls.sheet-change.test.tsx`),
 * but it is the PARENT of whatever renders `Drawing2DCanvas`, and React
 * commits a child's effects before its parent's on the same update. On the
 * very render the sheet's geometry changes, the canvas's drawing effect can
 * therefore run BEFORE the clearing effect and reuse a transform computed
 * for the OLD sheet — and nothing forces a second draw afterwards to correct
 * it, since clearing a ref is not itself a render trigger.
 *
 * `useViewControls.sheet-change.test.tsx` only asserts on the ref-clearing
 * effect in isolation, so it cannot see this: from that test's point of
 * view, the ref import always ends up `null`, whichever effect cleared it.
 * This file drives `Drawing2DCanvas` directly and reproduces the race
 * window itself — a cached entry, still PRESENT (as it would be for one
 * frame before the clearing effect runs), tagged with the OLD sheet's
 * geometry — and asserts the canvas does not trust it.
 *
 * The fix (`sheetGeometryKeyOf`, apps/viewer/src/lib/drawing/sheet-geometry-key.ts)
 * tags each cached transform with the geometry key it was computed FOR, and
 * `Drawing2DCanvas` validates that key against the CURRENT sheet before ever
 * reusing the cache — independent of which effect fires first.
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
  calculateViewportBounds,
} from '@ifc-lite/drawing-2d';
import type { Drawing2D, DrawingSheet } from '@ifc-lite/drawing-2d';
import { Drawing2DCanvas } from './Drawing2DCanvas.js';
import { sheetGeometryKeyOf, type CachedSheetTransform } from '@/lib/drawing/sheet-geometry-key.js';

installLayout();

/** No-op 2D context — this test only cares what transform the effect reads
 *  back into the ref, not what it draws. Mirrors the stub in
 *  Drawing2DCanvas.unit-display-override.test.tsx. */
function installCanvasStub(): { restore: () => void } {
  const ctx = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'measureText') return (text: string) => ({ width: String(text).length * 7 });
        if (prop === 'canvas') return { width: 800, height: 600 };
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

  return { restore: () => { HTMLCanvasElement.prototype.getContext = original; } };
}

const EMPTY_DRAWING: Drawing2D = {
  config: {
    plane: { axis: 'y', position: 0, flipped: false },
    projectionDepth: 10,
    includeHiddenLines: true,
    creaseAngle: 30,
    scale: 100,
  },
  lines: [],
  cutPolygons: [],
  projectionPolygons: [],
  bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } },
  stats: {
    cutLineCount: 0,
    projectionLineCount: 0,
    hiddenLineCount: 0,
    silhouetteLineCount: 0,
    polygonCount: 0,
    totalTriangles: 0,
    processingTimeMs: 0,
  },
};

/** A real, fully-populated `DrawingSheet` — the same building blocks
 *  `sheetSlice.createDefaultSheet` uses — so the frame/title-block draw code
 *  (margins, border weights, title-block grid) has everything it reads,
 *  unlike a partially-cast fixture. */
function sheet(id: string, paperId: 'A3_LANDSCAPE' | 'A0_LANDSCAPE', factor: number): DrawingSheet {
  const paper = PAPER_SIZE_REGISTRY[paperId];
  const frame = { style: 'professional' as const, ...FRAME_PRESETS.professional };
  const titleBlock = {
    ...TITLE_BLOCK_PRESETS.standard,
    fields: DEFAULT_TITLE_BLOCK_FIELDS.map((f) => ({ ...f })),
    logo: null,
  };
  const viewportBounds = calculateViewportBounds(paper, frame, titleBlock);
  return {
    id,
    name: id,
    paper,
    frame,
    titleBlock,
    scaleBar: { ...DEFAULT_SCALE_BAR },
    scale: { name: 'test', factor, useCase: '' },
    northArrow: { ...DEFAULT_NORTH_ARROW },
    viewportBounds,
    revisions: [],
  };
}

const SHEET_A = sheet('sheet-a', 'A3_LANDSCAPE', 50);
const SHEET_B = sheet('sheet-b', 'A0_LANDSCAPE', 100); // different id, paper AND scale factor

/** A cached transform that is obviously wrong for either sheet — reused only
 *  if the read site trusts presence alone. */
const STALE_SENTINEL: CachedSheetTransform = {
  key: sheetGeometryKeyOf(SHEET_A),
  translateX: 999,
  translateY: 999,
  scaleFactor: 999,
};

describe('Drawing2DCanvas rejects a pinned cache entry tagged with a DIFFERENT sheet (PR #2853 review)', () => {
  it('recomputes the transform instead of reusing a stale entry left over from the previous sheet', () => {
    const stub = installCanvasStub();
    const cachedSheetTransformRef: React.MutableRefObject<CachedSheetTransform | null> = {
      current: STALE_SENTINEL,
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | null = null;
    try {
      act(() => {
        root = createRoot(container);
        // Rendered with SHEET_B (the NEW sheet) while the cache still holds
        // SHEET_A's stale entry — exactly the one-frame race window: the
        // clearing effect in `useViewControls` (this hook's parent) has not
        // run yet, but the canvas is already drawing sheet B.
        root.render(
          <Drawing2DCanvas
            drawing={EMPTY_DRAWING}
            transform={{ x: 0, y: 0, scale: 1 }}
            showHiddenLines={false}
            overrideEngine={new GraphicOverrideEngine()}
            overridesEnabled={false}
            entityColorMap={new Map()}
            useIfcMaterials={false}
            sectionAxis="down"
            sheetEnabled
            activeSheet={SHEET_B}
            isPinned
            cachedSheetTransformRef={cachedSheetTransformRef}
          />,
        );
      });

      const after = cachedSheetTransformRef.current;
      assert.ok(after, 'the draw effect must populate the cache for the new sheet');
      assert.notStrictEqual(
        after!.scaleFactor,
        999,
        `must not have reused sheet A's stale cached transform for sheet B; got ${JSON.stringify(after)}`,
      );
      assert.equal(
        after!.key,
        sheetGeometryKeyOf(SHEET_B),
        `the cached entry must be tagged with sheet B's OWN geometry key; got ${JSON.stringify(after)}`,
      );
    } finally {
      if (root) act(() => { root!.unmount(); });
      container.remove();
      stub.restore();
    }
  });
});
