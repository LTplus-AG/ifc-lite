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
  INDIRECT: number;
  COPY_DST: number;
} =
  typeof GPUBufferUsage !== 'undefined'
    ? GPUBufferUsage
    : {
        VERTEX: 0x20,
        INDEX: 0x10,
        UNIFORM: 0x40,
        STORAGE: 0x80,
        INDIRECT: 0x100,
        COPY_DST: 0x08,
      };

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
  /** Mesh-local AABB minimum corner (used as quantisation basis on the GPU). */
  aabbMin: [number, number, number];
  /** Mesh-local AABB maximum corner. */
  aabbMax: [number, number, number];
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
  /**
   * Pre-baked indirect-draw command buffer: 5 × u32 per mesh
   * (`indexCount`, `instanceCount`, `firstIndex`, `baseVertex`, `firstInstance`),
   * total `meshCount * 20` bytes. Lets the render loop call
   * `drawIndexedIndirect(buffer, mesh * 20)` instead of repacking JS args
   * for `drawIndexed(...)` every frame, and is the substrate for future
   * GPU-driven frustum culling (a compute shader patches `instanceCount`
   * to zero for off-screen meshes).
   */
  private readonly indirectBuffer: GPUBuffer;

  /** CPU mirror of the instance SSBO; kept in sync with GPU writes. */
  private readonly instanceMirror: Uint8Array;

  /** Per-mesh aligned offset into `meshUniformBuffer`. */
  private readonly meshUniformOffsets: Uint32Array;

  /** Resolved per-mesh draw info (parallel to `meshUniformOffsets`). */
  private readonly drawInfos: MeshDrawInfo[];

  /** Map: expressId → instance index. Built lazily on first lookup. */
  private expressIdLookup: Map<number, number> | null = null;

  /** Map: instance index → mesh index. Built lazily on first need. */
  private instanceToMesh: Uint32Array | null = null;

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
        // aabb_min: vec4<f32> at bytes 0..16 (xyz used)
        // aabb_max: vec4<f32> at bytes 16..32
        // vertexInfo lives at byte 32; instanceInfo at byte 48.
        const aabbMinX = dv.getFloat32(recordOffset + 0, true);
        const aabbMinY = dv.getFloat32(recordOffset + 4, true);
        const aabbMinZ = dv.getFloat32(recordOffset + 8, true);
        const aabbMaxX = dv.getFloat32(recordOffset + 16, true);
        const aabbMaxY = dv.getFloat32(recordOffset + 20, true);
        const aabbMaxZ = dv.getFloat32(recordOffset + 24, true);
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
          aabbMin: [aabbMinX, aabbMinY, aabbMinZ],
          aabbMax: [aabbMaxX, aabbMaxY, aabbMaxZ],
        };
      }
      device.queue.writeBuffer(this.meshUniformBuffer, 0, meshUploadStaging);
    }

    // ── Indirect-draw command buffer ──
    // Five u32 per mesh: indexCount, instanceCount, firstIndex, baseVertex,
    // firstInstance. Written once at construction; immutable thereafter
    // (instance flag/colour patches go through the SSBO, not here).
    const indirectStride = 20;
    const indirectSize = Math.max(indirectStride, source.meshCount * indirectStride);
    this.indirectBuffer = device.createBuffer({
      size: indirectSize,
      usage: BUFFER_USAGE.INDIRECT | BUFFER_USAGE.COPY_DST | BUFFER_USAGE.STORAGE,
    });
    if (source.meshCount > 0) {
      const indirectData = new Uint32Array(source.meshCount * 5);
      for (let i = 0; i < source.meshCount; i++) {
        const di = this.drawInfos[i]!;
        const o = i * 5;
        indirectData[o] = di.indexCount;
        indirectData[o + 1] = di.instanceCount;
        indirectData[o + 2] = di.indexOffset;
        indirectData[o + 3] = di.vertexOffset; // baseVertex (read as i32)
        indirectData[o + 4] = 0; // firstInstance — instance offset is in the SSBO
      }
      device.queue.writeBuffer(this.indirectBuffer, 0, indirectData);
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

  /** Indirect-draw command buffer (5 × u32 per mesh, mesh-major). */
  getIndirectBuffer(): GPUBuffer {
    return this.indirectBuffer;
  }

  /** Byte stride between indirect commands. Useful for `drawIndexedIndirect` offsets. */
  static readonly INDIRECT_STRIDE = 20;

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

  /**
   * Read the column-major 4×4 transform of an instance into a fresh
   * `Float32Array(16)`. Used by CPU-side fit-to-view bound computation and
   * future raycast support.
   */
  getInstanceTransform(instanceIndex: number): Float32Array {
    this.assertInstanceIndex(instanceIndex);
    const out = new Float32Array(16);
    const dv = new DataView(this.instanceMirror.buffer, this.instanceMirror.byteOffset, this.instanceMirror.byteLength);
    const base = instanceIndex * QUANTIZED_INSTANCE_RECORD_SIZE;
    for (let i = 0; i < 16; i++) {
      out[i] = dv.getFloat32(base + i * 4, true);
    }
    return out;
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
    this.indirectBuffer.destroy();
  }

  /**
   * Lazily materialise a list of instances as legacy `MeshData[]` (one per
   * instance) — world-space, fully-decoded, transformed positions and normals
   * with the instance's `expressId` and base colour. Used by snap detection
   * and the section-plane cap renderer to keep their existing `MeshData[]`-
   * based code paths working without a global f32 mirror.
   *
   * The dequantisation here mirrors the GPU shader exactly: `mix(aabbMin,
   * aabbMax, q/65535)` for positions, octahedral decode for normals, then
   * `inst.transform * (local, 1)` and the same Z-up→Y-up swap. Caller passes
   * the snapshot's vertex/index/instance views so the buffers class doesn't
   * need to retain the snapshot itself.
   */
  materializeInstancesAsMeshData(
    instanceIndices: readonly number[],
    vertexData: Uint8Array,
    indexData: Uint32Array,
  ): MaterializedMeshData[] {
    const out: MaterializedMeshData[] = [];
    if (instanceIndices.length === 0) return out;

    // Map instanceIndex → meshIndex via a flat reverse index.
    if (!this.instanceToMesh) {
      const i2m = new Uint32Array(this.instanceCount);
      for (let m = 0; m < this.drawInfos.length; m++) {
        const di = this.drawInfos[m]!;
        for (let k = 0; k < di.instanceCount; k++) {
          i2m[di.firstInstance + k] = m;
        }
      }
      this.instanceToMesh = i2m;
    }
    const i2m = this.instanceToMesh;

    for (const inst of instanceIndices) {
      if (!Number.isInteger(inst) || inst < 0 || inst >= this.instanceCount) continue;
      const meshIndex = i2m[inst]!;
      const di = this.drawInfos[meshIndex]!;
      const t = this.getInstanceTransform(inst);
      const expressId = this.getInstanceExpressId(inst);
      const off = inst * QUANTIZED_INSTANCE_RECORD_SIZE;
      const baseColorPacked = readU32LE(this.instanceMirror, off + INSTANCE_FIELD_OFFSETS.baseColor);

      const aabbMinX = di.aabbMin[0];
      const aabbMinY = di.aabbMin[1];
      const aabbMinZ = di.aabbMin[2];
      const rangeX = di.aabbMax[0] - aabbMinX;
      const rangeY = di.aabbMax[1] - aabbMinY;
      const rangeZ = di.aabbMax[2] - aabbMinZ;

      const vc = di.vertexCount;
      const positions = new Float32Array(vc * 3);
      const normals = new Float32Array(vc * 3);
      for (let v = 0; v < vc; v++) {
        const vBase = (di.vertexOffset + v) * 12;
        // unorm16x4 → 0..1 scaled to local AABB.
        const px = (vertexData[vBase]! | (vertexData[vBase + 1]! << 8)) / 65535;
        const py = (vertexData[vBase + 2]! | (vertexData[vBase + 3]! << 8)) / 65535;
        const pz = (vertexData[vBase + 4]! | (vertexData[vBase + 5]! << 8)) / 65535;
        const lx = aabbMinX + px * rangeX;
        const ly = aabbMinY + py * rangeY;
        const lz = aabbMinZ + pz * rangeZ;
        // Apply instance transform (Z-up world).
        const wx = t[0]! * lx + t[4]! * ly + t[ 8]! * lz + t[12]!;
        const wy = t[1]! * lx + t[5]! * ly + t[ 9]! * lz + t[13]!;
        const wz = t[2]! * lx + t[6]! * ly + t[10]! * lz + t[14]!;
        // Z-up → Y-up: (x, y, z) → (x, z, -y) — same swap as the shader.
        positions[v * 3] = wx;
        positions[v * 3 + 1] = wz;
        positions[v * 3 + 2] = -wy;

        // snorm8x4 → -1..1; xy is the octahedral pair.
        const ex = (this.signed8(vertexData[vBase + 8]!)) / 127;
        const ey = (this.signed8(vertexData[vBase + 9]!)) / 127;
        // Octahedral decode (mirrors quantized.wgsl.ts octDecode).
        let nx = ex;
        let ny = ey;
        let nz = 1 - Math.abs(ex) - Math.abs(ey);
        if (nz < 0) {
          const tt = -nz;
          const sx = nx >= 0 ? tt : -tt;
          const sy = ny >= 0 ? tt : -tt;
          nx = nx + sx;
          ny = ny + sy;
        }
        const nLen = Math.hypot(nx, ny, nz) || 1;
        nx /= nLen; ny /= nLen; nz /= nLen;
        // Rotate normal by transform (rotation part) then Z-up → Y-up.
        const rx = t[0]! * nx + t[4]! * ny + t[ 8]! * nz;
        const ry = t[1]! * nx + t[5]! * ny + t[ 9]! * nz;
        const rz = t[2]! * nx + t[6]! * ny + t[10]! * nz;
        normals[v * 3] = rx;
        normals[v * 3 + 1] = rz;
        normals[v * 3 + 2] = -ry;
      }

      // Indices are mesh-local; copy as-is so callers can index into our
      // per-instance positions[] directly.
      const iStart = di.indexOffset;
      const iEnd = iStart + di.indexCount;
      const indices = indexData.slice(iStart, iEnd);

      out.push({
        expressId,
        positions,
        normals,
        indices,
        color: unpackRgba8ToFloats(baseColorPacked),
      });
    }
    return out;
  }

  private signed8(byte: number): number {
    return byte > 127 ? byte - 256 : byte;
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

/** Result shape from `materializeInstancesAsMeshData` — a per-instance
 * `MeshData`-equivalent in world (Y-up) space, ready for legacy raycaster /
 * snap detector / section cap renderer code paths.
 */
export interface MaterializedMeshData {
  expressId: number;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  color: [number, number, number, number];
}

function unpackRgba8ToFloats(p: number): [number, number, number, number] {
  return [
    (p & 0xff) / 255,
    ((p >>> 8) & 0xff) / 255,
    ((p >>> 16) & 0xff) / 255,
    ((p >>> 24) & 0xff) / 255,
  ];
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
