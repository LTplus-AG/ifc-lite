/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** #6812 finite audit: public native replacement exists; no production changes. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach,test } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import type { InStoreReplacementElement } from '@ifc-lite/create';
import { StoreEditor } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { configureMutationView } from '@/utils/configureMutationView';
import { GROUND_STOREY,SAMPLE_MODEL,seedAuthoringSample,parseIfc,danglingReferences } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { parseModelAuthoringBatch } from './model-authoring';
import { meshStairs as nativeMeshes,stairWasmAvailable,type StairMesh } from '../../../../../packages/create/src/in-store/__test__/stair-mesh.oracle';
const original=useViewerStore.getState();afterEach(()=>useViewerStore.setState(original));
const variants:InStoreReplacementElement[]=[
 {kind:'wall',params:{Start:[20,20,0],End:[26,20,0],Height:3,Thickness:.2,Name:'Original native wall'}},
 {kind:'column',params:{Position:[20,20,0],Width:.3,Depth:.4,Height:3,Name:'Original native column'}},
 {kind:'slab',params:{Position:[20,20,0],Width:6,Depth:4,Thickness:.25,Name:'Original native slab'}},
 {kind:'beam',params:{Start:[20,20,3],End:[26,20,3],Width:.3,Height:.4,Name:'Original native beam'}},
 {kind:'space',params:{Position:[20,20,0],Width:6,Depth:4,Height:3,Name:'Original native space'}},
 {kind:'roof',params:{Position:[20,20,3],Width:6,Depth:4,Thickness:.25,Name:'Original native roof'}},
 {kind:'plate',params:{Position:[20,20,0],Width:6,Depth:4,Thickness:.25,Name:'Original native plate'}},
 {kind:'member',params:{Start:[20,20,3],End:[26,20,3],Width:.3,Height:.4,Name:'Original native member'}},
 {kind:'stair',params:{Position:[20,20,0],NumberOfRisers:4,RiserHeight:.2,TreadLength:.3,Width:1,Name:'Original native stair'}},
 {kind:'railing',params:{Path:[[20,20,0],[26,20,0]],Height:1.1,Name:'Original native railing'}},
];
async function setup(element:InStoreReplacementElement){
 const {dataStore,view}=await seedAuthoringSample(),sdk=createBimContext({backend:new LocalBackend(useViewerStore)}),storey=dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
 const add=(e:InStoreReplacementElement)=>{switch(e.kind){
  case 'wall':return sdk.store.addWall(SAMPLE_MODEL,storey,e.params);case 'column':return sdk.store.addColumn(SAMPLE_MODEL,storey,e.params);case 'slab':return sdk.store.addSlab(SAMPLE_MODEL,storey,e.params);case 'beam':return sdk.store.addBeam(SAMPLE_MODEL,storey,e.params);case 'space':return sdk.store.addSpace(SAMPLE_MODEL,storey,e.params);case 'roof':return sdk.store.addRoof(SAMPLE_MODEL,storey,e.params);case 'plate':return sdk.store.addPlate(SAMPLE_MODEL,storey,e.params);case 'member':return sdk.store.addMember(SAMPLE_MODEL,storey,e.params);case 'stair':return sdk.store.addStair(SAMPLE_MODEL,storey,e.params);case 'railing':return sdk.store.addRailing(SAMPLE_MODEL,storey,e.params);
 }};
 const made=add(element),saved=await parseIfc(editedModelBytes(dataStore,view)),savedView=new MutablePropertyView(saved.properties,SAMPLE_MODEL);configureMutationView(savedView,saved);
 const state=useViewerStore.getState(),model=state.models.get(SAMPLE_MODEL);assert.ok(model);
 useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:saved,maxExpressId:Math.max(...saved.entityIndex.byId.keys())}]]),mutationViews:new Map([[SAMPLE_MODEL,savedView]]),storeEditors:new Map(),undoStacks:new Map(),redoStacks:new Map(),mutationBatchTags:new Map()});
 return {dataStore:saved,view:savedView,sdk,storey,made};
}
async function graph(bytes:Uint8Array){const parsed=await parseIfc(bytes);assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)),[]);return [...parsed.entityIndex.byId.keys()].sort((a,b)=>a-b).map(id=>({id,...parsed.getEntity(id)}));}
for(const [index,from] of variants.entries())test(`#6812 actual SDK ${from.kind} replacement to ${variants[(index+1)%variants.length].kind} exports new native identity and one Undo restores the entire graph`,async()=>{
 const f=await setup(from),into=variants[(index+1)%variants.length],bytes=()=>editedModelBytes(f.dataStore,f.view),before=await graph(bytes()),parsed=await parseIfc(bytes()),oldGuid=parsed.entities.getGlobalId(f.made.expressId),stack=useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length??0;
 assert.equal(parsed.entities.getTypeName(f.made.expressId),`Ifc${from.kind[0].toUpperCase()}${from.kind.slice(1)}`);
 const next=f.sdk.store.replaceElement(f.made,f.storey,into),after=await parseIfc(bytes());
 assert.equal(after.getEntity(f.made.expressId),null);assert.equal(after.entities.getTypeName(next.expressId),`Ifc${into.kind[0].toUpperCase()}${into.kind.slice(1)}`);assert.notEqual(after.entities.getGlobalId(next.expressId),oldGuid);assert.notEqual(next.expressId,f.made.expressId);
 const state=useViewerStore.getState(),writes=(state.undoStacks.get(SAMPLE_MODEL)??[]).slice(stack),groups=new Set(writes.map(mutation=>state.mutationBatchTags.get(mutation.id)));
 assert.ok(writes.length>0);assert.equal(groups.size,1,'all native removal and creation records belong to one canonical Undo group');assert.ok([...groups][0],'the group is explicitly tagged');
 useViewerStore.getState().undo(SAMPLE_MODEL);assert.deepEqual(await graph(bytes()),before,'one Undo restores every independently decoded source and authored record');
});
test('#6812 native replacement refuses a hosted wall and preserves its exported graph/history/allocator',async()=>{
 const f=await setup(variants[0]);f.sdk.store.addOpening(SAMPLE_MODEL,f.made.expressId,{Offset:2,Sill:1,Width:1,Height:1});
 const before=await graph(editedModelBytes(f.dataStore,f.view)),journal=f.view.getMutations(),next=f.view.peekNextExpressId(),count=useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length;
 assert.throws(()=>f.sdk.store.replaceElement(f.made,f.storey,variants[2]),/hosted-opening/);
 assert.deepEqual(await graph(editedModelBytes(f.dataStore,f.view)),before);assert.deepEqual(f.view.getMutations(),journal);assert.equal(f.view.peekNextExpressId(),next);assert.equal(useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length,count);
});
test('#6812 native replacement refuses an ordinary aggregate root rather than orphaning its children',async()=>{
 const f=await setup(variants[0]),child=f.sdk.store.addColumn(SAMPLE_MODEL,f.storey,{Position:[20,20,0],Width:.3,Depth:.4,Height:3}),editor=new StoreEditor(f.dataStore,f.view);
 editor.addEntity('IfcRelAggregates',['0VsQpgNEP1m9rHJH2cyRcN',null,'Native aggregate',null,`#${f.made.expressId}`,[`#${child.expressId}`]]);
 const before=await graph(editedModelBytes(f.dataStore,f.view)),parsed=await parseIfc(editedModelBytes(f.dataStore,f.view));assert.ok([...parsed.entityIndex.byId.keys()].some(id=>{const e=parsed.getEntity(id);return e?.type==='IFCRELAGGREGATES'&&e.attributes[4]===f.made.expressId;}));
 assert.throws(()=>f.sdk.store.replaceElement(f.made,f.storey,variants[2]),/assembly source/);assert.deepEqual(await graph(editedModelBytes(f.dataStore,f.view)),before);
});
test('#6812 supported native ordinary replacement has a reviewed admission contract',async()=>{
 const f=await setup(variants[0]),parsed=await parseIfc(editedModelBytes(f.dataStore,f.view));
 const batch=()=>parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Reviewed native product replacement',units:'m',frame:'storey-local',operations:[{op:'element.replace',ref:'replacement',target:{modelId:SAMPLE_MODEL,globalId:parsed.entities.getGlobalId(f.made.expressId),ifcClass:'IfcWall',name:parsed.entities.getName(f.made.expressId)},storey:{modelId:SAMPLE_MODEL,globalId:GROUND_STOREY},ifcClass:'IfcSlab',name:'Reviewed native slab replacement',params:{position:[20,20,0],width:6,depth:4,thickness:.25}}]}));
 assert.doesNotThrow(batch,'the already-supported native operation needs an explicit reviewed transport');
});

function solidVolume(parts:StairMesh[]){let sum=0;for(const {positions:p,indices:t} of parts)for(let i=0;i<t.length;i+=3){const a=t[i]*3,b=t[i+1]*3,c=t[i+2]*3;sum+=p[a]*(p[b+1]*p[c+2]-p[b+2]*p[c+1])+p[a+1]*(p[b+2]*p[c]-p[b]*p[c+2])+p[a+2]*(p[b]*p[c+1]-p[b+1]*p[c]);}return Math.abs(sum/6);}
test('#6812 public native saved wall-to-slab replacement emits the destination solid and grouped Undo restores the original real WASM',{skip:!stairWasmAvailable&&'run pnpm build:wasm:fetch'},async()=>{
 const f=await setup(variants[0]),text=()=>new TextDecoder().decode(editedModelBytes(f.dataStore,f.view)),before=await nativeMeshes(text()),old=before.get(f.made.expressId);assert.ok(old?.length);assert.ok(Math.abs(solidVolume(old)-3.6)<.001);
 const replacement=f.sdk.store.replaceElement(f.made,f.storey,variants[2]),after=await nativeMeshes(text()),next=after.get(replacement.expressId);assert.ok(next?.length);assert.equal(after.has(f.made.expressId),false);assert.ok(Math.abs(solidVolume(next)-6)<.001);
 useViewerStore.getState().undo(SAMPLE_MODEL);const restored=await nativeMeshes(text());assert.equal(restored.has(replacement.expressId),false);const oldRestored=restored.get(f.made.expressId);assert.ok(oldRestored?.length);assert.ok(Math.abs(solidVolume(oldRestored)-3.6)<.001);
});
