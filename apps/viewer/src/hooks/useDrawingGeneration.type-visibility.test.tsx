/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Class-level visibility must reach the section, not just the 3D mesh set (#2060).
 *
 * The Visibility toggles (Spaces, Openings, Site, Virtual Elements, Spatial
 * Zones, Annotations) are applied by `ViewportContainer` to the mesh list it
 * hands the renderer. The 2D drawing derives its OWN mesh list from
 * `geometryResult.meshes` and filtered only hiding/isolation, so a hidden
 * `IfcSpace` / `IfcOpeningElement` was still cut: its fill and outline showed
 * in the 2D Section view, and — because the 3D section overlay uploads
 * `drawing.cutPolygons` / `drawing.lines` verbatim (`useRenderUpdates.ts`) —
 * in the 3D view too. On AC20-FZK-Haus a mid-height plan cut put 6 IfcSpace
 * and 14 IfcOpeningElement entities into the drawing with both toggles at
 * their shipped default of `false`.
 *
 * These render the real hook (no mocked generator): one box per class
 * straddling a plan cut, asserted on the entity ids that come back. Cut
 * polygons are asserted SEPARATELY from lines — the polygons are what the 3D
 * overlay fills, the lines are what both views outline, and the two disagreed
 * in #2058.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { TypeVisibilityGate } from '@/store/typeVisibilityFilter';
import { useDrawingGeneration } from './useDrawingGeneration.js';

// ─── Fixture ─────────────────────────────────────────────────────────────

/** Axis-aligned box in render space (Y-up), 12 triangles. The CPU cutter and
 *  edge extractor only read positions/indices, so normals stay zeroed. */
function box(
  expressId: number,
  ifcType: string,
  x0: number,
  x1: number,
): MeshData {
  const [y0, z0, y1, z1] = [0, 0, 3, 0.2];
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
    geometryClass: 0,
  };
}

/** One occurrence per gated class plus two ordinary building elements. */
const IDS = {
  wall: 100,
  door: 101,
  space: 200,
  opening: 201,
  site: 202,
  virtual: 203,
  zone: 204,
} as const;

const MESHES: MeshData[] = [
  box(IDS.wall,    'IfcWall',             0,  2),
  box(IDS.door,    'IfcDoor',             3,  5),
  box(IDS.space,   'IfcSpace',            6,  8),
  box(IDS.opening, 'IfcOpeningElement',   9, 11),
  box(IDS.site,    'IfcSite',            12, 14),
  box(IDS.virtual, 'IfcVirtualElement',  15, 17),
  box(IDS.zone,    'IfcSpatialZone',     18, 20),
];

const GEOMETRY: GeometryResult = {
  meshes: MESHES,
  totalTriangles: MESHES.length * 12,
  totalVertices: MESHES.length * 8,
  coordinateInfo: {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 3, z: 0.2 } },
    shiftedBounds:  { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 3, z: 0.2 } },
    hasLargeCoordinates: false,
  },
};

const ALL_VISIBLE: TypeVisibilityGate = {
  spaces: true, spatialZones: true, openings: true,
  virtualElements: true, site: true, ifcAnnotations: true,
};

const ALL_HIDDEN: TypeVisibilityGate = {
  spaces: false, spatialZones: false, openings: false,
  virtualElements: false, site: false, ifcAnnotations: false,
};

interface HarnessProps {
  typeVisibility: TypeVisibilityGate;
  /** Panel open → the hook's own auto-generate effect drives generation. */
  panelVisible: boolean;
  drawing: Drawing2D | null;
  setDrawing: (d: Drawing2D | null) => void;
  onRun: (run: () => Promise<void>) => void;
}

function Harness({ typeVisibility, panelVisible, drawing, setDrawing, onRun }: HarnessProps): null {
  const { generateDrawing } = useDrawingGeneration({
    geometryResult: GEOMETRY,
    ifcDataStore: null,
    sectionPlane: { axis: 'down', position: 50, flipped: false },
    displayOptions: {
      showHiddenLines: false,
      useSymbolicRepresentations: false,
      show3DOverlay: false,
      scale: 50,
      showConstructionProjection: false,
    },
    typeVisibility,
    combinedHiddenIds: new Set<number>(),
    combinedIsolatedIds: null,
    computedIsolatedIds: null,
    models: new Map([['m0', { id: 'm0', visible: true }]]),
    panelVisible,
    drawing,
    setDrawing,
    setDrawingStatus: () => {},
    setDrawingProgress: () => {},
    setDrawingError: () => {},
  });
  onRun(generateDrawing);
  return null;
}

/** Drive the real hook once and return the drawing it publishes. */
async function generate(typeVisibility: TypeVisibilityGate): Promise<Drawing2D | null> {
  let drawing: Drawing2D | null = null;
  let run: (() => Promise<void>) | null = null;

  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(container);
      // Panel closed: the auto-generate effects stay out of the way so the
      // drawing under test is the one this harness asks for, not a race.
      root.render(
        <Harness
          typeVisibility={typeVisibility}
          panelVisible={false}
          drawing={null}
          setDrawing={(d) => { drawing = d; }}
          onRun={(r) => { run = r; }}
        />,
      );
    });
    assert.ok(run, 'harness never rendered — the hook was not called');
    await act(async () => { await run!(); });
    return drawing;
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    container.remove();
  }
}

/** Entity ids of the 2D outlines — what both the 2D view and the 3D overlay draw. */
function lineIds(drawing: Drawing2D | null): Set<number> {
  return new Set((drawing?.lines ?? []).map((l) => l.entityId));
}

/** Entity ids of the cut fills — what the 3D section overlay triangulates. */
function polygonIds(drawing: Drawing2D | null): Set<number> {
  return new Set((drawing?.cutPolygons ?? []).map((p) => p.entityId));
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('useDrawingGeneration class visibility (#2060)', () => {
  it('drops every hidden class from the cut fills the 3D overlay renders', async () => {
    const ids = polygonIds(await generate(ALL_HIDDEN));

    // Negative case: the real building must still be cut.
    assert.ok(ids.has(IDS.wall), `wall must still be cut; got ${[...ids]}`);
    assert.ok(ids.has(IDS.door), `door must still be cut; got ${[...ids]}`);

    for (const [name, id] of [
      ['IfcSpace', IDS.space], ['IfcOpeningElement', IDS.opening],
      ['IfcSite', IDS.site], ['IfcVirtualElement', IDS.virtual],
      ['IfcSpatialZone', IDS.zone],
    ] as const) {
      assert.ok(!ids.has(id), `hidden ${name} must not produce a cut fill; got ${[...ids]}`);
    }
  });

  it('drops every hidden class from the 2D outlines', async () => {
    const ids = lineIds(await generate(ALL_HIDDEN));

    assert.ok(ids.has(IDS.wall), `wall must still be outlined; got ${[...ids]}`);
    assert.ok(ids.has(IDS.door), `door must still be outlined; got ${[...ids]}`);

    for (const [name, id] of [
      ['IfcSpace', IDS.space], ['IfcOpeningElement', IDS.opening],
      ['IfcSite', IDS.site], ['IfcVirtualElement', IDS.virtual],
      ['IfcSpatialZone', IDS.zone],
    ] as const) {
      assert.ok(!ids.has(id), `hidden ${name} must not be outlined; got ${[...ids]}`);
    }
  });

  it('keeps those same classes in the section when their toggles are ON', async () => {
    // This is a visibility filter, not a blanket exclusion: a user who turns
    // Spaces on expects room fills in the plan.
    const drawing = await generate(ALL_VISIBLE);
    const polys = polygonIds(drawing);
    const lines = lineIds(drawing);

    for (const [name, id] of Object.entries(IDS)) {
      assert.ok(polys.has(id), `${name} must be cut when its class is visible; got ${[...polys]}`);
      assert.ok(lines.has(id), `${name} must be outlined when its class is visible; got ${[...lines]}`);
    }
  });

  it('regenerates the open section when a class toggle flips', async () => {
    // Flipping a toggle changes the drawing's input without changing the mesh
    // count, so the hook's `geometryChanged` trigger never fires for it. Without
    // its own trigger the fix would only take effect on the next manual
    // Regenerate — invisible to the user who just unticked Spaces.
    let drawing: Drawing2D | null = null;
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | null = null;
    try {
      const render = async (typeVisibility: TypeVisibilityGate) => {
        await act(async () => {
          root!.render(
            <Harness
              typeVisibility={typeVisibility}
              panelVisible
              drawing={drawing}
              setDrawing={(d) => { drawing = d; }}
              onRun={() => {}}
            />,
          );
        });
      };

      await act(async () => { root = createRoot(container); });
      await render(ALL_VISIBLE);
      assert.ok(polygonIds(drawing).has(IDS.space), 'panel-open generation should cut the visible space');

      await render(ALL_HIDDEN);
      const polys = polygonIds(drawing);
      assert.ok(polys.has(IDS.wall), `wall must survive the regeneration; got ${[...polys]}`);
      assert.ok(!polys.has(IDS.space), `space must be gone after its toggle flips; got ${[...polys]}`);
    } finally {
      if (root) await act(async () => { root!.unmount(); });
      container.remove();
    }
  });
});
