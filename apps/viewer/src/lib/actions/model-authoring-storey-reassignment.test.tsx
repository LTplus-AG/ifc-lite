/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { createElement, act } from 'react';
import { AnchorEntityReader } from '../../../../../packages/create/src/in-store/resolve-anchor';
import * as nativeCreate from '@ifc-lite/create';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { federationRegistry } from '@ifc-lite/renderer';
import { toGlobalIdFromModels } from '@/store/globalId';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { EntityExtractor, effectiveMetadataRecord } from '@ifc-lite/parser';
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
import { ModelChangeProposal } from '@/components/viewer/assistant/ModelChangeProposal';
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
  return { store, view, editor, adapter, id, destination, destinationPlacement, row, operation, batch, bytesNow };
}

for (const mm of [false,true]) for (const imported of [false,true]) test(`#7328 reviewed native reassignment identity/mesh/export/Undo mm=${mm} imported=${imported}`, {skip:!stairWasmAvailable&&'run pnpm build:wasm:fetch'}, async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup(mm, imported), before = await graph(s.bytesNow());
  const beforeBody = physical(await meshStairs(new TextDecoder().decode(s.bytesNow())), s.id);
  const attributes = effectiveMetadataRecord(s.store,s.id,s.view)!.attributes;
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
  const restored=await seedNativeSdkModel(new TextEncoder().encode(step));
  const models=new Map(useViewerStore.getState().models);
  models.set(MODEL,{...models.get(MODEL)!,maxExpressId:getMaxExpressId(restored.store,[])});
  useViewerStore.setState({models,selectedEntityIds:new Set([s.id]),selectedEntityId:s.id});
  const row=captureSelectionGrounding(useViewerStore.getState()).elements[0];
  const candidate=row?.nativeStoreyReassignments?.find(entry=>entry.destinationStorey.globalId===s.operation.destinationStorey.globalId);
  assert.ok(candidate,'reparsed native source exposes a complete pin through the existing public selection route');
  const expected=JSON.parse(candidate.expectedJsonParts.join('')) as import('@ifc-lite/create').StoreyReassignmentPlan;
  const envelope=JSON.stringify({...s.batch(),operations:[{...s.operation,expected}]});
  if(process.env.CAMPAIGN_STOREY_CAPTURE_ARTIFACT) await writeFile(process.env.CAMPAIGN_STOREY_CAPTURE_ARTIFACT,JSON.stringify({step,envelope,expressId:s.id,destinationId:s.destination},null,2));
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

test('#7328 a complete source membership exceeding 5000 entries still admits one moved product', async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup();
  const siblings: string[] = [`#${s.id}`];
  for (let i = 0; i < 5000; i++) siblings.push(`#${s.editor.addEntity('IfcAnnotation', [generateIfcGuid(), null, `Unmoved ${i}`, null, null, null, null]).expressId}`);
  const reader = new AnchorEntityReader(s.store, s.view);
  const membership = [...reader.ids('IFCRELCONTAINEDINSPATIALSTRUCTURE')].find(id => (reader.entity(id)?.attributes[4] as unknown[])?.includes(`#${s.id}`));
  assert.ok(membership); s.editor.setPositionalAttribute(membership, 4, siblings);
  assert.equal(typeof nativeCreate.planStoreyReassignmentCandidates, 'function');
  const candidate = nativeCreate.planStoreyReassignmentCandidates(s.store, s.view, [s.id],
    s.operation.expected.sourceStoreyId, [s.operation.expected.destinationStoreyId])[0];
  assert.ok(candidate?.plan, 'the public native planner retains complete large membership capability');
  const pin = candidate.plan;
  assert.equal(pin.products.length, 1); assert.equal(pin.sourceMemberships[0].children.length, 5001);
  const batch = parseModelAuthoringBatch(JSON.stringify({kind: 'model.authoring', version: 1, title: 'Complete large membership', units: 'm', frame: 'storey-local', operations: [{...s.operation, expected: pin}]}));
  const preview = previewModelAuthoring(useViewerStore.getState(), batch);
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? '');
  const before = await graph(s.bytesNow());
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), '#7328 complete large source membership');
  assert.ok(result.ok, result.ok ? '' : result.detail ?? result.reason); await settle();
  assert.deepEqual(undoModelChanges(useViewerStore, result.receipt), {ok: true}); await settle();
  assert.deepEqual(await graph(s.bytesNow()), before);
  await t.test('an offered parser-valid complete pin fits the public explicit attachment route', async () => {
    const grounding = captureSelectionGrounding(useViewerStore.getState());
    assert.equal(grounding.elements[0]?.nativeAuthoringAvailability.storeyReassignment, 'available');
    const originalGrounding = JSON.stringify(grounding);
    assert.equal(grounding.elements[0]?.globalId, s.operation.target.globalId);
    replaceEvidence(captureEvidence('selection'));
    let requested = false;
    globalThis.fetch = async (_url, init) => {
      const wire = JSON.parse(String(init?.body));
      const user = wire.messages.filter((message: { role: string }) => message.role === 'user').at(-1);
      const sent: typeof grounding.elements = JSON.parse(user.content.split('\n').at(-1));
      assert.equal(sent[0]?.globalId, grounding.elements[0].globalId);
      assert.equal(sent[0]?.nativeAuthoringAvailability.storeyReassignment, 'unavailable-transport-budget');
      assert.equal(sent[0]?.nativeStoreyReassignments, null);
      requested = true;
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'The complete current selection was received.' }, finish_reason: 'stop' }] })}\n\n`);
    };
    assert.equal(await sendAssistant('Prepare the offered complete storey reassignment', 'openai/gpt-free', '/api/chat',
      attachmentsForSend({ selection: grounding, screenshot: null })), true, useAssistant.getState().error ?? '');
    assert.equal(requested, true, 'ordinary evidence reaches the provider with an explicit whole-pin refusal');
    assert.equal(JSON.stringify(grounding), originalGrounding, 'wire projection never mutates the owned capture');
  });
});

// #7328 / review r4235221306: every offered complete native pin must be admissible.
test('#7328 complete large retained membership is never advertised with an unreviewable pin', async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup();
  assert.doesNotThrow(s.batch, 'ordinary native candidate remains a public admission control');
  const relation = s.operation.expected.sourceMemberships[0];
  assert.ok(relation);
  const retained: number[] = [];
  for (let i = 0; i < 100_000; i++) retained.push(s.editor.addEntity('IfcAnnotation',
    [generateIfcGuid(), null, `Retained member ${i}`, null, null, null, null]).expressId);
  const members = [...relation.children, ...retained];
  assert.equal(new Set(members).size, members.length, 'native SET members are distinct');
  s.editor.setPositionalAttribute(relation.id, relation.listIndex, members.map(id => `#${id}`));
  const bytes = s.bytesNow();
  const parsed = await parseIfc(bytes);
  const nativeRelation = effectiveMetadataRecord(parsed, relation.id); assert.ok(nativeRelation);
  assert.deepEqual(nativeRelation.attributes[relation.listIndex], members, 'independent export/reparse retains the complete native membership');
  const guids = retained.map(id => {
    assert.equal(parsed.entities.getTypeName(id), 'IfcAnnotation');
    const guid = parsed.entities.getGlobalId(id); assert.ok(guid); return guid;
  });
  assert.equal(new Set(guids).size, retained.length, 'every retained native Root has a unique real GlobalId');
  const restored = await seedNativeSdkModel(bytes);
  const models = new Map(useViewerStore.getState().models);
  models.set(MODEL, { ...models.get(MODEL)!, maxExpressId: getMaxExpressId(restored.store, []) });
  useViewerStore.setState({ models, selectedEntityIds: new Set([s.id]), selectedEntityId: s.id });
  const state = useViewerStore.getState(), view = state.mutationViews.get(MODEL); assert.ok(view);
  const revision = view.getMutationRevision(), changes = structuredClone(view.getEffectiveChanges());
  const undo = state.undoStacks, redo = state.redoStacks;
  const grounding = captureSelectionGrounding(state), row = grounding.elements[0]; assert.ok(row);
  const candidate = row.nativeStoreyReassignments?.find(entry => entry.destinationStorey.globalId === s.operation.destinationStorey.globalId);
  const countValues = (root: unknown): number => {
    const pending = [root]; let count = 0;
    while (pending.length) {
      const value = pending.pop(); count++;
      if (Array.isArray(value)) for (const child of value) pending.push(child);
      else if (value !== null && typeof value === 'object') for (const child of Object.values(value)) pending.push(child);
    }
    return count;
  };
  // Measure actual reparsed membership duplicated in the native pin's two fields.
  assert.ok(countValues({ attributes: nativeRelation.attributes, children: members }) > 200_000);
  t.diagnostic(`native reassignment availability: ${JSON.stringify(row.nativeAuthoringAvailability)}; candidate present: ${Boolean(candidate)}`);
  if (!candidate) {
    assert.notEqual(row.nativeAuthoringAvailability.storeyReassignment, 'available', 'refused complete admission is disclosed');
  } else {
    assert.equal(row.nativeAuthoringAvailability.storeyReassignment, 'available');
    const expected: unknown = JSON.parse(candidate.expectedJsonParts.join(''));
    assert.ok(countValues(expected) > 200_000, 'actual offered pin exceeds the existing admission value limit');
    await t.test('an advertised actual complete pin reaches the existing public parser admission invariant', () => {
      assert.doesNotThrow(() => parseModelAuthoringBatch(JSON.stringify({ kind: 'model.authoring', version: 1,
        title: 'Complete native pin parser admission', units: 'm', frame: 'storey-local',
        operations: [{ ...s.operation, sourceStorey: candidate.sourceStorey, destinationStorey: candidate.destinationStorey, expected }] })),
        'every advertised complete pin must be accepted by the existing public batch parser');
    });
    replaceEvidence(captureEvidence('selection'));
    const title = 'Complete retained-members public admission';
    globalThis.fetch = async (_url, init) => {
      const wire = JSON.parse(String(init?.body));
      const user = wire.messages.filter((message: { role: string }) => message.role === 'user').at(-1);
      const rows: typeof grounding.elements = JSON.parse(user.content.split('\n').at(-1));
      const sentRow = rows.find(entry => entry.globalId === row.globalId); assert.ok(sentRow);
      assert.equal(sentRow.nativeAuthoringAvailability.storeyReassignment, 'available');
      const sentCandidate = sentRow.nativeStoreyReassignments?.find(entry => entry.destinationStorey.globalId === candidate.destinationStorey.globalId);
      assert.ok(sentCandidate, 'the actual provider attachment includes the advertised complete candidate');
      assert.deepEqual(sentCandidate.expectedJsonParts, candidate.expectedJsonParts);
      const sentExpected: unknown = JSON.parse(sentCandidate.expectedJsonParts.join(''));
      assert.deepEqual(sentExpected, expected);
      assert.ok(countValues(sentExpected) > 200_000, 'the actual wire pin exceeds the existing admission value limit');
      const answer = JSON.stringify({ kind: 'model.authoring', version: 1, title, units: 'm', frame: 'storey-local',
        operations: [{ ...s.operation, sourceStorey: sentCandidate.sourceStorey, destinationStorey: sentCandidate.destinationStorey, expected: sentExpected }] });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] })}\n\n`);
    };
    assert.equal(await sendAssistant('Prepare the offered native same-identity reassignment', 'openai/gpt-free', '/api/chat',
      attachmentsForSend({ selection: grounding, screenshot: null })), true, useAssistant.getState().error ?? '');
    const ui = render(createElement(ModelChangeProposal));
    assert.ok(ui.textContent?.includes(title), 'an available complete native candidate must reach the existing public review card');
  }
  assert.equal(view.getMutationRevision(), revision);
  assert.deepEqual(view.getEffectiveChanges(), changes);
  assert.equal(useViewerStore.getState().undoStacks, undo);
  assert.equal(useViewerStore.getState().redoStacks, redo);
});

for (const selected of [1, 2]) test(`#7328 real escaped complete pins reserve ordinary transport facts for ${selected} selected products`, async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup();
  const ids = [s.id];
  if (selected === 2) ids.push(s.adapter.addWall(MODEL, 42, {
    Start: [0, 8, 0], End: [8, 8, 0], Thickness: .2, Height: 3, Name: 'Second native selected wall',
  }).expressId);
  assert.equal(typeof nativeCreate.planStoreyReassignmentCandidates, 'function');
  const memberships = ids.map(id => {
    const current = nativeCreate.planStoreyReassignmentCandidates(s.store, s.view, [id],
      s.operation.expected.sourceStoreyId, [s.operation.expected.destinationStoreyId])[0];
    assert.ok(current?.plan, 'each canonical wall initially has one supported real source placement and containment');
    assert.equal(current.plan.products[0].expressId, id);
    return current.plan.sourceMemberships[0];
  });
  const escapedName = '"\\'.repeat(100);
  const uniqueMemberships = [...new Map(memberships.map(relation => [relation.id, relation])).values()];
  const expectedMembers = new Map<number, number[]>();
  for (const relation of uniqueMemberships) {
    const retained = [];
    for (let i = 0; i < (selected === 1 ? 800 : 1200); i++) retained.push(s.editor.addEntity('IfcAnnotation',
      [generateIfcGuid(), null, `Native retained ${relation.id}-${i}`, null, null, null, null]).expressId);
    const members = [...relation.children, ...retained];
    expectedMembers.set(relation.id, members);
    s.editor.setPositionalAttribute(relation.id, relation.listIndex, members.map(id => `#${id}`));
    s.editor.setPositionalAttribute(relation.id, 2, escapedName);
  }
  await settle();
  const parsed = await parseIfc(s.bytesNow());
  for (const relation of uniqueMemberships) {
    const exported = effectiveMetadataRecord(parsed, relation.id); assert.ok(exported);
    assert.deepEqual(exported.attributes[relation.listIndex], expectedMembers.get(relation.id));
    assert.equal(exported.attributes[2], escapedName, 'native export/reparse preserves actual escaped relationship metadata');
  }
  const reader = new AnchorEntityReader(parsed, null);
  for (const id of ids) {
    assert.equal(parsed.entities.getTypeName(id), 'IfcWall');
    const incoming = [...reader.ids('IFCRELCONTAINEDINSPATIALSTRUCTURE')].filter(relationId => {
      const attributes = effectiveMetadataRecord(parsed, relationId)?.attributes;
      return Array.isArray(attributes?.[4]) && attributes[4].includes(id);
    });
    assert.equal(incoming.length, 1, 'native export independently proves unambiguous canonical containment');
  }
  useViewerStore.setState({ selectedEntityIds: new Set(ids), selectedEntityId: ids[0] });
  const grounding = captureSelectionGrounding(useViewerStore.getState());
  assert.equal(grounding.elements.length, selected);
  const pins = grounding.elements.map(row => {
    assert.equal(row.nativeAuthoringAvailability.storeyReassignment, 'available');
    assert.ok(row.nativeStoreyReassignments); return row.nativeStoreyReassignments;
  });
  for (const pin of pins) assert.ok(JSON.stringify(JSON.stringify(pin)).length > 12_000,
    'the actual fitting positive must reject the previously proposed arbitrary 12k allowance');
  const original = JSON.stringify(grounding), revision = s.view.getMutationRevision();
  const changes = structuredClone(s.view.getEffectiveChanges());
  const undo = useViewerStore.getState().undoStacks, redo = useViewerStore.getState().redoStacks;
  replaceEvidence(captureEvidence('selection'));
  let requested = false;
  globalThis.fetch = async (_url, init) => {
    const wire = JSON.parse(String(init?.body));
    const user = wire.messages.filter((message: { role: string }) => message.role === 'user').at(-1);
    const sent: typeof grounding.elements = JSON.parse(user.content.split('\n').at(-1));
    assert.deepEqual(sent.map(row => [row.modelId, row.globalId, row.type, row.name]),
      grounding.elements.map(row => [row.modelId, row.globalId, row.type, row.name]), 'every ordinary selected identity survives');
    const available = sent.filter(row => row.nativeAuthoringAvailability.storeyReassignment === 'available');
    if (selected === 1) assert.equal(available.length, 1, 'a genuinely fitting complete pin larger than 12k remains offered');
    if (selected === 2) assert.ok(available.length < selected, 'the actual aggregate envelope refuses at least one whole optional pin');
    for (const row of sent) {
      const source = grounding.elements.find(item => item.modelId === row.modelId && item.globalId === row.globalId); assert.ok(source);
      if (row.nativeAuthoringAvailability.storeyReassignment === 'available') assert.deepEqual(row.nativeStoreyReassignments, source.nativeStoreyReassignments);
      else { assert.equal(row.nativeAuthoringAvailability.storeyReassignment, 'unavailable-transport-budget'); assert.equal(row.nativeStoreyReassignments, null); }
    }
    requested = true;
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Native selection evidence received.' }, finish_reason: 'stop' }] })}\n\n`);
  };
  assert.equal(await sendAssistant('Prepare the complete native Storey candidate', 'openai/gpt-free', '/api/chat',
    attachmentsForSend({ selection: grounding, screenshot: null })), true, useAssistant.getState().error ?? '');
  assert.equal(requested, true);
  assert.equal(JSON.stringify(grounding), original);
  assert.equal(s.view.getMutationRevision(), revision); assert.deepEqual(s.view.getEffectiveChanges(), changes);
  assert.equal(useViewerStore.getState().undoStacks, undo); assert.equal(useViewerStore.getState().redoStacks, redo);
});

test('#7328 ordinary native Structural and Cost pins remain available when the actual request fits', async t => {
  if (!ensureRoomWasm(t)) return;
  await setup();
  const grounding = captureSelectionGrounding(useViewerStore.getState());
  assert.equal(grounding.elements[0].nativeStructural.status, 'available');
  assert.equal(grounding.elements[0].nativeCost.status, 'available');
  replaceEvidence(captureEvidence('selection'));
  globalThis.fetch = async (_url, init) => {
    const wire = JSON.parse(String(init?.body));
    const user = wire.messages.filter((message: { role: string }) => message.role === 'user').at(-1);
    const sent: typeof grounding.elements = JSON.parse(user.content.split('\n').at(-1));
    assert.equal(sent[0].nativeStructural.status, 'available');
    assert.deepEqual(sent[0].nativeStructural, JSON.parse(JSON.stringify(grounding.elements[0].nativeStructural)));
    assert.equal(sent[0].nativeCost.status, 'available');
    assert.deepEqual(sent[0].nativeCost, JSON.parse(JSON.stringify(grounding.elements[0].nativeCost)));
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Complete native graphs received.' }, finish_reason: 'stop' }] })}\n\n`);
  };
  assert.equal(await sendAssistant('Explain the supplied native graphs', 'openai/gpt-free', '/api/chat',
    attachmentsForSend({ selection: grounding, screenshot: null })), true, useAssistant.getState().error ?? '');
});

test('#7328 transported pins retain model ownership across two native models with colliding local IDs and GUIDs', async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup(false, true), own = await parseIfc(s.bytesNow()), peer = await parseIfc(s.bytesNow());
  assert.notEqual(own, peer);
  assert.equal(own.entities.getGlobalId(s.id), peer.entities.getGlobalId(s.id));
  const state = useViewerStore.getState(), model = state.models.get(MODEL)!;
  federationRegistry.clear();
  const ownOffset = state.registerModelOffset(MODEL, getMaxExpressId(own, []));
  const peerOffset = state.registerModelOffset('peer', getMaxExpressId(peer, []));
  const ownView = new MutablePropertyView(own.properties, MODEL), peerView = new MutablePropertyView(peer.properties, 'peer');
  const models = new Map([[MODEL, { ...model, idOffset: ownOffset, ifcDataStore: own, maxExpressId: getMaxExpressId(own, []) }],
    ['peer', { ...model, id: 'peer', idOffset: peerOffset, ifcDataStore: peer, maxExpressId: getMaxExpressId(peer, []) }]]);
  for (const [id, entry] of models) if (entry.geometryResult) entry.geometryResult = { ...entry.geometryResult,
    meshes: entry.geometryResult.meshes.map(mesh => ({ ...mesh, expressId: toGlobalIdFromModels(models, id, mesh.expressId) })) };
  const ids = [toGlobalIdFromModels(models, MODEL, s.id), toGlobalIdFromModels(models, 'peer', s.id)];
  useViewerStore.setState({ models, mutationViews: new Map([[MODEL, ownView], ['peer', peerView]]), storeEditors: new Map(),
    undoStacks: new Map(), redoStacks: new Map(), selectedEntityIds: new Set(ids), selectedEntityId: ids[0] });
  const relationship = s.operation.expected.sourceMemberships[0];
  modelEditTarget(useViewerStore.getState(), 'peer')!.editor.setPositionalAttribute(relationship.id, 2, 'Peer current native membership');
  const reparsedPeer = await parseIfc(editedModelBytes(peer, peerView));
  assert.equal(effectiveMetadataRecord(reparsedPeer, relationship.id)?.attributes[2], 'Peer current native membership');
  const grounding = captureSelectionGrounding(useViewerStore.getState());
  assert.equal(grounding.elements.length, 2);
  for (const row of grounding.elements) { assert.equal(row.nativeAuthoringAvailability.storeyReassignment, 'available'); assert.ok(row.nativeStoreyReassignments?.length); }
  const before = JSON.stringify(grounding), revisions = [ownView.getMutationRevision(), peerView.getMutationRevision()];
  const graphs = [await graph(editedModelBytes(own, ownView)), await graph(editedModelBytes(peer, peerView))];
  replaceEvidence(captureEvidence('selection'));
  globalThis.fetch = async (_url, init) => {
    const wire = JSON.parse(String(init?.body));
    const user = wire.messages.filter((message: { role: string }) => message.role === 'user').at(-1);
    const sent: typeof grounding.elements = JSON.parse(user.content.split('\n').at(-1));
    assert.deepEqual(sent.map(row => [row.modelId, row.globalId]), grounding.elements.map(row => [row.modelId, row.globalId]));
    for (const row of sent) {
      assert.equal(row.nativeAuthoringAvailability.storeyReassignment, 'available');
      assert.ok(row.nativeStoreyReassignments?.length, 'each model must actually transport its own complete native candidate');
      const original = grounding.elements.find(entry => entry.modelId === row.modelId && entry.globalId === row.globalId); assert.ok(original);
      if (row.nativeAuthoringAvailability.storeyReassignment === 'available') {
        assert.deepEqual(row.nativeStoreyReassignments, original.nativeStoreyReassignments);
        for (const candidate of row.nativeStoreyReassignments ?? []) {
          assert.equal(candidate.sourceStorey.modelId, row.modelId); assert.equal(candidate.destinationStorey.modelId, row.modelId);
          const expected = JSON.parse(candidate.expectedJsonParts.join('')) as import('@ifc-lite/create').StoreyReassignmentPlan;
          const membership = expected.sourceMemberships.find(entry => entry.id === relationship.id); assert.ok(membership);
          if (row.modelId === 'peer') assert.equal(membership.attributes[2], 'Peer current native membership');
          else assert.notEqual(membership.attributes[2], 'Peer current native membership');
        }
      } else { assert.equal(row.nativeStoreyReassignments, null); assert.equal(row.nativeAuthoringAvailability.storeyReassignment, 'unavailable-transport-budget'); }
    }
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Two native model identities received.' }, finish_reason: 'stop' }] })}\n\n`);
  };
  assert.equal(await sendAssistant('Explain these native model-scoped pins', 'openai/gpt-free', '/api/chat',
    attachmentsForSend({ selection: grounding, screenshot: null })), true, useAssistant.getState().error ?? '');
  assert.equal(JSON.stringify(grounding), before);
  assert.deepEqual([ownView.getMutationRevision(), peerView.getMutationRevision()], revisions);
  assert.deepEqual(await graph(editedModelBytes(own, ownView)), graphs[0]);
  assert.deepEqual(await graph(editedModelBytes(peer, peerView)), graphs[1]);
});

for (const owner of ['source', 'destination'] as const) test(`#7328 public review refuses duplicate ${owner} storey identity before approval`, async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup(), batch = s.batch();
  const storeyId = owner === 'source' ? 42 : s.destination;
  const attributes = effectiveMetadataRecord(s.store, storeyId, s.view)!.attributes.map(value => {
    assert.ok(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean', 'IfcBuildingStorey attributes are scalar');
    return value;
  });
  const point = s.editor.addEntity('IfcCartesianPoint', [[50, 0, 0]]).expressId;
  const axis = s.editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
  attributes[5] = `#${s.editor.addEntity('IfcLocalPlacement', [null, `#${axis}`]).expressId}`;
  const duplicate = s.editor.addEntity('IfcBuildingStorey', attributes).expressId;
  const saved = await parseIfc(s.bytesNow());
  assert.equal(saved.getEntity(duplicate)?.attributes[0], saved.getEntity(storeyId)?.attributes[0]);
  const before = await graph(s.bytesNow()), revision = s.view.getMutationRevision(), depth = nativeSdkUndoDepth();
  const preview = previewModelAuthoring(useViewerStore.getState(), batch);
  assert.notEqual(preview.rows[0].status, 'ready', 'duplicate storey identity must not be offered for approval');
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'duplicate native storey');
  assert.equal(result.ok, false, 'canonical native preparation/commit must refuse duplicate identity');
  assert.deepEqual(await graph(s.bytesNow()), before);
  assert.equal(s.view.getMutationRevision(), revision, 'refusal preserves the native mutation revision'); assert.equal(nativeSdkUndoDepth(), depth, 'refusal preserves native Undo depth');
});

test('#7328 native near-text-limit pin distinguishes public batch overhead from actual request refusal', async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup();
  assert.equal(typeof nativeCreate.planStoreyReassignment, 'function');
  let expected = nativeCreate.planStoreyReassignment(s.store, s.view, [s.id], 42, s.destination);
  const relation = expected.sourceMemberships[0]; assert.ok(relation);
  // IfcRoot.Description is unbounded IfcText, not a 255-character IfcLabel.
  // Author actual IFC metadata; do not pad or alter the captured JSON pin.
  s.editor.setPositionalAttribute(relation.id, 3, 'N'.repeat(399_900 - JSON.stringify(expected).length - 2));
  expected = nativeCreate.planStoreyReassignment(s.store, s.view, [s.id], 42, s.destination);
  const saved = await parseIfc(s.bytesNow());
  assert.equal(saved.getEntity(relation.id)?.attributes[3], effectiveMetadataRecord(s.store, relation.id, s.view)!.attributes[3]);
  const pinLength = JSON.stringify(expected).length;
  const answer = JSON.stringify({ kind: 'model.authoring', version: 1, title: 'Native complete metadata', units: 'm', frame: 'storey-local', operations: [{ ...s.operation, expected }] });
  assert.ok(pinLength < 400_000); assert.ok(answer.length > 400_000);
  assert.throws(() => parseModelAuthoringBatch(answer), /text limit/);
  await settle();
  const grounding = captureSelectionGrounding(useViewerStore.getState());
  const candidate = grounding.elements[0].nativeStoreyReassignments?.find(item => item.destinationStorey.globalId === s.operation.destinationStorey.globalId);
  t.diagnostic(`actual native pin=${pinLength}; full batch=${answer.length}; captured candidate=${Boolean(candidate)}; availability=${JSON.stringify(grounding.elements[0].nativeAuthoringAvailability)}`);
  // Defer the advertised-parser assertion until the same public route measures
  // wire refusal. Nested tests run the global cleanup and invalidate this snapshot.
  replaceEvidence(captureEvidence('selection'));
  let requested = false;
  globalThis.fetch = async (_url, init) => {
    const wire = JSON.parse(String(init?.body));
    assert.ok(JSON.stringify(wire.messages).length <= 90_000, 'actual serialized provider messages including system stay bounded');
    const user = wire.messages.filter((message: { role: string }) => message.role === 'user').at(-1);
    const sent: typeof grounding.elements = JSON.parse(user.content.split('\n').at(-1));
    assert.equal(sent[0].modelId, MODEL); assert.equal(sent[0].globalId, grounding.elements[0].globalId);
    assert.notEqual(sent[0].nativeAuthoringAvailability.storeyReassignment, 'available');
    assert.equal(sent[0].nativeStoreyReassignments, null);
    requested = true;
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Native unavailable metadata received.' }, finish_reason: 'stop' }] })}\n\n`);
  };
  assert.equal(await sendAssistant('Explain this current native selection', 'openai/gpt-free', '/api/chat', attachmentsForSend({ selection: grounding, screenshot: null })), true, useAssistant.getState().error ?? '');
  assert.equal(requested, true);
  if (candidate) assert.doesNotThrow(() => parseModelAuthoringBatch(answer), 'advertised complete pin must fit the public full batch');
});

for (const owner of ['sourceStorey', 'destinationStorey'] as const) test(`#7328 public expected pin preserves and validates canonical ${owner} identity`, async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup(), batch = s.batch(), op = batch.operations[0];
  assert.equal(op.op, 'element.reassignStorey');
  if (op.op !== 'element.reassignStorey') throw new Error('Native reassignment operation required');
  assert.deepEqual(op.expected[owner], s.operation.expected[owner]);
  const saved = await parseIfc(s.bytesNow());
  assert.equal(saved.getEntity(op.expected[owner].expressId)?.attributes[0], op.expected[owner].GlobalId);
  for (const invalid of [undefined, null, { ...op.expected[owner], GlobalId: 'invalid' }, { ...op.expected[owner], expressId: op.expected[owner].expressId + 1 }]) {
    const expected = { ...s.operation.expected, [owner]: invalid };
    assert.throws(() => parseModelAuthoringBatch(JSON.stringify({ ...batch, operations: [{ ...s.operation, expected }] })), /unavailable-native-pin-shape/);
  }
  const preview = previewModelAuthoring(useViewerStore.getState(), batch);
  assert.equal(preview.rows[0].status, 'ready');
  s.editor.setPositionalAttribute(op.expected[owner].expressId, 0, generateIfcGuid());
  const before = await graph(s.bytesNow()), revision = s.view.getMutationRevision(), depth = nativeSdkUndoDepth();
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'changed reviewed storey identity');
  assert.equal(result.ok, false);
  assert.deepEqual(await graph(s.bytesNow()), before);
  assert.equal(s.view.getMutationRevision(), revision); assert.equal(nativeSdkUndoDepth(), depth);
});

test('#7328 actual parser-valid short-title native batch is not rejected by producer template overhead', async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup();
  let expected = nativeCreate.planStoreyReassignment(s.store, s.view, [s.id], 42, s.destination);
  const serialize = () => JSON.stringify({ kind: 'model.authoring', version: 1, title: 'N', units: 'm', frame: 'storey-local', operations: [{ ...s.operation, expected }] });
  const relation = expected.sourceMemberships[0]; assert.ok(relation);
  const description = 'S'.repeat(399_995 - serialize().length - 2);
  s.editor.setPositionalAttribute(relation.id, 3, description);
  expected = nativeCreate.planStoreyReassignment(s.store, s.view, [s.id], 42, s.destination);
  const saved = await parseIfc(s.bytesNow());
  assert.equal(saved.getEntity(relation.id)?.attributes[3], description);
  const answer = serialize();
  assert.ok(answer.length <= 400_000 && answer.length > 399_980, 'real native batch reaches the unchanged parser boundary');
  assert.doesNotThrow(() => parseModelAuthoringBatch(answer), 'outer parser must use the actual submitted title and bytes, not a longer producer template');
});
