/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { cleanup, click, render, waitFor } from '@/test/render';
import { IfcParser } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { MODEL, seedNativeSdkModel, settle } from '@/test/native-sdk-model';
import { useAssistant } from '@/lib/assistant/conversation';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { clearModelLayouts } from '@/lib/rooms/room-layout';
import { ModelChangeProposal } from './ModelChangeProposal';
import { nativeRootName } from '@/lib/actions/native-edit-evidence';
import { readOnlyModelEditTarget } from '@/lib/actions/model-authoring-read-target';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup(); setRemeshClientFactory(null); clearModelLayouts(MODEL);
  useViewerStore.setState(initial, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], status: 'idle', error: null });
});

// #7286: actual native candidates are usable, but the completed answer must offer an inert review.
it('admits a wall-derived native Room action without applying it on receipt (#7286)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { adapter, view, store } = await seedNativeSdkModel();
  const points: [number, number, number][] = [[20,20,0],[24,20,0],[24,23,0],[20,23,0]];
  for (const [i, Start] of points.entries()) adapter.addWall(MODEL, 42, { Start, End: points[(i + 1) % points.length], Thickness: .2, Height: 3 });
  await settle();
  const native = await adapter.roomCommand!(MODEL, 42, { action: 'query', weld: .05, minArea: .3 });
  assert.equal(native.candidates.filter(face => face.centre.some(([x]) => x > 19 && x < 25)).length, 1, 'actual WASM Room service derives the closed authored wall population');
  const changes = structuredClone(view.getEffectiveChanges());
  const reader = readOnlyModelEditTarget(useViewerStore.getState(), MODEL);
  assert.ok(reader);
  const content = JSON.stringify({ version: 1, kind: 'room.command', title: 'Rooms from current walls', modelId: MODEL,
    storey: { GlobalId: store.entities.getGlobalId(42), Name: nativeRootName(reader, 42) }, units: 'm', frame: 'storey-local',
    command: { action: 'auto', weld: .05, minArea: .3, boundary: 'inner', height: 3, z: 0, namePattern: 'Room {n}' } });
  act(() => useAssistant.setState({ messages: [{ role: 'user', content: 'Prepare rooms from these walls; show all rooms before applying' }, { role: 'assistant', content }] }));
  const ui = render(<ModelChangeProposal />);
  assert.deepEqual(view.getEffectiveChanges(), changes, 'a completed proposal is inert');
  assert.ok(ui.querySelector('section[aria-label="Review rooms"]'), 'the actual completed native Room answer has an explicit review route');
  assert.equal(ui.querySelector('output'), null, 'receipt offers no automatic native collection or inferred preview');
  const button = (label: string) => [...ui.querySelectorAll('button')].find(row => row.textContent === label)!;
  click(button('Prepare room preview'));
  await waitFor(() => !!ui.querySelector('input[type="checkbox"]'), 'explicit native Room preparation completes');
  assert.deepEqual(view.getEffectiveChanges(), changes, 'local native preparation publishes no graph');
  assert.equal(store.entities.getTypeName(1494), 'IfcSpace', 'the actual Bonsai source already contains its separate room');
  assert.ok((ui.textContent ?? '').includes('1 native candidates · 1 existing rooms'), ui.textContent ?? '');
  assert.ok(ui.querySelector('svg[aria-label="Prepared native room outlines in storey-local metres"]'), 'native writer polygons are visible before approval');
  assert.ok((ui.textContent ?? '').includes('extrusion height 3 m'), ui.textContent ?? '');
  click(ui.querySelector('input[type="checkbox"]')!);
  assert.equal(button('Apply Room action').disabled, true, 'declining the complete action disables Apply');
  click(ui.querySelector('input[type="checkbox"]')!);
  click(button('Apply Room action'));
  await waitFor(() => (ui.textContent ?? '').includes('Applied through native Room: created 1'), 'actual native receipt');
  const spaces = view.getNewEntities().filter(row => row.type === 'IfcSpace');
  assert.equal(spaces.length, 1);
  const bytes = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
  const parsed = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  assert.equal(parsed.entities.getTypeName(spaces[0].expressId), 'IfcSpace');
  click(button('Undo this Room action'));
  await waitFor(() => (ui.textContent ?? '').includes('The native Room action was undone.'), 'native receipt Undo');
  assert.deepEqual(view.getEffectiveChanges(), changes, 'native Undo returns to the approved source population');
});
