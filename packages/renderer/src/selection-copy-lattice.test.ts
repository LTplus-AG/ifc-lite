/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A highlight copy built from CPU pieces (individual-mesh-upload.ts) draws
 * with `greater-equal` and no depth bias over its base batch, so its vertices
 * must equal what the base's vertex shader positions bit for bit: the f32
 * relative coordinate for an f32 batch, `quantMin + q * step` (in f32) for a
 * quantized one, in the same frame origin.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { mergeGeometry } from './scene-geometry.js';
import { quantizeInterleaved } from './quantize.js';
import { uploadIndividualMesh, type IndividualMeshFrame } from './individual-mesh-upload.js';
import { Scene } from './scene.js';
import type { RenderPipeline } from './pipeline.js';
import type { BatchedMesh } from './types.js';
import { Renderer } from './index.js';
import { OpaqueVisibilityPass } from './opaque-visibility-pass.js';
import { MESH_UNIFORM_BYTES } from './mesh-rte-uniforms.js';

Object.assign(globalThis, {
  GPUBufferUsage: { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 },
  GPUMapMode: { READ: 1, WRITE: 2 }, GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
  GPUTextureUsage: { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 },
});

const fr = Math.fround;
const GREY: [number, number, number, number] = [0.5, 0.5, 0.5, 1];

interface FakeBuffer { size: number; usage: number; data: Uint8Array; destroy(): void }

/** A device that keeps what is written to each buffer. */
function fakeGpu(): { device: GPUDevice; pipeline: RenderPipeline } {
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: (d: GPUBufferDescriptor): FakeBuffer => ({ size: d.size, usage: d.usage, data: new Uint8Array(d.size), destroy() {} }),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({ copyBufferToBuffer() {}, finish: () => ({}) }),
    queue: {
      writeBuffer(buffer: FakeBuffer, offset: number, data: ArrayBufferView | ArrayBuffer) {
        const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        buffer.data.set(view, offset);
      },
      submit() {},
    },
  } as unknown as GPUDevice;
  return { device, pipeline: { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as RenderPipeline };
}

/** The copy's interleaved f32 vertices (7 floats each) and its frame origin. */
function copyOf(mesh: MeshData, frame: IndividualMeshFrame): { vertices: Float32Array; origin: readonly number[] } {
  const { device } = fakeGpu();
  const gpu = uploadIndividualMesh(device, mesh, frame);
  const bytes = (gpu.vertexBuffer as unknown as FakeBuffer).data;
  return { vertices: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4), origin: gpu.rteOrigin };
}

/** What the base's vertex shader positions, per vertex, in its batch frame. */
function basePositions(batch: BatchedMesh): Float32Array {
  const bytes = (batch.vertexBuffer as unknown as FakeBuffer).data;
  const q = batch.quantized;
  if (!q) {
    const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    return Float32Array.from({ length: (f.length / 7) * 3 }, (_, k) => f[Math.floor(k / 3) * 7 + (k % 3)]!);
  }
  const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  return Float32Array.from({ length: (u16.length / 6) * 3 }, (_, k) => fr(fr(q.min[k % 3]!) + fr(u16[Math.floor(k / 3) * 6 + (k % 3)]! * fr(q.step))));
}

function lcg(seed: number): () => number { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }

describe('a CPU-built highlight copy lands on its base batch\'s vertices', () => {
  it('equals the quantized base\'s dequantized positions bit for bit, against its own or a shared lattice origin', () => {
    const r = lcg(7);
    let checked = 0;
    for (let trial = 0; trial < 120; trial++) {
      const shared: [number, number, number] = [(r() - 0.5) * 2e5, (r() - 0.5) * 2e5, (r() - 0.5) * 200];
      const meshes = Array.from({ length: 3 }, (_, m) => {
        const positions = Float32Array.from({ length: 60 }, () => (r() - 0.5) * 6);
        return { expressId: 100 + m, positions, normals: new Float32Array(60).fill(0.5), indices: Uint32Array.from({ length: 20 }, (_, i) => i), color: GREY,
          origin: [shared[0] + (r() - 0.5) * 50, shared[1] + (r() - 0.5) * 50, shared[2] + (r() - 0.5) * 20] } as unknown as MeshData;
      });
      const merged = mergeGeometry(meshes, trial % 2 ? shared : undefined);
      for (const lattice of [undefined, {}]) {
        const q = quantizeInterleaved(merged.vertexData, 7, lattice);
        if (!q) continue;
        const u16 = new Uint16Array(q.vertexData);
        let v = 0;
        for (const mesh of meshes) {
          const copy = copyOf(mesh, { sharedOrigin: merged.origin, quantized: true });
          assert.deepEqual(copy.origin, [...merged.origin]);
          for (let i = 0; i < mesh.positions.length / 3; i++, v++) for (let a = 0; a < 3; a++) {
            const base = fr(fr(q.quantMin[a]!) + fr(u16[v * 6 + a]! * fr(q.step)));
            assert.ok(copy.vertices[i * 7 + a] === base, `trial ${trial}: copy ${copy.vertices[i * 7 + a]} vs base ${base}`);
            checked++;
          }
        }
      }
    }
    assert.ok(checked > 10_000);
  });

  for (const [name, span] of [['an f32 fragment (past the u16 lattice range)', 100], ['a quantized fragment', 1]] as const) {
    it(`takes the encoding of the streaming fragment that draws it, mid-stream: ${name}`, () => {
      const { device, pipeline } = fakeGpu();
      const scene = new Scene();
      scene.setQuantizedBatches(true);
      const mesh = {
        expressId: 777, modelIndex: 0, color: GREY, origin: [1000.0003, -20.0007, 3.0001],
        positions: new Float32Array([0, 0, 0, span, 0, 0, 0, 1, 0.3]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
      } as unknown as MeshData;
      scene.appendToBatches([mesh], device, pipeline, true);
      const [fragment] = scene.getBatchedMeshes();
      assert.equal(fragment!.quantized !== undefined, span === 1, 'fixture: the fragment encoding');
      const piece = scene.getMeshDataPieces(777)![0]!;
      const copy = copyOf(piece, scene.getIndividualMeshFrame(piece));
      assert.deepEqual(copy.origin, fragment!.origin, 'the copy is in the fragment\'s frame');
      const base = basePositions(fragment!);
      for (let v = 0; v < 3; v++) for (let a = 0; a < 3; a++) {
        assert.ok(copy.vertices[v * 7 + a] === base[v * 3 + a], `vertex ${v} axis ${a}: copy ${copy.vertices[v * 7 + a]} vs base ${base[v * 3 + a]}`);
      }
    });
  }
});

/** The real render loop over a stub GPU whose buffers keep what is written, with no batch highlight pipeline: copies draw the highlight. */
function rendererHarness() {
  const inert = (): unknown => new Proxy({}, { get: (_t, p) => (p === 'beginRenderPass' || p === 'beginComputePass' ? () => inert() : p === 'finish' ? () => ({}) : () => undefined) });
  const { device: base } = fakeGpu();
  const device = new Proxy({} as Record<string | symbol, unknown>, { get(_t, p) {
    switch (p) {
      case 'lost': return new Promise(() => {});
      case 'limits': return { maxTextureDimension2D: 8192, maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 27 };
      case 'queue': return { ...base.queue, writeTexture() {}, copyExternalImageToTexture() {}, onSubmittedWorkDone: () => Promise.resolve() };
      case 'createBuffer': return (d: GPUBufferDescriptor) => ({ ...base.createBuffer(d), getMappedRange: () => new ArrayBuffer(d.size), unmap() {}, mapAsync: () => Promise.resolve() });
      case 'popErrorScope': return () => Promise.resolve(null);
      case 'createCommandEncoder': return () => inert();
      case 'createBindGroup': return () => ({});
      case 'createTexture': return (d: { size: { width: number; height: number } }) => ({ width: d.size.width, height: d.size.height, createView: () => ({}), destroy() {} });
      case 'createRenderPipelineAsync': return () => Promise.resolve({ getBindGroupLayout: () => ({}) });
      case 'createComputePipeline': case 'createRenderPipeline': return () => ({ getBindGroupLayout: () => ({}) });
      default: return () => ({});
    }
  } }) as unknown as GPUDevice;
  const canvas = { width: 64, height: 64, getBoundingClientRect: () => ({ width: 64, height: 64 }) } as unknown as HTMLCanvasElement;
  const renderer = new Renderer(canvas);
  Object.assign(renderer['device'] as unknown as Record<string, unknown>, { device, canvas, contextConfigured: true, lastWidth: 64, lastHeight: 64,
    context: { configure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) } });
  const visibility = new OpaqueVisibilityPass(device, 1);
  const pipeline = new Proxy({} as Record<string | symbol, unknown>, { get(_t, p) {
    switch (p) {
      case 'visibility': return visibility;
      case 'needsResize': return () => false;
      case 'getSampleCount': return () => 1;
      case 'getMultisampleTextureView': case 'getQuantizedPipelineVariant': case 'getBatchSelectionPipeline': return () => null;
      case 'getUniformBufferSize': return () => MESH_UNIFORM_BYTES;
      default: return () => ({ label: String(p), getBindGroupLayout: () => ({}) });
    }
  } }) as unknown as RenderPipeline;
  (renderer as unknown as Record<string, unknown>)['pipeline'] = pipeline;
  return { renderer, device, pipeline, scene: renderer['scene'] as Scene };
}

describe('a highlight copy outlives no change of its base\'s frame', () => {
  it('is built again when a finalize moves its piece from a quantized fragment into an f32 bucket', () => {
    const h = rendererHarness();
    h.scene.setQuantizedBatches(true);
    const tri = (id: number, x: number) => ({
      expressId: id, modelIndex: 0, color: GREY, origin: [x + 0.0003, 0.0007, 0.0001],
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0.3]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
    } as unknown as MeshData);
    // Two small fragments (each quantized), one colour bucket 100 m wide (past the u16 lattice: f32).
    h.scene.appendToBatches([tri(1, 0)], h.device, h.pipeline, true);
    h.scene.appendToBatches([tri(2, 100)], h.device, h.pipeline, true);
    assert.ok(h.scene.getBatchedMeshes().every((b) => b.quantized), 'fixture: quantized fragments');
    const frame = () => {
      h.renderer.render({ visualEnhancement: { enabled: false }, selectedId: 1 });
      return h.scene.getMeshes().find((m) => m.hydrated && m.expressId === 1)!;
    };
    assert.ok(frame(), 'the selection is drawn from a copy');
    h.scene.finalizeStreaming(h.device, h.pipeline);
    const copy = frame();
    const bucket = h.scene.getBatchedMeshes().find((b) => b.expressIds.includes(1))!;
    assert.equal(bucket.quantized, undefined, 'fixture: the finalized bucket is f32');
    assert.deepEqual(copy.rteOrigin, bucket.origin, 'the copy is in the bucket\'s frame');
    const vertices = new Float32Array((copy.vertexBuffer as unknown as FakeBuffer).data.buffer, 0, 21);
    const base = basePositions(bucket);
    for (let v = 0; v < 3; v++) for (let a = 0; a < 3; a++) {
      assert.ok(vertices[v * 7 + a] === base[v * 3 + a], `vertex ${v} axis ${a}: copy ${vertices[v * 7 + a]} vs base ${base[v * 3 + a]}`);
    }
  });
});
