/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach,test } from 'node:test';
import type { InStoreReplacementElement } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { replacementVariants,setupReplacementSource,replacementReviewParams } from '@/test/authoring-replacement-fixture';
import { SAMPLE_MODEL,GROUND_STOREY,parseIfc,danglingReferences } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { captureSelectionGrounding } from './selection-grounding';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { undoModelChanges } from './model-change-commit';
import { meshStairs as nativeMeshes,stairWasmAvailable } from '../../../../../packages/create/src/in-store/__test__/stair-mesh.oracle';
const initial=useViewerStore.getState();afterEach(()=>useViewerStore.setState(initial));
const variants:InStoreReplacementElement[]=[
 {kind:'column',params:{Position:[20,20,0],Profile:{Type:'Circle',Radius:.3},Height:3,Name:'Native circle replacement'}},
 {kind:'roof',params:{Position:[20,20,0],Profile:'polygon',OuterCurve:[[0,0],[6,0],[6,4],[3,4],[0,2]],Thickness:.25,Name:'Native polygon replacement'}},
];
async function graph(bytes:Uint8Array){const source=await parseIfc(bytes);assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)),[]);return [...source.entityIndex.byId.keys()].sort((a,b)=>a-b).map(id=>({id,...source.getEntity(id)}));}
for(const variant of variants)test(`#7320 reviewed ${variant.kind} profile/polygon replacement matches the independently executed public native WASM body`,{skip:!stairWasmAvailable&&'run pnpm build:wasm:fetch'},async()=>{
 const control=await setupReplacementSource(replacementVariants[0]),made=control.sdk.store.replaceElement(control.made,control.storey,variant),native=(await nativeMeshes(new TextDecoder().decode(editedModelBytes(control.dataStore,control.view)))).get(made.expressId);assert.ok(native?.length,'actual existing SDK and Rust pipeline produce the native variant');
 const f=await setupReplacementSource(replacementVariants[0]),bytes=()=>editedModelBytes(f.dataStore,f.view),before=await graph(bytes()),expected=captureSelectionGrounding({...useViewerStore.getState(),selectedEntityIds:new Set([f.made.expressId]),selectedEntityId:f.made.expressId}).elements[0]?.nativeReplacementExpected;assert.ok(expected);
 const cls=variant.kind==='column'?'IfcColumn':'IfcRoof',batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Canonical native variant replacement',units:'m',frame:'storey-local',operations:[{op:'element.replace',ref:'new',target:{modelId:SAMPLE_MODEL,globalId:f.dataStore.entities.getGlobalId(f.made.expressId),ifcClass:'IfcWall',name:f.dataStore.entities.getName(f.made.expressId)},storey:{modelId:SAMPLE_MODEL,globalId:GROUND_STOREY},ifcClass:cls,name:variant.params.Name,params:replacementReviewParams(variant),expected}]}));
 const preview=previewModelAuthoring(useViewerStore.getState(),batch);assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'native profile/polygon variant');assert.ok(result.ok,result.ok?'':result.detail??result.reason);
 const saved=await parseIfc(bytes()),id=saved.entities.getExpressIdByGlobalId(result.receipt.applied[0].globalId),body=(await nativeMeshes(new TextDecoder().decode(bytes()))).get(id);assert.equal(saved.entities.getTypeName(id),cls);assert.ok(body?.length);assert.deepEqual(body.map(m=>({positions:[...m.positions],indices:[...m.indices]})),native.map(m=>({positions:[...m.positions],indices:[...m.indices]})),'shipping reviewed transport and independent native writer produce the same physical vertices/triangles');
 assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes())),[]);assert.deepEqual(undoModelChanges(useViewerStore,result.receipt),{ok:true});assert.deepEqual(await graph(bytes()),before);
});
