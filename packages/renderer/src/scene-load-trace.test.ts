/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6979: the streaming upload and the post-stream finalize report into the
 * load's trace when the caller hands one in. Driven through the real
 * `queueMeshes` / `flushPending` / `finalizeStreamingAsync` paths with only
 * the GPU upload (`createBatchedMesh`) stubbed, as in
 * `scene-finalize-incremental.test.ts`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createLoadTracer } from '@ifc-lite/load-trace';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import type { RenderPipeline } from './pipeline.js';
import type { BatchedMesh } from './types.js';

const device = {} as GPUDevice;
const pipeline = {} as RenderPipeline;

function triangle(expressId: number, color: [number, number, number, number]): MeshData {
  return {
    expressId,
    modelIndex: 0,
    color,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
  } as MeshData;
}

function scene(failBuild = false): Scene {
  const s = new Scene();
  s['cachedMaxBufferSize'] = 256 * 1024 * 1024;
  let id = 1;
  s['createBatchedMesh'] = (meshes: MeshData[], color: [number, number, number, number], _d: GPUDevice, _p: RenderPipeline, key?: string) => {
    if (failBuild && key !== undefined) throw new Error('device lost');
    const buffer = () => ({ destroy() {} });
    return { id: id++, colorKey: key ?? 'fragment', color, indexCount: meshes.length * 3, vertexBuffer: buffer(), indexBuffer: buffer(), expressIds: meshes.map((m) => m.expressId) } as unknown as BatchedMesh;
  };
  return s;
}

const tracer = () => createLoadTracer({ enabled: true, sink: null });

describe('Scene load-trace spans (#6979)', () => {
  it('records one scene.flushPending span per flush that uploaded, none for an empty queue', () => {
    const t = tracer();
    const trace = t.startLoad('m');
    const s = scene();
    s.queueMeshes([triangle(1, [1, 0, 0, 1]), triangle(2, [0, 1, 0, 1])]);
    assert.strictEqual(s.flushPending(device, pipeline, 12, trace), true);
    assert.strictEqual(s.flushPending(device, pipeline, 12, trace), false);
    const flushes = t.latest()!.spans.filter((sp) => sp.name === 'scene.flushPending');
    assert.strictEqual(flushes.length, 1);
    assert.deepStrictEqual(flushes[0].attrs, { meshes: 2, queued: 0 });
    assert.ok(flushes[0].end! >= flushes[0].start);
  });

  it('records scene.finalize with scene.finalize.regroup under it, ending when the rebuild resolves', async () => {
    const t = tracer();
    const trace = t.startLoad('m');
    const s = scene();
    s.appendToBatches([triangle(1, [1, 0, 0, 1]), triangle(2, [0, 1, 0, 1])], device, pipeline, true);
    const done = s.finalizeStreamingAsync(device, pipeline, 8, trace);
    await done;
    const spans = t.latest()!.spans;
    const finalize = spans.find((sp) => sp.name === 'scene.finalize')!;
    assert.ok(finalize, 'scene.finalize recorded');
    assert.notStrictEqual(finalize.end, null);
    assert.strictEqual(finalize.attrs?.fragments, 2);
    assert.strictEqual(finalize.attrs?.batches, 2);
    assert.ok((finalize.attrs?.chunks as number) >= 1);
    const regroup = spans.find((sp) => sp.name === 'scene.finalize.regroup')!;
    assert.strictEqual(regroup.parentId, finalize.id);
  });

  it('closes scene.finalize with an error flag when the rebuild rejects', async () => {
    const t = tracer();
    const trace = t.startLoad('m');
    const s = scene(true);
    s.appendToBatches([triangle(1, [1, 0, 0, 1])], device, pipeline, true);
    await assert.rejects(s.finalizeStreamingAsync(device, pipeline, 8, trace), /device lost/);
    const finalize = t.latest()!.spans.find((sp) => sp.name === 'scene.finalize')!;
    assert.notStrictEqual(finalize.end, null);
    assert.strictEqual(finalize.attrs?.error, true);
  });

  it('records a finalize with nothing to rebuild as a closed span, so waiters still see it end', async () => {
    const t = tracer();
    const trace = t.startLoad('m');
    await scene().finalizeStreamingAsync(device, pipeline, 8, trace);
    const finalize = t.latest()!.spans.find((sp) => sp.name === 'scene.finalize')!;
    assert.notStrictEqual(finalize.end, null);
    assert.strictEqual(finalize.attrs?.fragments, 0);
  });
});
