/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  INSTANCE_FIELD_OFFSETS,
  INSTANCE_FLAGS,
  QUANTIZED_INSTANCE_RECORD_SIZE,
  QUANTIZED_MESH_RECORD_SIZE,
  QUANTIZED_VERTEX_STRIDE,
} from './quantized-pipeline.js';
import {
  QuantizedSceneBuffers,
  type QuantizedSceneSource,
} from './quantized-scene-buffers.js';
import { quantizedShaderSource } from './shaders/quantized.wgsl.js';

interface RecordedWrite {
  buffer: MockBuffer;
  bufferOffset: number;
  bytes: Uint8Array;
}

class MockBuffer {
  destroyed = false;
  constructor(public size: number, public usage: number) {}
  destroy(): void {
    this.destroyed = true;
  }
}

class MockDevice {
  limits = { minUniformBufferOffsetAlignment: 256 };
  writes: RecordedWrite[] = [];
  buffers: MockBuffer[] = [];

  queue = {
    writeBuffer: (
      buffer: MockBuffer,
      bufferOffset: number,
      data: BufferSource | ArrayBuffer,
      dataOffset?: number,
      size?: number,
    ) => {
      const view = toBytes(data, dataOffset ?? 0, size);
      this.writes.push({ buffer, bufferOffset, bytes: view });
    },
  };

  createBuffer(desc: { size: number; usage: number }): MockBuffer {
    const buf = new MockBuffer(desc.size, desc.usage);
    this.buffers.push(buf);
    return buf;
  }
}

function toBytes(
  data: BufferSource | ArrayBuffer,
  offset: number,
  size: number | undefined,
): Uint8Array {
  let underlying: ArrayBuffer;
  let viewOffset = 0;
  let viewLength: number;
  if (data instanceof ArrayBuffer) {
    underlying = data;
    viewLength = size ?? data.byteLength - offset;
  } else {
    underlying = data.buffer as ArrayBuffer;
    viewOffset = data.byteOffset;
    viewLength = size ?? data.byteLength - offset;
  }
  return new Uint8Array(underlying, viewOffset + offset, viewLength).slice();
}

function makeIdentity(): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

function buildSource(opts: {
  meshes: { aabbMin: [number, number, number]; aabbMax: [number, number, number]; vertexCount: number; indexCount: number; instanceCount: number }[];
}): QuantizedSceneSource {
  let totalVertexCount = 0;
  let totalIndexCount = 0;
  let totalInstanceCount = 0;
  for (const m of opts.meshes) {
    totalVertexCount += m.vertexCount;
    totalIndexCount += m.indexCount;
    totalInstanceCount += m.instanceCount;
  }

  const vertexData = new Uint8Array(totalVertexCount * QUANTIZED_VERTEX_STRIDE);
  const indexData = new Uint32Array(totalIndexCount);
  const meshTable = new Uint8Array(opts.meshes.length * QUANTIZED_MESH_RECORD_SIZE);
  const instanceData = new Uint8Array(totalInstanceCount * QUANTIZED_INSTANCE_RECORD_SIZE);

  let vertexOffset = 0;
  let indexOffset = 0;
  let firstInstance = 0;
  let expressIdSeed = 1000;

  const meshDV = new DataView(meshTable.buffer);
  const instDV = new DataView(instanceData.buffer);

  for (let i = 0; i < opts.meshes.length; i++) {
    const m = opts.meshes[i]!;
    const recOff = i * QUANTIZED_MESH_RECORD_SIZE;
    // aabb_min
    meshDV.setFloat32(recOff + 0, m.aabbMin[0], true);
    meshDV.setFloat32(recOff + 4, m.aabbMin[1], true);
    meshDV.setFloat32(recOff + 8, m.aabbMin[2], true);
    // aabb_max
    meshDV.setFloat32(recOff + 16, m.aabbMax[0], true);
    meshDV.setFloat32(recOff + 20, m.aabbMax[1], true);
    meshDV.setFloat32(recOff + 24, m.aabbMax[2], true);
    // vertex_offset, vertex_count, index_offset, index_count
    meshDV.setUint32(recOff + 32, vertexOffset, true);
    meshDV.setUint32(recOff + 36, m.vertexCount, true);
    meshDV.setUint32(recOff + 40, indexOffset, true);
    meshDV.setUint32(recOff + 44, m.indexCount, true);
    // first_instance, instance_count
    meshDV.setUint32(recOff + 48, firstInstance, true);
    meshDV.setUint32(recOff + 52, m.instanceCount, true);

    // Fill instance records with synthetic but valid bytes.
    const xform = makeIdentity();
    for (let k = 0; k < m.instanceCount; k++) {
      const instIdx = firstInstance + k;
      const off = instIdx * QUANTIZED_INSTANCE_RECORD_SIZE;
      // Transform: identity, with translation tx = instIdx for traceability.
      for (let j = 0; j < 16; j++) {
        instDV.setFloat32(off + j * 4, xform[j]!, true);
      }
      instDV.setFloat32(off + 12 * 4, instIdx, true); // tx
      instDV.setUint32(off + INSTANCE_FIELD_OFFSETS.expressId, expressIdSeed++, true);
      instDV.setUint32(off + INSTANCE_FIELD_OFFSETS.baseColor, 0xff808080, true);
      instDV.setUint32(off + INSTANCE_FIELD_OFFSETS.override, 0, true);
      instDV.setUint32(off + INSTANCE_FIELD_OFFSETS.flags, INSTANCE_FLAGS.visible, true);
    }

    vertexOffset += m.vertexCount;
    indexOffset += m.indexCount;
    firstInstance += m.instanceCount;
  }

  return {
    vertexData,
    indexData,
    meshTable,
    instanceData,
    meshCount: opts.meshes.length,
    instanceCount: totalInstanceCount,
    totalVertexCount,
  };
}

describe('QuantizedSceneBuffers', () => {
  it('uploads vertex / index / instance buffers and pads mesh uniform slots', () => {
    const device = new MockDevice();
    const source = buildSource({
      meshes: [
        { aabbMin: [-1, -1, 0], aabbMax: [1, 1, 0], vertexCount: 4, indexCount: 6, instanceCount: 2 },
        { aabbMin: [0, 0, 0], aabbMax: [2, 2, 2], vertexCount: 8, indexCount: 36, instanceCount: 1 },
      ],
    });

    const buffers = new QuantizedSceneBuffers(device as unknown as GPUDevice, source);

    expect(buffers.meshCount).toBe(2);
    expect(buffers.instanceCount).toBe(3);
    expect(buffers.meshUniformAlignment).toBe(256);

    // Mesh uniform buffer should be 2 × 256 = 512 bytes, vertex buffer at least
    // 12 * 12 = 144 bytes (rounded up to 4), instance buffer 3 × 80.
    const meshBuffer = buffers.getMeshUniformBuffer() as unknown as MockBuffer;
    expect(meshBuffer.size).toBe(2 * 256);
    expect((buffers.getInstanceBuffer() as unknown as MockBuffer).size).toBe(3 * 80);

    // Each draw info should report the correctly aligned uniform offset.
    expect(buffers.getDrawInfo(0).meshUniformOffset).toBe(0);
    expect(buffers.getDrawInfo(1).meshUniformOffset).toBe(256);
    expect(buffers.getDrawInfo(0).instanceCount).toBe(2);
    expect(buffers.getDrawInfo(1).firstInstance).toBe(2);
    expect(buffers.getDrawInfo(1).indexCount).toBe(36);
    expect(buffers.getDrawInfo(1).vertexOffset).toBe(4);
  });

  it('honours device alignment when it exceeds 256', () => {
    const device = new MockDevice();
    device.limits.minUniformBufferOffsetAlignment = 1024;
    const source = buildSource({
      meshes: [
        { aabbMin: [0, 0, 0], aabbMax: [1, 1, 1], vertexCount: 1, indexCount: 0, instanceCount: 1 },
      ],
    });
    const buffers = new QuantizedSceneBuffers(device as unknown as GPUDevice, source);
    expect(buffers.meshUniformAlignment).toBe(1024);
    expect(buffers.getDrawInfo(0).meshUniformOffset).toBe(0);
    expect((buffers.getMeshUniformBuffer() as unknown as MockBuffer).size).toBe(1024);
  });

  it('setInstanceFlags writes 4 bytes at the right offset', () => {
    const device = new MockDevice();
    const source = buildSource({
      meshes: [
        { aabbMin: [0, 0, 0], aabbMax: [1, 1, 1], vertexCount: 0, indexCount: 0, instanceCount: 3 },
      ],
    });
    const buffers = new QuantizedSceneBuffers(device as unknown as GPUDevice, source);
    const writesBefore = device.writes.length;

    buffers.setInstanceFlags(1, INSTANCE_FLAGS.visible | INSTANCE_FLAGS.selected);

    const newWrites = device.writes.slice(writesBefore);
    expect(newWrites.length).toBe(1);
    const w = newWrites[0]!;
    expect(w.buffer).toBe(buffers.getInstanceBuffer() as unknown as MockBuffer);
    expect(w.bufferOffset).toBe(1 * QUANTIZED_INSTANCE_RECORD_SIZE + INSTANCE_FIELD_OFFSETS.flags);
    expect(w.bytes.length).toBe(4);
    const dv = new DataView(w.bytes.buffer, w.bytes.byteOffset, w.bytes.byteLength);
    expect(dv.getUint32(0, true)).toBe(INSTANCE_FLAGS.visible | INSTANCE_FLAGS.selected);
    expect(buffers.getInstanceFlags(1)).toBe(INSTANCE_FLAGS.visible | INSTANCE_FLAGS.selected);
  });

  it('setInstanceOverride writes the override slot only', () => {
    const device = new MockDevice();
    const source = buildSource({
      meshes: [
        { aabbMin: [0, 0, 0], aabbMax: [1, 1, 1], vertexCount: 0, indexCount: 0, instanceCount: 2 },
      ],
    });
    const buffers = new QuantizedSceneBuffers(device as unknown as GPUDevice, source);
    const writesBefore = device.writes.length;
    buffers.setInstanceOverride(0, 0xff112233);
    const w = device.writes.slice(writesBefore)[0]!;
    expect(w.bufferOffset).toBe(INSTANCE_FIELD_OFFSETS.override);
    expect(w.bytes.length).toBe(4);
    const dv = new DataView(w.bytes.buffer, w.bytes.byteOffset, w.bytes.byteLength);
    expect(dv.getUint32(0, true)).toBe(0xff112233);
  });

  it('setInstanceSelected toggles only bit 1, preserves bit 0', () => {
    const device = new MockDevice();
    const source = buildSource({
      meshes: [
        { aabbMin: [0, 0, 0], aabbMax: [1, 1, 1], vertexCount: 0, indexCount: 0, instanceCount: 1 },
      ],
    });
    const buffers = new QuantizedSceneBuffers(device as unknown as GPUDevice, source);
    expect(buffers.getInstanceFlags(0) & INSTANCE_FLAGS.visible).toBe(INSTANCE_FLAGS.visible);

    buffers.setInstanceSelected(0, true);
    expect(buffers.getInstanceFlags(0) & INSTANCE_FLAGS.selected).toBe(INSTANCE_FLAGS.selected);
    expect(buffers.getInstanceFlags(0) & INSTANCE_FLAGS.visible).toBe(INSTANCE_FLAGS.visible);

    buffers.setInstanceSelected(0, false);
    expect(buffers.getInstanceFlags(0) & INSTANCE_FLAGS.selected).toBe(0);
    expect(buffers.getInstanceFlags(0) & INSTANCE_FLAGS.visible).toBe(INSTANCE_FLAGS.visible);
  });

  it('findInstanceIndexByExpressId returns -1 for unknown ids and indexes known ones', () => {
    const device = new MockDevice();
    const source = buildSource({
      meshes: [
        { aabbMin: [0, 0, 0], aabbMax: [1, 1, 1], vertexCount: 0, indexCount: 0, instanceCount: 4 },
      ],
    });
    const buffers = new QuantizedSceneBuffers(device as unknown as GPUDevice, source);
    // Source seeds expressIds starting at 1000, so we should find them.
    const idx = buffers.findInstanceIndexByExpressId(1002);
    expect(idx).toBe(2);
    expect(buffers.findInstanceIndexByExpressId(99999)).toBe(-1);
  });

  it('rejects out-of-range instance indices', () => {
    const device = new MockDevice();
    const source = buildSource({
      meshes: [
        { aabbMin: [0, 0, 0], aabbMax: [1, 1, 1], vertexCount: 0, indexCount: 0, instanceCount: 2 },
      ],
    });
    const buffers = new QuantizedSceneBuffers(device as unknown as GPUDevice, source);
    expect(() => buffers.setInstanceFlags(-1, 0)).toThrow();
    expect(() => buffers.setInstanceFlags(2, 0)).toThrow();
    expect(() => buffers.getInstanceFlags(2)).toThrow();
  });

  it('rejects malformed sources', () => {
    const device = new MockDevice();
    expect(() =>
      new QuantizedSceneBuffers(device as unknown as GPUDevice, {
        vertexData: new Uint8Array(0),
        indexData: new Uint32Array(0),
        meshTable: new Uint8Array(7), // not a multiple of 64
        instanceData: new Uint8Array(0),
        meshCount: 1,
        instanceCount: 0,
        totalVertexCount: 0,
      }),
    ).toThrow();
  });

  it('destroy releases all GPU buffers', () => {
    const device = new MockDevice();
    const source = buildSource({
      meshes: [
        { aabbMin: [0, 0, 0], aabbMax: [1, 1, 1], vertexCount: 1, indexCount: 0, instanceCount: 1 },
      ],
    });
    const buffers = new QuantizedSceneBuffers(device as unknown as GPUDevice, source);
    const allBefore = device.buffers.filter((b) => !b.destroyed).length;
    buffers.destroy();
    const liveAfter = device.buffers.filter((b) => !b.destroyed).length;
    expect(liveAfter).toBeLessThan(allBefore);
    // Specifically: vertex + index + meshUniform + instance + indirect = 5 buffers we own.
    expect(allBefore - liveAfter).toBe(5);
  });
});

describe('quantizedShaderSource', () => {
  it('declares vertex and fragment entry points', () => {
    expect(quantizedShaderSource).toMatch(/@vertex\s+fn\s+vs_main/);
    expect(quantizedShaderSource).toMatch(/@fragment\s+fn\s+fs_main/);
  });

  it('binds the three expected resources at @group(0)', () => {
    expect(quantizedShaderSource).toMatch(/@binding\(0\)\s*@group\(0\)\s*var<uniform>\s*uniforms/);
    expect(quantizedShaderSource).toMatch(/@binding\(1\)\s*@group\(0\)\s*var<uniform>\s*mesh/);
    expect(quantizedShaderSource).toMatch(/@binding\(2\)\s*@group\(0\)\s*var<storage,\s*read>\s*instances/);
  });

  it('declares the quantised vertex layout', () => {
    expect(quantizedShaderSource).toMatch(/@location\(0\)\s*position_q:\s*vec4<f32>/);
    expect(quantizedShaderSource).toMatch(/@location\(1\)\s*normal_oct:\s*vec4<f32>/);
  });

  it('packs instance fields into a vec4<u32>', () => {
    expect(quantizedShaderSource).toMatch(/packed:\s*vec4<u32>/);
  });
});
