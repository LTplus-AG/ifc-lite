/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { asSourceBytes } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { MODEL } from '@/test/native-sdk-model';
import { roomProposal, seedReviewedRoom } from '@/test/reviewed-room-fixture';
import { nativeRoomRemeshGate } from '@/test/room-remesh-gate';
import { clearModelLayouts } from '@/lib/rooms/room-layout';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { prepareRoomReview } from './room-review';

const initial = useViewerStore.getState();
afterEach(() => { clearModelLayouts(MODEL); setRemeshClientFactory(null); useViewerStore.setState(initial, true); });

for (const changed of ['source bytes', 'source fingerprint', 'history-free replay'] as const) it(`refuses ${changed} that changes during actual native Room remeshing (#7286)`, async t => {
  if (!ensureRoomWasm(t)) return;
  const { store, view } = await seedReviewedRoom();
  const proposal = roomProposal(), gate = nativeRoomRemeshGate();
  const pending = prepareRoomReview(proposal, new AbortController().signal);
  await gate.entered;
  if (changed === 'source bytes') {
    const original = store.source;
    store.source = asSourceBytes(original.slice(0, original.byteLength).slice());
    assert.equal(store.source.byteLength, original.byteLength);
    assert.notEqual(store.source, original, 'the source facade was actually replaced while content remains valid IFC');
    assert.deepEqual(store.source.slice(0, store.source.byteLength), original.slice(0, original.byteLength));
  }
  else if (changed === 'source fingerprint') {
    const state = useViewerStore.getState(), model = state.models.get(MODEL)!;
    useViewerStore.setState({ models: new Map(state.models).set(MODEL, { ...model, sourceContentHash: 'native-room-new-source-identity' }) });
  } else {
    const count = view.getMutationCount();
    view.setAttribute(42, 'Description', 'Changed during native preparation', undefined, true);
    assert.equal(view.getMutationCount(), count);
  }
  const before = structuredClone(view.getEffectiveChanges());
  gate.release();
  await assert.rejects(pending, /changed|stale|source/i);
  assert.deepEqual(view.getEffectiveChanges(), before);
});

it('reports real native remesh failure without creating an actionable approval (#7286)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { view } = await seedReviewedRoom();
  const gate = nativeRoomRemeshGate(true);
  const pending = prepareRoomReview(roomProposal(), new AbortController().signal);
  await gate.entered;
  const before = structuredClone(view.getEffectiveChanges());
  gate.release();
  await assert.rejects(pending, /failed/i);
  assert.deepEqual(view.getEffectiveChanges(), before);
});
