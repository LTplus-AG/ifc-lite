/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach,test } from 'node:test';
import { useViewerStore } from '@/store';
import { seedModelingSession,MODEL_ID,STOREY } from '@/test/modeling-session-fixture';
import { parseIfc } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { captureSelectionGrounding } from './selection-grounding';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { undoModelChanges } from './model-change-commit';
import { authoringGhosts } from './model-authoring-ghost';
import { buildStoreyWorkplane,isWorkplane } from '@/lib/commands/modeling/workplane';
import { meshStairs as nativeMeshes,stairWasmAvailable,type StairMesh } from '../../../../../packages/create/src/in-store/__test__/stair-mesh.oracle';
const initial=useViewerStore.getState();afterEach(()=>useViewerStore.setState(initial));
function volume(parts:StairMesh[]){let sum=0;for(const {positions:p,indices:t} of parts)for(let i=0;i<t.length;i+=3){const a=t[i]*3,b=t[i+1]*3,c=t[i+2]*3;sum+=p[a]*(p[b+1]*p[c+2]-p[b+2]*p[c+1])+p[a+1]*(p[b+2]*p[c]-p[b]*p[c+2])+p[a+2]*(p[b]*p[c+1]-p[b+1]*p[c]);}return Math.abs(sum/6);}
for(const unit of ['metre','millimetre'] as const)for(const declared of ['m','mm'] as const)
test(`#7320 native ${unit} source receives declared ${declared} replacement dimensions exactly once and restores physical WASM`,{skip:!stairWasmAvailable&&'run pnpm build:wasm:fetch'},async()=>{
 const view=await seedModelingSession({unit,storeyOffset:[100,-50]}),state=useViewerStore.getState(),store=state.models.get(MODEL_ID)?.ifcDataStore;assert.ok(store);
 const made=state.addWall(MODEL_ID,STOREY,{Start:[20,20,0],End:[26,20,0],Height:3,Thickness:.2,Name:'Native unit replacement source'});assert.ok('expressId'in made,'error'in made?made.error:'');
 const bytes=()=>editedModelBytes(store,view),before=await parseIfc(bytes()),graph=(s:typeof before)=>[...s.entityIndex.byId.keys()].sort((a,b)=>a-b).map(id=>({id,...s.getEntity(id)}));
 const expected=captureSelectionGrounding({...useViewerStore.getState(),selectedEntityIds:new Set([made.expressId]),selectedEntityId:made.expressId}).elements[0]?.nativeReplacementExpected;assert.ok(expected);
 const k=declared==='mm'?1000:1,batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Explicit native unit replacement',units:declared,frame:'storey-local',operations:[{op:'element.replace',ref:'new',target:{modelId:MODEL_ID,globalId:before.entities.getGlobalId(made.expressId),ifcClass:'IfcWall',name:before.entities.getName(made.expressId)},ifcClass:'IfcSlab',name:'Physical six cubic metre slab',storey:{modelId:MODEL_ID,globalId:before.entities.getGlobalId(STOREY)},expected,params:{position:[20*k,20*k,0],width:6*k,depth:4*k,thickness:.25*k}}]}));
 const preview=previewModelAuthoring(useViewerStore.getState(),batch);assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');
 const ghosts=authoringGhosts(useViewerStore.getState(),preview);assert.equal(ghosts.length,1);const plane=buildStoreyWorkplane(useViewerStore.getState(),MODEL_ID,STOREY,0);assert.ok(isWorkplane(plane));
 const xs:number[]=[];for(let i=0;i<ghosts[0].positions.length;i+=3)xs.push(plane.renderToLocal([ghosts[0].positions[i],ghosts[0].positions[i+1],ghosts[0].positions[i+2]])[0]);assert.ok(Math.abs(Math.min(...xs)-20)<.001);assert.ok(Math.abs(Math.max(...xs)-26)<.001);
 const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'physical replacement unit contract');assert.ok(result.ok,result.ok?'':result.detail??result.reason);
 const after=await parseIfc(bytes()),id=after.entities.getExpressIdByGlobalId(result.receipt.applied[0].globalId),meshes=await nativeMeshes(new TextDecoder().decode(bytes())),solid=meshes.get(id);assert.ok(solid?.length);assert.equal(meshes.has(made.expressId),false);assert.ok(Math.abs(volume(solid)-6)<.002,'native WASM destination is six cubic metres in both file units');
 assert.deepEqual(undoModelChanges(useViewerStore,result.receipt),{ok:true});assert.deepEqual(graph(await parseIfc(bytes())),graph(before));const restored=(await nativeMeshes(new TextDecoder().decode(bytes()))).get(made.expressId);assert.ok(restored?.length);assert.ok(Math.abs(volume(restored)-3.6)<.002);
});
