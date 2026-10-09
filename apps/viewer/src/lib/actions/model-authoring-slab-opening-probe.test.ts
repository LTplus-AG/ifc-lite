/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** #6812 finite charter probe: native slab cuts already exist; reviewed admission must expose that same writer. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { configureMutationView } from '@/utils/configureMutationView';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { readHostedFill, readHostOpeningExtents, resolveHostAnchor } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { GROUND_STOREY, SAMPLE_MODEL, parseIfc, seedAuthoringSample, danglingReferences } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { parseModelAuthoringBatch } from './model-authoring';
import { commitModelAuthoring } from './model-authoring-commit';
import { undoModelChanges } from './model-change-commit';
import { authoringReader } from './model-authoring-read';
import { readSplitSnapshot } from './model-authoring-split-state';
import { authoringGhosts } from './model-authoring-ghost';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { previewModelAuthoring } from './model-authoring-preview';
const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
const wasm = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
function meshVolume(bytes: Uint8Array, expressId: number, vertices?: [number,number,number][]): number {
 initSync({ module: readFileSync(wasm) }); const api = new IfcAPI(); let sum = 0, count = 0;
 try {
  const pre = api.buildPrePassOnce(bytes), offset = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0,0,0];
  const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, offset[0],offset[1],offset[2],pre.needsShift,pre.voidKeys,pre.voidCounts,pre.voidValues,pre.styleIds,pre.styleColors);
  try { for(let i=0;i<collection.length;i++) {
   const mesh=collection.get(i);if(!mesh)continue;
   try { if(mesh.expressId!==expressId)continue;count++;const p=mesh.positions,ids=mesh.indices;
    if(vertices){const o=mesh.origin;for(let k=0;k<p.length;k+=3)vertices.push([p[k]+o[0],p[k+1]+o[1],p[k+2]+o[2]]);}
    let part=0;for(let j=0;j<ids.length;j+=3){const a=ids[j]*3,b=ids[j+1]*3,c=ids[j+2]*3;part+=(p[a]*(p[b+1]*p[c+2]-p[b+2]*p[c+1])-p[a+1]*(p[b]*p[c+2]-p[b+2]*p[c])+p[a+2]*(p[b]*p[c+1]-p[b+1]*p[c]))/6;}sum+=Math.abs(part);
   } finally { mesh.free(); }
  }} finally { collection.free(); }
 } finally { api.clearPrePassCache();api.free(); }
 assert.ok(count>0,'actual native slab host must produce a WASM mesh');return sum;
}
async function nativeSlab(polygon=false) {
 const {dataStore,view}=await seedAuthoringSample();const sdk=createBimContext({backend:new LocalBackend(useViewerStore)});
 const storey=dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
 const slab=sdk.store.addSlab(SAMPLE_MODEL,storey,polygon?{Profile:'polygon',OuterCurve:[[0,0],[6,0],[6,2],[4,2],[4,4],[0,4]],Position:[20,20,3],Thickness:.25,Name:'Native polygon opening charter'}:{Position:[20,20,3],Width:6,Depth:4,Thickness:.25,Name:'Native slab opening charter'});
 return {dataStore,view,sdk,slab,storey};
}
test('#6812 native SDK bare slab opening independently exports/reparses its host-local graph',async()=>{
 const {dataStore,view,sdk,slab}=await nativeSlab();const opening=sdk.store.addOpening(SAMPLE_MODEL,slab.expressId,{Position:[2,1],Width:1,Depth:.8,Name:'Native slab cut'});
 const bytes=editedModelBytes(dataStore,view),saved=await parseIfc(bytes);assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)),[]);
 assert.equal(saved.entities.getTypeName(slab.expressId),'IfcSlab');assert.equal(saved.entities.getTypeName(opening.expressId),'IfcOpeningElement');
 const host=resolveHostAnchor(saved,slab.expressId);assert.equal(host.hostKind,'slab');
 const binding=readHostedFill(saved,opening.expressId);assert.ok(binding);assert.equal(binding.hostId,slab.expressId);
 const cuts=readHostOpeningExtents(saved,slab.expressId);assert.deepEqual(cuts.unreadable,[]);assert.equal(cuts.cuts.length,1);assert.equal(cuts.cuts[0].openingId,opening.expressId);
 console.log(JSON.stringify({nativeHost:slab,nativeOpening:opening,hostBounds:host.hostBounds,nativeCutBounds:cuts.cuts[0].bounds,schema:saved.schemaVersion}));
});
test('#6812 native SDK bare slab opening produces a real WASM through cut', {skip:!existsSync(wasm)&&'run pnpm build:wasm:fetch'},async()=>{
 const {dataStore,view,sdk,slab}=await nativeSlab();const before=meshVolume(editedModelBytes(dataStore,view),slab.expressId);
 sdk.store.addOpening(SAMPLE_MODEL,slab.expressId,{Position:[2,1],Width:1,Depth:.8});const after=meshVolume(editedModelBytes(dataStore,view),slab.expressId);
 assert.ok(Math.abs(before-6)<.001,`actual original slab volume ${before}`);assert.ok(Math.abs(after-5.8)<.001,`actual voided slab volume ${after}`);
 useViewerStore.getState().undo(SAMPLE_MODEL);
 const restored=meshVolume(editedModelBytes(dataStore,view),slab.expressId);assert.ok(Math.abs(restored-before)<.001,'one native Undo restores the physical uncut slab');
 assert.equal(readHostOpeningExtents(await parseIfc(editedModelBytes(dataStore,view)),slab.expressId).cuts.length,0,'one native Undo removes the entire exported void graph');
 console.log(JSON.stringify({nativeWasmSlabBefore:before,nativeWasmSlabAfter:after,actualRemovedVolume:before-after,nativeUndoRestoredVolume:restored}));
});
test('#6812 existing reviewed wall opening remains a ready canonical positive control',async()=>{
 await seedAuthoringSample();const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Existing native wall opening',units:'m',frame:'storey-local',operations:[
 {op:'element.create',ref:'wall',name:'Native wall control',ifcClass:'IfcWall',storey:{modelId:SAMPLE_MODEL,globalId:GROUND_STOREY,name:'00 groundfloor'},params:{start:[20,20,0],end:[30,20,0],height:3,thickness:.2}},
 {op:'hosted.create',kind:'opening',host:{ref:'wall'},offset:2,sill:1,width:1,height:1}]}));
 const preview=previewModelAuthoring(useViewerStore.getState(),batch);assert.deepEqual(preview.rows.map(row=>row.status),['ready','ready']);
});
test('#6812 reviewed bare slab opening admits the existing canonical native slab variant',async()=>{
 const {dataStore,view,slab}=await nativeSlab();const saved=await parseIfc(editedModelBytes(dataStore,view));assert.equal(resolveHostAnchor(saved,slab.expressId).hostKind,'slab');
 const current = authoringReader(useViewerStore.getState(), SAMPLE_MODEL); assert.ok(current);
 const proposal={version:1,kind:'model.authoring',title:'Explicit slab opening',units:'m',frame:'storey-local',operations:[{op:'hosted.create',kind:'opening',host:{modelId:SAMPLE_MODEL,globalId:saved.entities.getGlobalId(slab.expressId),ifcClass:'IfcSlab',name:saved.entities.getName(slab.expressId)},params:{Position:[2,1],Width:1,Depth:.8},expected:readSplitSnapshot(current.dataStore,current.editor,slab.expressId,'m')}]};
 const batch = parseModelAuthoringBatch(JSON.stringify(proposal));
 const preview = previewModelAuthoring(useViewerStore.getState(), batch);
 assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? '');
 assert.equal(preview.rows[0].previewUnavailable, false, 'the supported frame draws a native slab cutter, never a wall ghost');
});

for (const polygon of [false,true]) for (const units of ['m', 'mm'] as const) test(`#7310 reviewed ${polygon?'polygon':'rectangle'} source slab opening commits the physical native cut and one grouped Undo in declared ${units}`, {skip: !existsSync(wasm) && 'run pnpm build:wasm:fetch'}, async () => {
 const {dataStore,view,slab,storey}=await nativeSlab(polygon); const saved = await parseIfc(editedModelBytes(dataStore,view));
 const reader = authoringReader(useViewerStore.getState(), SAMPLE_MODEL); assert.ok(reader);
 const factor = units === 'mm' ? 1000 : 1;
 const batch = parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Reviewed physical native slab cut',units,frame:'storey-local',operations:[{
  op:'hosted.create',kind:'opening',host:{modelId:SAMPLE_MODEL,globalId:saved.entities.getGlobalId(slab.expressId),ifcClass:'IfcSlab',name:saved.entities.getName(slab.expressId)},
  expected:readSplitSnapshot(reader.dataStore,reader.editor,slab.expressId,units),params:{Position:[2*factor,1*factor],Width:factor,Depth:.8*factor}}]}));
 const before=meshVolume(editedModelBytes(dataStore,view),slab.expressId),preview=previewModelAuthoring(useViewerStore.getState(),batch);
 assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue ?? '');
 const outcome=commitModelAuthoring(useViewerStore,preview,new Set([0]),'slab-native-contract');assert.ok(outcome.ok,outcome.ok?'':outcome.detail??outcome.reason);
 const bytes=editedModelBytes(dataStore,view),reparsed=await parseIfc(bytes);
 assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)),[]);
 const openingId=reparsed.entities.getExpressIdByGlobalId(outcome.receipt.applied[0].globalId);assert.ok(openingId>0);
 assert.equal(readHostedFill(reparsed,openingId)?.hostId,slab.expressId);
 const vertices:[number,number,number][]=[],after=meshVolume(bytes,slab.expressId,vertices);
 assert.ok(Math.abs(before-(polygon?5:6))<.001,'actual source footprint establishes the physical starting volume');
 assert.ok(Math.abs(after-(polygon?4.8:5.8))<.001,'actual reviewed native commit cuts precisely the supported slab');
 const plane=buildStoreyWorkplane(useViewerStore.getState(),SAMPLE_MODEL,storey,0);assert.ok(isWorkplane(plane));
 const ghost=authoringGhosts(useViewerStore.getState(),preview)[0];assert.ok(ghost);
 const ghostLocal:(readonly [number,number,number])[]=[];for(let k=0;k<ghost.positions.length;k+=3)ghostLocal.push(plane.renderToLocal([ghost.positions[k],ghost.positions[k+1],ghost.positions[k+2]]));
 for(const [axis,min,max] of [[0,21.5,22.5],[1,20.6,21.4],[2,2.95,3.3]]){
  const values=ghostLocal.map(p=>p[axis]);assert.ok(Math.abs(Math.min(...values)-min)<.001);assert.ok(Math.abs(Math.max(...values)-max)<.001);
 }
 const nativeLocal=vertices.map(p=>plane.renderToLocal(p));
 const actualCutFaces=nativeLocal.filter(p=>p[0]>21.499&&p[0]<22.501&&p[1]>20.599&&p[1]<21.401);
 assert.ok(actualCutFaces.length>0,'the physical WASM host has actual cut-face vertices inside the shown native cutter');
 for(const [axis,min,max] of [[0,21.5,22.5],[1,20.6,21.4]]){
  const values=actualCutFaces.map(p=>p[axis]);assert.ok(Math.abs(Math.min(...values)-min)<.001);assert.ok(Math.abs(Math.max(...values)-max)<.001);
 }
 assert.deepEqual(undoModelChanges(useViewerStore,outcome.receipt),{ok:true});
 assert.ok(Math.abs(meshVolume(editedModelBytes(dataStore,view),slab.expressId)-before)<.001,'one grouped Changes Undo restores the complete physical host');
 assert.equal(readHostOpeningExtents(await parseIfc(editedModelBytes(dataStore,view)),slab.expressId).cuts.length,0);
});

test('#7315 live named native slab retarget reviewed cut matches independently saved real WASM and grouped Undo',{skip:!existsSync(wasm)&&'run pnpm build:wasm:fetch'},async()=>{
 const f=await nativeSlab(),store=await parseIfc(editedModelBytes(f.dataStore,f.view)),view=new MutablePropertyView(store.properties,SAMPLE_MODEL);configureMutationView(view,store);
 const state=useViewerStore.getState(),model=state.models.get(SAMPLE_MODEL);assert.ok(model);
 useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:store,maxExpressId:Math.max(...store.entityIndex.byId.keys())}]]),mutationViews:new Map([[SAMPLE_MODEL,view]]),storeEditors:new Map()});
 const editor=new StoreEditor(store,view),id=f.slab.expressId,localId=Number(store.getEntity(id)?.attributes[5]),point=editor.addEntity('IfcCartesianPoint',[[22000,21000,3000]]),axis=editor.addEntity('IfcAxis2Placement3D',[`#${point.expressId}`,null,null]);
 editor.setAttribute(localId,'RelativePlacement',`#${axis.expressId}`);
 const beforeBytes=editedModelBytes(store,view),before=await parseIfc(beforeBytes);assert.equal(before.getEntity(localId)?.attributes[1],axis.expressId);
 const expected=readSplitSnapshot(store,editor,id,'m');if(expected.kind!=='slab')assert.fail('The actual native host must resolve as a slab');assert.deepEqual(expected.chain.placementOrigin,[22,21,3]);
 const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Current named slab native cut',units:'m',frame:'storey-local',operations:[{op:'hosted.create',kind:'opening',host:{modelId:SAMPLE_MODEL,globalId:before.entities.getGlobalId(id),ifcClass:'IfcSlab',name:before.entities.getName(id)},expected,params:{Position:[2,1],Width:1,Depth:.8}}]}));
 const preview=previewModelAuthoring(useViewerStore.getState(),batch);assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');
 const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'named current slab native cut');assert.ok(result.ok,result.ok?'':result.detail??result.reason);
 const bytes=editedModelBytes(store,view),after=await parseIfc(bytes);assert.equal(after.getEntity(localId)?.attributes[1],axis.expressId);assert.equal(readHostOpeningExtents(after,id).cuts.length,1);
 assert.ok(Math.abs(meshVolume(beforeBytes,id)-6)<.001);assert.ok(Math.abs(meshVolume(bytes,id)-5.8)<.001,'the actual current-location solid receives the native through cut');
 assert.deepEqual(undoModelChanges(useViewerStore,result.receipt),{ok:true});assert.ok(Math.abs(meshVolume(editedModelBytes(store,view),id)-6)<.001);
 const undone=await parseIfc(editedModelBytes(store,view));assert.equal(undone.getEntity(localId)?.attributes[1],axis.expressId);assert.equal(readHostOpeningExtents(undone,id).cuts.length,0);
});
