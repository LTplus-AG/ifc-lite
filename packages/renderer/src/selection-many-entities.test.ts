/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from './index.js';
import type { DecodedInstancedShard, MeshData } from '@ifc-lite/geometry';
import type { Scene } from './scene.js';
import type { RenderOptions } from './types.js';
import { OpaqueVisibilityPass } from './opaque-visibility-pass.js';
import { MESH_UNIFORM_BYTES } from './mesh-rte-uniforms.js';
import { uploadMergedMeshes, uploadIndividualMesh } from './individual-mesh-upload.js';
import { matchesHoveredMesh } from './selection-outline-frame.js';
import { planPickMeshHydration } from './pick-mesh-budget.js';
import { XRayEpochTracker } from './xray-alpha.js';
import { colorSaltByte, packEntityLane } from './scene-geometry.js';
import { SelectionSnapshot, SELECTION_IDS_VERIFIED_PER_FRAME } from './selection-highlight.js';

/**
 * #9835: a selection of many ordinary entities must cost a frame what its
 * colours cost, not what its entities do. Selecting every element of a model
 * used to hold one GPU mesh per selected piece and, on every frame of an orbit,
 * write its uniforms and draw it; the same frame also rebuilt the id set and
 * looked up every selected entity's pieces. Drives the REAL render() loop
 * against a stub GPU that records every allocation, write and draw.
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

interface FakeBuffer { size: number; usage: number; destroyed: number; bytes: Uint8Array | null; destroy(): void; getMappedRange(): ArrayBuffer; unmap(): void; mapAsync(): Promise<void> }
interface Draw { vertexBuffer: FakeBuffer; indexBuffer: FakeBuffer; indexCount: number; pipeline: unknown }

const VERTEX_OR_INDEX = 48;

function makeHarness() {
  const stats = { buffers: [] as FakeBuffer[], bindGroups: 0, writes: 0, destroyedBufferDraws: 0, destroyedAtSubmit: 0, draws: [] as Draw[] };
  /** Every buffer the open frame wrote or drew: a real submit rejects the frame if one was destroyed by then. */
  const frameBuffers = new Set<FakeBuffer>();
  let vertexBuffer: FakeBuffer | null = null;
  let indexBuffer: FakeBuffer | null = null;
  let pipeline: unknown = null;
  const pass = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, prop) {
      if (prop === 'setPipeline') return (p: unknown) => { pipeline = p; };
      if (prop === 'setVertexBuffer') return (slot: number, b: FakeBuffer) => { if (slot === 0) vertexBuffer = b; };
      if (prop === 'setIndexBuffer') return (b: FakeBuffer) => { indexBuffer = b; };
      if (prop === 'drawIndexed') return (indexCount: number) => {
        // A real submit rejects a destroyed buffer. Recorded, not asserted here:
        // render() contains anything thrown mid-frame, and would hide the failure.
        if (vertexBuffer!.destroyed > 0 || indexBuffer!.destroyed > 0) stats.destroyedBufferDraws++;
        frameBuffers.add(vertexBuffer!).add(indexBuffer!);
        stats.draws.push({ vertexBuffer: vertexBuffer!, indexBuffer: indexBuffer!, indexCount, pipeline });
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
    writeBuffer(buffer: FakeBuffer, offset: number, data: ArrayBufferView) {
      stats.writes++;
      frameBuffers.add(buffer);
      if (buffer.usage & VERTEX_OR_INDEX) { // keep the geometry to assert on
        buffer.bytes ??= new Uint8Array(buffer.size);
        buffer.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
      }
    },
    writeTexture() { /* no-op */ }, copyExternalImageToTexture() { /* no-op */ },
    submit() {
      for (const buffer of frameBuffers) if (buffer.destroyed > 0) stats.destroyedAtSubmit++;
      frameBuffers.clear();
    },
    onSubmittedWorkDone: () => Promise.resolve(),
  };
  const lost = new Promise<void>(() => { /* never lost */ });
  const device = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, prop) {
      switch (prop) {
        case 'lost': return lost;
        case 'limits': return { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 };
        case 'queue': return queue;
        case 'popErrorScope': return () => Promise.resolve(null);
        case 'createCommandEncoder': return () => encoder;
        case 'createBuffer': return (desc: { size: number; usage?: number }) => {
          const buffer: FakeBuffer = {
            size: desc.size, usage: desc.usage ?? 0, destroyed: 0, bytes: null,
            destroy() { this.destroyed++; }, getMappedRange: () => new ArrayBuffer(desc.size), unmap() { /* no-op */ }, mapAsync: () => Promise.resolve(),
          };
          stats.buffers.push(buffer);
          return buffer;
        };
        case 'createBindGroup': return () => { stats.bindGroups++; return {}; };
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
  const SELECTION = { label: 'selection' };
  (renderer as unknown as Record<string, unknown>)['pipeline'] = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, prop) {
      switch (prop) {
        case 'visibility': return visibility;
        case 'needsResize': return () => false;
        case 'getSampleCount': return () => 1;
        case 'getMultisampleTextureView': return () => null;
        case 'getUniformBufferSize': return () => MESH_UNIFORM_BYTES;
        case 'getQuantizedPipelineVariant': return () => null;
        case 'getSelectionPipeline': return () => SELECTION;
        case 'getPipeline': return () => ({ label: 'opaque', getBindGroupLayout: () => ({}) });
        case 'opaquePipeline': return () => ({ label: 'opaque' });
        case 'getTransparentPipeline': return () => ({ label: 'transparent' });
        case 'getGhostPipeline': return () => ({ label: 'ghost' });
        default: return () => ({});
      }
    },
  });
  return {
    renderer, stats, SELECTION,
    scene: renderer['scene'] as Scene,
    device: device as unknown as GPUDevice,
    render(options: RenderOptions = {}) {
      renderer.render({ visualEnhancement: { enabled: false }, ...options });
      assert.equal(stats.destroyedBufferDraws, 0, 'a frame drew a buffer it had already destroyed');
      assert.equal(stats.destroyedAtSubmit, 0, 'a frame submitted a write or a draw of a buffer it destroyed meanwhile');
    },
  };
}

type Harness = ReturnType<typeof makeHarness>;

const GREY: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
const RED: [number, number, number, number] = [0.8, 0.1, 0.1, 1];
/** The individual copies a selection may hold before it pools: the pick budget, as for one entity (#9192). */
const BUDGET = 500;
const PIECES_EACH = 2;

/** Piece `i` of entity `expressId`: one triangle that no other piece shares. */
function piece(expressId: number, i: number, overrides: Partial<MeshData> = {}): MeshData {
  const x = i * 2;
  const y = expressId * 2;
  return {
    expressId,
    positions: new Float32Array([x, y, 0, x + 1, y, 0, x, y + 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: GREY,
    geometryItemId: expressId * 1_000 + i,
    ...overrides,
  } as MeshData;
}

/** Entities 1..count, `PIECES_EACH` pieces each. */
function model(count: number, overrides: (expressId: number, i: number) => Partial<MeshData> = () => ({})): MeshData[] {
  const meshes: MeshData[] = [];
  for (let id = 1; id <= count; id++) for (let i = 0; i < PIECES_EACH; i++) meshes.push(piece(id, i, overrides(id, i)));
  return meshes;
}

const idsOf = (count: number, from = 1): number[] => Array.from({ length: count }, (_, i) => from + i);
const ofEntities = (meshes: readonly MeshData[], ids: Iterable<number>): MeshData[] => { const wanted = new Set(ids); return meshes.filter((mesh) => wanted.has(mesh.expressId)); };

/** Load through the real batching path, with bounds stripped so the default camera cannot cull. */
function load(h: Harness, meshes: MeshData[]): void {
  h.scene.appendToBatches(meshes, h.device, h.renderer['pipeline'] as never, false);
  h.render();
  for (const batch of h.scene.getBatchedMeshes()) batch.bounds = undefined;
}

/** What one render costs on the GPU, and what its highlight drew. */
function frameCost(h: Harness, options: RenderOptions) {
  const before = h.stats.buffers.length;
  const bindGroups = h.stats.bindGroups;
  const draws = h.stats.draws.length;
  const writes = h.stats.writes;
  h.render(options);
  const frameDraws = h.stats.draws.slice(draws);
  const highlightDraws = frameDraws.filter((draw) => draw.pipeline === h.SELECTION);
  const origins = new Map(h.scene.getMeshes().map((mesh) => [mesh.vertexBuffer as unknown as FakeBuffer, mesh.rteOrigin]));
  const created = h.stats.buffers.slice(before).filter((buffer) => (buffer.usage & VERTEX_OR_INDEX) !== 0 || buffer.size === MESH_UNIFORM_BYTES);
  return {
    buffers: created.length,
    bindGroups: h.stats.bindGroups - bindGroups,
    draws: frameDraws.length,
    writes: h.stats.writes - writes,
    highlightDraws,
    created,
    drawn: () => drawnTriangles(highlightDraws, origins),
  };
}

/** One `x,y,z` key per triangle the draws put on screen, sorted, and the entity id in every vertex lane. */
function drawnTriangles(draws: readonly Draw[], origins: ReadonlyMap<FakeBuffer, readonly [number, number, number] | undefined>) {
  const triangles: string[] = [];
  const ids = new Set<number>();
  for (const draw of draws) {
    const bytes = draw.vertexBuffer.bytes!;
    const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const lanes = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const indexBytes = draw.indexBuffer.bytes!;
    const indices = new Uint32Array(indexBytes.buffer, indexBytes.byteOffset, indexBytes.byteLength / 4);
    assert.equal(indices.length, draw.indexCount);
    const origin = origins.get(draw.vertexBuffer) ?? [0, 0, 0];
    for (let i = 0; i < draw.indexCount; i += 3) {
      const corners: number[] = [];
      for (let c = 0; c < 3; c++) {
        const base = indices[i + c] * 7;
        corners.push(floats[base] + origin[0], floats[base + 1] + origin[1], floats[base + 2] + origin[2]);
        ids.add(lanes[base + 6] & 0xFFFFFF);
      }
      triangles.push(corners.join(','));
    }
  }
  return { triangles: [...triangles].sort(), inDrawOrder: triangles, ids };
}

const expectedTriangles = (meshes: readonly MeshData[]): string[] => meshes.map((mesh) => Array.from(mesh.positions).join(',')).sort();
const hydrated = (h: Harness) => h.scene.getMeshes().filter((mesh) => mesh.hydrated);
const sorted = (ids: Iterable<number>): number[] => [...ids].sort((a, b) => a - b);

/** A Set that counts every membership test and every id handed to an iteration. */
class CountingSet extends Set<number> {
  lookups = 0;
  override has(value: number): boolean { this.lookups++; return super.has(value); }
  override *[Symbol.iterator](): SetIterator<number> { for (const value of super.values()) { this.lookups++; yield value; } return undefined; }
  override values(): SetIterator<number> { return this[Symbol.iterator](); }
  override keys(): SetIterator<number> { return this[Symbol.iterator](); }
  override forEach(callback: (value: number, key: number, set: Set<number>) => void): void { for (const value of this) callback(value, value, this); }
}

/** Calls into the scene's per-entity piece lookups, the work a frame did per selected entity. */
function countPieceLookups(scene: Scene): { count: number } {
  const counter = { count: 0 };
  const pieces = scene.getMeshDataPieces.bind(scene);
  const list = scene.getMeshDataPieceList.bind(scene);
  scene.getMeshDataPieces = (...args) => { counter.count++; return pieces(...args); };
  scene.getMeshDataPieceList = (...args) => { counter.count++; return list(...args); };
  return counter;
}

describe('selecting many entities (#9835)', () => {
  it('a settled frame costs the same GPU work whether 300 or 10,000 entities are selected', () => {
    const settled = (count: number) => {
      const h = makeHarness();
      load(h, model(count));
      const none = frameCost(h, {});
      const selectedIds = new Set(idsOf(count));
      const first = frameCost(h, { selectedIds });
      const next = frameCost(h, { selectedIds });
      return { none, first, next, pieces: count * PIECES_EACH };
    };
    const small = settled(300);
    const large = settled(10_000);
    for (const { first, next, none, pieces } of [small, large]) {
      assert.equal(first.buffers, 3, `${pieces} pieces: one vertex, one index and one uniform buffer for the whole selection`);
      assert.equal(first.highlightDraws.length, 1, `${pieces} pieces: one highlight draw for the one colour`);
      assert.equal(next.buffers, 0, 'a settled selection allocates nothing');
      assert.equal(next.bindGroups, 0);
      assert.equal(next.highlightDraws.length, 1);
      // The highlight mesh costs a frame its own uniform (written for the mesh
      // pass and again as the highlight) and its draws; nothing per entity.
      assert.ok(next.writes - none.writes <= 4, `${pieces} pieces: ${next.writes - none.writes} extra buffer writes a frame`);
      assert.ok(next.draws - none.draws <= 4, `${pieces} pieces: ${next.draws - none.draws} extra draws a frame`);
    }
    assert.equal(large.next.draws, small.next.draws, 'draw calls a frame do not grow with the selection');
    assert.equal(large.next.writes, small.next.writes, 'buffer writes a frame do not grow with the selection');
  });

  it('a settled frame does no work per selected entity on the CPU either', () => {
    const settledWork = (count: number) => {
      const h = makeHarness();
      load(h, model(count));
      const selectedIds = new CountingSet(idsOf(count));
      h.render({ selectedIds });
      h.render({ selectedIds });
      const pieceLookups = countPieceLookups(h.scene);
      selectedIds.lookups = 0;
      for (let i = 0; i < 3; i++) h.render({ selectedIds });
      return { pieceLookups: pieceLookups.count, idLookups: selectedIds.lookups };
    };
    const small = settledWork(20_000);
    const large = settledWork(60_000);
    assert.equal(large.pieceLookups, 0, 'no entity\'s pieces are looked up on a frame that changed nothing');
    assert.equal(small.pieceLookups, 0);
    // A frame re-checks a bounded slice of the ids (an in-place edit must not go
    // unseen) and tests the drawn meshes against them: neither grows with the selection.
    assert.equal(large.idLookups, small.idLookups, 'the ids read a frame do not grow with the selection');
    assert.ok(large.idLookups <= 3 * (SELECTION_IDS_VERIFIED_PER_FRAME + 4), `${large.idLookups} id reads in three frames`);
  });

  it('draws exactly the selected entities, each triangle once, each vertex stamped with its own id', () => {
    const h = makeHarness();
    const meshes = model(2_000);
    load(h, meshes);
    const selected = idsOf(1_200, 301);
    const cost = frameCost(h, { selectedIds: new Set(selected) });
    const drawn = cost.drawn();
    assert.deepEqual(drawn.triangles, expectedTriangles(ofEntities(meshes, selected)));
    assert.deepEqual(sorted(drawn.ids), selected, 'every selected entity and no other');
    const pool = hydrated(h);
    assert.equal(pool.length, 1);
    assert.equal(pool[0].expressId, 301, 'the mesh is anchored at the lowest id it holds, which its draw rebuilds full ids from');
    assert.deepEqual(sorted(pool[0].mergedSelection?.ids ?? []), selected);
  });

  it('keeps copies per piece up to the budget, so a small selection still names its items', () => {
    const atBudget = makeHarness();
    const meshes = model(400);
    load(atBudget, meshes);
    const selected = idsOf(BUDGET / PIECES_EACH);
    const first = frameCost(atBudget, { selectedIds: new Set(selected) });
    assert.equal(first.buffers, BUDGET * 3, 'individual vertex, index and uniform buffers');
    assert.equal(first.highlightDraws.length, BUDGET);
    assert.ok(hydrated(atBudget).every((mesh) => mesh.mergedSelection === undefined));
    assert.deepEqual(hydrated(atBudget).map((mesh) => mesh.geometryItemId).sort(), ofEntities(meshes, selected).map((mesh) => mesh.geometryItemId).sort());
    assert.equal(planPickMeshHydration(atBudget.scene).overBudget, false, 'per-piece copies leave the GPU pick available');

    const past = makeHarness();
    load(past, model(400));
    const pooled = frameCost(past, { selectedIds: new Set(idsOf(BUDGET / PIECES_EACH + 1)) });
    assert.equal(pooled.buffers, 3);
    assert.equal(pooled.highlightDraws.length, 1);
    assert.equal(planPickMeshHydration(past.scene).overBudget, true, 'a merged copy cannot name the item it was hit on: the CPU raycast answers');
  });

  it('growing a per-piece selection past the budget replaces its copies with the pool, drawing each triangle once', () => {
    const h = makeHarness();
    const meshes = model(600);
    load(h, meshes);
    const few = frameCost(h, { selectedIds: new Set(idsOf(200)) });
    assert.equal(few.highlightDraws.length, 200 * PIECES_EACH);

    const many = frameCost(h, { selectedIds: new Set(idsOf(600)) });
    assert.ok(few.created.every((buffer) => buffer.destroyed === 1), 'the individual copies do not linger beside the pool');
    assert.equal(many.highlightDraws.length, 1);
    assert.deepEqual(many.drawn().triangles, expectedTriangles(meshes));
  });

  // The highlight writes no depth, so where glass lets highlighted surfaces
  // overlap on screen the last one drawn shows. One copy per piece drew them in
  // selection order; a pool split by colour would shade those pixels differently.
  it('pools one mesh per model whatever the colours, its triangles in the selection\'s order', () => {
    const h = makeHarness();
    const meshes = model(1_000, (id) => ({ color: id % 2 ? RED : GREY, modelIndex: id > 500 ? 1 : 0 }));
    load(h, meshes);
    const selection = idsOf(1_000).reverse();
    const cost = frameCost(h, { selectedIds: new Set(selection) });
    assert.equal(cost.highlightDraws.length, 2, 'one mesh per model, not one per colour');
    const inSelectionOrder = selection.flatMap((id) => meshes.filter((mesh) => mesh.expressId === id)).map((mesh) => Array.from(mesh.positions).join(','));
    assert.deepEqual(cost.drawn().inDrawOrder, inSelectionOrder, 'drawn in the order one copy per piece would be');
  });

  it('never draws a pool holding glass as translucent geometry of its own', () => {
    const h = makeHarness();
    const glass: [number, number, number, number] = [0.2, 0.4, 0.8, 0.3];
    load(h, model(1_000, (id) => ({ color: id === 1 ? glass : GREY })));
    const selectedIds = new Set(idsOf(1_000));
    h.render({ selectedIds });
    const [pool] = hydrated(h);
    assert.equal(pool.expressId, 1, 'the glass entity is the one the mesh is named after');
    assert.equal(pool.color[3], 1);
    assert.equal(pool.finish, undefined);
    const before = h.stats.draws.length;
    h.render({ selectedIds });
    const poolDraws = h.stats.draws.slice(before).filter((draw) => draw.vertexBuffer === (pool.vertexBuffer as unknown as FakeBuffer));
    assert.ok(poolDraws.length > 0);
    assert.equal(poolDraws.filter((draw) => (draw.pipeline as { label?: string }).label === 'transparent').length, 0, 'only the highlight and its outline mask draw it');
  });

  it('keeps the pool when the same selection arrives as a new Set, and rebuilds when its ids change', () => {
    const h = makeHarness();
    const meshes = model(1_000);
    load(h, meshes);
    const first = frameCost(h, { selectedIds: new Set(idsOf(1_000)) });
    // A capture, or a store handing out a fresh Set, passes a copy every time.
    for (let i = 0; i < 3; i++) assert.equal(frameCost(h, { selectedIds: new Set(idsOf(1_000)) }).buffers, 0, 'a copy of the same ids keeps the highlight');
    assert.ok(first.created.every((buffer) => buffer.destroyed === 0));

    const fewer = idsOf(999);
    const changed = frameCost(h, { selectedIds: new Set(fewer) });
    assert.ok(first.created.every((buffer) => buffer.destroyed === 1), 'deselecting one entity frees the pool that held it');
    assert.deepEqual(changed.drawn().triangles, expectedTriangles(ofEntities(meshes, fewer)));
    assert.equal(frameCost(h, { selectedIds: new Set(fewer) }).buffers, 0, 'and settles');
  });

  it('adds a newly selected entity beside the pool instead of rebuilding it', () => {
    const h = makeHarness();
    const meshes = model(1_001);
    load(h, meshes);
    const first = frameCost(h, { selectedIds: new Set(idsOf(1_000)) });
    const grown = frameCost(h, { selectedIds: new Set(idsOf(1_001)) });
    assert.ok(first.created.every((buffer) => buffer.destroyed === 0), 'the pool stays');
    assert.equal(grown.buffers, PIECES_EACH * 3, 'only the new entity is copied');
    assert.deepEqual(grown.drawn().triangles, expectedTriangles(meshes));
  });

  it('leaves a hidden or isolated-away entity out of the highlight, and brings it back', () => {
    const h = makeHarness();
    const meshes = model(1_000);
    load(h, meshes);
    const selectedIds = new Set(idsOf(1_000));
    h.render({ selectedIds });

    const hidden = frameCost(h, { selectedIds, hiddenIds: new Set([7]) });
    assert.deepEqual(hidden.drawn().triangles, expectedTriangles(meshes.filter((mesh) => mesh.expressId !== 7)));
    assert.equal(frameCost(h, { selectedIds, hiddenIds: new Set([7]) }).buffers, 0, 'settles while hidden');

    const isolated = frameCost(h, { selectedIds, isolatedIds: new Set(idsOf(700)) });
    assert.deepEqual(isolated.drawn().triangles, expectedTriangles(ofEntities(meshes, idsOf(700))));

    assert.deepEqual(frameCost(h, { selectedIds }).drawn().triangles, expectedTriangles(meshes), 'all of it again once the filters are off');
  });

  it('keeps the primary\'s one item out of the pool, and highlights it whole again when the item filter lifts (#4382)', () => {
    const h = makeHarness();
    const meshes = model(1_000);
    load(h, meshes);
    const selectedIds = new Set(idsOf(1_000));
    const item = meshes.find((mesh) => mesh.expressId === 9)!;

    const narrowed = frameCost(h, { selectedIds, selectedId: 9, selectedItemId: item.geometryItemId });
    assert.deepEqual(narrowed.drawn().triangles, expectedTriangles([...meshes.filter((mesh) => mesh.expressId !== 9), item]));
    assert.deepEqual(hydrated(h).filter((mesh) => !mesh.mergedSelection).map((mesh) => mesh.geometryItemId), [item.geometryItemId], 'the item is its own copy, reporting its item');

    const whole = frameCost(h, { selectedIds, selectedId: 9 });
    assert.deepEqual(whole.drawn().triangles, expectedTriangles(meshes));
    assert.equal(frameCost(h, { selectedIds, selectedId: 9 }).buffers, 0);
  });

  it('scopes the pool to the selected model when federated models share ids, and to all of them without one', () => {
    const h = makeHarness();
    const model0 = model(600, () => ({ modelIndex: 0 }));
    const model1 = model(600, (id, i) => ({ modelIndex: 1, positions: new Float32Array([i * 2, id * 2, 5, i * 2 + 1, id * 2, 5, i * 2, id * 2 + 1, 5]) }));
    load(h, [...model0, ...model1]);
    const selectedIds = new Set(idsOf(600));

    const scoped = frameCost(h, { selectedIds, selectedModelIndex: 1 });
    assert.deepEqual(scoped.drawn().triangles, expectedTriangles(model1));
    const all = frameCost(h, { selectedIds });
    assert.ok(scoped.created.every((buffer) => buffer.destroyed === 1), 'the one-model pool is not kept for a wider scope');
    assert.deepEqual(all.drawn().triangles, expectedTriangles([...model0, ...model1]), 'both models, each triangle once');
    assert.equal(all.highlightDraws.length, 2, 'one mesh per model');
  });

  it('rebuilds from moved geometry after an edit to a pooled entity, and drops a removed one', () => {
    const h = makeHarness();
    const meshes = model(1_000);
    load(h, meshes);
    const selectedIds = new Set(idsOf(1_000));
    const first = frameCost(h, { selectedIds });

    assert.equal(h.scene.translateMeshesForEntity(40, [0, 0, 9]), true);
    assert.ok(first.created.every((buffer) => buffer.destroyed === 1), 'the frozen copy holding the moved entity is gone');
    const moved = frameCost(h, { selectedIds });
    assert.deepEqual(moved.drawn().triangles, expectedTriangles(meshes), 'the highlight follows the entity (the test meshes were moved in place)');

    h.scene.removeMeshesForEntity(41);
    const removed = frameCost(h, { selectedIds });
    assert.deepEqual(removed.drawn().triangles, expectedTriangles(meshes.filter((mesh) => mesh.expressId !== 41)));
  });

  it('rebuilds once when a pooled entity gains a piece, and not for another entity\'s', () => {
    const h = makeHarness();
    const meshes = model(1_001);
    load(h, meshes.filter((mesh) => mesh.expressId <= 1_000));
    const selectedIds = new Set(idsOf(1_000));
    const first = frameCost(h, { selectedIds });

    h.scene.appendToBatches(ofEntities(meshes, [1_001]), h.device, h.renderer['pipeline'] as never, false);
    assert.equal(frameCost(h, { selectedIds }).buffers, 0, 'an unselected entity\'s pieces leave the pool current');

    const late = piece(5, 7);
    h.scene.appendToBatches([late], h.device, h.renderer['pipeline'] as never, false);
    const grown = frameCost(h, { selectedIds });
    assert.ok(first.created.every((buffer) => buffer.destroyed === 1));
    assert.deepEqual(grown.drawn().triangles, expectedTriangles([...ofEntities(meshes, idsOf(1_000)), late]));
    assert.equal(frameCost(h, { selectedIds }).buffers, 0, 'and is current again');
  });

  it('pools only the pieces no authored mesh already stands for', () => {
    const h = makeHarness();
    const meshes = model(1_000);
    load(h, meshes);
    const authored = meshes.filter((mesh) => mesh.expressId === 3);
    for (const meshData of authored) {
      const gpu = uploadIndividualMesh(h.device, meshData, { sharedOrigin: null, quantized: false });
      h.renderer.addMesh({ expressId: meshData.expressId, modelIndex: meshData.modelIndex, ...gpu, color: meshData.color });
    }
    h.render({});
    const selectedIds = new Set(idsOf(1_000));
    const cost = frameCost(h, { selectedIds });
    assert.equal(cost.highlightDraws.length, 1 + authored.length, 'the pool, and the authored meshes drawing their own highlight');
    assert.deepEqual(cost.drawn().triangles, expectedTriangles(meshes), 'every piece highlighted exactly once');
    assert.equal(frameCost(h, { selectedIds }).buffers, 0);
  });

  it('frees every pooled buffer when the selection clears', () => {
    const h = makeHarness();
    load(h, model(1_000));
    const { created } = frameCost(h, { selectedIds: new Set(idsOf(1_000)) });
    h.render({});
    assert.ok(created.every((buffer) => buffer.destroyed === 1));
    assert.equal(hydrated(h).length, 0);
  });

  it('leaves a pick\'s copies of unselected entities alone until the selection moves', () => {
    const h = makeHarness();
    const meshes = model(10);
    load(h, meshes);
    const selectedIds = new Set([1]);
    h.render({ selectedIds });
    for (const meshData of ofEntities(meshes, [4])) h.renderer.createMeshFromData(meshData);
    h.render({ selectedIds });
    h.render({ selectedIds });
    assert.equal(hydrated(h).filter((mesh) => mesh.expressId === 4).length, PIECES_EACH, 'kept across frames of one selection');
    h.render({ selectedIds: new Set([2]) });
    assert.equal(hydrated(h).filter((mesh) => mesh.expressId === 4).length, 0, 'freed when the selection changes');
  });

  it('shrinking a pooled selection under the budget goes back to one copy per piece, drawing each triangle once on every frame', () => {
    const h = makeHarness();
    const meshes = model(600);
    load(h, meshes);
    const many = frameCost(h, { selectedIds: new Set(idsOf(251)) });
    assert.equal(many.highlightDraws.length, 1, 'just past the budget: pooled');
    assert.deepEqual(many.drawn().triangles, expectedTriangles(ofEntities(meshes, idsOf(251))));

    const few = frameCost(h, { selectedIds: new Set(idsOf(250)) });
    assert.ok(many.created.every((buffer) => buffer.destroyed === 1), 'the pool is freed');
    assert.equal(few.highlightDraws.length, 250 * PIECES_EACH, 'at the budget: one copy per piece');
    assert.deepEqual(few.drawn().triangles, expectedTriangles(ofEntities(meshes, idsOf(250))), 'the frame that crosses the budget already draws the whole selection');

    const again = frameCost(h, { selectedIds: new Set(idsOf(251)) });
    assert.ok(few.created.every((buffer) => buffer.destroyed === 1));
    assert.deepEqual(again.drawn().triangles, expectedTriangles(ofEntities(meshes, idsOf(251))), 'and back over it');
  });

  it('highlights a selected entity whose geometry only arrives after the selection was made', () => {
    const h = makeHarness();
    const meshes = model(1_000);
    load(h, ofEntities(meshes, idsOf(999)));
    const selectedIds = new Set(idsOf(1_000));
    const first = frameCost(h, { selectedIds });
    assert.deepEqual(first.drawn().triangles, expectedTriangles(ofEntities(meshes, idsOf(999))));

    h.scene.appendToBatches(ofEntities(meshes, [1_000]), h.device, h.renderer['pipeline'] as never, true);
    const streamed = frameCost(h, { selectedIds });
    assert.ok(first.created.every((buffer) => buffer.destroyed === 0), 'the pool is not rebuilt for it');
    assert.deepEqual(streamed.drawn().triangles, expectedTriangles(meshes));
    assert.equal(frameCost(h, { selectedIds }).buffers, 0);
  });

  it('draws nothing freed after the model is cleared while selected, and highlights a reloaded model again', () => {
    const h = makeHarness();
    const meshes = model(1_000);
    load(h, meshes);
    const selectedIds = new Set(idsOf(1_000));
    const first = frameCost(h, { selectedIds });

    h.scene.clear();
    const cleared = frameCost(h, { selectedIds }); // h.render fails on any draw or write of a destroyed buffer
    assert.ok(first.created.every((buffer) => buffer.destroyed === 1));
    assert.equal(cleared.highlightDraws.length, 0);

    load(h, meshes);
    assert.deepEqual(frameCost(h, { selectedIds }).drawn().triangles, expectedTriangles(meshes));
  });

  it('keeps the pool across a colour override: the highlight reads no colour', () => {
    const h = makeHarness();
    load(h, model(1_000));
    const selectedIds = new Set(idsOf(1_000));
    const first = frameCost(h, { selectedIds });
    h.scene.setColorOverrides(new Map([[5, [1, 0, 0, 1]]]), h.device, h.renderer['pipeline'] as never);
    const painted = frameCost(h, { selectedIds });
    assert.equal(painted.buffers, 0);
    assert.ok(first.created.every((buffer) => buffer.destroyed === 0));
    assert.equal(painted.highlightDraws.length, 1);
  });

  // A capture, and the viewer while a focused clash is selected, pass a new Set
  // on every frame. That must compare, not rebuild.
  it('a new Set of the same ids on every frame compares the ids and rebuilds nothing', () => {
    const h = makeHarness();
    const count = 20_000;
    load(h, model(count));
    const first = frameCost(h, { selectedIds: new Set(idsOf(count)) });
    const pieceLookups = countPieceLookups(h.scene);
    const copies = [0, 1, 2].map(() => new CountingSet(idsOf(count)));
    for (const selectedIds of copies) assert.equal(frameCost(h, { selectedIds }).buffers, 0);
    assert.ok(first.created.every((buffer) => buffer.destroyed === 0), 'the pool is neither freed nor rebuilt');
    assert.equal(pieceLookups.count, 0, 'no entity\'s pieces are looked up');
    for (const selectedIds of copies) assert.ok(selectedIds.lookups <= count + 8, `${selectedIds.lookups} id reads for ${count} ids: one pass, no copy`);
  });

  it('flags instanced occurrences of the selection, whether their shard arrives before or after it', () => {
    const shard = (entityId: number): DecodedInstancedShard => ({
      carriesItemIds: false,
      templates: [{ positions: new Float32Array([-1, 0, -1, 1, 0, -1, 0, 0, 1]), normals: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0]), indices: new Uint32Array([0, 1, 2]), origin: [0, 0, 0] }],
      instances: [{ templateIndex: 0, entityId, color: [0.4, 0.5, 0.6, 1], transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) }],
    });
    const selectedCounts = (h: Harness) => h.scene.getInstancedTemplates().map((template) => template.selectedCount);
    const h = makeHarness();
    load(h, model(1_000));
    h.scene.addInstancedShard(h.device, shard(5_001));
    const selectedIds = new Set([...idsOf(1_000), 5_001, 5_002]);
    h.render({ selectedIds });
    assert.deepEqual(selectedCounts(h), [1], 'a shard loaded before the selection');

    h.scene.addInstancedShard(h.device, shard(5_002));
    h.render({ selectedIds });
    assert.deepEqual(selectedCounts(h), [1, 1], 'and one that arrives while it is held, on the next frame');

    h.render({ selectedIds: new Set(idsOf(1_000)) });
    assert.deepEqual(selectedCounts(h), [0, 0], 'deselected with the rest');
  });

  it('never lets a pooled mesh stand for a hovered entity', () => {
    const h = makeHarness();
    load(h, model(1_000));
    h.render({ selectedIds: new Set(idsOf(1_000)) });
    const [pool] = hydrated(h);
    assert.equal(matchesHoveredMesh(pool, pool.expressId, undefined), false, 'outlining it would outline the whole selection');
  });
});

describe('uploadMergedMeshes across entities (#9835)', () => {
  const NO_FRAME = { sharedOrigin: null, quantized: false };
  const uploadDevice = () => ({
    limits: { maxBufferSize: 1 << 28 },
    createBuffer: (desc: { size: number }) => ({ size: desc.size, destroy() { /* no-op */ } }),
    queue: { writeBuffer() { /* no-op */ } },
  }) as unknown as GPUDevice;

  it('names the lowest id of each mesh as its representative, whatever order the pieces come in', () => {
    const merged = uploadMergedMeshes(uploadDevice(), [piece(30, 0), piece(10, 0), piece(20, 0)], () => NO_FRAME);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].representative.expressId, 10);
  });

  it('writes every vertex of every piece with its own position, normal, id and colour salt', () => {
    const written: Uint8Array[] = [];
    const device = {
      limits: { maxBufferSize: 1 << 28 },
      createBuffer: (desc: { size: number }) => ({ size: desc.size, destroy() { /* no-op */ } }),
      queue: { writeBuffer(_buffer: unknown, _offset: number, data: ArrayBufferView) { written.push(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))); } },
    } as unknown as GPUDevice;
    const pieces = [
      piece(30, 0, { color: RED, normals: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) }),
      piece(10, 1, { color: GREY, normals: new Float32Array(0) }),
    ];
    uploadMergedMeshes(device, pieces, () => NO_FRAME, true);
    const vertices = written[0];
    const floats = new Float32Array(vertices.buffer);
    const lanes = new Uint32Array(vertices.buffer);
    const expected: number[][] = [];
    for (const each of pieces) {
      for (let v = 0; v < 3; v++) {
        expected.push([
          each.positions[v * 3], each.positions[v * 3 + 1], each.positions[v * 3 + 2],
          each.normals.length ? each.normals[v * 3] : 0, each.normals.length ? each.normals[v * 3 + 1] : 0, each.normals.length ? each.normals[v * 3 + 2] : 0,
          packEntityLane(each.expressId, colorSaltByte(each.color)),
        ]);
      }
    }
    const actual = expected.map((_, v) => [...floats.subarray(v * 7, v * 7 + 6), lanes[v * 7 + 6]]);
    assert.deepEqual(actual, expected);
  });

  it('never puts ids of two 2^24 pages in one mesh: the 24-bit vertex lane could not tell them apart', () => {
    const PAGE = 0x1000000;
    const merged = uploadMergedMeshes(uploadDevice(), [piece(5, 0), piece(PAGE + 5, 0), piece(PAGE + 3, 0)], () => NO_FRAME);
    assert.deepEqual(merged.map((mesh) => [mesh.representative.expressId, mesh.pieces]), [[5, 1], [PAGE + 3, 2]]);
  });
});

describe('the frame\'s selection snapshot (#9835)', () => {
  const snapshot = () => new SelectionSnapshot();

  it('hands back the same set while the same Set is passed, reading a bounded number of ids a frame', () => {
    const selection = snapshot();
    const ids = new CountingSet(idsOf(100_000));
    const first = selection.update(null, ids);
    const version = selection.getVersion();
    ids.lookups = 0;
    for (let i = 0; i < 5; i++) assert.equal(selection.update(null, ids), first);
    assert.equal(ids.lookups, 5 * SELECTION_IDS_VERIFIED_PER_FRAME, 'not the 100,000 ids a frame a rebuild would read');
    assert.equal(selection.getVersion(), version);
    assert.equal(first.size, 100_000);
  });

  it('sees a Set edited in place to other ids of the same count: at once when small, within a few frames when large', () => {
    const small = snapshot();
    const few = new Set([1, 2, 3]);
    small.update(null, few);
    few.delete(2);
    few.add(9);
    assert.deepEqual(sorted(small.update(null, few)), [1, 3, 9], 'the very next frame');

    const large = snapshot();
    const many = new Set(idsOf(20_000));
    const before = large.update(null, many);
    many.delete(7);
    many.add(99_999);
    const frames = Math.ceil(20_000 / SELECTION_IDS_VERIFIED_PER_FRAME);
    let after = before;
    for (let i = 0; i < frames && after === before; i++) after = large.update(null, many);
    assert.notEqual(after, before, `within ${frames} frames`);
    assert.equal(after.has(99_999), true);
    assert.equal(after.has(7), false);
  });

  it('keeps set and version for a copy of the same ids, and moves both when the content changes', () => {
    const selection = snapshot();
    const first = selection.update(4, new Set([1, 2, 3]));
    const version = selection.getVersion();
    assert.deepEqual([...first], [4, 1, 2, 3], 'the primary first, as the highlight has always been built');
    assert.equal(selection.update(4, new Set([3, 2, 1])), first);
    assert.equal(selection.update(4, new Set([1, 2, 3, 4])), first, 'the primary may also be listed');
    assert.equal(selection.getVersion(), version);

    const next = selection.update(4, new Set([1, 2, 5]));
    assert.notEqual(next, first);
    assert.deepEqual(sorted(next), [1, 2, 4, 5]);
    assert.equal(selection.getVersion(), version + 1);
    assert.deepEqual([...first], [4, 1, 2, 3], 'a set already handed out is never edited');

    assert.deepEqual(sorted(selection.update(null, undefined)), []);
    assert.equal(selection.getVersion(), version + 2);
  });

  it('sees a Set that grew or shrank in place', () => {
    const selection = snapshot();
    const ids = new Set([1, 2, 3]);
    selection.update(null, ids);
    ids.add(4);
    assert.deepEqual(sorted(selection.update(null, ids)), [1, 2, 3, 4]);
    ids.delete(1);
    assert.deepEqual(sorted(selection.update(null, ids)), [2, 3, 4]);
  });
});

describe('XRayEpochTracker with a selection version (#9835)', () => {
  it('bumps on a version change while X-Ray is on, and never reads the ids', () => {
    const tracker = new XRayEpochTracker();
    const ghost: RenderOptions = { ghostExceptIds: new Set([1]) };
    const ids = new CountingSet(idsOf(1_000));
    const base = tracker.update(ghost, ids, 1);
    ids.lookups = 0;
    assert.equal(tracker.update(ghost, ids, 1), base, 'same version: same epoch');
    assert.equal(tracker.update(ghost, ids, 2), base + 1, 'the selection decides who is exempt from fading');
    assert.equal(ids.lookups, 0);
    assert.equal(tracker.update({}, ids, 3), base + 2, 'X-Ray off is a change of its own');
    assert.equal(tracker.update({}, ids, 4), base + 2, 'and the selection alone is none while it is off');
  });
});
