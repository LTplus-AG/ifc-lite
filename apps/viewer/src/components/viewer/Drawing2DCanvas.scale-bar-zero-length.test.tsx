/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Drawing2DCanvas` sizes its scale bar by doubling a target length until it
 * fills the cell:
 *
 *     while (sbLengthMm < maxBarWidth * 0.3 && targetLengthM < 100)
 *       targetLengthM = targetLengthM * 2;
 *
 * `0 * 2` is 0, so neither condition ever changes and the loop never
 * terminates. A negative length is the same shape, doubling toward -Infinity,
 * which stays below 100 forever. The loop runs synchronously inside the drawing
 * effect, so it does not merely draw wrongly: it wedges the render.
 *
 * `calculateOptimalScaleBarLength` returns 0 deliberately, as a sentinel for
 * "no usable bar at this scale and paper budget", pinned by
 * scale-bar-ladder.test.ts. The export renderer honours it and draws nothing.
 * This canvas did not, so the fix is the canvas agreeing with the exporter, not
 * a change to what 0 means. My first attempt clamped the calculator instead,
 * which broke that contract and failed the peer's test that asserts it.
 *
 * This test exists because the first version of it did not. That one
 * transcribed the loop into a unit test in `@ifc-lite/drawing-2d` and asserted
 * the copy spins. Deleting every guard clause from `Drawing2DCanvas` left it
 * green, because it never imported the component: a guard that could not catch
 * its own regression. Driving the real component is the whole point, and the
 * harness for it already existed in this directory.
 *
 * How the failure shows up: with the guard removed the render never returns, so
 * this test does not fail with an assertion, it stops responding and the
 * runner's timeout kills it. That is a slow red, and it is a real one. Nothing
 * in-process can bound a synchronous infinite loop, because a wedged event loop
 * cannot run a timer either.
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
import type { CachedSheetTransform } from '@/lib/drawing/sheet-geometry-key.js';

installLayout();

/** Counting 2D context stub. Mirrors the Proxy stub in
 *  Drawing2DCanvas.stale-pinned-transform.test.tsx, but tallies the calls that
 *  draw a scale bar so "did it draw one" is answerable. */
function installCanvasStub(): { calls: Map<string, number>; restore: () => void } {
  const calls = new Map<string, number>();
  const bump = (name: string) => calls.set(name, (calls.get(name) ?? 0) + 1);

  const ctx = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'measureText') return (text: string) => ({ width: String(text).length * 7 });
        if (prop === 'canvas') return { width: 800, height: 600 };
        return (...args: unknown[]) => {
          bump(String(prop));
          if (String(prop) === 'fillText') bump(`fillText:${String(args[0])}`);
          return undefined;
        };
      },
      set() {
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;

  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = ((kind: string) =>
    kind === '2d' ? ctx : null) as unknown as typeof HTMLCanvasElement.prototype.getContext;

  return { calls, restore: () => { HTMLCanvasElement.prototype.getContext = original; } };
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

function sheetWithBarLength(totalLengthM: number): DrawingSheet {
  const paper = PAPER_SIZE_REGISTRY.A3_LANDSCAPE;
  const frame = { style: 'professional' as const, ...FRAME_PRESETS.professional };
  const titleBlock = {
    ...TITLE_BLOCK_PRESETS.standard,
    fields: DEFAULT_TITLE_BLOCK_FIELDS.map((f) => ({ ...f })),
    logo: null,
  };
  return {
    id: 'zero-bar',
    name: 'zero-bar',
    paper,
    frame,
    titleBlock,
    scaleBar: { ...DEFAULT_SCALE_BAR, visible: true, totalLengthM },
    scale: { name: '1:100', factor: 100, useCase: '' },
    northArrow: { ...DEFAULT_NORTH_ARROW },
    viewportBounds: calculateViewportBounds(paper, frame, titleBlock),
    revisions: [],
  };
}

function render(totalLengthM: number): Map<string, number> {
  const stub = installCanvasStub();
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  const cachedSheetTransformRef: React.MutableRefObject<CachedSheetTransform | null> = {
    current: null,
  };
  try {
    act(() => {
      root = createRoot(container);
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
          activeSheet={sheetWithBarLength(totalLengthM)}
          cachedSheetTransformRef={cachedSheetTransformRef}
        />,
      );
    });
    return stub.calls;
  } finally {
    act(() => { root?.unmount(); });
    container.remove();
    stub.restore();
  }
}

describe('Drawing2DCanvas does not wedge on an unusable scale bar length', () => {
  it('returns from the render with totalLengthM = 0', () => {
    // Reaching the next line at all IS the assertion. Without the guard the
    // doubling loop never exits and this never returns.
    const calls = render(0);
    assert.ok((calls.get('fillRect') ?? 0) >= 0, 'render completed');
  });

  it('returns from the render with a negative totalLengthM', () => {
    // Doubles toward -Infinity, which stays below the loop's `< 100` bound.
    const calls = render(-5);
    assert.ok((calls.get('fillRect') ?? 0) >= 0, 'render completed');
  });

  it('returns from the render with an infinite totalLengthM', () => {
    // A DIFFERENT loop from the other two. `Infinity > 0` passes a positivity
    // check, so the first version of this guard admitted it, and the HALVING
    // loop above the doubling one spins because `Infinity / 2` is `Infinity`.
    // Review caught this against the supposedly-fixed component: a 20,000 ms
    // budget, killed at 20,002 ms. The bug report named the doubling loop and I
    // never looked at the one above it.
    const calls = render(Number.POSITIVE_INFINITY);
    assert.ok((calls.get('fillRect') ?? 0) >= 0, 'render completed');
  });

  // The positive control. Without it, a guard that skipped the scale bar
  // unconditionally would satisfy both cases above, which would be a worse
  // bug than the hang and completely invisible here.
  it('still draws a bar for a usable length', () => {
    const zero = render(0);
    const usable = render(5);
    const zeroFills = zero.get('fillRect') ?? 0;
    const usableFills = usable.get('fillRect') ?? 0;
    assert.ok(
      usableFills > zeroFills,
      `a usable length must draw more than an unusable one (usable=${usableFills}, zero=${zeroFills})`,
    );
  });

  // The north arrow is drawn after the scale bar in the same function, so an
  // early `return` inside the block would silently drop it. That was my first
  // attempt at this guard.
  //
  // The assertion is `fillText:N`, not `stroke`, and the difference is the
  // whole test. Review measured `stroke` at 8 calls with the arrow explicitly
  // set to `style: 'none'`, because the frame and title-block rules call it
  // regardless. An `|| stroke` disjunct made this pass 4/4 with the arrow
  // actually gone, which review proved by reintroducing the early return.
  // `fillText:N` goes 1 -> 0 with the arrow, and nothing else emits it.
  it('still draws the north arrow when the scale bar is skipped', () => {
    const calls = render(0);
    assert.equal(
      calls.get('fillText:N') ?? 0,
      1,
      'the north arrow glyph must still be drawn when the scale bar is skipped',
    );
  });
});
