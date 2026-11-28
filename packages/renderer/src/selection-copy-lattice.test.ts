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

Object.assign(globalThis, { GPUBufferUsage: { COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 } });

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
