/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach,test } from 'node:test';
import { EMPTY_SOURCE_BYTES } from '@ifc-lite/parser';
import { StoreEditor,MutablePropertyView } from '@ifc-lite/mutations';
import { createModellingStoreBackend,resolveLiveOwnerHistoryId } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { replacementVariants,setupReplacementSource,replacementReviewParams } from '@/test/authoring-replacement-fixture';
import { SAMPLE_MODEL,GROUND_STOREY,FRONT_WALL_TYPE,FRONT_WALL_TYPE_NAME,parseIfc,danglingReferences } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { captureSelectionGrounding } from './selection-grounding';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { undoModelChanges } from './model-change-commit';
const initial=useViewerStore.getState();afterEach(()=>useViewerStore.setState(initial));
async function graph(bytes:Uint8Array){const store=await parseIfc(bytes);assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)),[]);return [...store.entityIndex.byId.keys()].sort((a,b)=>a-b).map(id=>({id,...store.getEntity(id)}));}
async function fixture(){
 const f=await setupReplacementSource(replacementVariants[0]),state=useViewerStore.getState(),record=f.dataStore.getEntity(f.made.expressId);assert.ok(record);
 const selected={...state,selectedEntityIds:new Set([f.made.expressId]),selectedEntityId:f.made.expressId},evidence=captureSelectionGrounding(selected).elements[0];assert.ok(evidence?.nativeReplacementExpected);
 const globalId=record.attributes[0];assert.ok(typeof globalId==='string');
 const op={op:'element.replace',ref:'new',target:{modelId:SAMPLE_MODEL,globalId,ifcClass:'IfcWall',name:record.attributes[2]},ifcClass:'IfcSlab',name:'Supplied slab destination',storey:{modelId:SAMPLE_MODEL,globalId:GROUND_STOREY},params:replacementReviewParams(replacementVariants[2]),expected:evidence.nativeReplacementExpected};
 const batch=(operations:unknown[]=[op],units:'m'|'mm'='m')=>parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Explicit current replacement',units,frame:'storey-local',operations}));
 return {...f,state,record,evidence,op,batch,bytes:()=>editedModelBytes(f.dataStore,f.view)};
}
for(const kind of ['source','view','placement','identity','delete'] as const)test(`#7320 ${kind} changes after approval refuse replacement and preserve the current graph`,async()=>{
 const f=await fixture(),preview=previewModelAuthoring(useViewerStore.getState(),f.batch());assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');
 if(kind==='source'){const model=f.state.models.get(SAMPLE_MODEL);assert.ok(model);useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:await parseIfc(f.dataStore.source.materialize())}]])});}
 if(kind==='view')useViewerStore.setState({mutationViews:new Map([[SAMPLE_MODEL,new MutablePropertyView(f.dataStore.properties,SAMPLE_MODEL)]])});
 if(kind==='identity')new StoreEditor(f.dataStore,f.view).setAttribute(f.made.expressId,'Name','Native source renamed');
 if(kind==='delete')new StoreEditor(f.dataStore,f.view).removeEntity(f.made.expressId);
 if(kind==='placement'){const editor=new StoreEditor(f.dataStore,f.view),local=Number(f.record.attributes[5]),axis=f.dataStore.getEntity(local)?.attributes[1],point=f.dataStore.getEntity(Number(axis))?.attributes[0];assert.ok(point);editor.setPositionalAttribute(Number(point),0,[25000,26000,0]);}
 const current=useViewerStore.getState(),store=current.models.get(SAMPLE_MODEL)?.ifcDataStore,view=current.mutationViews.get(SAMPLE_MODEL);assert.ok(store&&view);const bytes=()=>editedModelBytes(store,view),before=await graph(bytes());
 assert.equal(commitModelAuthoring(useViewerStore,preview,new Set([0]),'stale replacement').ok,false);assert.deepEqual(await graph(bytes()),before);
});
test('#7320 valid EMPTY_SOURCE_BYTES yields explicit unavailable replacement evidence and no native write',async()=>{
 const f=await fixture(),model=f.state.models.get(SAMPLE_MODEL);assert.ok(model);useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:{...f.dataStore,source:EMPTY_SOURCE_BYTES}}]])});
 const evidence=captureSelectionGrounding({...useViewerStore.getState(),selectedEntityIds:new Set([f.made.expressId]),selectedEntityId:f.made.expressId}).elements[0];assert.ok(evidence);assert.equal(evidence.nativeReplacementExpected,null);assert.notEqual(evidence.nativeAuthoringAvailability.replacement,'available');
 const before=await graph(f.bytes()),preview=previewModelAuthoring(useViewerStore.getState(),f.batch());assert.notEqual(preview.rows[0].status,'ready');assert.equal(commitModelAuthoring(useViewerStore,preview,new Set([0]),'opaque replacement').ok,false);assert.deepEqual(await graph(f.bytes()),before);
});
test('#7320 first-read replacement evidence/preview preserve the held source lease and unpublished editor registry',async()=>{
 const f=await fixture(),held=f.view.prepareAtomic(()=>undefined);assert.equal(useViewerStore.getState().storeEditors.size,0);
 const evidence=captureSelectionGrounding({...useViewerStore.getState(),selectedEntityIds:new Set([f.made.expressId]),selectedEntityId:f.made.expressId});assert.ok(evidence.elements[0]?.nativeReplacementExpected);
 const preview=previewModelAuthoring(useViewerStore.getState(),f.batch());assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');assert.doesNotThrow(()=>held.validate());assert.equal(useViewerStore.getState().storeEditors.size,0);
});
test('#7320 genuine duplicate source/storey Root identities refuse without conflating material Names',async()=>{
 const f=await fixture(),editor=new StoreEditor(f.dataStore,f.view);editor.addEntity('IfcMaterial',[f.op.target.globalId,null,null]);assert.ok(captureSelectionGrounding({...useViewerStore.getState(),selectedEntityIds:new Set([f.made.expressId]),selectedEntityId:f.made.expressId}).elements[0]?.nativeReplacementExpected,'non-root material Name is not a second GlobalId');
 assert.equal(previewModelAuthoring(useViewerStore.getState(),f.batch()).rows[0].status,'ready');
 editor.addEntity('IfcWall',f.record.attributes);const saved=await parseIfc(f.bytes());assert.equal([...saved.entityIndex.byId.keys()].filter(id=>saved.getEntity(id)?.type==='IFCWALL'&&saved.getEntity(id)?.attributes[0]===f.op.target.globalId).length,2);
 const before=await graph(f.bytes()),preview=previewModelAuthoring(useViewerStore.getState(),f.batch());assert.notEqual(preview.rows[0].status,'ready');assert.equal(commitModelAuthoring(useViewerStore,preview,new Set([0]),'ambiguous native source').ok,false);assert.deepEqual(await graph(f.bytes()),before);
});
for(const matching of [false,true])test(`#7320 intermediate existing type assignment ${matching?'accepts exact current':'refuses old'} replacement metadata`,async()=>{
 const f=await fixture(),typeId=f.dataStore.entities.getExpressIdByGlobalId(FRONT_WALL_TYPE);assert.ok(typeId>0);
 const assignment={op:'type.assign',target:f.op.target,expected:null,type:{globalId:FRONT_WALL_TYPE,name:FRONT_WALL_TYPE_NAME}};
 const expected=f.view.prepareAtomic(view=>{
  const editor=new StoreEditor(f.dataStore,view),methods=createModellingStoreBackend(()=>({modelId:SAMPLE_MODEL,store:f.dataStore,editor,mutationView:view,ownerHistoryId:resolveLiveOwnerHistoryId(f.dataStore,editor,view)}));methods.assignType(SAMPLE_MODEL,typeId,[f.made.expressId]);
  const state={...useViewerStore.getState(),mutationViews:new Map([[SAMPLE_MODEL,view]]),selectedEntityIds:new Set([f.made.expressId]),selectedEntityId:f.made.expressId};return captureSelectionGrounding(state).elements[0]?.nativeReplacementExpected;
 }).result;assert.ok(expected);assert.equal(expected.types.length,1);
 const before=await graph(f.bytes()),preview=previewModelAuthoring(useViewerStore.getState(),f.batch([assignment,{...f.op,expected:matching?expected:f.op.expected}]));assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');
 if(!matching){assert.notEqual(preview.rows[1].status,'ready');assert.deepEqual(await graph(f.bytes()),before);return;}
 assert.equal(preview.rows[1].status,'ready',preview.rows[1].issue??'');const result=commitModelAuthoring(useViewerStore,preview,new Set([0,1]),'current intermediate replacement');assert.ok(result.ok,result.ok?'':result.detail??result.reason);assert.deepEqual(undoModelChanges(useViewerStore,result.receipt),{ok:true});assert.deepEqual(await graph(f.bytes()),before);
});
test('#7320 two same-GUID native models require explicit owner and keep the peer graph unchanged',async()=>{
 const f=await fixture(),model=f.state.models.get(SAMPLE_MODEL);assert.ok(model);const peerStore=await parseIfc(f.dataStore.source.materialize()),peerView=new MutablePropertyView(peerStore.properties,'peer');useViewerStore.setState({models:new Map([...f.state.models,['peer',{...model,id:'peer',name:'peer.ifc',idOffset:1000000,ifcDataStore:peerStore}]]),mutationViews:new Map([...f.state.mutationViews,['peer',peerView]])});
 const {modelId:omitted,...target}=f.op.target;void omitted;assert.equal(previewModelAuthoring(useViewerStore.getState(),f.batch([{...f.op,target}])).rows[0].status,'ambiguous-target','both original roots exist before writing');
 const peerBefore=await graph(editedModelBytes(peerStore,peerView)),preview=previewModelAuthoring(useViewerStore.getState(),f.batch());assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');
 const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'explicit replacement owner');assert.ok(result.ok,result.ok?'':result.detail??result.reason);assert.deepEqual(await graph(editedModelBytes(peerStore,peerView)),peerBefore);
});
