/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { contiguousSourceBytes } from '@ifc-lite/parser';
import type { RtcFrame } from '@ifc-lite/geometry';
import { fixtureDataStore, fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { __setOverlayWorkerFactoryForTest } from '@/lib/overlay-parse';
import { useAlignmentLines3D } from './useAlignmentLines3D.js';

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

function result(frame: RtcFrame) {
  const zero = { x: 0, y: 0, z: 0 };
  return {
    meshes: [],
    totalVertices: 0,
    totalTriangles: 0,
    coordinateInfo: {
      originShift: zero,
      originalBounds: { min: zero, max: zero },
      shiftedBounds: { min: zero, max: zero },
      hasLargeCoordinates: false,
      wasmRtcFrame: frame,
    },
  };
}

it('keeps a late frame-A alignment reply from replacing the observable frame-B result (#4799)', async () => {
  const frameA: RtcFrame = { x: 10, y: 20, z: 30, needsShift: true };
  const frameB: RtcFrame = { x: 40, y: 50, z: 60, needsShift: false };
  const store = fixtureDataStore([{ expressId: 1, type: 'IfcAlignment' }]);
  store.source = contiguousSourceBytes(new TextEncoder().encode(`alignment rtc race #4799 ${Date.now()}`));

  interface Request { id: number; frame?: RtcFrame }
  const requests: Request[] = [];
  const worker = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(request: Request) { requests.push(request); },
    terminate() {},
  };
  const previous = __setOverlayWorkerFactoryForTest(() => worker as unknown as Worker);
  const model = {
    ...fixtureModel('alignment-race'),
    ifcDataStore: store,
    geometryResult: result(frameA),
    loadState: 'complete' as const,
  };
  useViewerStore.setState({
    ...fixtureModels(model),
    ifcDataStore: store,
    geometryResult: model.geometryResult,
    modelPlacement: emptyPlacementState(),
  } as never);

  function Probe() {
    return <output>{JSON.stringify(Array.from(useAlignmentLines3D()))}</output>;
  }

  try {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<Probe />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].frame, frameA);

    await act(async () => {
      const current = useViewerStore.getState().models.get(model.id)!;
      const geometryResult = result(frameB);
      useViewerStore.setState({
        models: new Map([[model.id, { ...current, geometryResult }]]),
        geometryResult,
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(requests.length, 2, 'frame publication must start a distinct keyed parse');
    assert.deepEqual(requests[1].frame, frameB);

    const vertsB = new Float32Array([40, 41, 42, 43, 44, 45]);
    await act(async () => {
      worker.onmessage?.({ data: { id: requests[1].id, ok: true, verts: vertsB } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(JSON.parse(container.textContent ?? '[]'), [...vertsB]);

    const lateA = new Float32Array([10, 11, 12, 13, 14, 15]);
    await act(async () => {
      worker.onmessage?.({ data: { id: requests[0].id, ok: true, verts: lateA } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(
      JSON.parse(container.textContent ?? '[]'),
      [...vertsB],
      'a late old-frame completion may populate its old key but must not become observable',
    );
  } finally {
    __setOverlayWorkerFactoryForTest(previous);
  }
});
