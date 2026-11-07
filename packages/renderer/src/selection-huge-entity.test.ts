/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from './index.js';
import type { MeshData } from '@ifc-lite/geometry';
import type { Scene } from './scene.js';
import type { RenderOptions } from './types.js';
import { OpaqueVisibilityPass } from './opaque-visibility-pass.js';
import { MESH_UNIFORM_BYTES } from './mesh-rte-uniforms.js';
// A namespace import, so the file still loads with the production change reverted
// and every test below fails on an assertion instead of on a missing export.
import * as upload from './individual-mesh-upload.js';
import type { IndividualMeshFrame, MergedMeshGpu } from './individual-mesh-upload.js';
import { planPickMeshHydration } from './pick-mesh-budget.js';

/**
 * #9192 part B: one entity holding tens of thousands of pieces (a mapped
 * SurfaceModel with one IfcShellBasedSurfaceModel per item) must not cost one
 * set of GPU buffers per piece when selected or hovered. Drives the REAL
 * render() loop against a stub GPU that records every allocation and draw.
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

function makeHarness() {
  const stats = {
    buffers: [] as FakeBuffer[], bindGroups: 0, writes: 0, destroyedBufferDraws: 0,
    /** Throw like host memory pressure on the next vertex or index buffers. */
    failGeometryBuffers: false,
    draws: [] as { vertexBuffer: FakeBuffer; indexBuffer: FakeBuffer; indexCount: number; pipeline: unknown }[],
  };
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
      if (buffer.usage & 48) { // VERTEX | INDEX: keep the geometry to assert on
        buffer.bytes ??= new Uint8Array(buffer.size);
        buffer.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
      }
    },
    writeTexture() { /* no-op */ }, copyExternalImageToTexture() { /* no-op */ }, submit() { /* no-op */ },
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
          if (stats.failGeometryBuffers && ((desc.usage ?? 0) & 48)) throw new RangeError('Array buffer allocation failed');
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
    },
  };
}

const GREY: [number, number, number, number] = [0.5, 0.5, 0.5, 1];

/** Piece `i` of an entity: one triangle of its own, placed so pieces are distinguishable. */
function piece(expressId: number, i: number, overrides: Partial<MeshData> = {}): MeshData {
  const x = i * 2;
  return {
    expressId,
    positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: GREY,
    geometryItemId: 100_000 + i,
    ...overrides,
  } as MeshData;
}

function entity(expressId: number, pieces: number, overrides: (i: number) => Partial<MeshData> = () => ({})): MeshData[] {
  return Array.from({ length: pieces }, (_, i) => piece(expressId, i, overrides(i)));
}

/** Load through the real batching path, with bounds stripped so the default camera cannot cull. */
function load(h: ReturnType<typeof makeHarness>, meshes: MeshData[]): void {
  h.scene.appendToBatches(meshes, h.device, h.renderer['pipeline'] as never, false);
  h.render();
  for (const batch of h.scene.getBatchedMeshes()) batch.bounds = undefined;
}

const VERTEX_OR_INDEX = 48;

const RED: [number, number, number, number] = [0.8, 0.1, 0.1, 1];
/** The 500-piece pick budget: at most this many pieces keep one copy each. */
const MERGE_PIECES_ABOVE = 500;
const HUGE = MERGE_PIECES_ABOVE + 1;

/** The merged uploader, asserted present rather than imported by name. */
function uploadMergedMeshes(device: GPUDevice, pieces: readonly MeshData[], frameOf: (meshData: MeshData) => IndividualMeshFrame): MergedMeshGpu[] {
  const fn = (upload as Record<string, unknown>).uploadMergedMeshes;
  assert.equal(typeof fn, 'function', 'individual-mesh-upload exports uploadMergedMeshes');
  return (fn as typeof uploadMergedMeshes)(device, pieces, frameOf);
}

type Harness = ReturnType<typeof makeHarness>;

/**
 * What one render costs: its new per-mesh buffers (geometry and mesh uniforms,
 * not the frame's own once-per-renderer uniforms) and its highlight draws.
 */
function frameCost(h: Harness, options: RenderOptions) {
  const before = h.stats.buffers.length;
  const bindGroups = h.stats.bindGroups;
  const draws = h.stats.draws.length;
  h.render(options);
  const highlightDraws = h.stats.draws.slice(draws).filter((draw) => draw.pipeline === h.SELECTION);
  const origins = new Map(h.scene.getMeshes().map((mesh) => [mesh.vertexBuffer as unknown as FakeBuffer, mesh.rteOrigin]));
  const created = h.stats.buffers.slice(before).filter((buffer) => (buffer.usage & VERTEX_OR_INDEX) !== 0 || buffer.size === MESH_UNIFORM_BYTES);
  return {
    buffers: created.length,
    geometryBuffers: created.filter((buffer) => (buffer.usage & VERTEX_OR_INDEX) !== 0).length,
    bindGroups: h.stats.bindGroups - bindGroups,
    highlightDraws,
    created,
    /** World-space triangles this frame's highlight drew, each in its mesh's own frame. */
    drawn: () => drawnTriangles(highlightDraws, origins),
  };
}

/**
 * Decode what a highlight draw actually put on screen: one `x,y,z` triangle key
 * per drawn triangle, sorted, plus the entity id in each vertex's lane.
 */
function drawnTriangles(
  draws: readonly { vertexBuffer: FakeBuffer; indexBuffer: FakeBuffer; indexCount: number }[],
  origins: ReadonlyMap<FakeBuffer, readonly [number, number, number] | undefined>,
) {
  const triangles: string[] = [];
  const ids = new Set<number>();
  for (const draw of draws) {
    const bytes = draw.vertexBuffer.bytes!;
    const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const lanes = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const indexBytes = draw.indexBuffer.bytes!;
    const indices = new Uint32Array(indexBytes.buffer, indexBytes.byteOffset, indexBytes.byteLength / 4);
    assert.equal(indices.length, draw.indexCount);
    for (let i = 0; i < draw.indexCount; i += 3) {
      const corners: number[] = [];
      for (let c = 0; c < 3; c++) {
        const base = indices[i + c] * 7;
        const origin = origins.get(draw.vertexBuffer) ?? [0, 0, 0];
        corners.push(floats[base] + origin[0], floats[base + 1] + origin[1], floats[base + 2] + origin[2]);
        ids.add(lanes[base + 6] & 0xFFFFFF);
      }
      triangles.push(corners.join(','));
    }
  }
  return { triangles: triangles.sort(), ids };
}

function expectedTriangles(meshes: readonly MeshData[]): string[] {
  return meshes.map((mesh) => Array.from(mesh.positions).join(',')).sort();
}

describe('selecting an entity with a huge piece count (#9192)', () => {
  it('allocates and draws per entity, not per piece, however many pieces it holds', () => {
    for (const pieces of [HUGE, 20_000]) {
      const h = makeHarness();
      load(h, [piece(1, 0), ...entity(9, pieces)]);
      const first = frameCost(h, { selectedId: 9 });
      assert.equal(first.buffers, 3, `${pieces} pieces: one vertex, index and uniform buffer in total`);
      assert.ok(first.bindGroups <= 2, `${pieces} pieces: one mesh bind group, and at most one frame-wide`);
      assert.equal(first.highlightDraws.length, 1, `${pieces} pieces: one highlight draw`);

      const next = frameCost(h, { selectedId: 9 });
      assert.equal(next.buffers, 0, 'a settled selection allocates nothing');
      assert.equal(next.bindGroups, 0);
      assert.equal(next.highlightDraws.length, 1);
    }
  });

  it('draws exactly the entity\'s geometry exactly once, stamped with its id', () => {
    const h = makeHarness();
    const pieces = entity(9, 1_000);
    load(h, [piece(1, 0, { positions: new Float32Array([-9, -9, -9, -8, -9, -9, -9, -8, -9]) }), ...pieces]);
    const drawn = frameCost(h, { selectedId: 9 }).drawn();
    assert.deepEqual(drawn.triangles, expectedTriangles(pieces));
    assert.deepEqual([...drawn.ids], [9], 'no other entity leaks into the highlight');
  });

  it('keeps ordinary entities per piece, up to and including the threshold', () => {
    const h = makeHarness();
    const atLimit = entity(9, MERGE_PIECES_ABOVE);
    load(h, atLimit);
    const first = frameCost(h, { selectedId: 9 });
    assert.equal(first.buffers, MERGE_PIECES_ABOVE * 3, 'individual vertex, index and uniform buffers');
    assert.equal(first.highlightDraws.length, MERGE_PIECES_ABOVE);
    const hydrated = h.scene.getMeshes().filter((mesh) => mesh.hydrated);
    assert.equal(hydrated.length, MERGE_PIECES_ABOVE);
    assert.ok(hydrated.every((mesh) => mesh.mergedSelection === undefined));
    assert.deepEqual(hydrated.map((mesh) => mesh.geometryItemId).sort(), atLimit.map((mesh) => mesh.geometryItemId).sort(), 'each copy reports its own item');
    assert.deepEqual(first.drawn().triangles, expectedTriangles(atLimit));

    const twoPieces = makeHarness();
    load(twoPieces, entity(9, 2));
    assert.equal(frameCost(twoPieces, { selectedId: 9 }).buffers, 6);
  });

  it('frees every merged buffer on deselect, and rebuilds on reselect', () => {
    const h = makeHarness();
    load(h, entity(9, HUGE));
    const { created } = frameCost(h, { selectedId: 9 });
    assert.equal(created.length, 3);

    h.render({});
    assert.ok(created.every((buffer) => buffer.destroyed === 1), 'vertex, index and uniform buffers all freed');
    assert.equal(h.scene.getMeshes().filter((mesh) => mesh.hydrated).length, 0);

    assert.equal(frameCost(h, { selectedId: 9 }).buffers, 3);
  });

  it('splits by colour, keeping each colour\'s triangles in its own mesh and draw', () => {
    const h = makeHarness();
    const pieces = entity(9, HUGE * 2, (i) => ({ color: i % 2 ? RED : GREY }));
    load(h, pieces);
    const cost = frameCost(h, { selectedId: 9 });
    assert.equal(cost.highlightDraws.length, 2);
    assert.equal(cost.buffers, 6);
    assert.deepEqual(cost.drawn().triangles, expectedTriangles(pieces));
    const merged = h.scene.getMeshes().filter((mesh) => mesh.hydrated);
    assert.deepEqual(merged.map((mesh) => mesh.color[0]).sort(), [GREY[0], RED[0]].sort());
  });

  it('narrows to one item and widens back, drawing each state exactly once (#4382)', () => {
    const h = makeHarness();
    const pieces = entity(9, HUGE);
    load(h, pieces);
    const whole = frameCost(h, { selectedId: 9 });
    assert.equal(whole.highlightDraws.length, 1);

    const item = pieces[7];
    const narrowed = frameCost(h, { selectedId: 9, selectedItemId: item.geometryItemId });
    assert.ok(whole.created.every((buffer) => buffer.destroyed === 1), 'the whole-product merge is freed');
    assert.equal(narrowed.buffers, 3, 'the item is one ordinary per-piece copy');
    assert.deepEqual(narrowed.drawn().triangles, expectedTriangles([item]));
    const itemMesh = h.scene.getMeshes().filter((mesh) => mesh.hydrated);
    assert.equal(itemMesh.length, 1);
    assert.equal(itemMesh[0].geometryItemId, item.geometryItemId);

    const widened = frameCost(h, { selectedId: 9 });
    assert.ok(narrowed.created.every((buffer) => buffer.destroyed === 1), 'the item copy does not linger beside the merge');
    assert.deepEqual(widened.drawn().triangles, expectedTriangles(pieces));
  });

  it('widening from an item whose own pieces merged rebuilds the whole product, not just that item', () => {
    const h = makeHarness();
    const itemPieces = entity(9, HUGE, () => ({ geometryItemId: 777 }));
    const otherPieces = entity(9, 3, (i) => ({ geometryItemId: 778, positions: new Float32Array([i, 9, 0, i + 1, 9, 0, i, 10, 0]) }));
    load(h, [...itemPieces, ...otherPieces]);

    const narrowed = frameCost(h, { selectedId: 9, selectedItemId: 777 });
    assert.equal(narrowed.highlightDraws.length, 1);
    assert.deepEqual(narrowed.drawn().triangles, expectedTriangles(itemPieces));

    const widened = frameCost(h, { selectedId: 9 });
    assert.deepEqual(widened.drawn().triangles, expectedTriangles([...itemPieces, ...otherPieces]));
  });

  it('holds across a translucent entity, whose copies also draw in the main pass', () => {
    const h = makeHarness();
    const glass: [number, number, number, number] = [0.2, 0.4, 0.8, 0.3];
    const pieces = entity(9, HUGE, () => ({ color: glass }));
    load(h, pieces);
    // Each of these frames retires the last state's buffers: the harness's draw
    // assertion fails if the frame then binds one through a stale mesh list.
    h.render({ selectedId: 9 });
    h.render({ selectedId: 9 });
    h.render({ selectedId: 9, selectedItemId: pieces[3].geometryItemId });
    h.render({ selectedId: 9, selectedItemId: pieces[3].geometryItemId });
    h.render({ selectedId: 9 });
    const settled = frameCost(h, { selectedId: 9 });
    assert.equal(settled.highlightDraws.length, 1);
    assert.deepEqual(settled.drawn().triangles, expectedTriangles(pieces));
  });

  it('scopes to the selected model when federated models share an id, and to all without one', () => {
    const h = makeHarness();
    const model0 = entity(9, HUGE, () => ({ modelIndex: 0 }));
    const model1 = entity(9, HUGE, (i) => ({ modelIndex: 1, positions: new Float32Array([i * 2, 5, 0, i * 2 + 1, 5, 0, i * 2, 6, 0]) }));
    load(h, [...model0, ...model1]);

    const first = frameCost(h, { selectedId: 9, selectedModelIndex: 0 });
    assert.deepEqual(first.drawn().triangles, expectedTriangles(model0));
    assert.deepEqual(h.scene.getMeshes().filter((mesh) => mesh.hydrated).map((mesh) => mesh.modelIndex), [0]);

    const second = frameCost(h, { selectedId: 9, selectedModelIndex: 1 });
    assert.ok(first.created.every((buffer) => buffer.destroyed === 1), 'the other model\'s merge is freed');
    assert.deepEqual(second.drawn().triangles, expectedTriangles(model1));

    const both = makeHarness();
    load(both, [...model0, ...model1]);
    const all = frameCost(both, { selectedId: 9 });
    assert.equal(all.highlightDraws.length, 2, 'one merge per model');
    assert.deepEqual(all.drawn().triangles, expectedTriangles([...model0, ...model1]));
  });

  it('rebuilds once when pieces arrive for the selected entity, never drawing both', () => {
    const h = makeHarness();
    const pieces = entity(9, HUGE);
    load(h, pieces);
    const before = frameCost(h, { selectedId: 9 });

    const late = entity(9, 3, (i) => ({ positions: new Float32Array([i, 9, 0, i + 1, 9, 0, i, 10, 0]) }));
    h.scene.appendToBatches(late, h.device, h.renderer['pipeline'] as never, false);
    const grown = frameCost(h, { selectedId: 9 });
    assert.ok(before.created.every((buffer) => buffer.destroyed === 1));
    assert.deepEqual(grown.drawn().triangles, expectedTriangles([...pieces, ...late]));

    assert.equal(frameCost(h, { selectedId: 9 }).buffers, 0, 'and is current again');
  });

  it('keeps the merge while a cold-evicted bucket has shrunk the piece list, and when it comes back', () => {
    const h = makeHarness();
    const pieces = entity(9, HUGE + 10);
    load(h, pieces);
    const merged = frameCost(h, { selectedId: 9 });

    const list = h.scene['meshDataMap'].get(9)!;
    const evicted = list.splice(0, 20);
    assert.equal(frameCost(h, { selectedId: 9 }).buffers, 0, 'an evicted piece stays in the highlight, as a per-piece copy would');
    list.push(...evicted);
    assert.equal(frameCost(h, { selectedId: 9 }).buffers, 0, 'a restored piece was already drawn');
    assert.ok(merged.created.every((buffer) => buffer.destroyed === 0));
  });

  it('rebuilds from moved geometry after an edit, and frees the merge on removal', () => {
    const h = makeHarness();
    const pieces = entity(9, HUGE);
    load(h, pieces);
    const first = frameCost(h, { selectedId: 9 });

    assert.equal(h.scene.translateMeshesForEntity(9, [100, 0, 0]), true);
    assert.ok(first.created.every((buffer) => buffer.destroyed === 1), 'the frozen copy is gone');
    const moved = frameCost(h, { selectedId: 9 });
    assert.equal(moved.buffers, 3);
    assert.deepEqual(moved.drawn().triangles, expectedTriangles(pieces));

    h.scene.removeMeshesForEntity(9);
    assert.ok(moved.created.every((buffer) => buffer.destroyed === 1));
    assert.equal(h.scene.getMeshes().length, 0);
  });

  it('survives a failed merge: no partial highlight, one warning, and it recovers', () => {
    const warn = mock.method(console, 'warn', () => undefined);
    try {
      const h = makeHarness();
      const pieces = entity(9, HUGE);
      load(h, pieces);
      h.stats.failGeometryBuffers = true;
      h.render({ selectedId: 9 });
      h.render({ selectedId: 9 });
      assert.equal(h.scene.getMeshes().filter((mesh) => mesh.hydrated).length, 0);
      const warnings = warn.mock.calls.filter((call) => String(call.arguments[0]).includes('merged selection highlight'));
      assert.equal(warnings.length, 1, 'warned once, not every frame');

      h.stats.failGeometryBuffers = false;
      assert.deepEqual(frameCost(h, { selectedId: 9 }).drawn().triangles, expectedTriangles(pieces));
    } finally {
      warn.mock.restore();
    }
  });

  it('sends picks to the CPU raycast while merged, which still reports the piece\'s item (#2985)', () => {
    const h = makeHarness();
    const pieces = entity(9, HUGE);
    load(h, pieces);
    h.render({ selectedId: 9 });
    assert.equal(planPickMeshHydration(h.scene).overBudget, true, 'a merged mesh cannot name the item it was hit on');

    const target = pieces[42];
    const hit = h.scene.raycast({ x: target.positions[0] + 0.25, y: 0.25, z: 5 }, { x: 0, y: 0, z: -1 });
    assert.equal(hit?.expressId, 9);
    assert.equal(hit?.geometryItemId, target.geometryItemId);
  });
});

describe('hovering an entity with a huge piece count (#9192)', () => {
  it('uploads one merged copy, frees it, and leaves per-piece hover alone', () => {
    const h = makeHarness();
    const pieces = entity(9, HUGE);
    load(h, [...pieces, ...entity(2, 3)]);

    const hovered = frameCost(h, { hoverOutline: { id: 9 } });
    assert.equal(hovered.geometryBuffers, 2, 'one vertex and one index buffer, no per-piece pairs');

    const small = frameCost(h, { hoverOutline: { id: 2 } });
    const geometry = (cost: typeof hovered) => cost.created.filter((buffer) => (buffer.usage & VERTEX_OR_INDEX) !== 0);
    assert.ok(geometry(hovered).every((buffer) => buffer.destroyed === 1), 'moving on frees the merged copy');
    assert.equal(small.geometryBuffers, 6, 'an ordinary entity still uploads each piece');

    h.render({});
    assert.ok(geometry(small).every((buffer) => buffer.destroyed === 1));
  });

  it('reuses the selection\'s merged mesh when the hovered entity is selected', () => {
    const h = makeHarness();
    load(h, entity(9, HUGE));
    h.render({ selectedId: 9 });
    assert.equal(frameCost(h, { selectedId: 9, hoverOutline: { id: 9 } }).buffers, 0);
  });
});

describe('uploadMergedMeshes (#9192)', () => {
  const NO_FRAME: IndividualMeshFrame = { sharedOrigin: null, quantized: false };

  function uploadDevice(maxBufferSize = 1 << 28, failAtBuffer = Infinity) {
    const created: FakeBuffer[] = [];
    const device = {
      limits: { maxBufferSize },
      createBuffer(desc: { size: number; usage: number }) {
        if (created.length >= failAtBuffer) throw new RangeError('Array buffer allocation failed');
        const buffer: FakeBuffer = { size: desc.size, usage: desc.usage, destroyed: 0, bytes: null, destroy() { this.destroyed++; }, getMappedRange: () => new ArrayBuffer(0), unmap() { /* no-op */ }, mapAsync: () => Promise.resolve() };
        created.push(buffer);
        return buffer;
      },
      queue: { writeBuffer(buffer: FakeBuffer, offset: number, data: ArrayBufferView) { buffer.bytes ??= new Uint8Array(buffer.size); buffer.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset); } },
    } as unknown as GPUDevice;
    return { device, created };
  }

  const vertexBytes = (mesh: { vertexBuffer: GPUBuffer }) => (mesh.vertexBuffer as unknown as FakeBuffer).bytes!;

  for (const [name, frame] of [
    ['a shared frame', { sharedOrigin: [1000.5, -2000.25, 3.125], quantized: false }],
    ['a quantized shared frame', { sharedOrigin: [1000.5, -2000.25, 3.125], quantized: true }],
    ['no shared frame', NO_FRAME],
  ] as [string, IndividualMeshFrame][]) {
    it(`is bit-coincident with the per-piece upload in ${name}, so depth matches the batch`, () => {
      const { device } = uploadDevice();
      const pieces = entity(9, 5, (i) => ({
        origin: [1000, -2000, 3] as [number, number, number],
        positions: new Float32Array([i + 0.1, 0.2, 0.3, i + 1.7, 0.2, 0.3, i + 0.1, 1.9, 0.3]),
        normals: new Float32Array([0.6, 0, 0.8, 0.6, 0, 0.8, 0.6, 0, 0.8]),
      }));
      const [merged, ...rest] = uploadMergedMeshes(device, pieces, () => frame);
      assert.equal(rest.length, 0);
      assert.equal(merged.pieces, 5);

      const each = pieces.map((p) => upload.uploadIndividualMesh(device, p, frame));
      const concatenated = new Uint8Array(each.reduce((sum, mesh) => sum + vertexBytes(mesh).length, 0));
      let at = 0;
      for (const mesh of each) { concatenated.set(vertexBytes(mesh), at); at += vertexBytes(mesh).length; }
      assert.deepEqual(vertexBytes(merged), concatenated);
      assert.deepEqual(Array.from(merged.transform.m), Array.from(each[0].transform.m));
      assert.deepEqual(merged.rteOrigin, each[0].rteOrigin);
    });
  }

  it('never folds pieces with different origins or frames into one mesh', () => {
    const { device } = uploadDevice();
    const framelessFar = uploadMergedMeshes(device, entity(9, 4, (i) => ({ origin: [i % 2 ? 5000 : 0, 0, 0] as [number, number, number] })), () => NO_FRAME);
    assert.deepEqual(framelessFar.map((mesh) => mesh.rteOrigin[0]).sort((a, b) => a - b), [0, 5000]);

    const frames: IndividualMeshFrame[] = [{ sharedOrigin: [1, 0, 0], quantized: false }, { sharedOrigin: [2, 0, 0], quantized: false }, { sharedOrigin: [2, 0, 0], quantized: true }];
    const pieces = entity(9, 6);
    const byPiece = new Map(pieces.map((p, i) => [p, frames[i % 3]]));
    assert.equal(uploadMergedMeshes(device, pieces, (p) => byPiece.get(p)!).length, 3);
  });

  it('never merges pieces of different federated models, whatever else they share', () => {
    const { device } = uploadDevice();
    const merged = uploadMergedMeshes(device, entity(9, 4, (i) => ({ modelIndex: i % 2 })), () => NO_FRAME);
    assert.deepEqual(merged.map((mesh) => mesh.representative.modelIndex).sort(), [0, 1]);
  });

  it('fills a mesh up to one GPU buffer, keeping every triangle', () => {
    const triangleBytes = 3 * 28;
    const { device } = uploadDevice(Math.ceil((triangleBytes * 4) / 0.9));
    const pieces = entity(9, 10);
    const merged = uploadMergedMeshes(device, pieces, () => NO_FRAME);
    assert.equal(merged.length, 3, 'four, four, and the remaining two');
    assert.ok(merged.every((mesh) => mesh.vertexBuffer.size <= triangleBytes * 4));
    const drawn = drawnTriangles(merged as never, new Map());
    assert.deepEqual(drawn.triangles, expectedTriangles(pieces));
  });

  it('merges past the same 500-piece budget picks use', () => {
    assert.equal((upload as Record<string, unknown>).MERGE_PIECES_ABOVE, MERGE_PIECES_ABOVE);
  });

  it('skips empty pieces rather than allocating for them', () => {
    const { device, created } = uploadDevice();
    const empty = piece(9, 0, { positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0) });
    assert.equal(uploadMergedMeshes(device, [empty], () => NO_FRAME).length, 0);
    assert.equal(created.length, 0);
  });

  it('frees what it created when a later allocation throws', () => {
    const { device, created } = uploadDevice(1 << 28, 3);
    const pieces = entity(9, 2, (i) => ({ color: i ? RED : GREY }));
    assert.throws(() => uploadMergedMeshes(device, pieces, () => NO_FRAME), RangeError);
    assert.equal(created.length, 3);
    assert.deepEqual(created.slice(0, 2).map((buffer) => buffer.destroyed), [1, 1]);
  });
});
