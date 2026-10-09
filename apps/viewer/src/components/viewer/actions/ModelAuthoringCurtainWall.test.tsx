/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { render, click, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { modelChangeLibrary } from '@/lib/actions/receipts';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { seedAuthoringSample, GROUND_STOREY, parseIfc, danglingReferences } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { RelationshipType } from '@ifc-lite/data';
import { ModelAuthoringReview } from './ModelAuthoringReview';
const original=useViewerStore.getState();afterEach(()=>{cleanup();useViewerStore.setState(original);});
test('#7298 mounted native curtain review shows complete member/panel counts and unavailable custom preview before selective Apply; one Undo restores source',async()=>{
  await modelChangeLibrary.initialize();const {dataStore,view}=await seedAuthoringSample();
  const params={Start:[0,0,0],End:[4,0,0],Height:3,UGrid:2,VGrid:2};
  const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Curtain aggregate review',units:'m',frame:'storey-local',operations:[
    {op:'curtainWall.create',ref:'first',storey:{globalId:GROUND_STOREY},params:{...params,Name:'Checked native curtain',MullionProfile:{Type:'Circle',Radius:.04}}},
    {op:'curtainWall.create',ref:'second',storey:{globalId:GROUND_STOREY},params:{...params,Name:'Excluded native curtain'}},
  ]}));const history=view.getMutations(),ui=render(<ModelAuthoringReview batch={batch} origin="native curtain review"/>);
  assert.match(ui.textContent??'',/Create curtain wall/);assert.match(ui.textContent??'',/IfcMember=9/);assert.match(ui.textContent??'',/IfcPlate=4/);assert.match(ui.textContent??'',/other native sections or thicknesses are not drawn/);assert.match(ui.textContent??'',/No geometry preview is available for this edit/);assert.deepEqual(view.getMutations(),history);
  const checkboxes=[...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];assert.equal(checkboxes.length,2);act(()=>checkboxes[1].click());
  const apply=[...ui.querySelectorAll('button')].find(button=>button.textContent==='Apply 1 operation');assert.ok(apply);click(apply);assert.match(ui.textContent??'',/Applied 1 change/);
  const bytes=editedModelBytes(dataStore,view);assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)),[]);const parsed=await parseIfc(bytes);
  const products=[...parsed.entityIndex.byId.values()].filter(row=>row.type==='IFCCURTAINWALL');assert.equal(products.length,1);assert.equal(parsed.entities.getName(products[0].expressId),'Checked native curtain');assert.equal(parsed.relationships.getRelated(products[0].expressId,RelationshipType.Aggregates,'forward').length,13);
  const undo=[...ui.querySelectorAll('button')].find(button=>button.textContent==='Undo these changes');assert.ok(undo);click(undo);const undone=await parseIfc(editedModelBytes(dataStore,view));assert.equal([...undone.entityIndex.byId.values()].filter(row=>row.type==='IFCCURTAINWALL').length,0,'Native reviewed Undo removes the complete checked aggregate');
});
