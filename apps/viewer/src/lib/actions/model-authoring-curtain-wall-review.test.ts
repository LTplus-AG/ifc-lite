/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { DEFAULT_SECTIONS } from '@/lib/profile-section/profile-kinds';
import { getAttributeNamesForSchema } from '@ifc-lite/parser';
import { IfcCreator, curtainWallLayout, type CurtainWallInStoreParams } from '@ifc-lite/create';
import { RelationshipType } from '@ifc-lite/data';
import { EMPTY_SOURCE_BYTES, EntityExtractor } from '@ifc-lite/parser';
import { MutablePropertyView, iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import { fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { GROUND_STOREY, SAMPLE_MODEL, parseIfc, seedAuthoringSample, danglingReferences } from '@/test/authoring-sample-fixture';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { parseModelAuthoringBatch } from './model-authoring';
import { authoringReader, materialNameOf } from './model-authoring-read';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { undoModelChanges } from './model-change-commit';
import { createStoreAdapter } from '@/sdk/adapters/store-adapter';
import { uniqueSplitGuids, uniqueSplitGuid } from './model-authoring-split';
import { useAssistant, cancelAssistant, replaceEvidence } from '@/lib/assistant/conversation';
import { captureEvidence } from '@/lib/assistant/evidence';
import { sendAssistant } from '@/lib/assistant/request';
import { authoringGhosts } from './model-authoring-ghost';
const original = useViewerStore.getState(),originalAssistant=useAssistant.getState(),originalFetch=globalThis.fetch;
afterEach(() => {cancelAssistant();useViewerStore.setState(original);useAssistant.setState(originalAssistant);globalThis.fetch=originalFetch;});
const state = useViewerStore.getState;
const base: CurtainWallInStoreParams = { Start: [1,2,1], End: [5,2,1], Height: 3, UGrid: 2, VGrid: 2, Name: 'Reviewed native aggregate' };
const op = (params: unknown = base, modelId = SAMPLE_MODEL, globalId = GROUND_STOREY, ref = 'curtain') => ({ op: 'curtainWall.create', ref, storey: { modelId, globalId }, params });
function batch(operations: unknown[], units: 'm'|'mm' = 'm') { return parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native curtain aggregate', units, frame: 'storey-local', operations })); }
async function exportGraph(bytes: Uint8Array) {
  const parsed = await parseIfc(bytes), extractor = new EntityExtractor(parsed.source);
  return [...iterateEffectiveEntityIds(parsed, undefined)].map(({ expressId }) => {
    const ref = parsed.entityIndex.byId.get(expressId); assert.ok(ref);
    return extractor.extractEntity(ref);
  }).sort((a,b) => a!.expressId-b!.expressId);
}
function bytes(modelId = SAMPLE_MODEL) { return editedModelBytes(state().models.get(modelId)!.ifcDataStore!, state().mutationViews.get(modelId)!); }
async function assertAggregate(guid: string, expectedMembers: number, expectedPanels: number, modelId = SAMPLE_MODEL) {
  const source = bytes(modelId); assert.deepEqual(danglingReferences(new TextDecoder().decode(source)), []);
  const parsed = await parseIfc(source), id = parsed.entities.getExpressIdByGlobalId(guid); assert.ok(id > 0);
  assert.equal(parsed.entities.getTypeName(id), 'IfcCurtainWall');
  const children = parsed.relationships.getRelated(id, RelationshipType.Aggregates, 'forward');
  assert.equal(children.length, expectedMembers+expectedPanels);
  assert.equal(children.filter(child => parsed.entities.getTypeName(child)==='IfcMember').length, expectedMembers);
  assert.equal(children.filter(child => parsed.entities.getTypeName(child)==='IfcPlate').length, expectedPanels);
  for (const child of children) assert.deepEqual(parsed.relationships.getRelated(child, RelationshipType.Aggregates, 'inverse'), [id]);
  return { parsed, id, children };
}
for (const variant of ['default', 'explicit', 'section'] as const) test(`#7298 ${variant} native aggregate preview is pure and commit/export/full graph Undo retain all parts`, async () => {
  await seedAuthoringSample();
  const params: CurtainWallInStoreParams = variant==='default' ? base : variant==='explicit' ? { ...base, UGrid:[1,3], VGrid:[1], EdgeMembers:false } : { ...base, PanelThickness:.032, MullionProfile:{Type:'Circle',Radius:.04}, TransomProfile:{Type:'Rectangle',XDim:.06,YDim:.12} };
  const view=state().mutationViews.get(SAMPLE_MODEL)!, lease=view.prepareAtomic(()=>null), source=bytes(), history=state().undoStacks, editors=state().storeEditors;
  const preview=previewModelAuthoring(state(),batch([op(params)])); assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');
  assert.doesNotThrow(lease.validate,'Preview preserves the held real native source/allocator lease'); assert.equal(state().storeEditors,editors); assert.equal(state().undoStacks,history);
  assert.deepEqual(await exportGraph(bytes()),await exportGraph(source));
  assert.equal(preview.rows[0].previewUnavailable,variant==='section');
  assert.equal(authoringGhosts(state(),preview).length,variant==='section'?0:2,'Only actual native command-compatible details receive a ghost');
  const requested:number[][]=[],restore=setRequestRemesh((_get,request)=>requested.push([...request.expressIds]));
  let result; try {result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'native aggregate');} finally {restore();}
  assert.ok(result.ok,result.ok?'':result.detail??result.reason); assert.equal(result.receipt.batches.length,1); assert.equal(requested.length,1);
  const native=curtainWallLayout(params),proof=await assertAggregate(result.receipt.applied[0].globalId,native.mullions.length+native.transoms.length,native.panels.length);
  assert.deepEqual(new Set(requested[0]),new Set([proof.id,...proof.children]),'One native remesh includes every owned aggregate product');
  assert.ok(undoModelChanges(useViewerStore,result.receipt).ok); assert.deepEqual(await exportGraph(bytes()),await exportGraph(source),'One Undo restores every native EXPRESS entity and reference');
  state().redo(SAMPLE_MODEL); await assertAggregate(result.receipt.applied[0].globalId,native.mullions.length+native.transoms.length,native.panels.length);
});
for (const Schema of ['IFC2X3','IFC4','IFC4X3'] as const) for (const units of ['m','mm'] as const) test(`#7298 native ${Schema} ${units} count grids stay dimensionless and explicit lengths export in owning source units`,async()=>{
  await seedAuthoringSample();
  const creator=new IfcCreator({Schema,LengthUnit:units==='mm'?'MILLIMETRE':'METRE',Name:'Native canonical schema invariant'}),storey=creator.addIfcBuildingStorey({Name:'Storey',Elevation:0});
  const parsed=await parseIfc(new TextEncoder().encode(creator.toIfc().content)),model={...state().models.get(SAMPLE_MODEL)!,ifcDataStore:parsed},view=new MutablePropertyView(parsed.properties,SAMPLE_MODEL);
  useViewerStore.setState({...fixtureModels(model),mutationViews:new Map([[SAMPLE_MODEL,view]]),storeEditors:new Map(),undoStacks:new Map(),redoStacks:new Map()});
  const factor=units==='mm'?1000:1,params={...base,Start:base.Start.map(v=>v*factor),End:base.End.map(v=>v*factor),Height:base.Height*factor,UGrid:[factor,3*factor],VGrid:2};
  // Explicit offsets are lengths; the same VGrid=2 remains a dimensionless count.
  const preview=previewModelAuthoring(state(),batch([op(params,SAMPLE_MODEL,parsed.entities.getGlobalId(storey))],units));assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');
  const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'native schema units');assert.ok(result.ok,result.ok?'':result.detail??result.reason);
  const proof=await assertAggregate(result.receipt.applied[0].globalId,13,6);assert.equal(proof.parsed.schemaVersion,Schema);
});
test('#7298 federated ownership refuses unpinned reused storey GUID and writes only the explicitly owned native source',async()=>{
  const {dataStore:first,view:firstView}=await seedAuthoringSample(),firstModel=state().models.get(SAMPLE_MODEL)!,second=await parseIfc(first.source.materialize()),secondView=new MutablePropertyView(second.properties,'second');
  useViewerStore.setState({...fixtureModels(firstModel,{...firstModel,id:'second',idOffset:1_000_000,ifcDataStore:second}),mutationViews:new Map([[SAMPLE_MODEL,firstView],['second',secondView]])});
  const unpinned=op();delete (unpinned.storey as {modelId?:string}).modelId;
  assert.equal(previewModelAuthoring(state(),batch([unpinned])).rows[0].status,'ambiguous-target');
  const before=bytes(),preview=previewModelAuthoring(state(),batch([op(base,'second')]));assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');
  const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'native second source');assert.ok(result.ok,result.ok?'':result.detail??result.reason);await assertAggregate(result.receipt.applied[0].globalId,9,4,'second');assert.deepEqual(await exportGraph(bytes()),await exportGraph(before));
});
test('#7298 native source replacement, real Root collision and missing source refuse without publishing aggregate records',async()=>{
  const {dataStore,view}=await seedAuthoringSample(),preview=previewModelAuthoring(state(),batch([op()]));assert.equal(preview.rows[0].status,'ready');
  const replacement=await parseIfc(dataStore.source.materialize());useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...state().models.get(SAMPLE_MODEL)!,ifcDataStore:replacement}]])});
  const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'stale source');assert.ok(!result.ok);assert.equal(view.getNewEntities().length,0);
  await seedAuthoringSample();const collision=previewModelAuthoring(state(),batch([op({...base,GlobalId:GROUND_STOREY})]));assert.notEqual(collision.rows[0].status,'ready');assert.match(collision.rows[0].issue??'',/unique/i);assert.equal(state().mutationViews.get(SAMPLE_MODEL)!.getNewEntities().length,0);
  const source=state().models.get(SAMPLE_MODEL)!.ifcDataStore!;useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...state().models.get(SAMPLE_MODEL)!,ifcDataStore:{...source,source:EMPTY_SOURCE_BYTES}}]])});
  const unavailable=previewModelAuthoring(state(),batch([op()]));assert.equal(unavailable.rows[0].status,'missing-target','Canonical source-free Root lookup cannot verify the original storey');assert.equal(state().mutationViews.get(SAMPLE_MODEL)!.getNewEntities().length,0);
});
test('#7298 layout work caps and invalid offsets refuse before allocation; additive native parts are never silently truncated',()=>{
  assert.throws(()=>batch([op({...base,UGrid:1_000_000})]),/bounded|1500/);
  assert.throws(()=>batch([op({...base,UGrid:[3,1]})]),/increasing/);
  assert.throws(()=>batch([op({...base,End:[5,2,2]})]),/same height/);
  assert.throws(()=>batch([op({...base,UGrid:30,VGrid:30},SAMPLE_MODEL,GROUND_STOREY,'first'),op({...base,UGrid:30,VGrid:30},SAMPLE_MODEL,GROUND_STOREY,'second'),op({...base,UGrid:30,VGrid:30},SAMPLE_MODEL,GROUND_STOREY,'third')]),/5000.*smaller/);
});

test('#7298 one canonical complete Root inventory ignores non-root Names and rejects a duplicate authored peer GUID',async()=>{
  const {dataStore,view}=await seedAuthoringSample(),api=createStoreAdapter(useViewerStore);assert.ok(api.addCurtainWall);
  const made=api.addCurtainWall(SAMPLE_MODEL,dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY),{Start:[1,2,0],End:[5,2,0],Height:3,UGrid:2,VGrid:2}),editor=state().storeEditors.get(SAMPLE_MODEL)!;
  const native=view.getNewEntities().filter(record=>['IFCCURTAINWALL','IFCMEMBER','IFCPLATE'].includes(record.type.toUpperCase())),guids=native.map(record=>String(record.attributes[0]));assert.equal(native.length,14);
  api.addEntity(SAMPLE_MODEL,{type:'IfcMaterial',attributes:[guids[0],null,null]});assert.ok(uniqueSplitGuids(dataStore,editor,guids));assert.ok(uniqueSplitGuid(dataStore,editor,guids[0]),'The existing singular guard preserves schema-role semantics');
  editor.setAttribute(native[1].expressId,'GlobalId',guids[0]);const saved=await parseIfc(bytes());assert.equal([...iterateEffectiveEntityIds(saved,undefined,['IfcCurtainWall','IfcMember','IfcPlate'])].filter(({expressId})=>saved.entities.getGlobalId(expressId)===guids[0]).length,2,'Independent export confirms two genuine native Root identities');assert.equal(uniqueSplitGuids(dataStore,editor,guids),false);assert.equal(uniqueSplitGuid(dataStore,editor,guids[0]),false);
  assert.equal(made.expressId,native.find(record=>record.type.toUpperCase()==='IFCCURTAINWALL')!.expressId);
});
test('#7298 actual assistant stream guidance admits native curtain params; explicit reviewed commit exports the complete aggregate',async()=>{
  const {dataStore}=await seedAuthoringSample();useViewerStore.setState({selectedEntity:{modelId:SAMPLE_MODEL,expressId:dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY)},selectedEntityId:null,selectedEntities:[],selectedEntitiesSet:new Set(),selectedEntityIds:new Set()});replaceEvidence(captureEvidence('selection'));let calls=0;
  globalThis.fetch=async(_input,init)=>{calls++;const wire=JSON.parse(String(init?.body)),system=typeof wire.system==='string'?wire.system:wire.system.map((block:{text:string})=>block.text).join('\n');assert.match(system,/curtainWall.create/);assert.match(system,/UGrid\/VGrid/);const answer=JSON.stringify({version:1,kind:'model.authoring',title:'Streamed native curtain',units:'m',frame:'storey-local',operations:[op()]});return new Response(`data: ${JSON.stringify({choices:[{delta:{content:answer},finish_reason:'stop'}]})}\n\n`);};
  assert.equal(await sendAssistant('Prepare a curtain wall with these explicit source storey and dimensions','openai/gpt-free','/api/chat'),true,useAssistant.getState().error??'');assert.equal(calls,1);assert.equal(state().mutationViews.get(SAMPLE_MODEL)!.getNewEntities().length,0,'Transport never autoruns the native writer');
  const answer=useAssistant.getState().messages.at(-1)?.content;assert.ok(answer);const preview=previewModelAuthoring(state(),parseModelAuthoringBatch(answer));assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'native curtain stream');assert.ok(result.ok,result.ok?'':result.detail??result.reason);await assertAggregate(result.receipt.applied[0].globalId,9,4);
});

for (const [kind, section] of Object.entries(DEFAULT_SECTIONS)) test(`#7298 native ${kind} member sections export through the shared profile factory without an invented rectangular preview`,async()=>{
  await seedAuthoringSample();const preview=previewModelAuthoring(state(),batch([op({...base,MullionProfile:section})]));assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');assert.equal(preview.rows[0].previewUnavailable,true);
  const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'native section family');assert.ok(result.ok,result.ok?'':result.detail??result.reason);const proof=await assertAggregate(result.receipt.applied[0].globalId,9,4);
  const profiles=[...proof.parsed.entityIndex.byId.values()].filter(record=>record.type.endsWith('PROFILEDEF'));assert.ok(profiles.length>0);
  const nativeTypes:{[key:string]:string}={I:'IFCISHAPEPROFILEDEF',L:'IFCLSHAPEPROFILEDEF',T:'IFCTSHAPEPROFILEDEF',U:'IFCUSHAPEPROFILEDEF',C:'IFCCSHAPEPROFILEDEF',Circle:'IFCCIRCLEPROFILEDEF',RectangleHollow:'IFCRECTANGLEHOLLOWPROFILEDEF',CircleHollow:'IFCCIRCLEHOLLOWPROFILEDEF'};
  const record=profiles.find(record=>record.type===nativeTypes[kind]);assert.ok(record,`Independent native source contains supplied ${kind} profile`);
  const entity=proof.parsed.getEntity(record.expressId);assert.ok(entity);const names=getAttributeNamesForSchema(record.type,proof.parsed.schemaVersion);
  for(const [name,value] of Object.entries(section))if(name!=='Type'){const slot=names.indexOf(name);assert.ok(slot>=0,`Exact native EXPRESS dimension ${name}`);assert.ok(Math.abs(Number(entity.attributes[slot])/1000-Number(value))<1e-9,'Native millimetre source retains the supplied metre section dimensions');}
});
test('#7298 explicit native empty/whitespace text is preserved and malformed GlobalId refuses unpublished creation',async()=>{
  await seedAuthoringSample();const preview=previewModelAuthoring(state(),batch([op({...base,Name:'',Description:'  native description  ',ObjectType:'',Tag:'tag; native'})]));assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');
  const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'native metadata');assert.ok(result.ok,result.ok?'':result.detail??result.reason);const proof=await assertAggregate(result.receipt.applied[0].globalId,9,4),entity=proof.parsed.getEntity(proof.id);assert.ok(entity);const names=getAttributeNamesForSchema('IfcCurtainWall',proof.parsed.schemaVersion);
  for(const [key,value]of Object.entries({Name:'',Description:'  native description  ',ObjectType:'',Tag:'tag; native'}))assert.equal(entity.attributes[names.indexOf(key)],value);
  const view=state().mutationViews.get(SAMPLE_MODEL)!,lease=view.prepareAtomic(()=>null),before=await exportGraph(bytes()),invalid=previewModelAuthoring(state(),batch([op({...base,GlobalId:'invalid-native-guid'})]));assert.notEqual(invalid.rows[0].status,'ready');assert.match(invalid.rows[0].issue??'',/GlobalId|GUID/i);assert.doesNotThrow(lease.validate);assert.deepEqual(await exportGraph(bytes()),before);
});

test('#7298 native aggregate references preserve material ownership, excluded dependency and complete one-batch Undo',async()=>{
  await seedAuthoringSample();const source=await exportGraph(bytes()),preview=previewModelAuthoring(state(),batch([op(),{op:'material.assign',target:{ref:'curtain'},material:{name:'Authored native curtain finish',create:true}}]));assert.deepEqual(preview.rows.map(row=>row.status),['ready','ready']);assert.deepEqual(preview.rows[1].dependsOn,[0]);
  assert.deepEqual(commitModelAuthoring(useViewerStore,preview,new Set([1]),'excluded dependency'),{ok:false,reason:'nothing-approved'});assert.deepEqual(await exportGraph(bytes()),source);
  const result=commitModelAuthoring(useViewerStore,preview,new Set([0,1]),'owned native material');assert.ok(result.ok,result.ok?'':result.detail??result.reason);assert.equal(result.receipt.applied[0].globalId,result.receipt.applied[1].globalId);
  const proof=await assertAggregate(result.receipt.applied[0].globalId,9,4),reader=authoringReader(state(),SAMPLE_MODEL);assert.ok(reader);assert.equal(materialNameOf(reader,proof.id),'Authored native curtain finish');
  assert.ok(undoModelChanges(useViewerStore,result.receipt).ok);assert.deepEqual(await exportGraph(bytes()),source);
});
