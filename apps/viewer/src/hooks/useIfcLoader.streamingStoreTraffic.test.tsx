/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Streamed geometry must not drive React per batch (NEW-1, load-time hillclimb).
 *
 * A Holter cold load made 462 store updates, 264 of them the instanced-shard
 * hop: `appendInstancedShards` per batch, then the drain effect's
 * `clearInstancedShards`. Every one ran the whole subscriber fan-out and
 * re-rendered the Viewport, which selected the field. Shards now reach the
 * renderer through a queue outside the store, so the number of store
 * notifications while geometry streams no longer grows with the batch count.
 *
 * Real loader, store, parser and engine (`blank-ifc-loader-harness`); only the
 * geometry event stream is explicit, and the renderer is a recording fake. The
 * consumer is the Viewport's own wiring: `useColorUpdateState()` spread into
 * `useGeometryStreaming`.
 */
import '@/test/setup-dom.js';
import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { GeometryProcessor, type MeshData, type CoordinateInfo, type StreamingGeometryEvent, type DecodedInstancedShard } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { useColorUpdateState } from '@/hooks/useViewerSelectors';
import { useGeometryStreaming } from '@/components/viewer/useGeometryStreaming';
import { waitFor } from '@/test/render.js';
import { buildShardBytes } from '@/test/instanced-shard-fixture.js';
import { hook, skip, blankFile } from '@/test/blank-ifc-loader-harness.js';

const BATCHES = 48;
const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
const coordinateInfo: CoordinateInfo = { originalBounds: bounds, shiftedBounds: bounds, originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false };
const mesh = (): MeshData => ({ expressId: 31, positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), normals: new Float32Array(9), indices: Uint32Array.of(0, 1, 2), color: [0.6, 0.6, 0.6, 1] });

it('NEW-1: store notifications and consumer renders while streaming do not scale with batches; every shard still uploads', { skip }, async () => {
  assert.ok(hook);
  const uploads: number[] = [];
  const scene = {
    addInstancedShard: (_device: unknown, shard: DecodedInstancedShard) => { uploads.push(shard.instances.length); },
    getInstancedModelIndices: () => [0],
  };
  const renderer = { getGPUDevice: () => ({}), getPipeline: () => null, getScene: () => scene, requestRender: () => {} } as unknown as Renderer;

  let renders = 0;
  function ViewportWiring() {
    renders++;
    const rendererRef = useRef<Renderer | null>(renderer);
    useGeometryStreaming({
      ...useColorUpdateState(),
      rendererRef, isInitialized: true, geometry: null, isStreaming: false,
      geometryBoundsRef: useRef({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }),
      clearColorRef: useRef<[number, number, number, number]>([1, 1, 1, 1]),
    });
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<ViewportWiring />));

  let streaming = false;
  mock.method(GeometryProcessor.prototype, 'processAdaptive', async function* (): AsyncGenerator<StreamingGeometryEvent> {
    yield { type: 'start', totalEstimate: BATCHES };
    streaming = true;
    for (let i = 0; i < BATCHES; i++) {
      yield { type: 'batch', meshes: [mesh()], instancedShards: [buildShardBytes(31)], coordinateInfo, totalSoFar: i + 1 };
    }
    streaming = false;
    yield { type: 'complete', coordinateInfo, totalMeshes: BATCHES };
  });

  let streamingNotifications = 0, rendersAtStart = 0, rendersAtEnd = 0;
  const unsubscribe = useViewerStore.subscribe(() => {
    if (!streaming) return;
    streamingNotifications++;
  });
  const id = crypto.randomUUID();
  try {
    rendersAtStart = renders;
    await act(async () => { await hook!.loadFile(blankFile('METRE'), { kind: 'primary', modelId: id }); });
    rendersAtEnd = renders;
    await waitFor(() => uploads.length === BATCHES, `all ${BATCHES} shards uploaded (got ${uploads.length})`);
  } finally {
    unsubscribe();
    await act(async () => root.unmount());
    container.remove();
  }
  assert.equal(useViewerStore.getState().models.get(id)?.loadState, 'complete');
  assert.equal(uploads.length, BATCHES, 'every streamed shard reaches the renderer exactly once');
  // Before the queue: 99 notifications and 99 renders for 48 batches (the
  // shard hop's append + clear per batch, plus 3). Now only the time-throttled
  // geometry/progress publishes remain (2 here; more on a slow runner, never
  // per batch), and the wiring renders only for the load's own resets.
  assert.ok(streamingNotifications <= 12, `store notified ${streamingNotifications} times while ${BATCHES} batches streamed`);
  assert.ok(rendersAtEnd - rendersAtStart <= 6, `Viewport wiring rendered ${rendersAtEnd - rendersAtStart} times during the load`);
});
