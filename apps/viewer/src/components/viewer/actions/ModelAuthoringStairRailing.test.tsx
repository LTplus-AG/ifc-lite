/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach,test } from 'node:test';
import { act } from 'react';
import { render,click,cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { modelChangeLibrary } from '@/lib/actions/receipts';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { seedAuthoringSample,GROUND_STOREY,parseIfc,danglingReferences } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { ModelAuthoringReview } from './ModelAuthoringReview';
const original=useViewerStore.getState();afterEach(()=>{cleanup();useViewerStore.setState(original);});
test('#7273 mounted native family review discloses command approximation and applies only the checked creation',async()=>{
 await modelChangeLibrary.initialize();const {dataStore,view}=await seedAuthoringSample();const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Reviewed stair/railing',frame:'storey-local',units:'m',operations:[
  {op:'stair.create',ref:'stair',storey:{globalId:GROUND_STOREY},params:{Name:'Checked stair',Position:[1,2,0],NumberOfRisers:4,RiserHeight:.2,TreadLength:.3,Width:1,WaistThickness:.1}},
  {op:'railing.create',ref:'rail',storey:{globalId:GROUND_STOREY},params:{Name:'Excluded rail',Path:[[1,4,0],[3,4,0]],Height:1.1}},
 ]}));const before=view.getMutations(),ui=render(<ModelAuthoringReview batch={batch} origin="native family review"/>);assert.match(ui.textContent??'',/Create stair/);assert.match(ui.textContent??'',/Create railing/);assert.match(ui.textContent??'',/Stair Direction is radians/);assert.match(ui.textContent??'',/solid stair steps/);assert.match(ui.textContent??'',/square rail\/post sections/);assert.match(ui.textContent??'',/stair waist is omitted/);assert.deepEqual(view.getMutations(),before);
 const checkboxes=[...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];assert.equal(checkboxes.length,2);act(()=>checkboxes[1].click());const apply=[...ui.querySelectorAll('button')].find(button=>button.textContent==='Apply 1 operation');assert.ok(apply);click(apply);assert.match(ui.textContent??'',/Applied 1 change/);
 const bytes=editedModelBytes(dataStore,view);assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)),[]);const parsed=await parseIfc(bytes);
 // @raw-entity-enumeration-ok independent reparse verifies the actual exported source has checked creation only, without any live overlay.
 assert.ok(parsed.entityIndex.byType.get('IFCSTAIR')?.some(id=>parsed.entities.getName(id)==='Checked stair'));assert.ok(!parsed.entityIndex.byType.get('IFCRAILING')?.some(id=>parsed.entities.getName(id)==='Excluded rail'));
});
