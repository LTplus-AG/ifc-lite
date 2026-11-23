/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared geometry arenas for the draw stream (`DrawStreamConfig.arena`).
 *
 * Every colour batch's vertex, index and LOD1 index ranges are copied GPU-side
 * into a few large buffers per vertex layout (12 B quantized, 28 B f32),
 * grouped by chunk cell so a node's batches share one vertex and one index
 * buffer. A stream draw then differs from its neighbour only in
 * `firstIndex`/`baseVertex`/`firstInstance`: one `drawIndexed` per batch
 * instead of setVertexBuffer + setIndexBuffer + drawIndexed.
 *
 * Spike cost: the copies DUPLICATE batch geometry on the GPU (the batches keep
 * their own buffers for the legacy path, highlight and picking). Productising
 * means uploading straight into the arena and giving `BatchedMesh` an
 * (arena, offset) instead of its own buffers.
 */
import type { BatchedMesh } from './types.js';

export interface ArenaSlot {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  baseVertex: number;
  first0: number;
  count0: number;
  /** LOD1 range in the same index buffer; count1 = 0 when the batch has no LOD1. */
  first1: number;
  count1: number;
}

const CHUNK_BYTES = 256 * 1024 * 1024;

interface Chunk { stride: number; vertexBytes: number; indexBytes: number; items: { b: BatchedMesh; v: number; i0: number; i1: number }[] }

export class GeometryArena {
  readonly slots = new Map<BatchedMesh, ArenaSlot>();
  private buffers: GPUBuffer[] = [];
  bytes = 0;

  /** Null when some batch cannot be copied (no COPY_SRC) or is not resident. */
  static build(device: GPUDevice, batches: readonly BatchedMesh[], cellOf: (b: BatchedMesh) => string): GeometryArena | null {
    const ordered = [...batches].filter((b) => b.gpuResident !== false);
    for (const b of ordered) {
      if ((b.vertexBuffer.usage & GPUBufferUsage.COPY_SRC) === 0 || (b.indexBuffer.usage & GPUBufferUsage.COPY_SRC) === 0) return null;
      if (b.lod1IndexBuffer && (b.lod1IndexBuffer.usage & GPUBufferUsage.COPY_SRC) === 0) return null;
    }
    const keyed = ordered.map((b) => ({ b, k: `${b.quantized ? 'q' : 'f'}|${cellOf(b)}` })).sort((x, y) => (x.k < y.k ? -1 : x.k > y.k ? 1 : 0));
    const chunks: Chunk[] = [];
    const open = new Map<number, Chunk>();
    for (const { b } of keyed) {
      const stride = b.quantized ? 12 : 28;
      const vBytes = b.vertexBuffer.size - (b.vertexBuffer.size % stride);
      const iBytes = b.indexCount * 4 + (b.lod1IndexBuffer && b.lod1IndexCount ? b.lod1IndexCount * 4 : 0);
      let c = open.get(stride);
      if (!c || c.vertexBytes + vBytes > CHUNK_BYTES || c.indexBytes + iBytes > CHUNK_BYTES) {
        c = { stride, vertexBytes: 0, indexBytes: 0, items: [] }; open.set(stride, c); chunks.push(c);
      }
      const i0 = c.indexBytes; const i1 = i0 + b.indexCount * 4;
      c.items.push({ b, v: c.vertexBytes, i0, i1 });
      c.vertexBytes += vBytes; c.indexBytes += iBytes;
    }
    const arena = new GeometryArena();
    const enc = device.createCommandEncoder({ label: 'draw-stream-arena-copy' });
    for (const c of chunks) {
      const vb = device.createBuffer({ label: 'draw-stream-arena-vertices', size: Math.max(4, c.vertexBytes), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      const ib = device.createBuffer({ label: 'draw-stream-arena-indices', size: Math.max(4, c.indexBytes), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      arena.buffers.push(vb, ib); arena.bytes += vb.size + ib.size;
      for (const it of c.items) {
        const b = it.b; const vBytes = b.vertexBuffer.size - (b.vertexBuffer.size % c.stride);
        if (vBytes > 0) enc.copyBufferToBuffer(b.vertexBuffer, 0, vb, it.v, vBytes);
        if (b.indexCount > 0) enc.copyBufferToBuffer(b.indexBuffer, 0, ib, it.i0, b.indexCount * 4);
        const lod = b.lod1IndexBuffer && b.lod1IndexCount ? b.lod1IndexCount : 0;
        if (lod > 0) enc.copyBufferToBuffer(b.lod1IndexBuffer!, 0, ib, it.i1, lod * 4);
        arena.slots.set(b, { vertexBuffer: vb, indexBuffer: ib, baseVertex: it.v / c.stride, first0: it.i0 / 4, count0: b.indexCount, first1: it.i1 / 4, count1: lod });
      }
    }
    device.queue.submit([enc.finish()]);
    return arena;
  }

  destroy(): void { for (const b of this.buffers) b.destroy(); this.buffers = []; this.slots.clear(); this.bytes = 0; }
}
