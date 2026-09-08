/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { appendChunkToNode, createNode } from './pointcloud/point-cloud-node.js';
import type { PointRenderPipeline } from './pointcloud/point-pipeline.js';
import { DeviationPipeline } from './deviation/deviation-pipeline.js';
import type { TriangleBVHResult } from './deviation/triangle-bvh.js';

// WebGPU enum globals referenced by DeviationPipeline's constructor / buffer
// usage flags (not defined in node) — same polyfill as point-cloud-transform.test.ts.
(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

/**
 * Two sites allocate a PAIR of GPU buffers with no cleanup if the SECOND
 * `createBuffer` throws: `appendPointSubBuffer` (vertexBuffer then
 * deviationBuffer) and `DeviationPipeline.uploadBvh` (nodeBuf then triBuf).
 * A throw on the second buffer must not leak the first — it must be
 * `.destroy()`d before the error propagates.
 */

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

describe('appendChunkToNode: paired buffer leak (point-cloud-node.ts)', () => {
  function makeDevice(opts: { failSecondCreate: boolean }) {
    const created: Array<GPUBuffer & { destroyed: number }> = [];
    let createCount = 0;
    const device = {
      limits: {
        maxBufferSize: 256 * 1024 * 1024,
        maxStorageBufferBindingSize: 128 * 1024 * 1024,
        maxComputeWorkgroupsPerDimension: 65535,
      },
      queue: {
        writeBuffer: () => {},
      },
      createBuffer: (_desc: unknown) => {
        createCount++;
        if (opts.failSecondCreate && createCount === 2) {
          throw new Error('simulated OOM on second createBuffer');
        }
        const buf = fakeBuffer();
        created.push(buf);
        return buf as unknown as GPUBuffer;
      },
    } as unknown as GPUDevice;
    return { device, created };
  }

  function makePipeline(): PointRenderPipeline {
    return {
      createUniformBuffer: () => fakeBuffer() as unknown as GPUBuffer,
      createBindGroup: () => ({} as GPUBindGroup),
    } as unknown as PointRenderPipeline;
  }

  function makeChunk() {
    return {
      positions: new Float32Array([0, 0, 0, 1, 1, 1]),
      colors: undefined,
      classifications: undefined,
      intensities: undefined,
      pointCount: 2,
      bbox: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] },
    };
  }

  it('RED/GREEN: destroys the vertexBuffer when the deviationBuffer allocation throws', () => {
    const { device, created } = makeDevice({ failSecondCreate: true });
    const pipeline = makePipeline();
    const node = createNode(device, pipeline, { expressId: 1 });

    assert.throws(() => appendChunkToNode(device, node, makeChunk()));

    assert.strictEqual(created.length, 1, 'only the vertexBuffer should have been created');
    assert.strictEqual(created[0].destroyed, 1, 'the leaked vertexBuffer must be destroyed');
    assert.strictEqual(node.chunks.length, 0, 'no chunk should be registered on failure');
  });

  it('BOUNDING CONTROL (success path): neither buffer is destroyed and the chunk is registered', () => {
    const { device, created } = makeDevice({ failSecondCreate: false });
    const pipeline = makePipeline();
    const node = createNode(device, pipeline, { expressId: 1 });

    appendChunkToNode(device, node, makeChunk());

    assert.strictEqual(created.length, 2, 'both vertexBuffer and deviationBuffer created');
    assert.strictEqual(created[0].destroyed, 0, 'vertexBuffer must survive the success path');
    assert.strictEqual(created[1].destroyed, 0, 'deviationBuffer must survive the success path');
    assert.strictEqual(node.chunks.length, 1, 'chunk must be registered on success');
    assert.strictEqual(node.pointCount, 2);
  });
});

describe('DeviationPipeline.uploadBvh: paired buffer leak (deviation-pipeline.ts)', () => {
  function makeDevice(opts: { failSecondCreate: boolean }) {
    const created: Array<GPUBuffer & { destroyed: number }> = [];
    let bufferCreateCount = 0;
    const device = {
      createBindGroupLayout: () => ({} as GPUBindGroupLayout),
      createPipelineLayout: () => ({} as GPUPipelineLayout),
      createShaderModule: () => ({} as GPUShaderModule),
      createComputePipeline: () => ({} as GPUComputePipeline),
      queue: {
        writeBuffer: () => {},
      },
      createBuffer: (_desc: unknown) => {
        bufferCreateCount++;
        if (opts.failSecondCreate && bufferCreateCount === 2) {
          throw new Error('simulated OOM on second createBuffer (triBuf)');
        }
        const buf = fakeBuffer();
        created.push(buf);
        return buf as unknown as GPUBuffer;
      },
    } as unknown as GPUDevice;
    return { device, created };
  }

  function makeBvh(): TriangleBVHResult {
    return {
      nodes: new Float32Array(8),
      triangles: new Float32Array(12),
      triangleCount: 1,
      nodeCount: 1,
      meshCount: 1,
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    };
  }

  it('RED/GREEN: destroys nodeBuf when the triBuf allocation throws', () => {
    const { device, created } = makeDevice({ failSecondCreate: true });
    const pipeline = new DeviationPipeline(device);

    assert.throws(() => pipeline.uploadBvh(makeBvh()));

    assert.strictEqual(created.length, 1, 'only nodeBuf should have been created');
    assert.strictEqual(created[0].destroyed, 1, 'the leaked nodeBuf must be destroyed');
    assert.strictEqual(pipeline.hasBvh(), false, 'no BVH should be considered uploaded on failure');
  });

  it('BOUNDING CONTROL (success path): neither buffer is destroyed and the BVH is registered', () => {
    const { device, created } = makeDevice({ failSecondCreate: false });
    const pipeline = new DeviationPipeline(device);

    pipeline.uploadBvh(makeBvh());

    assert.strictEqual(created.length, 2, 'both nodeBuf and triBuf created');
    assert.strictEqual(created[0].destroyed, 0, 'nodeBuf must survive the success path');
    assert.strictEqual(created[1].destroyed, 0, 'triBuf must survive the success path');
    assert.strictEqual(pipeline.hasBvh(), true, 'BVH must be considered uploaded on success');
    const stats = pipeline.getBvhStats();
    assert.strictEqual(stats.triangleCount, 1);
    assert.strictEqual(stats.nodeCount, 1);
  });
});
