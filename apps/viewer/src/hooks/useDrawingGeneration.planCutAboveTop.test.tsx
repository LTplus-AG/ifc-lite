/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A plan cut above the model top draws the top storey in projection (#8162).
 *
 * Fixture (viewer Y-up, metres): a top storey at 2.5 m holding only a slab
 * (id 200, y 2.5..2.7) and a low parapet (id 300, y 2.5..3.0), over a wall
 * (id 100, y 0..2.5). The model top is 3.0 m; the plan cut through the top
 * storey is 2.5 + 1.2 = 3.7 m. Clamped to the bounds, that cut sat on the
 * parapet's top face; kept at 3.7 m, nothing is cut and the top storey shows
 * as projection below the plane. An empty plan is not what is asserted: the
 * slab and parapet must be drawn, as projection.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { percentToWorld, storeyCutPosition } from '@/lib/section/section-distance';
import { useDrawingGeneration } from './useDrawingGeneration.js';

function box(expressId: number, min: [number, number, number], max: [number, number, number]): MeshData {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
    3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
  ]);
  return { expressId, ifcType: 'IfcSlab', modelIndex: 0, positions, normals: new Float32Array(positions.length), indices, color: [0.5, 0.5, 0.5, 1], geometryClass: 0 };
}

const WALL = 100;
const SLAB = 200;
const PARAPET = 300;
const RANGE = { min: 0, max: 3 };
const geometryResult: GeometryResult = {
  meshes: [
    box(WALL, [0, 0, 0], [10, 2.5, 0.3]),
    box(SLAB, [0, 2.5, 0], [10, 2.7, 8]),
    box(PARAPET, [0, 2.5, 7.8], [10, 3, 8]),
  ],
  totalTriangles: 36,
  totalVertices: 24,
  coordinateInfo: {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 3, z: 8 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 3, z: 8 } },
    hasLargeCoordinates: false,
  },
};

let runGenerate: (() => Promise<void>) | null = null;
let lastDrawing: Drawing2D | null = null;

function Harness(): null {
  const sectionPlane = useViewerStore((s) => s.sectionPlane);
  const { generateDrawing } = useDrawingGeneration({
    activeTool: 'select',
    geometryResult,
    ifcDataStore: null,
    sectionPlane,
    displayOptions: { showHiddenLines: false, useSymbolicRepresentations: false, show3DOverlay: false, scale: 100, showConstructionProjection: true },
    combinedHiddenIds: new Set<number>(),
    combinedIsolatedIds: null,
    computedIsolatedIds: null,
    models: new Map(),
    panelVisible: false,
    typeVisibility: { spaces: true, spatialZones: true, openings: true, virtualElements: true, site: true, ifcAnnotations: true },
    drawing: null,
    setDrawing: (d) => { lastDrawing = d; },
    setDrawingStatus: () => {},
    setDrawingProgress: () => {},
    setDrawingError: () => {},
  });
  runGenerate = generateDrawing;
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(async () => {
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  lastDrawing = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<Harness />); });
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
});

const ids = (lines: Drawing2D['lines']) => new Set(lines.map((l) => l.entityId));

it('the top-storey plan cut at 3.7 m draws the slab and parapet as projection, cutting nothing (#8162)', async () => {
  const position = storeyCutPosition({ elevation: 2.5 }, RANGE);
  assert.ok(Math.abs(percentToWorld(position, RANGE) - 3.7) < 1e-9);
  await act(async () => {
    useViewerStore.getState().setSectionPlaneAxis('down');
    useViewerStore.getState().setSectionPlanePosition(position);
  });
  assert.ok(runGenerate, 'harness rendered');
  await act(async () => { await runGenerate!(); });

  const drawing = lastDrawing;
  assert.ok(drawing, 'a drawing was produced');
  assert.ok(Math.abs(drawing.config.plane.position - 3.7) < 1e-6, `the drawing cuts at ${drawing.config.plane.position} m, not 3.7 m`);
  const cut = drawing.lines.filter((l) => l.category === 'cut');
  assert.deepEqual([...ids(cut)], [], 'nothing is cut: the plane is above every element');
  assert.equal(drawing.cutPolygons.length, 0, 'no cut fill');
  const drawn = ids(drawing.lines.filter((l) => l.category !== 'cut'));
  assert.ok(drawn.has(SLAB), `the top-storey slab is drawn below the cut; got ${JSON.stringify([...drawn])}`);
  assert.ok(drawn.has(PARAPET), `the parapet is drawn below the cut; got ${JSON.stringify([...drawn])}`);
});
