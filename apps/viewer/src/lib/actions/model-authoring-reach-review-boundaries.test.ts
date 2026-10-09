/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { EMPTY_SOURCE_BYTES } from '@ifc-lite/parser';
import { authoringReachEvidence } from './model-authoring-reach';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { readWallJoinTarget, trimExtendElementInStore } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { seedAuthoringSample, SAMPLE_MODEL, GROUND_STOREY, parseIfc } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { configureMutationView } from '@/utils/configureMutationView';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { commitModelAuthoring } from './model-authoring-commit';
import { previewModelAuthoring } from '@/lib/actions/model-authoring-preview';
const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial));
const line = (x:number): Parameters<typeof trimExtendElementInStore>[3]['boundary'] => ({a:[x,0],b:[x,10],tMin:0,tMax:1,reach:0});
async function savedFixture() {
 const {dataStore,view}=await seedAuthoringSample();
 const storey=dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
 const made=useViewerStore.getState().addWall(SAMPLE_MODEL,storey,{Start:[0,5,0],End:[8,5,0],Thickness:.2,Height:3,Name:'Native saved reach'}); assert.ok('expressId' in made);
 const edge=useViewerStore.getState().addWall(SAMPLE_MODEL,storey,{Start:[10,0,0],End:[10,10,0],Thickness:.2,Height:3,Name:'Native saved boundary'}); assert.ok('expressId' in edge);
 const source=await parseIfc(editedModelBytes(dataStore,view));
 const sourceView=new MutablePropertyView(source.properties,SAMPLE_MODEL); configureMutationView(sourceView,source);
 const model=useViewerStore.getState().models.get(SAMPLE_MODEL);assert.ok(model);
 useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:source}]]),mutationViews:new Map([[SAMPLE_MODEL,sourceView]]),storeEditors:new Map()});
 const scale=getModelLengthUnitScale(source), expected=readWallJoinTarget(source,sourceView,made.expressId,scale);assert.ok(expected);
 const ref=(id:number)=>({modelId:SAMPLE_MODEL,globalId:source.entities.getGlobalId(id),ifcClass:source.entities.getTypeName(id),name:source.entities.getName(id)});
 const op={op:'element.trimExtend',mode:'extend',target:ref(made.expressId),expected:{kind:'wall',wall:expected},click:[8,5],boundary:{line:line(10)}};
 return {source,sourceView,scale,id:made.expressId,boundary:edge.expressId,ref,op};
}
const proposal=(operation:unknown)=>parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Independent Trim review',units:'m',frame:'storey-local',operations:[operation]}));
test('#7262 native saved Trim/Extend writer control has independently exported endpoint geometry',async()=>{
 const f=await savedFixture();
 const view=new MutablePropertyView(f.source.properties,SAMPLE_MODEL);configureMutationView(view,f.source);
 const result=trimExtendElementInStore(f.source,new StoreEditor(f.source,view),f.id,{mode:'extend',click:[8,5],boundary:line(10)});assert.equal(result.length,10);
 const saved=await parseIfc(editedModelBytes(f.source,view));
 assert.deepEqual(readWallJoinTarget(saved,new MutablePropertyView(saved.properties,SAMPLE_MODEL),f.id,getModelLengthUnitScale(saved))?.wall.end,[10,5]);
});
test('#7262 first-read saved Trim/Extend preview preserves the prepared live lease and empty editor registry',async()=>{
 const f=await savedFixture(),lease=f.sourceView.prepareAtomic(()=>null),editors=useViewerStore.getState().storeEditors;
 const preview=previewModelAuthoring(useViewerStore.getState(),proposal(f.op));assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue ?? "native Trim/Extend review status");
 assert.doesNotThrow(()=>lease.validate(),'read-only trim preflight must not alter the source allocator watermark');
 assert.equal(useViewerStore.getState().storeEditors,editors);assert.equal(editors.size,0);
});
for(const duplicate of ['target','boundary'] as const) test(`#7262 genuine same-model ${duplicate} GUID duplication cannot authorize Trim/Extend`,async()=>{
 const f=await savedFixture(),id=duplicate==='target'?f.id:f.boundary,native=f.source.getEntity(id);assert.ok(native);
 const made=new StoreEditor(f.source,f.sourceView).addEntity(native.type,native.attributes);
 const saved=await parseIfc(editedModelBytes(f.source,f.sourceView));
 assert.equal(saved.getEntity(id)?.attributes[0],f.source.entities.getGlobalId(id));assert.equal(saved.getEntity(made.expressId)?.attributes[0],f.source.entities.getGlobalId(id));
 const boundaryExpected=readWallJoinTarget(f.source,f.sourceView,f.boundary,f.scale);assert.ok(boundaryExpected);
 const op=duplicate==='target'?f.op:{...f.op,boundary:{wall:f.ref(f.boundary),expected:boundaryExpected}};
 const preview=previewModelAuthoring(useViewerStore.getState(),proposal(op));
 assert.equal(preview.rows[0].status,'ambiguous-target',preview.rows[0].issue ?? "native Trim/Extend review status");
});
for(const subject of ['target','boundary'] as const) test(`#7262 saved non-root material Name matching the ${subject} GUID is a valid native Trim/Extend control`,async()=>{
 const f=await savedFixture(),id=subject==='target'?f.id:f.boundary;
 const material=new StoreEditor(f.source,f.sourceView).addEntity('IfcMaterial',[f.source.entities.getGlobalId(id)]);
 const source=await parseIfc(editedModelBytes(f.source,f.sourceView));
 assert.equal(source.getEntity(material.expressId)?.attributes[0],f.source.entities.getGlobalId(id));
 const sourceView=new MutablePropertyView(source.properties,SAMPLE_MODEL);configureMutationView(sourceView,source);
 const model=useViewerStore.getState().models.get(SAMPLE_MODEL);assert.ok(model);
 useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:source}]]),mutationViews:new Map([[SAMPLE_MODEL,sourceView]]),storeEditors:new Map()});
 const expected=readWallJoinTarget(source,sourceView,f.id,f.scale);assert.ok(expected);
 const edge=readWallJoinTarget(source,sourceView,f.boundary,f.scale);assert.ok(edge);
 const ref=(id:number)=>({modelId:SAMPLE_MODEL,globalId:f.source.entities.getGlobalId(id),ifcClass:f.source.entities.getTypeName(id),name:f.source.entities.getName(id)});
 const op={...f.op,target:ref(f.id),expected:{kind:'wall',wall:expected},boundary:subject==='target'?f.op.boundary:{wall:ref(f.boundary),expected:edge}};
 const preview=previewModelAuthoring(useViewerStore.getState(),proposal(op));
 assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue ?? "native Trim/Extend review status");
 const outcome=commitModelAuthoring(useViewerStore,preview,new Set([0]),'native role control');assert.ok(outcome.ok,outcome.ok?'':outcome.detail??outcome.reason);
 const changed=await parseIfc(editedModelBytes(source,sourceView));
 assert.deepEqual(readWallJoinTarget(changed,new MutablePropertyView(changed.properties,SAMPLE_MODEL),f.id,f.scale)?.wall.end,[10,5]);
 useViewerStore.getState().undo(SAMPLE_MODEL);
 const restored=await parseIfc(editedModelBytes(source,sourceView));
 assert.deepEqual(readWallJoinTarget(restored,new MutablePropertyView(restored.properties,SAMPLE_MODEL),f.id,f.scale)?.wall.end,[8,5]);
});

for(const expectedState of ['old','intermediate'] as const) test(`#7262 preceding boundary edit checks the actual ${expectedState} native snapshot`,async()=>{
 const f=await savedFixture();
 const expected=readWallJoinTarget(f.source,f.sourceView,f.boundary,f.scale);assert.ok(expected);
 const horizontal: Parameters<typeof trimExtendElementInStore>[3]['boundary']={a:[5,8],b:[15,8],tMin:0,tMax:1,reach:0};
 const draftView=new MutablePropertyView(f.source.properties,SAMPLE_MODEL);configureMutationView(draftView,f.source);
 trimExtendElementInStore(f.source,new StoreEditor(f.source,draftView),f.boundary,{mode:'trim',click:[10,10],boundary:horizontal});
 const nativeChanged=readWallJoinTarget(f.source,draftView,f.boundary,f.scale);assert.ok(nativeChanged);assert.deepEqual(nativeChanged.wall.end,[10,8]);
 const exported=await parseIfc(editedModelBytes(f.source,draftView));
 assert.deepEqual(readWallJoinTarget(exported,new MutablePropertyView(exported.properties,SAMPLE_MODEL),f.boundary,f.scale)?.wall.end,[10,8]);
 const prior={op:'element.trimExtend',mode:'trim',target:f.ref(f.boundary),expected:{kind:'wall',wall:expected},click:[10,10],boundary:{line:horizontal}};
 const later={...f.op,boundary:{wall:f.ref(f.boundary),expected:expectedState==='old'?expected:nativeChanged}};
 const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Native intermediate boundary',units:'m',frame:'storey-local',operations:[prior,later]}));
 const preview=previewModelAuthoring(useViewerStore.getState(),batch);
 assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue ?? "native Trim/Extend review status");
 if(expectedState==='old') {
  assert.equal(preview.rows[1].status,'invalid');assert.match(preview.rows[1].issue??'',/boundary wall differs/);
  assert.deepEqual(readWallJoinTarget(f.source,f.sourceView,f.boundary,f.scale)?.wall.end,[10,10]);
 } else {
  assert.equal(preview.rows[1].status,'ready',preview.rows[1].issue ?? "native Trim/Extend review status");
  assert.equal(preview.rows[1].previewUnavailable,true,'single-row body ghost must disclose its absent intermediate boundary state');
  const outcome=commitModelAuthoring(useViewerStore,preview,new Set([0,1]),'native intermediate boundary');assert.ok(outcome.ok,outcome.ok?'':outcome.detail??outcome.reason);
  const changed=await parseIfc(editedModelBytes(f.source,f.sourceView));
  const changedView=new MutablePropertyView(changed.properties,SAMPLE_MODEL);
  assert.deepEqual(readWallJoinTarget(changed,changedView,f.id,f.scale)?.wall.end,[10,5]);
  assert.deepEqual(readWallJoinTarget(changed,changedView,f.boundary,f.scale)?.wall.end,[10,8]);
  useViewerStore.getState().undo(SAMPLE_MODEL);
  const restored=await parseIfc(editedModelBytes(f.source,f.sourceView));
  const restoredView=new MutablePropertyView(restored.properties,SAMPLE_MODEL);
  assert.deepEqual(readWallJoinTarget(restored,restoredView,f.id,f.scale)?.wall.end,[8,5]);
  assert.deepEqual(readWallJoinTarget(restored,restoredView,f.boundary,f.scale)?.wall.end,[10,10]);
 }
});

test('#7262 valid source-empty transport does not infer a native reach snapshot from a retained decoder',async()=>{
 const f=await savedFixture(),model=useViewerStore.getState().models.get(SAMPLE_MODEL);assert.ok(model);
 useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:{...f.source,source:EMPTY_SOURCE_BYTES}}]])});
 const lease=f.sourceView.prepareAtomic(()=>null);
 assert.equal(authoringReachEvidence(useViewerStore.getState(),SAMPLE_MODEL,f.id),null);
 const preview=previewModelAuthoring(useViewerStore.getState(),proposal(f.op));
 assert.notEqual(preview.rows[0].status,'ready');
 assert.doesNotThrow(()=>lease.validate());
});
