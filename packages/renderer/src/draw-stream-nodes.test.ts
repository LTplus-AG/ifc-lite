/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BatchedMesh } from './types.js';
import { buildStreamNodes, linkHlodLeaves } from './draw-stream-nodes.js';
import { collectStreamItems, StreamDrawBudget } from './draw-stream-cull.js';
import { memberPicks } from './draw-stream-picks.js';
import { DrawStream } from './draw-stream.js';
import { DrawStreamGate, RendererDrawStream } from './draw-stream-frame.js';
import { HlodTree, nodeKey, proxySlotKey, type HlodNode } from './draw-stream-hlod.js';
import type { MeshData } from '@ifc-lite/geometry';
import { PROXY_WORKER_SOURCE } from './draw-stream-proxy-worker.js';
import { resolveDrawStreamConfig } from './draw-stream-config.js';
import { BASE_OPAQUE_MODE } from './opaque-draw-variants.js';
import { cellOf, MemberPick, orthoSlot, pxPerMetre, type StreamFrameInputs, type StreamFrameStats } from './draw-stream-types.js';

function batch(id: number, x: number, opts: { quantized?: boolean; lod1?: number; ids?: number } = {}): BatchedMesh {
  return {
    id, colorKey: `k${id}`, vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 30, color: [1, 1, 1, 1],
    expressIds: Array.from({ length: opts.ids ?? 2 }, (_, i) => id * 100 + i),
    bounds: { min: [x, 0, 0], max: [x + 1, 1, 1] },
    ...(opts.quantized ? { quantized: { min: [0, 0, 0], step: 0.001 } } : {}),
    ...(opts.lod1 ? { lod1IndexBuffer: {} as GPUBuffer, lod1IndexCount: opts.lod1 } : {}),
  } as BatchedMesh;
}

const stats = (): StreamFrameStats => ({ nodes: 0, nodesDrawn: 0, draws: 0, tris: 0, bundlesRecorded: 0, entries: 0, syncs: 0, invalidations: 0,
  arenaBytes: 0, budgetDraws: 0, budgetCut: 0, proxiesDrawn: 0, proxyReady: 0, proxyNodes: 0, proxyBuildMs: 0, proxyBytes: 0 });

function frame(over: Partial<StreamFrameInputs> = {}): StreamFrameInputs {
  return {
    pass: {} as GPURenderPassEncoder, mode: { discardFree: true, objectId: false }, allowBundles: true,
    visible: () => true, projectedPx: () => 100, contribPx: 0, lodPx: 0, eye: { x: 0, y: 0, z: 0 },
    projection: { ortho: false, orthoHalfHeight: 1, fovYRadians: Math.PI / 2, viewportHeightPx: 1000 }, interacting: false, ...over,
  };
}

/** A frame whose `projectedPx` is faked: a tiny viewport keeps the node lower bound (`memberPicks`) out of the way. */
const fake = (over: Partial<StreamFrameInputs>): StreamFrameInputs => frame({ projection: { ortho: false, orthoHalfHeight: 1, fovYRadians: Math.PI / 2, viewportHeightPx: 1e-6 }, ...over });

describe('draw stream nodes', () => {
  it('groups members by chunk cell, totals triangles per LOD and keeps submission order', () => {
    const members = [batch(1, 0.2, { quantized: true }), batch(2, 0.5, { lod1: 9 }), batch(3, 40), batch(4, 0.7)];
    const nodes = buildStreamNodes(members, 32);
    assert.equal(nodes.length, 2);
    const near = nodes.find((n) => n.coords[0] === 0)!;
    assert.deepEqual(near.members, [0, 1, 3], 'submission order: the loop\'s tie-break between coincident surfaces');
    assert.equal(near.tris0, 30);
    assert.equal(near.tris1, 10 + 3 + 10, 'LOD1 counts fall back to LOD0 without a LOD1 range');
    assert.equal(near.entries, 6);
    assert.deepEqual([near.min[0], near.max[0]], [0.2, 1.7]);
  });

  it('leaves every node uncovered without an HLOD tree', () => {
    const nodes = buildStreamNodes([batch(1, 0), batch(2, 50)], 32);
    const links = linkHlodLeaves(null, nodes, [], [], [], 32);
    assert.equal(links.uncovered.length, 2);
    assert.equal(links.leavesByParent.size, 0);
  });

  it('maps an AABB centre to its grid cell', () => {
    assert.deepEqual(cellOf([-1, 0, 31], [0, 2, 33], 32), [-1, 0, 1]);
  });
});

describe('draw stream culling', () => {
  const members = [batch(1, 0, { lod1: 6 }), batch(2, 40, { lod1: 6 }), batch(3, 80, { lod1: 6 })];
  const nodes = buildStreamNodes(members, 32);
  const links = linkHlodLeaves(null, nodes, [], [], [], 32);

  it('drops invisible and sub-contribution nodes and picks LOD1 below the LOD threshold', () => {
    const items = collectStreamItems(fake({
      visible: (min) => min[0] < 60, projectedPx: (min) => (min[0] < 30 ? 50 : 5), contribPx: 2, lodPx: 10,
    }), nodes, null, links, 2, members);
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((it) => it.leaf?.coords[0]), [0, 1]);
    assert.deepEqual(items.map((it) => it.lod1), [false, true]);
  });

  it('culls and LOD-picks each member by its own size, as the per-batch loop does (#11370 qualification)', () => {
    // One chunk cell: a large member, a mid-size one with a LOD1 range, a mid-size one without, and a sub-pixel one.
    const cell = [batch(1, 0, { lod1: 6 }), batch(2, 2, { lod1: 6 }), batch(3, 4), batch(4, 6, { lod1: 6 })];
    const [node] = buildStreamNodes(cell, 32);
    const px = (min: number[]) => ({ 0: 400, 2: 20, 4: 20, 6: 0.2 })[min[0]!] ?? 0;
    const f = fake({ projectedPx: px, contribPx: 0.5, lodPx: 48 });
    assert.ok(f.projectedPx(node!.min, node!.max) >= 48, 'judged as a whole (the old per-node pick), the node is above the LOD threshold: every member at LOD0');
    const picks = memberPicks(f, node!, cell);
    assert.ok(picks instanceof Uint8Array);
    assert.deepEqual([...picks], [MemberPick.Lod0, MemberPick.Lod1, MemberPick.AnyLod, MemberPick.Cull]);
    assert.equal(memberPicks(fake({ projectedPx: () => 20, lodPx: 48 }), node!, cell), MemberPick.Lod1, 'a member with no LOD1 range does not split a LOD1 node');
    assert.equal(memberPicks(fake({ projectedPx: () => 0.1, contribPx: 0.5 }), node!, cell), MemberPick.Cull);
    const culledThenAny = memberPicks(fake({ projectedPx: (min) => (min[0] === 4 ? 20 : 0.1), contribPx: 0.5, lodPx: 48 }), node!, cell);
    assert.deepEqual([...(culledThenAny as Uint8Array)], [MemberPick.Cull, MemberPick.Cull, MemberPick.AnyLod, MemberPick.Cull], 'a drawn member without LOD1 never joins a culled node');
    const anyThenCulled = memberPicks(fake({ projectedPx: (min) => (min[0] === 4 ? 20 : 0.1), contribPx: 0.5, lodPx: 48 }), buildStreamNodes([cell[2]!, cell[0]!], 32)[0]!, [cell[2]!, cell[0]!]);
    assert.deepEqual([...(anyThenCulled as Uint8Array)], [MemberPick.AnyLod, MemberPick.Cull]);
    assert.equal(memberPicks(fake({ projectedPx: () => 0.1 }), node!, cell), MemberPick.Lod0, 'culling and LOD off: everything at LOD0');
    const [item] = collectStreamItems(f, [node!], null, linkHlodLeaves(null, [node!], [], [], [], 32), 2, cell);
    assert.ok(item?.picks, 'a mixed node carries its picks');
  });

  it('draws a mixed node per member and keeps only drawn members warm', () => {
    const draws: [number, number][] = []; const executed: unknown[] = [];
    const pass = { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer(b: { tag?: string }) { draws.push([b.tag === 'lod1' ? 1 : 0, -1]); },
      drawIndexed(count: number, _n: number, _f: number, _b: number, first: number) { draws[draws.length - 1]![1] = first; void count; }, executeBundles(b: unknown[]) { executed.push(...b); } };
    const device = {
      createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}), createBindGroup: () => ({}), createShaderModule: () => ({}),
      createBuffer: (d: GPUBufferDescriptor) => ({ size: d.size, destroy() {} }), queue: { writeBuffer() {} },
      createRenderBundleEncoder: () => ({ setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {}, drawIndexed() {}, finish: () => ({ bundle: true }) }), // prewarm records here
    } as unknown as GPUDevice;
    const pipeline = { getStreamBase: () => ({ environmentLayout: {}, descriptor: { fragment: { targets: [] } }, colorFormat: 'bgra8unorm', depthFormat: 'depth32float', sampleCount: 1 }),
      visibility: { create: () => ({}) }, getEnvironmentBindGroup: () => ({}) } as unknown as ConstructorParameters<typeof DrawStream>[1];
    const g = globalThis as Record<string, unknown>;
    g.GPUBufferUsage ??= { COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 }; g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
    const cell = [batch(1, 0, { lod1: 6 }), batch(2, 2, { lod1: 6 }), batch(3, 6, { lod1: 6 })];
    for (const b of cell) (b as { lod1IndexBuffer: unknown }).lod1IndexBuffer = { tag: 'lod1' };
    const stream = new DrawStream(device, pipeline, resolveDrawStreamConfig({ stream: true, bundles: false }));
    stream.sync(cell, 'g', 'k', 32, () => ({ alpha: 1, anchor: null, overrideBits: 0 }));
    stream.prepareFrame(new Float32Array(4), { getCameraWorld: () => [0, 0, 0], tryPackDrawableOrigin: () => true } as unknown as Parameters<DrawStream['prepareFrame']>[1]);
    const drawn: number[] = [];
    const px = (min: number[]) => ({ 0: 400, 2: 20, 6: 0.2 })[min[0]!] ?? 0;
    const s = stream.encode(fake({ pass: pass as unknown as GPURenderPassEncoder, projectedPx: px, contribPx: 0.5, lodPx: 48 }), (b) => drawn.push(b.id));
    assert.deepEqual(draws, [[0, 0], [1, 1]], 'member 0 at LOD0, member 1 at LOD1, member 2 culled');
    assert.deepEqual(drawn, [1, 2]);
    assert.deepEqual([s.draws, s.tris], [2, 10 + 2], 'stats count the drawn members at their LOD');
  });

  it('skips per-member projection when even the smallest member at the far corner is above both thresholds', () => {
    const cell = [batch(1, 0, { lod1: 6 }), batch(2, 2, { lod1: 6 })];
    const [node] = buildStreamNodes(cell, 32);
    let projected = 0;
    const near = frame({ projectedPx: () => { projected++; return 1; }, contribPx: 0.5, lodPx: 48, eye: { x: 0, y: 0, z: 5 } });
    assert.equal(memberPicks(near, node!, cell), MemberPick.Lod0, 'unit boxes a few metres away span hundreds of px at 1000 px / 90°');
    assert.equal(projected, 0);
    const far = frame({ projectedPx: () => { projected++; return 1; }, contribPx: 0.5, lodPx: 48, eye: { x: 0, y: 0, z: 5000 } });
    assert.equal(memberPicks(far, node!, cell), MemberPick.Lod1, 'far away: each member is projected');
    assert.equal(projected, 2);
  });

  it('caches a mixed node\'s bundle for its pick pattern and re-records when the pattern changes', () => {
    const executed: unknown[][] = []; let recorded = 0; const env = {}; // one environment group: the bundle-cache key holds
    const enc = () => ({ setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {}, drawIndexed() {}, finish: () => ({ n: ++recorded }) });
    const device = { createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}), createBindGroup: () => ({}), createShaderModule: () => ({}),
      createBuffer: (d: GPUBufferDescriptor) => ({ size: d.size, destroy() {} }), queue: { writeBuffer() {} }, createRenderBundleEncoder: enc } as unknown as GPUDevice;
    const pipeline = { getStreamBase: () => ({ environmentLayout: {}, descriptor: { fragment: { targets: [] } }, colorFormat: 'bgra8unorm', depthFormat: 'depth32float', sampleCount: 1 }),
      visibility: { create: () => ({}), createAsync: async () => ({}) }, getEnvironmentBindGroup: () => env } as unknown as ConstructorParameters<typeof DrawStream>[1];
    const cell = [batch(1, 0, { lod1: 6 }), batch(2, 2, { lod1: 6 })];
    const stream = new DrawStream(device, pipeline, resolveDrawStreamConfig({ stream: true }));
    stream.sync(cell, 'g', 'k', 32, () => ({ alpha: 1, anchor: null, overrideBits: 0 }));
    stream.prepareFrame(new Float32Array(4), { getCameraWorld: () => [0, 0, 0], tryPackDrawableOrigin: () => true } as unknown as Parameters<DrawStream['prepareFrame']>[1]);
    const pass = { executeBundles: (b: unknown[]) => { executed.push([...b]); } } as unknown as GPURenderPassEncoder;
    const at = (px: Record<number, number>) => fake({ pass, projectedPx: (min) => px[min[0]!] ?? 0, lodPx: 48 });
    stream.encode(at({ 0: 400, 2: 20 }), () => {}); const first = executed.at(-1)![0];
    stream.encode(at({ 0: 400, 2: 20 }), () => {});
    assert.equal(executed.at(-1)![0], first, 'same picks: the cached bundle replays');
    stream.encode(at({ 0: 20, 2: 400 }), () => {});
    assert.notEqual(executed.at(-1)![0], first, 'new picks: a new bundle');
  });

  it('converts world size to screen px for perspective and orthographic cameras', () => {
    assert.ok(Math.abs(pxPerMetre({ ortho: false, orthoHalfHeight: 0, fovYRadians: Math.PI / 2, viewportHeightPx: 1000 }, 10) - 50) < 1e-9);
    assert.equal(pxPerMetre({ ortho: true, orthoHalfHeight: 5, fovYRadians: 0, viewportHeightPx: 1000 }, 123), 100);
  });

  it('keeps the largest nodes under the draw budget while moving, and everything at rest', () => {
    const many = Array.from({ length: 40 }, (_, i) => buildStreamNodes([{ ...batch(i, i * 40), expressIds: [i] }], 32)[0]!)
      .map((leaf, i) => ({ leaf, lod1: false, d: i, px: i }));
    for (const it of many) it.leaf.members = Array.from({ length: 1000 }, (_, k) => k);
    const rest = [...many]; const s0 = stats();
    new StreamDrawBudget().apply(rest, 16, false, s0);
    assert.equal(rest.length, 40);
    const moving = [...many]; const s1 = stats();
    new StreamDrawBudget().apply(moving, 16, true, s1); // first frame: no interval to adapt to yet
    assert.equal(moving.length, 20, 'the 20000-draw starting budget keeps 20 nodes of 1000 draws');
    assert.equal(s1.budgetCut, 20);
    assert.ok(moving.every((it) => it.px >= 20), 'largest on screen first');
    const off = [...many];
    new StreamDrawBudget().apply(off, 0, true, stats());
    assert.equal(off.length, 40, 'budgetMs 0 disables the budget');
  });
});

describe('renderer draw stream glue', () => {
  const batches = [batch(1, 0), batch(2, 40)];
  const device = {} as GPUDevice;
  const pipeline = {} as Parameters<RendererDrawStream['begin']>[1];
  const inputs = { visibility: () => 'all', alpha: () => 1, colorOverrides: null, colorOverrideGen: 0, emphasize: false, xrayActive: false };

  it('hands every batch to the per-batch loop while the stream is off', () => {
    const glue = new RendererDrawStream();
    assert.equal(glue.begin(device, pipeline, batches, 0, 'e', 32, inputs, BASE_OPAQUE_MODE), batches);
    assert.equal(glue.engaged, false);
    assert.equal(glue.highlightIndex, false);
    assert.equal(glue.enabled, false);
    assert.throws(() => glue.encode(new Float32Array(4), {} as Parameters<RendererDrawStream['encode']>[1], frame(), () => {}));
  });

  it('waits for the batch set to settle before engaging', () => {
    const glue = new RendererDrawStream();
    glue.configure(resolveDrawStreamConfig({ stream: true, settleMs: 60_000 }));
    assert.equal(glue.begin(device, pipeline, batches, 0, 'e', 32, inputs, BASE_OPAQUE_MODE), batches);
    assert.equal(glue.engaged, false);
    assert.equal(glue.highlightIndex, true, 'the stream implies the highlight index');
    assert.equal(glue.enabled, true);
  });
});

describe('draw stream HLOD links', () => {
  const l1 = (keys: [number, number, number][]): HlodTree => {
    const level = new Map<string, HlodNode>();
    for (const c of keys) level.set(nodeKey(1, c), { level: 1, key: nodeKey(1, c), coords: c, min: [0, 0, 0], max: [0, 0, 0], error: 1, children: [], state: 'ready', draws: [], cpu: [], tris: 0, bundle: [], ortho: [] });
    return { levels: [undefined, level] } as unknown as HlodTree;
  };
  const leaf = (minX: number, maxX: number) => buildStreamNodes([{ ...batch(1, 0), bounds: { min: [minX, 0, 0], max: [maxX, 1, 1] } } as BatchedMesh], 32)[0]!;

  it('links a leaf spanning two level-1 cells under both and keeps both from drawing a proxy', () => {
    const n = leaf(60, 70); // level-1 cells are 64 m: x 0 and x 1
    const links = linkHlodLeaves(l1([[0, 0, 0], [1, 0, 0]]), [n], [], [batch(1, 0)], [{ alpha: 1, anchor: null, overrideBits: 0 }], 32);
    assert.deepEqual([...links.leavesByParent.keys()].sort(), [nodeKey(1, [0, 0, 0]), nodeKey(1, [1, 0, 0])]);
    assert.ok(links.dirty.has(nodeKey(1, [0, 0, 0])) && links.dirty.has(nodeKey(1, [1, 0, 0])));
    assert.equal(links.allDirty, false);
  });

  it('marks every cell a hidden (legacy) batch touches, not just its centre', () => {
    const hidden = { ...batch(2, 0), bounds: { min: [0, 0, 0], max: [130, 1, 1] } } as BatchedMesh;
    const links = linkHlodLeaves(l1([[0, 0, 0], [1, 0, 0], [2, 0, 0]]), [], [hidden], [], [], 32);
    for (const x of [0, 1, 2]) assert.ok(links.dirty.has(nodeKey(1, [x, 0, 0])), `cell ${x}`);
  });

  it('gives up proxies when a batch spans too many cells (chunking off)', () => {
    const site = { ...batch(3, 0), bounds: { min: [0, 0, 0], max: [5000, 1, 1] } } as BatchedMesh;
    assert.equal(linkHlodLeaves(l1([[0, 0, 0]]), [], [site], [], [], 32).allDirty, true);
  });
});

describe('draw stream proxy simplifier keys', () => {
  it('keeps colour slots past 1023 and far cells apart', () => {
    let reply: { pieces: { slot: number }[] } | null = null;
    const self = { postMessage: (m: { pieces: { slot: number }[] }) => { reply = m; }, onmessage: null as null | ((e: { data: unknown }) => void) };
    new Function('self', PROXY_WORKER_SOURCE)(self);
    const tri = (x: number) => [x, 0, 0, x + 4, 0, 0, x, 4, 0];
    const positions = new Float32Array([...tri(0), ...tri(0), ...tri(2048 * 3)]);
    self.onmessage!({ data: { job: 1, positions, ids: new Uint32Array(9), colors: new Uint16Array([0, 0, 0, 1024, 1024, 1024, 0, 0, 0]), indices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]), cell: 1 } });
    const out = reply as { pieces: { slot: number; ids: Uint32Array }[] } | null;
    assert.deepEqual(out!.pieces.map((p) => p.slot).sort((a, b) => a - b), [0, 1024]);
    assert.equal(out!.pieces.find((p) => p.slot === 0)!.ids.length, 6, 'the far triangle is its own, not merged into the near one');
  });
});

describe('draw stream gate', () => {
  const config = resolveDrawStreamConfig({ stream: true, settleMs: 0 });
  const inputs = { visibility: () => 'all', alpha: () => 1, colorOverrides: null, colorOverrideGen: 0, emphasize: false, xrayActive: false };
  const keyOf = (gate: DrawStreamGate, batches: BatchedMesh[]): string => {
    let key = '';
    const stream = { config, sync: (_b: unknown, _g: string, k: string) => { key = k; return true; } } as unknown as Parameters<DrawStreamGate['sync']>[0];
    assert.equal(gate.settled(batches, config, 0), true);
    gate.sync(stream, batches, 'e', 32, inputs);
    return key;
  };

  it('changes the sync key when one batch is evicted and another restored in the same interval', () => {
    const a = batch(1, 0), b = { ...batch(2, 40), gpuResident: false };
    const gate = new DrawStreamGate();
    const before = keyOf(gate, [a, b]);
    const restored = { ...b, id: 99, gpuResident: true }, evicted = { ...a, gpuResident: false };
    assert.notEqual(keyOf(gate, [evicted, restored]), before, 'same resident count, different resident batches');
  });

  it('keeps the geometry signature across a residency swap (no arena/HLOD rebuild)', () => {
    let geom = '';
    const gate = new DrawStreamGate();
    const stream = { config, sync: (_b: unknown, g: string) => { geom = g; return true; } } as unknown as Parameters<DrawStreamGate['sync']>[0];
    const a = batch(1, 0);
    gate.settled([a], config, 0); gate.sync(stream, [a], 'e', 32, inputs); const first = geom;
    const restored = { ...a, id: 7 };
    gate.settled([restored], config, 0); gate.sync(stream, [restored], 'e', 32, inputs);
    assert.equal(geom, first);
  });

  it('asks for a frame when the settle delay ends', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gate = new DrawStreamGate();
    let frames = 0;
    try {
      assert.equal(gate.settled([batch(1, 0)], resolveDrawStreamConfig({ stream: true, settleMs: 5 }), 0, () => { frames++; }), false);
      t.mock.timers.tick(10);
      assert.equal(frames, 1);
    } finally { gate.cancel(); }
  });
});

describe('draw stream HLOD tree', () => {
  it('keeps distinct authored colours in distinct proxy slots', () => {
    assert.notEqual(proxySlotKey([0.5001, 0, 0, 1], undefined), proxySlotKey([0.5004, 0, 0, 1], undefined));
    assert.notEqual(proxySlotKey([1, 0, 0, 1], { metallic: 1, roughness: 0.2 }), proxySlotKey([1, 0, 0, 1], undefined));
  });

  it('places a proxy in the frame its vertices were made relative to, even after the node bounds grow', () => {
    const host = globalThis as Record<string, unknown>;
    host.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 };
    const posted: { job: number; positions: Float32Array }[] = [];
    let worker: { onmessage: ((e: { data: unknown }) => void) | null } | null = null;
    const savedWorker = host.Worker;
    host.Worker = class { onmessage: ((e: { data: unknown }) => void) | null = null; onerror: unknown = null; constructor() { worker = this; } postMessage(m: { job: number; positions: Float32Array }) { posted.push(m); } terminate() {} };
    let records: Float32Array | null = null;
    const device = {
      createBuffer: (d: GPUBufferDescriptor) => ({ size: d.size, label: d.label, destroy() {}, getMappedRange: () => new ArrayBuffer(d.size), unmap() {} }),
      queue: { writeBuffer: (b: { label?: string }, _o: number, data: Float32Array) => { if (b.label === 'draw-stream-proxy-records') records = data; } },
    } as unknown as GPUDevice;
    try {
      const tree = new HlodTree(device, 32, 24, () => {});
      const piece = { expressId: 5, positions: new Float32Array([0, 0, 0, 4, 0, 0, 0, 4, 0]), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]),
        color: [1, 0, 0, 1], origin: [10, 0, 0] } as unknown as MeshData;
      tree.build((visit) => visit(piece));
      assert.equal(posted.length, 1);
      const node = [...tree.levels[1]!.values()][0]!;
      const atSubmit = [...node.origin!];
      assert.equal(posted[0]!.positions[0], 10 - atSubmit[0]!, 'vertices relative to the submit-time centre, with the piece origin applied');
      node.max[0] += 500; // the stream links a wide leaf and grows the node
      worker!.onmessage!({ data: { job: posted[0]!.job, pieces: [{ slot: 0, positions: new Float32Array(9), ids: new Uint32Array(3), vertices: new Float32Array(21) }] } });
      assert.deepEqual([records![12], records![13], records![14]], atSubmit.map((v) => Math.fround(v)));
      tree.destroy();
    } finally { host.Worker = savedWorker; }
  });
});

describe('draw stream reconfigure and cache keys', () => {
  it('re-arms the settle delay after a reset (configure)', () => {
    const gate = new DrawStreamGate();
    const batches = [batch(1, 0)];
    assert.equal(gate.settled(batches, resolveDrawStreamConfig({ stream: true, settleMs: 0 }), 0), true);
    gate.reset();
    assert.equal(gate.settled(batches, resolveDrawStreamConfig({ stream: true, settleMs: 60_000 }), 0), false, 'same batches, but a new settle delay');
    gate.cancel();
  });

  it('keys orthographic bundles by draw mode and LOD, like perspective ones', () => {
    const slots = new Set<number>();
    for (let mode = 0; mode < 4; mode++) for (const lod1 of [false, true]) { const s = orthoSlot(mode, lod1); assert.ok(!slots.has(s) && !slots.has(s + 1)); slots.add(s); slots.add(s + 1); }
    assert.equal(slots.size, 16);
  });
});
