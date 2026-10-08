/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readStairDimensions } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { createStoreAdapter } from '@/sdk/adapters/store-adapter';
import { GROUND_STOREY, SAMPLE_MODEL, danglingReferences, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch } from './model-authoring';
import { commitModelAuthoring } from './model-authoring-commit';
import { previewModelAuthoring } from './model-authoring-preview';
const original=useViewerStore.getState();
afterEach(()=>useViewerStore.setState(original));
const s=useViewerStore.getState;
function proposal(operation:unknown){return parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Native stair/railing',units:'m',frame:'storey-local',operations:[operation]}));}
const stair={Position:[1,2,0] as [number,number,number],NumberOfRisers:4,RiserHeight:.2,TreadLength:.3,Width:1,WaistThickness:.1,Name:'Native stair'};
const railing={Path:[[1,4,0],[3,4,.4],[3,6,.4]] as [number,number,number][],Height:1.1,PostSpacing:.8,Name:'Native railing'};
async function exported(){const state=s(),store=state.models.get(SAMPLE_MODEL)!.ifcDataStore!;const bytes=editedModelBytes(store,state.mutationViews.get(SAMPLE_MODEL)!);assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)),[]);return parseIfc(bytes);}
for(const kind of ['stair','railing'] as const)test(`#7273 reviewed ${kind} creation admits independently exported native geometry`,async()=>{
 const {dataStore}=await seedAuthoringSample();const api=createStoreAdapter(useViewerStore),storey=dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
 const add=kind==='stair'?api.addStair:api.addRailing;assert.ok(add);
 const made=kind==='stair'?api.addStair!(SAMPLE_MODEL,storey,stair):api.addRailing!(SAMPLE_MODEL,storey,railing);
 const gid=s().mutationViews.get(SAMPLE_MODEL)!.getNewEntity(made.expressId)!.attributes[0];assert.equal(typeof gid,'string');
 const parsed=await exported(),id=parsed.entities.getExpressIdByGlobalId(String(gid));assert.ok(id>0);assert.equal(parsed.entities.getTypeName(id),kind==='stair'?'IfcStair':'IfcRailing');
 if(kind==='stair'){const dims=readStairDimensions(parsed,id);assert.ok(dims);assert.equal(dims.NumberOfRisers,4);assert.ok(Math.abs(dims.Width-1)<1e-9);assert.ok(Math.abs(dims.WaistThickness!-.1)<1e-9);}
 const operation={op:`${kind}.create`,ref:'reviewed',storey:{globalId:GROUND_STOREY},params:kind==='stair'?{...stair,Name:'Reviewed stair'}:{...railing,Name:'Reviewed railing'}};
 assert.doesNotThrow(()=>proposal(operation),'Assistant must admit the independently exported native family');
 const before=s().mutationViews.get(SAMPLE_MODEL)!.getMutations();const preview=previewModelAuthoring(s(),proposal(operation));assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue);assert.deepEqual(s().mutationViews.get(SAMPLE_MODEL)!.getMutations(),before,'Preview leaves real native journal unchanged');
 const committed=commitModelAuthoring(useViewerStore,preview,new Set([0]),'native stair/railing witness');assert.ok(committed.ok,committed.ok?'':committed.detail??committed.reason);
 const after=await exported(),reviewedId=after.entities.getExpressIdByGlobalId(committed.receipt.applied[0].globalId);assert.ok(reviewedId>0);assert.equal(after.entities.getName(reviewedId),kind==='stair'?'Reviewed stair':'Reviewed railing');assert.equal(after.entities.getTypeName(reviewedId),kind==='stair'?'IfcStair':'IfcRailing');assert.ok(after.entities.getExpressIdByGlobalId(String(gid))>0,'Prior native product remains unchanged');
});
test('#7273 ordinary native creation remains an unpublished review control',async()=>{await seedAuthoringSample();const before=s().mutationViews.get(SAMPLE_MODEL)!.getMutations();const preview=previewModelAuthoring(s(),proposal({op:'element.create',ref:'control',ifcClass:'IfcWall',name:'Control',storey:{globalId:GROUND_STOREY},params:{start:[0,10,0],end:[8,10,0],height:3,thickness:.2}}));assert.equal(preview.rows[0].status,'ready');assert.deepEqual(s().mutationViews.get(SAMPLE_MODEL)!.getMutations(),before);});
