/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Independent #7275 review: native writers and STEP establish current identities.
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {generateIfcGuid} from '@ifc-lite/encoding';
import {StoreEditor} from '@ifc-lite/mutations';
import {useViewerStore} from '@/store';
import {seedAuthoringSample,parseIfc,SAMPLE_MODEL,GROUND_STOREY,FRONT_WALL_TYPE} from '@/test/authoring-sample-fixture';
import {editedModelBytes} from '@/lib/export/edited-model-bytes';
import {recordModellingEdit} from '@/store/slices/mutation-modelling-records';
import {applyMaterialLayers} from '@/components/viewer/model-inspector/inspector-edits';
import {captureSelectionGrounding} from './selection-grounding';
import {parseModelAuthoringBatch} from './model-authoring';
import {previewModelAuthoring} from './model-authoring-preview';
import {commitModelAuthoring} from './model-authoring-commit';
import {layerSetOf} from '@/lib/commands/modeling/authored-kinds';
const original=useViewerStore.getState();afterEach(()=>useViewerStore.setState(original,true));
for(const identity of ['unchanged','target-named','type-named','target-positional','type-positional'] as const)test(`#7275 independent native current GUID layer review ${identity}`,async()=>{
 const {dataStore,view}=await seedAuthoringSample();
 const made=useViewerStore.getState().addWall(SAMPLE_MODEL,dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY),{Start:[20,20,0],End:[24,20,0],Height:3,Thickness:.2,Name:'Current layer wall'});
 assert.ok('expressId' in made);const id=made.expressId;
 const typeId=dataStore.entities.getExpressIdByGlobalId(FRONT_WALL_TYPE);
 if(identity.startsWith('type-')){
  recordModellingEdit(useViewerStore,SAMPLE_MODEL,methods=>methods.assignType(SAMPLE_MODEL,typeId,[id]));
  assert.notEqual(applyMaterialLayers(SAMPLE_MODEL,{kind:'wall',target:'type',elementId:id,typeId,layers:[{thickness:.3,material:null}]}),null);
 }
 const editor=new StoreEditor(dataStore,view),newGuid=generateIfcGuid();
 if(identity!=='unchanged'){ const root=identity.startsWith('type-')?typeId:id; if(identity.endsWith('-named'))editor.setAttribute(root,'GlobalId',newGuid);else editor.setPositionalAttribute(root,0,newGuid); }
 const saved=await parseIfc(editedModelBytes(dataStore,view));
 const guid=saved.getEntity(id)?.attributes[0];assert.equal(typeof guid,'string');
 if(identity!=='unchanged')assert.equal(saved.getEntity(identity.startsWith('type-')?typeId:id)?.attributes[0],newGuid,'independent STEP proves current named native GlobalId');
 const state=useViewerStore.getState(),grounding=captureSelectionGrounding({...state,selectedEntityIds:new Set([id])});
 const expected=grounding.elements[0]?.nativeLayers?.expected;assert.ok(expected);
 if(identity.startsWith('type-'))assert.equal(expected.type?.GlobalId,newGuid);
 const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Current native identities',units:'m',frame:'storey-local',operations:[{op:'material.layers',target:{globalId:guid,modelId:SAMPLE_MODEL,ifcClass:'IfcWall',name:'Current layer wall'},scope:identity.startsWith('type-')?'type':'element',expected,MaterialLayers:[{LayerThickness:.4,Material:null}]}]}));
 const preview=previewModelAuthoring(state,batch);
 assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue);
 const outcome=commitModelAuthoring(useViewerStore,preview,new Set([0]),'independent layer review');assert.ok(outcome.ok,outcome.ok?'':outcome.detail??outcome.reason);
 const changed=await parseIfc(editedModelBytes(dataStore,view));
 assert.equal(changed.getEntity(id)?.attributes[0],guid);
 assert.equal(layerSetOf({dataStore:changed,view:null},identity.startsWith('type-')?typeId:id)?.layers[0].thickness,.4);
 useViewerStore.getState().undo(SAMPLE_MODEL);
 const restored=await parseIfc(editedModelBytes(dataStore,view));assert.equal(restored.getEntity(id)?.attributes[0],guid);
 assert.equal(layerSetOf({dataStore:restored,view:null},identity.startsWith('type-')?typeId:id)?.layers[0].thickness,identity.startsWith('type-') ? .3 : undefined,'Undo restores the actual prior native layer population');
});

for(const owner of ['target','type'] as const)test(`#7275 old ${owner} GUID cannot authorize layers after native current identity replacement`,async()=>{
 const {dataStore,view}=await seedAuthoringSample();
 const made=useViewerStore.getState().addWall(SAMPLE_MODEL,dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY),{Start:[20,20,0],End:[24,20,0],Height:3,Thickness:.2,Name:'Current layer wall'});assert.ok('expressId' in made);const id=made.expressId,typeId=dataStore.entities.getExpressIdByGlobalId(FRONT_WALL_TYPE);
 if(owner==='type')recordModellingEdit(useViewerStore,SAMPLE_MODEL,methods=>methods.assignType(SAMPLE_MODEL,typeId,[id]));
 const prior=await parseIfc(editedModelBytes(dataStore,view)),oldGuid=prior.getEntity(id)?.attributes[0];assert.equal(typeof oldGuid,'string');
 const state=useViewerStore.getState(),expected=captureSelectionGrounding({...state,selectedEntityIds:new Set([id])}).elements[0]?.nativeLayers?.expected;assert.ok(expected);
 const root=owner==='type'?typeId:id,newGuid=generateIfcGuid();new StoreEditor(dataStore,view).setAttribute(root,'GlobalId',newGuid);
 const saved=await parseIfc(editedModelBytes(dataStore,view));assert.equal(saved.getEntity(root)?.attributes[0],newGuid,'native STEP proves replacement before stale review');
 const held=view.prepareAtomic(()=>null),records=view.getMutations(),batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Revoked native identity',units:'m',frame:'storey-local',operations:[{op:'material.layers',target:{globalId:oldGuid,modelId:SAMPLE_MODEL,ifcClass:'IfcWall',name:'Current layer wall'},scope:owner==='type'?'type':'element',expected,MaterialLayers:[{LayerThickness:.4,Material:null}]}]}));
 const preview=previewModelAuthoring(useViewerStore.getState(),batch);assert.notEqual(preview.rows[0].status,'ready');
 assert.equal(preview.rows[0].status,owner==='type'?'conflict':'missing-target');assert.deepEqual(view.getMutations(),records);assert.doesNotThrow(held.validate);
});
