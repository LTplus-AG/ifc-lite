/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { readWallJoinTarget } from '@ifc-lite/create';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { render, click, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { seedAuthoringSample, SAMPLE_MODEL, GROUND_STOREY, parseIfc } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { modelChangeLibrary } from '@/lib/actions/receipts';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { authoringReachEvidence } from '@/lib/actions/model-authoring-reach';
import { ModelAuthoringReview } from './ModelAuthoringReview';

const initial=useViewerStore.getState();
afterEach(()=>{cleanup();useViewerStore.setState(initial);});

test('#7262 mounted native reach review shows actual planned end/length, disclosed body limits and applies only the approved target',async()=>{
  await modelChangeLibrary.initialize();
  const {dataStore,view}=await seedAuthoringSample(),get=useViewerStore.getState,storey=dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const ids=[5,20].map(y=>{const result=get().addWall(SAMPLE_MODEL,storey,{Start:[0,y,0],End:[8,y,0],Height:3,Thickness:.2,Name:`Reviewed reach ${y}`});assert.ok('expressId' in result);return result.expressId;});
  const before=await parseIfc(editedModelBytes(dataStore,view));
  const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Native reviewed reach',units:'mm',frame:'storey-local',operations:ids.map((id,i)=>({
    op:'element.trimExtend',mode:'extend',target:{globalId:before.entities.getGlobalId(id),ifcClass:'IfcWall',name:before.entities.getName(id)},expected:authoringReachEvidence(get(),SAMPLE_MODEL,id),
    click:[8000,(i?20:5)*1000],boundary:{line:{a:[10000,0],b:[10000,30000],tMin:0,tMax:1,reach:0}},
  }))}));
  const mutations=view.getMutationCount(),ui=render(<ModelAuthoringReview batch={batch} origin="native reach review" />);
  assert.match(ui.textContent??'',/extend end · length 10000 mm/);
  assert.match(ui.textContent??'',/The preview shows the outer body; openings are not cut into the preview/);
  assert.equal(view.getMutationCount(),mutations,'native mounted preview remains unpublished');
  const boxes=[...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];assert.equal(boxes.length,2);act(()=>boxes[1].click());
  const apply=[...ui.querySelectorAll('button')].find(button=>button.textContent==='Apply 1 operation');assert.ok(apply);click(apply);
  assert.match(ui.textContent??'',/Applied 1 change/);
  const after=await parseIfc(editedModelBytes(dataStore,view)),fresh=new MutablePropertyView(after.properties,SAMPLE_MODEL),scale=getModelLengthUnitScale(after);
  assert.deepEqual(readWallJoinTarget(after,fresh,after.entities.getExpressIdByGlobalId(before.entities.getGlobalId(ids[0])),scale)?.wall.end,[10,5]);
  assert.deepEqual(readWallJoinTarget(after,fresh,after.entities.getExpressIdByGlobalId(before.entities.getGlobalId(ids[1])),scale)?.wall.end,[8,20]);
});
