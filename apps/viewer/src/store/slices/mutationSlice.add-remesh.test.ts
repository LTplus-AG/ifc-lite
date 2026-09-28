/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every add re-meshes the element it creates from its written IFC, and the
 * room receives that real geometry (#6232 PR1.4). A scripted mesher stands in
 * for the wasm worker (`@/test/scripted-mesher`).
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { installScriptedMesher, settleRemesh, triangleFor } from '@/test/scripted-mesher';

const MODEL = 'ifc';
const STOREY = 40;
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

let mesher: ReturnType<typeof installScriptedMesher>;
let mirrored: Array<[string, number, readonly MeshData[]]>;

async function seed(): Promise<void> {
  const bytes = new TextEncoder().encode(FIXTURE);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const geometry = {
    meshes: [], totalTriangles: 0, totalVertices: 0,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      hasLargeCoordinates: false,
      wasmRtcFrame: { x: 0, y: 0, z: 0, needsShift: false },
    },
  } as unknown as GeometryResult;
  mirrored = [];
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel(MODEL), ifcDataStore: dataStore, geometryResult: geometry } as unknown as FederatedModel),
    editEnabled: true,
    geometryResult: geometry,
    mutationViews: new Map([[MODEL, new MutablePropertyView(dataStore.properties || null, MODEL)]]),
    storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(),
    removedNewEntities: new Map(), removedMeshes: new Map(),
    pendingMeshRemovals: null, pendingMeshEdits: null, mutationVersion: 0,
    mirrorEntityGeometry: (modelId, entityId, meshes) => {
      mirrored.push([modelId, entityId, [...meshes]]);
    },
  });
}

const meshedIds = () => (useViewerStore.getState().models.get(MODEL)?.geometryResult?.meshes ?? []).map((m) => m.expressId);

describe('authored elements get re-meshed geometry (#6232)', () => {
  beforeEach(async () => { mesher = installScriptedMesher(); await seed(); });
  afterEach(() => mesher.restore());

  it('an add asks the mesher for the new element, swaps its mesh in, and mirrors it to the room', async () => {
    const wall = useViewerStore.getState().addWall(MODEL, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in wall);
    assert.deepEqual(meshedIds(), [], 'no parameter-built stand-in mesh any more');
    await settleRemesh();
    assert.deepEqual(mesher.requests.map((r) => [...r.targets]), [[wall.expressId]]);
    assert.match(new TextDecoder().decode(mesher.requests[0].buffer), new RegExp(`#${wall.expressId}=IFCWALL\\(`));
    assert.deepEqual(meshedIds(), [wall.expressId]);
    assert.deepEqual(mirrored.map(([m, id, meshes]) => [m, id, meshes.length]), [[MODEL, wall.expressId, 1]]);
  });

  it('redo of an add whose mesh never landed meshes it from the restored record', async () => {
    mesher.restore();
    const silent = installScriptedMesher(() => []);
    const wall = useViewerStore.getState().addWall(MODEL, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in wall);
    await settleRemesh();
    useViewerStore.getState().undo(MODEL);
    const before = silent.requests.length;
    useViewerStore.getState().redo(MODEL);
    await settleRemesh();
    assert.ok(silent.requests.slice(before).some((r) => [...r.targets].includes(wall.expressId)), 'redo re-meshed it');
    silent.restore();
  });

  it('that redo also hands the room the re-mesh, since the re-created entity arrived without geometry', async () => {
    mesher.restore();
    let answered = 0;
    const late = installScriptedMesher((request) => (answered++ === 0 ? [] : [...request.targets].map(triangleFor)));
    const wall = useViewerStore.getState().addWall(MODEL, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in wall);
    await settleRemesh();
    assert.equal(mirrored.length, 0, 'the first re-mesh produced nothing to send');
    useViewerStore.getState().undo(MODEL);
    useViewerStore.getState().redo(MODEL);
    await settleRemesh();
    assert.deepEqual(mirrored.map(([, id, meshes]) => [id, meshes.length]), [[wall.expressId, 1]]);
    late.restore();
  });

  it('redo of an add hands the room every mesh of the element, not just the first', async () => {
    mesher.restore();
    const layered = installScriptedMesher((request) => [...request.targets].flatMap((id) => [triangleFor(id), triangleFor(id)]));
    const wall = useViewerStore.getState().addWall(MODEL, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in wall);
    await settleRemesh();
    useViewerStore.getState().undo(MODEL);
    mirrored = [];
    useViewerStore.getState().redo(MODEL);
    await settleRemesh();
    assert.deepEqual(mirrored.map(([, id, meshes]) => [id, meshes.length]), [[wall.expressId, 2]]);
    layered.restore();
  });

  it('undo and redo of a wall resize send the room the re-meshed wall too', async () => {
    const wall = useViewerStore.getState().addWall(MODEL, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in wall);
    await settleRemesh();
    const resized = useViewerStore.getState().resizeWall(MODEL, wall.expressId, [0, 0, 0], [6, 0, 0]);
    assert.ok(resized.ok);
    await settleRemesh();
    const sent = () => mirrored.filter(([, id]) => id === wall.expressId).length;
    const afterResize = sent();
    useViewerStore.getState().undo(MODEL);
    await settleRemesh();
    assert.equal(sent(), afterResize + 1, 'the undone length reached the room');
    useViewerStore.getState().redo(MODEL);
    await settleRemesh();
    assert.equal(sent(), afterResize + 2, 'the redone length reached the room');
  });
});
