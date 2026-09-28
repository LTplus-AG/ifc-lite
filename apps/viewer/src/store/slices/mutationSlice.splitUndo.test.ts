/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Undoing a wall split must remove both halves AND restore the source
 * (#4925).
 *
 * Before this fix, split routed the source's removal through `removeEntity`
 * (a DELETE_ENTITY mutation) plus two CREATE_ENTITY mutations for the
 * halves, but only the IFC overlay side of that was reversible: undoing the
 * DELETE_ENTITY just flipped `hiddenEntities` visibility, which does
 * nothing once the source's mesh has actually been pruned out of
 * `geometryResult` (which a split's own `setPendingMeshRemovals` call did),
 * and undoing a CREATE_ENTITY never touched the created mesh at all — so
 * undo left both halves rendered AND failed to bring the source back.
 *
 * Since #6233 a split keeps the longer piece as the source, reshaped in
 * place, adds one new wall, and is ONE undo step. This test builds a wall
 * through the in-store `addWall` builder, splits it, then undoes and redoes
 * it, asserting after each step that `totalTriangles` still equals the sum
 * of `indices.length / 3` over `geometryResult.meshes` — the invariant the
 * issue names — plus which express ids have a mesh.
 *
 * There is no mounted renderer in this headless harness, so "removed from
 * the scene" is checked the same way `dataSlice.test.ts`'s own prune tests
 * do: absence from `geometryResult.meshes` (what `useGeometryStreaming`'s
 * drain keeps in sync with the GPU scene) plus presence in the queued
 * `pendingMeshRemovals` renderer-removal signal.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult } from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';

const MODEL_ID = 'ifc';
const STOREY = 40;

/** Project + geometric context + one storey — no wall; `addWall` authors it. */
const FIXTURE = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,(#20),#30);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40=IFCBUILDINGSTOREY('2hQBAVPOr5VxhS3Jl0O47h',$,'L0',$,$,#41,$,$,.ELEMENT.,0.);
#41=IFCLOCALPLACEMENT($,#21);
#70=IFCRELAGGREGATES('0kTvXnbbzCWw8lcMd1dR4o',$,$,$,#1,(#40));
ENDSEC;
END-ISO-10303-21;
`;

function emptyGeometry(): GeometryResult {
  return {
    meshes: [],
    totalTriangles: 0,
    totalVertices: 0,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      hasLargeCoordinates: false,
    },
  } as unknown as GeometryResult;
}

async function seed(): Promise<void> {
  const bytes = new TextEncoder().encode(FIXTURE);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const geometry = emptyGeometry();
  const model = { ...fixtureModel(MODEL_ID), ifcDataStore: dataStore, geometryResult: geometry } as unknown as FederatedModel;
  useViewerStore.setState({
    ...fixtureModels(model),
    editEnabled: true,
    geometryResult: geometry,
    mutationViews: new Map([[MODEL_ID, new MutablePropertyView(dataStore.properties || null, MODEL_ID)]]),
    storeEditors: new Map(),
    undoStacks: new Map(),
    redoStacks: new Map(),
    removedNewEntities: new Map(),
    removedMeshes: new Map(),
    pendingMeshRemovals: null,
    geometryContentVersion: 0,
    mutationVersion: 0,
  });
}

function model(): FederatedModel {
  return useViewerStore.getState().models.get(MODEL_ID) as FederatedModel;
}

/** Express ids that currently have at least one mesh, sorted. */
function meshedIds(): number[] {
  return [...new Set((model().geometryResult?.meshes ?? []).map((m) => m.expressId))].sort((a, b) => a - b);
}

/** The issue's own invariant: totals must equal what the mesh array actually holds. */
function assertTriangleInvariant(what: string): void {
  const geometry = model().geometryResult;
  assert.ok(geometry, `${what}: model has no geometryResult`);
  const sum = geometry!.meshes.reduce((total, m) => total + m.indices.length / 3, 0);
  assert.equal(geometry!.totalTriangles, sum, `${what}: totalTriangles must equal sum(indices.length/3) over geometryResult.meshes`);
}

describe('undoing a wall split (#4925)', () => {
  beforeEach(seed);

  it('one undo restores the source mesh and removes the new piece; redo reverses it', () => {
    const s = useViewerStore.getState();
    const wall = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.25, Height: 2.8 });
    assert.ok('expressId' in wall, `addWall failed: ${'error' in wall ? wall.error : ''}`);
    const sourceId = wall.expressId;
    assertTriangleInvariant('after addWall');
    assert.deepEqual(meshedIds(), [sourceId], 'only the source has a mesh before splitting');
    const sourceTriangles = model().geometryResult!.totalTriangles;

    // Split identity policy (#6233): the longer piece stays the source,
    // reshaped in place; one new wall takes the other piece. The source's
    // mesh swap lands once the renderer drains its queued removal.
    const split = useViewerStore.getState().splitWallAtDistance(MODEL_ID, sourceId, 2);
    assert.ok(split.ok, `split failed: ${split.ok ? '' : split.reason}`);
    if (!split.ok) return;
    useViewerStore.getState().clearPendingMeshRemovals();
    assert.equal(split.right.expressId, sourceId, 'the 3 m far piece is the source');
    const newId = split.left.expressId;
    assertTriangleInvariant('after split');
    assert.deepEqual(meshedIds(), [sourceId, newId].sort((a, b) => a - b), 'split: source reshaped, new piece added');

    // --- ONE undo reverts the whole split. ---
    useViewerStore.getState().undo(MODEL_ID);
    useViewerStore.getState().clearPendingMeshRemovals();
    assertTriangleInvariant('after undo');
    assert.deepEqual(meshedIds(), [sourceId], 'undo: new piece gone, only the source mesh remains');
    assert.equal(model().geometryResult!.totalTriangles, sourceTriangles,
      'undone split restores the exact pre-split triangle total');
    // The source wall's own CREATE_ENTITY from `addWall` is still undoable.
    assert.equal(useViewerStore.getState().canUndo(MODEL_ID), true);

    // --- ONE redo re-applies it. ---
    useViewerStore.getState().redo(MODEL_ID);
    useViewerStore.getState().clearPendingMeshRemovals();
    assertTriangleInvariant('after redo');
    assert.deepEqual(meshedIds(), [sourceId, newId].sort((a, b) => a - b), 'redo: back to the split state');
    assert.equal(useViewerStore.getState().canRedo(MODEL_ID), false, 'redo stack drained');
  });
});
