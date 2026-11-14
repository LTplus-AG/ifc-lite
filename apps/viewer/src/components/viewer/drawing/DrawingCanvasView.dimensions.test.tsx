/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The canvas region on a ready cut with no geometry (#10076 review): it stays
 * mounted for dimensions, saved ones from another cut and one being placed,
 * and shows the empty-state note only when there is nothing at all.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRef } from 'react';
import { GraphicOverrideEngine, type Drawing2D } from '@ifc-lite/drawing-2d';
import { render, cleanup } from '@/test/render';
import type { DimensionScene } from './drawDimensions2D';
import { drawingViewMapping } from '@/lib/drawing2d-markup/drawing-view-mapping';
import { DrawingCanvasView } from './DrawingCanvasView';
import type { DrawingViewModel } from './useDrawingViewModel';
import type { DrawingLayers } from './useDrawingLayers';

installLayout();
afterEach(() => { cleanup(); mock.restoreAll(); });

const empty: Drawing2D = {
  config: { plane: { axis: 'y', position: 0, flipped: false }, projectionDepth: 10, includeHiddenLines: false, creaseAngle: 30, scale: 100 },
  lines: [], cutPolygons: [], projectionPolygons: [], bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } },
  stats: { cutLineCount: 0, projectionLineCount: 0, hiddenLineCount: 0, silhouetteLineCount: 0, polygonCount: 0, totalTriangles: 0, processingTimeMs: 0 },
};
const plane = { axis: 'down' as const, position: 1, flipped: false };
const layout = { mapping: drawingViewMapping({ x: 0, y: 0, scale: 100 }, 'down'), paperScale: 100, format: (m: number) => String(m) };

function view(scene: DimensionScene | null): HTMLElement {
  const ctx = new Proxy({}, { get: (_t, key) => (key === 'measureText' ? () => ({ width: 0 }) : key === 'canvas' ? { width: 800, height: 600 } : () => undefined), set: () => true });
  mock.method(HTMLCanvasElement.prototype, 'getContext', () => ctx);
  const vm = {
    drawing: empty, status: 'ready', drawnPlane: plane, viewTransform: { x: 0, y: 0, scale: 100 },
    displayOptions: { showHiddenLines: false, showScanSection: false, scanSectionOpacity: 1 },
    containerRef: createRef<HTMLDivElement>(), cursorClass: '', canvasMouseHandlers: {}, hasReferences: false,
    textAnnotation2DEditing: null, textAnnotations2D: [], tagTexts: [], cloudAnnotation2DPoints: [], cloudAnnotations2D: [],
    polygonArea2DPoints: [], polygonArea2DResults: [], measure2DResults: [], measure2DMode: false,
    overrideEngine: new GraphicOverrideEngine(), overridesEnabled: false, entityColorMap: new Map(),
    annotation2DActiveTool: 'dimension', cachedSheetTransformRef: { current: null }, sheetEnabled: false, isPinned: false,
    unitDisplayOverrides: {}, selectedAnnotation2D: null,
    dimensionTool: { scene, hover: null },
  } as unknown as DrawingViewModel;
  const layers = { dxfUnderlayData: [], ifcAnnotationData: { lines: [], texts: [], fills: [] }, scanSectionLayer: { points: [], outline: null } } as unknown as DrawingLayers;
  return render(<DrawingCanvasView vm={vm} layers={layers} />);
}

const mounted = (root: HTMLElement) => root.querySelector('canvas') !== null;
const emptyNote = (root: HTMLElement) => root.textContent?.includes('No geometry at this level') ?? false;

it('an empty cut with nothing to draw shows the empty-state note', () => {
  const root = view(null);
  assert.equal(mounted(root), false);
  assert.equal(emptyNote(root), true);
});

it('an empty cut keeps the canvas for a saved dimension from another cut', () => {
  const root = view({ dimensions: [{ id: 'd', a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: -1, orientation: 'aligned', plane: { ...plane, position: 4 } }],
    currentPlane: plane, selectedId: null, layout });
  assert.equal(mounted(root), true, 'the dimension layer is drawn');
  assert.equal(emptyNote(root), false, 'the empty-state note does not cover it');
});

it('an empty cut mounts the canvas once the first dimension point is placed', () => {
  const tool: DimensionScene = { dimensions: [], currentPlane: plane, selectedId: null, layout, placedPoints: [], preview: null, snap: null, markers: [] };
  assert.equal(mounted(view(tool)), false, 'before any point: nothing to draw yet');
  cleanup();
  const placed = view({ ...tool, placedPoints: [{ x: 1, y: 1 }] });
  assert.equal(mounted(placed), true, 'the placed point and rubber band are drawn');
});
