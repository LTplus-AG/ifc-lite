/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #7275: public native writer and independent STEP prove complete peer identity.
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach,test } from 'node:test';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { layerSetOf } from '@/lib/commands/modeling/authored-kinds.js';
import { commitModelAuthoring } from '@/lib/actions/model-authoring-commit.js';
import { StoreEditor,MutablePropertyView } from '@ifc-lite/mutations';
import { readRelatedLists } from '@ifc-lite/create';
import { useViewerStore } from '@/store/index.js';
import { seedAuthoringSample,SAMPLE_MODEL,GROUND_STOREY,FRONT_WALL_TYPE,parseIfc } from '@/test/authoring-sample-fixture.js';
import { editedModelBytes } from '@/lib/export/edited-model-bytes.js';
import { recordModellingEdit,detachFromType } from '@/store/slices/mutation-modelling-records.js';
import { applyMaterialLayers } from '@/components/viewer/model-inspector/inspector-edits.js';
import { captureSelectionGrounding } from '@/lib/actions/selection-grounding.js';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring.js';
import { previewModelAuthoring } from '@/lib/actions/model-authoring-preview.js';
import { resolveReviewedLayers, writeReviewedLayers } from '@/lib/actions/model-authoring-layers.js';
import { nativeLayerEvidence } from '@/lib/actions/native-layer-evidence.js';
import { readOnlyModelEditTarget } from '@/lib/actions/model-authoring-read-target.js';
const initial=useViewerStore.getState();afterEach(()=>useViewerStore.setState(initial));
async function fixture(duplicate=true){
 const {dataStore,view}=await seedAuthoringSample();const typeId=dataStore.entities.getExpressIdByGlobalId(FRONT_WALL_TYPE);
 const sourceRelation=readRelatedLists(dataStore,'IfcRelDefinesByType',view).find(row=>row.relatingId===typeId);assert.ok(sourceRelation?.relatedIds.length);
 const peer=sourceRelation.relatedIds[0],record=dataStore.getEntity(peer);assert.ok(record);
 const clone=new StoreEditor(dataStore,view).addEntity(record.type,[generateIfcGuid(),...record.attributes.slice(1)]);
 const made=useViewerStore.getState().addWall(SAMPLE_MODEL,dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY),{Start:[20,20,0],End:[24,20,0],Thickness:.2,Height:3,Name:'Independent layer target'});assert.ok('expressId' in made);
 const target=made.expressId;assert.ok(clone.expressId<target,'native allocation preserves peer ordering for the membership counterexample');
 recordModellingEdit(useViewerStore,SAMPLE_MODEL,methods=>methods.assignType(SAMPLE_MODEL,typeId,[target]));
 assert.notEqual(applyMaterialLayers(SAMPLE_MODEL,{kind:'wall',target:'type',elementId:target,typeId,layers:[{thickness:.3,material:null}]}),null);
 const saved=await parseIfc(editedModelBytes(dataStore,view));
 assert.notEqual(saved.getEntity(peer)?.attributes[0],saved.getEntity(clone.expressId)?.attributes[0]);
 const refs=readRelatedLists(saved,'IfcRelDefinesByType').filter(row=>row.relatingId===typeId).flatMap(row=>row.relatedIds);
 assert.ok(refs.includes(peer)&&refs.includes(target)&&!refs.includes(clone.expressId));
 const state=useViewerStore.getState(),grounding=captureSelectionGrounding({...state,selectedEntityIds:new Set([target])});
 const expected=grounding.elements[0]?.nativeLayers?.expected;assert.ok(expected?.peers);
 const globalId=view.getNewEntity(target)?.attributes[0];assert.ok(typeof globalId==='string');
 if(duplicate) {
  assert.equal(typeof record.attributes[0], 'string');
  new StoreEditor(dataStore, view).setPositionalAttribute(clone.expressId, 0, String(record.attributes[0]));
  const duplicateSource=await parseIfc(editedModelBytes(dataStore,view));
  assert.equal(duplicateSource.getEntity(peer)?.attributes[0],duplicateSource.getEntity(clone.expressId)?.attributes[0]);
 }
 const op={op:'material.layers',target:{modelId:SAMPLE_MODEL,globalId,ifcClass:'IfcWall',name:'Independent layer target'},scope:'type',expected,MaterialLayers:[{LayerThickness:.4,Material:null}]};
 return {dataStore,view,target,typeId,peer,clone:clone.expressId,op,expected};
}
test('native exported duplicate nonselected peer is not uniquely attestable as a type-layer population',async()=>{
 const f=await fixture();const r=readOnlyModelEditTarget(useViewerStore.getState(),SAMPLE_MODEL);assert.ok(r);
 const evidence=nativeLayerEvidence(useViewerStore.getState(),r,f.target);
 assert.notEqual(evidence.typeScopeStatus,'available','a complete peer population cannot attest a same-model ambiguous peer GUID');
});
test('native exported peer replacement with the same GUID/Name cannot satisfy an earlier type-layer expectation',async()=>{
 const f=await fixture();
 recordModellingEdit(useViewerStore,SAMPLE_MODEL,(methods,draft)=>{detachFromType(draft,f.dataStore,[f.peer]);methods.assignType(SAMPLE_MODEL,f.typeId,[f.clone]);});
 const saved=await parseIfc(editedModelBytes(f.dataStore,f.view));
 const refs=readRelatedLists(saved,'IfcRelDefinesByType').filter(row=>row.relatingId===f.typeId).flatMap(row=>row.relatedIds);
 assert.ok(!refs.includes(f.peer)&&refs.includes(f.clone)&&refs.includes(f.target),'independent export proves the current native type peer membership changed');
 const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Stale native peer population',units:'m',frame:'storey-local',operations:[f.op]}));
 const preview=previewModelAuthoring(useViewerStore.getState(),batch);
 assert.notEqual(preview.rows[0].status,'ready','old peer snapshot must not authorize a different native peer population');
});

test('native unique-peer layer population control previews purely and exports the type-layer change with Undo',async()=>{
 const f=await fixture(false),lease=f.view.prepareAtomic(()=>null);
 const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Native unique peer control',units:'m',frame:'storey-local',operations:[f.op]}));
 const preview=previewModelAuthoring(useViewerStore.getState(),batch);assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue);assert.doesNotThrow(()=>lease.validate());
 const outcome=commitModelAuthoring(useViewerStore,preview,new Set([0]),'native control');assert.ok(outcome.ok,outcome.ok?'':outcome.detail??outcome.reason);
 const saved=await parseIfc(editedModelBytes(f.dataStore,f.view));
 assert.equal(layerSetOf({dataStore:saved,view:new MutablePropertyView(saved.properties ?? null,SAMPLE_MODEL)},f.typeId)?.layers[0].thickness,.4);
 useViewerStore.getState().undo(SAMPLE_MODEL);
 const restored=await parseIfc(editedModelBytes(f.dataStore,f.view));
 assert.equal(layerSetOf({dataStore:restored,view:new MutablePropertyView(restored.properties ?? null,SAMPLE_MODEL)},f.typeId)?.layers[0].thickness,.3);
});


test('#7275 native layer writer rechecks newly ambiguous peers in its intermediate atomic draft', async () => {
 const f = await fixture(false), state = useViewerStore.getState();
 const reader = readOnlyModelEditTarget(state, SAMPLE_MODEL); assert.ok(reader);
 const batch = parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Intermediate peer check',units:'m',frame:'storey-local',operations:[f.op]}));
 const op = batch.operations[0]; assert.equal(op.op, 'material.layers'); if (op.op !== 'material.layers') throw new Error('Expected material.layers');
 const spec = resolveReviewedLayers(state, reader, f.target, op, 'm');
 const peerGuid = f.dataStore.getEntity(f.peer)?.attributes[0]; assert.equal(typeof peerGuid, 'string');
 assert.throws(() => recordModellingEdit(useViewerStore, SAMPLE_MODEL, (methods, draft) => {
  draft.setPositionalAttribute(f.clone, 0, String(peerGuid));
  const target = {modelId:SAMPLE_MODEL,dataStore:f.dataStore,view:draft.getMutationView(),editor:draft};
  writeReviewedLayers(target, draft, methods, spec, op, 'm', useViewerStore.getState());
 }), /peer population|complete current peer/i, 'the native write cannot reuse a preview after a preceding draft changes peer identity');
 const saved = await parseIfc(editedModelBytes(f.dataStore, f.view));
 assert.notEqual(saved.getEntity(f.peer)?.attributes[0], saved.getEntity(f.clone)?.attributes[0], 'failed atomic write rolls back the preceding native GUID change');
 assert.equal(layerSetOf({dataStore:saved,view:new MutablePropertyView(saved.properties ?? null,SAMPLE_MODEL)},f.typeId)?.layers[0].thickness,.3);
});
