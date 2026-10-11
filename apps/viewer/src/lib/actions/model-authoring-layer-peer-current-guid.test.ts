/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #7275: current peer identities come from actual native writes and independent STEP.
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {generateIfcGuid} from '@ifc-lite/encoding';
import {StoreEditor} from '@ifc-lite/mutations';
import {readRelatedLists} from '@ifc-lite/create';
import {useViewerStore} from '@/store';
import {seedAuthoringSample,parseIfc,SAMPLE_MODEL,GROUND_STOREY,FRONT_WALL_TYPE} from '@/test/authoring-sample-fixture';
import {editedModelBytes} from '@/lib/export/edited-model-bytes';
import {recordModellingEdit} from '@/store/slices/mutation-modelling-records';
import {captureSelectionGrounding} from './selection-grounding';
import {parseModelAuthoringBatch} from './model-authoring';
import {previewModelAuthoring} from './model-authoring-preview';
import {commitModelAuthoring} from './model-authoring-commit';
import {layerSetOf} from '@/lib/commands/modeling/authored-kinds';
const initial=useViewerStore.getState();afterEach(()=>useViewerStore.setState(initial,true));
for(const edit of ['named','positional'] as const)test(`#7275 complete native peer population retains ${edit} current GlobalId`,async()=>{
 const {dataStore,view}=await seedAuthoringSample(),typeId=dataStore.entities.getExpressIdByGlobalId(FRONT_WALL_TYPE);
 const relation=readRelatedLists(dataStore,'IfcRelDefinesByType',view).find(row=>row.relatingId===typeId);assert.ok(relation?.relatedIds.length);const peer=relation.relatedIds[0];
 const made=useViewerStore.getState().addWall(SAMPLE_MODEL,dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY),{Start:[20,20,0],End:[24,20,0],Height:3,Thickness:.2,Name:'Peer read target'});assert.ok('expressId' in made);
 recordModellingEdit(useViewerStore,SAMPLE_MODEL,methods=>methods.assignType(SAMPLE_MODEL,typeId,[made.expressId]));
 const editor=new StoreEditor(dataStore,view),currentGuid=generateIfcGuid();if(edit==='named')editor.setAttribute(peer,'GlobalId',currentGuid);else editor.setPositionalAttribute(peer,0,currentGuid);
 const saved=await parseIfc(editedModelBytes(dataStore,view));assert.equal(saved.getEntity(peer)?.attributes[0],currentGuid,'independent native STEP proves current nonselected peer identity');
 const population=readRelatedLists(saved,'IfcRelDefinesByType').filter(row=>row.relatingId===typeId).flatMap(row=>row.relatedIds);assert.ok(population.includes(peer)&&population.includes(made.expressId));
 const held=view.prepareAtomic(()=>null),records=view.getMutations(),state=useViewerStore.getState();
 const row=captureSelectionGrounding({...state,selectedEntityIds:new Set([made.expressId])}).elements[0]?.nativeLayers;assert.ok(row);
 assert.equal(row.typeScopeStatus,'available','complete real peer population with known unique current native identities must remain usable');
 assert.equal(row.expected?.peers?.filter(ref=>ref.globalId===currentGuid).length,1);
 assert.deepEqual(view.getMutations(),records);assert.doesNotThrow(held.validate);
 const expected=row.expected;assert.ok(expected);const prior=layerSetOf({dataStore:saved,view:null},typeId)?.layers.map(layer=>layer.thickness)??null;
 const globalId=saved.getEntity(made.expressId)?.attributes[0];assert.equal(typeof globalId,'string');
 const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Current peer population',units:'m',frame:'storey-local',operations:[{op:'material.layers',target:{globalId,modelId:SAMPLE_MODEL,ifcClass:'IfcWall',name:'Peer read target'},scope:'type',expected,MaterialLayers:[{LayerThickness:.4,Material:null}]}]}));
 const preview=previewModelAuthoring(useViewerStore.getState(),batch);assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue ?? '');
 const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'native peer review');assert.ok(result.ok,result.ok?'':result.detail??result.reason);
 const changed=await parseIfc(editedModelBytes(dataStore,view));assert.equal(changed.getEntity(peer)?.attributes[0],currentGuid);assert.equal(layerSetOf({dataStore:changed,view:null},typeId)?.layers[0].thickness,.4);
 useViewerStore.getState().undo(SAMPLE_MODEL);const restored=await parseIfc(editedModelBytes(dataStore,view));assert.equal(restored.getEntity(peer)?.attributes[0],currentGuid);assert.deepEqual(layerSetOf({dataStore:restored,view:null},typeId)?.layers.map(layer=>layer.thickness)??null,prior);

});

test('#7275 native type assignment refuses a non-root material peer and rolls back its staged creation',async()=>{
 const {dataStore,view}=await seedAuthoringSample(),typeId=dataStore.entities.getExpressIdByGlobalId(FRONT_WALL_TYPE);
 const made=useViewerStore.getState().addWall(SAMPLE_MODEL,dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY),{Start:[20,20,0],End:[24,20,0],Height:3,Thickness:.2,Name:'Peer read target'});assert.ok('expressId' in made);
 const guid=view.getNewEntity(made.expressId)?.attributes[0];assert.equal(typeof guid,'string');
 const held=view.prepareAtomic(()=>null),records=view.getMutations(),history=useViewerStore.getState().undoStacks;
 assert.throws(()=>recordModellingEdit(useViewerStore,SAMPLE_MODEL,methods=>{const materialId=methods.addMaterial(SAMPLE_MODEL,{Name:String(guid)}).expressId;methods.assignType(SAMPLE_MODEL,typeId,[made.expressId,materialId]);}),/IFCMATERIAL.*not an IfcObject/);
 assert.deepEqual(view.getMutations(),records);assert.equal(useViewerStore.getState().undoStacks,history);assert.doesNotThrow(held.validate);
 const saved=await parseIfc(editedModelBytes(dataStore,view));assert.equal(saved.getEntity(made.expressId)?.attributes[0],guid);
 assert.ok(!readRelatedLists(saved,'IfcRelDefinesByType').filter(row=>row.relatingId===typeId).some(row=>row.relatedIds.includes(made.expressId)),'rejected native transaction publishes no malformed relationship');
});
