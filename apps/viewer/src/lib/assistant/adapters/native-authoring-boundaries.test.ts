/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { EMPTY_SOURCE_BYTES, extractProjectUnits } from '@ifc-lite/parser';
import { readWallJoinTarget } from '@ifc-lite/create';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { previewModelAuthoring } from '@/lib/actions/model-authoring-preview';
import { commitModelAuthoring } from '@/lib/actions/model-authoring-commit';
import { undoModelChanges } from '@/lib/actions/model-change-commit';
import { useViewerStore } from '@/store';
import { GROUND_STOREY, SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { seedModelingSession, MODEL_ID, MESH_WALL } from '@/test/modeling-session-fixture';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest';
import { readOnlyModelEditLease } from '@/lib/actions/model-authoring-read-target';
import { readSplitSnapshot } from '@/lib/actions/model-authoring-split-state';
import { captureSelectionGrounding } from '@/lib/actions/selection-grounding';
import { setElementDimensions } from '@/components/viewer/model-inspector/inspector-edits';
import { attachmentsForSend } from '@/components/viewer/assistant/ComposerAttachments';
import { captureEvidence } from '../evidence';
import { replaceEvidence, cancelAssistant, useAssistant } from '../conversation';
import { sendAssistant } from '../request';
const initial = useViewerStore.getState(), assistant = useAssistant.getState(), originalFetch = globalThis.fetch;
const s = useViewerStore.getState;
afterEach(() => { cancelAssistant(); globalThis.fetch = originalFetch; useAssistant.setState(assistant, true); useViewerStore.setState(initial, true); });
async function wall(saved = true) {
  const { dataStore, view } = await seedAuthoringSample();
  const made = s().addWall(SAMPLE_MODEL, dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY),
    { Start: [0, 5, 0], End: [8, 5, 0], Thickness: .2, Height: 3, Name: 'Boundary native wall' });
  assert.ok('expressId' in made, 'error' in made ? made.error : '');
  const id = made.expressId;
  if (saved) {
    const parsed = await parseIfc(editedModelBytes(dataStore, view));
    const empty = new MutablePropertyView(parsed.properties, SAMPLE_MODEL);
    useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...s().models.get(SAMPLE_MODEL)!, ifcDataStore: parsed,
      maxExpressId: getMaxExpressId(parsed, []) }]]), ifcDataStore: parsed, mutationViews: new Map([[SAMPLE_MODEL, empty]]), storeEditors: new Map() });
    assert.equal(parsed.entities.getTypeName(id), 'IfcWall'); assert.ok(parsed.entities.getGlobalId(id));
  }
  useViewerStore.setState({ selectedEntity: { modelId: SAMPLE_MODEL, expressId: id }, selectedEntityId: id,
    selectedEntityIds: new Set([id]), selectedEntities: [], selectedEntitiesSet: new Set() });
  return id;
}
function row() { return JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data; }
function intercept() {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('data: {"choices":[{"delta":{"content":"Review"},"finish_reason":"stop"}]}\n\n'); };
  return () => calls;
}
for (const route of ['rich', 'attachment'] as const) for (const replacement of ['source', 'view'] as const)
test(`#7282 ${route} native captured snapshots refuse exact ${replacement} replacement before dispatch`, async () => {
  await wall(); const snapshot = captureEvidence(route === 'rich' ? 'selection' : 'loadReport');
  const grounding = route === 'attachment' ? captureSelectionGrounding(s()) : null;
  replaceEvidence(snapshot);
  const source = s().models.get(SAMPLE_MODEL)!.ifcDataStore!;
  if (replacement === 'source') {
    const reloaded = await parseIfc(source.source.materialize());
    assert.notEqual(reloaded, source); assert.equal(reloaded.entities.getGlobalId(s().selectedEntity!.expressId), source.entities.getGlobalId(s().selectedEntity!.expressId));
    s().updateModel(SAMPLE_MODEL, { ifcDataStore: reloaded });
  } else useViewerStore.setState({ mutationViews: new Map([[SAMPLE_MODEL, new MutablePropertyView(source.properties, SAMPLE_MODEL)]]) });
  const calls = intercept();
  assert.equal(await sendAssistant('Review native expected state', 'openai/gpt-free', '/api/chat', grounding ? attachmentsForSend({ selection: grounding, screenshot: null }) : {}), false);
  assert.equal(calls(), 0, 'Changed native capture authority never reaches transport');
});
for (const route of ['rich', 'attachment'] as const)
test(`#7282 ${route} capture publishes current native overlay and refuses later edits`, async () => {
  const id = await wall(); assert.equal(setElementDimensions(SAMPLE_MODEL, id, { kind: 'wall', height: 5 }), true);
  const parsed = await parseIfc(editedModelBytes(s().models.get(SAMPLE_MODEL)!.ifcDataStore!, s().mutationViews.get(SAMPLE_MODEL)!));
  assert.equal(readWallJoinTarget(parsed, new MutablePropertyView(parsed.properties, SAMPLE_MODEL), id, .001)?.height, 5);
  const snapshot = captureEvidence(route === 'rich' ? 'selection' : 'loadReport'), grounding = captureSelectionGrounding(s());
  const actual = route === 'rich' ? JSON.parse(snapshot.payload).evidence.rows[0].data : grounding.elements[0];
  assert.equal(actual.nativeTrimExtendExpected.wall.height, 5); replaceEvidence(snapshot);
  assert.equal(setElementDimensions(SAMPLE_MODEL, id, { kind: 'wall', height: 6 }), true);
  const calls = intercept();
  assert.equal(await sendAssistant('Review captured wall', 'openai/gpt-free', '/api/chat', route === 'attachment' ? attachmentsForSend({ selection: grounding, screenshot: null }) : {}), false);
  assert.equal(calls(), 0);
});

test('#7282 source-free unknown length units never fabricate native expected geometry', async () => {
  await wall(false); const model = s().models.get(SAMPLE_MODEL)!, original = model.ifcDataStore!;
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: { ...original, source: EMPTY_SOURCE_BYTES, lengthUnitScale: undefined } }]]) });
  const actual = row(), attachment = captureSelectionGrounding(s()).elements[0]; assert.ok(attachment);
  for (const data of [actual, attachment]) {
    assert.deepEqual(data.nativeAuthoringAvailability, { slabOpening: 'unavailable-unit', split: 'unavailable-unit', hosted: 'unavailable-unit', trimExtend: 'unavailable-unit', stair: 'unavailable-unit', placement: 'unavailable-unit' });
    for (const key of ['nativeSlabOpeningExpected', 'nativePlacement', 'nativeSplitExpected', 'nativeHostedExpected', 'nativeTrimExtendExpected', 'nativeStairExpected']) assert.equal(data[key], null);
  }
});

test('#7282 native projected polygon expected pin is removed whole while attachment preserves canonical vertices', async () => {
  const { dataStore } = await seedAuthoringSample();
  const points: [number, number][] = Array.from({ length: 120 }, (_, i) => [10 * Math.cos(i * Math.PI / 60), 10 * Math.sin(i * Math.PI / 60)]);
  const made = s().addSlab(SAMPLE_MODEL, dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY), { Profile: 'polygon', OuterCurve: points, Position: [0, 20, 0], Thickness: .2, Name: 'Native bounded polygon' });
  assert.ok('expressId' in made, 'error' in made ? made.error : '');
  useViewerStore.setState({ selectedEntity: { modelId: SAMPLE_MODEL, expressId: made.expressId }, selectedEntityId: made.expressId, selectedEntityIds: new Set([made.expressId]), selectedEntities: [], selectedEntitiesSet: new Set() });
  const lease = readOnlyModelEditLease(s(), SAMPLE_MODEL); assert.ok(lease);
  const expected = readSplitSnapshot(lease.target.dataStore, lease.target.editor, made.expressId, 'm');
  assert.equal(expected.kind, 'slab'); assert.ok('footprint' in expected.chain && expected.chain.footprint.length > 100);
  const snapshot = captureEvidence('selection'), projected = JSON.parse(snapshot.payload).evidence.rows[0].data;
  assert.equal(projected.nativeSplitExpected, null, 'No truncated expected chain may authorize review');
  assert.ok(projected.nativeAuthoringAvailability, 'Projection must disclose whole-pin availability');
  assert.equal(projected.nativeSlabOpeningExpected, null, '#7310 a partial slab opening snapshot never remains authorizable');
  assert.equal(projected.nativeAuthoringAvailability.slabOpening, 'unavailable-projection');
  assert.equal(projected.nativeAuthoringAvailability.split, 'unavailable-projection'); assert.equal(snapshot.projectionTruncated, true);
  const attachment = captureSelectionGrounding(s()); assert.equal(attachment.elements.length, 1);
  assert.deepEqual(attachment.elements[0].nativeSplitExpected, expected, 'Full native pin is preserved on the unprojected explicit route');
  assert.deepEqual(attachment.elements[0].nativeSlabOpeningExpected, expected, '#7310 the explicit route retains the complete native slab snapshot');
  assert.equal(attachment.elements[0].nativeAuthoringAvailability.slabOpening, 'available');
  assert.equal(attachment.elements[0].nativeAuthoringAvailability.split, 'available'); assert.doesNotThrow(lease.validate);
});


test('#7282 source-free recorded units preserve readable native authored snapshot without claiming hosted source availability', async () => {
  await wall(false);
  const model = s().models.get(SAMPLE_MODEL)!,original = model.ifcDataStore!;
  assert.equal(original.lengthUnitScale,.001);
  useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:{...original,source:EMPTY_SOURCE_BYTES}}]])});
  const actual=row(),attachment=captureSelectionGrounding(s()).elements[0];assert.ok(attachment);
  for(const data of [actual,attachment]){assert.ok(data.nativeTrimExtendExpected, 'Known native authored wall must publish its complete expected pin');assert.ok(data.nativeAuthoringAvailability, 'Native source availability is explicit');assert.equal(data.nativeTrimExtendExpected.wall.height,3);assert.deepEqual(data.nativeTrimExtendExpected.wall.wall.end,[8,5]);assert.equal(data.nativeAuthoringAvailability.trimExtend,'available');assert.equal(data.nativeHostedExpected,null);assert.equal(data.nativeAuthoringAvailability.hosted,'unavailable-native-layout');assert.match(data.nativeAuthoringRefusals.hosted,/source|IFC/i);}
});

test('#7282 genuine saved IFC with omitted project units refuses source fallback geometry assumptions', async () => {
  const id=await wall(),store=s().models.get(SAMPLE_MODEL)!.ifcDataStore!,view=s().mutationViews.get(SAMPLE_MODEL)!;
  const project=store.spatialHierarchy?.project?.expressId;assert.ok(project);new StoreEditor(store,view).setPositionalAttribute(project,8,null);
  const unknown=await parseIfc(editedModelBytes(store,view));assert.equal(unknown.entities.getGlobalId(id),store.entities.getGlobalId(id));assert.equal(extractProjectUnits(unknown.source,unknown.entityIndex,project).resolvedForUnitType('LENGTHUNIT'),undefined);
  const unknownView=new MutablePropertyView(unknown.properties,SAMPLE_MODEL);useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...s().models.get(SAMPLE_MODEL)!,ifcDataStore:unknown}]]),mutationViews:new Map([[SAMPLE_MODEL,unknownView]])});
  for(const data of [row(),captureSelectionGrounding(s()).elements[0]]){assert.deepEqual(data.nativeAuthoringAvailability,{slabOpening:'unavailable-unit',split:'unavailable-unit',hosted:'unavailable-unit',trimExtend:'unavailable-unit',stair:'unavailable-unit',placement:'unavailable-unit'});assert.equal(data.nativeSplitExpected,null);assert.equal(data.nativeTrimExtendExpected,null);}
});

test('#7282 real imported mesh layout is unavailable for native expected edits rather than absent geometry', async () => {
  await seedModelingSession();const model=s().models.get(MODEL_ID)!;s().updateModel(MODEL_ID,{maxExpressId:getMaxExpressId(model.ifcDataStore!,[])});assert.equal(model.ifcDataStore!.entities.getTypeName(MESH_WALL),'IfcWall');
  useViewerStore.setState({selectedEntity:{modelId:MODEL_ID,expressId:MESH_WALL},selectedEntityId:MESH_WALL,selectedEntityIds:new Set([MESH_WALL]),selectedEntities:[],selectedEntitiesSet:new Set()});
  for(const data of [row(),captureSelectionGrounding(s()).elements[0]]){assert.ok(data);assert.deepEqual(data.nativeAuthoringAvailability,{slabOpening:'unavailable-native-layout',split:'unavailable-native-layout',hosted:'unavailable-native-layout',trimExtend:'unavailable-native-layout',stair:'unavailable-native-layout',placement:'available'});assert.equal(data.nativeSplitExpected,null);assert.equal(data.nativeTrimExtendExpected,null);assert.match(data.nativeAuthoringRefusals.split,/Split unavailable/i);}
});


test('#7282 removing the native source reports unavailable selection rather than a usable expected pin', async () => {
  await wall();s().removeModel(SAMPLE_MODEL);const snapshot=captureEvidence('selection'),payload=JSON.parse(snapshot.payload);assert.equal(payload.sourceAvailability,'unavailable');assert.equal(payload.evidence.rows.length,0);assert.equal(captureSelectionGrounding(s()).elements.length,0);
});

for (const route of ['rich', 'attachment'] as const) for (const replacement of ['source', 'view'] as const)
test(`#7282 in-flight ${route} native ${replacement} replacement cancels owned transport and rejects a late answer`, async () => {
  await wall();replaceEvidence(captureEvidence(route === 'rich' ? 'selection' : 'loadReport'));
  const grounding = route === 'attachment' ? captureSelectionGrounding(s()) : null;
  let release: ((response: Response) => void) | undefined;
  let started: (() => void) | undefined;
  const began = new Promise<void>(resolve => { started = resolve; });
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = async (_url, init) => {
    signal = init?.signal; started?.();
    // Deliberately uncooperative transport: native request ownership must still
    // reject a response delivered after the captured source authority changes.
    return new Promise<Response>(resolve => { release = resolve; });
  };
  const sending = sendAssistant('Review captured native shape', 'openai/gpt-free', '/api/chat', grounding ? attachmentsForSend({ selection: grounding, screenshot: null }) : {});await began;
  const source=s().models.get(SAMPLE_MODEL)!.ifcDataStore!;
  if(replacement==='source')s().updateModel(SAMPLE_MODEL,{ifcDataStore:await parseIfc(source.source.materialize())});
  else useViewerStore.setState({mutationViews:new Map([[SAMPLE_MODEL,new MutablePropertyView(source.properties,SAMPLE_MODEL)]])});
  const abortedBeforeLateAnswer = signal?.aborted; assert.ok(release);
  // Settle this owned gate even when an inverse makes the abort assertion red.
  // Capture its abort state BEFORE delivering the deliberately late response.
  release(new Response('data: {"choices":[{"delta":{"content":"LATE native answer"},"finish_reason":"stop"}]}\n\n'));
  const accepted = await sending;
  assert.ok(abortedBeforeLateAnswer,'Exact native source/view lease change aborts its active request before the late answer');
  assert.equal(accepted,false);assert.equal(useAssistant.getState().messages.some(message=>message.content.includes('LATE native answer')),false);
});

test('#7282 unrelated loaded source replacement preserves the selected native capture',async()=>{
  await wall();const model=s().models.get(SAMPLE_MODEL)!,source=model.ifcDataStore!;
  const peer=await parseIfc(source.source.materialize());useViewerStore.setState({models:new Map([[SAMPLE_MODEL,model],['unrelated',{...model,id:'unrelated',idOffset:1_000_000,ifcDataStore:peer}]])});
  replaceEvidence(captureEvidence('selection'));s().updateModel('unrelated',{ifcDataStore:await parseIfc(peer.source.materialize())});
  const calls=intercept();assert.equal(await sendAssistant('Review selected native shape','openai/gpt-free','/api/chat'),true);assert.equal(calls(),1);
});


for (const route of ['rich', 'attachment'] as const) for (const edit of ['named', 'positional'] as const)
test(`#7282 ${route} ${edit} current native identity reaches wire, Apply and independent Undo reparse`, async () => {
  const id = await wall(), store = s().models.get(SAMPLE_MODEL)!.ifcDataStore!, view = s().mutationViews.get(SAMPLE_MODEL)!;
  const oldGuid = store.entities.getGlobalId(id), GlobalId = generateIfcGuid(), Name = 'Current reviewed native wall';
  const editor = new StoreEditor(store, view);
  if (edit === 'named') { editor.setAttribute(id, 'GlobalId', GlobalId); editor.setAttribute(id, 'Name', Name); }
  else { editor.setPositionalAttribute(id, 0, GlobalId); editor.setPositionalAttribute(id, 2, Name); }
  const before = await parseIfc(editedModelBytes(store, view));
  assert.equal(before.entities.getGlobalId(id), GlobalId); assert.equal(before.entities.getName(id), Name);
  assert.equal(before.entities.getExpressIdByGlobalId(oldGuid), -1);
  const snapshot = captureEvidence(route === 'rich' ? 'selection' : 'loadReport'); replaceEvidence(snapshot);
  const grounding = route === 'attachment' ? captureSelectionGrounding(s()) : null;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const wire = JSON.parse(String(init?.body));
    let actual;
    if (route === 'rich') {
      const system = typeof wire.system === 'string' ? wire.system : wire.system.map((block: { text: string }) => block.text).join('\n');
      const offset = system.indexOf(snapshot.payload); assert.ok(offset >= 0);
      actual = JSON.parse(system.slice(offset, offset + snapshot.payload.length)).evidence.rows[0].data;
    } else {
      const user = wire.messages.filter((message: { role: string }) => message.role === 'user').at(-1);
      actual = JSON.parse(user.content.split('\n').at(-1))[0];
    }
    assert.equal(actual.globalId, GlobalId); assert.equal(actual.name, Name); assert.equal(actual.type, 'IfcWall');
    assert.ok(actual.nativeAuthoringAvailability); assert.equal(actual.nativeAuthoringAvailability.trimExtend, 'available');
    const proposal = { version: 1, kind: 'model.authoring', title: 'Current identity trim', units: 'm', frame: 'storey-local', operations: [{
      op: 'element.trimExtend', target: { modelId: actual.modelId, globalId: actual.globalId, ifcClass: actual.type, name: actual.name },
      expected: actual.nativeTrimExtendExpected, mode: 'trim', click: [8, 5], boundary: { line: { a: [6, -10], b: [6, 10], tMin: 0, tMax: 1, reach: 10 } },
    }] };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(proposal) }, finish_reason: 'stop' }] })}\n\n`);
  };
  assert.equal(await sendAssistant('Prepare current native trim', 'openai/gpt-free', '/api/chat', grounding ? attachmentsForSend({ selection: grounding, screenshot: null }) : {}), true, useAssistant.getState().error ?? '');
  assert.equal(calls, 1);
  const answer = useAssistant.getState().messages.at(-1)?.content; assert.ok(answer);
  const preview = previewModelAuthoring(s(), parseModelAuthoringBatch(answer)); assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? '');
  const committed = commitModelAuthoring(useViewerStore, preview, new Set([0]), '#7282 current identity');
  assert.ok(committed.ok, committed.ok ? '' : committed.detail ?? committed.reason);
  const after = await parseIfc(editedModelBytes(store, view));
  assert.equal(after.entities.getGlobalId(id), GlobalId); assert.equal(after.entities.getName(id), Name);
  assert.deepEqual(readWallJoinTarget(after, new MutablePropertyView(after.properties, SAMPLE_MODEL), id, .001)?.wall.end, [6, 5]);
  assert.ok(undoModelChanges(useViewerStore, committed.receipt).ok);
  const undone = await parseIfc(editedModelBytes(store, view));
  assert.equal(undone.entities.getGlobalId(id), GlobalId); assert.equal(undone.entities.getName(id), Name);
  assert.deepEqual(readWallJoinTarget(undone, new MutablePropertyView(undone.properties, SAMPLE_MODEL), id, .001)?.wall.end, [8, 5]);
});
