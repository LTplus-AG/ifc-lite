/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dimensions are drawing content: they map through the same sheet transform
 * as the cut geometry, so on a sheet they are clipped to the sheet viewport
 * like that geometry is. Painted after the viewport clip was restored, a
 * dimension extending past the viewport drew over the frame and title block.
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
import { drawingViewMapping } from '@/lib/drawing2d-markup/drawing-view-mapping.js';
import type { DimensionScene } from './drawing/drawDimensions2D.js';

installLayout();

type Rect = [number, number, number, number];

/** A 2D context stub that records, for each text drawn, the clip rect in force. */
function installCanvasStub(): { textClips: Map<string, Rect | null>; restore: () => void } {
  const textClips = new Map<string, Rect | null>();
  let pathRect: Rect | null = null;
  let clip: Rect | null = null;
  const stack: (Rect | null)[] = [];
  const ctx = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'measureText') return (text: string) => ({ width: String(text).length * 7 });
        if (prop === 'canvas') return { width: 800, height: 600 };
        return (...args: unknown[]) => {
          switch (prop) {
            case 'save': stack.push(clip); break;
            case 'restore': clip = stack.pop() ?? null; break;
            case 'beginPath': pathRect = null; break;
            case 'rect': pathRect = args as Rect; break;
            case 'clip': clip = pathRect; break;
            case 'fillText': textClips.set(String(args[0]), clip); break;
          }
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
  return { textClips, restore: () => { HTMLCanvasElement.prototype.getContext = original; } };
}

const DRAWING: Drawing2D = {
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

function sheet(): DrawingSheet {
  const paper = PAPER_SIZE_REGISTRY.A3_LANDSCAPE;
  const frame = { style: 'professional' as const, ...FRAME_PRESETS.professional };
  const titleBlock = {
    ...TITLE_BLOCK_PRESETS.standard,
    fields: DEFAULT_TITLE_BLOCK_FIELDS.map((f) => ({ ...f })),
    logo: null,
  };
  return {
    id: 'dim-clip',
    name: 'dim-clip',
    paper,
    frame,
    titleBlock,
    scaleBar: { ...DEFAULT_SCALE_BAR, visible: false },
    scale: { name: '1:100', factor: 100, useCase: '' },
    northArrow: { ...DEFAULT_NORTH_ARROW, style: 'none' },
    viewportBounds: calculateViewportBounds(paper, frame, titleBlock),
    revisions: [],
  };
}

const DIMENSION_TEXT = 'DIM-4000';

const scene: DimensionScene = {
  dimensions: [{ id: 'd', a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: -1, orientation: 'aligned' }],
  currentPlane: null,
  selectedId: null,
  layout: {
    mapping: drawingViewMapping({ x: 0, y: 0, scale: 10 }, 'down'),
    paperScale: 100,
    format: () => DIMENSION_TEXT,
  },
};

function render(sheetEnabled: boolean): Map<string, Rect | null> {
  const stub = installCanvasStub();
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  const cachedSheetTransformRef: React.MutableRefObject<CachedSheetTransform | null> = { current: null };
  try {
    act(() => {
      root = createRoot(container);
      root.render(
        <Drawing2DCanvas
          drawing={DRAWING}
          transform={{ x: 0, y: 0, scale: 10 }}
          showHiddenLines={false}
          overrideEngine={new GraphicOverrideEngine()}
          overridesEnabled={false}
          entityColorMap={new Map()}
          useIfcMaterials={false}
          sectionAxis="down"
          sheetEnabled={sheetEnabled}
          activeSheet={sheetEnabled ? sheet() : null}
          cachedSheetTransformRef={cachedSheetTransformRef}
          dimensionScene={scene}
        />,
      );
    });
    return stub.textClips;
  } finally {
    act(() => { root?.unmount(); });
    container.remove();
    stub.restore();
  }
}

describe('Drawing2DCanvas clips dimensions like the drawing they belong to', () => {
  it('draws dimensions inside the sheet viewport clip in sheet mode', () => {
    const textClips = render(true);
    assert.ok(textClips.has(DIMENSION_TEXT), 'the dimension text was drawn');
    const clip = textClips.get(DIMENSION_TEXT);
    assert.ok(clip, 'the dimension was drawn with no clip in force, over the sheet frame and title block');
    // The same rect the drawing content is clipped to.
    const v = sheet().viewportBounds;
    const [, , w, h] = clip;
    assert.ok(Math.abs(w / h - v.width / v.height) < 1e-9, `clip ${JSON.stringify(clip)} is not the viewport ${JSON.stringify(v)}`);
  });

  it('leaves dimensions unclipped in direct mode', () => {
    const textClips = render(false);
    assert.ok(textClips.has(DIMENSION_TEXT), 'the dimension text was drawn');
    assert.equal(textClips.get(DIMENSION_TEXT), null);
  });
});
