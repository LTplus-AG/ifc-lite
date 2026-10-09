/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { act } from 'react';
import { afterEach, test } from 'node:test';
import { useViewerStore } from '@/store';
import { MODEL, seedNativeSdkModel, settle, nativeSdkUndoDepth } from '@/test/native-sdk-model';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { federationRegistry } from '@ifc-lite/renderer';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest';
import { toGlobalIdFromModels } from '@/store/globalId';
import { readRelatedLists } from '@ifc-lite/create';
import { IfcAPI } from '@ifc-lite/wasm';
import { remeshOnApi, styleWireOnApi, applyRemeshConfig } from '../../../../../packages/geometry/src/remesh/remesh-core';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { captureSelectionGrounding } from './selection-grounding';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { prepareReviewedAlignments } from './model-authoring-align';
import { commitModelAuthoring } from './model-authoring-commit';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { storeyBoxes } from '@/lib/commands/modeling/align-boxes';
import { captureEvidence } from '@/lib/assistant/evidence';
import { replaceEvidence, cancelAssistant, useAssistant } from '@/lib/assistant/conversation';
import { sendAssistant } from '@/lib/assistant/request';
import { attachmentsForSend } from '@/components/viewer/assistant/ComposerAttachments';
import { render, click, advance, cleanup } from '@/test/render';
import { ModelAuthoringReview } from '@/components/viewer/actions/ModelAuthoringReview';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { parseIfc } from '@/test/authoring-sample-fixture';
const original = useViewerStore.getState(), assistant = useAssistant.getState(), originalFetch = globalThis.fetch;
afterEach(() => { federationRegistry.clear(); cleanup(); cancelAssistant(); globalThis.fetch = originalFetch; useAssistant.setState(assistant, true); setRemeshClientFactory(null); useViewerStore.setState(original, true); });
async function setup(federated = false) {
  federationRegistry.clear();
  const { adapter, view: authoredView } = await seedNativeSdkModel();
  let view = authoredView, owner = MODEL;
  const reference = adapter.addColumn(MODEL, 42, { Position: [20,20,0], Width: .8, Depth: .4, Height: 3, Name: 'Reference' });
  const first = adapter.addColumn(MODEL, 42, { Position: [24,21,0], Width: .4, Depth: .4, Height: 3, Name: 'First target' });
  const second = adapter.addColumn(MODEL, 42, { Position: [28,22,0], Width: .6, Depth: .4, Height: 3, Name: 'Second target' });
  await settle();
  if (federated) {
    const state = useViewerStore.getState(), base = state.models.get(MODEL)!; assert.ok(base.ifcDataStore);
    const saved = await parseIfc(editedModelBytes(base.ifcDataStore, view)), peer = await parseIfc(saved.source.materialize());
    owner = 'peer';
    const firstOffset = state.registerModelOffset(MODEL, getMaxExpressId(saved, []));
    const peerOffset = state.registerModelOffset(owner, getMaxExpressId(peer, []));
    const savedView = new MutablePropertyView(saved.properties, MODEL); view = new MutablePropertyView(peer.properties, owner);
    const models = new Map([[MODEL, { ...base, idOffset: firstOffset, ifcDataStore: saved, maxExpressId: getMaxExpressId(saved, []) }],
      [owner, { ...base, id: owner, idOffset: peerOffset, ifcDataStore: peer, maxExpressId: getMaxExpressId(peer, []) }]]);
    for (const [id, model] of models) if (model.geometryResult) model.geometryResult = { ...model.geometryResult,
      meshes: model.geometryResult.meshes.map(mesh => ({ ...mesh, expressId: toGlobalIdFromModels(models, id, mesh.expressId) })) };
    useViewerStore.setState({ models, mutationViews: new Map([[MODEL, savedView], [owner, view]]), storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map() });
  }
  const rendererId = (id: number) => toGlobalIdFromModels(useViewerStore.getState().models, owner, id);
  useViewerStore.setState({ selectedEntityIds: new Set([reference.expressId, first.expressId, second.expressId].map(rendererId)), selectedEntityId: rendererId(reference.expressId) });
  const captured = captureSelectionGrounding(useViewerStore.getState());
  assert.equal(captured.elements.length, 3);
  const rows = [reference, first, second].map(ref => {
    const guid = view.getNewEntity(ref.expressId)?.attributes[0] ?? useViewerStore.getState().models.get(owner)?.ifcDataStore?.entities.getGlobalId(ref.expressId);
    const row = captured.elements.find(row => row.globalId === guid); assert.ok(row?.nativePlacement);
    return row;
  });
  const target = (row: typeof rows[number]) => ({ modelId: row.modelId, globalId: row.globalId, ifcClass: row.type, name: row.name });
  const batch = parseModelAuthoringBatch(JSON.stringify({ kind:'model.authoring', version:1, title:'Native align', units:'m', frame:'storey-local',
    operations: [{ op:'element.align', reference: target(rows[0]), targets: rows.slice(1).map(target), mode:'left',
      expected:{ reference: rows[0].nativePlacement, targets: rows.slice(1).map(row => row.nativePlacement) } }] }));
  const plane = buildStoreyWorkplane(useViewerStore.getState(), owner, 42, 0); assert.ok(isWorkplane(plane));
  return { adapter, view, owner, batch, reference, first, second, boxes: () => storeyBoxes(useViewerStore.getState(), owner, 42, plane) };
}

test('#7313 reviewed Align prepares actual Bonsai geometry, applies two different native shifts and one Undo restores the IFC graph', async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup(), before = s.boxes(), graph = structuredClone(s.view.getNewEntities()), undo = nativeSdkUndoDepth();
  assert.equal(previewModelAuthoring(useViewerStore.getState(), s.batch).rows[0].status, 'blocked');
  await prepareReviewedAlignments(useViewerStore.getState, s.batch);
  const preview = previewModelAuthoring(useViewerStore.getState(), s.batch);
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue);
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'Native evidence');
  assert.ok(result.ok, result.ok ? '' : result.detail ?? result.reason);
  await settle();
  const after = s.boxes(), fixed = before.get(s.reference.expressId); assert.ok(fixed);
  assert.deepEqual(after.get(s.reference.expressId), fixed);
  for (const ref of [s.first, s.second]) {
    const box = after.get(ref.expressId), old = before.get(ref.expressId); assert.ok(box && old);
    assert.ok(Math.abs(box.min[0] - fixed.min[0]) < 1e-4);
    assert.ok(Math.abs(box.min[1] - old.min[1]) < 1e-4);
  }
  const model = useViewerStore.getState().models.get(MODEL); assert.ok(model?.ifcDataStore);
  const parsed = await parseIfc(editedModelBytes(model.ifcDataStore, s.view));
  assert.equal(parsed.entities.getTypeName(s.first.expressId), 'IfcColumn');
  assert.equal(parsed.entities.getTypeName(s.second.expressId), 'IfcColumn');
  useViewerStore.getState().undo(MODEL); await settle();
  assert.equal(nativeSdkUndoDepth(), undo);
  assert.deepEqual(s.view.getNewEntities(), graph);
  assert.deepEqual(s.boxes(), before);
});

test('#7313 held Align preparation cannot approve a direct native revision', async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup();
  await prepareReviewedAlignments(useViewerStore.getState, s.batch);
  const held = previewModelAuthoring(useViewerStore.getState(), s.batch);
  assert.equal(held.rows[0].status, 'ready');
  s.view.setAttribute(s.first.expressId, 'Name', 'Changed after preparation');
  assert.notEqual(previewModelAuthoring(useViewerStore.getState(), s.batch).rows[0].status, 'ready');
  const result = commitModelAuthoring(useViewerStore, held, new Set([0]), 'Stale');
  assert.equal(result.ok, false);
});

for (const change of ['source', 'cancel'] as const) test(`#7313 native Align ${change} during real WASM preparation rejects late publication`, async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup(), api = new IfcAPI();
  let started!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  setRemeshClientFactory(async config => {
    applyRemeshConfig(api, config);
    return { alive: true, setConfig: next => applyRemeshConfig(api, next), dispose: () => api.free(),
      styleWire: async source => styleWireOnApi(api, source),
      remesh: async request => { started(); await gate; return remeshOnApi(api, request); } };
  });
  const controller = new AbortController();
  const preparing = prepareReviewedAlignments(useViewerStore.getState, s.batch, controller.signal);
  await began;
  if (change === 'source') s.view.setAttribute(s.first.expressId, 'Description', 'Edited during native preparation');
  else controller.abort();
  release();
  await assert.rejects(preparing, /changed|cancelled|stale/i);
  assert.notEqual(previewModelAuthoring(useViewerStore.getState(), s.batch).rows[0].status, 'ready');
});

test('#7313 native Align model relocation invalidates the prepared canonical workplane', async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup();
  await prepareReviewedAlignments(useViewerStore.getState, s.batch);
  const held = previewModelAuthoring(useViewerStore.getState(), s.batch); assert.equal(held.rows[0].status, 'ready');
  useViewerStore.getState().openReposition([MODEL]);
  useViewerStore.getState().previewModelTranslation([50, 0, 0]);
  useViewerStore.getState().applyModelTranslation();
  assert.equal(previewModelAuthoring(useViewerStore.getState(), s.batch).rows[0].status, 'blocked');
  assert.equal(commitModelAuthoring(useViewerStore, held, new Set([0]), 'Relocated').ok, false);
});

for (const route of ['rich', 'attachment'] as const) test(`#7313 actual ${route} Align wire supplies the complete native population to mounted review/Apply`, async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup(), before = s.boxes(), snapshot = captureEvidence(route === 'rich' ? 'selection' : 'loadReport');
  replaceEvidence(snapshot);
  const grounding = route === 'attachment' ? captureSelectionGrounding(useViewerStore.getState()) : null;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++; const wire = JSON.parse(String(init?.body));
    let rows: { globalId: string; modelId: string; type: string; name: string; nativePlacement: unknown }[];
    if (route === 'rich') {
      const system = typeof wire.system === 'string' ? wire.system : wire.system.map((b: { text: string }) => b.text).join('\n');
      const at = system.indexOf(snapshot.payload); assert.ok(at >= 0);
      rows = JSON.parse(system.slice(at, at + snapshot.payload.length)).evidence.rows.map((r: { data: typeof rows[number] }) => r.data);
    } else {
      const user = wire.messages.filter((m: { role: string }) => m.role === 'user').at(-1);
      rows = JSON.parse(user.content.split('\n').at(-1));
    }
    assert.equal(rows.length, 3); assert.ok(rows.every(row => row.nativePlacement));
    const reference = rows.find(row => row.name === 'Reference'), targets = rows.filter(row => row.name !== 'Reference'); assert.ok(reference);
    const target = (row: typeof rows[number]) => ({ modelId: row.modelId, globalId: row.globalId, ifcClass: row.type, name: row.name });
    const answer = JSON.stringify({ kind: 'model.authoring', version: 1, title: 'Native wire Align', units: 'mm', frame: 'storey-local',
      operations: [{ op: 'element.align', reference: target(reference), targets: targets.map(target), mode: 'left',
        expected: { reference: reference.nativePlacement, targets: targets.map(row => row.nativePlacement) } }] });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] })}\n\n`);
  };
  assert.equal(await sendAssistant('Draft native left Align', 'openai/gpt-free', '/api/chat', grounding ? attachmentsForSend({ selection: grounding, screenshot: null }) : {}), true, useAssistant.getState().error ?? '');
  assert.equal(calls, 1);
  const answer = useAssistant.getState().messages.at(-1)?.content; assert.ok(answer);
  const batch = parseModelAuthoringBatch(answer);
  const ui = render(<ModelAuthoringReview batch={batch} origin="#7313 actual wire" />);
  const button = (label: string) => { const found = [...ui.querySelectorAll('button')].find(b => b.textContent?.includes(label)); assert.ok(found, label); return found; };
  click(button('Prepare native Align geometry'));
  for (let i = 0; i < 30 && previewModelAuthoring(useViewerStore.getState(), batch).rows[0].status !== 'ready'; i++) await advance(10);
  assert.equal(previewModelAuthoring(useViewerStore.getState(), batch).rows[0].status, 'ready');
  click(button('Apply')); await act(async () => { await settle(); });
  const fixed = before.get(s.reference.expressId); assert.ok(fixed);
  for (const target of [s.first, s.second]) assert.ok(Math.abs(s.boxes().get(target.expressId)!.min[0] - fixed.min[0]) < 1e-4);
  click(button('Undo')); await act(async () => { await settle(); }); assert.deepEqual(s.boxes(), before);
});

test('#7313 earlier same-model geometry refuses Align before any live write', async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup(), op = s.batch.operations[0]; assert.equal(op.op, 'element.align');
  if (op.op !== 'element.align') return;
  const mixed = { ...s.batch, operations: [{ op: 'element.move' as const, target: op.targets[0], delta: [1,0] as [number,number] }, op] };
  const history = s.view.getMutations(), graph = structuredClone(s.view.getNewEntities());
  const preview = previewModelAuthoring(useViewerStore.getState(), mixed);
  assert.equal(preview.rows[1].status, 'unsupported');
  await assert.rejects(prepareReviewedAlignments(useViewerStore.getState, mixed), /earlier.*geometry/i);
  assert.deepEqual(s.view.getMutations(), history); assert.deepEqual(s.view.getNewEntities(), graph);
});

test('#7313 a same-model duplicate Root GlobalId cannot authorize native Align even with matching placement', async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup(), op = s.batch.operations[0]; assert.equal(op.op, 'element.align');
  if (op.op !== 'element.align') return;
  s.view.setAttribute(s.second.expressId, 'GlobalId', op.reference.globalId);
  assert.equal(previewModelAuthoring(useViewerStore.getState(), s.batch).rows[0].status, 'ambiguous-target');
});

test('#7313 native type detachment metadata can precede Align without guessing new geometry', async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup();
  const type = s.adapter.addElementType(MODEL, { Type: 'IfcColumnType', Name: 'Column metadata type' });
  s.adapter.assignType(MODEL, type.expressId, [s.first.expressId]); await settle();
  const captured = captureSelectionGrounding(useViewerStore.getState());
  const first = captured.elements.find(row => row.name === 'First target'); assert.ok(first?.nativeType.expected);
  const batch = parseModelAuthoringBatch(JSON.stringify({ ...s.batch, operations: [{ op: 'type.detach',
    target: { modelId: first.modelId, globalId: first.globalId, ifcClass: first.type, name: first.name }, expected: first.nativeType.expected }, ...s.batch.operations] }));
  const before = s.boxes(), graph = structuredClone(s.view.getNewEntities());
  assert.equal(previewModelAuthoring(useViewerStore.getState(), batch).rows[0].status, 'ready');
  await prepareReviewedAlignments(useViewerStore.getState, batch);
  const preview = previewModelAuthoring(useViewerStore.getState(), batch);
  assert.deepEqual(preview.rows.map(row => row.status), ['ready', 'ready']);
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0,1]), 'Native metadata and Align'); assert.ok(result.ok, result.ok ? '' : result.detail ?? result.reason);
  await settle(); const fixed = before.get(s.reference.expressId); assert.ok(fixed);
  assert.ok(Math.abs(s.boxes().get(s.first.expressId)!.min[0] - fixed.min[0]) < 1e-4);
  const store = useViewerStore.getState().models.get(MODEL)?.ifcDataStore; assert.ok(store);
  const parsed = await parseIfc(editedModelBytes(store, s.view));
  assert.equal(readRelatedLists(parsed, 'IfcRelDefinesByType').some(rel => rel.relatedIds.includes(s.first.expressId)), false);
  useViewerStore.getState().undo(MODEL); await settle();
  assert.deepEqual(s.view.getNewEntities(), graph); assert.deepEqual(s.boxes(), before);
});

test('#7313 federated native Align resolves colliding source GUIDs only in the captured owner', async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup(true), state = useViewerStore.getState(), unrelated = state.models.get(MODEL); assert.ok(unrelated?.ifcDataStore);
  const untouched = structuredClone(unrelated.geometryResult?.meshes.map(mesh => ({ id:mesh.expressId, positions:Array.from(mesh.positions) })));
  const before = s.boxes();
  const native = state.models.get(s.owner)?.ifcDataStore; assert.ok(native);
  assert.equal(native.entities.getGlobalId(s.first.expressId), unrelated.ifcDataStore.entities.getGlobalId(s.first.expressId));
  await prepareReviewedAlignments(useViewerStore.getState, s.batch);
  const preview = previewModelAuthoring(useViewerStore.getState(), s.batch); assert.equal(preview.rows[0].modelId, s.owner); assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue);
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), '#7313 federated native'); assert.ok(result.ok, result.ok ? '' : result.detail ?? result.reason);
  await settle(s.owner);
  const reference = before.get(s.reference.expressId); assert.ok(reference);
  assert.ok(Math.abs(s.boxes().get(s.first.expressId)!.min[0] - reference.min[0]) < 1e-4);
  const still = useViewerStore.getState().models.get(MODEL)?.geometryResult?.meshes.map(mesh => ({id:mesh.expressId,positions:Array.from(mesh.positions)}));
  assert.deepEqual(still, untouched);
  useViewerStore.getState().undo(s.owner); await settle(s.owner); assert.deepEqual(s.boxes(), before);
});
