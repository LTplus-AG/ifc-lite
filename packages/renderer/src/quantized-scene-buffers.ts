/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU buffer wrapper around a `QuantizedScene` produced by
 * `parseQuantizedInstanced` in the WASM bridge. Owns four buffers (vertex,
 * index, per-mesh uniform, per-instance SSBO) plus a CPU-side mirror of the
 * instance buffer so per-instance flag/override patches can be applied with
 * a single 4-byte `writeBuffer`.
 *
 * Uniforms in WebGPU need slots aligned to `minUniformBufferOffsetAlignment`
 * (256 by default, sometimes higher on mobile). Each 64-byte mesh record from
 * WASM is therefore re-packed into an aligned slot when uploading.
 */

import {
  INSTANCE_FIELD_OFFSETS,
  INSTANCE_FLAGS,
  QUANTIZED_INSTANCE_RECORD_SIZE,
  QUANTIZED_MESH_RECORD_SIZE,
} from './quantized-pipeline.js';

// `GPUBufferUsage` is a browser global; provide a fallback so this file can be
// imported (and unit-tested) under Node. Values come from the WebGPU spec.
const BUFFER_USAGE: {
  VERTEX: number;
  INDEX: number;
  UNIFORM: number;
  STORAGE: number;
  COPY_DST: number;
} =
  typeof GPUBufferUsage !== 'undefined'
    ? GPUBufferUsage
    : { VERTEX: 0x20, INDEX: 0x10, UNIFORM: 0x40, STORAGE: 0x80, COPY_DST: 0x08 };

/** Shape of the `QuantizedScene` exposed by the WASM bridge that we depend on. */
export interface QuantizedSceneSource {
  /** Interleaved vertex bytes (12 B/vertex). */
  vertexData: Uint8Array;
  /** Mesh-local indices. */
  indexData: Uint32Array;
  /** Per-mesh records, 64 B each. */
  meshTable: Uint8Array;
  /** Per-instance records, 80 B each. */
  instanceData: Uint8Array;
  meshCount: number;
  instanceCount: number;
  totalVertexCount: number;
}

/** One mesh's draw parameters resolved from the table. */
export interface MeshDrawInfo {
  vertexOffset: number; // baseVertex
  vertexCount: number;
  indexOffset: number; // firstIndex
  indexCount: number;
  firstInstance: number;
  instanceCount: number;
  /** Aligned offset into the per-mesh uniform buffer. */
  meshUniformOffset: number;
}

/**
 * Owns the four GPU buffers plus the CPU mirrors needed to patch instances
 * cheaply at runtime.
 */
export class QuantizedSceneBuffers {
  private readonly device: GPUDevice;
  private readonly vertexBuffer: GPUBuffer;
  private readonly indexBuffer: GPUBuffer;
  private readonly meshUniformBuffer: GPUBuffer;
  private readonly instanceBuffer: GPUBuffer;

  /** CPU mirror of the instance SSBO; kept in sync with GPU writes. */
  private readonly instanceMirror: Uint8Array;

  /** Per-mesh aligned offset into `meshUniformBuffer`. */
  private readonly meshUniformOffsets: Uint32Array;

  /** Resolved per-mesh draw info (parallel to `meshUniformOffsets`). */
  private readonly drawInfos: MeshDrawInfo[];

  /** Map: expressId → instance index. Built lazily on first lookup. */
  private expressIdLookup: Map<number, number> | null = null;

  readonly meshCount: number;
  readonly instanceCount: number;
  readonly meshUniformAlignment: number;

  constructor(device: GPUDevice, source: QuantizedSceneSource) {
    this.device = device;
    this.meshCount = source.meshCount;
    this.instanceCount = source.instanceCount;

    if (source.meshTable.byteLength !== source.meshCount * QUANTIZED_MESH_RECORD_SIZE) {
      throw new Error(
        `meshTable byte length ${source.meshTable.byteLength} does not match ${source.meshCount} × ${QUANTIZED_MESH_RECORD_SIZE}`,
      );
    }
    if (source.instanceData.byteLength !== source.instanceCount * QUANTIZED_INSTANCE_RECORD_SIZE) {
      throw new Error(
        `instanceData byte length ${source.instanceData.byteLength} does not match ${source.instanceCount} × ${QUANTIZED_INSTANCE_RECORD_SIZE}`,
      );
    }

    const limits = device.limits;
    this.meshUniformAlignment = Math.max(256, limits.minUniformBufferOffsetAlignment ?? 256);

    // ── Vertex buffer ──
    this.vertexBuffer = device.createBuffer({
      size: alignTo4(source.vertexData.byteLength),
      usage: BUFFER_USAGE.VERTEX | BUFFER_USAGE.COPY_DST,
    });
    if (source.vertexData.byteLength > 0) {
      device.queue.writeBuffer(this.vertexBuffer, 0, source.vertexData);
    }

    // ── Index buffer ──
    this.indexBuffer = device.createBuffer({
      size: Math.max(4, source.indexData.byteLength),
      usage: BUFFER_USAGE.INDEX | BUFFER_USAGE.COPY_DST,
    });
    if (source.indexData.byteLength > 0) {
      device.queue.writeBuffer(this.indexBuffer, 0, source.indexData);
    }

    // ── Per-mesh uniform buffer (slot-aligned) ──
    const slotSize = this.meshUniformAlignment;
    const meshBufferSize = Math.max(slotSize, slotSize * source.meshCount);
    this.meshUniformBuffer = device.createBuffer({
      size: meshBufferSize,
      usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
    });
    this.meshUniformOffsets = new Uint32Array(source.meshCount);
    this.drawInfos = new Array(source.meshCount);

    if (source.meshCount > 0) {
      const meshUploadStaging = new Uint8Array(meshBufferSize);
      const meshTableView = source.meshTable;
      const dv = new DataView(meshTableView.buffer, meshTableView.byteOffset, meshTableView.byteLength);

      for (let i = 0; i < source.meshCount; i++) {
        const recordOffset = i * QUANTIZED_MESH_RECORD_SIZE;
        const slotOffset = i * slotSize;
        meshUploadStaging.set(
          meshTableView.subarray(recordOffset, recordOffset + QUANTIZED_MESH_RECORD_SIZE),
          slotOffset,
        );
        this.meshUniformOffsets[i] = slotOffset;
        // vertexInfo lives at byte 32; instanceInfo at byte 48.
        const vertexOffset = dv.getUint32(recordOffset + 32, true);
        const vertexCount = dv.getUint32(recordOffset + 36, true);
        const indexOffset = dv.getUint32(recordOffset + 40, true);
        const indexCount = dv.getUint32(recordOffset + 44, true);
        const firstInstance = dv.getUint32(recordOffset + 48, true);
        const instanceCountForMesh = dv.getUint32(recordOffset + 52, true);
        this.drawInfos[i] = {
          vertexOffset,
          vertexCount,
          indexOffset,
          indexCount,
          firstInstance,
          instanceCount: instanceCountForMesh,
          meshUniformOffset: slotOffset,
        };
      }
      device.queue.writeBuffer(this.meshUniformBuffer, 0, meshUploadStaging);
    }

    // ── Per-instance SSBO ──
    const instanceBufferSize = Math.max(QUANTIZED_INSTANCE_RECORD_SIZE, source.instanceData.byteLength);
    this.instanceBuffer = device.createBuffer({
      size: instanceBufferSize,
      usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST,
    });
    // Mirror the source bytes so per-instance patches can be applied without
    // round-tripping the GPU buffer.
    this.instanceMirror = new Uint8Array(instanceBufferSize);
    if (source.instanceData.byteLength > 0) {
      this.instanceMirror.set(source.instanceData, 0);
      device.queue.writeBuffer(this.instanceBuffer, 0, source.instanceData);
    }
  }

  /** Resolved draw info for one mesh slot (0 ≤ index < meshCount). */
  getDrawInfo(meshIndex: number): MeshDrawInfo {
    const info = this.drawInfos[meshIndex];
    if (!info) {
      throw new RangeError(`mesh index ${meshIndex} out of range (meshCount=${this.meshCount})`);
    }
    return info;
  }

  /** Iterator over all draw infos, in scene order. */
  iterDrawInfos(): readonly MeshDrawInfo[] {
    return this.drawInfos;
  }

  getVertexBuffer(): GPUBuffer {
    return this.vertexBuffer;
  }

  getIndexBuffer(): GPUBuffer {
    return this.indexBuffer;
  }

  getMeshUniformBuffer(): GPUBuffer {
    return this.meshUniformBuffer;
  }

  getInstanceBuffer(): GPUBuffer {
    return this.instanceBuffer;
  }

  /** Read the current `flags` byte for an instance (0 ≤ index < instanceCount). */
  getInstanceFlags(instanceIndex: number): number {
    this.assertInstanceIndex(instanceIndex);
    const off = instanceIndex * QUANTIZED_INSTANCE_RECORD_SIZE + INSTANCE_FIELD_OFFSETS.flags;
    return readU32LE(this.instanceMirror, off);
  }

  /** Patch the per-instance flags. Single 4-byte GPU write. */
  setInstanceFlags(instanceIndex: number, flags: number): void {
    this.assertInstanceIndex(instanceIndex);
    const off = instanceIndex * QUANTIZED_INSTANCE_RECORD_SIZE + INSTANCE_FIELD_OFFSETS.flags;
    writeU32LE(this.instanceMirror, off, flags);
    this.device.queue.writeBuffer(
      this.instanceBuffer,
      off,
      this.instanceMirror.buffer,
      this.instanceMirror.byteOffset + off,
      4,
    );
  }

  /** Patch the per-instance colour override (0 = use base colour). */
  setInstanceOverride(instanceIndex: number, packedRgba8: number): void {
    this.assertInstanceIndex(instanceIndex);
    const off = instanceIndex * QUANTIZED_INSTANCE_RECORD_SIZE + INSTANCE_FIELD_OFFSETS.override;
    writeU32LE(this.instanceMirror, off, packedRgba8);
    this.device.queue.writeBuffer(
      this.instanceBuffer,
      off,
      this.instanceMirror.buffer,
      this.instanceMirror.byteOffset + off,
      4,
    );
  }

  /** Read the `expressId` baked into an instance record. */
  getInstanceExpressId(instanceIndex: number): number {
    this.assertInstanceIndex(instanceIndex);
    const off = instanceIndex * QUANTIZED_INSTANCE_RECORD_SIZE + INSTANCE_FIELD_OFFSETS.expressId;
    return readU32LE(this.instanceMirror, off);
  }

  /** Toggle the `visible` bit (bit 0). */
  setInstanceVisible(instanceIndex: number, visible: boolean): void {
    const cur = this.getInstanceFlags(instanceIndex);
    this.setInstanceFlags(
      instanceIndex,
      visible ? cur | INSTANCE_FLAGS.visible : cur & ~INSTANCE_FLAGS.visible,
    );
  }

  /** Toggle the `selected` bit (bit 1). */
  setInstanceSelected(instanceIndex: number, selected: boolean): void {
    const cur = this.getInstanceFlags(instanceIndex);
    this.setInstanceFlags(
      instanceIndex,
      selected ? cur | INSTANCE_FLAGS.selected : cur & ~INSTANCE_FLAGS.selected,
    );
  }

  /** Toggle the `ghost` bit (bit 2). */
  setInstanceGhost(instanceIndex: number, ghost: boolean): void {
    const cur = this.getInstanceFlags(instanceIndex);
    this.setInstanceFlags(
      instanceIndex,
      ghost ? cur | INSTANCE_FLAGS.ghost : cur & ~INSTANCE_FLAGS.ghost,
    );
  }

  /**
   * Find the instance index for a given `expressId`.
   *
   * Builds a lookup table on first call; subsequent calls are O(1). Returns
   * `-1` if the expressId is not in the scene. If the same expressId appears
   * on multiple instances (legal — same element placed multiple times), the
   * last one wins; callers needing all matches should iterate the SSBO.
   */
  findInstanceIndexByExpressId(expressId: number): number {
    if (!this.expressIdLookup) {
      const map = new Map<number, number>();
      for (let i = 0; i < this.instanceCount; i++) {
        map.set(this.getInstanceExpressId(i), i);
      }
      this.expressIdLookup = map;
    }
    return this.expressIdLookup.get(expressId) ?? -1;
  }

  /** Drop all GPU buffers. */
  destroy(): void {
    this.vertexBuffer.destroy();
    this.indexBuffer.destroy();
    this.meshUniformBuffer.destroy();
    this.instanceBuffer.destroy();
  }

  private assertInstanceIndex(idx: number): void {
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.instanceCount) {
      throw new RangeError(`instance index ${idx} out of range (instanceCount=${this.instanceCount})`);
    }
  }
}

function alignTo4(n: number): number {
  return (n + 3) & ~3;
}

function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset]! |
      (buf[offset + 1]! << 8) |
      (buf[offset + 2]! << 16) |
      (buf[offset + 3]! << 24)) >>>
    0
  );
}

function writeU32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}
