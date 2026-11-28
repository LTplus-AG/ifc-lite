/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FullDetailBatches, scanBatchesHolding, type BatchesHolding } from './full-detail-batches.js';
import { buildStreamNodes, linkHlodLeaves } from './draw-stream-nodes.js';
import { collectStreamItems } from './draw-stream-cull.js';
import { nodeKey, type HlodNode, type HlodTree } from './draw-stream-hlod.js';
import type { StreamFrameInputs } from './draw-stream-types.js';
import type { BatchedMesh } from './types.js';

function batch(id: number, ids: number[], x = 0): BatchedMesh {
  return { id, colorKey: `k${id}`, expressIds: ids, bounds: { min: [x, 0, 0], max: [x + 1, 1, 1] } } as unknown as BatchedMesh;
}

/** `scanBatchesHolding`, counting the ids it is asked for. */
function countingLookup(): { lookup: BatchesHolding; asked: number[][] } {
  const asked: number[][] = [];
  return { asked, lookup: (list, ids) => { asked.push([...ids]); return scanBatchesHolding(list, ids); } };
}

describe('FullDetailBatches', () => {
  it('holds the batches of the selection and the hover, and counts a batch held by both once', () => {
    const list = [batch(1, [10, 11]), batch(2, [20]), batch(3, [30]), { ...batch(4, [40]), laneIds: [12] } as BatchedMesh];
    const fd = new FullDetailBatches().resolve(list, 0, new Set([11, 12]), 10);
    assert.deepEqual(list.map((b) => fd.has(b)), [true, false, false, true], 'entries and lane ids');
    assert.equal(fd.size, 2);
  });

  it('never looks the selection up again when only the hover moves, and keeps its part', () => {
    const list = Array.from({ length: 50 }, (_, i) => batch(i, [i * 10, i * 10 + 1], i * 2));
    const selected = new Set(Array.from({ length: 40 }, (_, i) => i * 10));
    const { lookup, asked } = countingLookup();
    const fd = new FullDetailBatches();
    const selection = fd.resolve(list, 0, selected, null, lookup).parts[0];
    for (const hovered of [451, 461, null, 471]) {
      fd.resolve(list, 0, selected, hovered, lookup);
      assert.equal(fd.parts[0], selection, 'the selection part is the same object');
    }
    assert.deepEqual(asked.filter((ids) => ids.length > 1).length, 1, 'the 40-id selection was looked up once');
    assert.deepEqual(asked.filter((ids) => ids.length === 1).map(([id]) => id), [451, 461, 471], 'one lookup per hovered id');
    assert.equal(fd.has(list[47]!), true);
    assert.equal(fd.has(list[46]!), false, 'the previous hover is let go');
  });

  it('looks again when a held batch is swapped at the same index', () => {
    const list = [batch(1, [10]), batch(2, [20])];
    const fd = new FullDetailBatches();
    fd.resolve(list, 0, new Set([10]), null);
    const restored = batch(3, [10]);
    list[0] = restored; // a residency restore: same list, length and revision
    fd.resolve(list, 0, new Set([10]), null);
    assert.equal(fd.has(restored), true, 'the restored batch is held');
    assert.deepEqual([...fd.parts[0]!], [restored], 'and the replaced one is not');
  });

  it('looks again when the list grows in place, and when the pick geometry moves', () => {
    const list = [batch(1, [10]), batch(2, [99])];
    const fd = new FullDetailBatches();
    fd.resolve(list, 0, new Set([10]), null);
    const fragment = batch(3, [10]);
    list.push(fragment); // a streaming fragment appended to the scene's own array
    assert.equal(fd.resolve(list, 0, new Set([10]), null).has(fragment), true, 'the appended fragment holding the entity');
    const rebuilt = batch(4, [10, 99]);
    list[1] = rebuilt; // an unheld index rebuilt to hold the entity: same list and length, the scene bumps the revision
    assert.equal(fd.resolve(list, 1, new Set([10]), null).has(rebuilt), true, 'the rebuilt batch, after the revision bump');
  });
});

describe('draw stream HLOD pins under a large selection', () => {
  it('marks the selection\'s batches once while the hover moves', () => {
    const far = [batch(1, [10], 1030), batch(2, [20], 1100), batch(3, [30], 1040)];
    const level1 = new Map<string, HlodNode>(), level2 = new Map<string, HlodNode>();
    const node = (level: number, c: [number, number, number], min: [number, number, number], max: [number, number, number]): HlodNode =>
      ({ level, key: nodeKey(level, c), coords: c, min, max, error: 1, children: [], state: 'ready', draws: [], cpu: [], tris: 0, bundle: [], ortho: [] });
    const a = node(1, [16, 0, 0], [1024, 0, 0], [1088, 64, 64]), b = node(1, [17, 0, 0], [1088, 0, 0], [1152, 64, 64]);
    const root = node(2, [8, 0, 0], [1024, 0, 0], [1152, 64, 64]);
    root.children = [a, b];
    level1.set(a.key, a); level1.set(b.key, b); level2.set(root.key, root);
    const h = { levels: [undefined, level1, level2], roots: [root], outsideNodes: new Set<string>(), leafCell: 32 } as unknown as HlodTree;
    const nodes = buildStreamNodes(far, 32);
    const links = linkHlodLeaves(h, nodes, [], far, far.map(() => ({ alpha: 1, anchor: null, overrideBits: 0 })), 32);

    let visits = 0;
    const selection = { *[Symbol.iterator]() { visits++; yield far[0]!; } };
    const frame = (hover: BatchedMesh[]): StreamFrameInputs => ({
      pass: {} as GPURenderPassEncoder, mode: { discardFree: true, objectId: false }, allowBundles: true, visible: () => true, projectedPx: () => 100,
      contribPx: 0, lodPx: 0, eye: { x: 0, y: 0, z: 0 }, interacting: false,
      projection: { ortho: false, orthoHalfHeight: 1, fovYRadians: Math.PI / 2, viewportHeightPx: 100 },
      fullDetail: { has: (x) => x === far[0] || hover.includes(x), parts: [selection, new Set(hover)] },
    });
    for (const hover of [[], [far[1]!], [far[2]!], []]) {
      const items = collectStreamItems(frame(hover), nodes, h, links, 2, far);
      assert.equal(items.some((it) => it.proxy === a || it.proxy === root), false, 'the selected batch\'s region refines');
      assert.equal(items.some((it) => it.proxy === b), !hover.includes(far[1]!), 'the hovered region refines while hovered');
    }
    assert.equal(visits, 1, 'the selection part was marked once');
  });
});
