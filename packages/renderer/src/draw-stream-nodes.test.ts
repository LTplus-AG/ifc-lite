/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BatchedMesh } from './types.js';
import { buildStreamNodes, linkHlodLeaves } from './draw-stream-nodes.js';
import { collectStreamItems, StreamDrawBudget } from './draw-stream-cull.js';
import { RendererDrawStream } from './draw-stream-frame.js';
import { nodeKey, type HlodNode, type HlodTree } from './draw-stream-hlod.js';
import { PROXY_WORKER_SOURCE } from './draw-stream-proxy-worker.js';
import { resolveDrawStreamConfig } from './draw-stream-config.js';
import { cellOf, pxPerMetre, type StreamFrameInputs, type StreamFrameStats } from './draw-stream-types.js';

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

describe('draw stream nodes', () => {
  it('groups members by chunk cell, totals triangles per LOD and puts f32 members first', () => {
    const members = [batch(1, 0.2, { quantized: true }), batch(2, 0.5, { lod1: 9 }), batch(3, 40), batch(4, 0.7)];
    const nodes = buildStreamNodes(members, 32);
    assert.equal(nodes.length, 2);
    const near = nodes.find((n) => n.coords[0] === 0)!;
    assert.deepEqual(near.members, [1, 3, 0], 'f32 members before the quantized one');
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
  const nodes = buildStreamNodes([batch(1, 0), batch(2, 40), batch(3, 80)], 32);
  const links = linkHlodLeaves(null, nodes, [], [], [], 32);

  it('drops invisible and sub-contribution nodes and picks LOD1 below the LOD threshold', () => {
    const items = collectStreamItems(frame({
      visible: (min) => min[0] < 60, projectedPx: (min) => (min[0] < 30 ? 50 : 5), contribPx: 2, lodPx: 10,
    }), nodes, null, links, 2);
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((it) => it.leaf?.coords[0]), [0, 1]);
    assert.deepEqual(items.map((it) => it.lod1), [false, true]);
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
    assert.equal(glue.begin(device, pipeline, batches, 0, 'e', 32, inputs), batches);
    assert.equal(glue.engaged, false);
    assert.equal(glue.highlightIndex, false);
    assert.equal(glue.enabled, false);
    assert.throws(() => glue.encode(new Float32Array(4), {} as Parameters<RendererDrawStream['encode']>[1], frame(), () => {}));
  });

  it('waits for the batch set to settle before engaging', () => {
    const glue = new RendererDrawStream();
    glue.configure(resolveDrawStreamConfig({ stream: true, settleMs: 60_000 }));
    assert.equal(glue.begin(device, pipeline, batches, 0, 'e', 32, inputs), batches);
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
