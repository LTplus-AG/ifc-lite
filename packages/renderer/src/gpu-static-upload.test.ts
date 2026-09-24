/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Issue #5429: static geometry must reach the GPU through `queue.writeBuffer`,
// never `createBuffer({ mappedAtCreation: true })` — on Chromium the latter
// pins a hidden shared-memory copy of the buffer for its whole lifetime.
//
// The fake device below enforces the two WebGPU rules this contract hangs on:
//  - it REFUSES any mapped-at-creation allocation (throwing the RangeError
//    Chromium raises when it cannot back the mapping), so a site that still
//    maps at creation fails loudly here;
//  - its `writeBuffer` applies the spec's synchronous checks — a byte count
//    that is not a multiple of 4, or a write past the buffer end, throws an
//    `OperationError` DOMException, which `isDeviceLossThrow` would treat as
//    a device loss in production.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { DecodedInstancedShard, MeshData } from '@ifc-lite/geometry';
import { createStaticGpuBuffer } from './gpu-static-upload.js';
import { Scene } from './scene.js';
import { createSceneBatch } from './scene-batch-upload.js';
import type { RenderPipeline } from './pipeline.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

interface FakeBuffer {
  size: number;
  usage: number;
  contents: Uint8Array;
  destroyed: number;
  destroy(): void;
}

function strictDevice(options: { failWrite?: boolean } = {}) {
  const created: FakeBuffer[] = [];
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer(desc: GPUBufferDescriptor): FakeBuffer {
      if (desc.mappedAtCreation) {
        throw new RangeError(
          "Failed to execute 'createBuffer' on 'GPUDevice': createBuffer failed, " +
          `size (${desc.size}) is too large for the implementation when mappedAtCreation == true`,
        );
      }
      const buffer: FakeBuffer = {
        size: desc.size,
        usage: desc.usage,
        contents: new Uint8Array(desc.size),
        destroyed: 0,
        destroy() { this.destroyed++; },
      };
      created.push(buffer);
      return buffer;
    },
    createBindGroup: () => ({}),
    queue: {
      writeBuffer(buffer: FakeBuffer, offset: number, data: ArrayBufferView, dataOffset?: number, size?: number) {
        assert.strictEqual(dataOffset, undefined, 'uploads write whole views (3-argument form)');
        assert.strictEqual(size, undefined, 'uploads write whole views (3-argument form)');
        if (options.failWrite) throw new Error('queue rejected the write');
        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (bytes.byteLength % 4 !== 0 || offset % 4 !== 0) {
          throw new DOMException('Number of bytes to write must be a multiple of 4', 'OperationError');
        }
        if (offset + bytes.byteLength > buffer.size) {
          throw new DOMException('Write range exceeds the buffer size', 'OperationError');
        }
        buffer.contents.set(bytes, offset);
      },
    },
  };
  return { device: device as unknown as GPUDevice, created };
}

describe('createStaticGpuBuffer (#5429)', () => {
  it('uploads 4-byte-aligned data verbatim into an exactly-sized COPY_DST buffer', () => {
    const { device } = strictDevice();
    const data = new Float32Array([1.5, -2, 3.25, 4]);
    const buffer = createStaticGpuBuffer(device, data, GPUBufferUsage.VERTEX) as unknown as FakeBuffer;
    assert.strictEqual(buffer.size, 16);
    assert.strictEqual(buffer.usage, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
    assert.deepStrictEqual([...new Float32Array(buffer.contents.buffer)], [1.5, -2, 3.25, 4]);
  });

  it('pads an odd-count u16 index list to a 4-byte multiple instead of throwing OperationError', () => {
    const { device } = strictDevice();
    const indices = new Uint16Array([7, 8, 9]); // 6 bytes
    const buffer = createStaticGpuBuffer(device, indices, GPUBufferUsage.INDEX) as unknown as FakeBuffer;
    assert.strictEqual(buffer.size, 8);
    assert.deepStrictEqual([...new Uint16Array(buffer.contents.buffer)], [7, 8, 9, 0]);
  });

  it('honours a view\'s byteOffset and length, not its whole backing buffer', () => {
    const { device } = strictDevice();
    const backing = new Uint32Array([100, 1, 2, 3, 200]);
    const view = backing.subarray(1, 4);
    const buffer = createStaticGpuBuffer(device, view, GPUBufferUsage.INDEX) as unknown as FakeBuffer;
    assert.strictEqual(buffer.size, 12);
    assert.deepStrictEqual([...new Uint32Array(buffer.contents.buffer)], [1, 2, 3]);
  });

  it('accepts a raw ArrayBuffer and gives an empty payload a valid 4-byte buffer', () => {
    const { device } = strictDevice();
    const raw = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    const full = createStaticGpuBuffer(device, raw, GPUBufferUsage.VERTEX) as unknown as FakeBuffer;
    assert.deepStrictEqual([...full.contents], [1, 2, 3, 4, 5, 6, 7, 8]);
    const empty = createStaticGpuBuffer(device, new Float32Array(0), GPUBufferUsage.VERTEX) as unknown as FakeBuffer;
    assert.strictEqual(empty.size, 4);
  });

  it('destroys its own buffer and rethrows when the write fails, so nothing is orphaned', () => {
    const { device, created } = strictDevice({ failWrite: true });
    assert.throws(
      () => createStaticGpuBuffer(device, new Float32Array([1]), GPUBufferUsage.VERTEX),
      /queue rejected the write/,
    );
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].destroyed, 1);
  });
});

function triangle(expressId: number): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [0.2, 0.3, 0.4, 1],
  } as MeshData;
}

function shard(): DecodedInstancedShard {
  return {
    templates: [{ ...triangle(0), origin: [0, 0, 0] }],
    instances: [{
      templateIndex: 0,
      entityId: 42,
      color: [0.4, 0.5, 0.6, 1],
      transform: new Float32Array([1, 0, 0, 2, 0, 1, 0, 3, 0, 0, 1, 4, 0, 0, 0, 1]),
    }],
    carriesItemIds: false,
  };
}

const pipeline = {
  getUniformBufferSize: () => 256,
  getBindGroupLayout: () => ({}),
} as unknown as RenderPipeline;

describe('Scene static-geometry uploads never map at creation (#5429)', () => {
  it('batched, instanced and device-recovery uploads all succeed on a device that refuses mappedAtCreation', async () => {
    const scene = new Scene();
    const first = strictDevice();
    scene.appendToBatches([triangle(1), triangle(2)], first.device, pipeline);
    scene.addInstancedShard(first.device, shard(), 0);

    const batch = scene.getBatchedMeshes()[0];
    assert.ok(batch, 'the batch was published');
    const indexBuffer = batch.indexBuffer as unknown as FakeBuffer;
    assert.deepStrictEqual(
      [...new Uint32Array(indexBuffer.contents.buffer)],
      [0, 1, 2, 3, 4, 5],
      'the merged index data reached the GPU buffer',
    );
    const template = scene.getInstancedTemplates()[0];
    assert.ok(template, 'the instanced template was published');
    assert.deepStrictEqual(
      [...new Uint32Array((template.indexBuffer as unknown as FakeBuffer).contents.buffer)],
      [0, 1, 2],
    );

    assert.deepStrictEqual(await scene.prepareDeviceRecovery(), { ok: true });
    scene.discardGpuResourcesForRecovery();
    const second = strictDevice();
    scene.restoreGpuResourcesAfterRecovery(second.device, pipeline);
    assert.ok(scene.getBatchedMeshes().length > 0, 'batches were restored');
    assert.strictEqual(scene.getInstancedTemplates().length, 1, 'instanced templates were restored');
    assert.ok(second.created.length > 0);
  });
  it('the LOD1 index buffer is uploaded the same way', () => {
    // A 100x100 quad grid: 20k triangles, far past LOD_MIN_TRIANGLES, and a
    // vertex spacing below the clustering cell, so LOD1 genuinely simplifies.
    const n = 100;
    const positions: number[] = [], normals: number[] = [], indices: number[] = [];
    for (let y = 0; y <= n; y++) {
      for (let x = 0; x <= n; x++) { positions.push(x / n, y / n, 0); normals.push(0, 0, 1); }
    }
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const a = y * (n + 1) + x, b = a + 1, c = a + n + 1, d = c + 1;
        indices.push(a, b, d, a, d, c);
      }
    }
    const grid = {
      expressId: 7,
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      indices: new Uint32Array(indices),
      color: [0.2, 0.3, 0.4, 1],
    } as MeshData;
    const { device } = strictDevice();
    const batch = createSceneBatch([grid], [0.2, 0.3, 0.4, 1], device, pipeline, {
      id: 0, colorKey: 'k', origin: [0, 0, 0], quantized: 'off', lod: true,
    }, 'bucket');
    assert.ok(batch.lod1IndexBuffer, 'precondition: the batch built LOD1');
    const lod = batch.lod1IndexBuffer as unknown as FakeBuffer;
    const lodIndices = new Uint32Array(lod.contents.buffer);
    assert.strictEqual(lodIndices.length, batch.lod1IndexCount);
    assert.ok(lodIndices.some((index) => index !== 0), 'the simplified indices reached the GPU buffer');
  });
});
