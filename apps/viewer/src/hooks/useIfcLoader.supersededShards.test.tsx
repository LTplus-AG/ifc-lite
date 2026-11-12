/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A superseded load leaves no instanced shards behind (#9628 review).
 *
 * Load A streams, then a second primary load B replaces it while A is still
 * between batches; A then produces one more shard batch. Only B's shard may
 * reach the renderer, and once both loads have finished nothing is left in the
 * queue holding A's buffers. Real loader, parser, engine and store; the two
 * geometry streams are explicit and the renderer records uploads. The drain's
 * maps come from the store, as the Viewport's do.
 */
import '@/test/setup-dom.js';
import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { GeometryProcessor, type MeshData, type CoordinateInfo, type StreamingGeometryEvent, type DecodedInstancedShard } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { hasPendingInstancedShards } from '@/store/instancedShardQueue';
import { useInstancedShardDrain } from '@/components/viewer/useInstancedShardDrain';
import { waitFor } from '@/test/render.js';
import { buildShardBytes } from '@/test/instanced-shard-fixture.js';
import { hook, skip, blankFile } from '@/test/blank-ifc-loader-harness.js';

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
const coordinateInfo: CoordinateInfo = { originalBounds: bounds, shiftedBounds: bounds, originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false };
const mesh = (): MeshData => ({ expressId: 31, positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), normals: new Float32Array(9), indices: Uint32Array.of(0, 1, 2), color: [0.6, 0.6, 0.6, 1] });
const task = () => new Promise((resolve) => setTimeout(resolve, 0));

it('a primary load superseded mid-stream delivers no shard and leaves the queue empty', { skip }, async () => {
  assert.ok(hook);
  const uploads: number[] = [];
  const renderer = {
    getGPUDevice: () => ({}), getPipeline: () => null, requestRender: () => {},
    getScene: () => ({
      addInstancedShard: (_device: unknown, shard: DecodedInstancedShard) => { for (const i of shard.instances) uploads.push(i.entityId); },
      getInstancedModelIndices: () => [],
    }),
  } as unknown as Renderer;
  function Viewport() {
    const models = useViewerStore((s) => s.models);
    useInstancedShardDrain({
      rendererRef: useRef(renderer), isInitialized: true, gpuRecoveryEpoch: 0, geometryKernel: 'exact', geometry: null,
      modelIdToIndex: modelIndices(models),
      modelIdToOffset: new Map([...models].map(([id, model]) => [id, model.idOffset ?? 0])),
      cameraFittedRef: useRef(false), cameraSnapshotRef: useRef(null),
      geometryBoundsRef: useRef({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }),
      finalBoundsRefittedRef: useRef(false), lastFitPolicyKindRef: useRef(null), lastGeometryRef: useRef(null),
    });
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<Viewport />));

  let releaseA!: () => void, aWaiting = false;
  const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
  let calls = 0;
  mock.method(GeometryProcessor.prototype, 'processAdaptive', async function* (): AsyncGenerator<StreamingGeometryEvent> {
    const first = calls++ === 0;
    yield { type: 'start', totalEstimate: 2 };
    if (first) {
      yield { type: 'batch', meshes: [mesh()], instancedShards: [buildShardBytes(501)], coordinateInfo, totalSoFar: 1 };
      aWaiting = true;
      await gateA;
      yield { type: 'batch', meshes: [mesh()], instancedShards: [buildShardBytes(502)], coordinateInfo, totalSoFar: 2 };
    } else {
      await task();
      yield { type: 'batch', meshes: [mesh()], instancedShards: [buildShardBytes(601)], coordinateInfo, totalSoFar: 1 };
    }
    yield { type: 'complete', coordinateInfo, totalMeshes: first ? 2 : 1 };
  });
  try {
    const loadA = hook.loadFile(blankFile('METRE'), { kind: 'primary', modelId: 'load-a' });
    await waitFor(() => aWaiting, 'load A is streaming and between batches');
    await act(async () => { await task(); });
    const loadB = hook.loadFile(blankFile('METRE'), { kind: 'primary', modelId: 'load-b' });
    await act(async () => { await loadB; });
    releaseA();
    await act(async () => { await loadA; });
    await act(async () => { await task(); await task(); });
  } finally {
    releaseA();
    await act(async () => root.unmount());
    container.remove();
  }
  assert.equal(useViewerStore.getState().models.get('load-b')?.loadState, 'complete');
  assert.ok(!uploads.includes(502), 'A\'s post-replacement shard never reaches the renderer');
  assert.ok(uploads.includes(601), 'B\'s shard uploads');
  assert.equal(hasPendingInstancedShards(), false, 'nothing of A\'s is left holding its buffers once both loads finished');
});
