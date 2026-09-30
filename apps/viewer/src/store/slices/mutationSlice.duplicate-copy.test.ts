/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, type NewEntity } from '@ifc-lite/mutations';
import type { MeshData, GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore, resolveEntityRef } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { modelRotationBaker } from '@/lib/model-placement/rotation-bake';

const STEP = `ISO-10303-21;
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
#41=IFCLOCALPLACEMENT($,#42);
#42=IFCAXIS2PLACEMENT3D(#43,$,$);
#43=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCSITE('3wdauVJT5Fx9drrREiDq10',$,'S',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#60=IFCBUILDING('3wdauVJT5Fx9drrREiDq11',$,'B',$,$,$,$,$,.ELEMENT.,$,$,$);
#61=IFCRELAGGREGATES('3wdauVJT5Fx9drrREiDq12',$,$,$,#1,(#50));
#62=IFCRELAGGREGATES('3wdauVJT5Fx9drrREiDq13',$,$,$,#50,(#60));
#63=IFCRELAGGREGATES('3wdauVJT5Fx9drrREiDq14',$,$,$,#60,(#40));
#90=IFCDIRECTION((0.,1.,0.));
#100=IFCELEMENTASSEMBLY('3wdauVJT5Fx9drrREiDq01',$,'Assembly',$,$,#101,$,$,$,$);
#101=IFCLOCALPLACEMENT(#41,#102);
#102=IFCAXIS2PLACEMENT3D(#103,$,$);
#103=IFCCARTESIANPOINT((2.,3.,0.));
#110=IFCBEAM('3wdauVJT5Fx9drrREiDq02',$,'Part A',$,$,#111,$,$,$);
#111=IFCLOCALPLACEMENT(#101,#112);
#112=IFCAXIS2PLACEMENT3D(#113,$,$);
#113=IFCCARTESIANPOINT((1.,0.,0.));
#115=IFCBEAM('3wdauVJT5Fx9drrREiDq03',$,'Part B',$,$,#116,$,$,$);
#116=IFCLOCALPLACEMENT(#101,#117);
#117=IFCAXIS2PLACEMENT3D(#118,$,$);
#118=IFCCARTESIANPOINT((0.,1.,0.));
#125=IFCBEAM('3wdauVJT5Fx9drrREiDq04',$,'Sub part',$,$,#126,$,$,$);
#126=IFCLOCALPLACEMENT(#116,#127);
#127=IFCAXIS2PLACEMENT3D(#128,$,$);
#128=IFCCARTESIANPOINT((0.,0.5,0.));
#120=IFCRELAGGREGATES('3wdauVJT5Fx9drrREiDq05',$,$,$,#100,(#110,#115));
#121=IFCRELAGGREGATES('3wdauVJT5Fx9drrREiDq06',$,$,$,#115,(#125));
#130=IFCRELCONTAINEDINSPATIALSTRUCTURE('3wdauVJT5Fx9drrREiDq07',$,$,$,(#100,#200,#300),#40);
#205=IFCLOCALPLACEMENT(#41,#206);
#206=IFCAXIS2PLACEMENT3D(#207,$,#90);
#207=IFCCARTESIANPOINT((0.,0.,0.));
#200=IFCBEAM('3wdauVJT5Fx9drrREiDq08',$,'Turned parent',$,$,#201,$,$,$);
#201=IFCLOCALPLACEMENT(#205,#202);
#202=IFCAXIS2PLACEMENT3D(#203,$,$);
#203=IFCCARTESIANPOINT((1.,0.,0.));
#305=IFCLOCALPLACEMENT($,#206);
#300=IFCBEAM('3wdauVJT5Fx9drrREiDq09',$,'Detached parent',$,$,#301,$,$,$);
#301=IFCLOCALPLACEMENT(#305,#202);

#400=IFCWALL('3wdauVJT5Fx9drrREiDq20',$,'Host',$,$,#401,$,$,.STANDARD.);
#401=IFCLOCALPLACEMENT(#41,#402);
#402=IFCAXIS2PLACEMENT3D(#403,$,$);
#403=IFCCARTESIANPOINT((0.,0.,0.));
#410=IFCOPENINGELEMENT('3wdauVJT5Fx9drrREiDq21',$,'Opening',$,$,#411,$,$,.OPENING.);
#411=IFCLOCALPLACEMENT(#401,#412);
#412=IFCAXIS2PLACEMENT3D(#413,$,$);
#413=IFCCARTESIANPOINT((1.,0.,0.));
#420=IFCDOOR('3wdauVJT5Fx9drrREiDq22',$,'Door',$,$,#421,$,$,2.,1.,.DOOR.,.NOTDEFINED.,$);
#421=IFCLOCALPLACEMENT(#411,#422);
#422=IFCAXIS2PLACEMENT3D(#423,$,$);
#423=IFCCARTESIANPOINT((0.,0.,0.));
#430=IFCRELVOIDSELEMENT('3wdauVJT5Fx9drrREiDq23',$,$,$,#400,#410);
#431=IFCRELFILLSELEMENT('3wdauVJT5Fx9drrREiDq24',$,$,$,#410,#420);
#432=IFCRELCONTAINEDINSPATIALSTRUCTURE('3wdauVJT5Fx9drrREiDq25',$,$,$,(#400,#420),#40);
ENDSEC;
END-ISO-10303-21;
`;

const MODEL = 'edited';
function mesh(id: number, x: number, width: number): MeshData {
  return {
    expressId: id, origin: [x, 0, 0],
    positions: new Float32Array([0, 0, 0, width, 0, 0, width, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1],
  } as MeshData;
}
async function seed(federated = false, brokenPart = false): Promise<number> {
  modelRotationBaker.clear();
  const bytes = new TextEncoder().encode(brokenPart ? STEP.replace('#126=IFCLOCALPLACEMENT(#116,#127);', '#126=IFCLOCALPLACEMENT(#305,#127);') : STEP);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const offset = federated ? 1000 : 0;
  const geometryResult = {
    meshes: [mesh(110 + offset, 3, 2), mesh(115 + offset, 2, 1), mesh(125 + offset, 2, 0.5), mesh(400 + offset, 0, 4), mesh(420 + offset, 1, 1)],
    totalTriangles: 5, totalVertices: 15,
  } as GeometryResult;
  const edited = { ...fixtureModel(MODEL, { idOffset: offset }), ifcDataStore: dataStore, geometryResult, maxExpressId: 500 };
  useViewerStore.setState({
    ...fixtureModels(...(federated ? [fixtureModel('active'), edited] : [edited])),
    geometryResult: federated ? null : geometryResult,
    editEnabled: true, modelPlacement: emptyPlacementState(),
    mutationViews: new Map([[MODEL, new MutablePropertyView(dataStore.properties ?? null, MODEL)]]),
    storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(),
    mutationBatchTags: new Map(), removedMeshes: new Map(), removedNewEntities: new Map(),
    changeSets: new Map(), activeChangeSetId: null,
  });
  return offset;
}
const records = () => useViewerStore.getState().mutationViews.get(MODEL)!.getNewEntities();
const reference = (value: unknown) => typeof value === 'string' && /^#\d+$/.test(value) ? Number(value.slice(1)) : null;
const attribute = (id: number, index: number) => records().find((e) => e.expressId === id)?.attributes[index];
const parent = (id: number) => reference(attribute(reference(attribute(id, 5))!, 0));
const byType = (type: string): NewEntity[] => records().filter((e) => e.type === type);
const duplicate = (id: number) => {
  const result = useViewerStore.getState().duplicateEntity(MODEL, id);
  if ('error' in result) assert.fail(result.error);
  return result;
};

describe('Duplicate shares the complete copy write (#6232 follow-up)', () => {
  for (const federated of [false, true]) {
    it(`copies a nested assembly, placement links, geometry and aliases with one undo, federation=${federated}`, async () => {
      const offset = await seed(federated);
      const result = duplicate(100);
      const assembly = records().find((e) => e.expressId === result.expressId)!;
      assert.equal(assembly.type, 'IfcElementAssembly');
      assert.equal(assembly.attributes[2], 'Assembly (copy)');
      const parts = byType('IfcBeam');
      assert.equal(parts.length, 3, 'all nested assembly parts must be copied');
      const partA = parts.find((p) => p.attributes[2] === 'Part A')!;
      const partB = parts.find((p) => p.attributes[2] === 'Part B')!;
      const sub = parts.find((p) => p.attributes[2] === 'Sub part')!;
      const relations = byType('IfcRelAggregates').map((r) => [reference(r.attributes[4]), r.attributes[5]]);
      assert.deepEqual(relations, [[partB.expressId, [`#${sub.expressId}`]], [result.expressId, [`#${partA.expressId}`, `#${partB.expressId}`]]]);
      assert.equal(parent(partA.expressId), reference(assembly.attributes[5]));
      assert.equal(parent(sub.expressId), reference(partB.attributes[5]));
      const point = reference(attribute(reference(attribute(reference(assembly.attributes[5])!, 1))!, 0))!;
      assert.deepEqual(attribute(point, 0), [5, 3, 0], 'assembly uses all parts’ 3 metre width, even without a root mesh');
      assert.equal(new Set([assembly, ...parts].map((p) => p.attributes[0])).size, 4);
      const view = useViewerStore.getState().mutationViews.get(MODEL)!;
      for (const [part, source] of [[partA, 110], [partB, 115], [sub, 125]] as const) {
        assert.equal(view.getEntityAlias(part.expressId), source);
        assert.deepEqual(resolveEntityRef(part.expressId + offset), { modelId: MODEL, expressId: part.expressId }, 'overlay copy resolves through the canonical model-backed resolver');
        const drawn = useViewerStore.getState().models.get(MODEL)!.geometryResult!.meshes.find((m) => m.expressId === part.expressId + offset);
        assert.ok(drawn, 'each copied part must be immediately visible');
        assert.equal(drawn.origin![0], (source === 110 ? 3 : 2) + 3);
      }
      const createdIds = records().map((r) => r.expressId);
      const tags = useViewerStore.getState().mutationBatchTags;
      const history = useViewerStore.getState().undoStacks.get(MODEL)!;
      assert.ok(history.length >= createdIds.length, 'every helper and relationship participates in undo');
      assert.equal(new Set(history.map((m) => tags.get(m.id))).size, 1);
      useViewerStore.getState().undo(MODEL);
      assert.equal(records().length, 0, 'one undo removes the complete copied subgraph');
      assert.equal(useViewerStore.getState().models.get(MODEL)!.geometryResult!.meshes.length, 5);
      useViewerStore.getState().redo(MODEL);
      assert.deepEqual(records().map((r) => r.expressId).sort((a, b) => a - b), createdIds.sort((a, b) => a - b));
      assert.equal(byType('IfcRelAggregates').length, 2);
    });
  }
  for (const federated of [false, true]) {
    it(`sizes mixed flat/instanced assembly copies in the pristine model frame, federation=${federated}`, async () => {
      const offset = await seed(federated);
      const state = useViewerStore.getState();
      const edited = state.models.get(MODEL)!;
      const geometryResult: GeometryResult = {
        ...edited.geometryResult!,
        meshes: edited.geometryResult!.meshes.filter((m) => m.expressId !== 115 + offset),
        instancedGeometryAabbs: new Map([[115 + offset, { min: [2, 0, 0], max: [12, 1, 1] }]]),
        coordinateInfo: {
          originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
          originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 12, y: 1, z: 1 } },
          shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 12, y: 1, z: 1 } },
        },
      };
      // The active model's colliding box would produce a 98 m step. It must
      // never supply the non-active edited model's instanced metadata (#4929).
      const decoy = { ...geometryResult, instancedGeometryAabbs: new Map([[115 + offset, { min: [2, 0, 0] as [number, number, number], max: [100, 1, 1] as [number, number, number] }]]) };
      useViewerStore.setState({ models: new Map(state.models).set(MODEL, { ...edited, geometryResult }), geometryResult: federated ? decoy : geometryResult });
      modelRotationBaker.reconcile(new Map([[MODEL, { geometry: geometryResult, rotation: { angle: Math.PI / 2, pivot: [0, 0, 0] } }]]));
      assert.notDeepEqual(geometryResult.instancedGeometryAabbs!.get(115 + offset)!.max, [12, 1, 1], 'the live instanced bounds must actually be rotated');
      const result = duplicate(100);
      const point = reference(attribute(reference(attribute(reference(attribute(result.expressId, 5))!, 1))!, 0))!;
      assert.deepEqual(attribute(point, 0), [12, 3, 0], 'all source parts contribute their unrotated 10 m width');
      assert.equal(byType('IfcBeam').length, 3);
      useViewerStore.getState().undo(MODEL);
      assert.equal(records().length, 0);
    });
  }
  it('copies hosted openings and fills under the new placements; independent hosted copies are refused', async () => {
    await seed();
    for (const id of [410, 420, 110]) {
      assert.ok('error' in useViewerStore.getState().duplicateEntity(MODEL, id));
      assert.equal(records().length, 0);
    }
    const result = duplicate(400);
    const opening = byType('IfcOpeningElement')[0];
    const door = byType('IfcDoor')[0];
    assert.ok(opening && door, 'the void and its filling must travel with the host');
    assert.equal(parent(opening.expressId), reference(attribute(result.expressId, 5)));
    assert.equal(parent(door.expressId), reference(opening.attributes[5]));
    assert.deepEqual(byType('IfcRelVoidsElement')[0].attributes.slice(4), [`#${result.expressId}`, `#${opening.expressId}`]);
    assert.deepEqual(byType('IfcRelFillsElement')[0].attributes.slice(4), [`#${opening.expressId}`, `#${door.expressId}`]);
    useViewerStore.getState().undo(MODEL);
    assert.equal(records().length, 0);
  });
  it('refuses detached root and descendant frames atomically, leaving undo, redo and meshes untouched', async () => {
    await seed(false, true);
    const meshes = useViewerStore.getState().models.get(MODEL)!.geometryResult!.meshes;
    for (const id of [300, 100]) {
      const result = useViewerStore.getState().duplicateEntity(MODEL, id);
      assert.ok('error' in result && /not tied to its storey/.test(result.error));
      assert.equal(records().length, 0, 'a late part refusal must roll back root and prior parts');
      assert.equal(useViewerStore.getState().undoStacks.size, 0);
      assert.equal(useViewerStore.getState().redoStacks.size, 0);
      assert.equal(useViewerStore.getState().models.get(MODEL)!.geometryResult!.meshes, meshes);
    }
  });
  it('reveals the new occurrence in Model view when the source has no flat geometry', async () => {
    await seed();
    const state = useViewerStore.getState();
    const model = state.models.get(MODEL)!;
    const geometryResult = { ...model.geometryResult!, meshes: [] };
    useViewerStore.setState({ typeViewMode: 'types', geometryResult, models: new Map([[MODEL, { ...model, geometryResult }]]) });
    duplicate(100);
    assert.equal(useViewerStore.getState().typeViewMode, 'model', 'new occurrence geometry must be visible after the wasm re-mesh, including instanced-only sources');
    assert.equal(byType('IfcBeam').length, 3);
  });
  it('duplicates an overlay-created assembly and honors the explicit root name', async () => {
    await seed();
    const first = duplicate(100);
    const second = useViewerStore.getState().duplicateEntity(MODEL, first.expressId, '-X', { name: 'Second assembly' });
    assert.ok(!('error' in second));
    if ('error' in second) return;
    assert.equal(attribute(second.expressId, 2), 'Second assembly');
    assert.equal(byType('IfcBeam').length, 6);
    useViewerStore.getState().undo(MODEL);
    assert.equal(byType('IfcBeam').length, 3, 'one undo preserves the first assembly');
  });
});
