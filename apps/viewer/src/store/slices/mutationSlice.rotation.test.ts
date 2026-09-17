/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Authoring on a rotated model must not compound the heading (#4869).
 *
 * The rotation baker treats every mesh it has never seen as pristine — in the
 * model's own unrotated frame — and turns it once. That is right for a streamed
 * batch and for an element built from its IFC parameters (add-element, and the
 * wall / slab split, which rebuild their halves through `addWall` / `addSlab`).
 * It is wrong for a mesh DERIVED from the live, already-baked vertices, which is
 * what duplicating an element did: the copy arrived turned and was turned again.
 *
 * The property pinned here is order independence: duplicating and then rotating
 * must land every vertex where rotating and then duplicating does.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { degreesToRadians } from '@/lib/model-placement/rotation';
import { modelRotationBaker } from '@/lib/model-placement/rotation-bake';
import { reconcileModelRotations } from '@/components/viewer/useModelRotationSync';

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

/** 30° about an off-origin pivot, on an asymmetric wall: no term cancels. */
const HEADING = { angle: degreesToRadians(30), pivot: [7, -3, 0] as [number, number, number] };

function geometryResult(): GeometryResult {
  return {
    meshes: [{ expressId: WALL, positions: new Float32Array([0, 0, 0, 4, 0, 0, 4, 3, 0, 0, 3, 0.2]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      color: [1, 1, 1, 1], origin: [2, 0, -1] } as MeshData],
    totalTriangles: 2,
    totalVertices: 4,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 2, y: 0, z: -1 }, max: { x: 6, y: 3, z: -0.8 } },
      hasLargeCoordinates: false },
  } as unknown as GeometryResult;
}

async function seed(): Promise<void> {
  modelRotationBaker.clear();
  const bytes = new TextEncoder().encode(FIXTURE);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const geometry = geometryResult();
  const model = { ...fixtureModel('ifc'), ifcDataStore: dataStore, geometryResult: geometry } as unknown as FederatedModel;
  useViewerStore.setState({
    ...fixtureModels(model),
    geometryResult: geometry,
    modelPlacement: emptyPlacementState(),
    mutationViews: new Map([['ifc', new MutablePropertyView(dataStore.properties || null, 'ifc')]]),
    storeEditors: new Map(),
    undoStacks: new Map(),
    redoStacks: new Map(),
    geometryContentVersion: 0,
  });
}

function rotate(): void {
  useViewerStore.getState().setModelRotation(['ifc'], { angle: HEADING.angle, pivot: [...HEADING.pivot] });
  reconcileModelRotations(useViewerStore.getState());
}

function duplicate(): number {
  const result = useViewerStore.getState().duplicateEntity('ifc', WALL, '+X');
  assert.ok(!('error' in result), `duplicate failed: ${'error' in result ? result.error : ''}`);
  // What the store subscription does on the append.
  reconcileModelRotations(useViewerStore.getState());
  return result.globalId;
}

/** World-space vertices of every mesh carrying `expressId`. */
function world(expressId: number): number[] {
  const meshes = (useViewerStore.getState().models.get('ifc') as FederatedModel).geometryResult!.meshes;
  const out: number[] = [];
  for (const mesh of meshes.filter((m) => m.expressId === expressId)) {
    const [ox, oy, oz] = mesh.origin ?? [0, 0, 0];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      out.push(mesh.positions[i] + ox, mesh.positions[i + 1] + oy, mesh.positions[i + 2] + oz);
    }
    for (const n of mesh.normals ?? []) out.push(n);
  }
  return out;
}

function assertClose(actual: number[], expected: number[], what: string): void {
  assert.equal(actual.length, expected.length, `${what}: vertex count`);
  assert.ok(actual.length > 0, `${what}: no geometry`);
  for (let i = 0; i < actual.length; i += 1) {
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-4, `${what}, component ${i}: ${actual[i]} vs ${expected[i]}`);
  }
}

describe('duplicating an element on a rotated model (#4869)', () => {
  beforeEach(seed);

  it('lands the copy where duplicating before the rotation does, instead of turning it twice', async () => {
    duplicate();
    rotate();
    const expectedSource = world(WALL);
    const copyId = (useViewerStore.getState().models.get('ifc') as FederatedModel).geometryResult!.meshes
      .find((m) => m.expressId !== WALL)!.expressId;
    const expectedCopy = world(copyId);

    await seed();
    rotate();
    const copy = duplicate();
    assert.equal(copy, copyId);
    assertClose(world(WALL), expectedSource, 'source');
    assertClose(world(copy), expectedCopy, 'duplicate');
  });

  it('restores the copy to its unrotated place when the heading returns to zero', async () => {
    const copyId = duplicate();
    const unrotated = world(copyId);

    await seed();
    rotate();
    duplicate();
    useViewerStore.getState().setModelRotation(['ifc'], { angle: 0, pivot: [...HEADING.pivot] });
    reconcileModelRotations(useViewerStore.getState());
    assertClose(world(copyId), unrotated, 'duplicate after reset');
  });
});

/** Every mesh of the model, in array order, as world-space vertices. */
function allWorld(): number[][] {
  const meshes = (useViewerStore.getState().models.get('ifc') as FederatedModel).geometryResult!.meshes;
  return [...new Set(meshes.map((m) => m.expressId))].map((id) => world(id));
}

/** Run `edit` once before and once after the heading, and require the same
 * geometry either way. */
async function assertOrderIndependent(edit: () => void, what: string): Promise<void> {
  await seed();
  edit();
  rotate();
  const expected = allWorld();
  // The fixture wall, the element under edit, and at least one new mesh.
  assert.ok(expected.length >= 3, `${what}: the edit produced no new mesh`);
  await seed();
  rotate();
  edit();
  const actual = allWorld();
  assert.equal(actual.length, expected.length, `${what}: mesh count`);
  actual.forEach((mesh, i) => assertClose(mesh, expected[i], `${what}, mesh ${i}`));
}

// The wall and slab split rebuild their halves from IFC parameters through
// `addWall` / `addSlab`, so the halves arrive pristine and the baker turns them
// once. Pinned so a split that starts deriving its halves from live vertices
// (as duplicate did) cannot compound the heading unnoticed.
describe('splitting an element on a rotated model (#4869)', () => {
  it('builds the wall halves in the model frame, turned once', async () => {
    await assertOrderIndependent(() => {
      const s = useViewerStore.getState();
      const wall = s.addWall('ifc', 40, { Start: [1, 2, 0], End: [6, 4, 0], Thickness: 0.25, Height: 2.8 });
      assert.ok('expressId' in wall, `addWall failed: ${'error' in wall ? wall.error : ''}`);
      reconcileModelRotations(useViewerStore.getState());
      const split = useViewerStore.getState().splitWallAtDistance('ifc', wall.expressId, 2);
      assert.ok(split.ok, `split failed: ${split.ok ? '' : split.reason}`);
      reconcileModelRotations(useViewerStore.getState());
    }, 'wall split');
  });

  it('builds the slab halves in the model frame, turned once', async () => {
    await assertOrderIndependent(() => {
      const s = useViewerStore.getState();
      const slab = s.addSlab('ifc', 40, { Profile: 'polygon', Position: [0, 0, 0],
        OuterCurve: [[1, 1], [7, 1], [7, 5], [1, 4]], Thickness: 0.3 } as Parameters<typeof s.addSlab>[2]);
      assert.ok('expressId' in slab, `addSlab failed: ${'error' in slab ? slab.error : ''}`);
      reconcileModelRotations(useViewerStore.getState());
      const split = useViewerStore.getState().splitSlabByLine('ifc', slab.expressId, [4, 0], [4.5, 6]);
      assert.ok(split.ok, `split failed: ${split.ok ? '' : split.reason}`);
      reconcileModelRotations(useViewerStore.getState());
    }, 'slab split');
  });
});
