/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { contiguousSourceBytes } from '@ifc-lite/parser';
import { render, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels, fixtureDataStore } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { __setOverlayWorkerFactoryForTest } from '@/lib/overlay-parse';
import { useAlignmentLines3D } from './useAlignmentLines3D';

it('moves each alignment instance without mutating the shared parsed centerline (#4226)', async () => {
  const vertices = new Float32Array([1, 2, 3, 4, 5, 6]); let parses = 0;
  const worker = { onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(request: { id: number }) { parses++; queueMicrotask(() => worker.onmessage?.({ data: { id: request.id, ok: true, verts: vertices } })); }, terminate() {} };
  const previous = __setOverlayWorkerFactoryForTest(() => worker as unknown as Worker);
  const store = fixtureDataStore([{ expressId: 1, type: 'IfcAlignment' }]);
  store.source = contiguousSourceBytes(new TextEncoder().encode('alignment placement fixture #4226'));
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('a'), ifcDataStore: store }, { ...fixtureModel('b'), ifcDataStore: store }), modelPlacement: emptyPlacementState() });
  function Lines() { return <output>{JSON.stringify(Array.from(useAlignmentLines3D()))}</output>; }
  try {
    const ui = render(<Lines />); await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(JSON.parse(ui.textContent!), [...vertices, ...vertices]);
    act(() => { const s = useViewerStore.getState(); s.openReposition(['b']); s.previewModelTranslation([10, 20, 30]); });
    assert.deepEqual(JSON.parse(ui.textContent!), [1, 2, 3, 4, 5, 6, 11, 32, -17, 14, 35, -14]);
    act(() => useViewerStore.getState().closeReposition());
    assert.deepEqual(JSON.parse(ui.textContent!), [...vertices, ...vertices]);
    assert.deepEqual(Array.from(vertices), [1, 2, 3, 4, 5, 6]); assert.equal(parses, 1);
  } finally { cleanup(); __setOverlayWorkerFactoryForTest(previous); }
});
