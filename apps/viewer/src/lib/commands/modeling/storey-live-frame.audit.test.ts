/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { storeyPlanFrame } from '@ifc-lite/create';
import { RelationshipType } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { createStoreAdapter } from '@/sdk/adapters/store-adapter';
import { GROUND_STOREY, SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { buildStoreyWorkplane, isWorkplane } from './workplane';
import { meshStairs, stairMeshBounds, stairWasmAvailable } from '../../../../../../packages/create/src/in-store/__test__/stair-mesh.oracle';
const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
async function editedFrame() {
 await seedAuthoringSample(); const get=useViewerStore.getState, api=createStoreAdapter(useViewerStore), source=get().models.get(SAMPLE_MODEL)!.ifcDataStore!, storey=source.entities.getExpressIdByGlobalId(GROUND_STOREY);
 const point=api.addEntity(SAMPLE_MODEL,{type:'IfcCartesianPoint',attributes:[[15000,20000,5000]]}), z=api.addEntity(SAMPLE_MODEL,{type:'IfcDirection',attributes:[[0,0,1]]}), x=api.addEntity(SAMPLE_MODEL,{type:'IfcDirection',attributes:[[0,1,0]]}), axis=api.addEntity(SAMPLE_MODEL,{type:'IfcAxis2Placement3D',attributes:[`#${point.expressId}`,`#${z.expressId}`,`#${x.expressId}`]}), placement=api.addEntity(SAMPLE_MODEL,{type:'IfcLocalPlacement',attributes:[null,`#${axis.expressId}`]});
 api.setPositionalAttribute({modelId:SAMPLE_MODEL,expressId:storey},5,`#${placement.expressId}`);api.setPositionalAttribute({modelId:SAMPLE_MODEL,expressId:storey},9,5000);
 const view=get().mutationViews.get(SAMPLE_MODEL)!; const saved=await parseIfc(editedModelBytes(source,view));
 assert.equal(saved.getEntity(storey)?.attributes[5],placement.expressId);
 const frame=storeyPlanFrame(saved,storey);assert.ok(frame);assert.deepEqual(frame.origin,[15,20]);assert.deepEqual(frame.axisX,[0,1]);
 return {api,source,storey,view,saved};
}
test('audit: independent saved public 3D frame agrees with actual native aggregate world bounds',{skip:!stairWasmAvailable&&'run pnpm build:wasm:fetch'},async()=>{
 const {api,source,storey,view}=await editedFrame(); const made=api.addCurtainWall!(SAMPLE_MODEL,storey,{Start:[1,2,0],End:[5,2,0],Height:3,UGrid:2,VGrid:2});
 const bytes=editedModelBytes(source,view),parsed=await parseIfc(bytes),children=parsed.relationships.getRelated(made.expressId,RelationshipType.Aggregates,'forward'),meshes=await meshStairs(new TextDecoder().decode(bytes)); const native=children.flatMap(id=>meshes.get(id)??[]);assert.ok(native.length);
 const bounds=stairMeshBounds(native); assert.ok(Math.abs(bounds.min[0]-12.925)<.001);assert.ok(Math.abs(bounds.min[1]-21)<.001);assert.ok(Math.abs(bounds.min[2]-5)<.001);
});
test('audit: current interactive/Room workplane agrees with independently saved public 3D storey frame',async()=>{
 const {storey,saved}=await editedFrame();const state=useViewerStore.getState(),live=buildStoreyWorkplane(state,SAMPLE_MODEL,storey,0);assert.ok(isWorkplane(live));const model=state.models.get(SAMPLE_MODEL)!;
 const independent=buildStoreyWorkplane({...state,models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:saved}]]),mutationViews:new Map()},SAMPLE_MODEL,storey,0);assert.ok(isWorkplane(independent));
 assert.deepEqual(independent.localToRender([1,2,0]),[13,5,-21],'Saved native frame positive precondition');
 assert.deepEqual(live.localToRender([1,2,0]),independent.localToRender([1,2,0]),'Current interactive and Room workplane must not discard the effective public placement');
});
