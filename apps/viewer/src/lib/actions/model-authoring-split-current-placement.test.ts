/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach,test } from 'node:test';
import { setSourceAttrsReader,resolvePlacementChain } from '../../../../../packages/create/src/in-store/edit/placement-core';
import { authoringReader } from './model-authoring-read';
import { configureMutationView } from '@/utils/configureMutationView';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { seedModelingSession,MODEL_ID,STOREY } from '@/test/modeling-session-fixture';
import { StoreEditor,MutablePropertyView } from '@ifc-lite/mutations';
import { EMPTY_SOURCE_BYTES } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { seedAuthoringSample,parseIfc,SAMPLE_MODEL,GROUND_STOREY } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { readSplitSnapshot } from './model-authoring-split-state';
const initial=useViewerStore.getState();afterEach(()=>useViewerStore.setState(initial));
async function fixture(kind: 'slab'|'column'='slab'){
 const {dataStore,view}=await seedAuthoringSample(),storeyId=dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
 const made=kind==='slab'?useViewerStore.getState().addSlab(SAMPLE_MODEL,storeyId,{Position:[20,20,3],Width:6,Depth:4,Thickness:.25,Name:'Current native placement'}):useViewerStore.getState().addColumn(SAMPLE_MODEL,storeyId,{Position:[20,20,3],Width:.2,Depth:.8,Height:8,Name:'Current native column'});assert.ok('expressId' in made,'error' in made?made.error:'');
 const store=await parseIfc(editedModelBytes(dataStore,view)),currentView=new MutablePropertyView(store.properties,SAMPLE_MODEL),editor=new StoreEditor(store,currentView);
 const original=store.getEntity(made.expressId);assert.ok(original);const localId=Number(original.attributes[5]);assert.ok(store.getEntity(localId));
 return {store,view:currentView,editor,id:made.expressId,localId};
}
for(const slot of ['RelativePlacement','ObjectPlacement'] as const)for(const mode of ['named','positional'] as const)
test(`#7315 real native ${mode} ${slot} retarget snapshot agrees with independently exported current axis`,async()=>{
 const f=await fixture(),old=readSplitSnapshot(f.store,f.editor,f.id,'m');
 const point=f.editor.addEntity('IfcCartesianPoint',[[22000,21000,3000]]),direction=f.editor.addEntity('IfcDirection',[[1,0,0]]),axis=f.editor.addEntity('IfcAxis2Placement3D',[`#${point.expressId}`,null,`#${direction.expressId}`]);
 const target=slot==='RelativePlacement'?f.localId:f.id;
 const reference=slot==='RelativePlacement'?axis.expressId:f.editor.addEntity('IfcLocalPlacement',[f.store.getEntity(f.localId)?.attributes[0],`#${axis.expressId}`]).expressId;
 if(mode==='named')f.editor.setAttribute(target,slot,`#${reference}`);else f.editor.setPositionalAttribute(target,slot==='RelativePlacement'?1:5,`#${reference}`);
 const saved=await parseIfc(editedModelBytes(f.store,f.view)),savedEditor=new StoreEditor(saved,new MutablePropertyView(saved.properties,SAMPLE_MODEL));
 assert.equal(Number(saved.getEntity(target)?.attributes[slot==='RelativePlacement'?1:5]),reference,'public STEP export proves the exact native reference edit');
 const expected=readSplitSnapshot(saved,savedEditor,f.id,'m');assert.deepEqual(expected.placement.frame.o,[22,21,3]);assert.deepEqual(expected.placement.frame.x,[1,0,0]);assert.notDeepEqual(expected.placement,old.placement);
 assert.deepEqual(readSplitSnapshot(f.store,f.editor,f.id,'m').placement,expected.placement,'current native parent/basis must match the independently reparsed source');
});
test('#7315 full native snapshot chain follows the same current named axis as its placement',async()=>{
 const f=await fixture(),point=f.editor.addEntity('IfcCartesianPoint',[[22000,21000,3000]]),axis=f.editor.addEntity('IfcAxis2Placement3D',[`#${point.expressId}`,null,null]);
 f.editor.setAttribute(f.localId,'RelativePlacement',`#${axis.expressId}`);
 const saved=await parseIfc(editedModelBytes(f.store,f.view)),savedEditor=new StoreEditor(saved,new MutablePropertyView(saved.properties,SAMPLE_MODEL));
 assert.deepEqual(readSplitSnapshot(f.store,f.editor,f.id,'m').chain,readSplitSnapshot(saved,savedEditor,f.id,'m').chain,'native shape-chain provenance and placement origin must use the same effective reference');
});
test('#7315 current named parent cycle is refused rather than attested as a native basis',async()=>{
 const f=await fixture();f.editor.setAttribute(f.localId,'PlacementRelTo',`#${f.localId}`);
 const saved=await parseIfc(editedModelBytes(f.store,f.view));assert.equal(saved.getEntity(f.localId)?.attributes[0],f.localId,'the public native export proves the cyclic reference');
 assert.throws(()=>readSplitSnapshot(f.store,f.editor,f.id,'m'),/placement|basis|shape|Split/i,'a live named cycle must refuse just as an independently saved cycle does');
});

for(const mode of ['named','positional'] as const)test(`#7315 current ${mode} native column Axis belongs to both full shape chain and basis`,async()=>{
 const f=await fixture('column'),axisId=Number(f.store.getEntity(f.localId)?.attributes[1]),direction=f.editor.addEntity('IfcDirection',[[1,0,1]]);
 if(mode==='named')f.editor.setAttribute(axisId,'Axis',`#${direction.expressId}`);else f.editor.setPositionalAttribute(axisId,1,`#${direction.expressId}`);
 const saved=await parseIfc(editedModelBytes(f.store,f.view));assert.equal(saved.getEntity(axisId)?.attributes[1],direction.expressId,'public native export proves the current column axis');
 const savedEditor=new StoreEditor(saved,new MutablePropertyView(saved.properties,SAMPLE_MODEL)),expected=readSplitSnapshot(saved,savedEditor,f.id,'m'),current=readSplitSnapshot(f.store,f.editor,f.id,'m');
 assert.equal(expected.kind,'linear');assert.deepEqual(current.placement,expected.placement,'existing canonical frame reader already honors the current named direction');
 assert.deepEqual(current.chain,expected.chain,'native linear shape-chain direction must agree with its current frame');
});

test('#7315 effective placement retains a real custom source callback and its source-disabled contract',async()=>{
 const f=await fixture(),point=f.editor.addEntity('IfcCartesianPoint',[[22000,21000,3000]]),axis=f.editor.addEntity('IfcAxis2Placement3D',[`#${point.expressId}`,null,null]);
 f.editor.setAttribute(f.localId,'RelativePlacement',`#${axis.expressId}`);let calls=0;
 const actualSource=(store:typeof f.store,id:number)=>{calls++;return store.getEntity(id)?.attributes??null;};
 try {
  setSourceAttrsReader(actualSource);assert.deepEqual(readSplitSnapshot(f.store,f.editor,f.id,'m').placement.frame.o,[22,21,3]);assert.ok(calls>0,'the native callback actually supplied source attributes');
  setSourceAttrsReader(null);assert.equal(resolvePlacementChain(f.store,f.view,f.editor,f.id),null,'disabling source access must not introduce another source decode path');
 }finally{setSourceAttrsReader((store,id)=>store.source.byteLength>0?store.getEntity(id)?.attributes??null:null);}
});
test('#7315 deleted saved native placement leaf refuses rather than falling back to source attributes',async()=>{
 const f=await fixture(),axis=Number(f.store.getEntity(f.localId)?.attributes[1]);f.editor.removeEntity(axis);
 const saved=await parseIfc(editedModelBytes(f.store,f.view));assert.equal(saved.getEntity(axis),null,'independent native STEP proves the source leaf deletion');
 assert.throws(()=>readSplitSnapshot(f.store,f.editor,f.id,'m'),/Split|placement|basis|shape/i);
});
test('#7315 first current named placement capture preserves the actual prepared source-view lease',async()=>{
 const f=await fixture(),point=f.editor.addEntity('IfcCartesianPoint',[[22000,21000,3000]]),axis=f.editor.addEntity('IfcAxis2Placement3D',[`#${point.expressId}`,null,null]);f.editor.setAttribute(f.localId,'RelativePlacement',`#${axis.expressId}`);
 configureMutationView(f.view,f.store);const model=useViewerStore.getState().models.get(SAMPLE_MODEL);assert.ok(model);
 useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:f.store,maxExpressId:Math.max(...f.store.entityIndex.byId.keys())}]]),mutationViews:new Map([[SAMPLE_MODEL,f.view]]),storeEditors:new Map()});
 const held=f.view.prepareAtomic(()=>undefined),revision=f.view.getMutationRevision(),count=f.view.getMutationCount();
 const reader=authoringReader(useViewerStore.getState(),SAMPLE_MODEL);assert.ok(reader);assert.deepEqual(readSplitSnapshot(f.store,reader.editor,f.id,'m').placement.frame.o,[22,21,3]);
 assert.doesNotThrow(()=>held.validate(),'pure source capture cannot revoke an existing prepared transaction');assert.equal(f.view.getMutationRevision(),revision);assert.equal(f.view.getMutationCount(),count);assert.equal(useViewerStore.getState().storeEditors.size,0);
});

for(const unit of ['metre','millimetre'] as const)for(const declared of ['m','mm'] as const)test(`#7315 native ${unit} current snapshot refuses the old source in declared ${declared}`,async()=>{
 const view=await seedModelingSession({unit}),state=useViewerStore.getState(),store=state.models.get(MODEL_ID)?.ifcDataStore;assert.ok(store);
 const made=state.addSlab(MODEL_ID,STOREY,{Position:[20,20,3],Width:6,Depth:4,Thickness:.25,Name:'Bound native frame'});assert.ok('expressId' in made,'error' in made?made.error:'');
 const reader=authoringReader(useViewerStore.getState(),MODEL_ID);assert.ok(reader);const old=readSplitSnapshot(store,reader.editor,made.expressId,declared),editor=new StoreEditor(store,view),factor=unit==='millimetre'?1000:1;
 const local=Number(view.getNewEntity(made.expressId)?.attributes[5]?.toString().slice(1));assert.ok(view.getNewEntity(local));
 const point=editor.addEntity('IfcCartesianPoint',[[22*factor,21*factor,3*factor]]),axis=editor.addEntity('IfcAxis2Placement3D',[`#${point.expressId}`,null,null]);editor.setAttribute(local,'RelativePlacement',`#${axis.expressId}`);
 const native=await parseIfc(editedModelBytes(store,view));assert.equal(native.getEntity(local)?.attributes[1],axis.expressId);
 const fresh=authoringReader(useViewerStore.getState(),MODEL_ID);assert.ok(fresh);const expected=readSplitSnapshot(store,fresh.editor,made.expressId,declared),k=declared==='mm'?1000:1;
 assert.deepEqual(expected.placement.frame.o,[22*k,21*k,3*k]);assert.notDeepEqual(expected,old);
 const target={modelId:MODEL_ID,globalId:native.entities.getGlobalId(made.expressId),ifcClass:'IfcSlab',name:'Bound native frame'},cut={kind:'slab',a:[24*k,-100*k],b:[24*k,100*k]};
 const batch=(snapshot:typeof expected)=>parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Current native source pin',units:declared,frame:'storey-local',operations:[{op:'element.split',target,expected:snapshot,cut}]}));
 const before=view.getMutationCount(),stale=previewModelAuthoring(useViewerStore.getState(),batch(old));assert.notEqual(stale.rows[0].status,'ready','the old placement cannot authorize a native cut after the public named edit');
 const current=previewModelAuthoring(useViewerStore.getState(),batch(expected));assert.equal(current.rows[0].status,'ready',current.rows[0].issue);assert.equal(view.getMutationCount(),before,'native reviewed source capture stays unpublished');
});

test('#7315 source-free original placement remains unreadable even with a retained native getter',async()=>{
 const f=await fixture();assert.ok(f.store.getEntity(f.localId));f.store.source=EMPTY_SOURCE_BYTES;
 assert.throws(()=>readSplitSnapshot(f.store,f.editor,f.id,'m'),/Split|placement|basis|shape/i,'original source geometry cannot be reconstructed through a retained closure');
});
test('#7315 current native parent walk accepts a finite chain and explicitly refuses an oversized one',async()=>{
 const f=await fixture(),axis=Number(f.store.getEntity(f.localId)?.attributes[1]);let parent=Number(f.store.getEntity(f.localId)?.attributes[0]);
 for(let i=0;i<128;i++)parent=f.editor.addEntity('IfcLocalPlacement',[`#${parent}`,`#${axis}`]).expressId;
 f.editor.setAttribute(f.localId,'PlacementRelTo',`#${parent}`);assert.equal(readSplitSnapshot(f.store,f.editor,f.id,'m').placement.parent,parent,'a valid finite source chain remains readable');
 for(let i=128;i<10001;i++)parent=f.editor.addEntity('IfcLocalPlacement',[`#${parent}`,`#${axis}`]).expressId;
 f.editor.setAttribute(f.localId,'PlacementRelTo',`#${parent}`);const revision=f.view.getMutationRevision();
 assert.throws(()=>readSplitSnapshot(f.store,f.editor,f.id,'m'),/Split|placement|basis|shape/i,'bounded traversal must report unavailable rather than truncate a successful parent');assert.equal(f.view.getMutationRevision(),revision);
});
