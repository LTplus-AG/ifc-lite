/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readStairDimensions } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { federationRegistry } from '@ifc-lite/renderer';
import { createStoreAdapter } from '@/sdk/adapters/store-adapter';
import { GROUND_STOREY, SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { captureSelectionGrounding, selectionGroundingText } from './selection-grounding';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
const params = { Position: [1,2,0] as [number,number,number], NumberOfRisers: 4, RiserHeight: .2, TreadLength: .3, Width: 1, Name: 'Attached native stair' };
test('#7273 attached native stair carries the canonical snapshot into reviewed resize and independent export', async () => {
 const {dataStore,view} = await seedAuthoringSample();
 const api = createStoreAdapter(useViewerStore); assert.ok(api.addStair);
 const made = api.addStair(SAMPLE_MODEL,dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY),params);
 useViewerStore.setState({selectedEntityIds:new Set([made.expressId]),selectedEntityId:made.expressId});
 const grounding = captureSelectionGrounding(useViewerStore.getState());
 assert.equal(grounding.elements.length,1);
 const attached = JSON.parse(selectionGroundingText(grounding).split('\n').slice(1).join('\n'))[0];
 const canonical = readStairDimensions(dataStore,made.expressId,view); assert.ok(canonical);
 assert.deepEqual(attached.nativeStairExpected,canonical,'Attachment includes the verbatim native stair expected snapshot');
 const batch = parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Attachment resize',units:'mm',frame:'storey-local',operations:[{op:'stair.resize',target:{modelId:attached.modelId,globalId:attached.globalId,ifcClass:attached.type,name:attached.name},expected:attached.nativeStairExpected,size:{Width:1500}}]}));
 const preview = previewModelAuthoring(useViewerStore.getState(),batch); assert.equal(preview.rows[0].status,'ready');
 const result = commitModelAuthoring(useViewerStore,preview,new Set([0]),'Attached stair snapshot'); assert.ok(result.ok,result.ok?'':result.reason);
 const saved = await parseIfc(editedModelBytes(dataStore,view));
 assert.equal(readStairDimensions(saved,saved.entities.getExpressIdByGlobalId(attached.globalId))?.Width,1.5);
});
test('#7273 native stair writer permits sub-millimetre positive widths without an invented reviewed minimum', async () => {
 const {dataStore,view} = await seedAuthoringSample();
 const api = createStoreAdapter(useViewerStore); assert.ok(api.addStair);
 const made = api.addStair(SAMPLE_MODEL,dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY),{...params,Width:.0001});
 const saved = await parseIfc(editedModelBytes(dataStore,view));
 const guid = String(view.getNewEntity(made.expressId)!.attributes[0]);
 assert.equal(readStairDimensions(saved,saved.entities.getExpressIdByGlobalId(guid))?.Width,.0001);
 assert.doesNotThrow(() => parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Native minimum control',units:'m',frame:'storey-local',operations:[{op:'stair.create',ref:'tiny',storey:{modelId:SAMPLE_MODEL,globalId:GROUND_STOREY},params:{...params,Width:.0001}}]})));
});
test('#7273 attached stairs with identical native IDs retain separate owning-model snapshots', async () => {
 const {dataStore,view} = await seedAuthoringSample();
 const api = createStoreAdapter(useViewerStore); assert.ok(api.addStair);
 const made = api.addStair(SAMPLE_MODEL,dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY),params);
 const saved = await parseIfc(editedModelBytes(dataStore,view));
 const model = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
 const other = 'attached-stair-other';
 federationRegistry.unregisterModel(SAMPLE_MODEL);
 const firstOffset = federationRegistry.registerModel(SAMPLE_MODEL,100_000);
 const otherOffset = federationRegistry.registerModel(other,100_000);
 try {
  useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,idOffset:firstOffset}],
   [other,{...model,id:other,idOffset:otherOffset,maxExpressId:Math.max(...saved.entityIndex.byId.keys()),ifcDataStore:saved}]]),mutationViews:new Map([[SAMPLE_MODEL,view]])});
  const firstId = federationRegistry.toGlobalId(SAMPLE_MODEL,made.expressId);
  const otherId = federationRegistry.toGlobalId(other,made.expressId);
  useViewerStore.getState().setSelectedEntityIds([firstId,otherId]);
  const grounding = captureSelectionGrounding(useViewerStore.getState());
  assert.deepEqual(grounding.elements.map(row => [row.modelId,row.nativeStairExpected]),
   [[SAMPLE_MODEL,readStairDimensions(dataStore,made.expressId,view)],
    [other,readStairDimensions(saved,made.expressId)]]);
  assert.equal(grounding.unresolved,0);
 } finally { federationRegistry.unregisterModel(SAMPLE_MODEL); federationRegistry.unregisterModel(other); }
});
