/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2199 slice that #2538 ("measurement distance readouts honour
 * unitDisplayOverrides", 0de10a0fd) did not cover: the 2D section/drawing
 * canvas. `Drawing2DCanvas`'s on-canvas distance label (drawn for each
 * completed measurement) called `formatDistance(distance)` with no
 * `overrides` argument, so a user who set feet as their LENGTHUNIT display
 * override still saw metres there — unlike every measure-tool readout in
 * `MeasurePanel.tsx` / `MeasurementVisuals.tsx`, which #2538 already fixed.
 *
 * The canvas draws imperatively (`ctx.fillText`), so this test installs a
 * recording `CanvasRenderingContext2D` stub (happy-dom implements the
 * `<canvas>` element but not 2D rendering) and a synchronous ResizeObserver
 * (`installLayout()`, #2434) so the draw effect's early-return guards
 * (`canvasSize.width === 0`, `!ctx`) don't skip the draw entirely.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GraphicOverrideEngine } from '@ifc-lite/drawing-2d';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import { Drawing2DCanvas, type Measure2DResultData } from './Drawing2DCanvas.js';

installLayout();

/** Records every `fillText` call so a test can assert on the exact label
 *  string the canvas drew, without a real 2D rendering backend. All other
 *  `CanvasRenderingContext2D` members are no-ops (methods) or accept any
 *  assignment (properties) — the component under test calls dozens of them
 *  (`beginPath`, `fillStyle = ...`, `save`, `clip`, ...) that this test does
 *  not care about. */
function installCanvasStub(): { fillTextCalls: string[]; restore: () => void } {
  const fillTextCalls: string[] = [];
  const store = new Map<string | symbol, unknown>();
  const ctx = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'measureText') return (text: string) => ({ width: text.length * 7 });
        if (prop === 'canvas') return { width: 800, height: 600 };
        if (prop === 'fillText') {
          return (text: string) => {
            fillTextCalls.push(text);
          };
        }
        if (store.has(prop)) return store.get(prop);
        // Any other canvas 2D method (beginPath, moveTo, lineTo, stroke,
        // fill, save, restore, translate, scale, clip, rect, arc,
        // setLineDash, fillRect, strokeRect, ...) is a no-op.
        return () => undefined;
      },
      set(_target, prop, value) {
        store.set(prop, value);
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;

  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = ((kind: string) =>
    kind === '2d' ? ctx : null) as unknown as typeof HTMLCanvasElement.prototype.getContext;

  return {
    fillTextCalls,
    restore: () => {
      HTMLCanvasElement.prototype.getContext = original;
    },
  };
}

/** Empty drawing. Only `bounds`, `lines`, and `cutPolygons` are read by the
 *  non-sheet-mode render path this test exercises, but every `Drawing2D`
 *  field is filled in (rather than cast past the interface) so this fixture
 *  keeps type-checking against the real shape as it evolves. */
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

const MEASURE_RESULT: Measure2DResultData = {
  id: 'm1',
  start: { x: 0, y: 0 },
  end: { x: 10, y: 0 },
  distance: 1, // metres — matches formatDistance.test.ts's "3.2808 ft" fixture
};

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderCanvas(unitDisplayOverrides?: Record<string, string>): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
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
        measureResults={[MEASURE_RESULT]}
        unitDisplayOverrides={unitDisplayOverrides}
      />,
    );
  });
  mounted.push({ root, container });
}

describe('Drawing2DCanvas unitDisplayOverrides (#2199 slice)', () => {
  it('honours a LENGTHUNIT override in the on-canvas distance label', () => {
    const stub = installCanvasStub();
    try {
      renderCanvas({ LENGTHUNIT: 'ft' });
      assert.ok(
        stub.fillTextCalls.includes('3.2808 ft'),
        `expected a "3.2808 ft" label; got ${JSON.stringify(stub.fillTextCalls)}`,
      );
      assert.ok(
        !stub.fillTextCalls.some((t) => t.includes(' m')),
        `no label should still read in metres; got ${JSON.stringify(stub.fillTextCalls)}`,
      );
    } finally {
      stub.restore();
    }
  });

  it('keeps the pre-existing metric label when no override is set (byte-identical to main)', () => {
    const stub = installCanvasStub();
    try {
      renderCanvas(undefined);
      assert.ok(
        stub.fillTextCalls.includes('1.000 m'),
        `expected the unconverted "1.000 m" label; got ${JSON.stringify(stub.fillTextCalls)}`,
      );
    } finally {
      stub.restore();
    }
  });
});
