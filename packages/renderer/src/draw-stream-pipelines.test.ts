/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BatchedMesh } from './types.js';
import { DrawStream } from './draw-stream.js';
import { StreamPipelines } from './draw-stream-pipelines.js';
import { resolveDrawStreamConfig } from './draw-stream-config.js';
import type { StreamFrameInputs } from './draw-stream-types.js';

const g = globalThis as Record<string, unknown>;
g.GPUBufferUsage ??= { COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 }; g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

/** A fake device and renderer pipeline that log which stream pipelines are built, and how. */
function rig({ fail = false } = {}) {
  const log = { sync: [] as string[], async: [] as string[], bundles: 0 };
  const settle: (() => void)[] = [];
  const device = {
    createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}), createBindGroup: () => ({}), createShaderModule: () => ({}),
    createBuffer: (d: GPUBufferDescriptor) => ({ size: d.size, destroy() {} }), queue: { writeBuffer() {} },
    createRenderBundleEncoder: () => { log.bundles++; return { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {}, drawIndexed() {}, finish: () => ({}) }; },
  } as unknown as GPUDevice;
  const visibility = {
    create: (d: GPURenderPipelineDescriptor) => { log.sync.push(d.label!); return { label: d.label, how: 'sync' }; },
    createAsync: (d: GPURenderPipelineDescriptor) => { log.async.push(d.label!);
      return new Promise((resolve, reject) => settle.push(() => (fail ? reject(new Error('compile failed')) : resolve({ label: d.label, how: 'async' })))); },
  };
  const env = {}; // one environment group: the bundle-cache key holds across frames
  const pipeline = { getStreamBase: () => ({ environmentLayout: {}, descriptor: { fragment: { targets: [] } }, colorFormat: 'bgra8unorm', depthFormat: 'depth32float', sampleCount: 1 }),
    visibility, getEnvironmentBindGroup: () => env } as unknown as ConstructorParameters<typeof DrawStream>[1];
  /** Resolve the first `n` (default: every) async build requested so far, then let their continuations run. */
  const finish = async (n = settle.length) => { for (const s of settle.splice(0, n)) s(); await new Promise((r) => setTimeout(r, 0)); };
  return { device, pipeline, log, finish };
}

const DISCARD_FREE = { discardFree: true, objectId: true };
const DISCARDING = { discardFree: false, objectId: true };

describe('draw stream pipelines', () => {
  it('ready() builds both layouts asynchronously, once, and get() then returns them without a synchronous build', async () => {
    const { device, pipeline, log, finish } = rig();
    let built = 0;
    const p = new StreamPipelines(device, pipeline, () => built++);
    assert.equal(p.ready(DISCARDING), false);
    assert.equal(p.ready(DISCARDING), false, 'still compiling');
    assert.deepEqual(log.async, ['draw-stream-1', 'draw-stream-5'], 'flat and quantized, requested once each');
    await finish(1);
    assert.equal(built, 1);
    assert.equal(p.ready(DISCARDING), false, 'one layout built: the mode is not ready yet');
    await finish();
    assert.equal(built, 2, 'each landed build asks for a frame: a resting viewer would otherwise never prewarm with it');
    assert.equal(p.ready(DISCARDING), true);
    assert.equal((p.get(true, DISCARDING) as unknown as { how: string }).how, 'async');
    assert.deepEqual(log.sync, [], 'no synchronous build');
  });

  it('reports a failed async build as null, once, without a synchronous retry', async () => {
    const { device, pipeline, log, finish } = rig({ fail: true });
    const p = new StreamPipelines(device, pipeline);
    const warn = console.warn; console.warn = () => {};
    try { p.ready(DISCARDING); await finish(); } finally { console.warn = warn; }
    assert.equal(p.ready(DISCARDING), null, 'failed: prewarm treats the mode as done');
    assert.deepEqual(log.async, ['draw-stream-1', 'draw-stream-5'], 'not requested again');
    assert.deepEqual(log.sync, []);
  });

  it('drops an async build that lands after clear()', async () => {
    const { device, pipeline, log, finish } = rig();
    const p = new StreamPipelines(device, pipeline);
    p.ready(DISCARDING); p.clear(); await finish();
    assert.equal((p.get(false, DISCARDING) as unknown as { how: string }).how, 'sync', 'the stale result was not kept');
    assert.deepEqual(log.sync, ['draw-stream-1']);
  });

  it('prewarm records the other discard mode only once its pipelines are built off the frame', async () => {
    const { device, pipeline, log, finish } = rig();
    const stream = new DrawStream(device, pipeline, resolveDrawStreamConfig({ stream: true }));
    const cell = [0, 2].map((x, i) => ({ id: i + 1, colorKey: `k${i}`, vertexBuffer: {}, indexBuffer: {}, indexCount: 30, color: [1, 1, 1, 1],
      expressIds: [i], bounds: { min: [x, 0, 0], max: [x + 1, 1, 1] } }) as unknown as BatchedMesh);
    stream.sync(cell, 'g', 'k', 32, () => ({ alpha: 1, anchor: null, overrideBits: 0 }));
    stream.prepareFrame(new Float32Array(4), { getCameraWorld: () => [0, 0, 0], tryPackDrawableOrigin: () => true } as unknown as Parameters<DrawStream['prepareFrame']>[1]);
    const f = { pass: { executeBundles() {} } as unknown as GPURenderPassEncoder, mode: DISCARD_FREE, allowBundles: true, visible: () => true, projectedPx: () => 100,
      contribPx: 0, lodPx: 0, eye: { x: 0, y: 0, z: 0 }, interacting: false,
      projection: { ortho: false, orthoHalfHeight: 1, fovYRadians: Math.PI / 2, viewportHeightPx: 1000 } } as StreamFrameInputs;
    stream.encode(f, () => {});
    assert.deepEqual(log.sync, ['draw-stream-3'], 'the drawn mode builds synchronously (the frame needs it now); the discarding mode does not');
    assert.deepEqual(log.async, ['draw-stream-1', 'draw-stream-5']);
    const before = log.bundles; // the drawn node's bundle and both LODs of the drawn mode, at most
    stream.encode(f, () => {});
    assert.equal(log.bundles, before, 'nothing of the discarding mode recorded while it compiles');
    await finish();
    stream.encode(f, () => {});
    assert.ok(log.bundles > before, 'recorded once built');
    assert.deepEqual(log.sync, ['draw-stream-3'], 'still no synchronous build of the discarding mode');
  });
});
