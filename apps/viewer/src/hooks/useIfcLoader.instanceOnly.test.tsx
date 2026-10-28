/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { GeometryProcessor, type MeshData, type CoordinateInfo, type StreamingGeometryEvent } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { waitFor } from '@/test/render.js';
import { buildShardBytes } from '@/test/instanced-shard-fixture.js';
import { hook, skip, blankFile } from '@/test/blank-ifc-loader-harness.js';

// Loader scheduling invariant, not kernel parity: real parser/loader/store,
// with an explicit batch stream so the paused state can be observed mid-load.
const bounds = { min: { x: 10, y: 0, z: 0 }, max: { x: 11, y: 1, z: 1 } };
const coordinateInfo: CoordinateInfo = { originalBounds: bounds, shiftedBounds: bounds, originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false };
const mesh: MeshData = { expressId: 31, positions: Float32Array.of(10,0,0,11,0,0,10,1,0), normals: new Float32Array(9), indices: Uint32Array.of(0,1,2), color: [0.6,0.6,0.6,1] };
for (const flat of [false, true]) {
  it(`#7955 ${flat ? 'mixed flat/shard keeps one ordered flat append' : 'shard-only batch publishes bounds before completion'}`, { skip }, async () => {
    assert.ok(hook);
    let release!: () => void, delivered = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    mock.method(GeometryProcessor.prototype, 'processAdaptive', async function* (): AsyncGenerator<StreamingGeometryEvent> {
      yield { type: 'start', totalEstimate: 1 };
      yield { type: 'batch', meshes: flat ? [mesh] : [], instancedShards: [buildShardBytes(31)], coordinateInfo, totalSoFar: 1 };
      delivered = true;await held;
      yield { type: 'complete', coordinateInfo, totalMeshes: 1 };
    });
    const state = useViewerStore.getState(), calls: string[] = [];
    const append = state.appendGeometryBatch, shards = state.appendInstancedShards;
    mock.method(state, 'appendGeometryBatch', (...args: Parameters<typeof append>) => { calls.push(`append:${args[1].length}`);return append(...args); });
    mock.method(state, 'appendInstancedShards', (...args: Parameters<typeof shards>) => { calls.push('shards');return shards(...args); });
    const id = crypto.randomUUID(), pending = hook.loadFile(blankFile('METRE'), { kind: 'primary', modelId: id });
    try {
      await waitFor(() => delivered, 'loader consumed the batch and is waiting for completion');
      const result = useViewerStore.getState().models.get(id)?.geometryResult;
      assert.deepEqual(calls, ['shards', `append:${flat ? 1 : 0}`], 'same order and exactly one append for flat batches');
      assert.deepEqual(result?.coordinateInfo.shiftedBounds, bounds);
      assert.equal(result?.meshes.length, flat ? 1 : 0);
      assert.equal(useViewerStore.getState().geometryStreamingActive, true);
    } finally { release();await act(async () => pending); }
    assert.equal(useViewerStore.getState().models.get(id)?.loadState, 'complete');
  });
}
