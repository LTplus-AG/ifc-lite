/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { GeometryProcessor, type MeshData, type CoordinateInfo, type StreamingGeometryEvent } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { loadTracer } from '@/lib/perf/loadTrace';
import { advance, waitFor } from '@/test/render.js';
import { buildShardBytes } from '@/test/instanced-shard-fixture.js';
import { hook, skip, blankFile } from '@/test/blank-ifc-loader-harness.js';

// Loader scheduling invariant, not kernel parity: real parser/loader/store,
// with an explicit batch stream so the paused state can be observed mid-load.
const bounds = { min: { x: 10, y: 0, z: 0 }, max: { x: 11, y: 1, z: 1 } };
const coordinateInfo: CoordinateInfo = { originalBounds: bounds, shiftedBounds: bounds, originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false };
const mesh: MeshData = { expressId: 31, positions: Float32Array.of(10,0,0,11,0,0,10,1,0), normals: new Float32Array(9), indices: Uint32Array.of(0,1,2), color: [0.6,0.6,0.6,1] };
for (const flat of [false, true]) {
  it(`#7955 ${flat ? 'mixed flat/shard keeps one ordered flat append' : 'exact shard-only batch preserves main milestone and append sequence'}`, { skip }, async () => {
    assert.ok(hook);
    let release!: () => void, releaseFlat!: () => void, delivered = false, flatDelivered = false;
    const flatHeld = new Promise<void>(resolve => { releaseFlat = resolve; });
    const milestones: string[] = [], startLoad = loadTracer.startLoad.bind(loadTracer);
    mock.method(loadTracer, 'startLoad', (...args: Parameters<typeof startLoad>) => {
      const trace = startLoad(...args), milestone = trace.milestone.bind(trace);
      mock.method(trace, 'milestone', (...mark: Parameters<typeof milestone>) => {
        if (mark[0] === 'geometry.firstAppend' || mark[0] === 'geometry.firstVisible') milestones.push(mark[0]);
        return milestone(...mark);
      });
      return trace;
    });
    const held = new Promise<void>(resolve => { release = resolve; });
    mock.method(GeometryProcessor.prototype, 'processAdaptive', async function* (): AsyncGenerator<StreamingGeometryEvent> {
      yield { type: 'start', totalEstimate: 1 };
      yield { type: 'batch', meshes: flat ? [mesh] : [], instancedShards: [buildShardBytes(31)], coordinateInfo, totalSoFar: 1 };
      delivered = true;await held;
      if (!flat) {
        yield { type: 'batch', meshes: [mesh], coordinateInfo, totalSoFar: 2 };
        flatDelivered = true;await flatHeld;
      }
      yield { type: 'complete', coordinateInfo, totalMeshes: flat ? 1 : 2 };
    });
    const state = useViewerStore.getState(), calls: string[] = [];
    const append = state.appendGeometryBatch, shards = state.appendInstancedShards;
    // Publish forwarding observers through Zustand so the mounted hook gets
    // the new callbacks; directly mutating an old state object would not.
    await act(async () => useViewerStore.setState({
      appendGeometryBatch: (...args: Parameters<typeof append>) => { calls.push(`append:${args[1].length}`);return append(...args); },
      appendInstancedShards: (...args: Parameters<typeof shards>) => { calls.push('shards');return shards(...args); },
    }));
    const id = crypto.randomUUID(), pending = hook.loadFile(blankFile('METRE'), { kind: 'primary', modelId: id });
    try {
      await waitFor(() => delivered, 'loader consumed the batch and is waiting for completion');
      const result = useViewerStore.getState().models.get(id)?.geometryResult;
      assert.deepEqual(calls, flat ? ['shards', 'append:1'] : ['shards']);
      if (flat) {
        assert.deepEqual(result?.coordinateInfo.shiftedBounds, bounds);
        assert.equal(result?.meshes.length, 1);
      } else {
        await advance(120); // pass the existing flat render throttle and any queued paint
        assert.equal(milestones.length, 0, 'main records no first geometry milestone for a shard-only batch');
        release();
        await waitFor(() => flatDelivered, 'subsequent flat batch consumed');
        await waitFor(() => milestones.includes('geometry.firstVisible'), 'first flat geometry paint');
        assert.deepEqual(calls, ['shards', 'append:1']);
        assert.deepEqual(milestones, ['geometry.firstAppend', 'geometry.firstVisible']);
      }
      assert.equal(useViewerStore.getState().geometryStreamingActive, true);
    } finally {
      release();releaseFlat();await act(async () => pending);
      await act(async () => useViewerStore.setState({ appendGeometryBatch: append, appendInstancedShards: shards }));
    }
    assert.equal(useViewerStore.getState().models.get(id)?.loadState, 'complete');
  });
}
