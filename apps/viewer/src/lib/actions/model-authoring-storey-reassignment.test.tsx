/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { createElement, act } from 'react';
import { StoreEditor, MutablePropertyView } from '@ifc-lite/mutations';
import { federationRegistry } from '@ifc-lite/renderer';
import { toGlobalIdFromModels } from '@/store/globalId';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { EntityExtractor, effectiveMetadataRecord } from '@ifc-lite/parser';
import { planStoreyReassignment, reassignElementsToStoreyInStore } from '@ifc-lite/create';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { MODEL, seedNativeSdkModel, settle, nativeSdkUndoDepth } from '@/test/native-sdk-model';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest';
import { useViewerStore } from '@/store';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { parseIfc, danglingReferences } from '@/test/authoring-sample-fixture';
import { captureSelectionGrounding } from './selection-grounding';
import { cancelAssistant, replaceEvidence, useAssistant } from '@/lib/assistant/conversation';
import { sendAssistant } from '@/lib/assistant/request';
import { attachmentsForSend } from '@/components/viewer/assistant/ComposerAttachments';
import { preserveNativeExpectedProjection } from './native-authoring-evidence';
import { captureEvidence } from '@/lib/assistant/evidence';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { undoModelChanges } from './model-change-commit';
import { ModelAuthoringReview } from '@/components/viewer/actions/ModelAuthoringReview';
import { render, click, cleanup } from '@/test/render';
import { meshStairs, stairWasmAvailable } from '../../../../../packages/create/src/in-store/__test__/stair-mesh.oracle';

const initial = useViewerStore.getState(), initialAssistant = useAssistant.getState(), originalFetch = globalThis.fetch;
afterEach(() => { federationRegistry.clear(); cancelAssistant(); globalThis.fetch = originalFetch; useAssistant.setState(initialAssistant, true); cleanup(); setRemeshClientFactory(null); useViewerStore.setState(initial, true); });
const graph = async (bytes: Uint8Array) => {
  const parsed = await parseIfc(bytes), extractor = new EntityExtractor(parsed.source);
  return [...parsed.entityIndex.byId].map(([id, info]) => [id, info.type, extractor.extractEntity(info)?.attributes]);
};
const physical = (meshes: Awaited<ReturnType<typeof meshStairs>>, id: number) => {
  const body = meshes.get(id); assert.ok(body?.length, `native body #${id} must exist`);
  return body.map(mesh => ({ positions: [...mesh.positions], indices: [...mesh.indices] }));
};

async function setup(mm = false, imported = false) {
  const bytes = await readFile(new URL('../../../public/samples/hello-wall.ifc', import.meta.url));
  const source = mm ? new TextEncoder().encode(new TextDecoder().decode(bytes).replace('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)', 'IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)')) : bytes;
  const { store, adapter, view } = await seedNativeSdkModel(source);
  const models = new Map(useViewerStore.getState().models);
  models.set(MODEL, { ...models.get(MODEL)!, maxExpressId: getMaxExpressId(store, []) });
  useViewerStore.setState({ models });
  const editor = modelEditTarget(useViewerStore.getState(), MODEL)!.editor;
  const k = mm ? 1000 : 1;
  const frame = (xyz: number[], direction: number[]) => {
    const point = editor.addEntity('IfcCartesianPoint', [xyz]).expressId;
    const x = editor.addEntity('IfcDirection', [direction]).expressId;
    const axis = editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, `#${x}`]).expressId;
    return editor.addEntity('IfcLocalPlacement', [null, `#${axis}`]).expressId;
  };
  const sourcePlacement = frame([2*k,-3*k,4*k], [0,1,0]);
  editor.setPositionalAttribute(42, 5, `#${sourcePlacement}`);
  const destinationPlacement = frame([-7*k,6*k,12*k], [1,1,0]);
  const destinationGuid = generateIfcGuid();
  const destination = editor.addEntity('IfcBuildingStorey', [destinationGuid, null, 'Native destination', null, null, `#${destinationPlacement}`, null, '.ELEMENT.', 12*k]).expressId;
  editor.addEntity('IfcRelAggregates', [generateIfcGuid(), null, null, null, '#36', [`#${destination}`]]);
  const id = imported ? 1222 : adapter.addWall(MODEL, 42, { Start:[0,5,0], End:[8,5,0], Thickness:.2, Height:3, Name:'Native reassignment wall' }).expressId;
  await settle();
  useViewerStore.setState({ selectedEntityIds:new Set([id]), selectedEntityId:id });
  const bytesNow = () => editedModelBytes(store, view);
  const row = captureSelectionGrounding(useViewerStore.getState()).elements[0]; assert.ok(row?.nativeStoreyReassignments);
  const candidate = row.nativeStoreyReassignments.find(entry => entry.destinationStorey.globalId === destinationGuid); assert.ok(candidate);
  const operation = { op:'element.reassignStorey', target:{modelId:MODEL,globalId:row.globalId,ifcClass:row.type,name:row.name}, sourceStorey:candidate.sourceStorey, destinationStorey:candidate.destinationStorey, expected:JSON.parse(candidate.expectedJsonParts.join('')) as import('@ifc-lite/create').StoreyReassignmentPlan };
  const batch = () => parseModelAuthoringBatch(JSON.stringify({kind:'model.authoring',version:1,title:'Native world-preserving storey change',units:mm?'mm':'m',frame:'storey-local',operations:[operation]}));
  return { store, view, editor, id, destination, destinationPlacement, row, operation, batch, bytesNow };
}

for (const mm of [false,true]) for (const imported of [false,true]) test(`#7328 reviewed native reassignment identity/mesh/export/Undo mm=${mm} imported=${imported}`, {skip:!stairWasmAvailable&&'run pnpm build:wasm:fetch'}, async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup(mm, imported), before = await graph(s.bytesNow());
  const beforeBody = physical(await meshStairs(new TextDecoder().decode(s.bytesNow())), s.id);
  const attributes = effectiveMetadataRecord(s.store,s.id,s.view)!.attributes;
  const native = s.view.prepareAtomic(view => reassignElementsToStoreyInStore(s.store, new StoreEditor(s.store,view), [s.id],42,s.destination)).result;
  assert.deepEqual(native.products.map(p=>p.expressId), s.operation.expected.products.map(p=>p.expressId));
  const preview = previewModelAuthoring(useViewerStore.getState(),s.batch());
  assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??''); assert.equal(preview.rows[0].previewUnavailable,true);
  const depth = nativeSdkUndoDepth();
  const result = commitModelAuthoring(useViewerStore,preview,new Set([0]),'native reassignment'); assert.ok(result.ok,result.ok?'':result.detail??result.reason);
  // Journal rows share one logical batch; the receipt undoes all of them.
  assert.ok(nativeSdkUndoDepth()>depth);
  await settle();
  assert.deepEqual(effectiveMetadataRecord(s.store,s.id,s.view)!.attributes,attributes);
  const afterBody = physical(await meshStairs(new TextDecoder().decode(s.bytesNow())),s.id);
  assert.equal(afterBody.length,beforeBody.length);
  for(let m=0;m<afterBody.length;m++){assert.deepEqual(afterBody[m].indices,beforeBody[m].indices);for(let i=0;i<afterBody[m].positions.length;i++)assert.ok(Math.abs(afterBody[m].positions[i]-beforeBody[m].positions[i])<1e-5);}
  const parsed = await parseIfc(s.bytesNow()); assert.equal(parsed.entities.getExpressIdByGlobalId(String(attributes[0])),s.id);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(s.bytesNow())),[]);
  assert.deepEqual(undoModelChanges(useViewerStore,result.receipt),{ok:true}); await settle();
  assert.deepEqual(await graph(s.bytesNow()),before);
});

test('#7328 rich and attached evidence share complete native pins; review discloses dependencies and mounted Apply preserves identity', async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup();
  const captured = JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data;
  assert.deepEqual(captured.nativeStoreyReassignments,s.row.nativeStoreyReassignments);
  const before = await graph(s.bytesNow());
  const ui = render(createElement(ModelAuthoringReview,{batch:s.batch(),origin:'native-storey-review'}));
  assert.match(ui.textContent??'',/identities and world placement stay fixed/);
  const button = [...ui.querySelectorAll('button')].find(b=>b.textContent?.includes('Apply'));assert.ok(button);await act(async()=>click(button));
  assert.notDeepEqual(await graph(s.bytesNow()),before);
  assert.equal(effectiveMetadataRecord(s.store,s.id,s.view)?.attributes[0],s.row.globalId);
});

for (const failure of ['destination stale','source stale','wrong model','partial pin','source swapped','edit disabled'] as const) test(`#7328 reviewed ${failure} preserves graph and history`, async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup(), preview=previewModelAuthoring(useViewerStore.getState(),s.batch());assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');
  if(failure==='destination stale')s.editor.setPositionalAttribute(s.destinationPlacement,0,'#0');
  if(failure==='source stale')s.editor.setAttribute(s.id,'Name','Changed');
  if(failure==='edit disabled')useViewerStore.setState({editEnabled:false});
  if(failure==='source swapped'){const parsed=await parseIfc(s.bytesNow());const models=new Map(useViewerStore.getState().models);models.set(MODEL,{...models.get(MODEL)!,ifcDataStore:parsed});useViewerStore.setState({models});}
  const before=await graph(s.bytesNow()), depth=nativeSdkUndoDepth();
  if(failure==='wrong model'||failure==='partial pin'){
    const op=failure==='wrong model'?{...s.operation,destinationStorey:{...s.operation.destinationStorey,modelId:'other'}}:{...s.operation,expected:{...s.operation.expected,placements:[]}};
    assert.throws(()=>parseModelAuthoringBatch(JSON.stringify({...s.batch(),operations:[op]})));
  }else{const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'stale reassignment');assert.equal(result.ok,false);}
  assert.deepEqual(await graph(s.bytesNow()),before);assert.equal(nativeSdkUndoDepth(),depth);
});


for (const route of ['rich', 'attachment'] as const) test(`#7328 actual ${route} assistant wire drives native hosted reassignment through mounted review/Apply/Undo`, async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup(false, true), before = await graph(s.bytesNow());
  const snapshot = captureEvidence(route === 'rich' ? 'selection' : 'loadReport'); replaceEvidence(snapshot);
  const grounding = route === 'attachment' ? captureSelectionGrounding(useViewerStore.getState()) : null;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++; const wire = JSON.parse(String(init?.body));
    let rows: { globalId:string; modelId:string; type:string; name:string; nativeStoreyReassignments:typeof s.row.nativeStoreyReassignments }[];
    if(route === 'rich') {
      const system = typeof wire.system === 'string' ? wire.system : wire.system.map((b:{text:string})=>b.text).join('\n');
      const at = system.indexOf(snapshot.payload); assert.ok(at >= 0);
      rows = JSON.parse(system.slice(at,at+snapshot.payload.length)).evidence.rows.map((r:{data:typeof rows[number]})=>r.data);
    } else {
      const user = wire.messages.filter((m:{role:string})=>m.role==='user').at(-1);
      rows = JSON.parse(user.content.split('\n').at(-1));
    }
    const row = rows.find(row=>row.globalId===s.row.globalId); assert.ok(row?.nativeStoreyReassignments);
    const candidate = row.nativeStoreyReassignments.find(entry=>entry.destinationStorey.globalId===s.operation.destinationStorey.globalId); assert.ok(candidate);
    const expected = JSON.parse(candidate.expectedJsonParts.join('')); assert.deepEqual(expected,s.operation.expected);
    assert.ok(expected.products.length > 1, 'current real Bonsai opening dependencies survive both wire routes');
    const answer = JSON.stringify({kind:'model.authoring',version:1,title:'Native wire storey change',units:'mm',frame:'storey-local',operations:[{
      op:'element.reassignStorey',target:{modelId:row.modelId,globalId:row.globalId,ifcClass:row.type,name:row.name},sourceStorey:candidate.sourceStorey,destinationStorey:candidate.destinationStorey,expected,
    }]});
    return new Response(`data: ${JSON.stringify({choices:[{delta:{content:answer},finish_reason:'stop'}]})}\n\n`);
  };
  assert.equal(await sendAssistant('Prepare native same-identity storey reassignment','openai/gpt-free','/api/chat',grounding?attachmentsForSend({selection:grounding,screenshot:null}):{}),true,useAssistant.getState().error??'');
  assert.equal(calls,1); const answer=useAssistant.getState().messages.at(-1)?.content;assert.ok(answer);
  const batch=parseModelAuthoringBatch(answer), preview=previewModelAuthoring(useViewerStore.getState(),batch);assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');
  const ui=render(createElement(ModelAuthoringReview,{batch,origin:'#7328 actual wire'}));
  const button=(label:string)=>{const found=[...ui.querySelectorAll('button')].find(b=>b.textContent?.includes(label));assert.ok(found,label);return found;};
  await act(async()=>{click(button('Apply'));await settle();});
  assert.equal(effectiveMetadataRecord(s.store,s.id,s.view)?.attributes[0],s.row.globalId);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(s.bytesNow())),[]);
  await act(async()=>{click(button('Undo'));await settle();});
  assert.deepEqual(await graph(s.bytesNow()),before);
});

test('#7328 projected partial JSON parts cannot authorize reviewed reassignment', async t => {
  if(!ensureRoomWasm(t))return;
  const s=await setup(), original={data:{nativeStoreyReassignments:s.row.nativeStoreyReassignments,nativeAuthoringAvailability:{storeyReassignment:'available'}}};
  const projected=structuredClone(original);assert.ok(projected.data.nativeStoreyReassignments);
  projected.data.nativeStoreyReassignments[0].expectedJsonParts.pop();
  preserveNativeExpectedProjection(original,projected);
  assert.equal(projected.data.nativeStoreyReassignments,null);
  assert.equal(projected.data.nativeAuthoringAvailability.storeyReassignment,'unavailable-projection');
});


test('#7328 preserve an independently reparsed native envelope for unchanged-public-endpoint whole-owner probes', async t => {
  if(!ensureRoomWasm(t))return;
  const s=await setup(false,true), step=new TextDecoder().decode(s.bytesNow()), store=await parseIfc(new TextEncoder().encode(step));
  const view=new (await import('@ifc-lite/mutations')).MutablePropertyView(store.properties,MODEL);
  const expected=planStoreyReassignment(store,view,[s.id],42,s.destination);
  const envelope=JSON.stringify({...s.batch(),operations:[{...s.operation,expected}]});
  if(process.env.CAMPAIGN_STOREY_PUBLIC_ARTIFACT) await writeFile(process.env.CAMPAIGN_STOREY_PUBLIC_ARTIFACT,JSON.stringify({step,envelope,expressId:s.id,destinationId:s.destination},null,2));
  assert.equal(store.entities.getGlobalId(s.id),s.row.globalId);
});


test('#7328 two real federated models with duplicate source/destination GlobalIds keep the explicit owning model isolated', async t => {
  if(!ensureRoomWasm(t))return;
  const s=await setup(false,true), saved=await parseIfc(s.bytesNow()), peer=await parseIfc(s.bytesNow()), state=useViewerStore.getState(), model=state.models.get(MODEL)!;
  federationRegistry.clear();
  const ownOffset=state.registerModelOffset(MODEL,getMaxExpressId(saved,[])), peerOffset=state.registerModelOffset('peer',getMaxExpressId(peer,[]));
  const ownView=new MutablePropertyView(saved.properties,MODEL), peerView=new MutablePropertyView(peer.properties,'peer');
  const models=new Map([[MODEL,{...model,idOffset:ownOffset,ifcDataStore:saved,maxExpressId:getMaxExpressId(saved,[])}],['peer',{...model,id:'peer',idOffset:peerOffset,ifcDataStore:peer,maxExpressId:getMaxExpressId(peer,[])}]]);
  for(const [id,m] of models)if(m.geometryResult)m.geometryResult={...m.geometryResult,meshes:m.geometryResult.meshes.map(mesh=>({...mesh,expressId:toGlobalIdFromModels(models,id,mesh.expressId)}))};
  const rendererId=toGlobalIdFromModels(models,MODEL,s.id);
  useViewerStore.setState({models,mutationViews:new Map([[MODEL,ownView],['peer',peerView]]),storeEditors:new Map(),undoStacks:new Map(),redoStacks:new Map(),selectedEntityIds:new Set([rendererId]),selectedEntityId:rendererId});
  const captured=captureSelectionGrounding(useViewerStore.getState()).elements[0];assert.equal(captured.modelId,MODEL);assert.ok(captured.nativeStoreyReassignments);
  const candidate=captured.nativeStoreyReassignments.find(entry=>entry.destinationStorey.globalId===s.operation.destinationStorey.globalId);assert.ok(candidate);
  const batch=parseModelAuthoringBatch(JSON.stringify({...s.batch(),operations:[{...s.operation,sourceStorey:candidate.sourceStorey,destinationStorey:candidate.destinationStorey,expected:JSON.parse(candidate.expectedJsonParts.join(''))}]}));
  const before=await graph(editedModelBytes(saved,ownView)), peerBefore=await graph(editedModelBytes(peer,peerView));
  const preview=previewModelAuthoring(useViewerStore.getState(),batch);assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');
  const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'explicit owning model');assert.ok(result.ok,result.ok?'':result.detail??result.reason);await settle(MODEL);
  assert.deepEqual(await graph(editedModelBytes(peer,peerView)),peerBefore);assert.equal(peerView.hasPendingChanges(),false);
  assert.deepEqual(undoModelChanges(useViewerStore,result.receipt),{ok:true});await settle(MODEL);
  assert.deepEqual(await graph(editedModelBytes(saved,ownView)),before);assert.deepEqual(await graph(editedModelBytes(peer,peerView)),peerBefore);
});
