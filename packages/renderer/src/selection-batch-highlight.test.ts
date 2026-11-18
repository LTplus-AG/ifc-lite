/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from './index.js';
import type { MeshData } from '@ifc-lite/geometry';
import type { Scene } from './scene.js';
import type { RenderOptions } from './types.js';
import { OpaqueVisibilityPass } from './opaque-visibility-pass.js';
import { MESH_UNIFORM_BYTES, MESH_UNIFORM_OFFSET } from './mesh-rte-uniforms.js';
import { highlightKeepsFragment, MESH_FLAG_HIGHLIGHTED_ENTITIES, MESH_FLAG_ONE_ENTITY } from './entity-highlight-table.js';
import { sectionExclusions } from './section-exclusions.js';

/**
 * #10264 S3: the selection and hover highlight of entities held by colour
 * batches is drawn from those batches' own GPU buffers, keeping only the
 * highlighted entities in the fragment stage, instead of from copies built
 * out of the CPU pieces. Drives the REAL render() loop against a stub GPU
 * that keeps every byte written, and replays the shader's keep rule
 * (`highlightKeepsFragment`, the CPU mirror of `highlightKeeps`) over the
 * bound vertex lanes to read back which triangles each highlight draw shows.
 */

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};
(globalThis as Record<string, unknown>).GPUMapMode = { READ: 1, WRITE: 2 };
(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
};
(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

interface FakeBuffer { size: number; usage: number; destroyed: number; bytes: Uint8Array; destroy(): void; getMappedRange(): ArrayBuffer; unmap(): void; mapAsync(): Promise<void> }
interface BindGroup { entries: { resource: { buffer: FakeBuffer; offset?: number } }[] }
interface Draw { vertexBuffer: FakeBuffer; indexBuffer: FakeBuffer; indexCount: number; pipeline: unknown; group0: BindGroup | null }

function makeHarness(limits: { storage?: number } = {}) {
  const stats = { buffers: [] as FakeBuffer[], draws: [] as Draw[], destroyedBufferDraws: 0 };
  let vertexBuffer: FakeBuffer | null = null;
  let indexBuffer: FakeBuffer | null = null;
  let pipeline: unknown = null;
  let group0: BindGroup | null = null;
  const pass = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, prop) {
      if (prop === 'setPipeline') return (p: unknown) => { pipeline = p; };
      if (prop === 'setBindGroup') return (slot: number, g: BindGroup) => { if (slot === 0) group0 = g; };
      if (prop === 'setVertexBuffer') return (slot: number, b: FakeBuffer) => { if (slot === 0) vertexBuffer = b; };
      if (prop === 'setIndexBuffer') return (b: FakeBuffer) => { indexBuffer = b; };
      if (prop === 'drawIndexed') return (indexCount: number) => {
        if (vertexBuffer!.destroyed > 0 || indexBuffer!.destroyed > 0) stats.destroyedBufferDraws++;
        stats.draws.push({ vertexBuffer: vertexBuffer!, indexBuffer: indexBuffer!, indexCount, pipeline, group0 });
      };
      return () => undefined;
    },
  });
  const encoder = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, prop) {
      if (prop === 'beginRenderPass' || prop === 'beginComputePass') return () => pass;
      if (prop === 'finish') return () => ({});
      return () => undefined;
    },
  });
  const queue = {
    writeBuffer(buffer: FakeBuffer, offset: number, data: ArrayBuffer | ArrayBufferView) {
      const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      buffer.bytes.set(bytes, offset);
    },
    writeTexture() { /* no-op */ }, copyExternalImageToTexture() { /* no-op */ }, submit() { /* no-op */ },
    onSubmittedWorkDone: () => Promise.resolve(),
  };
  const lost = new Promise<void>(() => { /* never lost */ });
  const device = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, prop) {
      switch (prop) {
        case 'lost': return lost;
        case 'limits': return { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: limits.storage ?? 128 * 1024 * 1024 };
        case 'queue': return queue;
        case 'popErrorScope': return () => Promise.resolve(null);
        case 'createCommandEncoder': return () => encoder;
        case 'createBuffer': return (desc: { size: number; usage?: number }) => {
          const buffer: FakeBuffer = {
            size: desc.size, usage: desc.usage ?? 0, destroyed: 0, bytes: new Uint8Array(desc.size),
            destroy() { this.destroyed++; }, getMappedRange: () => new ArrayBuffer(desc.size), unmap() { /* no-op */ }, mapAsync: () => Promise.resolve(),
          };
          stats.buffers.push(buffer);
          return buffer;
        };
        case 'createBindGroup': return (desc: BindGroup) => desc;
        case 'createTexture': return (desc: { size: { width: number; height: number } }) => ({ width: desc.size.width, height: desc.size.height, createView: () => ({}), destroy() { /* no-op */ } });
        case 'createShaderModule': return () => ({});
        case 'createRenderPipelineAsync': return () => Promise.resolve({ getBindGroupLayout: () => ({}) });
        case 'createComputePipeline':
        case 'createRenderPipeline': return () => ({ getBindGroupLayout: () => ({}) });
        default: return () => undefined;
      }
    },
  });
  const canvas = { width: 256, height: 256, getBoundingClientRect: () => ({ width: 256, height: 256 }) } as unknown as HTMLCanvasElement;
  const renderer = new Renderer(canvas);
  const wrapper = renderer['device'] as unknown as Record<string, unknown>;
  wrapper['device'] = device;
  wrapper['context'] = { configure() { /* no-op */ }, getCurrentTexture: () => ({ createView: () => ({}) }) };
  wrapper['canvas'] = canvas;
  wrapper['contextConfigured'] = true;
  wrapper['lastWidth'] = 256;
  wrapper['lastHeight'] = 256;
  const visibility = new OpaqueVisibilityPass(device as unknown as GPUDevice, 1);
  const COPY = { label: 'selection-copy' };
  const BATCH = { label: 'selection-batch' };
  const BATCH_QUANTIZED = { label: 'selection-batch-quantized' };
  const pipelines = { quantizedReady: true };
  (renderer as unknown as Record<string, unknown>)['pipeline'] = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, prop) {
      switch (prop) {
        case 'visibility': return visibility;
        case 'needsResize': return () => false;
        case 'getSampleCount': return () => 1;
        case 'getMultisampleTextureView': return () => null;
        case 'getUniformBufferSize': return () => MESH_UNIFORM_BYTES;
        case 'getQuantizedPipelineVariant': return () => ({ label: 'quantized' });
        case 'getSelectionPipeline':
        case 'getTexturedSelectionPipeline': return () => COPY;
        case 'getBatchSelectionPipeline': return (quantized: boolean) => (quantized ? (pipelines.quantizedReady ? BATCH_QUANTIZED : null) : BATCH);
        case 'getPipeline': return () => ({ label: 'opaque', getBindGroupLayout: () => ({}) });
        case 'opaquePipeline': return () => ({ label: 'opaque' });
        case 'getTransparentPipeline': return () => ({ label: 'transparent' });
        case 'getGhostPipeline': return () => ({ label: 'ghost' });
        default: return () => ({});
      }
    },
  });
  const scene = renderer['scene'] as Scene;
  return {
    renderer, stats, scene, pipelines, COPY, BATCH, BATCH_QUANTIZED,
    device: device as unknown as GPUDevice,
    render(options: RenderOptions = {}) {
      const before = stats.draws.length;
      renderer.render({ visualEnhancement: { enabled: false }, ...options });
      assert.equal(stats.destroyedBufferDraws, 0, 'a frame drew a buffer it had already destroyed');
      return stats.draws.slice(before);
    },
  };
}
type Harness = ReturnType<typeof makeHarness>;

const GREY: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
const RED: [number, number, number, number] = [0.8, 0.1, 0.1, 1];

/** One triangle of entity `id`, piece `i`, unique in space. */
function piece(id: number, i = 0, overrides: Partial<MeshData> = {}): MeshData {
  const x = i * 2;
  const y = id * 2;
  return {
    expressId: id, positions: new Float32Array([x, y, 0, x + 1, y, 0, x, y + 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
    color: id % 2 === 0 ? RED : GREY, geometryItemId: id * 1_000 + i, ...overrides,
  } as MeshData;
}

function model(ids: Iterable<number>, piecesEach = 2, overrides: (id: number) => Partial<MeshData> = () => ({})): MeshData[] {
  const out: MeshData[] = [];
  for (const id of ids) for (let i = 0; i < piecesEach; i++) out.push(piece(id, i, overrides(id)));
  return out;
}

function load(h: Harness, meshes: MeshData[]): void {
  h.scene.appendToBatches(meshes, h.device, h.renderer['pipeline'] as never, false);
  h.render();
  for (const batch of h.scene.getBatchedMeshes()) batch.bounds = undefined;
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const key = (corners: number[]) => corners.map((v) => Math.round(v * 1e4) / 1e4).join(',');
const expected = (meshes: readonly MeshData[]) => meshes.map((m) => key(Array.from(m.positions))).sort();

function u32(buffer: FakeBuffer, byteOffset: number, words: number): Uint32Array {
  return new Uint32Array(buffer.bytes.buffer.slice(buffer.bytes.byteOffset + byteOffset, buffer.bytes.byteOffset + byteOffset + words * 4));
}

/**
 * The triangles each batch highlight draw keeps, by the shader's rule: the
 * entity rebuilt from the vertex lane and the draw's anchor, tested against
 * the bound highlight table and the draw's flags.
 */
function kept(h: Harness, draws: readonly Draw[], pipelines: readonly unknown[] = [h.BATCH]) {
  const table = sectionExclusions(h.device).highlight as unknown as FakeBuffer;
  const image = u32(table, 0, table.size / 4);
  const triangles: string[] = [];
  const ids = new Set<number>();
  for (const draw of draws.filter((d) => pipelines.includes(d.pipeline))) {
    const binding = draw.group0!.entries[0]!.resource;
    const uniforms = new Float32Array(u32(binding.buffer, binding.offset ?? 0, MESH_UNIFORM_BYTES / 4).buffer);
    const words = new Uint32Array(uniforms.buffer);
    const flagsX = words[MESH_UNIFORM_OFFSET.flags]!;
    const flagsW = words[MESH_UNIFORM_OFFSET.flags + 3]!;
    const anchor = words[MESH_UNIFORM_OFFSET.overrideParams]!;
    const origin = [uniforms[MESH_UNIFORM_OFFSET.model + 12]!, uniforms[MESH_UNIFORM_OFFSET.model + 13]!, uniforms[MESH_UNIFORM_OFFSET.model + 14]!];
    const floats = new Float32Array(draw.vertexBuffer.bytes.buffer);
    const lanes = new Uint32Array(draw.vertexBuffer.bytes.buffer);
    const indices = new Uint32Array(draw.indexBuffer.bytes.buffer, 0, draw.indexCount);
    for (let t = 0; t < draw.indexCount; t += 3) {
      const lane = lanes[indices[t]! * 7 + 6]!;
      const id = (anchor + ((lane - anchor) & 0xFFFFFF)) >>> 0;
      if (!highlightKeepsFragment(image, flagsX, flagsW, id)) continue;
      const corners: number[] = [];
      for (let c = 0; c < 3; c++) {
        const base = indices[t + c]! * 7;
        corners.push(floats[base]! + origin[0]!, floats[base + 1]! + origin[1]!, floats[base + 2]! + origin[2]!);
      }
      triangles.push(key(corners));
      ids.add(id);
    }
  }
  return { triangles: triangles.sort(), ids };
}

const hydrated = (h: Harness) => h.scene.getMeshes().filter((mesh) => mesh.hydrated);

describe('selection highlight from colour batches (#10264 S3)', () => {
  it('draws exactly the selected entities, each triangle once, from the batches and without copies', () => {
    const h = makeHarness();
    const meshes = model(range(1, 40));
    load(h, meshes);
    const buffersBefore = h.stats.buffers.filter((b) => (b.usage & (GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX)) !== 0).length;
    const selected = [3, 4, 17, 30];
    h.render({ selectedIds: new Set(selected) });
    const frame = h.render({ selectedIds: new Set(selected) });
    const highlight = kept(h, frame);
    assert.deepEqual(highlight.triangles, expected(meshes.filter((m) => selected.includes(m.expressId))));
    assert.deepEqual([...highlight.ids].sort((a, b) => a - b), selected);
    assert.equal(hydrated(h).length, 0, 'no copy of any piece');
    assert.equal(frame.filter((d) => d.pipeline === h.COPY).length, 0);
    assert.equal(h.stats.buffers.filter((b) => (b.usage & (GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX)) !== 0).length, buffersBefore, 'no geometry uploaded for the highlight');
    const batches = new Set(h.scene.getBatchedMeshes().map((b) => b.vertexBuffer as unknown as FakeBuffer));
    assert.ok(frame.filter((d) => d.pipeline === h.BATCH).every((d) => batches.has(d.vertexBuffer)), 'every highlight draw binds a batch\'s own buffers');
    // A deselect draws none and keeps nothing.
    const cleared = h.render({});
    assert.equal(cleared.filter((d) => d.pipeline === h.BATCH).length, 0);
  });

  it('keeps highlighting after the CPU scene geometry is released', () => {
    const h = makeHarness();
    const meshes = model(range(1, 20));
    load(h, meshes);
    const selected = new Set([2, 9, 15]);
    const before = kept(h, h.render({ selectedIds: selected })).triangles;
    h.scene.releaseGeometryData();
    assert.equal(h.scene.getMeshDataPieces(2)?.length ?? 0, 0, 'precondition: the pieces are gone');
    h.render({ selectedIds: new Set([1]) }); // move away and back: rebuilt without pieces
    const after = kept(h, h.render({ selectedIds: selected })).triangles;
    assert.deepEqual(after, before);
    assert.deepEqual(after, expected(meshes.filter((m) => selected.has(m.expressId))));
  });

  it('a 10,000-entity selection costs one draw per batch holding it, and no piece lookups on later frames', () => {
    const h = makeHarness();
    const meshes = model(range(1, 10_000), 1);
    load(h, meshes);
    const selectedIds = new Set(range(1, 10_000));
    const first = h.render({ selectedIds });
    const highlight = kept(h, first);
    assert.equal(highlight.ids.size, 10_000);
    assert.deepEqual(highlight.triangles, expected(meshes));
    const lookups = { count: 0 };
    const pieces = h.scene.getMeshDataPieces.bind(h.scene);
    h.scene.getMeshDataPieces = (...args) => { lookups.count++; return pieces(...args); };
    const orbit = h.render({ selectedIds, isInteracting: true });
    assert.equal(lookups.count, 0, 'a settled selection looks up no pieces');
    assert.equal(orbit.filter((d) => d.pipeline === h.BATCH).length, h.scene.getBatchedMeshes().length);
    assert.equal(hydrated(h).length, 0);
  });

  it('leaves hidden and isolated-away entities out, and brings them back', () => {
    const h = makeHarness();
    const meshes = model(range(1, 12));
    load(h, meshes);
    const selectedIds = new Set([1, 2, 3, 4]);
    const ids = (options: RenderOptions) => [...kept(h, h.render({ selectedIds, ...options })).ids].sort((a, b) => a - b);
    assert.deepEqual(ids({ hiddenIds: new Set([2]) }), [1, 3, 4]);
    assert.deepEqual(ids({ isolatedIds: new Set([3, 4, 9]) }), [3, 4]);
    assert.deepEqual(ids({}), [1, 2, 3, 4]);
  });

  it('keeps the item filter on its copy, exact to the item, and the rest from batches (#4382)', () => {
    const h = makeHarness();
    const meshes = model(range(1, 6));
    load(h, meshes);
    h.render({ selectedId: 2, selectedItemId: 2_001, selectedIds: new Set([2, 5]) });
    const frame = h.render({ selectedId: 2, selectedItemId: 2_001, selectedIds: new Set([2, 5]) });
    const copies = hydrated(h);
    assert.deepEqual(copies.map((m) => [m.expressId, m.geometryItemId]), [[2, 2_001]], 'one copy: the item, not the product');
    assert.deepEqual([...kept(h, frame).ids], [5]);
    // Released: the item cannot be cut out of a batch, so the whole product shows (entity-level, as S1 picks).
    h.scene.releaseGeometryData();
    h.render({ selectedId: 2, selectedIds: new Set([5]) });
    const released = h.render({ selectedId: 2, selectedItemId: 2_001, selectedIds: new Set([2, 5]) });
    assert.deepEqual([...kept(h, released).ids].sort(), [2, 5]);
    assert.equal(hydrated(h).length, 0);
  });

  it('keeps the copies for an id two federated models share in a batch while the selection is scoped to one', () => {
    const h = makeHarness();
    const a = model([7, 8], 1, () => ({ modelIndex: 0 } as Partial<MeshData>));
    const b = model([7], 1, () => ({ modelIndex: 1 } as Partial<MeshData>)).map((m) => ({ ...m, positions: new Float32Array([50, 50, 0, 51, 50, 0, 50, 51, 0]) }));
    load(h, [...a, ...b]);
    const scoped = h.render({ selectedId: 7, selectedModelIndex: 1 });
    assert.equal(kept(h, scoped).ids.size, 0, 'the lane cannot tell the two 7s apart: nothing from the batch');
    assert.deepEqual(hydrated(h).map((m) => m.modelIndex), [1], 'the selected model\'s copy stands in');
    const unscoped = h.render({ selectedId: 7 });
    assert.deepEqual(kept(h, unscoped).triangles, expected([...a.filter((m) => m.expressId === 7), ...b]), 'unscoped: both models\' 7');
    assert.equal(hydrated(h).length, 0);
  });

  it('falls back to copies, never partially, while a batch is evicted, and returns once it is back', () => {
    const h = makeHarness();
    const meshes = model(range(1, 8));
    load(h, meshes);
    const selectedIds = new Set([1, 2]);
    h.render({ selectedIds });
    for (const batch of h.scene.getBatchedMeshes()) {
      if (!batch.expressIds.includes(1)) continue;
      batch.vertexBuffer.destroy(); batch.indexBuffer.destroy(); batch.gpuResident = false;
    }
    const evicted = h.render({ selectedIds });
    assert.ok(!kept(h, evicted).ids.has(1), 'entity 1 is not drawn from its evicted batch');
    assert.ok(hydrated(h).some((m) => m.expressId === 1), 'its copies stand in while its pieces are in memory');
    // The app's animation loop runs the queued restore between frames.
    assert.ok(h.scene.hasResidencyRestoreWork(), 'the evicted batch was asked back');
    h.scene.processResidencyRestores(h.device, h.renderer['pipeline'] as never, Infinity);
    const frame = h.render({ selectedIds });
    assert.deepEqual([...kept(h, frame).ids].sort(), [1, 2], 'back on the rebuilt batch');
    assert.equal(hydrated(h).length, 0);
  });

  it('falls back to copies when the highlight table cannot be held', () => {
    const h = makeHarness({ storage: 64 }); // 16 words: 15 ids at most
    const meshes = model(range(1, 40), 1);
    load(h, meshes);
    const small = h.render({ selectedIds: new Set(range(1, 10)) });
    assert.equal(kept(h, small).ids.size, 10);
    const large = h.render({ selectedIds: new Set(range(1, 30)) });
    assert.equal(large.filter((d) => d.pipeline === h.BATCH).length, 0, 'no batch draw reads a table that does not hold its ids');
    assert.deepEqual([...new Set(hydrated(h).map((m) => m.expressId))].sort((a, b) => a - b), range(1, 30));
  });

  it('draws quantized batches through their own pipeline with their dequantization, and copies while it is missing', () => {
    const h = makeHarness();
    h.scene.setQuantizedBatches(true);
    load(h, model(range(1, 6)));
    assert.ok(h.scene.getBatchedMeshes().every((b) => b.quantized), 'precondition: quantized batches');
    const frame = h.render({ selectedIds: new Set([3]) });
    const draws = frame.filter((d) => d.pipeline === h.BATCH_QUANTIZED);
    assert.ok(draws.length > 0);
    for (const draw of draws) {
      const binding = draw.group0!.entries[0]!.resource;
      const uniforms = new Float32Array(u32(binding.buffer, binding.offset ?? 0, MESH_UNIFORM_BYTES / 4).buffer);
      const batch = h.scene.getBatchedMeshes().find((b) => (b.vertexBuffer as unknown) === draw.vertexBuffer)!;
      assert.deepEqual([...uniforms.subarray(MESH_UNIFORM_OFFSET.quantParams, MESH_UNIFORM_OFFSET.quantParams + 4)], [...batch.quantized!.min, batch.quantized!.step].map(Math.fround));
      assert.ok((new Uint32Array(uniforms.buffer)[MESH_UNIFORM_OFFSET.flags]! & MESH_FLAG_HIGHLIGHTED_ENTITIES) !== 0);
    }
    h.pipelines.quantizedReady = false;
    h.render({});
    const copies = h.render({ selectedIds: new Set([3]) });
    assert.equal(copies.filter((d) => d.pipeline === h.BATCH_QUANTIZED).length, 0);
    assert.ok(hydrated(h).length > 0, 'copies stand in without the quantized highlight pipeline');
  });
});

describe('hover outline from colour batches (#10264 S3)', () => {
  it('outlines the hovered entity from its batches, naming it in flags.w, and uploads nothing', () => {
    const h = makeHarness();
    load(h, model(range(1, 10)));
    const before = h.stats.buffers.filter((b) => (b.usage & (GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX)) !== 0).length;
    const frame = h.render({ hoverOutline: { id: 6 } });
    const batches = new Map(h.scene.getBatchedMeshes().map((b) => [b.vertexBuffer as unknown as FakeBuffer, b]));
    const hoverDraws = frame.filter((d) => batches.has(d.vertexBuffer) && d.group0 && (() => {
      const binding = d.group0!.entries[0]!.resource;
      const words = u32(binding.buffer, binding.offset ?? 0, MESH_UNIFORM_BYTES / 4);
      return (words[MESH_UNIFORM_OFFSET.flags]! & MESH_FLAG_ONE_ENTITY) !== 0 && words[MESH_UNIFORM_OFFSET.flags + 3] === 6;
    })());
    assert.equal(hoverDraws.length, 1, 'the one batch holding entity 6');
    assert.ok(batches.get(hoverDraws[0]!.vertexBuffer)!.expressIds.includes(6));
    assert.equal(h.stats.buffers.filter((b) => (b.usage & (GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX)) !== 0).length, before, 'no hover copies');
  });
});
