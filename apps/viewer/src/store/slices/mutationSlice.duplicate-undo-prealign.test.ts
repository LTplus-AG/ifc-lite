/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4970 follow-up: `duplicateEntity` and undo-of-`removeEntity` (the #4925
 * mesh stash) must not hand the pre-alignment snapshot the mesh's LIVE
 * bytes as its baseline when the model is federation-aligned —
 * `modelRotationBaker.inModelFrame` only reverses the placement-rotation
 * bake, never alignment, so those bytes are still in the aligned frame.
 *
 * These go through `duplicateEntity`/`removeEntity`/`undo` — pre-existing
 * store actions — rather than importing `data-mesh-prealign.ts` or
 * `mutation-duplicate-prealign.ts` directly, for the reason
 * `mutationSlice.duplicate-federated-bounds.test.ts` documents: the revert
 * oracle reverts this PR's production files, which deletes those new
 * modules, and a changed test file that cannot even load is
 * `REVERT_BROKE_BUILD` for the whole run. Entering through exports that
 * survive the revert keeps the witness an assertion.
 *
 * The fixture simulates "already aligned" directly: the model's live
 * `geometryResult` carries different bytes (`LIVE_POSITIONS`) than its
 * `preAlignment` snapshot (`PRISTINE_POSITIONS`) — exactly what a real
 * federation align produces, without needing to drive the align machinery
 * itself.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { modelRotationBaker } from '@/lib/model-placement/rotation-bake';

const MODEL = 'edited';
const WALL = 50;

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
#50=IFCWALL('3cUkl32yn9qRSPvBJVyWYp',$,'W',$,$,#51,$,$,.STANDARD.);
#51=IFCLOCALPLACEMENT(#41,#52);
#52=IFCAXIS2PLACEMENT3D(#53,$,$);
#53=IFCCARTESIANPOINT((2.,1.,0.));
#60=IFCRELCONTAINEDINSPATIALSTRUCTURE('1kTvXnbbzCWw8lcMd1dR4o',$,$,$,(#50),#40);
#70=IFCRELAGGREGATES('0kTvXnbbzCWw8lcMd1dR4o',$,$,$,#1,(#40));
ENDSEC;
END-ISO-10303-21;
`;

/** The mesh's CURRENT (already federation-aligned) bytes. */
const LIVE_POSITIONS = [0, 0, 0, 4, 0, 0, 4, 3, 0, 0, 3, 0];
/** What the SAME mesh looked like before that align — the value its
 *  `preAlignment` slot carries, and what any correctly-derived baseline for
 *  a duplicate or an undo-restore must trace back to. */
const PRISTINE_POSITIONS = [10, 10, 10, 14, 10, 10, 14, 13, 10, 10, 13, 10];
const PRISTINE_ORIGIN: [number, number, number] = [-100, -200, -300];

function wallMesh(expressId: number): MeshData {
  return {
    expressId,
    // Alignment folds any local origin into positions and zeroes it, so a
    // truly aligned live mesh carries none.
    positions: new Float32Array(LIVE_POSITIONS),
    normals: new Float32Array(12),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    color: [1, 1, 1, 1],
  } as MeshData;
}

function geometryOf(meshes: MeshData[]): GeometryResult {
  return {
    meshes,
    totalTriangles: 2 * meshes.length,
    totalVertices: 4 * meshes.length,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 3, z: 0 } },
      hasLargeCoordinates: false,
    },
  } as unknown as GeometryResult;
}

const PRISTINE_BOX = { min: [10, 10, 10] as [number, number, number], max: [14, 13, 10] as [number, number, number] };

function fakeAlignedSnapshot(): FederatedModel['preAlignment'] {
  return {
    positions: [new Float32Array(PRISTINE_POSITIONS)],
    normals: [new Float32Array(12)],
    origins: [PRISTINE_ORIGIN],
    geometryAabbs: [PRISTINE_BOX],
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 3, z: 0 } },
      hasLargeCoordinates: false,
    },
    instancedGeometryAabbs: undefined,
  };
}

async function seed(): Promise<FederatedModel> {
  modelRotationBaker.clear();
  const bytes = new TextEncoder().encode(FIXTURE);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, {
    disableWorkerScan: true,
  });

  const geometryResult = geometryOf([wallMesh(WALL)]);
  const model = {
    ...fixtureModel(MODEL, {}),
    ifcDataStore: dataStore,
    geometryResult,
    preAlignment: fakeAlignedSnapshot(),
    maxExpressId: 100,
  } as unknown as FederatedModel;

  useViewerStore.setState({
    ...fixtureModels(model),
    geometryResult,
    modelPlacement: emptyPlacementState(),
    mutationViews: new Map([
      [MODEL, new MutablePropertyView(dataStore.properties || null, MODEL)],
    ]),
    storeEditors: new Map(),
    undoStacks: new Map(),
    redoStacks: new Map(),
    removedMeshes: new Map(),
    geometryContentVersion: 0,
  });
  return model;
}

describe('duplicateEntity derives a correct preAlignment baseline on an aligned model (#4970)', () => {
  it('the clone\'s baseline is the source\'s PRISTINE geometry, not its live/aligned bytes', async () => {
    await seed();
    const result = useViewerStore.getState().duplicateEntity(MODEL, WALL, '+X');
    assert.ok(!('error' in result), `duplicate failed: ${'error' in result ? (result as { error: string }).error : ''}`);

    const model = useViewerStore.getState().models.get(MODEL)!;
    const meshes = model.geometryResult!.meshes;
    const cloneIndex = meshes.findIndex((m) => m.expressId === (result as { globalId: number }).globalId);
    assert.ok(cloneIndex >= 0, 'clone mesh missing');

    const snap = model.preAlignment!;
    assert.equal(snap.positions.length, meshes.length, 'snapshot must stay index-aligned after the append');

    // The naive guess growPreAlignment alone would have made is the clone's
    // own LIVE (aligned) bytes — assert we do NOT have that.
    assert.notDeepEqual(
      [...snap.positions[cloneIndex]],
      LIVE_POSITIONS,
      'fixture: the clone baseline must not equal live/aligned bytes — that IS the #4970 bug this pins',
    );
    assert.deepEqual(
      [...snap.positions[cloneIndex]],
      PRISTINE_POSITIONS,
      'the clone baseline must be the source\'s pristine geometry, verbatim',
    );

    // The baseline's world box must travel with the same offset as the
    // positions/origin — a box left at the source's location would point a
    // later restore's spatial index at the wrong place (review finding on
    // this same PR, CodeRabbit + Macroscope).
    const box = snap.geometryAabbs[cloneIndex];
    assert.ok(box, 'the clone must keep a world box, not lose it');
    const deltaX = box!.min[0] - PRISTINE_BOX.min[0];
    assert.notEqual(deltaX, 0, 'the box must move with the duplicate, not stay at the source');
    assert.deepEqual(
      [box!.max[0] - box!.min[0], box!.max[1] - box!.min[1], box!.max[2] - box!.min[2]],
      [PRISTINE_BOX.max[0] - PRISTINE_BOX.min[0], PRISTINE_BOX.max[1] - PRISTINE_BOX.min[1], PRISTINE_BOX.max[2] - PRISTINE_BOX.min[2]],
      'translating the box must preserve its size',
    );
  });
});

describe('undo of removeEntity restores the TRUE preAlignment baseline (#4970, #4925)', () => {
  it('restores the exact pristine slot captured at delete time, not a guess from the stashed live-frame bytes', async () => {
    await seed();
    assert.ok(useViewerStore.getState().removeEntity(MODEL, WALL), 'removeEntity must succeed');

    const afterDelete = useViewerStore.getState().models.get(MODEL)!;
    assert.equal(afterDelete.geometryResult!.meshes.length, 0, 'mesh must be pruned');
    assert.equal(afterDelete.preAlignment!.positions.length, 0, 'its preAlignment slot must be pruned too');

    useViewerStore.getState().undo(MODEL);

    const restored = useViewerStore.getState().models.get(MODEL)!;
    assert.equal(restored.geometryResult!.meshes.length, 1, 'mesh must be restored');
    const snap = restored.preAlignment!;
    assert.equal(snap.positions.length, 1, 'snapshot must be index-aligned again after the restore');
    assert.notDeepEqual(
      [...snap.positions[0]],
      LIVE_POSITIONS,
      'fixture: the restored baseline must not equal the stashed live/aligned bytes — that IS the #4970 bug this pins',
    );
    assert.deepEqual(
      [...snap.positions[0]],
      PRISTINE_POSITIONS,
      'the restored baseline must be the TRUE original captured before deletion',
    );
    assert.deepEqual(snap.origins[0], PRISTINE_ORIGIN);
  });
});
