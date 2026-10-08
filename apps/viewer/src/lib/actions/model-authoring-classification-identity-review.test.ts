/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #7271 independent review: native writes and decoded STEP establish owner identity.
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {StoreEditor} from '@ifc-lite/mutations';
import {generateIfcGuid} from '@ifc-lite/encoding';
import {extractClassificationsOnDemand} from '@ifc-lite/parser';
import {useViewerStore} from '@/store';
import {seedAuthoringSample,parseIfc,SAMPLE_MODEL,BACK_WALL,BACK_WALL_NAME} from '@/test/authoring-sample-fixture';
import {editedModelBytes} from '@/lib/export/edited-model-bytes';
import {parseModelAuthoringBatch} from './model-authoring';
import {previewModelAuthoring} from './model-authoring-preview';
import {commitModelAuthoring} from './model-authoring-commit';
const initial=useViewerStore.getState();afterEach(()=>useViewerStore.setState(initial,true));
for(const duplicate of [false,true])test(`#7271 classification ${duplicate?'refuses duplicate':'accepts unique'} current native Root identity`,async()=>{
 const {dataStore,view}=await seedAuthoringSample(),id=dataStore.entities.getExpressIdByGlobalId(BACK_WALL),record=dataStore.getEntity(id);assert.ok(record);
 const editor=new StoreEditor(dataStore,view);editor.addEntity(record.type,[duplicate?BACK_WALL:generateIfcGuid(),...record.attributes.slice(1)]);
 const saved=await parseIfc(editedModelBytes(dataStore,view));
 const ids=[id,...view.getNewEntitiesOfType('IFCWALL').map(row=>row.expressId)];
 assert.equal(ids.filter(root=>saved.getEntity(root)?.attributes[0]===BACK_WALL).length,duplicate?2:1,'independent IFC proves actual duplicate versus unique owning roots');
 const held=view.prepareAtomic(()=>null),records=view.getMutations(),state=useViewerStore.getState();
 const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Native owner review',units:'m',frame:'storey-local',operations:[{op:'classification.add',target:{globalId:BACK_WALL,modelId:SAMPLE_MODEL,ifcClass:'IfcWall',name:BACK_WALL_NAME},Classification:{Name:'Explicit native review'},Reference:{Identification:'WALL-REVIEW',Name:'Independent native evidence'}}]}));
 const preview=previewModelAuthoring(state,batch);assert.doesNotThrow(held.validate);assert.deepEqual(view.getMutations(),records);
 if(duplicate){assert.notEqual(preview.rows[0].status,'ready','review cannot choose one of two same-model native roots with identical GUID/Class/Name');assert.equal(preview.rows[0].status,'ambiguous-target');return;}
 assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue);
 const outcome=commitModelAuthoring(useViewerStore,preview,new Set([0]),'native classification owner');assert.ok(outcome.ok,outcome.ok?'':outcome.detail??outcome.reason);
 const after=await parseIfc(editedModelBytes(dataStore,view));assert.equal(after.getEntity(id)?.attributes[0],BACK_WALL);assert.equal(extractClassificationsOnDemand(after,id).filter(row=>row.system==='Explicit native review').length,1);
 useViewerStore.getState().undo(SAMPLE_MODEL);const restored=await parseIfc(editedModelBytes(dataStore,view));assert.equal(restored.getEntity(id)?.attributes[0],BACK_WALL);assert.equal(extractClassificationsOnDemand(restored,id).filter(row=>row.system==='Explicit native review').length,0);
});
