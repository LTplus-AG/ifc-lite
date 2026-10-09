/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { curtainWallLayout, type CurtainWallInStoreParams } from '@ifc-lite/create';
import { RelationshipType } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { createStoreAdapter } from '@/sdk/adapters/store-adapter';
import { GROUND_STOREY, SAMPLE_MODEL, danglingReferences, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { parseModelAuthoringBatch } from './model-authoring';
const original=useViewerStore.getState();
afterEach(()=>useViewerStore.setState(original));
const params:CurtainWallInStoreParams={Start:[1,2,0],End:[5,2,0],Height:3,UGrid:2,VGrid:2,Name:'Native reviewed curtain wall'};
async function nativeAggregate() {
 const {dataStore,view}=await seedAuthoringSample();
 const api=createStoreAdapter(useViewerStore);assert.ok(api.addCurtainWall,'Existing public native curtain-wall capability');
 const storeyId=dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
 const made=api.addCurtainWall(SAMPLE_MODEL,storeyId,params);
 const guid=String(view.getNewEntity(made.expressId)!.attributes[0]);
 const bytes=editedModelBytes(dataStore,view);
 assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)),[]);
 const parsed=await parseIfc(bytes),id=parsed.entities.getExpressIdByGlobalId(guid);
 assert.ok(id>0);assert.equal(parsed.entities.getTypeName(id),'IfcCurtainWall');
 const layout=curtainWallLayout(params),children=parsed.relationships.getRelated(id,RelationshipType.Aggregates,'forward');
 assert.equal(children.length,layout.mullions.length+layout.transoms.length+layout.panels.length,'Independent source contains every canonical native layout part');
 assert.equal(children.filter(child=>parsed.entities.getTypeName(child)==='IfcMember').length,layout.mullions.length+layout.transoms.length);
 assert.equal(children.filter(child=>parsed.entities.getTypeName(child)==='IfcPlate').length,layout.panels.length);
 for(const child of children)assert.deepEqual(parsed.relationships.getRelated(child,RelationshipType.Aggregates,'inverse'),[id]);
 assert.deepEqual(parsed.relationships.getRelated(id,RelationshipType.ContainsElements,'inverse'),[storeyId]);
 return {dataStore,view,parsed,id,guid,layout};
}
test('#7298 public native curtain-wall aggregate preserves canonical layout, complete parts and containment through STEP export',async()=>{
 const result=await nativeAggregate();assert.equal(result.parsed.entities.getName(result.id),params.Name);
 assert.equal(result.layout.panels.length,4,'Explicit native 2-by-2 bays contain four panels');
});
test('#7298 reviewed authoring admits the existing independently exported native curtain-wall family',async()=>{
 await nativeAggregate();
 assert.doesNotThrow(()=>parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Review native curtain-wall aggregate',units:'m',frame:'storey-local',operations:[{op:'curtainWall.create',ref:'curtain',storey:{modelId:SAMPLE_MODEL,globalId:GROUND_STOREY},params}]})),'Reviewed authoring must admit the demonstrated public native curtain-wall aggregate');
});
