/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A plan cut opens with construction projection; a section cut does not (#8802).
 *
 * Fixture (viewer Y-up, metres): a 6 m wall (id 100, y 0..2.5) standing on a
 * slab (id 200, y -0.2..0). The display options are the store's REAL
 * defaults. A plan cut at 1.2 m cuts the wall; the slab lies below it and is
 * the floor a plan has to show, so it must be drawn as projection. A front
 * section through the same model keeps the previous default: cut only.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { getDefaultDrawing2DState } from '@/store/slices/drawing2DSlice';
import { useDrawingGeneration } from './useDrawingGeneration.js';

function box(expressId: number, ifcType: string, min: [number, number, number], max: [number, number, number]): MeshData {
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
  return { expressId, ifcType, modelIndex: 0, positions, normals: new Float32Array(positions.length), indices, color: [0.5, 0.5, 0.5, 1], geometryClass: 0 };
}

const WALL = 100;
const SLAB = 200;
const RANGE = { min: -0.2, max: 2.5 };
const geometryResult: GeometryResult = {
  meshes: [
    box(WALL, 'IfcWall', [0, 0, 0], [6, 2.5, 0.2]),
    box(SLAB, 'IfcSlab', [0, -0.2, 0], [6, 0, 5]),
  ],
  totalTriangles: 24,
  totalVertices: 16,
  coordinateInfo: {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: 0, y: RANGE.min, z: 0 }, max: { x: 6, y: RANGE.max, z: 5 } },
    shiftedBounds: { min: { x: 0, y: RANGE.min, z: 0 }, max: { x: 6, y: RANGE.max, z: 5 } },
    hasLargeCoordinates: false,
  },
};

let runGenerate: (() => Promise<void>) | null = null;
let lastDrawing: Drawing2D | null = null;

function Harness(): null {
  const sectionPlane = useViewerStore((s) => s.sectionPlane);
  const displayOptions = useViewerStore((s) => s.drawing2DDisplayOptions);
  const { generateDrawing } = useDrawingGeneration({
    activeTool: 'select',
    geometryResult,
    ifcDataStore: null,
    sectionPlane,
    displayOptions,
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
  useViewerStore.setState({ drawing2DDisplayOptions: getDefaultDrawing2DState().drawing2DDisplayOptions });
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

async function generate(axis: 'down' | 'front', worldPosition: number, range: { min: number; max: number }): Promise<Drawing2D> {
  await act(async () => {
    useViewerStore.getState().setSectionPlaneAxis(axis);
    useViewerStore.getState().setSectionPlanePosition(((worldPosition - range.min) / (range.max - range.min)) * 100);
  });
  assert.ok(runGenerate, 'harness rendered');
  await act(async () => { await runGenerate!(); });
  assert.ok(lastDrawing, 'a drawing was produced');
  return lastDrawing;
}

const projectedIds = (d: Drawing2D) => new Set(d.lines.filter((l) => l.category === 'projection').map((l) => l.entityId));

it('a plan cut opens with the floor below it drawn as projection, by default (#8802)', async () => {
  const drawing = await generate('down', 1.2, RANGE);
  assert.ok(drawing.cutPolygons.some((p) => p.entityId === WALL), 'the plan cuts the wall');
  const projected = projectedIds(drawing);
  assert.ok(projected.has(SLAB), `the slab below the cut is drawn as projection; projected ids ${JSON.stringify([...projected])}`);
});

it('a front section opens cut-only, by default, as before (#8802)', async () => {
  // Front cuts along Z: through the wall (z 0..0.2) and the slab (z 0..5).
  const drawing = await generate('front', 0.1, { min: 0, max: 5 });
  assert.ok(drawing.cutPolygons.some((p) => p.entityId === WALL), 'the section cuts the wall');
  assert.equal(projectedIds(drawing).size, 0, 'no projection on a section until the user turns it on');
});
