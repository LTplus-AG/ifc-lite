/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DeviationComputer } from './deviation/deviation-computer.js';
import type { DeviationComputeContext } from './deviation/deviation-computer.js';

// WebGPU enum globals referenced by DeviationPipeline's constructor / buffer
// usage flags (not defined in node) — same polyfill as paired-buffer-leak.test.ts.
(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

function fakeBuffer(): GPUBuffer & { destroyed: number } {
  const buf = {
    size: 0,
    destroyed: 0,
    destroy() {
      this.destroyed++;
    },
  };
  return buf as unknown as GPUBuffer & { destroyed: number };
}

/**
 * Fake `GPUDevice` sufficient for `DeviationPipeline` construction and
 * `DeviationComputer.compute()`. `onSubmittedWorkDoneImpl` lets each test
 * control whether the submitted-work promise resolves or rejects, so the
 * device-loss rejection path can be exercised directly.
 */
function makeFakeGpuDevice(opts: { onSubmittedWorkDoneImpl?: () => Promise<void> } = {}) {
  const encoder = {
    beginComputePass: () => ({
      setPipeline: () => {},
      setBindGroup: () => {},
      dispatchWorkgroups: () => {},
      end: () => {},
    }),
    finish: () => ({}),
  };
  const device = {
    createBindGroupLayout: () => ({} as GPUBindGroupLayout),
    createPipelineLayout: () => ({} as GPUPipelineLayout),
    createShaderModule: () => ({} as GPUShaderModule),
    createComputePipeline: () => ({} as GPUComputePipeline),
    createCommandEncoder: () => encoder as unknown as GPUCommandEncoder,
    createBindGroup: () => ({} as GPUBindGroup),
    createBuffer: () => fakeBuffer() as unknown as GPUBuffer,
    queue: {
      writeBuffer: () => {},
      submit: () => {},
      onSubmittedWorkDone:
        opts.onSubmittedWorkDoneImpl ?? (() => Promise.resolve()),
    },
  } as unknown as GPUDevice;
  return device;
}

function makeMesh(expressId: number) {
  return {
    expressId,
    modelIndex: 0,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

function makeCtx(device: GPUDevice, opts: { chunks?: number } = {}): DeviationComputeContext {
  const chunkCount = opts.chunks ?? 1;
  const chunks = Array.from({ length: chunkCount }, () => ({
    vertexBuffer: fakeBuffer() as unknown as GPUBuffer,
    deviationBuffer: fakeBuffer() as unknown as GPUBuffer,
    pointCount: 4,
  }));
  return {
    device: { getDevice: () => device } as unknown as DeviationComputeContext['device'],
    scene: {
      forEachMeshData: (visit: (md: unknown) => void) => {
        visit(makeMesh(1));
      },
    } as unknown as DeviationComputeContext['scene'],
    pointCloudRenderer: {
      getInternalNodes: () => [{ chunks, model: undefined }],
    } as unknown as DeviationComputeContext['pointCloudRenderer'],
    requestRender: () => {},
  };
}

describe('DeviationComputer.init(): idempotency across a missing destroy()', () => {
  it('RED/GREEN: a second init() without destroy() still processes chunks (BVH not silently skipped)', async () => {
    const computer = new DeviationComputer();
    const deviceA = makeFakeGpuDevice();
    computer.init(deviceA as unknown as GPUDevice);

    const ctx1 = makeCtx(deviceA);
    const r1 = await computer.compute({}, ctx1);
    assert.strictEqual(r1.chunksProcessed, 1, 'sanity: first compute against deviceA processes its chunk');

    // Re-init WITHOUT an intervening destroy() — e.g. a device-recreate
    // path in the Renderer. The mesh set (and therefore the fingerprint)
    // is identical to the first compute() call above.
    const deviceB = makeFakeGpuDevice();
    computer.init(deviceB as unknown as GPUDevice);

    const ctx2 = makeCtx(deviceB);
    const r2 = await computer.compute({}, ctx2);

    // Before the fix: the stale fingerprint from deviceA's compute matches
    // this mesh set, so uploadBvh() is skipped against the NEW pipeline
    // (deviceB), pipeline.dispatch() has no BVH and returns false for
    // every chunk, and the result silently reports zero chunks processed
    // — a plausible-looking "no deviation" instead of a loud failure.
    assert.strictEqual(r2.chunksProcessed, 1, 'second compute after re-init() must still process its chunk');
    assert.strictEqual(r2.pointsProcessed, 4, 'points must not be silently dropped after re-init()');
  });

  it('BOUNDING CONTROL: init() -> compute() -> destroy() -> init() -> compute() still works (normal lifecycle)', async () => {
    const computer = new DeviationComputer();
    const deviceA = makeFakeGpuDevice();
    computer.init(deviceA as unknown as GPUDevice);
    const r1 = await computer.compute({}, makeCtx(deviceA));
    assert.strictEqual(r1.chunksProcessed, 1);

    computer.destroy();

    const deviceB = makeFakeGpuDevice();
    computer.init(deviceB as unknown as GPUDevice);
    const r2 = await computer.compute({}, makeCtx(deviceB));
    assert.strictEqual(r2.chunksProcessed, 1, 'normal init/compute/destroy/init/compute lifecycle must keep working');
  });

  it('BOUNDING CONTROL: a second init() releases the previous pipeline (no GPU buffer leak)', async () => {
    const computer = new DeviationComputer();

    // Track every buffer deviceA's pipeline allocates so we can assert
    // the BVH buffers specifically get torn down by the re-init below.
    const createdOnA: Array<GPUBuffer & { destroyed: number }> = [];
    const deviceA = makeFakeGpuDevice();
    (deviceA as unknown as { createBuffer: () => GPUBuffer }).createBuffer = () => {
      const buf = fakeBuffer();
      createdOnA.push(buf);
      return buf as unknown as GPUBuffer;
    };
    computer.init(deviceA as unknown as GPUDevice);

    // Run a compute against deviceA so uploadBvh() actually allocates the
    // BVH GPU buffers (nodes + triangles) that init()'s teardown must free.
    const r1 = await computer.compute({}, makeCtx(deviceA));
    assert.strictEqual(r1.chunksProcessed, 1, 'sanity: compute against deviceA processed its chunk');
    // uploadBvh() creates exactly 2 buffers (nodes + triangles) before
    // dispatch()'s 1 transient params buffer; assert the count so a
    // future change to buffer creation order doesn't silently invalidate
    // which entries below are "the BVH buffers".
    assert.ok(createdOnA.length >= 2, `expected uploadBvh to have created at least 2 buffers on deviceA, got ${createdOnA.length}`);
    const [bvhNodesBuffer, bvhTrianglesBuffer] = createdOnA;
    assert.strictEqual(bvhNodesBuffer.destroyed, 0, 'sanity: BVH nodes buffer not yet destroyed before re-init');
    assert.strictEqual(bvhTrianglesBuffer.destroyed, 0, 'sanity: BVH triangles buffer not yet destroyed before re-init');

    const deviceB = makeFakeGpuDevice();
    // Re-init must not throw even though the previous pipeline is live.
    assert.doesNotThrow(() => computer.init(deviceB as unknown as GPUDevice));

    // The old pipeline's BVH buffers must have been torn down by the
    // re-init — exactly once each, so a double-destroy is also caught.
    assert.strictEqual(bvhNodesBuffer.destroyed, 1, 'old BVH nodes buffer must be destroyed exactly once by re-init()');
    assert.strictEqual(bvhTrianglesBuffer.destroyed, 1, 'old BVH triangles buffer must be destroyed exactly once by re-init()');
  });
});

describe('DeviationComputer.compute(): releaseTransientParams on the rejection path', () => {
  it('RED/GREEN: transient params buffers are released even when onSubmittedWorkDone() rejects (device loss)', async () => {
    const created: Array<GPUBuffer & { destroyed: number }> = [];
    const device = {
      createBindGroupLayout: () => ({} as GPUBindGroupLayout),
      createPipelineLayout: () => ({} as GPUPipelineLayout),
      createShaderModule: () => ({} as GPUShaderModule),
      createComputePipeline: () => ({} as GPUComputePipeline),
      createCommandEncoder: () => ({
        beginComputePass: () => ({
          setPipeline: () => {}, setBindGroup: () => {}, dispatchWorkgroups: () => {}, end: () => {},
        }),
        finish: () => ({}),
      }) as unknown as GPUCommandEncoder,
      createBindGroup: () => ({} as GPUBindGroup),
      createBuffer: () => {
        const buf = fakeBuffer();
        created.push(buf);
        return buf as unknown as GPUBuffer;
      },
      queue: {
        writeBuffer: () => {},
        submit: () => {},
        onSubmittedWorkDone: () => Promise.reject(new Error('simulated device loss')),
      },
    } as unknown as GPUDevice;

    const computer = new DeviationComputer();
    computer.init(device);

    await assert.rejects(() => computer.compute({}, makeCtx(device)));

    // uploadBvh() creates 2 buffers (nodes + triangles); dispatch() creates
    // 1 transient params buffer per chunk (1 chunk here) = 3 total.
    assert.strictEqual(created.length, 3, 'sanity: BVH buffers (2) + one transient params buffer (1) were created');
    const paramsBuffer = created[2];
    assert.strictEqual(
      paramsBuffer.destroyed, 1,
      'the transient params buffer must be released even though onSubmittedWorkDone() rejected',
    );
  });

  it('BOUNDING CONTROL (happy path): transient params buffers are still released when the device does not fail', async () => {
    const created: Array<GPUBuffer & { destroyed: number }> = [];
    const device = {
      createBindGroupLayout: () => ({} as GPUBindGroupLayout),
      createPipelineLayout: () => ({} as GPUPipelineLayout),
      createShaderModule: () => ({} as GPUShaderModule),
      createComputePipeline: () => ({} as GPUComputePipeline),
      createCommandEncoder: () => ({
        beginComputePass: () => ({
          setPipeline: () => {}, setBindGroup: () => {}, dispatchWorkgroups: () => {}, end: () => {},
        }),
        finish: () => ({}),
      }) as unknown as GPUCommandEncoder,
      createBindGroup: () => ({} as GPUBindGroup),
      createBuffer: () => {
        const buf = fakeBuffer();
        created.push(buf);
        return buf as unknown as GPUBuffer;
      },
      queue: {
        writeBuffer: () => {},
        submit: () => {},
        onSubmittedWorkDone: () => Promise.resolve(),
      },
    } as unknown as GPUDevice;

    const computer = new DeviationComputer();
    computer.init(device);

    const result = await computer.compute({}, makeCtx(device));
    assert.strictEqual(result.chunksProcessed, 1);

    const paramsBuffer = created[2];
    assert.strictEqual(paramsBuffer.destroyed, 1, 'the transient params buffer must be released on the happy path too');
  });
});
