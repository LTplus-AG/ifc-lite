/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6232 D4: builder-driven edits land in the active change set. `addWall`
 * enters history through `recordAuthoredElementIn`, `addHostedFill` (and the
 * other `recordModellingEdit` writers, e.g. curtain walls and grids) through
 * `recordMutationBatch`; both file into the active set, undo takes them out
 * and redo puts them back.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { installScriptedMesher, settleRemesh } from '@/test/scripted-mesher';

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
    changeSets: new Map(), activeChangeSetId: null,
    storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(),
    removedNewEntities: new Map(), removedMeshes: new Map(),
    pendingMeshRemovals: null, pendingMeshEdits: null, mutationVersion: 0,
    mirrorEntityGeometry: (modelId, entityId, meshes) => {
      mirrored.push([modelId, entityId, [...meshes]]);
    },
  });
}


const state = () => useViewerStore.getState();
const inSet = (id: string) => state().changeSets.get(id)?.mutations ?? [];
const historyIds = () => (state().undoStacks.get(MODEL) ?? []).map((m) => m.id);

describe('builder-driven edits land in the active change set (#6232 D4)', () => {
  beforeEach(async () => { mesher = installScriptedMesher(); await seed(); });
  afterEach(() => mesher.restore());

  it('a builder add, a hosted door and a hosted window are filed in order in the active set; undo and redo move them', async () => {
    const set = state().createChangeSet('Walls and openings');
    const wall = state().addWall(MODEL, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in wall);
    const door = state().addHostedFill(MODEL, wall.expressId, { kind: 'door', params: { Offset: 1, Width: 0.9, Height: 2.1 } });
    assert.ok('expressId' in door, 'error' in door ? door.error : '');
    const window = state().addHostedFill(MODEL, wall.expressId, { kind: 'window', params: { Offset: 2.5, Sill: 0.9, Width: 1.2, Height: 1.5 } });
    assert.ok('expressId' in window, 'error' in window ? window.error : '');
    await settleRemesh();

    assert.ok(historyIds().length >= 3, 'each edit has history');
    assert.deepEqual(inSet(set).map((m) => m.id), historyIds(), 'the set holds exactly what history holds');
    assert.ok(inSet(set).some((m) => m.entityId === wall.expressId && m.type === 'CREATE_ENTITY'));
    assert.ok(inSet(set).some((m) => m.entityId === door.expressId && m.type === 'CREATE_ENTITY'));

    const all = inSet(set).map((m) => m.id);
    state().undo(MODEL);
    const afterUndo = inSet(set).map((m) => m.id);
    assert.ok(afterUndo.length < all.length, 'undoing the window takes it out of the set');
    assert.deepEqual(afterUndo, historyIds());
    state().redo(MODEL);
    assert.deepEqual(inSet(set).map((m) => m.id), all, 'redo puts it back in order');
  });

  it('with no active set the first builder add starts "Unsaved changes"', () => {
    const wall = state().addWall(MODEL, STOREY, { Start: [0, 0, 0], End: [3, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in wall);
    const [only] = [...state().changeSets.values()];
    assert.equal(only.name, 'Unsaved changes');
    assert.deepEqual(only.mutations.map((m) => m.entityId), [wall.expressId]);
    assert.equal(state().activeChangeSetId, only.id);
  });
});
