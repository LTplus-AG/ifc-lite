/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Closes the user-visible gap left in the merged drawing-persistence feature
 * (issue #4153): markup (measurements, annotations) is restored on reload,
 * but the section cut that produced it is not — `useDrawing2DPersistence.ts`
 * loaded `entry.sectionConfig` only into its own module-local
 * `lastSectionConfig` variable, used solely to re-save it, and never fed it
 * to drawing generation. After a reload the restored markup floated over
 * whichever cut `sectionPlane` already held (the slice default, or a
 * PREVIOUS session's unrelated last-used cardinal mode), not the one it was
 * actually drawn against.
 *
 * This mounts BOTH real hooks together (`useDrawing2DPersistence` +
 * `useDrawingGeneration`), exactly as `Section2DPanel.tsx` does, wired
 * through a `sectionPlane` prop that is read live from the store — so the
 * fix under test (`useDrawingGeneration.ts` consuming
 * `consumeRestoredSectionConfig` and writing the converted plane back into
 * the store) is exercised end-to-end, not just at the module-level API.
 *
 * The fixture uses two disjoint boxes so the resulting `Drawing2D`'s
 * entity ids alone prove WHICH plane the generator actually cut on:
 *   - box A (id 100): x [0,10], y [6,10], z [0,10] — spans the full x range,
 *     but its y range excludes 5, so the slice's DEFAULT cut (axis 'down',
 *     50% of y => y=5) never touches it.
 *   - box B (id 200): x [0,3],  y [0,10], z [0,10] — its y range includes 5
 *     (the default cut hits it), but its x range excludes 8.
 * The persisted `sectionConfig` cuts on x=8 (80% of the [0,10] x-bounds).
 * That plane intersects ONLY box A. If restore is wired correctly, the
 * generated drawing contains entity 100 and not 200; if the gap this test
 * targets is still open, generation runs on the untouched default plane and
 * produces entity 200 instead (or, once #4153 was reopened as a regression,
 * neither/both — any outcome other than exactly {100} is a failure).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store';
import { useDrawing2DPersistence } from './useDrawing2DPersistence.js';
import { useDrawingGeneration } from './useDrawingGeneration.js';
import {
  saveDrawing2DEntry,
  clearAllDrawing2DEntries,
} from '@/store/slices/drawing2DSlice.persistence.js';
import { computeFullSourceHashFromBlob } from '@/utils/sourceContentHash.js';

// ─── Fixture ─────────────────────────────────────────────────────────────

function box(
  expressId: number,
  min: [number, number, number],
  max: [number, number, number],
): MeshData {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0, y0, z0,  x1, y0, z0,  x1, y1, z0,  x0, y1, z0,
    x0, y0, z1,  x1, y0, z1,  x1, y1, z1,  x0, y1, z1,
  ]);
  const indices = new Uint32Array([
    0, 1, 2,  0, 2, 3,
    4, 6, 5,  4, 7, 6,
    0, 4, 5,  0, 5, 1,
    3, 2, 6,  3, 6, 7,
    0, 3, 7,  0, 7, 4,
    1, 5, 6,  1, 6, 2,
  ]);
  return {
    expressId,
    ifcType: 'IfcWall',
    modelIndex: 0,
    positions,
    normals: new Float32Array(positions.length),
    indices,
    color: [0.5, 0.5, 0.5, 1],
    geometryClass: 0,
  };
}

const BOX_A_ID = 100; // hit only by the persisted x=8 cut
const BOX_B_ID = 200; // hit only by the default down/50% (y=5) cut

const geometryResult: GeometryResult = {
  meshes: [
    box(BOX_A_ID, [0, 6, 0], [10, 10, 10]),
    box(BOX_B_ID, [0, 0, 0], [3, 10, 10]),
  ],
  totalTriangles: 24,
  totalVertices: 16,
  coordinateInfo: {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } },
    hasLargeCoordinates: false,
  },
} as GeometryResult;

function fileWithBytes(seed: number, name: string): File {
  const bytes = new Uint8Array(256).map((_, i) => (i + seed) % 256);
  return new File([bytes], name, { type: 'application/octet-stream' });
}

function stubModel(id: string, sourceFile: File): FederatedModel {
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 0,
    fileSize: sourceFile.size,
    sourceFile,
    idOffset: 0,
    maxExpressId: 0,
  } as FederatedModel;
}

// ─── Harness — mirrors Section2DPanel.tsx's wiring ─────────────────────────

let runGenerate: (() => Promise<void>) | null = null;
let lastDrawing: Drawing2D | null = null;

function Harness(): null {
  useDrawing2DPersistence();
  const sectionPlane = useViewerStore((s) => s.sectionPlane);
  const displayOptions = useViewerStore((s) => s.drawing2DDisplayOptions);
  const { generateDrawing } = useDrawingGeneration({
    activeTool: 'select',
    geometryResult,
    ifcDataStore: null,
    sectionPlane,
    displayOptions: {
      showHiddenLines: displayOptions.showHiddenLines,
      useSymbolicRepresentations: false,
      show3DOverlay: displayOptions.show3DOverlay,
      scale: displayOptions.scale,
      showConstructionProjection: false,
    },
    combinedHiddenIds: new Set<number>(),
    combinedIsolatedIds: null,
    computedIsolatedIds: null,
    models: new Map([['model-a', { id: 'model-a', visible: true }]]),
    // Closed, same as the real production gap this issue describes: restore
    // runs unconditionally regardless of panel visibility.
    panelVisible: false,
    typeVisibility: {
      spaces: true,
      spatialZones: true,
      openings: true,
      virtualElements: true,
      site: true,
      ifcAnnotations: true,
    },
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

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Harness />);
  });
}

async function flushDeep(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
  });
}

function entityIds(drawing: Drawing2D | null): Set<number> {
  const out = new Set<number>();
  for (const line of drawing?.lines ?? []) out.add(line.entityId);
  for (const poly of drawing?.cutPolygons ?? []) out.add(poly.entityId);
  return out;
}

beforeEach(() => {
  clearAllDrawing2DEntries();
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  lastDrawing = null;
  runGenerate = null;
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  if (container) { container.remove(); container = null; }
  clearAllDrawing2DEntries();
});

describe('restore feeding generation — MUTATION TARGET: issue #4153 gap', () => {
  it('regenerates the section cut from the restored SectionConfig, not the slice default', async () => {
    const file = fileWithBytes(7, 'restored-cut.ifc');
    const hash = (await computeFullSourceHashFromBlob(file))!;
    const model = stubModel('model-a', file);

    const defaults = useViewerStore.getState().drawing2DDisplayOptions;
    saveDrawing2DEntry(hash, {
      measure2DResults: [],
      polygonArea2DResults: [],
      textAnnotations2D: [],
      cloudAnnotations2D: [],
      drawing2DDisplayOptions: defaults,
      // World-space x cut at 8 (80% of the fixture's [0,10] x-bounds) — hits
      // box A (id 100) only, never box B (id 200).
      sectionConfig: {
        plane: { axis: 'x', position: 8, flipped: false },
        projectionDepth: 10,
        includeHiddenLines: false,
        creaseAngle: 30,
        scale: 100,
      },
    });

    useViewerStore.setState({ models: new Map([['model-a', model]]) });
    await mount();

    await act(async () => { useViewerStore.getState().setActiveModel('model-a'); });
    await flushDeep();

    assert.ok(runGenerate, 'harness never rendered — useDrawingGeneration was not called');
    await act(async () => { await runGenerate!(); });

    const ids = entityIds(lastDrawing);
    assert.ok(
      ids.has(BOX_A_ID),
      `restored cut (x=8) must intersect box A (id ${BOX_A_ID}) — got entity ids ${JSON.stringify([...ids])}. ` +
      'Generation ran on the un-restored default plane instead of the persisted sectionConfig.',
    );
    assert.ok(
      !ids.has(BOX_B_ID),
      `restored cut (x=8) must NOT intersect box B (id ${BOX_B_ID}), which only the slice-default ` +
      `down/50% cut (y=5) would hit — got entity ids ${JSON.stringify([...ids])}.`,
    );
  });
});
