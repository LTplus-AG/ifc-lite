/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { readHostOpeningExtents } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { render, click, cleanup } from '@/test/render';
import { GROUND_STOREY, SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { authoringReader } from '@/lib/actions/model-authoring-read';
import { captureSelectionGrounding } from '@/lib/actions/selection-grounding';
import { selectionAdapter } from '@/lib/assistant/adapters/selection';
import { readSplitSnapshot } from '@/lib/actions/model-authoring-split-state';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { modelChangeLibrary } from '@/lib/actions/receipts';
import { ModelAuthoringReview } from './ModelAuthoringReview';
const initial=useViewerStore.getState();
afterEach(()=>{cleanup();useViewerStore.setState(initial);});
test('#7310 mounted native slab review discloses no fit and the native cutter boundary and applies only the checked cut',async()=>{
 await modelChangeLibrary.initialize();const {dataStore,view}=await seedAuthoringSample();
 const made=useViewerStore.getState().addSlab(SAMPLE_MODEL,dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY),{Position:[20,20,3],Width:6,Depth:4,Thickness:.25,Name:'Mounted native slab'});assert.ok('expressId' in made,'error' in made?made.error:'');
 const reader=authoringReader(useViewerStore.getState(),SAMPLE_MODEL);assert.ok(reader);
 const saved=await parseIfc(editedModelBytes(dataStore,view));
 const operation={op:'hosted.create',kind:'opening',host:{modelId:SAMPLE_MODEL,globalId:saved.entities.getGlobalId(made.expressId),ifcClass:'IfcSlab',name:saved.entities.getName(made.expressId)},expected:readSplitSnapshot(dataStore,reader.editor,made.expressId,'m'),params:{Position:[2,1],Width:1,Depth:.8}};
 const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Selective native slab openings',units:'m',frame:'storey-local',operations:[operation,{...operation,params:{...operation.params,Position:[4,1]}}]}));
 const before=view.getMutationCount(),ui=render(<ModelAuthoringReview batch={batch} origin="Native slab review" />);
 assert.match(ui.textContent??'',/Slab footprint fit and overlap are not checked/);
 assert.match(ui.textContent??'',/Preview shows the native slab cutter only, not the boolean result/);
 assert.match(ui.textContent??'',/1.*0.8 m/);assert.equal(view.getMutationCount(),before,'mounted review never publishes the preview draft');
 const boxes=[...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];assert.equal(boxes.length,2);act(()=>boxes[1].click());
 const apply=[...ui.querySelectorAll('button')].find(button=>button.textContent==='Apply 1 operation');assert.ok(apply);click(apply);
 assert.match(ui.textContent??'',/Applied 1 change/);
 const after=await parseIfc(editedModelBytes(dataStore,view)),cuts=readHostOpeningExtents(after,made.expressId);
 assert.equal(cuts.cuts.length,1,'the unchecked native cut is never authored');assert.equal(cuts.cuts[0].bounds.min[0],1500);
});
test('#7310 both real selection transports carry the same complete current native slab snapshot',async()=>{
 const {dataStore}=await seedAuthoringSample(),made=useViewerStore.getState().addSlab(SAMPLE_MODEL,dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY),{Position:[20,20,3],Width:6,Depth:4,Thickness:.25,Name:'Attached native slab'});assert.ok('expressId' in made,'error' in made?made.error:'');
 useViewerStore.getState().setSelectedEntityIds([made.expressId]);const state=useViewerStore.getState(),attached=captureSelectionGrounding(state);
 assert.equal(attached.elements.length,1);assert.ok(attached.elements[0].nativeSlabOpeningExpected,'the shipping attachment includes the native slab snapshot');assert.equal(attached.elements[0].nativeAuthoringAvailability.slabOpening,'available');
 const evidence=selectionAdapter.capture(state,10),reader=authoringReader(state,SAMPLE_MODEL);assert.ok(reader);
 assert.deepEqual(attached.elements[0].nativeSlabOpeningExpected,readSplitSnapshot(dataStore,reader.editor,made.expressId,'m'));
 const row=evidence.rows?.[0];assert.ok(row && typeof row==='object' && 'nativeSlabOpeningExpected' in row);
 assert.deepEqual(row.nativeSlabOpeningExpected,attached.elements[0].nativeSlabOpeningExpected,'attachment and evidence adapter use one authoritative native reader');
});
