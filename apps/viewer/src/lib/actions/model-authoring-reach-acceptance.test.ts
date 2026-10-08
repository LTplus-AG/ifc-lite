/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { readWallJoinTarget, readWallJoinRels, addHostedElementInStore, readHostedFill } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { seedModelingSession, MODEL_ID, STOREY } from '@/test/modeling-session-fixture';
import { resolvePlacementChain } from '@/lib/placement-edit';
import { fixtureModels } from '@/test/store-fixture';
import { GROUND_STOREY, SAMPLE_MODEL, danglingReferences, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { resolveLinearElementChain } from '@/lib/linear-element-edit';
import { useAssistant, replaceEvidence, cancelAssistant } from '@/lib/assistant/conversation';
import { sendAssistant } from '@/lib/assistant/request';
import { captureEvidence } from '@/lib/assistant/evidence';
import { authoringReachEvidence } from './model-authoring-reach';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { undoModelChanges } from './model-change-commit';
import { setRequestRemesh, type RequestRemesh } from '@/lib/commands/modeling/transaction';
import { remeshAfterCommit } from '@/lib/remesh/remesh-registry';
import { authoringGhosts } from './model-authoring-ghost';

const original = useViewerStore.getState();
const originalAssistant=useAssistant.getState(),originalFetch=globalThis.fetch;
afterEach(() => { cancelAssistant(); globalThis.fetch=originalFetch; useAssistant.setState(originalAssistant,true); useViewerStore.setState(original); });
const state = useViewerStore.getState;
const added = (r: {expressId:number}|{error:string}) => { assert.ok('expressId' in r, 'error' in r ? r.error : ''); return r.expressId; };
const line = (x:number,y:number,factor=1) => ({ a:[x*factor,(y-5)*factor],b:[x*factor,(y+5)*factor],tMin:0,tMax:1,reach:0 });
const batch = (operations:unknown[],units:'m'|'mm'='m') => parseModelAuthoringBatch(JSON.stringify({ version:1,kind:'model.authoring',title:'Canonical reach',units,frame:'storey-local',operations }));
function target(id:number,modelId=SAMPLE_MODEL) {
  const model=state().models.get(modelId)!,view=state().mutationViews.get(modelId)!;
  const made=view.getNewEntity(id);
  const globalId=made?.attributes[0] ?? model.ifcDataStore!.entities.getGlobalId(id);
  const name=made?.attributes[2] ?? model.ifcDataStore!.entities.getName(id);
  const ifcClass=made?.type ?? model.ifcDataStore!.entities.getTypeName(id);
  assert.ok(typeof globalId==='string' && typeof name==='string');
  return {globalId,name,ifcClass,modelId};
}
const operation=(id:number,mode:'trim'|'extend',click:number[],boundary:unknown,modelId=SAMPLE_MODEL) => ({op:'element.trimExtend',target:target(id,modelId),expected:authoringReachEvidence(state(),modelId,id),mode,click,boundary});
async function read(modelId=SAMPLE_MODEL) {
  const s=state(),source=s.models.get(modelId)!.ifcDataStore!, bytes=editedModelBytes(source,s.mutationViews.get(modelId)!);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)),[]);
  const store=await parseIfc(bytes),view=new MutablePropertyView(store.properties,modelId),editor=new StoreEditor(store,view);
  return {store,view,editor,scale:getModelLengthUnitScale(store)};
}

for(const units of ['m','mm'] as const) test(`#7262 native ${units} both-end trim/extend wall, beam and member preserve identity and one Undo/Redo`,async()=>{
  const {dataStore,view}=await seedAuthoringSample(),storey=dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const factor=units==='mm'?1000:1;
  const operations:unknown[]=[],expected:Array<{globalId:string;kind:string;start:number;end:number;y:number}>=[];
  for(const kind of ['wall','beam','member'] as const) for(const mode of ['trim','extend'] as const) for(const end of ['start','end'] as const){
    const y=40+operations.length*4,params={Start:[0,y,0] as [number,number,number],End:[8,y,0] as [number,number,number],Width:.2,Height:.3,Name:`${kind} ${mode} ${end}`};
    const id=added(kind==='wall'?state().addWall(SAMPLE_MODEL,storey,{...params,Thickness:.2,Height:3}):kind==='beam'?state().addBeam(SAMPLE_MODEL,storey,params):state().addMember(SAMPLE_MODEL,storey,params));
    const x=mode==='trim'?(end==='start'?2:6):(end==='start'?-2:10);
    operations.push(operation(id,mode,[(end==='start'?0:8)*factor,y*factor],{line:line(x,y,factor)}));
    expected.push({globalId:target(id).globalId,kind,start:end==='start'?x:0,end:end==='end'?x:8,y});
  }
  const baseline=view.getMutationCount(),proposed=batch(operations,units),preview=previewModelAuthoring(state(),proposed);
  assert.deepEqual(preview.rows.map(r=>[r.status,r.issue]),expected.map(()=>['ready',undefined]));
  assert.equal(view.getMutationCount(),baseline,'native preparation publishes no geometry edits');
  assert.equal(authoringGhosts(state(),preview).length,12,'canonical edited-body/section ghosts cover all eligible paths');
  assert.equal(view.getMutationCount(),baseline,'ghost drafts publish no mutations');
  const remesh: Array<Parameters<RequestRemesh>[1]> = [];
  const restore = setRequestRemesh((get, request) => { remesh.push(request); remeshAfterCommit(get, request.modelId, request.batchId, request.expressIds, request.cause); });
  let result;
  try { result=commitModelAuthoring(useViewerStore,preview,new Set(preview.rows.map(r=>r.index)),'native reach'); } finally { restore(); }
  assert.ok(result.ok,result.ok?'':result.detail ?? result.reason);
  assert.equal(result.receipt.batches.length,1);
  const exported=await read();
  for(const e of expected){
    const id=exported.store.entities.getExpressIdByGlobalId(e.globalId);assert.ok(id>0);
    if(e.kind==='wall') { const wall=readWallJoinTarget(exported.store,exported.view,id,exported.scale);assert.ok(wall);assert.deepEqual(wall.wall.start,[e.start,e.y]);assert.deepEqual(wall.wall.end,[e.end,e.y]); }
    else { const chain=resolveLinearElementChain(exported.store,exported.view,exported.editor,id,exported.scale);assert.ok(chain);assert.deepEqual(chain.startCoordinates,[e.start,e.y,0]);assert.ok(Math.abs(chain.depth-(e.end-e.start))<1e-9); }
  }
  assert.equal(remesh.length,1,'one native transaction hands the committed reach set to remesh');
  assert.equal(remesh[0].cause,'hostsChanged');
  assert.deepEqual([...remesh[0].expressIds].sort((a,b)=>a-b),preview.rows.map(r=>r.expressId!).sort((a,b)=>a-b),'native remesh receives all independently reparsed roots');
  // This source-only fixture has no loaded WASM RTC frame; actual geometry is proven in the dedicated WASM control.
  assert.deepEqual(undoModelChanges(useViewerStore,result.receipt),{ok:true});
  const undone=await read();
  for(const e of expected){const id=undone.store.entities.getExpressIdByGlobalId(e.globalId);const wall=readWallJoinTarget(undone.store,undone.view,id,undone.scale);if(e.kind==='wall'){assert.ok(wall);assert.deepEqual(wall.wall.end,[8,e.y]);}else assert.equal(resolveLinearElementChain(undone.store,undone.view,undone.editor,id,undone.scale)?.depth,8);}
  state().redo(SAMPLE_MODEL);
  const redone=await read();const wall=expected[3];assert.deepEqual(readWallJoinTarget(redone.store,redone.view,redone.store.entities.getExpressIdByGlobalId(wall.globalId),redone.scale)?.wall.end,[wall.end,wall.y]);
  const last=expected.at(-1)!;assert.equal(resolveLinearElementChain(redone.store,redone.view,redone.editor,redone.store.entities.getExpressIdByGlobalId(last.globalId),redone.scale)?.depth,last.end-last.start);
});

test('#7262 selected native evidence exposes verbatim geometry pins and federated commits touch only their owning model',async()=>{
  const {dataStore:first,view:firstView}=await seedAuthoringSample(),second=await parseIfc(first.source.materialize()),firstModel=state().models.get(SAMPLE_MODEL)!;
  const secondView=new MutablePropertyView(second.properties,'second');
  useViewerStore.setState({...fixtureModels(firstModel,{...firstModel,id:'second',idOffset:1_000_000,ifcDataStore:second}),mutationViews:new Map([[SAMPLE_MODEL,firstView],['second',secondView]])});
  const id=added(state().addWall('second',second.entities.getExpressIdByGlobalId(GROUND_STOREY),{Start:[0,5,0],End:[8,5,0],Thickness:.2,Height:3,Name:'Owned reach'}));
  const ref=target(id,'second');useViewerStore.setState({selectedEntity:{modelId:'second',expressId:id},selectedEntityId:null,selectedEntities:[],selectedEntitiesSet:new Set(),selectedEntityIds:new Set()});
  const snapshot=captureEvidence('selection');
  const evidence=JSON.parse(snapshot.payload).evidence.rows[0].data.nativeTrimExtendExpected;
  assert.equal(evidence.wall.location[1],5000,'native file coordinate remains millimetres');assert.equal(evidence.wall.wall.start[1],5,'canonical wall axis remains metres');
  const proposal=batch([{op:'element.trimExtend',target:ref,expected:evidence,mode:'extend',click:[8000,5000],boundary:{line:line(10,5,1000)}}],'mm');
  const preview=previewModelAuthoring(state(),proposal);assert.deepEqual(preview.rows.map(r=>[r.status,r.modelId]),[['ready','second']]);
  const baseline=editedModelBytes(first,firstView),result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'federated reach');assert.ok(result.ok);
  assert.deepEqual(editedModelBytes(first,firstView),baseline,'other model exports the same native graph');
  const exported=await read('second'),persisted=exported.store.entities.getExpressIdByGlobalId(ref.globalId);
  assert.deepEqual(readWallJoinTarget(exported.store,exported.view,persisted,exported.scale)?.wall.end,[10,5]);
});

// The native core, not a copied eligibility list, decides failure before live publication.
test('#7262 invalid native reach and expected-state conflicts preserve the IFC journal and allocations',async()=>{
  const {dataStore,view}=await seedAuthoringSample(),storey=dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const id=added(state().addWall(SAMPLE_MODEL,storey,{Start:[0,5,0],End:[8,5,0],Thickness:.2,Height:3,Name:'Refused reach'}));
  const before=structuredClone({new:view.getNewEntities(),mutations:view.getMutations(),next:view.peekNextExpressId()});
  for(const boundary of [{a:[0,5],b:[10,5],tMin:0,tMax:1,reach:0},line(20,100),line(8,5)]){
    const preview=previewModelAuthoring(state(),batch([operation(id,'trim',[8,5],{line:boundary})]));
    assert.equal(preview.rows[0].status,'invalid');assert.equal(commitModelAuthoring(useViewerStore,preview,new Set([0]),'refusal').ok,false);
  }
  const expected=authoringReachEvidence(state(),SAMPLE_MODEL,id);assert.ok(expected?.kind==='wall');expected.wall.height=9;
  const preview=previewModelAuthoring(state(),batch([{...operation(id,'extend',[8,5],{line:line(10,5)}),expected}]));assert.equal(preview.rows[0].status,'conflict');
  assert.deepEqual({new:view.getNewEntities(),mutations:view.getMutations(),next:view.peekNextExpressId()},before);
});


test('#7262 actual Assistant transport receives native reach pins and its streamed proposal commits through native review',async()=>{
  const {dataStore}=await seedAuthoringSample();
  const id=added(state().addWall(SAMPLE_MODEL,dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY),{Start:[0,5,0],End:[8,5,0],Thickness:.2,Height:3,Name:'Provider native wall'}));
  useViewerStore.setState({selectedEntity:{modelId:SAMPLE_MODEL,expressId:id},selectedEntityId:null,selectedEntities:[],selectedEntitiesSet:new Set(),selectedEntityIds:new Set()});
  const snapshot=captureEvidence('selection');replaceEvidence(snapshot);
  let calls=0;
  globalThis.fetch=async(_url,init)=>{
    calls++;const wire=JSON.parse(String(init?.body));
    const system=typeof wire.system==='string'?wire.system:wire.system.map((block:{text:string})=>block.text).join('\n');
    assert.equal(typeof system,'string');
    assert.ok(system.includes(snapshot.payload),'real provider route transmits the exact frozen native source');
    assert.ok(system.includes('nativeTrimExtendExpected'),'actual guidance names the native producer field');
    const row=JSON.parse(snapshot.payload).evidence.rows[0];
    const answer=JSON.stringify({version:1,kind:'model.authoring',title:'Streamed native reach',units:'m',frame:'storey-local',operations:[{
      op:'element.trimExtend',target:{globalId:row.data.globalId,modelId:row.data.modelId??row.modelId,ifcClass:row.data.type,name:row.data.name},
      expected:row.data.nativeTrimExtendExpected,mode:'extend',click:[8,5],boundary:{line:line(10,5)},
    }]});
    return new Response(`data: ${JSON.stringify({choices:[{delta:{content:answer},finish_reason:'stop'}]})}\n\n`);
  };
  assert.equal(await sendAssistant('Extend the selected wall to x=10 metres','openai/gpt-free','/api/chat'),true,`${calls} native transport calls; ${useAssistant.getState().error}`);
  assert.equal(calls,1);
  const content=useAssistant.getState().messages.at(-1)?.content;assert.ok(content);
  const proposal=parseModelAuthoringBatch(content),preview=previewModelAuthoring(state(),proposal);assert.equal(preview.rows[0].status,'ready');
  const outcome=commitModelAuthoring(useViewerStore,preview,new Set([0]),'controlled native provider');assert.ok(outcome.ok,outcome.ok?'':outcome.detail??outcome.reason);
  const exported=await read(),persisted=exported.store.entities.getExpressIdByGlobalId(outcome.receipt.applied[0].globalId);
  assert.deepEqual(readWallJoinTarget(exported.store,exported.view,persisted,exported.scale)?.wall.end,[10,5]);
});


test('#7262 native newly created boundary supports dependent reach without an invented independent ghost',async()=>{
  const {dataStore}=await seedAuthoringSample(),storey=dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const id=added(state().addWall(SAMPLE_MODEL,storey,{Start:[0,5,0],End:[8,5,0],Thickness:.2,Height:3,Name:'Dependency reach'}));
  const proposed=batch([{op:'element.create',ref:'boundary',ifcClass:'IfcWall',name:'Native boundary',storey:{globalId:GROUND_STOREY,name:dataStore.entities.getName(storey),modelId:SAMPLE_MODEL},params:{start:[10,0,0],end:[10,10,0],thickness:.2,height:3}},operation(id,'extend',[8,5],{wall:{ref:'boundary'}})]);
  const preview=previewModelAuthoring(state(),proposed);
  assert.deepEqual(preview.rows.map(row=>[row.status,row.issue]),[['ready',undefined],['ready',undefined]]);
  assert.equal(preview.rows[1].previewUnavailable,true,'dependent body is not guessed without the full native boundary draft');
  assert.equal(commitModelAuthoring(useViewerStore,preview,new Set([1]),'missing dependency').ok,false);
  const result=commitModelAuthoring(useViewerStore,preview,new Set([0,1]),'native dependency');assert.ok(result.ok,result.ok?'':result.detail??result.reason);
  const exported=await read(),root=exported.store.entities.getExpressIdByGlobalId(target(id).globalId);
  assert.deepEqual(readWallJoinTarget(exported.store,exported.view,root,exported.scale)?.wall.end,[10,5]);
});


test('#7262 native wall boundary joins survive later reach and one Undo without rewriting hosted identity',async()=>{
  const {dataStore,view}=await seedAuthoringSample(),storey=dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const id=added(state().addWall(SAMPLE_MODEL,storey,{Start:[0,5,0],End:[8,5,0],Thickness:.2,Height:3,Name:'Joined reach'}));
  const boundary=added(state().addWall(SAMPLE_MODEL,storey,{Start:[10,0,0],End:[10,10,0],Thickness:.2,Height:3,Name:'Existing boundary'}));
  const fill=addHostedElementInStore(dataStore,state().storeEditors.get(SAMPLE_MODEL)!,id,{kind:'door',params:{Offset:4,Sill:0,Width:1,Height:2}});
  const doorBefore=readHostedFill(dataStore,fill.expressId,view);assert.ok(doorBefore);
  const nativeBoundary=authoringReachEvidence(state(),SAMPLE_MODEL,boundary);assert.ok(nativeBoundary?.kind==='wall');
  const preview=previewModelAuthoring(state(),batch([operation(id,'extend',[8,5],{wall:target(boundary),expected:nativeBoundary.wall})]));
  assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue);
  const joined=commitModelAuthoring(useViewerStore,preview,new Set([0]),'native join');assert.ok(joined.ok);
  assert.equal(readWallJoinRels(dataStore,view,new Set([id])).length,1);
  const next=previewModelAuthoring(state(),batch([operation(id,'trim',[0,5],{line:line(2,5)})]));
  assert.equal(next.rows[0].status,'ready',next.rows[0].issue);
  const trimmed=commitModelAuthoring(useViewerStore,next,new Set([0]),'native joined host trim');assert.ok(trimmed.ok);
  assert.equal(readWallJoinRels(dataStore,view,new Set([id])).length,1,'opposite native joined end is retained');
  const doorAfter=readHostedFill(dataStore,fill.expressId,view);assert.ok(doorAfter);assert.equal(doorAfter.location[0],doorBefore.location[0]-2000,'moved start refits filling in actual file units');
  const exported=await read(),persisted=exported.store.entities.getExpressIdByGlobalId(target(id).globalId);
  assert.deepEqual(readWallJoinTarget(exported.store,exported.view,persisted,exported.scale)?.wall.start,[2,5]);
  const journal=structuredClone({entities:view.getNewEntities(),mutations:view.getMutations(),next:view.peekNextExpressId()});
  const cut=previewModelAuthoring(state(),batch([operation(id,'trim',[2,5],{line:line(4.5,5)})]));
  assert.equal(cut.rows[0].status,'invalid');assert.match(cut.rows[0].issue??'',/hosted/);
  assert.deepEqual({entities:view.getNewEntities(),mutations:view.getMutations(),next:view.peekNextExpressId()},journal);
  assert.deepEqual(undoModelChanges(useViewerStore,trimmed.receipt),{ok:true});
  assert.deepEqual(readHostedFill(dataStore,fill.expressId,view),doorBefore);
  assert.deepEqual(undoModelChanges(useViewerStore,joined.receipt),{ok:true});
  assert.equal(readWallJoinRels(dataStore,view,new Set([id])).length,0);
});


for(const unit of ['metre','millimetre'] as const)test(`#7262 native ${unit} file uses verbatim snapshot coordinates while explicit command lengths remain metres`,async()=>{
  const view=await seedModelingSession({unit}),store=state().models.get(MODEL_ID)!.ifcDataStore!;
  const id=added(state().addWall(MODEL_ID,STOREY,{Start:[0,5,0],End:[8,5,0],Height:3,Thickness:.2,Name:'File unit reach'}));
  const pin=authoringReachEvidence(state(),MODEL_ID,id);assert.ok(pin?.kind==='wall');
  assert.equal(pin.wall.location[1],unit==='metre'?5:5000);
  const preview=previewModelAuthoring(state(),batch([operation(id,'extend',[8,5],{line:line(10,5)},MODEL_ID)]));assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue);
  assert.ok(commitModelAuthoring(useViewerStore,preview,new Set([0]),'file unit reach').ok);
  const exported=await read(MODEL_ID);assert.deepEqual(readWallJoinTarget(exported.store,exported.view,exported.store.entities.getExpressIdByGlobalId(target(id,MODEL_ID).globalId),exported.scale)?.wall.end,[10,5]);
  assert.ok(view.getMutationCount()>0&&store.source.length>0);
});

test('#7262 native replay and source reload refuse approved reach without a second publication',async()=>{
  const {dataStore,view}=await seedAuthoringSample(),id=added(state().addWall(SAMPLE_MODEL,dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY),{Start:[0,5,0],End:[8,5,0],Height:3,Thickness:.2,Name:'Freshness reach'}));
  const proposed=batch([operation(id,'extend',[8,5],{line:line(10,5)})]),preview=previewModelAuthoring(state(),proposed);
  view.setAttribute(id,'Description','Native replay after approved reach',undefined,true);
  assert.match(new TextDecoder().decode(editedModelBytes(dataStore,view)),/Native replay after approved reach/);
  assert.deepEqual(commitModelAuthoring(useViewerStore,preview,new Set([0]),'replay'),{ok:false,reason:'stale'});
  const current=previewModelAuthoring(state(),proposed),loaded=await parseIfc(editedModelBytes(dataStore,view)),model=state().models.get(SAMPLE_MODEL)!;
  useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:loaded}]])});
  assert.deepEqual(commitModelAuthoring(useViewerStore,current,new Set([0]),'reload'),{ok:false,reason:'stale'});
});

test('#7262 shared native beam start refuses while end reach preserves the peer and allocations',async()=>{
  const {dataStore,view}=await seedAuthoringSample(),storey=dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const id=added(state().addBeam(SAMPLE_MODEL,storey,{Start:[0,20,0],End:[8,20,0],Width:.2,Height:.3,Name:'Shared target'}));
  const peer=added(state().addBeam(SAMPLE_MODEL,storey,{Start:[0,25,0],End:[8,25,0],Width:.2,Height:.3,Name:'Shared peer'}));
  const editor=state().storeEditors.get(SAMPLE_MODEL)!,scale=getModelLengthUnitScale(dataStore),chain=resolveLinearElementChain(dataStore,view,editor,id,scale),placement=resolvePlacementChain(dataStore,view,editor,peer);assert.ok(chain&&placement);
  editor.setPositionalAttribute(placement.axisPlacementId,0,`#${chain.startPointId}`);
  const before=structuredClone(resolveLinearElementChain(dataStore,view,editor,peer,scale));
  const end=previewModelAuthoring(state(),batch([operation(id,'extend',[8,20],{line:line(10,20)})]));assert.equal(end.rows[0].status,'ready',end.rows[0].issue);
  assert.ok(commitModelAuthoring(useViewerStore,end,new Set([0]),'shared end').ok);
  assert.deepEqual(resolveLinearElementChain(dataStore,view,editor,peer,scale),before);
  const journal=structuredClone({entities:view.getNewEntities(),mutations:view.getMutations(),next:view.peekNextExpressId()});
  const start=previewModelAuthoring(state(),batch([operation(id,'extend',[0,20],{line:line(-2,20)})]));assert.equal(start.rows[0].status,'invalid');assert.match(start.rows[0].issue??'',/shares placement or geometry/);
  assert.deepEqual({entities:view.getNewEntities(),mutations:view.getMutations(),next:view.peekNextExpressId()},journal);
});
