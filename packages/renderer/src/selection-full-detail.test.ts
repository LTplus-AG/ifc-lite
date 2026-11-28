/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A highlighted entity's batch draws its LOD0 triangles, in every path that
 * could draw it otherwise. The selection highlight, its masks and the hover
 * outline redraw the entity from LOD0 with `greater-equal` and no depth bias:
 * a base drawn from LOD1 indices or an HLOD proxy is other triangles, and its
 * colour shows through wherever they lie in front.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { Renderer } from './index.js';
import type { Scene } from './scene.js';
import type { BatchedMesh, RenderOptions } from './types.js';
import { OpaqueVisibilityPass } from './opaque-visibility-pass.js';
import { MESH_UNIFORM_BYTES } from './mesh-rte-uniforms.js';
import { simplifyIndicesByClustering, lodCellSizeForBounds } from './lod-simplify.js';
import { buildStreamNodes, linkHlodLeaves } from './draw-stream-nodes.js';
import { collectStreamItems } from './draw-stream-cull.js';
import { nodeKey, type HlodNode, type HlodTree } from './draw-stream-hlod.js';
import { MemberPick, type StreamFrameInputs } from './draw-stream-types.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};
(globalThis as Record<string, unknown>).GPUMapMode = { READ: 1, WRITE: 2 };
(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
};
(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

/** A 0.2 m slab, 10 m square, both faces tessellated into `n` x `n` quads, in the 7-float batch layout. */
function slab(n: number): { vertices: Float32Array; indices: Uint32Array } {
  const vertices: number[] = [], indices: number[] = [];
  for (const [z, nz] of [[0, -1], [0.2, 1]] as const) {
    const base = vertices.length / 7;
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) vertices.push((i / n) * 10, (j / n) * 10, z, 0, 0, nz, 0);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = base + j * (n + 1) + i;
      indices.push(a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1);
    }
  }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

describe('LOD1 is not the geometry the highlight redraws', () => {
  it('moves triangle corners onto cell representatives, so LOD1 cannot tie with LOD0', () => {
    const { vertices, indices } = slab(100);
    const lod1 = simplifyIndicesByClustering(vertices, 7, indices, lodCellSizeForBounds([0, 0, 0], [10, 10, 0.2]));
    assert.ok(lod1 && lod1.length > 0, 'the slab simplifies');
    const key = (ix: ArrayLike<number>, t: number): string => [0, 1, 2].map((k) => {
      const v = ix[t * 3 + k]! * 7;
      return `${vertices[v]},${vertices[v + 1]},${vertices[v + 2]}`;
    }).sort().join('|');
    const lod0 = new Set(Array.from({ length: indices.length / 3 }, (_, t) => key(indices, t)));
    let foreign = 0;
    for (let t = 0; t < lod1.length / 3; t++) if (!lod0.has(key(lod1, t))) foreign++;
    assert.ok(foreign > 0, `every LOD1 triangle is a LOD0 triangle (${lod1.length / 3} triangles): the tie would hold`);
  });
});

function member(id: number, x: number): BatchedMesh {
  return {
    id, colorKey: `k${id}`, vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 30, color: [1, 1, 1, 1],
    expressIds: [id * 100], bounds: { min: [x, 0, 0], max: [x + 1, 1, 1] }, lod1IndexBuffer: {} as GPUBuffer, lod1IndexCount: 6,
  } as BatchedMesh;
}

function frame(over: Partial<StreamFrameInputs> & Record<string, unknown>): StreamFrameInputs {
  return {
    pass: {} as GPURenderPassEncoder, mode: { discardFree: true, objectId: false }, allowBundles: true,
    visible: () => true, projectedPx: () => 5, contribPx: 0, lodPx: 10, eye: { x: 0, y: 0, z: 0 },
    // A tiny viewport keeps memberPicks' node lower bound out of the way: `projectedPx` decides.
    projection: { ortho: false, orthoHalfHeight: 1, fovYRadians: Math.PI / 2, viewportHeightPx: 1e-6 }, interacting: false, ...over,
  } as StreamFrameInputs;
}

describe('draw stream: a highlighted entity\'s batch draws full detail', () => {
  const members = [member(1, 0), member(2, 2), member(3, 4)];
  const nodes = buildStreamNodes(members, 32);
  const links = linkHlodLeaves(null, nodes, [], [], [], 32);

  it('draws that member at LOD0 while its node\'s other members stay at LOD1', () => {
    const [plain] = collectStreamItems(frame({}), nodes, null, links, 0, members);
    assert.equal(plain!.lod1, true, 'control: small members draw LOD1');
    const [held] = collectStreamItems(frame({ fullDetail: new Set([members[1]!]) }), nodes, null, links, 0, members);
    assert.ok(held!.picks, 'the node draws per member');
    assert.deepEqual([...held!.picks!], [MemberPick.Lod1, MemberPick.Lod0, MemberPick.Lod1]);
  });

  it('keeps culling a member too small to draw', () => {
    const [held] = collectStreamItems(frame({ contribPx: 8, fullDetail: new Set([members[1]!]) }), nodes, null, links, 0, members);
    assert.equal(held, undefined, 'every member is below the contribution threshold: nothing draws, the highlight draws alone');
  });

  it('refines an HLOD node over that batch instead of drawing its proxy', () => {
    const far = [member(4, 1030), member(5, 1100)]; // level-1 cells (64 m) 16 and 17, under one level-2 node
    const farNodes = buildStreamNodes(far, 32);
    const level1 = new Map<string, HlodNode>(), level2 = new Map<string, HlodNode>();
    const node = (level: number, c: [number, number, number], min: [number, number, number], max: [number, number, number]): HlodNode =>
      ({ level, key: nodeKey(level, c), coords: c, min, max, error: 1, children: [], state: 'ready', draws: [], cpu: [], tris: 0, bundle: [], ortho: [] });
    const a = node(1, [16, 0, 0], [1024, 0, 0], [1088, 64, 64]), b = node(1, [17, 0, 0], [1088, 0, 0], [1152, 64, 64]);
    const root = node(2, [8, 0, 0], [1024, 0, 0], [1152, 64, 64]);
    root.children = [a, b];
    level1.set(a.key, a); level1.set(b.key, b); level2.set(root.key, root);
    const h = { levels: [undefined, level1, level2], roots: [root], outsideNodes: new Set<string>(), leafCell: 32 } as unknown as HlodTree;
    const farLinks = linkHlodLeaves(h, farNodes, [], far, far.map(() => ({ alpha: 1, anchor: null, overrideBits: 0 })), 32);
    const at = (over: Record<string, unknown>) => collectStreamItems(frame({ projection: { ortho: false, orthoHalfHeight: 1, fovYRadians: Math.PI / 2, viewportHeightPx: 100 }, ...over }), farNodes, h, farLinks, 2, far);

    const plain = at({});
    assert.deepEqual(plain.map((it) => it.proxy?.key), [root.key], 'control: the far region draws as one proxy');
    const held = at({ fullDetail: new Set([far[0]!]) });
    assert.equal(held.some((it) => it.proxy === root || it.proxy === a), false, 'no proxy over the highlighted batch');
    assert.ok(held.some((it) => it.leaf?.members.some((i) => far[i] === far[0])), 'its leaf draws');
    assert.ok(held.some((it) => it.proxy === b), 'the sibling region keeps its proxy');
  });
});

interface FakeBuffer { size: number; usage: number; destroy(): void; getMappedRange(): ArrayBuffer; unmap(): void; mapAsync(): Promise<void> }

/** The real render loop against a stub GPU that records each draw's pipeline, vertex and index buffers. */
function harness() {
  const draws: { pipeline: unknown; vertexBuffer: unknown; indexBuffer: unknown; count: number }[] = [];
  let pipeline: unknown = null, vertexBuffer: unknown = null, indexBuffer: unknown = null;
  const pass = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, prop) {
      if (prop === 'setPipeline') return (p: unknown) => { pipeline = p; };
      if (prop === 'setVertexBuffer') return (slot: number, b: unknown) => { if (slot === 0) vertexBuffer = b; };
      if (prop === 'setIndexBuffer') return (b: unknown) => { indexBuffer = b; };
      if (prop === 'drawIndexed') return (count: number) => { draws.push({ pipeline, vertexBuffer, indexBuffer, count }); };
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
  const queue = { writeBuffer() {}, writeTexture() {}, copyExternalImageToTexture() {}, submit() {}, onSubmittedWorkDone: () => Promise.resolve() };
  const device = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, prop) {
      switch (prop) {
        case 'lost': return new Promise<void>(() => {});
        case 'limits': return { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 };
        case 'queue': return queue;
        case 'popErrorScope': return () => Promise.resolve(null);
        case 'createCommandEncoder': return () => encoder;
        case 'createBuffer': return (desc: { size: number; usage?: number }): FakeBuffer => ({
          size: desc.size, usage: desc.usage ?? 0, destroy() {}, getMappedRange: () => new ArrayBuffer(desc.size), unmap() {}, mapAsync: () => Promise.resolve(),
        });
        case 'createBindGroup': return () => ({});
        case 'createTexture': return (desc: { size: { width: number; height: number } }) => ({ width: desc.size.width, height: desc.size.height, createView: () => ({}), destroy() {} });
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
  Object.assign(wrapper, { device, canvas, contextConfigured: true, lastWidth: 256, lastHeight: 256,
    context: { configure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) } });
  const visibility = new OpaqueVisibilityPass(device as unknown as GPUDevice, 1);
  const OPAQUE = { label: 'opaque', getBindGroupLayout: () => ({}) };
  (renderer as unknown as Record<string, unknown>)['pipeline'] = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, prop) {
      switch (prop) {
        case 'visibility': return visibility;
        case 'needsResize': return () => false;
        case 'getSampleCount': return () => 1;
        case 'getMultisampleTextureView': return () => null;
        case 'getUniformBufferSize': return () => MESH_UNIFORM_BYTES;
        case 'getQuantizedPipelineVariant': return () => null;
        case 'getSelectionPipeline': return () => ({ label: 'selection' });
        case 'getBatchSelectionPipeline': return () => null;
        case 'getPipeline': case 'opaquePipeline': return () => OPAQUE;
        case 'getTransparentPipeline': return () => ({ label: 'transparent' });
        case 'getGhostPipeline': return () => ({ label: 'ghost' });
        default: return () => ({});
      }
    },
  });
  return { renderer, draws, OPAQUE, scene: renderer['scene'] as Scene, device: device as unknown as GPUDevice };
}

describe('per-batch loop: a highlighted entity\'s batch draws full detail', () => {
  it('draws LOD0 indices for the selected entity\'s batch while it projects below the LOD threshold', () => {
    const h = harness();
    const wall: MeshData = {
      expressId: 7, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]), color: [0.5, 0.5, 0.5, 1],
    } as MeshData;
    h.scene.appendToBatches([wall], h.device, h.renderer['pipeline'] as never, false);
    h.renderer.fitToView();
    const [batch] = h.scene.getBatchedMeshes();
    // A LOD1 range, as the batch build makes for one of 500+ triangles.
    Object.assign(batch!, { lod1IndexBuffer: { size: 12, destroy() {} } as unknown as GPUBuffer, lod1IndexCount: 3 });
    const base = (options: RenderOptions) => {
      h.draws.length = 0;
      h.renderer.render({ visualEnhancement: { enabled: false }, lod: { screenPx: 1e9 }, ...options });
      return h.draws.filter((d) => d.pipeline === h.OPAQUE && d.vertexBuffer === batch!.vertexBuffer);
    };
    const plain = base({});
    assert.ok(plain.length > 0 && plain.every((d) => d.indexBuffer === batch!.lod1IndexBuffer), 'control: an unselected small batch draws LOD1');
    const selected = base({ selectedId: 7 });
    assert.ok(selected.length > 0, 'the base draws');
    assert.ok(selected.every((d) => d.indexBuffer === batch!.indexBuffer), 'the selected entity\'s batch draws its LOD0 indices');
    const hovered = base({ hoverOutline: { id: 7 } } as RenderOptions);
    assert.ok(hovered.every((d) => d.indexBuffer === batch!.indexBuffer), 'so does the hovered entity\'s');

    // A compact page decides per part (lod-parts.ts): the page holding the entity draws every part at LOD0.
    Object.assign(batch!, { lodParts: [{ bounds: batch!.bounds!, lod0Start: 0, lod0Count: 3, lod1: true, lod1Start: 0, lod1Count: 3 }] });
    assert.ok(base({}).every((d) => d.indexBuffer === batch!.lod1IndexBuffer), 'control: its small part draws LOD1');
    const page = base({ selectedId: 7 });
    assert.ok(page.length > 0 && page.every((d) => d.indexBuffer === batch!.indexBuffer), 'the page holding the selected entity draws LOD0 parts');
  });
});
