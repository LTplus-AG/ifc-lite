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
import { nativeRoomRemeshGate } from '@/test/room-remesh-gate';
import { cleanup, click, render, waitFor } from '@/test/render';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { clearModelLayouts } from '@/lib/rooms/room-layout';
import { useAssistant } from '@/lib/assistant/conversation';
import { nativeRootName } from '@/lib/actions/native-edit-evidence';
import { readOnlyModelEditTarget } from '@/lib/actions/model-authoring-read-target';
import { ModelChangeProposal } from './ModelChangeProposal';

const initial = useViewerStore.getState(), assistantInitial = useAssistant.getState();
afterEach(() => { cleanup(); clearModelLayouts(MODEL); setRemeshClientFactory(null);
  useViewerStore.setState(initial, true); useAssistant.setState(assistantInitial, true); });
const button = (ui: HTMLElement, label: string) => [...ui.querySelectorAll('button')].find(row => row.textContent === label)!;
async function card() {
  const f = await seedNativeSdkModel();
  const points: [number,number,number][] = [[20,20,0],[24,20,0],[24,23,0],[20,23,0]];
  for (const [i, Start] of points.entries()) f.adapter.addWall(MODEL, 42, { Start, End: points[(i + 1) % points.length], Thickness: .2, Height: 3 });
  await settle();
  assert.equal((await f.adapter.roomCommand!(MODEL, 42, { action: 'query' })).candidates.length, 1);
  const reader = readOnlyModelEditTarget(useViewerStore.getState(), MODEL)!;
  const content = JSON.stringify({ version: 1, kind: 'room.command', title: 'Review current rooms', modelId: MODEL,
    storey: { GlobalId: f.store.entities.getGlobalId(42), Name: nativeRootName(reader, 42) }, units: 'm', frame: 'storey-local',
    command: { action: 'auto', weld: .05, minArea: .3, boundary: 'inner', height: 3, z: 0, namePattern: 'Owned {n}' } });
  act(() => useAssistant.setState({ messages: [{ role: 'user', content: 'Prepare native rooms for review' }, { role: 'assistant', content }], status: 'idle' }));
  const ui = render(<ModelChangeProposal />);
  assert.ok(ui.querySelector('section[aria-label="Review rooms"]'), 'completed native Room answer owns a review');
  return { ...f, ui };
}

for (const finish of ['cancel', 'unmount', 'replace answer'] as const) it(`native Room ${finish} prevents late approval/IFC writes while actual remeshing finishes (#7286)`, async t => {
  if (!ensureRoomWasm(t)) return;
  const { view, ui } = await card();
  const before = structuredClone(view.getEffectiveChanges()), history = [...(useViewerStore.getState().undoStacks.get(MODEL) ?? [])];
  const gate = nativeRoomRemeshGate();
  click(button(ui, 'Prepare room preview'));
  await gate.entered;
  if (finish === 'cancel') click(button(ui, 'Cancel preparation'));
  else if (finish === 'unmount') cleanup();
  else act(() => useAssistant.setState({ messages: [{ role: 'assistant', content: 'A different completed answer' }], status: 'idle' }));
  await act(async () => { gate.release(); await gate.completed; });
  await act(async () => { await settle(); });
  assert.deepEqual(view.getEffectiveChanges(), before);
  assert.deepEqual(useViewerStore.getState().undoStacks.get(MODEL), history);
  assert.equal(ui.querySelector('input[type="checkbox"]'), null, 'late geometry cannot install an approval in the cancelled/replaced host');
});

it('a second Room card reports actual native busy ownership instead of stealing pending approval (#7286)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { view, ui } = await card();
  const before = structuredClone(view.getEffectiveChanges()), gate = nativeRoomRemeshGate();
  click(button(ui, 'Prepare room preview'));
  await gate.entered;
  const other = render(<ModelChangeProposal />);
  click(button(other, 'Prepare room preview'));
  await waitFor(() => !!other.querySelector('[role="alert"]'), 'native busy refusal');
  assert.ok(/preparing|preparation|busy/i.test(other.textContent ?? ''), other.textContent ?? '');
  assert.equal(other.querySelector('input[type="checkbox"]'), null);
  await act(async () => { gate.release(); await gate.completed; });
  await waitFor(() => !!ui.querySelector('input[type="checkbox"]'), 'original current host receives its preparation');
  assert.deepEqual(view.getEffectiveChanges(), before);
});

it('native remesh failure is visible and never installs an approval checkbox (#7286)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { view, ui } = await card();
  const before = structuredClone(view.getEffectiveChanges()), gate = nativeRoomRemeshGate(true);
  click(button(ui, 'Prepare room preview'));
  await gate.entered;
  await act(async () => { gate.release(); await gate.completed; });
  await waitFor(() => !!ui.querySelector('[role="alert"]'), 'native geometry failure');
  assert.ok(/failed/i.test(ui.textContent ?? ''), ui.textContent ?? '');
  assert.equal(ui.querySelector('input[type="checkbox"]'), null);
  assert.deepEqual(view.getEffectiveChanges(), before);
});

it('Apply rechecks a history-free replay even without a viewer-store notification (#7286)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { view, ui } = await card();
  click(button(ui, 'Prepare room preview'));
  await waitFor(() => !!ui.querySelector('input[type="checkbox"]'), 'native prepared approval');
  const count = view.getMutationCount();
  view.setAttribute(42, 'Description', 'Current replay after visible approval', undefined, true);
  assert.equal(view.getMutationCount(), count);
  const current = structuredClone(view.getEffectiveChanges());
  click(button(ui, 'Apply Room action'));
  await waitFor(() => !!ui.querySelector('[role="alert"]'), 'native pre-write refusal');
  assert.ok((ui.textContent ?? '').includes('Prepare the Room preview again'));
  assert.equal(button(ui, 'Apply Room action').disabled, true);
  assert.deepEqual(view.getEffectiveChanges(), current, 'newer replay survives the refused old approval');
});
