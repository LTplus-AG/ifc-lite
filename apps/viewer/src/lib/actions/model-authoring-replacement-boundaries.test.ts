/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach,test } from 'node:test';
import { readWallJoinTarget } from '@ifc-lite/create';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { draftElementSize } from '@/lib/element-size-commit';
import { setElementDimensions } from '@/components/viewer/model-inspector/inspector-edits';
import { EMPTY_SOURCE_BYTES } from '@ifc-lite/parser';
import { StoreEditor,MutablePropertyView } from '@ifc-lite/mutations';
import { createModellingStoreBackend,resolveLiveOwnerHistoryId } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { replacementVariants,setupReplacementSource,replacementReviewParams } from '@/test/authoring-replacement-fixture';
import { SAMPLE_MODEL,GROUND_STOREY,FRONT_WALL_TYPE,FRONT_WALL_TYPE_NAME,parseIfc,danglingReferences } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { captureSelectionGrounding } from './selection-grounding';
import { captureEvidence } from '@/lib/assistant/evidence';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest';
import { effectiveStoreyId } from '@/lib/effective-storey';
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
test('#7320 genuine duplicate source Root identities refuse without conflating material Names',async()=>{
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

test('#7320 a genuine duplicate destination storey Root refuses without changing the source graph',async()=>{
 const f=await fixture(),editor=new StoreEditor(f.dataStore,f.view),record=f.dataStore.getEntity(f.storey);assert.ok(record);
 editor.addEntity('IfcBuildingStorey',record.attributes);const saved=await parseIfc(f.bytes());assert.equal([...saved.entityIndex.byId.keys()].filter(id=>saved.getEntity(id)?.type==='IFCBUILDINGSTOREY'&&saved.getEntity(id)?.attributes[0]===GROUND_STOREY).length,2);
 const before=await graph(f.bytes()),preview=previewModelAuthoring(useViewerStore.getState(),f.batch());assert.notEqual(preview.rows[0].status,'ready');assert.equal(commitModelAuthoring(useViewerStore,preview,new Set([0]),'ambiguous destination storey').ok,false);assert.deepEqual(await graph(f.bytes()),before);
});

test('#7320 bounded native evidence drops an entire oversized peer-membership pin rather than authorizing a prefix',async()=>{
 const f=await fixture(),ids=[f.made.expressId];for(let i=0;i<105;i++)ids.push(f.sdk.store.addWall(SAMPLE_MODEL,f.storey,{Start:[30+i,20,0],End:[30+i,25,0],Height:3,Thickness:.2}).expressId);
 const typeId=f.dataStore.entities.getExpressIdByGlobalId(FRONT_WALL_TYPE);assert.ok(typeId>0);const editor=new StoreEditor(f.dataStore,f.view),methods=createModellingStoreBackend(()=>({modelId:SAMPLE_MODEL,store:f.dataStore,editor,mutationView:f.view,ownerHistoryId:resolveLiveOwnerHistoryId(f.dataStore,editor,f.view)}));methods.assignType(SAMPLE_MODEL,typeId,ids);
 const saved=await parseIfc(f.bytes());const relation=[...saved.entityIndex.byId.keys()].map(id=>saved.getEntity(id)).find(row=>{const peers=row?.attributes[4];return row?.type==='IFCRELDEFINESBYTYPE'&&Array.isArray(peers)&&ids.every(id=>peers.includes(id));});assert.ok(relation,'independent STEP confirms every one of the106 supplied memberships and preserves pre-existing peers');
 useViewerStore.getState().setSelectedEntity({modelId:SAMPLE_MODEL,expressId:f.made.expressId});useViewerStore.getState().setSelectedEntityIds([f.made.expressId]);const attached=captureSelectionGrounding(useViewerStore.getState()).elements[0];assert.ok(attached?.nativeReplacementExpected);assert.deepEqual(attached.nativeReplacementExpected.types[0].relatedIds,relation.attributes[4]);
 const projected=JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data;assert.equal(projected.nativeReplacementExpected,null);assert.equal(projected.nativeAuthoringAvailability.replacement,'unavailable-projection');
});
test('#7320 selected committed SketchUp roof replacement availability is derived only from native STEP root and placement',async()=>{
 const {seedAuthoringSample}=await import('@/test/authoring-sample-fixture'),{dataStore,view}=await seedAuthoringSample();const id=425,source=await parseIfc(dataStore.source.materialize());assert.equal(source.entities.getGlobalId(id),'12UVOn4wvAJPMUExKdZLb8');assert.equal(source.entities.getTypeName(id),'IfcSlab');
 const model=useViewerStore.getState().models.get(SAMPLE_MODEL);assert.ok(model);useViewerStore.getState().updateModel(SAMPLE_MODEL,{maxExpressId:getMaxExpressId(dataStore,[])});
 const captured=captureSelectionGrounding({...useViewerStore.getState(),selectedEntityIds:new Set([id]),selectedEntityId:id}).elements[0];assert.ok(captured);
 assert.equal(effectiveStoreyId(source,new MutablePropertyView(source.properties,SAMPLE_MODEL),id),undefined,'the native source has no proven containment storey for this roof');
 assert.equal(captured.nativeReplacementExpected,null);assert.equal(captured.nativeAuthoringAvailability.replacement,'unavailable-native-layout');
 assert.equal(view.getMutationCount(),0,'native capture performs no authoring');
});

test('#7320 an actual native in-place dimension edit invalidates the old replacement expectation before approval',async()=>{
 const f=await fixture();assert.equal(setElementDimensions(SAMPLE_MODEL,f.made.expressId,{kind:'wall',height:4}),true);
 const exported=await parseIfc(f.bytes()),height=readWallJoinTarget(exported,new MutablePropertyView(exported.properties,SAMPLE_MODEL),f.made.expressId,getModelLengthUnitScale(exported))?.height;assert.equal(height,4,'independent native STEP proves the actual body changed');
 const before=await graph(f.bytes()),preview=previewModelAuthoring(useViewerStore.getState(),f.batch());assert.notEqual(preview.rows[0].status,'ready','a fresh preview may not authorize the old three-metre source pin after an in-place four-metre body edit');assert.equal(commitModelAuthoring(useViewerStore,preview,new Set([0]),'old body pin').ok,false);assert.deepEqual(await graph(f.bytes()),before);
});

for(const matching of [false,true])test(`#7320 preceding native resize ${matching?'accepts the explicitly captured current':'refuses the old'} full replacement shape`,async()=>{
 const f=await fixture(),resize={op:'element.resize',target:f.op.target,expected:{kind:'wall',height:3,thickness:.2},size:{kind:'wall',height:4}};
 const expected=f.view.prepareAtomic(view=>{const editor=new StoreEditor(f.dataStore,view),methods=createModellingStoreBackend(()=>({modelId:SAMPLE_MODEL,store:f.dataStore,editor,mutationView:view,ownerHistoryId:resolveLiveOwnerHistoryId(f.dataStore,editor,view)}));const made=draftElementSize(f.dataStore,editor,methods,SAMPLE_MODEL,f.made.expressId,{kind:'wall',height:4});assert.ok(made.ok,made.ok?'':made.reason);return captureSelectionGrounding({...useViewerStore.getState(),mutationViews:new Map([[SAMPLE_MODEL,view]]),selectedEntityIds:new Set([f.made.expressId]),selectedEntityId:f.made.expressId}).elements[0]?.nativeReplacementExpected;}).result;assert.ok(expected);assert.notDeepEqual(expected.shape,f.op.expected.shape,'the existing canonical shape reader proves the actual native dimension change');
 const before=await graph(f.bytes()),preview=previewModelAuthoring(useViewerStore.getState(),f.batch([resize,{...f.op,expected:matching?expected:f.op.expected}]));assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');
 if(!matching){assert.notEqual(preview.rows[1].status,'ready');assert.deepEqual(await graph(f.bytes()),before);return;}
 assert.equal(preview.rows[1].status,'ready',preview.rows[1].issue??'');const result=commitModelAuthoring(useViewerStore,preview,new Set([0,1]),'current native resized source');assert.ok(result.ok,result.ok?'':result.detail??result.reason);assert.deepEqual(undoModelChanges(useViewerStore,result.receipt),{ok:true});assert.deepEqual(await graph(f.bytes()),before);
});
test('#7320 independently reparsed four-metre source refuses the old three-metre pin even when native mutation revisions reset',async()=>{
 const f=await fixture();assert.equal(setElementDimensions(SAMPLE_MODEL,f.made.expressId,{kind:'wall',height:4}),true);const saved=await parseIfc(f.bytes()),view=new MutablePropertyView(saved.properties,SAMPLE_MODEL),model=useViewerStore.getState().models.get(SAMPLE_MODEL);assert.ok(model);assert.equal(view.getMutationRevision(),0);
 useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:saved}]]),mutationViews:new Map([[SAMPLE_MODEL,view]]),storeEditors:new Map()});const before=await graph(editedModelBytes(saved,view));assert.notEqual(previewModelAuthoring(useViewerStore.getState(),f.batch()).rows[0].status,'ready','full canonical geometry prevents a revision-only stale-source acceptance');assert.deepEqual(await graph(editedModelBytes(saved,view)),before);
});

test('#7320 saved single-flight replacement refuses a stale removed-flight metadata pin',async()=>{
 const f=await setupReplacementSource(replacementVariants[8]),state=useViewerStore.getState(),expected=captureSelectionGrounding({...state,selectedEntityIds:new Set([f.made.expressId]),selectedEntityId:f.made.expressId}).elements[0]?.nativeReplacementExpected;assert.ok(expected&&expected.shape.kind==='stair');const flight=expected.shape.expected.flightId;
 new StoreEditor(f.dataStore,f.view).setAttribute(flight,'Name','Current independently saved native flight');const saved=await parseIfc(editedModelBytes(f.dataStore,f.view));assert.equal(saved.entities.getName(flight),'Current independently saved native flight');const view=new MutablePropertyView(saved.properties,SAMPLE_MODEL),model=state.models.get(SAMPLE_MODEL);assert.ok(model);assert.equal(view.getMutationRevision(),0);useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:saved}]]),mutationViews:new Map([[SAMPLE_MODEL,view]]),storeEditors:new Map()});
 const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Explicit old native single-flight product',units:'m',frame:'storey-local',operations:[{op:'element.replace',ref:'new',target:{modelId:SAMPLE_MODEL,globalId:saved.entities.getGlobalId(f.made.expressId),ifcClass:'IfcStair',name:saved.entities.getName(f.made.expressId)},ifcClass:'IfcSlab',name:'Explicit new native slab',storey:{modelId:SAMPLE_MODEL,globalId:GROUND_STOREY},params:replacementReviewParams(replacementVariants[2]),expected}]}));
 const before=await graph(editedModelBytes(saved,view)),preview=previewModelAuthoring(useViewerStore.getState(),batch);assert.notEqual(preview.rows[0].status,'ready','the native writer removes both products, so saved current flight metadata must be bound too');assert.deepEqual(await graph(editedModelBytes(saved,view)),before);
 const current=captureSelectionGrounding({...useViewerStore.getState(),selectedEntityIds:new Set([f.made.expressId]),selectedEntityId:f.made.expressId}).elements[0]?.nativeReplacementExpected;assert.ok(current);assert.equal(current.companions.length,1);assert.equal(current.companions[0].record.attributes[2],'Current independently saved native flight');const matching=parseModelAuthoringBatch(JSON.stringify({...batch,operations:[{...batch.operations[0],expected:current}]})),approved=previewModelAuthoring(useViewerStore.getState(),matching);assert.equal(approved.rows[0].status,'ready',approved.rows[0].issue??'');const result=commitModelAuthoring(useViewerStore,approved,new Set([0]),'current native Stair companion');assert.ok(result.ok,result.ok?'':result.detail??result.reason);assert.deepEqual(undoModelChanges(useViewerStore,result.receipt),{ok:true});assert.deepEqual(await graph(editedModelBytes(saved,view)),before);
});


test('#7320 compact native selection preserves metadata budget while explicit attachment retains complete replacement pins',async()=>{
 const f=await fixture();
 const ids=[f.made.expressId,...[...f.dataStore.entityIndex.byId.keys()].filter(id=>id!==f.made.expressId&&Boolean(f.dataStore.entities.getGlobalId(id))).slice(0,10)];
 assert.equal(ids.length,11,'real parsed native roots supply the compact selection population');
 useViewerStore.getState().setSelectedEntityIds(ids);
 const compact=JSON.parse(captureEvidence('selection').payload).evidence;
 assert.equal(compact.summary.nativeReplacementCapture,'unavailable-selection-budget');
 const row=compact.rows.find((row:{data:{expressId:number}})=>row.data.expressId===f.made.expressId);assert.ok(row);
 assert.equal('nativeReplacementExpected'in row.data,false);
 assert.equal('replacement'in row.data.nativeAuthoringUnits,false);
 assert.equal('replacement'in row.data.nativeAuthoringAvailability,false);
 const explicit=captureSelectionGrounding({...useViewerStore.getState(),selectedEntityIds:new Set([f.made.expressId]),selectedEntityId:f.made.expressId}).elements[0];
 assert.deepEqual(explicit?.nativeReplacementExpected,f.evidence.nativeReplacementExpected,'complete current parsed native pin survives explicit attachment');
 useViewerStore.getState().setSelectedEntityIds([f.made.expressId]);
 const rich=JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data;
 assert.deepEqual(rich.nativeReplacementExpected,f.evidence.nativeReplacementExpected,'rich transport retains the same complete pin');
});
