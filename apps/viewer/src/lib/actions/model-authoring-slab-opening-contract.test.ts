/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { EMPTY_SOURCE_BYTES } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { readHostOpeningExtents } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { configureMutationView } from '@/utils/configureMutationView';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { GROUND_STOREY, SAMPLE_MODEL, parseIfc, seedAuthoringSample, danglingReferences } from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { undoModelChanges } from './model-change-commit';
import { authoringReader } from './model-authoring-read';
import { draftAuthoringOperation } from './model-authoring-native';
import { readAuthoringSizeFromTarget } from './model-authoring-size';
import { readSplitSnapshot } from './model-authoring-split-state';
import { captureSelectionGrounding } from './selection-grounding';
function slabEvidence(id:number){const row=captureSelectionGrounding({...useViewerStore.getState(),selectedEntityIds:new Set([id]),selectedEntityId:id}).elements[0];assert.ok(row,'the native selected host resolves');return {units:row.nativeAuthoringUnits.slabOpening,status:row.nativeAuthoringAvailability.slabOpening,expected:row.nativeSlabOpeningExpected};}
const initial=useViewerStore.getState();
afterEach(()=>useViewerStore.setState(initial));
async function fixture(polygon=false) {
 const {dataStore,view}=await seedAuthoringSample();
 const storey=dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
 const made=useViewerStore.getState().addSlab(SAMPLE_MODEL,storey,polygon
  ? {Profile:'polygon',OuterCurve:[[0,0],[6,0],[6,2],[4,2],[4,4],[0,4]],Position:[20,20,3],Thickness:.25,Name:'Reviewed polygon slab'}
  : {Position:[20,20,3],Width:6,Depth:4,Thickness:.25,Name:'Reviewed rectangle slab'});
 assert.ok('expressId' in made,'error' in made?made.error:'');
 const saved=await parseIfc(editedModelBytes(dataStore,view)),id=made.expressId;
 const r=authoringReader(useViewerStore.getState(),SAMPLE_MODEL);assert.ok(r);
 const expected=readSplitSnapshot(dataStore,r.editor,id,'m');
 const host={modelId:SAMPLE_MODEL,globalId:saved.entities.getGlobalId(id),ifcClass:'IfcSlab',name:saved.entities.getName(id)};
 const operation={op:'hosted.create',kind:'opening',host,expected,params:{Position:[2,1],Width:1,Depth:.8,CutDepth:.5}};
 const batch=(operations:unknown[]=[operation])=>parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Native slab contract',units:'m',frame:'storey-local',operations}));
 return {dataStore,view,saved,id,host,expected,operation,batch};
}
async function graph(store: Awaited<ReturnType<typeof parseIfc>>,view:MutablePropertyView) {
 const parsed=await parseIfc(editedModelBytes(store,view));return [...parsed.entityIndex.byId.keys()].sort((a,b)=>a-b).map(id=>({id,...parsed.getEntity(id)}));
}
for(const polygon of [false,true])test(`#7310 native ${polygon?'polygon':'rectangle'} slab complete expected snapshot preserves host metadata and cut depth`,async()=>{
 const f=await fixture(polygon),preview=previewModelAuthoring(useViewerStore.getState(),f.batch());
 assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue);
 assert.equal(preview.rows[0].previewUnavailable,false,'review draws the native cutter only on its supported storey frame');
 const before=await graph(f.dataStore,f.view),result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'complete slab expectation');assert.ok(result.ok,result.ok?'':result.detail??result.reason);
 const bytes=editedModelBytes(f.dataStore,f.view),after=await parseIfc(bytes),cuts=readHostOpeningExtents(after,f.id);
 assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)),[]);
 assert.deepEqual(after.getEntity(f.id)?.attributes,f.saved.getEntity(f.id)?.attributes,'the native opening preserves the original host identity and representation');
 assert.equal(cuts.cuts.length,1);assert.deepEqual(cuts.unreadable,[]);
 assert.equal(cuts.cuts[0].bounds.max[2]-cuts.cuts[0].bounds.min[2],500,'explicit CutDepth is written in native model millimetres exactly once');
 assert.deepEqual(undoModelChanges(useViewerStore,result.receipt),{ok:true});
 assert.deepEqual(await graph(f.dataStore,f.view),before,'one grouped Undo restores every independently parsed native entity');
});
for(const stale of ['snapshot','revision','source'] as const)test(`#7310 ${stale} approval cannot write a stale native slab cut`,async()=>{
 const f=await fixture();
 const batch=stale==='snapshot'?f.batch([{...f.operation,expected:{...f.expected,storeyId:f.expected.storeyId+1}}]):f.batch();
 const preview=previewModelAuthoring(useViewerStore.getState(),batch);
 if(stale==='snapshot')assert.notEqual(preview.rows[0].status,'ready');
 else {
  assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue);
  if(stale==='revision')f.view.setAttribute(f.id,'Description','Independent edit after approval');
  else {const state=useViewerStore.getState(),model=state.models.get(SAMPLE_MODEL);assert.ok(model);const replacement=await parseIfc(f.dataStore.source.materialize());useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:replacement}]])});}
 }
 const before=await graph(f.dataStore,f.view);
 assert.equal(commitModelAuthoring(useViewerStore,preview,new Set([0]),'stale slab approval').ok,false);
 assert.deepEqual(await graph(f.dataStore,f.view),before);
});
test('#7310 valid source-empty transport refuses both current slab evidence and reviewed writes',async()=>{
 const f=await fixture(),state=useViewerStore.getState(),model=state.models.get(SAMPLE_MODEL);assert.ok(model);
 useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:{...f.dataStore,source:EMPTY_SOURCE_BYTES}}]])});
 const reader=authoringReader(useViewerStore.getState(),SAMPLE_MODEL);assert.ok(reader);
 assert.deepEqual(slabEvidence(f.id),{units:'m',status:'unavailable-native-layout',expected:null});
 const before=await graph(f.dataStore,f.view),preview=previewModelAuthoring(useViewerStore.getState(),f.batch());
 assert.notEqual(preview.rows[0].status,'ready');assert.match(preview.rows[0].issue??'',/source|IFC/i);
 assert.equal(commitModelAuthoring(useViewerStore,preview,new Set([0]),'missing slab source').ok,false);
 assert.deepEqual(await graph(f.dataStore,f.view),before);
});
test('#7310 saved first-read slab preview and evidence preserve a held native transaction lease',async()=>{
 const f=await fixture(),state=useViewerStore.getState(),model=state.models.get(SAMPLE_MODEL);assert.ok(model);
 const view=new MutablePropertyView(f.saved.properties,SAMPLE_MODEL);configureMutationView(view,f.saved);
 useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:f.saved,maxExpressId:Math.max(...f.saved.entityIndex.byId.keys())}]]),mutationViews:new Map([[SAMPLE_MODEL,view]]),storeEditors:new Map()});
 const prepared=view.prepareAtomic(()=>undefined),preview=previewModelAuthoring(useViewerStore.getState(),f.batch());
 assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue);
 const reader=authoringReader(useViewerStore.getState(),SAMPLE_MODEL);assert.ok(reader);assert.equal(slabEvidence(f.id).status,'available');
 assert.doesNotThrow(()=>prepared.validate(),'native snapshot reads never invalidate another prepared edit');
 assert.equal(useViewerStore.getState().storeEditors.size,0,'preview does not install a live editor');
});
test('#7310 owning model isolates identical slab GlobalIds in two real native sources',async()=>{
 const f=await fixture(),state=useViewerStore.getState(),model=state.models.get(SAMPLE_MODEL);assert.ok(model);
 const peerView=new MutablePropertyView(f.saved.properties,'peer');
 useViewerStore.setState({models:new Map([...state.models,['peer',{...model,id:'peer',name:'peer.ifc',idOffset:1000000,ifcDataStore:f.saved}]]),mutationViews:new Map([...state.mutationViews,['peer',peerView]])});
 const peerBefore=await graph(f.saved,peerView),preview=previewModelAuthoring(useViewerStore.getState(),f.batch());assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue);assert.equal(preview.rows[0].modelId,SAMPLE_MODEL);
 const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'owning slab model');assert.ok(result.ok,result.ok?'':result.detail??result.reason);
 assert.equal(readHostOpeningExtents(await parseIfc(editedModelBytes(f.dataStore,f.view)),f.id).cuts.length,1);
 assert.deepEqual(await graph(f.saved,peerView),peerBefore,'same-GUID peer keeps its complete native graph');
 const {modelId:ignored,...unscoped}=f.host;void ignored;
 const ambiguous=previewModelAuthoring(useViewerStore.getState(),f.batch([{...f.operation,host:unscoped}]));assert.equal(ambiguous.rows[0].status,'ambiguous-target');
});
test('#7310 genuine duplicate slab Root GlobalId refuses evidence, preview and direct intermediate writing',async()=>{
 const f=await fixture(),editor=new StoreEditor(f.dataStore,f.view),record=f.view.getNewEntity(f.id);assert.ok(record);
 const duplicate=editor.addEntity('IfcSlab',record.attributes);const saved=await parseIfc(editedModelBytes(f.dataStore,f.view));
 assert.equal(saved.getEntity(duplicate.expressId)?.attributes[0],f.host.globalId,'independent STEP proves the genuine Root collision');
 const r=authoringReader(useViewerStore.getState(),SAMPLE_MODEL);assert.ok(r);assert.equal(slabEvidence(f.id).status,'unavailable-native-layout');
 const before=await graph(f.dataStore,f.view),batch=f.batch(),op=batch.operations[0];assert.ok(op.op==='hosted.create'&&'params' in op);
 assert.notEqual(previewModelAuthoring(useViewerStore.getState(),batch).rows[0].status,'ready');
 assert.throws(()=>editor.runAtomic(draft=>draftAuthoringOperation(batch,f.dataStore,SAMPLE_MODEL,draft,{index:0,op,resolved:{host:{id:f.id}}},new Map())),/GlobalId is not unique/);
 assert.deepEqual(await graph(f.dataStore,f.view),before);
});
test('#7310 intermediate native slab resize requires and accepts the exact current draft snapshot',async()=>{
 const f=await fixture(),reader=authoringReader(useViewerStore.getState(),SAMPLE_MODEL);assert.ok(reader);
 const expected=readAuthoringSizeFromTarget(reader,f.id,'slab');assert.ok(expected);
 const resize={op:'element.resize',target:f.host,expected,size:{kind:'slab',thickness:.4}};
 const batch=f.batch([resize,f.operation]),stale=previewModelAuthoring(useViewerStore.getState(),batch);
 assert.equal(stale.rows[0].status,'ready',stale.rows[0].issue);assert.notEqual(stale.rows[1].status,'ready','native earlier resize invalidates the bound source dimensions');
 const current=f.view.prepareAtomic(view=>{
  const editor=new StoreEditor(f.dataStore,view);
  draftAuthoringOperation(batch,f.dataStore,SAMPLE_MODEL,editor,stale.rows[0],new Map());
  return readSplitSnapshot(f.dataStore,editor,f.id,'m');
 }).result;
 const matching=previewModelAuthoring(useViewerStore.getState(),f.batch([resize,{...f.operation,expected:current}]));
 assert.deepEqual(matching.rows.map(row=>[row.status,row.issue]),[['ready',undefined],['ready',undefined]]);
 const before=await graph(f.dataStore,f.view),result=commitModelAuthoring(useViewerStore,matching,new Set([0,1]),'intermediate native slab binding');assert.ok(result.ok,result.ok?'':result.detail??result.reason);
 const saved=await parseIfc(editedModelBytes(f.dataStore,f.view));assert.equal(readHostOpeningExtents(saved,f.id).cuts.length,1);
 assert.deepEqual(undoModelChanges(useViewerStore,result.receipt),{ok:true});assert.deepEqual(await graph(f.dataStore,f.view),before);
});
for(const shape of ['rectangle','polygon'] as const)test(`#7310 earlier reviewed ${shape} slab reference binds to the canonical current draft`,async()=>{
 await seedAuthoringSample();
 const params=shape==='rectangle'?{position:[20,20,3],width:6,depth:4,thickness:.25}:{Profile:'polygon',OuterCurve:[[0,0],[6,0],[6,2],[4,2],[4,4],[0,4]],position:[20,20,3],thickness:.25};
 const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Create native slab and opening',units:'m',frame:'storey-local',operations:[
  {op:'element.create',ref:'slab',ifcClass:'IfcSlab',name:'Created reviewed slab',storey:{modelId:SAMPLE_MODEL,globalId:GROUND_STOREY,name:'00 groundfloor'},params},
  {op:'hosted.create',kind:'opening',host:{ref:'slab'},params:{Position:[2,1],Width:1,Depth:.8}}]}));
 const preview=previewModelAuthoring(useViewerStore.getState(),batch);assert.deepEqual(preview.rows.map(row=>[row.status,row.issue]),[['ready',undefined],['ready',undefined]]);
 const result=commitModelAuthoring(useViewerStore,preview,new Set([0,1]),'native slab ref');assert.ok(result.ok,result.ok?'':result.detail??result.reason);
 const state=useViewerStore.getState(),store=state.models.get(SAMPLE_MODEL)?.ifcDataStore,view=state.mutationViews.get(SAMPLE_MODEL);assert.ok(store&&view);
 const saved=await parseIfc(editedModelBytes(store,view)),hostId=saved.entities.getExpressIdByGlobalId(result.receipt.applied[0].globalId);
 assert.equal(readHostOpeningExtents(saved,hostId).cuts.length,1);assert.deepEqual(danglingReferences(new TextDecoder().decode(editedModelBytes(store,view))),[]);
 assert.deepEqual(undoModelChanges(useViewerStore,result.receipt),{ok:true});assert.equal((await parseIfc(editedModelBytes(store,view))).entities.getExpressIdByGlobalId(result.receipt.applied[0].globalId),-1);
});
for(const fields of [{Width:0},{Depth:-1},{CutDepth:.1}] as const)test(`#7310 native slab invalid dimensions ${JSON.stringify(fields)} retain canonical refusal`,async()=>{
 const f=await fixture(),operation={...f.operation,params:{...f.operation.params,...fields}},before=await graph(f.dataStore,f.view);
 if('CutDepth' in fields){
  const batch=f.batch([operation]),preview=previewModelAuthoring(useViewerStore.getState(),batch);assert.notEqual(preview.rows[0].status,'ready');assert.match(preview.rows[0].issue??'',/depth|thickness/i);
  assert.equal(commitModelAuthoring(useViewerStore,preview,new Set([0]),'native insufficient cut').ok,false);
 }else assert.throws(()=>f.batch([operation]),/positive|Width|Depth/);
 assert.deepEqual(await graph(f.dataStore,f.view),before,'the native graph is unchanged after dimension refusal');
});
for(const write of ['named-metadata','positional'] as const)test(`#7310 current ${write} saved placement edit is explicitly bound before a native slab cut`,async()=>{
 const f=await fixture(),store=f.saved,view=new MutablePropertyView(store.properties,SAMPLE_MODEL);configureMutationView(view,store);
 const state=useViewerStore.getState(),model=state.models.get(SAMPLE_MODEL);assert.ok(model);
 useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:store,maxExpressId:Math.max(...store.entityIndex.byId.keys())}]]),mutationViews:new Map([[SAMPLE_MODEL,view]]),storeEditors:new Map()});
 const editor=new StoreEditor(store,view),entity=store.getEntity(f.id);assert.ok(entity);
 const local=store.getEntity(Number(entity.attributes[5]));assert.ok(local);const axis=store.getEntity(Number(local.attributes[1]));assert.ok(axis);
 const pointId=Number(axis.attributes[0]);
 if(write==='named-metadata')editor.setAttribute(f.id,'Name','Current named slab host');else editor.setPositionalAttribute(pointId,0,[22000,21000,3000]);
 const saved=await parseIfc(editedModelBytes(store,view));if(write==='named-metadata')assert.equal(saved.entities.getName(f.id),'Current named slab host');else assert.deepEqual(saved.getEntity(pointId)?.attributes[0],[22000,21000,3000],'actual native export confirms the edited placement');
 const stale=previewModelAuthoring(useViewerStore.getState(),f.batch());assert.notEqual(stale.rows[0].status,'ready');
 const current=readSplitSnapshot(store,editor,f.id,'m'),preview=previewModelAuthoring(useViewerStore.getState(),f.batch([{...f.operation,host:{...f.host,name:saved.entities.getName(f.id)},expected:current}]));assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue);
 const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'current native slab placement');assert.ok(result.ok,result.ok?'':result.detail??result.reason);
 assert.equal(readHostOpeningExtents(await parseIfc(editedModelBytes(store,view)),f.id).cuts.length,1);
});
test('#7310 a native nested host remains authorable with an explicitly unavailable cutter frame',async()=>{
 const f=await fixture(),editor=new StoreEditor(f.dataStore,f.view);
 const point=editor.addEntity('IfcCartesianPoint',[[100000,0,0]]),axis=editor.addEntity('IfcAxis2Placement3D',[`#${point.expressId}`,null,null]);
 const parent=editor.addEntity('IfcLocalPlacement',[`#${f.expected.placement.parent}`,`#${axis.expressId}`]);
 const host=f.view.getNewEntity(f.id);assert.ok(host);const localId=Number(String(host.attributes[5]).slice(1));editor.setPositionalAttribute(localId,0,`#${parent.expressId}`);
 const saved=await parseIfc(editedModelBytes(f.dataStore,f.view));assert.deepEqual(saved.getEntity(point.expressId)?.attributes[0],[100000,0,0]);assert.equal(saved.getEntity(localId)?.attributes[0],parent.expressId);
 const expected=readSplitSnapshot(f.dataStore,editor,f.id,'m'),preview=previewModelAuthoring(useViewerStore.getState(),f.batch([{...f.operation,expected}]));assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue);assert.equal(preview.rows[0].previewUnavailable,true,'no storey-local marker can conceal a real nested +100m parent');
 const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'native nested slab');assert.ok(result.ok,result.ok?'':result.detail??result.reason);
 const after=await parseIfc(editedModelBytes(f.dataStore,f.view));assert.equal(readHostOpeningExtents(after,f.id).cuts.length,1);assert.equal(after.getEntity(localId)?.attributes[0],parent.expressId,'native commit preserves the actual parent frame');
});

test('#7310 unreadable current native snapshot never attests a named placement retarget as the old frame',async()=>{
 const f=await fixture(),store=f.saved,view=new MutablePropertyView(store.properties,SAMPLE_MODEL);configureMutationView(view,store);
 const state=useViewerStore.getState(),model=state.models.get(SAMPLE_MODEL);assert.ok(model);
 useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:store,maxExpressId:Math.max(...store.entityIndex.byId.keys())}]]),mutationViews:new Map([[SAMPLE_MODEL,view]]),storeEditors:new Map()});
 const editor=new StoreEditor(store,view),host=store.getEntity(f.id);assert.ok(host);const localId=Number(host.attributes[5]);
 const point=editor.addEntity('IfcCartesianPoint',[[22000,21000,3000]]),axis=editor.addEntity('IfcAxis2Placement3D',[`#${point.expressId}`,null,null]);
 editor.setAttribute(localId,'RelativePlacement',`#${axis.expressId}`);
 const saved=await parseIfc(editedModelBytes(store,view));assert.equal(saved.getEntity(localId)?.attributes[1],axis.expressId,'the public named edit changes the actual exported placement');
 assert.deepEqual(saved.getEntity(point.expressId)?.attributes[0],[22000,21000,3000]);
 const preview=previewModelAuthoring(useViewerStore.getState(),f.batch());
 assert.notEqual(preview.rows[0].status,'ready','an old native frame cannot authorize a current retargeted placement');
 assert.deepEqual(slabEvidence(f.id),{units:'m',status:'unavailable-native-layout',expected:null});
 const before=await graph(store,view);assert.equal(commitModelAuthoring(useViewerStore,preview,new Set([0]),'unavailable named frame').ok,false);assert.deepEqual(await graph(store,view),before);
 // Independently saving/reparsing supplies the inherited reader's actual
 // current native source. That source is supported without another resolver.
 const savedView=new MutablePropertyView(saved.properties,SAMPLE_MODEL);configureMutationView(savedView,saved);
 useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:saved,maxExpressId:Math.max(...saved.entityIndex.byId.keys())}]]),mutationViews:new Map([[SAMPLE_MODEL,savedView]]),storeEditors:new Map()});
 const current=readSplitSnapshot(saved,new StoreEditor(saved,savedView),f.id,'m'),ready=previewModelAuthoring(useViewerStore.getState(),f.batch([{...f.operation,expected:current}]));assert.equal(ready.rows[0].status,'ready',ready.rows[0].issue);
 const result=commitModelAuthoring(useViewerStore,ready,new Set([0]),'independently saved current frame');assert.ok(result.ok,result.ok?'':result.detail??result.reason);assert.equal(readHostOpeningExtents(await parseIfc(editedModelBytes(saved,savedView)),f.id).cuts.length,1);
});
