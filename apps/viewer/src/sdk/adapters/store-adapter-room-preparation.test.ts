/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { useViewerStore } from '@/store';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { MODEL, seedNativeSdkModel, settle } from '@/test/native-sdk-model';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { clearModelLayouts } from '@/lib/rooms/room-layout';
import { prepareNativeRoomCommand } from './store-adapter-room';

const initial = useViewerStore.getState();
afterEach(() => { setRemeshClientFactory(null); clearModelLayouts(MODEL); useViewerStore.setState(initial, true); });
const command = { action: 'auto', weld: .05, minArea: .3, boundary: 'inner', height: 3, z: 0, namePattern: 'Prepared {n}' } as const;
async function seed() {
  const f = await seedNativeSdkModel();
  const points: [number, number, number][] = [[20,20,0],[24,20,0],[24,23,0],[20,23,0]];
  for (const [i, Start] of points.entries()) f.adapter.addWall(MODEL, 42, { Start, End: points[(i + 1) % points.length], Thickness: .2, Height: 3 });
  await settle();
  return f;
}
const depth = () => useViewerStore.getState().undoStacks.get(MODEL)?.length ?? 0;

it('prepares actual native spaces without graph/history edits, then commits and exports one Undo group (#7286)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { store, view } = await seed();
  const before = structuredClone(view.getEffectiveChanges()), undo = depth();
  const prepared = await prepareNativeRoomCommand(useViewerStore, MODEL, 42, command);
  try {
    assert.deepEqual(view.getEffectiveChanges(), before);
    assert.equal(depth(), undo);
    assert.ok(prepared.result.created.length > 0);
    assert.ok(prepared.preview.mutationView.getNewEntities().some(row => row.type === 'IfcSpace'));
    const result = prepared.commit();
    assert.deepEqual(result.created, prepared.result.created);
    const bytes = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
    const parsed = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
    const extractor = new EntityExtractor(parsed.source);
    for (const ref of result.created) {
      assert.equal(parsed.entities.getTypeName(ref.expressId), 'IfcSpace');
      const location = parsed.entityIndex.byId.get(ref.expressId);
      assert.ok(location);
      assert.ok(String(extractor.extractEntity({ ...location, expressId: ref.expressId, lineNumber: 0 })?.attributes[2]).startsWith('Prepared '));
    }
    useViewerStore.getState().undo(MODEL);
    assert.deepEqual(view.getEffectiveChanges(), before);
    useViewerStore.getState().redo(MODEL);
    assert.ok(result.created.every(ref => view.getNewEntities().some(row => row.expressId === ref.expressId)));
    assert.throws(() => prepared.commit(), /no longer available/);
  } finally { prepared.dispose(); }
});

it('refuses approval after actual skip-history replay and preserves that newer edit (#7286)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { view } = await seed();
  const prepared = await prepareNativeRoomCommand(useViewerStore, MODEL, 42, command);
  try {
    const count = view.getMutationCount();
    view.setAttribute(42, 'Description', 'Changed after Room preparation', undefined, true);
    assert.equal(view.getMutationCount(), count, 'the actual replay is history-free');
    const newer = structuredClone(view.getEffectiveChanges()), undo = depth();
    assert.throws(() => prepared.commit(), /model changed|overlay changed/);
    assert.deepEqual(view.getEffectiveChanges(), newer);
    assert.equal(depth(), undo);
  } finally { prepared.dispose(); }
});

it('a newer native preparation supersedes an older approval and cancellation discards its draft (#7286)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { view } = await seed();
  const before = structuredClone(view.getEffectiveChanges()), undo = depth();
  const first = await prepareNativeRoomCommand(useViewerStore, MODEL, 42, command);
  const controller = new AbortController();
  const next = await prepareNativeRoomCommand(useViewerStore, MODEL, 42, { ...command, signal: controller.signal });
  try {
    assert.throws(() => first.commit(), /model changed/);
    controller.abort();
    assert.throws(() => next.commit(), /abort/i);
    assert.deepEqual(view.getEffectiveChanges(), before);
    assert.equal(depth(), undo);
  } finally { first.dispose(); next.dispose(); }
});

it('previews a native Room cut inertly and disposal preserves its current layout and IFC roots (#7286)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { adapter, view } = await seed();
  const room = await adapter.roomCommand!(MODEL, 42, command);
  assert.equal(room.created.length, 1);
  const before = structuredClone(view.getEffectiveChanges()), undo = depth();
  const cut = { action: 'edit', weld: .05, operation: { kind: 'split', a: [21,20], b: [21,23] }, tolerance: .01 } as const;
  const prepared = await prepareNativeRoomCommand(useViewerStore, MODEL, 42, cut);
  assert.equal(prepared.result.created.length, 1);
  assert.equal(prepared.result.updated.length, 1);
  assert.deepEqual(view.getEffectiveChanges(), before);
  assert.equal(depth(), undo);
  prepared.dispose();
  assert.throws(() => prepared.commit(), /no longer available/);
  const query = await adapter.roomCommand!(MODEL, 42, { action: 'query' });
  assert.equal(query.candidates.length, 1, 'an abandoned duplicate plate never replaces the native layout');
  assert.deepEqual(view.getEffectiveChanges(), before);
  const approved = await prepareNativeRoomCommand(useViewerStore, MODEL, 42, cut);
  try {
    const result = approved.commit();
    assert.equal(result.created.length, 1);
    assert.equal((await adapter.roomCommand!(MODEL, 42, { action: 'query' })).candidates.length, 2);
    useViewerStore.getState().undo(MODEL);
    assert.equal((await adapter.roomCommand!(MODEL, 42, { action: 'query' })).candidates.length, 1);
    assert.deepEqual(view.getEffectiveChanges(), before);
  } finally { approved.dispose(); }
});

it('clearing the native layout owner refuses a pending cut before any graph write (#7286)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { adapter, view } = await seed();
  await adapter.roomCommand!(MODEL, 42, command);
  const prepared = await prepareNativeRoomCommand(useViewerStore, MODEL, 42, { action: 'edit', operation: { kind: 'split', a: [21,20], b: [21,23] } });
  const before = structuredClone(view.getEffectiveChanges()), undo = depth();
  try {
    clearModelLayouts(MODEL);
    assert.throws(() => prepared.commit(), /layout changed/);
    assert.deepEqual(view.getEffectiveChanges(), before);
    assert.equal(depth(), undo);
  } finally { prepared.dispose(); }
});

it('exposes detached post-cut contours for a session-only layout before approval (#7286)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { adapter, view } = await seed();
  const native = await adapter.roomCommand!(MODEL, 42, { action: 'query', weld: .05 });
  assert.equal(native.candidates.length, 1);
  const before = structuredClone(view.getEffectiveChanges());
  const prepared = await prepareNativeRoomCommand(useViewerStore, MODEL, 42, {
    action: 'edit', weld: .05, operation: { kind: 'split', a: [21,20], b: [21,23] }, tolerance: .01,
  });
  try {
    assert.equal(prepared.result.created.length, 0, 'the edit has no materialized IFC rooms');
    assert.equal(prepared.result.candidates.length, 1, 'the legacy native result preserves its before population');
    assert.deepEqual(view.getEffectiveChanges(), before, 'native cut preparation remains inert');
    assert.equal(prepared.layoutAfter?.length, 2, 'the review must show both detached post-cut contours');
    assert.ok(prepared.layoutAfter!.every(face => face.centre.length >= 3));
    prepared.commit();
    const current = await adapter.roomCommand!(MODEL, 42, { action: 'query', weld: .05 });
    assert.deepEqual(current.candidates.map(face => face.centre), prepared.layoutAfter!.map(face => face.centre));
    useViewerStore.getState().undo(MODEL);
    assert.equal((await adapter.roomCommand!(MODEL, 42, { action: 'query', weld: .05 })).candidates.length, 1);
    assert.deepEqual(view.getEffectiveChanges(), before);
  } finally { prepared.dispose(); }
});
