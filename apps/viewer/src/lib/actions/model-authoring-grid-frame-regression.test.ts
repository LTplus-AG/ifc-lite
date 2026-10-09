/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { StoreEditor, MutablePropertyView } from '@ifc-lite/mutations';
import { rectangularGridAxes } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { seedAuthoringSample, SAMPLE_MODEL, GROUND_STOREY, parseIfc } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { authoringGhosts } from './model-authoring-ghost';
const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
for (const mode of ['named', 'positional'] as const) test(`#7304 current ${mode} native storey frame has an independent saved positive and an honest grid ghost limitation`, async () => {
 const { dataStore, view } = await seedAuthoringSample();
 const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
 const editor = new StoreEditor(dataStore, view);
 const point = editor.addEntity('IfcCartesianPoint', [[25000,30000,5000]]);
 const vertical = editor.addEntity('IfcDirection', [[0,0,1]]);
 const direction = editor.addEntity('IfcDirection', [[1,0,0]]);
 const axis = editor.addEntity('IfcAxis2Placement3D', [`#${point.expressId}`,`#${vertical.expressId}`,`#${direction.expressId}`]);
 const placement = editor.addEntity('IfcLocalPlacement', [null,`#${axis.expressId}`]);
 if(mode==='named')editor.setAttribute(storey,'ObjectPlacement',`#${placement.expressId}`);
 else editor.setPositionalAttribute(storey,5,`#${placement.expressId}`);
 const saved = await parseIfc(editedModelBytes(dataStore, view));
 const state = useViewerStore.getState();const model = state.models.get(SAMPLE_MODEL)!;
 const plane = buildStoreyWorkplane(state,SAMPLE_MODEL,storey,0);assert.ok(isWorkplane(plane));
 const savedState={...state,models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:saved}]]),mutationViews:new Map<string,MutablePropertyView>(),storeEditors:new Map<string,StoreEditor>()};
 const independent=buildStoreyWorkplane(savedState,SAMPLE_MODEL,storey,0);assert.ok(isWorkplane(independent));
 assert.deepEqual(plane.localToRender([1,2,0]),independent.localToRender([1,2,0]),'actual native export proves the effective current frame');
 const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Current frame grid',units:'m',frame:'storey-local',operations:[{op:'grid.create',ref:'grid',storey:{globalId:GROUND_STOREY,modelId:SAMPLE_MODEL},params:{Position:[0,0,0],Direction:0,...rectangularGridAxes({UOffsets:[0,6],VOffsets:[0,4]}),Name:'Current frame grid'}}]}));
 const savedPreview=previewModelAuthoring(savedState,batch);assert.equal(savedPreview.rows[0].status,'ready',savedPreview.rows[0].issue??'');
 assert.ok(authoringGhosts(savedState,savedPreview).length>0,'same frame as independently saved source has a real native grid ghost');
 const revision=view.getMutationRevision();const currentPreview=previewModelAuthoring(state,batch);assert.equal(currentPreview.rows[0].status,'ready',currentPreview.rows[0].issue??'');
 assert.equal(authoringGhosts(state,currentPreview).length,0,'current edited frame must retain explicit unsupported grid ghost status, not silently bypass the saved/current comparison');
 assert.equal(view.getMutationRevision(),revision,'ghost reads do not mutate the current source view');
});
