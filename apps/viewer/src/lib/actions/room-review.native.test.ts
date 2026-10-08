/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { roomChainInStore } from '../../../../../packages/create/src/in-store/room-store.js';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { seedReviewedRoom, roomProposal, roomEnvelope } from '@/test/reviewed-room-fixture';
import { MODEL, nativeSdkMeshes, settle } from '@/test/native-sdk-model';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { clearModelLayouts } from '@/lib/rooms/room-layout';
import { useViewerStore } from '@/store';
import { buildStoreyWorkplane } from '@/lib/commands/modeling/workplane';
import { parseRoomProposal } from './room-command-proposal';
import { prepareRoomReview } from './room-review';
import { commitReviewedRoom } from './room-receipt';
import { decodeModelChangeReceipt } from './receipts';
import { undoModelChanges } from './model-change-commit';

const initial = useViewerStore.getState();
afterEach(() => { clearModelLayouts(MODEL); setRemeshClientFactory(null); useViewerStore.setState(initial, true); });
const prepare = (command?: Record<string, unknown>, extra?: Record<string, unknown>) => prepareRoomReview(roomProposal(command, extra), new AbortController().signal);
const corners = (outline: readonly (readonly [number, number])[]) => outline.map(p => p.map(v => Number(v.toFixed(4))).join(',')).sort();

it('exports the native prepared polygon, names, SI height/areas and actual WASM mesh; receipt Undo reverts one group (#7286)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { store, view } = await seedReviewedRoom();
  const before = structuredClone(view.getEffectiveChanges());
  const review = await prepare({ action: 'auto', PredefinedType: 'EXTERNAL', ObjectType: 'Reviewed room' });
  try {
    assert.equal(review.snapshot.candidateCount, 1);
    assert.equal(review.snapshot.roomCount, 1, 'the committed Bonsai room is retained in complete native membership');
    const ref = review.prepared.result.created[0];
    const expected = roomChainInStore(store, review.prepared.preview.editor, ref.expressId);
    assert.ok(expected.ok);
    assert.deepEqual(view.getEffectiveChanges(), before);
    const { result, receipt } = commitReviewedRoom(review, 'native-room-test');
    assert.equal(receipt.batches.length, 1, 'receipt addresses the real single native Undo group');
    assert.equal(decodeModelChangeReceipt(JSON.parse(JSON.stringify(receipt)))?.kind, 'room.command');
    const source = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
    const parsed = await new IfcParser().parseColumnar(source.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
    const exported = roomChainInStore(parsed, new StoreEditor(parsed, new MutablePropertyView(parsed.properties ?? null, MODEL)), ref.expressId);
    assert.ok(exported.ok);
    assert.deepEqual(corners(exported.chain.footprint), corners(expected.chain.footprint));
    assert.equal(exported.chain.thickness, 3);
    assert.equal(parsed.entities.getName(ref.expressId), 'Reviewed 2');
    const attrs = parsed.entityIndex.byId.get(ref.expressId);
    assert.ok(attrs, 'the IFC room survives real STEP scan');
    const qto = view.getQuantitiesForEntity(ref.expressId).find(set => set.name === 'Qto_SpaceBaseQuantities')!;
    assert.equal(Number(qto.quantities.find(q => q.name === 'GrossVolume')?.value), review.snapshot.candidates[0].grossArea * 3);
    await settle();
    const meshes = nativeSdkMeshes().filter(mesh => mesh.expressId === result.created[0].expressId);
    assert.ok(meshes.length > 0, 'the actual canonical WASM mesh producer renders the committed native room');
    const plane = buildStoreyWorkplane(useViewerStore.getState(), MODEL, 42, 0);
    assert.ok(!('refused' in plane));
    const xs = meshes.flatMap(mesh => [...mesh.positions].filter((_, i) => i % 3 === 0).map(x => x + (mesh.origin?.[0] ?? 0)));
    const outlineXs = expected.chain.footprint.map(([x,y]) => plane.localToRender([x,y,expected.chain.baseElevation])[0]);
    assert.ok(Math.abs(Math.min(...xs) - Math.min(...outlineXs)) < .0001, `native mesh minimum ${Math.min(...xs)} versus preview ${Math.min(...outlineXs)}`);
    assert.ok(Math.abs(Math.max(...xs) - Math.max(...outlineXs)) < .0001, `native mesh maximum ${Math.max(...xs)} versus preview ${Math.max(...outlineXs)}`);
    assert.deepEqual(undoModelChanges(useViewerStore, receipt), { ok: true });
    assert.deepEqual(view.getEffectiveChanges(), before);
    useViewerStore.getState().redo(MODEL);
    assert.ok(view.getNewEntity(ref.expressId));
  } finally { review.dispose(); }
});

it('requires explicit pick intent, normalizes mm once and refuses outside or occupied native faces (#7286)', async t => {
  if (!ensureRoomWasm(t)) return;
  await seedReviewedRoom();
  assert.throws(() => parseRoomProposal(JSON.stringify(roomEnvelope({ action: 'pick' }))), /explicit/);
  await assert.rejects(prepare({ action: 'pick', point: [200,200] }), /No room at this point/);
  const mm = roomProposal({ action: 'pick', point: [22000,21000], weld: 50, height: 3000 }, { units: 'mm' });
  assert.equal(mm.command.weld, .05); assert.equal(mm.command.height, 3);
  const review = await prepareRoomReview(mm, new AbortController().signal);
  try { assert.equal(review.prepared.result.created.length, 1); review.commit(); } finally { review.dispose(); }
  await assert.rejects(prepare({ action: 'pick', point: [22,21] }), /already has an IfcSpace/);
  await assert.rejects(prepare(), /No unoccupied/, 'Auto never expands an already occupied population');
});

it('reads explicit current room roots, previews native supported update and preserves skipped/source peers (#7286)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { view } = await seedReviewedRoom();
  const first = await prepare();
  let id: number;
  try { id = first.commit().created[0].expressId; } finally { first.dispose(); }
  const before = structuredClone(view.getEffectiveChanges());
  const current = view.getNewEntity(id)!;
  const review = await prepare({ action: 'update', boundary: 'outer', rooms: [
    { GlobalId: current.attributes[0], Name: current.attributes[2] },
    { GlobalId: first.snapshot.rooms[0].GlobalId, Name: first.snapshot.rooms[0].Name },
  ] });
  try {
    assert.equal(review.prepared.result.updated.length, 1);
    assert.equal(review.prepared.result.skipped.length, 1, 'the unrelated source room has no face at the authored wall box');
    assert.deepEqual(view.getEffectiveChanges(), before);
    const row = roomChainInStore(review.prepared.preview.store, review.prepared.preview.editor, id);
    assert.ok(row.ok);
    assert.ok(row.chain.footprint.some(([x]) => x < 20));
    const { receipt } = commitReviewedRoom(review, 'native-update');
    assert.deepEqual(undoModelChanges(useViewerStore, receipt), { ok: true });
    assert.deepEqual(view.getEffectiveChanges(), before);
  } finally { review.dispose(); }
});

it('prepares one native concave footprint and preserves high-threshold overlap refusal (#7286)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { view } = await seedReviewedRoom([[20,20,0],[26,20,0],[26,22,0],[23,22,0],[23,25,0],[20,25,0]]);
  assert.equal(useViewerStore.getState().removeEntity(MODEL, 1494), true, 'remove the existing source room through the public native gate');
  const review = await prepare({ action: 'footprint' });
  try {
    assert.equal(review.prepared.result.created.length, 1);
    const native = roomChainInStore(review.prepared.preview.store, review.prepared.preview.editor, review.prepared.result.created[0].expressId);
    assert.ok(native.ok); assert.ok(native.chain.footprint.length > 4, 'the actual L is retained rather than its convex hull');
    review.commit();
  } finally { review.dispose(); }
  const before = structuredClone(view.getEffectiveChanges());
  await assert.rejects(prepare({ action: 'footprint', minArea: 1000000 }), /overlap/);
  assert.deepEqual(view.getEffectiveChanges(), before);
});

it('publishes complete native expected geometry and ignores JSON key order while refusing altered contours (#7286)', async t => {
  if (!ensureRoomWasm(t)) return;
  await seedReviewedRoom();
  const first = await prepare();
  const snapshot = structuredClone(first.snapshot);
  assert.ok(snapshot.rooms.every(room => room.outline === null || room.outline.length >= 3));
  first.dispose();
  const reordered = Object.fromEntries(Object.entries(snapshot).reverse());
  const same = await prepare(undefined, { expected: reordered });
  same.dispose();
  snapshot.candidates[0].centre[0][0] += .1;
  await assert.rejects(prepare(undefined, { expected: snapshot }), /snapshot differs/);
});

for (const reason of ['skip-history', 'source replacement', 'Undo head', 'cancel'] as const) it(`refuses ${reason} after preparation and preserves the current graph (#7286)`, async t => {
  if (!ensureRoomWasm(t)) return;
  const { view } = await seedReviewedRoom();
  const controller = new AbortController();
  const review = await prepareRoomReview(roomProposal(), controller.signal);
  try {
    if (reason === 'skip-history') {
      const journal = view.getMutationCount();
      view.setAttribute(42, 'Description', 'Current history-free change', undefined, true);
      assert.equal(view.getMutationCount(), journal);
    } else if (reason === 'source replacement') {
      const s = useViewerStore.getState(), model = s.models.get(MODEL)!;
      useViewerStore.setState({ models: new Map(s.models).set(MODEL, { ...model, ifcDataStore: { ...model.ifcDataStore!, source: model.ifcDataStore!.source.slice() } }) });
    } else if (reason === 'Undo head') useViewerStore.getState().undo(MODEL);
    else controller.abort();
    const before = structuredClone(view.getEffectiveChanges());
    assert.throws(() => review.commit(), /changed|abort/i);
    assert.deepEqual(view.getEffectiveChanges(), before);
  } finally { review.dispose(); }
});

it('previews and records a session-only native cut with truthful no-IFC receipt and native layout Undo (#7286)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { adapter, view } = await seedReviewedRoom();
  const before = new StepExporter(useViewerStore.getState().models.get(MODEL)!.ifcDataStore!, view).export({ schema: 'IFC4', applyMutations: true }).content;
  const review = await prepare({ action: 'edit', operation: { kind: 'split', a: [21,20], b: [21,23] }, tolerance: .01 });
  try {
    assert.equal(review.prepared.result.created.length, 0);
    assert.equal(review.prepared.layoutAfter?.length, 2);
    const { receipt } = commitReviewedRoom(review, 'session-layout');
    assert.equal(JSON.parse(String(receipt.applied[0].after)).sessionOnly, true);
    assert.equal(receipt.batches.length, 1);
    assert.equal((await adapter.roomCommand!(MODEL, 42, { action: 'query' })).candidates.length, 2);
    const after = new StepExporter(useViewerStore.getState().models.get(MODEL)!.ifcDataStore!, view).export({ schema: 'IFC4', applyMutations: true }).content;
    assert.deepEqual(after, before, 'the exact existing IFC export layout is unchanged by a session-only operation');
    assert.deepEqual(undoModelChanges(useViewerStore, receipt), { ok: true });
    assert.equal((await adapter.roomCommand!(MODEL, 42, { action: 'query' })).candidates.length, 1);
  } finally { review.dispose(); }
});

it('cuts and merges materialized rooms through the native larger-piece identity rule (#7286)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { view } = await seedReviewedRoom();
  const auto = await prepare();
  let source: number;
  try { source = auto.commit().created[0].expressId; } finally { auto.dispose(); }
  const cut = await prepare({ action: 'edit', operation: { kind: 'split', a: [21,20], b: [21,23] }, tolerance: .01 });
  try { assert.equal(cut.prepared.result.created.length, 1); assert.equal(cut.prepared.result.updated[0].expressId, source); cut.commit(); }
  finally { cut.dispose(); }
  const before = structuredClone(view.getEffectiveChanges());
  const merge = await prepare({ action: 'edit', operation: { kind: 'remove', at: [21,21] }, tolerance: .01 });
  try {
    assert.equal(merge.prepared.result.deleted.length, 1);
    assert.equal(merge.prepared.result.updated[0].expressId, source, 'the larger native room retains its root identity');
    assert.deepEqual(view.getEffectiveChanges(), before);
    const { receipt } = commitReviewedRoom(merge, 'native-merge');
    assert.deepEqual(undoModelChanges(useViewerStore, receipt), { ok: true });
    assert.deepEqual(view.getEffectiveChanges(), before);
  } finally { merge.dispose(); }
});
