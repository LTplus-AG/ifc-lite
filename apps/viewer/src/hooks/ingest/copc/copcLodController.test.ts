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

interface FakeReaderOptions {
  hold?: Deferred[];
  /** Hold page loads; like the real client, an abort rejects the waiter. */
  holdPages?: Deferred[];
  /** Return true to make this read of node `id` fail. */
  failNode?: (id: string, attempt: number) => boolean;
}

function fakeReader(hierarchy: CopcHierarchy, childPages: Map<number, CopcHierarchyPage>, opts: FakeReaderOptions = {}) {
  const pagesRead: number[] = [];
  const reads: string[] = [];
  const reader: CopcLodReader = {
    async loadPage(ref: CopcPageRef, signal?: AbortSignal) {
      if (opts.holdPages) {
        await new Promise<void>((resolve, reject) => {
          opts.holdPages?.push({ run: resolve });
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      if (!hierarchy.pendingPages.has(voxelKeyId(ref.key))) return;
      pagesRead.push(ref.offset);
      hierarchy.addPage(ref, childPages.get(ref.offset) as CopcHierarchyPage);
    },
    async readNode(entry: CopcNodeEntry, { stride, signal }) {
      const id = voxelKeyId(entry.key);
      reads.push(id);
      if (opts.failNode?.(id, reads.filter((r) => r === id).length)) throw new Error(`read of ${id} failed`);
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

function setup(budget: number, opts: FakeReaderOptions & { seed?: number; depth?: number } = {}) {
  const { hierarchy, childPages } = syntheticCopc(opts.depth ?? 4, opts.seed);
  const tree = createCopcLodTree(hierarchy, INFO);
  const reader = fakeReader(hierarchy, childPages, opts);
  const scheduled: Array<() => void> = [];
  const sink = budgetSink(budget);
  const passes: Array<{ viewEpoch: number; added: number; replaced: boolean; at: number }> = [];
  const controller = new CopcLodController(tree, reader.reader, sink.sink, {
    pointBudget: budget,
    pacer: new LodPacer({ initialPointsPerMs: 500, minFirstPassPoints: 20_000 }),
    now: () => 0,
    onPassComplete: (p) => passes.push({ ...p, at: sink.log.length }),
    schedule: (run) => { scheduled.push(run); },
  });
  return { controller, reader, sink, passes, hierarchy, tree, scheduled };
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

describe('CopcLodController review fixes (#6880)', () => {
  it('a camera move during a hierarchy page load neither rejects nor wipes the cloud', async () => {
    const holdPages: Deferred[] = [];
    const { controller, sink } = setup(400_000, { holdPages });
    // Settle a far view first: nodes resident, no pages needed.
    holdPages.length = 0;
    const far = controller.update(camera([-4_000, 128, 600], [128, 128, 60]));
    while (holdPages.length > 0) holdPages.splice(0).forEach((d) => d.run());
    await far;
    const resident = sink.resident.size;
    assert.ok(resident > 0);
    // A close view needs pages; move again while those loads are in flight.
    const close = controller.update(camera([10, 10, 30], [60, 60, 10], 0.8));
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(holdPages.length > 0, 'page loads are in flight');
    const next = controller.update(camera([-4_000, 128, 600], [128, 128, 60]));
    await assert.doesNotReject(close, 'a superseded update resolves, it does not throw');
    while (holdPages.length > 0) holdPages.splice(0).forEach((d) => d.run());
    await next;
    assert.ok(sink.resident.size >= resident, 'the cloud is still on screen');
  });

  it('a fat keep-set node evicted to make room is reloaded at its share (root + 8 children)', async () => {
    const rootPage: CopcHierarchyPage = { nodes: [{ key: { d: 0, x: 0, y: 0, z: 0 }, offset: 10, byteSize: 10, pointCount: 1_000 }], pages: [] };
    for (const key of copcChildKeys({ d: 0, x: 0, y: 0, z: 0 })) rootPage.nodes.push({ key, offset: 10, byteSize: 10, pointCount: 1_000 });
    const hierarchy = new CopcHierarchy();
    hierarchy.addPage({ offset: 0, byteSize: 32 }, rootPage);
    const tree = createCopcLodTree(hierarchy, INFO);
    const { reader } = fakeReader(hierarchy, new Map());
    const sink = budgetSink(1_200);
    const controller = new CopcLodController(tree, reader, sink.sink, {
      pointBudget: 1_200,
      // First pass of 1,000 points: the root alone, at stride 1.
      pacer: new LodPacer({ initialPointsPerMs: 5, firstPassMs: 200, minFirstPassPoints: 1 }),
      now: () => 0,
      schedule: () => {},
    });
    await controller.update(camera([-300, 128, 128], [128, 128, 128], 1.0));
    const ids = [...sink.resident.keys()].sort();
    assert.ok(ids.includes('0-0-0-0'), `root must be resident, have ${ids.join(',')}`);
    assert.equal(ids.length, 9);
    assert.ok(sink.total() <= 1_200);
  });

  it('a superseded pass finishing late does not disarm the new pass\'s requeue (#6880 merge review)', async () => {
    // Same root + 8 children shape as above, but every read is held, so the
    // superseded pass's lanes are still awaiting their reads when the new
    // pass starts loading. When they unwind, the new pass must still requeue
    // a fat keep-set node it evicts.
    const rootPage: CopcHierarchyPage = { nodes: [{ key: { d: 0, x: 0, y: 0, z: 0 }, offset: 10, byteSize: 10, pointCount: 1_000 }], pages: [] };
    for (const key of copcChildKeys({ d: 0, x: 0, y: 0, z: 0 })) rootPage.nodes.push({ key, offset: 10, byteSize: 10, pointCount: 1_000 });
    const hierarchy = new CopcHierarchy();
    hierarchy.addPage({ offset: 0, byteSize: 32 }, rootPage);
    const tree = createCopcLodTree(hierarchy, INFO);
    const hold: Deferred[] = [];
    const { reader } = fakeReader(hierarchy, new Map(), { hold });
    const sink = budgetSink(1_200);
    const controller = new CopcLodController(tree, reader, sink.sink, {
      pointBudget: 1_200,
      pacer: new LodPacer({ initialPointsPerMs: 5, firstPassMs: 200, minFirstPassPoints: 1 }),
      now: () => 0,
      schedule: () => {},
    });
    const cam = camera([-300, 128, 128], [128, 128, 128], 1.0);
    const first = controller.update(cam);
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(hold.length > 0, 'the first pass has reads in flight');
    const stale = hold.splice(0);
    const second = controller.update(cam);
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(hold.length > 0, 'the second pass is loading before the first unwinds');
    // Finish the new view's first (root-only) pass; its full pass then holds
    // child reads, and the fat root must be evicted to fit them.
    hold.splice(0).forEach((d) => d.run());
    for (let i = 0; i < 20 && hold.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
    assert.ok(hold.length > 0, 'the full pass is loading children');
    // Only now does the superseded pass unwind.
    stale.forEach((d) => d.run());
    await first;
    while (hold.length > 0 || !(await Promise.race([second.then(() => true), new Promise((r) => setTimeout(() => r(false), 0))]))) {
      hold.splice(0).forEach((d) => d.run());
    }
    const ids = [...sink.resident.keys()].sort();
    assert.ok(ids.includes('0-0-0-0'), `root must be resident, have ${ids.join(',')}`);
    assert.equal(ids.length, 9);
  });

  it('a pass with a failed node does not retire the old view and retries, bounded', async () => {
    // Fails on both passes of the first update (one read per pass), then works.
    const { controller, sink, scheduled, passes } = setup(400_000, {
      failNode: (id, attempt) => id === '1-0-0-0' && attempt <= 2,
    });
    await controller.update(camera([-300, 128, 100], [128, 128, 60]));
    assert.ok(!sink.resident.has('1-0-0-0'), 'the failed node is missing after the first try');
    assert.equal(scheduled.length, 1, 'an incomplete pass schedules one retry');
    await scheduled.shift()?.();
    assert.ok(sink.resident.has('1-0-0-0'), 'the retry loaded it');
    assert.ok(passes.length >= 3);
    assert.equal(scheduled.length, 0, 'a complete pass schedules nothing');
  });

  it('an incomplete pass for a new view keeps the old view on screen', async () => {
    const { controller, sink, tree } = setup(20_000_000, { depth: 3, failNode: (id) => id.startsWith('3-') });
    await controller.update(camera([-4_000, 128, 600], [128, 128, 60]));
    const oldView = new Set(sink.resident.keys());
    const near = camera([20, 20, 40], [80, 80, 20], 0.7);
    await controller.update(near);
    const want = new Set(selectLod(tree.root as CopcLodNode, near, { pointBudget: 20_000_000 }).nodes.map((n) => n.node.id));
    assert.ok([...want].some((id) => id.startsWith('3-')), 'the near view wants failing nodes');
    for (const id of oldView) assert.ok(sink.resident.has(id), `${id} stayed while the new view is incomplete`);
  });

  it('a node that never loads stops retrying after a bounded number of attempts', async () => {
    const { controller, scheduled } = setup(400_000, { failNode: (id) => id === '1-0-0-0' });
    await controller.update(camera([-300, 128, 100], [128, 128, 60]));
    let retries = 0;
    while (scheduled.length > 0 && retries < 20) {
      retries++;
      await scheduled.shift()?.();
    }
    assert.ok(retries > 0 && retries <= 3, `retried ${retries} times`);
  });
});

describe('CopcLodController settled passes (#6880 x #6877 deviation refresh)', () => {
  /** Every `onPassSettled`, with what the sink held when it fired. */
  function settledSetup() {
    const { hierarchy, childPages } = syntheticCopc(3);
    const sink = budgetSink(20_000_000);
    const settled: Array<{ resident: string[]; ops: number }> = [];
    const controller = new CopcLodController(createCopcLodTree(hierarchy, INFO), fakeReader(hierarchy, childPages).reader, sink.sink, {
      pointBudget: 20_000_000,
      pacer: new LodPacer({ initialPointsPerMs: 500, minFirstPassPoints: 20_000 }),
      now: () => 0,
      schedule: () => {},
      onPassSettled: () => settled.push({ resident: [...sink.resident.keys()].sort(), ops: sink.log.length }),
    });
    return { controller, sink, settled };
  }

  it('a view that only evicts (the scan leaves the frustum) still settles, after its evictions', async () => {
    const { controller, sink, settled } = settledSetup();
    await controller.update(camera([-300, 128, 100], [128, 128, 60]));
    assert.ok(sink.resident.size > 0);
    const before = settled.length;
    // Looking straight away from the cube: the selection is empty, nothing is added.
    await controller.update(camera([-300, 128, 100], [-600, 128, 100]));
    assert.equal(sink.resident.size, 0, 'every node left the view');
    assert.ok(settled.length > before, 'an eviction-only pass is announced');
    // Every announcement of the new view comes after that pass's evictions:
    // a deviation re-run started earlier would measure the departing nodes.
    assert.deepEqual(settled.slice(before).map((s) => s.resident), settled.slice(before).map(() => []));
  });

  it('a view that adds nodes settles after it retired the old view', async () => {
    const { controller, sink, settled } = settledSetup();
    await controller.update(camera([-4_000, 128, 600], [128, 128, 60]));
    await controller.update(camera([20, 20, 40], [80, 80, 20], 0.7));
    assert.deepEqual(settled.at(-1), { resident: [...sink.resident.keys()].sort(), ops: sink.log.length });
  });
});

describe('quantizeStride', () => {
  it('rounds up to a power of two, so the decoded count never exceeds the share', () => {
    assert.deepEqual([1, 2, 3, 5, 8, 9, 0.5].map(quantizeStride), [1, 2, 4, 8, 8, 16, 1]);
  });
});
