/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { MODEL, seedNativeSdkModel, settle } from '@/test/native-sdk-model';
import { cleanup, click, render, waitFor } from '@/test/render';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { clearModelLayouts } from '@/lib/rooms/room-layout';
import { captureEvidence } from '@/lib/assistant/evidence';
import { cancelAssistant, replaceEvidence, useAssistant } from '@/lib/assistant/conversation';
import { sendAssistant } from '@/lib/assistant/request';
import { nativeRootName } from '@/lib/actions/native-edit-evidence';
import { readOnlyModelEditTarget } from '@/lib/actions/model-authoring-read-target';
import type { RoomReview } from '@/lib/actions/room-review';
import { ModelChangeProposal } from './ModelChangeProposal';
import { attachmentsForSend } from './ComposerAttachments';

// Endpoint witness uses existing public endpoints; full production reversion must reach assertions.
const initial = useViewerStore.getState(), initialAssistant = useAssistant.getState();
const originalFetch = globalThis.fetch;
afterEach(() => { cancelAssistant(); cleanup(); clearModelLayouts(MODEL); setRemeshClientFactory(null);
  globalThis.fetch = originalFetch; useViewerStore.setState(initial, true); useAssistant.setState(initialAssistant, true); });

async function prepared() {
  const f = await seedNativeSdkModel();
  const points: [number,number,number][] = [[20,20,0],[24,20,0],[24,23,0],[20,23,0]];
  for (const [i, Start] of points.entries()) f.adapter.addWall(MODEL, 42, { Start, End: points[(i + 1) % points.length], Thickness: .2, Height: 3 });
  await settle();
  const query = await f.adapter.roomCommand!(MODEL, 42, { action: 'query' });
  assert.equal(query.candidates.length, 1, 'actual native WASM candidates exist before assistant admission');
  const reader = readOnlyModelEditTarget(useViewerStore.getState(), MODEL)!;
  const content = JSON.stringify({ version: 1, kind: 'room.command', title: 'Review native rooms', modelId: MODEL,
    storey: { GlobalId: f.store.entities.getGlobalId(42), Name: nativeRootName(reader, 42) }, units: 'm', frame: 'storey-local',
    command: { action: 'auto', weld: .05, minArea: .3, boundary: 'inner', height: 3, z: 0, namePattern: 'Attached {n}' } });
  act(() => useAssistant.setState({ messages: [{ role: 'user', content: 'Prepare current native rooms for review' }, { role: 'assistant', content }] }));
  let attached: RoomReview | null = null;
  const ui = render(<ModelChangeProposal onAttachRoom={review => { attached = review; }} />);
  assert.ok(ui.querySelector('section[aria-label="Review rooms"]'), 'the completed Room answer is natively reviewable');
  const button = (label: string) => [...ui.querySelectorAll('button')].find(row => row.textContent === label)!;
  click(button('Prepare room preview'));
  await waitFor(() => !!ui.querySelector('input[type="checkbox"]'), 'native preparation');
  click(button('Attach this room snapshot to the next message'));
  assert.ok(attached, 'only the explicit native Attach control grants an evidence snapshot');
  // Load the new evidence helper only after the endpoint's admission assertion.
  const { captureRoomGrounding } = await import('@/lib/actions/room-review');
  const rooms = captureRoomGrounding(attached);
  return { ...f, rooms };
}
function intercept() {
  const seen = { calls: 0, body: '' };
  globalThis.fetch = async (_url, init) => {
    seen.calls++; seen.body = String(init?.body);
    return new Response('data: {"choices":[{"delta":{"content":"Review"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  };
  return seen;
}

it('transports an explicitly prepared complete native Room snapshot; a plain send collects no Room evidence (#7286)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { rooms, view } = await prepared();
  const before = structuredClone(view.getEffectiveChanges());
  replaceEvidence(captureEvidence('loadReport'));
  const plain = intercept();
  assert.equal(await sendAssistant('Explain current loading', 'openai/gpt-free', '/api/chat'), true);
  assert.equal(plain.calls, 1);
  assert.ok(!plain.body.includes('Explicitly attached complete native Room snapshot'));
  replaceEvidence(captureEvidence('loadReport'));
  const seen = intercept();
  assert.equal(await sendAssistant('Review these complete room candidates', 'openai/gpt-free', '/api/chat', attachmentsForSend({ selection: null, screenshot: null, rooms })), true);
  assert.equal(seen.calls, 1);
  const body = JSON.parse(seen.body);
  const user = body.messages.find((message: { role: string }) => message.role === 'user').content;
  assert.ok(user.includes('Explicitly attached complete native Room snapshot'));
  const transported = JSON.parse(user.slice(user.indexOf('\n{') + 1));
  assert.equal(transported.candidateCount, 1);
  assert.equal(transported.roomCount, 1);
  assert.equal(transported.units, 'm');
  assert.deepEqual(transported.candidates[0].inner, rooms.snapshot.candidates[0].inner);
  assert.equal(transported.candidates[0].taken, false);
  assert.equal(transported.rooms[0].Name, 'My Space');
  assert.ok(!('prepared' in transported) && !('commit' in transported) && !('source' in transported), 'provider receives evidence only');
  assert.deepEqual(view.getEffectiveChanges(), before, 'neither attaching nor either request executes a Room action');
});

for (const change of ['history-free overlay', 'layout owner', 'forged sidecar'] as const) it(`refuses ${change} evidence after explicit Room Attach without any network request (#7286)`, async t => {
  if (!ensureRoomWasm(t)) return;
  const { rooms, view } = await prepared();
  if (change === 'history-free overlay') {
    const count = view.getMutationCount();
    act(() => view.setAttribute(42, 'Description', 'New history-free current source', undefined, true));
    assert.equal(view.getMutationCount(), count);
  } else if (change === 'layout owner') clearModelLayouts(MODEL);
  replaceEvidence(captureEvidence('loadReport'));
  const seen = intercept();
  const sidecar = change === 'forged sidecar' ? { snapshot: structuredClone(rooms.snapshot) } : rooms;
  const attachment = attachmentsForSend({ selection: null, screenshot: null, rooms: sidecar });
  assert.equal(await sendAssistant('Review attached room geometry', 'openai/gpt-free', '/api/chat', attachment), false);
  assert.equal(seen.calls, 0);
  assert.equal(useAssistant.getState().error, 'stale-evidence');
});
