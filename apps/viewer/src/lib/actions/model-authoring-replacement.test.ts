/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach,test } from 'node:test';
import { useViewerStore } from '@/store';
import { replacementReviewParams,replacementVariants,setupReplacementSource } from '@/test/authoring-replacement-fixture';
import { parseIfc,SAMPLE_MODEL,GROUND_STOREY,danglingReferences } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { captureSelectionGrounding } from './selection-grounding';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { undoModelChanges } from './model-change-commit';
const initial=useViewerStore.getState();afterEach(()=>useViewerStore.setState(initial));
function classOf(kind:string){return `Ifc${kind[0].toUpperCase()}${kind.slice(1)}`;}
async function graph(bytes:Uint8Array){const parsed=await parseIfc(bytes);assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)),[]);return [...parsed.entityIndex.byId.keys()].sort((a,b)=>a-b).map(id=>({id,...parsed.getEntity(id)}));}
for(const from of replacementVariants)for(const into of replacementVariants)test(`#7320 reviewed native ${from.kind}->${into.kind} matches the canonical saved-source writer and one graph Undo`,async()=>{
 const f=await setupReplacementSource(from),bytes=()=>editedModelBytes(f.dataStore,f.view),before=await graph(bytes()),old=f.dataStore.getEntity(f.made.expressId);assert.ok(old);
 const selection=captureSelectionGrounding({...useViewerStore.getState(),selectedEntityIds:new Set([f.made.expressId]),selectedEntityId:f.made.expressId}),expected=selection.elements[0]?.nativeReplacementExpected;assert.ok(expected,'complete current native replacement evidence is available');
 const p=into.params;
 const params=replacementReviewParams(into);
 const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Reviewed native replacement matrix',units:'m',frame:'storey-local',operations:[{op:'element.replace',target:{modelId:SAMPLE_MODEL,globalId:old.attributes[0],ifcClass:classOf(from.kind),name:old.attributes[2]},storey:{modelId:SAMPLE_MODEL,globalId:GROUND_STOREY},ref:'replacement',ifcClass:classOf(into.kind),name:p.Name,params,expected}]}));
 const preview=previewModelAuthoring(useViewerStore.getState(),batch);assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');
 const committed=commitModelAuthoring(useViewerStore,preview,new Set([0]),'all canonical native replacements');assert.ok(committed.ok,committed.ok?'':committed.detail??committed.reason);
 const after=await parseIfc(bytes()),newId=after.entities.getExpressIdByGlobalId(committed.receipt.applied[0].globalId);assert.ok(newId>0);assert.notEqual(newId,f.made.expressId);assert.equal(after.getEntity(f.made.expressId),null);assert.equal(after.entities.getTypeName(newId),classOf(into.kind));assert.equal(after.entities.getName(newId),p.Name);
 assert.deepEqual(undoModelChanges(useViewerStore,committed.receipt),{ok:true});assert.deepEqual(await graph(bytes()),before,'one grouped Undo restores all saved native records including Stair flight and material/property helpers');
});
