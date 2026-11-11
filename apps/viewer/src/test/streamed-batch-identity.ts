/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import { Scene, type BatchedMesh, type RenderPipeline } from '@ifc-lite/renderer';

/**
 * Stream real meshes into a renderer Scene the way the viewer does (one queue
 * and drain per arrival, then the time-sliced finalize) on a GPU stand-in that
 * keeps every buffer's bytes, so the final batches can be decoded and compared.
 */
const USAGE = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
type StubBuffer = { size: number; usage: number; bytes: Uint8Array; destroyed: boolean; destroy(): void };

function bytesDevice(): GPUDevice {
  (globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage ??= USAGE;
  return {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer({ size, usage }: GPUBufferDescriptor): StubBuffer {
      const buffer: StubBuffer = { size, usage, bytes: new Uint8Array(size), destroyed: false, destroy() { buffer.destroyed = true; } };
      return buffer;
    },
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      copyBufferToBuffer(from: StubBuffer, fromOffset: number, to: StubBuffer, toOffset: number, size: number) {
        if (from.destroyed) throw new Error('copy from a destroyed buffer');
        to.bytes.set(from.bytes.subarray(fromOffset, fromOffset + size), toOffset);
      },
      finish: () => ({}),
    }),
    queue: {
      submit() {},
      writeBuffer(buffer: StubBuffer, offset: number, data: ArrayBuffer | ArrayBufferView, dataOffset = 0, size?: number) {
        const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        buffer.bytes.set(view.subarray(dataOffset, size === undefined ? undefined : dataOffset + size), offset);
      },
    },
  } as unknown as GPUDevice;
}

const pipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as RenderPipeline;

export interface StreamedScene { scene: Scene; batches: BatchedMesh[] }

/** The viewer's settings: 32 m chunks, LOD1, quantized batches. `rebuild` forces every final batch through the CPU rebuild. */
export async function streamIntoScene(meshes: readonly MeshData[], options: { arrival?: number; rebuild?: boolean; capture?: boolean } = {}): Promise<StreamedScene> {
  const device = bytesDevice();
  const scene = new Scene();
  scene.setSpatialChunking({ cellSize: 32 });
  scene.setLodBuildsEnabled(true);
  scene.setQuantizedBatches(true);
  if (options.rebuild) (scene as unknown as { streamWork: { assemble: () => null } }).streamWork.assemble = () => null;
  if (options.capture) scene.captureNextFinalize(() => {});
  const arrival = options.arrival ?? 200;
  for (let at = 0; at < meshes.length; at += arrival) {
    // Fresh objects per side: the scene registers and may re-key the meshes it is given.
    scene.queueMeshes(meshes.slice(at, at + arrival).map((mesh) => ({ ...mesh })));
    for (let flushes = 0; scene.hasQueuedMeshes(); flushes++) {
      if (flushes > 10_000) throw new Error('flushPending made no progress');
      scene.flushPending(device, pipeline, 1e9);
    }
  }
  await scene.finalizeStreamingAsync(device, pipeline, 1e9);
  return { scene, batches: scene.getBatchedMeshes() };
}

function bufferBytes(buffer: GPUBuffer | undefined): Uint8Array { return (buffer as unknown as StubBuffer).bytes; }

/** Vertex `v` of `batch`, decoded to what the shader sees: position (exact f32), then the normal/lane words. */
function decodeVertex(batch: BatchedMesh, dv: DataView, v: number, out: number[]): void {
  out.length = 0;
  if (batch.quantized) {
    const { min, step } = batch.quantized;
    const o = v * 12;
    for (let axis = 0; axis < 3; axis++) out.push(Math.fround(Math.fround(min[axis]) + dv.getUint16(o + axis * 2, true) * step));
    out.push(dv.getUint16(o + 6, true), dv.getUint32(o + 8, true));
  } else {
    for (let f = 0; f < 6; f++) out.push(dv.getFloat32(v * 28 + f * 4, true));
    out.push(dv.getUint32(v * 28 + 24, true));
  }
}

/**
 * The first difference between two scenes' final batches, or null. Compares
 * keys, colours, finishes, ids, models, frames, bounds, encodings, indices,
 * LOD1 indices and every decoded vertex, one value at a time: a failure names
 * one batch and one value, never the geometry.
 */
export function firstBatchDifference(actual: readonly BatchedMesh[], expected: readonly BatchedMesh[]): string | null {
  if (actual.length !== expected.length) return `batch count ${actual.length} vs ${expected.length}`;
  const a1: number[] = [], b1: number[] = [];
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i], b = expected[i];
    const head = (x: BatchedMesh) => JSON.stringify([x.colorKey, x.color, x.finish ?? null, x.origin, x.bounds, !!x.quantized, x.indexCount, x.lod1IndexCount ?? 0]);
    if (head(a) !== head(b)) return `batch ${i} (${b.colorKey}): header ${head(a).slice(0, 200)} vs ${head(b).slice(0, 200)}`;
    if (a.expressIds.length !== b.expressIds.length || a.expressIds.some((id, k) => id !== b.expressIds[k] || a.modelIndices?.[k] !== b.modelIndices?.[k])) return `batch ${i} (${b.colorKey}): pieces differ`;
    const ia = new Uint32Array(bufferBytes(a.indexBuffer).buffer, 0, a.indexCount), ib = new Uint32Array(bufferBytes(b.indexBuffer).buffer, 0, b.indexCount);
    let vertices = 0;
    for (let k = 0; k < ib.length; k++) {
      if (ia[k] !== ib[k]) return `batch ${i} (${b.colorKey}): index ${k} is ${ia[k]} vs ${ib[k]}`;
      if (ib[k] + 1 > vertices) vertices = ib[k] + 1;
    }
    if (a.lod1IndexCount) {
      const la = new Uint32Array(bufferBytes(a.lod1IndexBuffer).buffer, 0, a.lod1IndexCount), lb = new Uint32Array(bufferBytes(b.lod1IndexBuffer).buffer, 0, b.lod1IndexCount!);
      for (let k = 0; k < lb.length; k++) if (la[k] !== lb[k]) return `batch ${i} (${b.colorKey}): LOD1 index ${k} is ${la[k]} vs ${lb[k]}`;
    }
    const da = new DataView(bufferBytes(a.vertexBuffer).buffer), db = new DataView(bufferBytes(b.vertexBuffer).buffer);
    for (let v = 0; v < vertices; v++) {
      decodeVertex(a, da, v, a1); decodeVertex(b, db, v, b1);
      for (let k = 0; k < b1.length; k++) if (!Object.is(a1[k], b1[k])) return `batch ${i} (${b.colorKey}): vertex ${v} word ${k} is ${a1[k]} vs ${b1[k]}`;
    }
  }
  return null;
}
