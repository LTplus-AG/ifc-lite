/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** #6812 finite charter probe: native slab cuts already exist; reviewed admission must expose that same writer. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { readHostedFill, readHostOpeningExtents, resolveHostAnchor } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { GROUND_STOREY, SAMPLE_MODEL, parseIfc, seedAuthoringSample, danglingReferences } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
const wasm = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
function meshVolume(bytes: Uint8Array, expressId: number): number {
 initSync({ module: readFileSync(wasm) }); const api = new IfcAPI(); let sum = 0, count = 0;
 try {
  const pre = api.buildPrePassOnce(bytes), offset = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0,0,0];
  const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, offset[0],offset[1],offset[2],pre.needsShift,pre.voidKeys,pre.voidCounts,pre.voidValues,pre.styleIds,pre.styleColors);
  try { for(let i=0;i<collection.length;i++) {
   const mesh=collection.get(i);if(!mesh)continue;
   try { if(mesh.expressId!==expressId)continue;count++;const p=mesh.positions,ids=mesh.indices;
    let part=0;for(let j=0;j<ids.length;j+=3){const a=ids[j]*3,b=ids[j+1]*3,c=ids[j+2]*3;part+=(p[a]*(p[b+1]*p[c+2]-p[b+2]*p[c+1])-p[a+1]*(p[b]*p[c+2]-p[b+2]*p[c])+p[a+2]*(p[b]*p[c+1]-p[b+1]*p[c]))/6;}sum+=Math.abs(part);
   } finally { mesh.free(); }
  }} finally { collection.free(); }
 } finally { api.clearPrePassCache();api.free(); }
 assert.ok(count>0,'actual native slab host must produce a WASM mesh');return sum;
}
async function nativeSlab() {
 const {dataStore,view}=await seedAuthoringSample();const sdk=createBimContext({backend:new LocalBackend(useViewerStore)});
 const storey=dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
 const slab=sdk.store.addSlab(SAMPLE_MODEL,storey,{Position:[20,20,3],Width:6,Depth:4,Thickness:.25,Name:'Native slab opening charter'});
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
 const proposal={version:1,kind:'model.authoring',title:'Explicit slab opening',units:'m',frame:'storey-local',operations:[{op:'hosted.create',kind:'opening',host:{modelId:SAMPLE_MODEL,globalId:saved.entities.getGlobalId(slab.expressId),ifcClass:'IfcSlab',name:saved.entities.getName(slab.expressId)},params:{Position:[2,1],Width:1,Depth:.8}}]};
 assert.doesNotThrow(()=>parseModelAuthoringBatch(JSON.stringify(proposal)),'reviewed native admission omits the supported bare slab opening variant');
});
