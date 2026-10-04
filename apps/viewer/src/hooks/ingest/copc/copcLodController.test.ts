/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * COPC LOD residency (#6869) over a synthetic octree with lazily paged
 * hierarchy, the real `selectLod`, and a sink that asserts the budget at
 * every append. The reader is an in-memory COPC: pages are admitted into a
 * real `CopcHierarchy`, nodes return `ceil(count / stride)` points.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CopcHierarchy,
  LodPacer,
  copcChildKeys,
  selectLod,
  createCopcLodTree,
  voxelKeyId,
  type CopcHierarchyPage,
  type CopcInfo,
  type CopcLodNode,
  type CopcNodeEntry,
  type CopcPageRef,
  type DecodedPointChunk,
  type LodCamera,
  type VoxelKey,
} from '@ifc-lite/pointcloud';
import { CopcLodController, quantizeStride, type CopcLodReader, type CopcLodSink } from './copcLodController.js';

const INFO: CopcInfo = {
  center: [128, 128, 128], halfsize: 128, spacing: 8, rootHierOffset: 0, rootHierSize: 32, gpsTimeMin: 0, gpsTimeMax: 0,
};

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(1664525, s) + 1013904223) >>> 0) / 2 ** 32);
}

/** Full octree to `depth`; level-2 subtrees live on their own (lazy) pages. */
function syntheticCopc(depth: number, seed = 1) {
  const r = lcg(seed);
  const rootPage: CopcHierarchyPage = { nodes: [], pages: [] };
  const childPages = new Map<number, CopcHierarchyPage>();
  let nextOffset = 1_000;
  const subtree = (key: VoxelKey, page: CopcHierarchyPage) => {
    page.nodes.push({ key, offset: 10, byteSize: 10, pointCount: 2_000 + Math.floor(r() * 30_000) });
    if (key.d >= depth) return;
    for (const child of copcChildKeys(key)) {
      if (child.d === 2) {
        const offset = (nextOffset += 64);
        const own: CopcHierarchyPage = { nodes: [], pages: [] };
        childPages.set(offset, own);
        page.pages.push({ key: child, offset, byteSize: 64 });
        subtree(child, own);
      } else {
        subtree(child, page);
      }
    }
  };
  subtree({ d: 0, x: 0, y: 0, z: 0 }, rootPage);
  const hierarchy = new CopcHierarchy();
  hierarchy.addPage({ offset: 0, byteSize: 32 }, rootPage);
  return { hierarchy, childPages };
}

type Deferred = { run: () => void };

function fakeReader(hierarchy: CopcHierarchy, childPages: Map<number, CopcHierarchyPage>, opts: { hold?: Deferred[] } = {}) {
  const pagesRead: number[] = [];
  const reads: string[] = [];
  const reader: CopcLodReader = {
    async loadPage(ref: CopcPageRef) {
      if (!hierarchy.pendingPages.has(voxelKeyId(ref.key))) return;
      pagesRead.push(ref.offset);
      hierarchy.addPage(ref, childPages.get(ref.offset) as CopcHierarchyPage);
    },
    async readNode(entry: CopcNodeEntry, { stride, signal }) {
      reads.push(voxelKeyId(entry.key));
      if (opts.hold) await new Promise<void>((resolve) => opts.hold?.push({ run: resolve }));
      signal?.throwIfAborted();
      const n = Math.ceil(entry.pointCount / stride);
      return {
        positions: new Float32Array(n * 3), normalState: 'absent', pointCount: n,
        bbox: { min: [0, 0, 0], max: [0, 0, 0] },
      } satisfies DecodedPointChunk;
    },
  };
  return { reader, pagesRead, reads };
}

function budgetSink(budget: number) {
  const resident = new Map<string, number>();
  const log: Array<{ op: 'append' | 'remove'; id: string }> = [];
  let total = 0;
  let peak = 0;
  const sink: CopcLodSink = {
    append(node: CopcLodNode, chunk: DecodedPointChunk) {
      assert.ok(!resident.has(node.id), `${node.id} appended twice without removal`);
      resident.set(node.id, chunk.pointCount);
      total += chunk.pointCount;
      peak = Math.max(peak, total);
      assert.ok(total <= budget, `resident ${total} exceeds budget ${budget}`);
      log.push({ op: 'append', id: node.id });
    },
    remove(node: CopcLodNode) {
      total -= resident.get(node.id) ?? 0;
      resident.delete(node.id);
      log.push({ op: 'remove', id: node.id });
    },
  };
  return { sink, resident, log, total: () => total, peak: () => peak };
}

type V3 = [number, number, number];
/** WebGPU perspective look-at (z in [0, 1]), right-handed, Z up. */
function camera(eye: V3, target: V3, fovY = 1.0): LodCamera {
  const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (a: V3): V3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const f = norm(sub(target, eye)); const s = norm(cross(f, [0, 0, 1])); const u = cross(s, f);
  const view = [s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0, -dot(s, eye), -dot(u, eye), dot(f, eye), 1];
  const k = 1 / Math.tan(fovY / 2); const [n, fa] = [0.5, 5_000]; const aspect = 1.5;
  const proj = [k / aspect, 0, 0, 0, 0, k, 0, 0, 0, 0, -fa / (fa - n), -1, 0, 0, (-fa * n) / (fa - n), 0];
  const vp = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) for (let i = 0; i < 4; i++) vp[c * 4 + row] += proj[i * 4 + row] * view[c * 4 + i];
  return { viewProj: vp, position: eye, viewportHeight: 1_000, projScaleY: k };
}

function setup(budget: number, opts: { hold?: Deferred[]; seed?: number; depth?: number } = {}) {
  const { hierarchy, childPages } = syntheticCopc(opts.depth ?? 4, opts.seed);
  const tree = createCopcLodTree(hierarchy, INFO);
  const reader = fakeReader(hierarchy, childPages, { hold: opts.hold });
  const sink = budgetSink(budget);
  const passes: Array<{ viewEpoch: number; added: number; replaced: boolean; at: number }> = [];
  const controller = new CopcLodController(tree, reader.reader, sink.sink, {
    pointBudget: budget,
    pacer: new LodPacer({ initialPointsPerMs: 500, minFirstPassPoints: 20_000 }),
    now: () => 0,
    onPassComplete: (p) => passes.push({ ...p, at: sink.log.length }),
  });
  return { controller, reader, sink, passes, hierarchy, tree };
}

describe('CopcLodController (#6869)', () => {
  it('never holds more points than the budget across a camera walk, and settles on the selection', async () => {
    const r = lcg(6869);
    for (const budget of [60_000, 250_000, 1_000_000]) {
      const { controller, sink, tree } = setup(budget, { seed: budget });
      for (let step = 0; step < 25; step++) {
        const eye: V3 = [r() * 500 - 120, r() * 500 - 120, 20 + r() * 300];
        const cam = camera(eye, [r() * 256, r() * 256, r() * 60]);
        await controller.update(cam);
        assert.ok(sink.total() <= budget);
        // Settled: exactly the full-budget selection is resident, each at
        // its share's (power-of-two) stride or denser.
        const want = selectLod(tree.root as CopcLodNode, cam, { pointBudget: budget }).nodes;
        assert.deepEqual([...sink.resident.keys()].sort(), want.map((s) => s.node.id).sort());
        assert.equal(sink.total(), controller.points);
        assert.deepEqual([...sink.resident.keys()].sort(), controller.residentNodes().map((n) => n.id).sort());
      }
      assert.ok(sink.peak() > budget * 0.3, `budget ${budget} was exercised (peak ${sink.peak()})`);
    }
  });

  it('loads hierarchy pages only where the view needs them', async () => {
    const { controller, reader, hierarchy } = setup(400_000);
    const pending = hierarchy.pendingPages.size;
    // Close to one corner of the cube, looking into it.
    await controller.update(camera([10, 10, 30], [60, 60, 10], 0.8));
    assert.ok(reader.pagesRead.length > 0, 'a close view must page in detail');
    assert.ok(reader.pagesRead.length < pending, `read ${reader.pagesRead.length} of ${pending} pages`);
  });

  it('keeps the old view on screen until the new pass completes (no holes)', async () => {
    // Depth 3 holds ~10M points: the whole tree fits the budget, so any
    // removal before the pass completes would be a hole, not budget pressure.
    const { controller, sink, passes } = setup(20_000_000, { depth: 3 });
    // Far away: only the coarse top of the tree is resident.
    await controller.update(camera([-4_000, 128, 600], [128, 128, 60]));
    assert.ok(sink.resident.size < 20, `far view holds ${sink.resident.size} nodes`);
    const before = sink.log.length;
    const passesBefore = passes.length;
    await controller.update(camera([20, 20, 40], [80, 80, 20], 0.7));
    const firstPassOfNewView = passes[passesBefore];
    assert.ok(firstPassOfNewView.replaced);
    const opsDuringPass = sink.log.slice(before, firstPassOfNewView.at);
    // A remove immediately followed by an append of the same node is a
    // denser copy replacing a thinner one in one synchronous step: no frame
    // can render between them, so it is not a hole.
    const holes = opsDuringPass.filter((o, i) => o.op === 'remove'
      && !(opsDuringPass[i + 1]?.op === 'append' && opsDuringPass[i + 1]?.id === o.id));
    assert.deepEqual(holes, [], 'no node left the screen before the pass completed');
    assert.ok(opsDuringPass.some((o) => o.op === 'append'), 'the new view loaded nodes during the pass');
    assert.ok(sink.log.slice(firstPassOfNewView.at).some((o) => o.op === 'remove'), 'the old view is retired afterwards');
  });

  it('a superseded update never touches the sink again', async () => {
    const hold: Deferred[] = [];
    const { controller, sink } = setup(500_000, { hold });
    const first = controller.update(camera([-300, 128, 100], [128, 128, 60]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(hold.length > 0, 'reads are in flight');
    const stale = hold.splice(0);
    const opsBefore = sink.log.length;
    const second = controller.update(camera([400, 400, 300], [128, 128, 60]));
    stale.forEach((d) => d.run());
    await first;
    assert.equal(sink.log.length, opsBefore, 'aborted reads must not append');
    // Let the newer view finish.
    while (hold.length > 0 || !(await Promise.race([second.then(() => true), new Promise((r) => setTimeout(() => r(false), 0))]))) {
      hold.splice(0).forEach((d) => d.run());
    }
    assert.ok(sink.log.length > opsBefore);
  });

  it('dispose removes every resident node', async () => {
    const { controller, sink } = setup(300_000);
    await controller.update(camera([-200, 128, 150], [128, 128, 60]));
    assert.ok(sink.resident.size > 0);
    controller.dispose();
    assert.equal(sink.resident.size, 0);
    assert.equal(controller.points, 0);
  });
});

describe('quantizeStride', () => {
  it('rounds up to a power of two, so the decoded count never exceeds the share', () => {
    assert.deepEqual([1, 2, 3, 5, 8, 9, 0.5].map(quantizeStride), [1, 2, 4, 8, 8, 16, 1]);
  });
});
