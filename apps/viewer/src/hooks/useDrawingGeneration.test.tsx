/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Type-library geometry must not bleed into the standard 2D drawing (#2058).
 *
 * `geometryResult.meshes` carries the whole scene — placed occurrences AND the
 * type-library copies the wasm mesh pass emits (`geometryClass` 1 = orphan
 * type, 2 = instanced type). The 3D viewport routes that set through
 * `isMeshVisibleInViewMode`, so class 2 never reaches the Model view. The 2D
 * drawing generator filtered only on hiding/isolation, so every instanced type
 * template was cut and drawn on top of the plan — AC20-FZK-Haus alone carries
 * 32 such meshes (IfcWallType/IfcDoorType/IfcWindowType) against 285
 * occurrence meshes.
 *
 * These render the real hook (no mocked generator): two boxes straddling one
 * plan cut, one occurrence and one type template, and assert on the entity ids
 * that come back in the generated `Drawing2D`.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useDrawingGeneration } from './useDrawingGeneration.js';

// ─── Fixture ─────────────────────────────────────────────────────────────

/** Axis-aligned box in render space (Y-up), 12 triangles, flat normals
 *  omitted (the CPU cutter and edge extractor only read positions/indices). */
function box(
  expressId: number,
  ifcType: string,
  geometryClass: number,
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
    0, 1, 2,  0, 2, 3, // -z
    4, 6, 5,  4, 7, 6, // +z
    0, 4, 5,  0, 5, 1, // -y
    3, 2, 6,  3, 6, 7, // +y
    0, 3, 7,  0, 7, 4, // -x
    1, 5, 6,  1, 6, 2, // +x
  ]);
  return {
    expressId,
    ifcType,
    modelIndex: 0,
    positions,
    normals: new Float32Array(positions.length),
    indices,
    color: [0.5, 0.5, 0.5, 1],
    geometryClass,
  };
}

const OCCURRENCE_ID = 100;
const TYPE_ID = 200;

function geometry(meshes: MeshData[], max: [number, number, number]): GeometryResult {
  return {
    meshes,
    totalTriangles: meshes.length * 12,
    totalVertices: meshes.length * 8,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: max[0], y: max[1], z: max[2] } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: max[0], y: max[1], z: max[2] } },
      hasLargeCoordinates: false,
    },
  };
}

/** Drive the real hook once and return the drawing it publishes. */
async function generate(geometryResult: GeometryResult): Promise<Drawing2D | null> {
  let drawing: Drawing2D | null = null;
  let run: (() => Promise<void>) | null = null;

  function Harness(): null {
    const { generateDrawing } = useDrawingGeneration({
      geometryResult,
      ifcDataStore: null,
      sectionPlane: { axis: 'down', position: 50, flipped: false },
      displayOptions: {
        showHiddenLines: false,
        useSymbolicRepresentations: false,
        show3DOverlay: false,
        scale: 50,
        showConstructionProjection: false,
      },
      combinedHiddenIds: new Set<number>(),
      combinedIsolatedIds: null,
      computedIsolatedIds: null,
      models: new Map([['m0', { id: 'm0', visible: true }]]),
      // Panel closed: the auto-generate effects stay out of the way so the
      // drawing under test is the one this harness asks for, not a race.
      panelVisible: false,
      // Every class visible: this suite is about the type-LIBRARY filter
      // (#2058), so the category filter (#2060) must not remove anything here.
      typeVisibility: {
        spaces: true,
        spatialZones: true,
        openings: true,
        virtualElements: true,
        site: true,
        ifcAnnotations: true,
      },
      drawing: null,
      setDrawing: (d) => { drawing = d; },
      setDrawingStatus: () => {},
      setDrawingProgress: () => {},
      setDrawingError: () => {},
    });
    run = generateDrawing;
    return null;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  try {
    await act(async () => { root = createRoot(container); root.render(<Harness />); });
    assert.ok(run, 'harness never rendered — the hook was not called');
    await act(async () => { await run!(); });
    return drawing;
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    container.remove();
  }
}

function entityIds(drawing: Drawing2D | null): Set<number> {
  const out = new Set<number>();
  for (const line of drawing?.lines ?? []) out.add(line.entityId);
  for (const poly of drawing?.cutPolygons ?? []) out.add(poly.entityId);
  return out;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('useDrawingGeneration type-library geometry (#2058)', () => {
  it('cuts the occurrence but not the instanced type template', async () => {
    const drawing = await generate(
      geometry(
        [
          box(OCCURRENCE_ID, 'IfcWall', 0, [0, 0, 0], [2, 3, 0.2]),
          box(TYPE_ID, 'IfcWallType', 2, [5, 0, 0], [7, 3, 0.2]),
        ],
        [7, 3, 0.2],
      ),
    );

    const ids = entityIds(drawing);
    // Negative case: the real building must still be drawn.
    assert.ok(
      ids.has(OCCURRENCE_ID),
      `occurrence geometry must still reach the 2D drawing; got ids ${[...ids]}`,
    );
    // The bug: the type template must not.
    assert.ok(
      !ids.has(TYPE_ID),
      `instanced type geometry must not reach the 2D drawing; got ids ${[...ids]}`,
    );
  });

  it('keeps orphan type geometry when the model has no occurrences at all', async () => {
    // A pure type-library file (buildingSMART annex-E) has nothing else to
    // draw — dropping class 1 unconditionally would blank the drawing, which
    // is exactly the trap `isMeshVisibleInViewMode` already encodes for 3D.
    const drawing = await generate(
      geometry([box(TYPE_ID, 'IfcBoilerType', 1, [0, 0, 0], [2, 3, 0.2])], [2, 3, 0.2]),
    );

    assert.ok(
      entityIds(drawing).has(TYPE_ID),
      'orphan type geometry must still be drawn for a model with no occurrences',
    );
  });

  it('drops orphan type geometry once the model has placed occurrences', async () => {
    const drawing = await generate(
      geometry(
        [
          box(OCCURRENCE_ID, 'IfcWall', 0, [0, 0, 0], [2, 3, 0.2]),
          box(TYPE_ID, 'IfcBoilerType', 1, [5, 0, 0], [7, 3, 0.2]),
        ],
        [7, 3, 0.2],
      ),
    );

    const ids = entityIds(drawing);
    assert.ok(ids.has(OCCURRENCE_ID), 'occurrence geometry must still be drawn');
    assert.ok(!ids.has(TYPE_ID), 'orphan type-library geometry must not be drawn alongside it');
  });
});
