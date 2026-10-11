/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach,test } from 'node:test';
import { useViewerStore } from '@/store';
import { render,click,cleanup } from '@/test/render';
import { replacementVariants,setupReplacementSource,replacementReviewParams } from '@/test/authoring-replacement-fixture';
import { SAMPLE_MODEL,GROUND_STOREY,parseIfc } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { captureSelectionGrounding } from '@/lib/actions/selection-grounding';
import { selectionAdapter } from '@/lib/assistant/adapters/selection';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { modelChangeLibrary } from '@/lib/actions/receipts';
import { ModelAuthoringReview } from './ModelAuthoringReview';
const initial=useViewerStore.getState();afterEach(()=>{cleanup();useViewerStore.setState(initial);});
test('#7320 mounted replacement discloses native identity/metadata/preview boundaries before manual Apply',async()=>{
 await modelChangeLibrary.initialize();const f=await setupReplacementSource(replacementVariants[0]);useViewerStore.getState().setSelectedEntityIds([f.made.expressId]);
 const state=useViewerStore.getState(),attached=captureSelectionGrounding(state),expected=attached.elements[0]?.nativeReplacementExpected;assert.ok(expected);
 const evidence=selectionAdapter.capture(state,10),row=evidence.rows?.[0];assert.ok(row&&typeof row==='object'&&'nativeReplacementExpected'in row);assert.deepEqual(row.nativeReplacementExpected,expected,'both shipping selection transports use the same native evidence owner');
 const original=f.dataStore.getEntity(f.made.expressId);assert.ok(original);const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Native replacement review',units:'m',frame:'storey-local',operations:[{op:'element.replace',target:{modelId:SAMPLE_MODEL,globalId:original.attributes[0],ifcClass:'IfcWall',name:original.attributes[2]},storey:{modelId:SAMPLE_MODEL,globalId:GROUND_STOREY},ref:'replacement',ifcClass:'IfcSlab',name:'Explicit new slab',params:replacementReviewParams(replacementVariants[2]),expected}]}));
 const count=f.view.getMutationCount(),ui=render(<ModelAuthoringReview batch={batch} origin="Native replacement review"/>);
 assert.match(ui.textContent??'',/Replace product/);assert.match(ui.textContent??'',/not transferred/);assert.match(ui.textContent??'',/destination body only/);assert.match(ui.textContent??'',/shared old geometry\/style leaves are retained/);
 assert.equal(f.view.getMutationCount(),count,'mounted review does not author or auto-apply');const apply=[...ui.querySelectorAll('button')].find(button=>button.textContent==='Apply 1 operation');assert.ok(apply);click(apply);assert.match(ui.textContent??'',/Applied 1 change/);
 const saved=await parseIfc(editedModelBytes(f.dataStore,f.view));assert.equal(saved.getEntity(f.made.expressId),null);assert.ok([...saved.entityIndex.byId.keys()].some(id=>saved.entities.getTypeName(id)==='IfcSlab'&&saved.entities.getName(id)==='Explicit new slab'));
});
