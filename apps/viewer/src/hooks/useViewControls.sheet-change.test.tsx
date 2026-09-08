/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pinned-sheet transform cache must not survive a sheet SWAP.
 *
 * `Drawing2DCanvas` reuses `cachedSheetTransformRef.current` whenever
 * `isPinned` is on, instead of recomputing `calculateDrawingTransform`
 * from the current sheet's `viewportBounds`/`scale`/`paper`
 * (Drawing2DCanvas.tsx around line 742). `useViewControls` is the only
 * place that ever clears that ref — on an axis/flip change, and on a
 * `sheetEnabled` false→true/true→false toggle.
 *
 * Loading a different saved sheet template (`sheetSlice.loadTemplate`,
 * wired from `SheetSetupPanel`) replaces `activeSheet` with a sheet that
 * has a different id, paper size, scale and viewport — while
 * `sheetEnabled` stays `true` throughout, since the user was already in
 * sheet mode. `setPaperSize` / `setDrawingScale` do the same thing to the
 * SAME sheet id. Neither transition fires the `sheetEnabled` effect, so
 * the cache silently keeps the OLD sheet's transform and the canvas draws
 * the new sheet's content at the wrong position/scale until the user
 * flips sheet mode off and back on, or changes the section axis.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DrawingSheet } from '@ifc-lite/drawing-2d';
import { useViewControls } from './useViewControls.js';
import type { CachedSheetTransform } from '@/lib/drawing/sheet-geometry-key.js';

type CachedTransform = CachedSheetTransform | null;

/** `factor` is the sheet's actual scale factor (`activeSheet.scale.factor`,
 *  the field `sheetGeometryKey` reads) — a real `DrawingSheet['scale']`
 *  object, not a bare number cast past the type, so the fixture's `factor`
 *  is never `undefined` (PR #2853 review). */
function sheet(id: string, factor: number, widthMm: number): DrawingSheet {
  return {
    id,
    name: id,
    paper: { id: 'p', name: 'p', widthMm, heightMm: 297, orientation: 'landscape' } as unknown as DrawingSheet['paper'],
    frame: {} as unknown as DrawingSheet['frame'],
    titleBlock: { fields: [], position: 'bottom-right', heightMm: 30 } as unknown as DrawingSheet['titleBlock'],
    scaleBar: {} as unknown as DrawingSheet['scaleBar'],
    scale: { name: 'test', factor, useCase: '' },
    northArrow: {} as unknown as DrawingSheet['northArrow'],
    viewportBounds: { x: 10, y: 10, width: widthMm - 20, height: 260 },
    revisions: [],
  };
}

interface HarnessProps {
  activeSheet: DrawingSheet | null;
  cacheRef: React.MutableRefObject<CachedTransform>;
}

function Harness({ activeSheet, cacheRef }: HarnessProps): null {
  useViewControls({
    drawing: null,
    sectionPlane: { axis: 'down', position: 50, flipped: false },
    containerRef: { current: null },
    panelVisible: true,
    status: 'ready',
    sheetEnabled: true,
    activeSheet,
    isPinned: true,
    cachedSheetTransformRef: cacheRef,
  });
  return null;
}

const SENTINEL: CachedTransform = { key: 'sentinel', translateX: 1, translateY: 2, scaleFactor: 3 };

describe('useViewControls sheet-swap cache invalidation', () => {
  it('clears the cached pinned transform when a different sheet replaces activeSheet', async () => {
    const cacheRef: React.MutableRefObject<CachedTransform> = { current: null };
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | null = null;
    try {
      await act(async () => {
        root = createRoot(container);
        root.render(<Harness activeSheet={sheet('sheet-a', 50, 420)} cacheRef={cacheRef} />);
      });

      // Simulate the canvas having cached a transform for sheet A while pinned.
      cacheRef.current = SENTINEL;

      // Swap to a DIFFERENT sheet (different id/scale/paper) — `sheetEnabled`
      // never toggles, matching `loadTemplate` / `setPaperSize` / `setDrawingScale`.
      await act(async () => {
        root!.render(<Harness activeSheet={sheet('sheet-b', 100, 841)} cacheRef={cacheRef} />);
      });

      assert.equal(
        cacheRef.current,
        null,
        `cached transform from sheet-a must not survive a swap to sheet-b; got ${JSON.stringify(cacheRef.current)}`,
      );
    } finally {
      if (root) await act(async () => { root!.unmount(); });
      container.remove();
    }
  });

  it('clears the cache when setPaperSize/setDrawingScale mutate the SAME sheet id', async () => {
    // sheetSlice.setPaperSize / setFrameStyle / setDrawingScale all do
    // `set({ activeSheet: { ...current, paper, viewportBounds } })` — the id
    // is untouched. Only `loadTemplate` gives the sheet a new id.
    const cacheRef: React.MutableRefObject<CachedTransform> = { current: null };
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | null = null;
    try {
      const before = sheet('sheet-a', 50, 420);
      await act(async () => {
        root = createRoot(container);
        root.render(<Harness activeSheet={before} cacheRef={cacheRef} />);
      });

      cacheRef.current = SENTINEL;

      // Same id, different paper width (setPaperSize) and scale (setDrawingScale).
      const after: DrawingSheet = { ...before, paper: { ...before.paper, widthMm: 841 } as DrawingSheet['paper'], scale: { name: 'x', factor: 100, useCase: '' } };
      await act(async () => {
        root!.render(<Harness activeSheet={after} cacheRef={cacheRef} />);
      });

      assert.equal(
        cacheRef.current,
        null,
        `cached transform must not survive a paper/scale change on the same sheet id; got ${JSON.stringify(cacheRef.current)}`,
      );
    } finally {
      if (root) await act(async () => { root!.unmount(); });
      container.remove();
    }
  });

  it('clears the cache on a SCALE-ONLY change (setDrawingScale with paper untouched)', async () => {
    // Isolates the `scale.factor` term of `sheetGeometryKey` from the paper
    // width — the previous test's fixture also changed paper width in the
    // same rerender, so it could pass even if the scale factor were dropped
    // from the key entirely (PR #2853 review).
    const cacheRef: React.MutableRefObject<CachedTransform> = { current: null };
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | null = null;
    try {
      const before = sheet('sheet-a', 50, 420);
      await act(async () => {
        root = createRoot(container);
        root.render(<Harness activeSheet={before} cacheRef={cacheRef} />);
      });

      cacheRef.current = SENTINEL;

      // SAME id and paper, ONLY the scale factor changes.
      const after: DrawingSheet = { ...before, scale: { name: 'x', factor: 100, useCase: '' } };
      await act(async () => {
        root!.render(<Harness activeSheet={after} cacheRef={cacheRef} />);
      });

      assert.equal(
        cacheRef.current,
        null,
        `cached transform must not survive a scale-only change; got ${JSON.stringify(cacheRef.current)}`,
      );
    } finally {
      if (root) await act(async () => { root!.unmount(); });
      container.remove();
    }
  });

  it('clears the cache on a PAPER-SIZE-ONLY change (setPaperSize with viewport/scale untouched)', async () => {
    // Isolates the `paper.widthMm`/`heightMm` term of `sheetGeometryKey`.
    // The `sheet()` fixture DERIVES `viewportBounds.width` from `widthMm`
    // (`width: widthMm - 20`), so simply calling `sheet('sheet-a', f, 841)`
    // for `after` would move paper size AND viewportBounds together and
    // could not tell which term the assertion actually depends on (PR #2853
    // review — mutating either term alone left the previous single
    // "paper AND scale" test green). Build `after` by overriding ONLY
    // `paper`, holding `before`'s `viewportBounds` literally.
    const cacheRef: React.MutableRefObject<CachedTransform> = { current: null };
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | null = null;
    try {
      const before = sheet('sheet-a', 50, 420);
      await act(async () => {
        root = createRoot(container);
        root.render(<Harness activeSheet={before} cacheRef={cacheRef} />);
      });

      cacheRef.current = SENTINEL;

      // SAME id, viewportBounds and scale; ONLY the paper size changes.
      const after: DrawingSheet = {
        ...before,
        paper: { ...before.paper, widthMm: 841, heightMm: 594 } as DrawingSheet['paper'],
      };
      await act(async () => {
        root!.render(<Harness activeSheet={after} cacheRef={cacheRef} />);
      });

      assert.equal(
        cacheRef.current,
        null,
        `cached transform must not survive a paper-size-only change; got ${JSON.stringify(cacheRef.current)}`,
      );
    } finally {
      if (root) await act(async () => { root!.unmount(); });
      container.remove();
    }
  });

  it('clears the cache on a VIEWPORT-BOUNDS-ONLY change (updateFrameMargins with paper/scale untouched)', async () => {
    // Isolates the `viewportBounds` term of `sheetGeometryKey` — the
    // `updateFrameMargins` path recomputes `viewportBounds` without
    // touching `paper` or `scale` at all, so a key that dropped this term
    // would leave the cache stale through a margin change with nothing
    // above catching it (PR #2853 review).
    const cacheRef: React.MutableRefObject<CachedTransform> = { current: null };
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | null = null;
    try {
      const before = sheet('sheet-a', 50, 420);
      await act(async () => {
        root = createRoot(container);
        root.render(<Harness activeSheet={before} cacheRef={cacheRef} />);
      });

      cacheRef.current = SENTINEL;

      // SAME id, paper and scale; ONLY the viewport bounds change.
      const after: DrawingSheet = {
        ...before,
        viewportBounds: { ...before.viewportBounds, x: 20, y: 20 },
      };
      await act(async () => {
        root!.render(<Harness activeSheet={after} cacheRef={cacheRef} />);
      });

      assert.equal(
        cacheRef.current,
        null,
        `cached transform must not survive a viewport-bounds-only change; got ${JSON.stringify(cacheRef.current)}`,
      );
    } finally {
      if (root) await act(async () => { root!.unmount(); });
      container.remove();
    }
  });

  it('negative control: keeps the cached transform across a re-render of the SAME sheet', async () => {
    const cacheRef: React.MutableRefObject<CachedTransform> = { current: null };
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | null = null;
    try {
      const sheetA = sheet('sheet-a', 50, 420);
      await act(async () => {
        root = createRoot(container);
        root.render(<Harness activeSheet={sheetA} cacheRef={cacheRef} />);
      });

      cacheRef.current = SENTINEL;

      // Re-render with the SAME sheet object (e.g. an unrelated parent
      // re-render) — the cache must survive, or "pinned" would never work.
      await act(async () => {
        root!.render(<Harness activeSheet={sheetA} cacheRef={cacheRef} />);
      });

      assert.deepEqual(
        cacheRef.current,
        SENTINEL,
        'an unrelated re-render with the same sheet must not clear the pin cache',
      );
    } finally {
      if (root) await act(async () => { root!.unmount(); });
      container.remove();
    }
  });
});
