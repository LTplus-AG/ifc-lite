/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #7284: native public writes and independently decoded STEP establish current identities.
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import {StoreEditor} from '@ifc-lite/mutations';
import {generateIfcGuid} from '@ifc-lite/encoding';
import {effectiveMetadataRecord} from '@ifc-lite/parser';
import {useViewerStore} from '@/store';
import {seedAuthoringSample,parseIfc,BACK_WALL,SAMPLE_MODEL,GROUND_STOREY} from '@/test/authoring-sample-fixture';
import {editedModelBytes} from '@/lib/export/edited-model-bytes';
import {resolveGlobalId} from '@/lib/actions/resolve-global-id';
import {readSplitSnapshot} from './model-authoring-split-state';
import {parseModelAuthoringBatch} from './model-authoring';
import {previewModelAuthoring} from './model-authoring-preview';
import {commitModelAuthoring} from './model-authoring-commit';
import {uniqueSplitGuid} from '@/lib/actions/model-authoring-split';
const initial=useViewerStore.getState(); afterEach(()=>useViewerStore.setState(initial,true));
for (const source of ['saved','authored'] as const) for (const edit of ['named','positional'] as const) {
 test(`public ${edit} GlobalId on ${source} Root matches independently exported current identity`,async()=>{
  const {dataStore,view}=await seedAuthoringSample(),editor=new StoreEditor(dataStore,view);
  const oldId=dataStore.entities.getExpressIdByGlobalId(BACK_WALL),record=dataStore.getEntity(oldId);assert.ok(record);
  const id=source==='saved'?oldId:editor.addEntity(record.type,[generateIfcGuid(),...record.attributes.slice(1)]).expressId;
  const guid=generateIfcGuid();
  if(edit==='named')editor.setAttribute(id,'GlobalId',guid);else editor.setPositionalAttribute(id,0,guid);
  const saved=await parseIfc(editedModelBytes(dataStore,view));
  assert.equal(saved.getEntity(id)?.attributes[0],guid,'public writer and independent STEP establish the current RootGUID');
  assert.equal(effectiveMetadataRecord(dataStore,id,view)?.attributes[0],guid,'canonical metadata reflects current native exported RootGUID');
  assert.equal(uniqueSplitGuid(dataStore,editor,guid),true,'shared strict identity inventory must recognize the uniquely exported current RootGUID');
 });
}

for (const source of ['saved','authored'] as const) {
 test(`public named GlobalId on ${source} Root cannot hide a genuine duplicate from strict inventory`,async()=>{
  const {dataStore,view}=await seedAuthoringSample(),editor=new StoreEditor(dataStore,view);
  const peer=dataStore.entities.getExpressIdByGlobalId(BACK_WALL),record=dataStore.getEntity(peer);assert.ok(record);
  const clone=editor.addEntity(record.type,[generateIfcGuid(),...record.attributes.slice(1)]).expressId;
  const edited=source==='saved'?peer:clone,other=source==='saved'?clone:peer;
  const otherGuid=effectiveMetadataRecord(dataStore,other,view)?.attributes[0];assert.equal(typeof otherGuid,'string');
  editor.setAttribute(edited,'GlobalId',String(otherGuid));
  const saved=await parseIfc(editedModelBytes(dataStore,view));
  assert.equal(saved.getEntity(edited)?.attributes[0],saved.getEntity(other)?.attributes[0],'independent STEP proves two actual IfcRoot entities share a current GUID');
  assert.equal(effectiveMetadataRecord(dataStore,edited,view)?.attributes[0],otherGuid);
  assert.equal(uniqueSplitGuid(dataStore,editor,String(otherGuid)),false,'named edits cannot leave an actual duplicate root inventory falsely unique');
 });
}

for (const source of ['saved','authored'] as const) {
 test(`canonical reviewed lookup resolves independently exported named GlobalId on ${source} Root`, async()=>{
  const {dataStore,view}=await seedAuthoringSample(),editor=new StoreEditor(dataStore,view);
  const peer=dataStore.entities.getExpressIdByGlobalId(BACK_WALL),record=dataStore.getEntity(peer);assert.ok(record);
  const id=source==='saved'?peer:editor.addEntity(record.type,[generateIfcGuid(),...record.attributes.slice(1)]).expressId;
  const guid=generateIfcGuid();editor.setAttribute(id,'GlobalId',guid);
  const saved=await parseIfc(editedModelBytes(dataStore,view));assert.equal(saved.getEntity(id)?.attributes[0],guid);
  assert.deepEqual(resolveGlobalId(useViewerStore.getState(),{modelId:SAMPLE_MODEL,globalId:guid}),{modelId:SAMPLE_MODEL,expressId:id});
 });
}

for (const source of ['saved','authored'] as const) for (const edit of ['named','positional'] as const) {
 test(`#7284 ${edit} identity replacement on ${source} root revokes the original reviewed GUID`,async()=>{
  const {dataStore,view}=await seedAuthoringSample(),editor=new StoreEditor(dataStore,view);
  const peer=dataStore.entities.getExpressIdByGlobalId(BACK_WALL),record=dataStore.getEntity(peer);assert.ok(record);
  const oldGuid=source==='saved'?BACK_WALL:generateIfcGuid();
  const id=source==='saved'?peer:editor.addEntity(record.type,[oldGuid,...record.attributes.slice(1)]).expressId;
  const current=generateIfcGuid(); if(edit==='named')editor.setAttribute(id,'GlobalId',current);else editor.setPositionalAttribute(id,0,current);
  const saved=await parseIfc(editedModelBytes(dataStore,view));assert.equal(saved.getEntity(id)?.attributes[0],current);
  assert.equal(uniqueSplitGuid(dataStore,editor,oldGuid),false);
  assert.equal(resolveGlobalId(useViewerStore.getState(),{modelId:SAMPLE_MODEL,globalId:oldGuid}),'missing','old parsed/created identity cannot resolve a renamed root');
 });
}

test('#7284 canonical Root inventory excludes material Name lookalikes and deleted roots without changing a held lease',async()=>{
 const {dataStore,view}=await seedAuthoringSample(),editor=new StoreEditor(dataStore,view);
 const id=dataStore.entities.getExpressIdByGlobalId(BACK_WALL),record=dataStore.getEntity(id);assert.ok(record);
 const clone=editor.addEntity(record.type,[generateIfcGuid(),...record.attributes.slice(1)]).expressId;
 editor.setAttribute(clone,'GlobalId',BACK_WALL); assert.equal(editor.removeEntity(clone),true);
 const material=editor.addEntity('IfcMaterial',[BACK_WALL,null,null]);
 const saved=await parseIfc(editedModelBytes(dataStore,view));assert.equal(saved.getEntity(material.expressId)?.attributes[0],BACK_WALL);assert.equal(saved.getEntity(clone),null);
 const lease=view.prepareAtomic(()=>null),count=view.getMutationCount();
 assert.equal(uniqueSplitGuid(dataStore,editor,BACK_WALL),true);
 assert.deepEqual(resolveGlobalId(useViewerStore.getState(),{modelId:SAMPLE_MODEL,globalId:BACK_WALL}),{modelId:SAMPLE_MODEL,expressId:id});
 assert.equal(view.getMutationCount(),count); assert.doesNotThrow(()=>lease.validate());
});

for (const duplicate of [false,true]) {
 test(`#7284 reviewed native split ${duplicate?'refuses duplicate':'accepts current unique'} named RootGUID`,async()=>{
  const {dataStore,view}=await seedAuthoringSample();
  const made=useViewerStore.getState().addWall(SAMPLE_MODEL,dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY),{Start:[20,20,0],End:[24,20,0],Thickness:.2,Height:3,Name:'Current identity wall'});
  assert.ok('expressId' in made);const id=made.expressId,editor=new StoreEditor(dataStore,view),guid=generateIfcGuid();
  editor.setAttribute(id,'GlobalId',guid);
  const saved=await parseIfc(editedModelBytes(dataStore,view));assert.equal(saved.getEntity(id)?.attributes[0],guid);
  if(duplicate){
    const record=saved.getEntity(id);assert.ok(record);
    const peer=editor.addEntity(record.type,record.attributes);
    const duplicated=await parseIfc(editedModelBytes(dataStore,view));
    assert.equal(duplicated.getEntity(peer.expressId)?.attributes[0],guid,'independent STEP proves the duplicate current root before review');
  }
  const expected=readSplitSnapshot(dataStore,editor,id,'m');
  const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Current native GUID',units:'m',frame:'storey-local',operations:[{op:'element.split',target:{modelId:SAMPLE_MODEL,globalId:guid,ifcClass:'IfcWall',name:'Current identity wall'},expected,cut:{kind:'wall',distance:2}}]}));
  const preview=previewModelAuthoring(useViewerStore.getState(),batch);
  if(duplicate){assert.notEqual(preview.rows[0].status,'ready','review entry refuses a genuine current named-GUID root duplicate');return;}
  assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue ?? 'native current identity split status');
  const outcome=commitModelAuthoring(useViewerStore,preview,new Set([0]),'native identity control');assert.ok(outcome.ok,outcome.ok?'':outcome.detail??outcome.reason);
  const after=await parseIfc(editedModelBytes(dataStore,view));assert.equal(after.getEntity(id)?.attributes[0],guid,'accepted native split preserves independently exported current source identity');
  useViewerStore.getState().undo(SAMPLE_MODEL);
  const restored=await parseIfc(editedModelBytes(dataStore,view));assert.equal(restored.getEntity(id)?.attributes[0],guid);
 });
}
