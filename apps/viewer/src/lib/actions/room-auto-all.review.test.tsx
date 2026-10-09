/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { IfcParser, EntityExtractor, EMPTY_SOURCE_BYTES } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { useViewerStore } from '@/store';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { seedReviewedRoom, roomProposal, roomEnvelope } from '@/test/reviewed-room-fixture';
import { MODEL, settle, nativeSdkMeshes, seedNativeSdkModel } from '@/test/native-sdk-model';
import { cleanup, click, render, waitFor } from '@/test/render';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { clearModelLayouts } from '@/lib/rooms/room-layout';
import { storeySpaces, storeyWalls, storeyRooms, clearStoreyRoomsCache } from '@/lib/rooms/storey-rooms';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { RoomCommandReview } from '@/components/viewer/assistant/RoomCommandReview';
import { prepareRoomReview } from './room-review';
import { roomChainInStore } from '../../../../../packages/create/src/in-store/room-store.js';
import { useAssistant, replaceEvidence, cancelAssistant } from '@/lib/assistant/conversation';
import { captureEvidence } from '@/lib/assistant/evidence';
import { sendAssistant } from '@/lib/assistant/request';
import { captureSelectionGrounding } from './selection-grounding';
import { updateApiKeys } from '@/services/api-keys';
import { attachmentsForSend } from '@/components/viewer/assistant/ComposerAttachments';
import { ModelChangeProposal } from '@/components/viewer/assistant/ModelChangeProposal';
import { nativeRoomRemeshGate } from '@/test/room-remesh-gate';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { ensureSpaceWasm } from '@/lib/rooms/space-wasm';
import { fixtureModel } from '@/test/store-fixture';
const initial = useViewerStore.getState();
const initialAssistant=useAssistant.getState(), originalFetch=globalThis.fetch, initialKeys=localStorage.getItem('ifc-lite:api-keys:v1');
afterEach(() => { cancelAssistant();cleanup(); setRemeshClientFactory(null); clearStoreyRoomsCache(); clearModelLayouts(MODEL); useViewerStore.setState(initial,true);useAssistant.setState(initialAssistant,true);globalThis.fetch=originalFetch;
  if(initialKeys===null)localStorage.removeItem('ifc-lite:api-keys:v1');else localStorage.setItem('ifc-lite:api-keys:v1',initialKeys); });

async function population(mm=false, walls=true) {
  const source=readFileSync(new URL('../../../public/samples/hello-wall.ifc',import.meta.url));
  const bytes=mm?new TextEncoder().encode(source.toString().replace('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)','IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)')):source;
  const native=await seedReviewedRoom(undefined,bytes);
  const editor=modelEditTarget(useViewerStore.getState(),MODEL)!.editor;
  const p=editor.addEntity('IfcCartesianPoint',[[0,0,mm?3000:3]]).expressId;
  const a=editor.addEntity('IfcAxis2Placement3D',[`#${p}`,null,null]).expressId;
  const placement=editor.addEntity('IfcLocalPlacement',[null,`#${a}`]).expressId;
  const upper=editor.addEntity('IfcBuildingStorey',[generateIfcGuid(),null,'Reviewed upper',null,null,`#${placement}`,null,null,'.ELEMENT.',mm?3000:3]).expressId;
  editor.setPositionalAttribute(60,5,['#42',`#${upper}`]);
  if(walls){const points:[number,number,number][]=[[20,20,0],[24,20,0],[24,23,0],[20,23,0]];
    for(const [i,Start] of points.entries())native.adapter.addWall(MODEL,upper,{Start,End:points[(i+1)%4],Thickness:.2,Height:3});}
  await settle();return {...native,upper};
}
for(const mm of [false,true])it(`#7324 actual compiled reviewed AutoAll ${mm?'mm':'m'} covers both native storeys, exports owned spaces and one Undo`,async t=>{
  if(!ensureRoomWasm(t))return;
  const {store,view,upper}=await population(mm),before=structuredClone(view.getEffectiveChanges());
  const proposal=roomProposal({action:'autoAll',...(mm?{weld:50,height:3000}:{})},mm?{units:'mm'}:{});
  const review=await prepareRoomReview(proposal,new AbortController().signal);
  try{
    assert.deepEqual(review.snapshot.storeys?.map(row=>[row.expressId,row.status]),[[42,'ready'],[upper,'ready']]);
    assert.equal(review.prepared.result.created.length,2);assert.deepEqual(view.getEffectiveChanges(),before,'detached preview publishes no graph');
    const expected=review.prepared.result.created.map(ref=>roomChainInStore(store,review.prepared.preview.editor,ref.expressId));
    assert.ok(expected.every(row=>row.ok));
    const ui=render(<RoomCommandReview proposal={proposal} origin="auto-all-native"/>);
    const button=(label:string)=>{const found=[...ui.querySelectorAll('button')].find(row=>row.textContent===label);assert.ok(found,ui.textContent??'');return found;};
    click(button('Prepare room preview'));
    await waitFor(()=>!!ui.querySelector('input[type="checkbox"]'),'complete native multi-storey preview');
    assert.ok(ui.textContent?.includes('Reviewed upper'));
    assert.equal(ui.querySelector('svg'),null,'distinct storey frames are not superimposed into one outline ghost');
    assert.deepEqual(view.getEffectiveChanges(),before);
    click(ui.querySelector('input[type="checkbox"]')!);assert.equal(button('Apply Room action').disabled,true);
    click(ui.querySelector('input[type="checkbox"]')!);click(button('Apply Room action'));
    await waitFor(()=>!!ui.textContent?.includes('Applied through native Room: created 2'),'two-storey native receipt');
    const spaces=view.getNewEntities().filter(row=>row.type.toUpperCase()==='IFCSPACE');assert.equal(spaces.length,2);
    const bytes=new StepExporter(store,view).export({schema:'IFC4',applyMutations:true}).content;
    const parsed=await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer,{disableWorkerScan:true});
    const extractor=new EntityExtractor(parsed.source);
    const relations=[...parsed.entityIndex.byId].map(([expressId,loc])=>extractor.extractEntity({...loc,expressId,lineNumber:0})).filter(row=>row?.type==='IFCRELAGGREGATES');
    const owners=spaces.map(space=>relations.find(row=>Array.isArray(row?.attributes[5])&&row.attributes[5].includes(space.expressId))?.attributes[4]);
    assert.deepEqual(owners.sort(),[42,upper].sort(),'independent STEP reader verifies distinct native spatial owners');
    const parsedEditor=new StoreEditor(parsed,new MutablePropertyView(parsed.properties??null,MODEL));
    for(const space of spaces){const native=roomChainInStore(parsed,parsedEditor,space.expressId);assert.ok(native.ok);assert.equal(native.chain.thickness,3);assert.ok(native.chain.footprint.every(([x,y])=>x>19&&x<25&&y>19&&y<24),'actual independent exported coordinates retain SI metre dimensions');}
    await settle();for(const space of spaces)assert.ok(nativeSdkMeshes().some(mesh=>mesh.expressId===space.expressId&&mesh.indices.length>0));
    click(button('Undo this Room action'));await waitFor(()=>!!ui.textContent?.includes('The native Room action was undone.'),'single grouped Undo');
    assert.deepEqual(view.getEffectiveChanges(),before);
  }finally{review.dispose();}
});

it('#7324 native AutoAll retains noWalls coverage and refuses direct geometry/current-source edits after preparation',async t=>{
  if(!ensureRoomWasm(t))return;
  const {view,upper}=await population(false,false);
  const proposal=roomProposal({action:'autoAll'}),review=await prepareRoomReview(proposal,new AbortController().signal);
  try{
    assert.deepEqual(review.snapshot.storeys?.map(row=>[row.expressId,row.status]),[[42,'ready'],[upper,'noWalls']]);
    const before=structuredClone(view.getEffectiveChanges()),mesh=nativeSdkMeshes().find(row=>view.getNewEntity(row.expressId)?.type.toUpperCase()==='IFCWALL')!;
    const old=mesh.positions[0];mesh.positions[0]+=1;
    assert.throws(()=>review.commit(),/geometry.*changed/);mesh.positions[0]=old;
    assert.deepEqual(view.getEffectiveChanges(),before);
    view.setAttribute(42,'Description','history-free stale source',undefined,true);
    assert.throws(()=>review.commit(),/changed/);
  }finally{review.dispose();}
});

for(const provider of ['openai','anthropic'] as const)for(const attached of [false,true])it(`#7324 ${provider} real request ${attached?'explicit Attach':'rich selection'} carries current native AutoAll population and its answer requires approval`,async t=>{
  if(!ensureRoomWasm(t))return;
  const {view,upper}=await population();
  const wall=view.getNewEntities().find(row=>row.type.toUpperCase()==='IFCWALL')!;
  act(()=>useViewerStore.setState({selectedEntityId:wall.expressId,selectedEntityIds:new Set([wall.expressId]),selectedEntity:{modelId:MODEL,expressId:wall.expressId}}));
  const before=structuredClone(view.getEffectiveChanges()),selection=captureSelectionGrounding(useViewerStore.getState());
  assert.deepEqual(selection.elements[0].nativeRoomAutoAll?.storeys.map(row=>row.expressId),[42,upper]);
  replaceEvidence(captureEvidence(attached?'loadReport':'selection'));
  updateApiKeys({openaiKey:'controlled-native-test',anthropicKey:'controlled-native-test'});
  const answer=JSON.stringify(roomEnvelope({action:'autoAll'}));let wire='',url='',calls=0;
  globalThis.fetch=async(input,init)=>{calls++;url=String(input);wire=String(init?.body);
    const stream=provider==='openai'?`data: ${JSON.stringify({choices:[{delta:{content:answer},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`
      :`event: message_start\ndata: ${JSON.stringify({type:'message_start',message:{id:'native-test',type:'message',role:'assistant',model:'claude-sonnet-5-5',content:[],stop_reason:null,usage:{input_tokens:100,output_tokens:0}}})}\n\nevent: content_block_start\ndata: ${JSON.stringify({type:'content_block_start',index:0,content_block:{type:'text',text:''}})}\n\nevent: content_block_delta\ndata: ${JSON.stringify({type:'content_block_delta',index:0,delta:{type:'text_delta',text:answer}})}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: ${JSON.stringify({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:100}})}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
    return new Response(stream,{headers:{'Content-Type':'text/event-stream'}});};
  assert.equal(await sendAssistant('Prepare all current storeys in this explicit model for Room review',provider==='openai'?'gpt-6-astra':'claude-sonnet-5-5','/api/chat',attached?attachmentsForSend({selection,screenshot:null}):undefined),true,useAssistant.getState().error??'');
  assert.equal(calls,1);assert.ok(url.includes(provider));assert.ok(wire.includes('nativeRoomAutoAll'));assert.ok(wire.includes('Reviewed upper'));
  assert.deepEqual(view.getEffectiveChanges(),before,'controlled provider transport never executes native edits');
  const ui=render(<ModelChangeProposal/>);
  assert.ok(ui.querySelector('section[aria-label="Review rooms"]'));
  const button=[...ui.querySelectorAll('button')].find(row=>row.textContent==='Prepare room preview');assert.ok(button);click(button);
  await waitFor(()=>!!ui.querySelector('input[type="checkbox"]'),'provider answer prepares actual compiled AutoAll');
  assert.ok(ui.textContent?.includes('Reviewed upper'));assert.deepEqual(view.getEffectiveChanges(),before);
});

it('#7324 actual AutoAll occupied coverage follows direct native room removal without a viewer mutation counter change',async t=>{
  if(!ensureRoomWasm(t))return;
  const {view}=await population();
  const proposal=roomProposal({action:'autoAll'}),first=await prepareRoomReview(proposal,new AbortController().signal);
  const created=first.commit().created;first.dispose();await settle();
  const occupied=await prepareRoomReview(proposal,new AbortController().signal);
  assert.deepEqual(occupied.snapshot.storeys?.map(row=>row.status),['occupied','occupied']);occupied.dispose();
  const version=useViewerStore.getState().mutationVersion,editor=modelEditTarget(useViewerStore.getState(),MODEL)!.editor;
  for(const ref of created)assert.equal(editor.removeEntity(ref.expressId),true);
  assert.equal(useViewerStore.getState().mutationVersion,version,'public native editor changes are independent of the UI counter');
  assert.ok(created.every(ref=>!view.getNewEntity(ref.expressId)));
  assert.ok(storeySpaces(useViewerStore.getState(),MODEL,42).every(row=>!created.some(ref=>ref.expressId===row.expressId)),'the exact native footprint cache no longer includes removed identities');
  const current=await prepareRoomReview(proposal,new AbortController().signal);
  try{assert.deepEqual(current.snapshot.storeys?.map(row=>row.status),['ready','ready'],'removed spaces cannot remain cached occupied blockers');assert.equal(current.prepared.result.created.length,2);}finally{current.dispose();}
});

for(const change of ['abort','source','model frame'] as const)it(`#7324 AutoAll refuses ${change} across actual native remesh await`,async t=>{
  if(!ensureRoomWasm(t))return;
  const {view}=await population(),proposal=roomProposal({action:'autoAll'}),controller=new AbortController(),gate=nativeRoomRemeshGate();
  const pending=prepareRoomReview(proposal,controller.signal);await gate.entered;
  if(change==='abort')controller.abort();
  else if(change==='source')view.setAttribute(42,'Description','direct edit during native await',undefined,true);
  else useViewerStore.getState().setModelRotation([MODEL],{angle:Math.PI/2,pivot:[0,0,0]});
  const before=structuredClone(view.getEffectiveChanges());gate.release();
  await assert.rejects(pending,/abort|changed|stale|source/i);await gate.completed;
  assert.deepEqual(view.getEffectiveChanges(),before,'cancel/refusal retains native IFC graph');
});

it('#7324 AutoAll is one explicitly owned model even with colliding IFC identities in a real peer source',async t=>{
  if(!ensureRoomWasm(t))return;
  const {store,view}=await population();
  const peerStore=await new IfcParser().parseColumnar(store.source.slice(0,store.source.byteLength).buffer as ArrayBuffer,{disableWorkerScan:true});
  const state=useViewerStore.getState();useViewerStore.setState({models:new Map(state.models).set('peer',{...fixtureModel('peer',{idOffset:1000000}),ifcDataStore:peerStore})});
  const proposal=roomProposal({action:'autoAll'}),beforePeer=peerStore.source.slice(0,peerStore.source.byteLength),before=structuredClone(view.getEffectiveChanges());
  const review=await prepareRoomReview(proposal,new AbortController().signal);
  try{assert.equal(review.snapshot.modelId,MODEL);assert.equal(review.snapshot.storeys?.length,2);assert.ok(review.prepared.result.created.every(ref=>ref.modelId===MODEL));
    assert.equal(review.commit().created.length,2);assert.equal(useViewerStore.getState().mutationViews.has('peer'),false);assert.deepEqual(peerStore.source.slice(0,peerStore.source.byteLength),beforePeer);
    useViewerStore.getState().undo(MODEL);assert.deepEqual(view.getEffectiveChanges(),before);
  }finally{review.dispose();}
});

it('#7324 missing native geometry retains every unavailable storey and disables actual mounted approval',async t=>{
  if(!ensureRoomWasm(t))return;
  const {view,upper}=await population(),proposal=roomProposal({action:'autoAll'});
  const state=useViewerStore.getState(),model=state.models.get(MODEL)!;
  act(()=>useViewerStore.setState({models:new Map(state.models).set(MODEL,{...model,geometryResult:null}),geometryResult:null}));
  const before=structuredClone(view.getEffectiveChanges()),review=await prepareRoomReview(proposal,new AbortController().signal);
  try{assert.deepEqual(review.snapshot.storeys?.map(row=>[row.expressId,row.status]),[[42,'unavailable'],[upper,'unavailable']]);
    assert.equal(review.prepared.result.created.length,0);assert.throws(()=>review.commit(),/unavailable/);
    const ui=render(<RoomCommandReview proposal={proposal} origin="unavailable-auto-all"/>);
    const button=(label:string)=>{const result=[...ui.querySelectorAll('button')].find(row=>row.textContent===label);assert.ok(result);return result;};
    click(button('Prepare room preview'));await waitFor(()=>!!ui.querySelector('input[type="checkbox"]'),'unknown native coverage');
    assert.equal(button('Apply Room action').disabled,true);assert.deepEqual(view.getEffectiveChanges(),before);
  }finally{review.dispose();}
});

it('#7324 fully occupied AutoAll discloses no native IFC or session write and records no Undo',async t=>{
  if(!ensureRoomWasm(t))return;
  const {view}=await population(),proposal=roomProposal({action:'autoAll'}),first=await prepareRoomReview(proposal,new AbortController().signal);
  first.commit();first.dispose();await settle();
  const before=structuredClone(view.getEffectiveChanges()),head=useViewerStore.getState().undoStacks.get(MODEL)?.length;
  const ui=render(<RoomCommandReview proposal={proposal} origin="occupied-auto-all"/>);
  const button=(label:string)=>{const result=[...ui.querySelectorAll('button')].find(row=>row.textContent===label);assert.ok(result);return result;};
  click(button('Prepare room preview'));await waitFor(()=>!!ui.querySelector('input[type="checkbox"]'),'fully occupied native coverage');
  assert.ok(ui.textContent?.includes('No IFC rooms or session layout changes are planned'),'actual no-work approval must not promise layout or Undo writes');
  click(button('Apply Room action'));await waitFor(()=>!!ui.textContent?.includes('Applied through native Room: created 0'),'known native no-work result');
  assert.equal(useViewerStore.getState().undoStacks.get(MODEL)?.length,head);assert.deepEqual(view.getEffectiveChanges(),before);
});

// A valid native source-free facade is not invented source data or a guessed unit.
it('#7324 source-free missing-unit native population is unavailable and preparation cannot write',async t=>{
  if(!ensureRoomWasm(t))return;
  const {store,view}=await population(),proposal=roomProposal({action:'autoAll'}),state=useViewerStore.getState(),model=state.models.get(MODEL)!;
  const opaque={...store,source:EMPTY_SOURCE_BYTES,lengthUnitScale:undefined};
  const wall=view.getNewEntities().find(row=>row.type.toUpperCase()==='IFCWALL')!;
  useViewerStore.setState({models:new Map(state.models).set(MODEL,{...model,ifcDataStore:opaque}),selectedEntityId:wall.expressId,selectedEntityIds:new Set([wall.expressId]),selectedEntity:{modelId:MODEL,expressId:wall.expressId}});
  const before=structuredClone(view.getEffectiveChanges()),editors=useViewerStore.getState().storeEditors;
  const selection=captureSelectionGrounding(useViewerStore.getState());
  assert.equal(selection.elements[0].nativeRoomAutoAll?.status,'unavailable');assert.deepEqual(selection.elements[0].nativeRoomAutoAll?.storeys,[]);
  assert.equal(useViewerStore.getState().storeEditors,editors,'native evidence does not initialize live writer maps');
  await assert.rejects(prepareRoomReview(proposal,new AbortController().signal),/unit|source|identity/i);assert.deepEqual(view.getEffectiveChanges(),before);
});

it('#7324 first native AutoAll preparation preserves absent live view/editor maps; explicit approval initializes one owned graph',async t=>{
  if(!ensureRoomWasm(t))return;
  const native=await population(),bytes=new StepExporter(native.store,native.view).export({schema:'IFC4',applyMutations:true}).content;
  const loaded=await seedNativeSdkModel(bytes),state=useViewerStore.getState(),model=state.models.get(MODEL)!;
  // Native fixtureModel omits parse-range metadata; a real loader supplies it.
  useViewerStore.setState({models:new Map(state.models).set(MODEL,{...model,maxExpressId:Math.max(...loaded.store.entityIndex.byId.keys())}),mutationViews:new Map(),storeEditors:new Map()});
  const before=useViewerStore.getState(),views=before.mutationViews,editors=before.storeEditors;
  const review=await prepareRoomReview(roomProposal({action:'autoAll'}),new AbortController().signal);
  try{
    assert.equal(review.prepared.result.created.length,2,'real saved-source walls are remeshed before native preparation');
    assert.equal(useViewerStore.getState().mutationViews,views,'first read cannot register a temporary native view');
    assert.equal(useViewerStore.getState().storeEditors,editors,'first read cannot register or watermark a live writer');
    assert.equal(useViewerStore.getState().undoStacks.get(MODEL)?.length??0,0);
    assert.equal(review.commit().created.length,2);
    const committed=useViewerStore.getState(),view=committed.mutationViews.get(MODEL);assert.ok(view);
    const records=committed.undoStacks.get(MODEL)??[];assert.ok(records.length>0);
    const batches=new Set(records.map(record=>committed.mutationBatchTags.get(record.id)));
    assert.equal(batches.size,1,'all actual IFC mutations belong to one native Undo step');assert.ok(!batches.has(undefined));
    useViewerStore.getState().undo(MODEL);assert.deepEqual(view.getEffectiveChanges(),[]);
  }finally{review.dispose();}
});


it('#7324 cached native room and wall populations refresh after direct removals without viewer history', async t => {
  if (!ensureRoomWasm(t)) return;
  const { view } = await population(false, false);
  await ensureSpaceWasm();
  const prepared = await prepareRoomReview(roomProposal({ action: 'autoAll' }), new AbortController().signal);
  const created = prepared.commit().created; prepared.dispose(); await settle();
  const state = useViewerStore.getState(), plane = buildStoreyWorkplane(state, MODEL, 42, 0);
  assert.ok(isWorkplane(plane));
  const occupied = storeyRooms(state, MODEL, 42, plane);
  assert.equal(occupied.status, 'ready');
  assert.ok(occupied.status === 'ready' && occupied.rooms.some(room => room.taken));
  const beforeWalls = storeyWalls(state, MODEL, 42, plane).length;
  const version = state.mutationVersion, editor = modelEditTarget(state, MODEL)!.editor;
  for (const ref of created) assert.equal(editor.removeEntity(ref.expressId), true);
  assert.equal(useViewerStore.getState().mutationVersion, version);
  const free = storeyRooms(useViewerStore.getState(), MODEL, 42, plane);
  assert.ok(free.status === 'ready' && free.rooms.some(room => !room.taken), 'the removed occupied space releases its cached native face');
  const authoredWalls = view.getNewEntities().filter(row => row.type.toUpperCase() === 'IFCWALL');
  assert.equal(authoredWalls.length, 4);
  for (const wall of authoredWalls) assert.equal(editor.removeEntity(wall.expressId), true);
  assert.equal(useViewerStore.getState().mutationVersion, version);
  assert.equal(storeyWalls(useViewerStore.getState(), MODEL, 42, plane).length, beforeWalls - 4, 'deleted native walls cannot survive the cache');
});
