/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The caps of the cutting planes beyond the active one (#7545), through the real
 * hook, store and cutter: a wall box cut by a plane that is NOT active must end
 * up as polygons in `sectionExtraCaps`, follow its plane, and respect what is
 * hidden, exactly like the active plane's drawing.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { useExtraSectionCaps } from './useExtraSectionCaps.js';

const state = () => useViewerStore.getState();

/** A 2 x 3 x 0.2 wall (render space, Y up), 12 triangles. */
function wall(expressId: number, z0 = 0): MeshData {
  const [x1, y1, z1] = [2, 3, z0 + 0.2];
  const positions = new Float32Array([
    0, 0, z0,  x1, 0, z0,  x1, y1, z0,  0, y1, z0,
    0, 0, z1,  x1, 0, z1,  x1, y1, z1,  0, y1, z1,
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2]);
  return { expressId, ifcType: 'IfcWall', modelIndex: 0, positions, normals: new Float32Array(positions.length), indices, color: [0.5, 0.5, 0.5, 1], geometryClass: 0 };
}

const WALL = 100;
const GEOMETRY: GeometryResult = {
  meshes: [wall(WALL)],
  totalTriangles: 12,
  totalVertices: 8,
  coordinateInfo: {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 3, z: 0.2 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 3, z: 0.2 } },
    hasLargeCoordinates: false,
  },
};

/** Two walls a metre apart in z, so a front plane's position decides WHICH one it cuts. */
const SECOND = 101;
const TWO_WALLS: GeometryResult = {
  ...GEOMETRY,
  meshes: [wall(WALL), wall(SECOND, 1)],
  coordinateInfo: {
    ...GEOMETRY.coordinateInfo,
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 3, z: 1.2 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 3, z: 1.2 } },
  },
};

let root: Root | null = null;
let container: HTMLElement | null = null;

function Harness({ geometry }: { geometry: GeometryResult }): null {
  useExtraSectionCaps(geometry, null);
  return null;
}

async function mount(geometry: GeometryResult = GEOMETRY) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<Harness geometry={geometry} />); });
}

/** Wait for the queued cuts to land. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

/** A plan cut A (active) and a front cut B through the wall, B inactive. */
function twoPlanes(): string {
  state().setActiveTool('section');
  state().addSectionPlane('down');
  state().setSectionPlanePosition(50);
  const b = state().addSectionPlane('front');
  assert.ok(b);
  state().setSectionPlanePosition(5); // inside the first wall, whichever fixture
  state().activateSectionPlane(state().inactiveSectionPlanes[0].id);
  assert.equal(state().inactiveSectionPlanes[0].id, b);
  return b;
}

beforeEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  container?.remove();
  state().resetViewerState();
});

describe('caps of the inactive cutting planes (#7545)', () => {
  it('cuts the wall for a plane that is not the active one', async () => {
    const b = twoPlanes();
    await mount();
    await settle();

    const cap = state().sectionExtraCaps[b];
    assert.ok(cap, 'the inactive plane got a cap');
    assert.ok(cap.cutPolygons.length > 0, 'the wall is cut by the plane');
    assert.ok(cap.cutPolygons.every((p) => p.entityId === WALL));
  });

  it('cuts nothing while the Section tool is closed, and keeps no stale caps', async () => {
    const b = twoPlanes();
    await mount();
    await settle();
    assert.ok(state().sectionExtraCaps[b]);

    await act(async () => { state().setActiveTool('select'); });
    await settle();
    assert.deepEqual(state().sectionExtraCaps, {}, 'caps are dropped with the tool');
  });

  it('a plane whose Cut is off has no cap', async () => {
    const b = twoPlanes();
    state().setSectionPlaneCutting(b, false);
    await mount();
    await settle();
    assert.equal(state().sectionExtraCaps[b], undefined);
  });

  it('re-cuts when the plane moves, and drops the cap when the plane is removed', async () => {
    const b = twoPlanes();
    await mount(TWO_WALLS);
    await settle();
    const ids = () => new Set(state().sectionExtraCaps[b].cutPolygons.map((p) => p.entityId));
    const first = state().sectionExtraCaps[b].signature;
    assert.deepEqual([...ids()], [WALL], 'the plane starts in the first wall');

    // Move B to the second wall (z = 1.14).
    await act(async () => { state().activateSectionPlane(b); state().setSectionPlanePosition(95); state().activateSectionPlane(state().inactiveSectionPlanes[0].id); });
    await settle();
    assert.notEqual(state().sectionExtraCaps[b].signature, first, 'the cap was cut again for the new position');
    assert.deepEqual([...ids()], [SECOND], 'the cap follows the plane to the other wall');

    await act(async () => { state().removeSectionPlane(b); });
    await settle();
    assert.equal(state().sectionExtraCaps[b], undefined);
  });

  it('does not cut what is hidden', async () => {
    const b = twoPlanes();
    state().hideEntity(WALL);
    await mount();
    await settle();
    assert.equal(state().sectionExtraCaps[b]?.cutPolygons.length ?? 0, 0, 'a hidden wall is not capped');

    await act(async () => { state().showAll(); });
    await settle();
    assert.ok((state().sectionExtraCaps[b]?.cutPolygons.length ?? 0) > 0, 'showing it again caps it');
  });
});
