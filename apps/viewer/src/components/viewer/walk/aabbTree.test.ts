/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tree is conservative by contract: every item whose box overlaps the
 * query must come back (extras are fine, the caller tests exactly). These
 * cases check that against brute force on random and degenerate inputs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAabbTree, IndexList, queryAabbTree, rayQueryAabbTree } from './aabbTree.js';

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomBoxes(count: number, seed: number, extent = 100, size = 3): Float32Array {
  const r = rng(seed);
  const boxes = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    const x = r() * extent, y = r() * extent, z = r() * extent;
    boxes.set([x, y, z, x + r() * size, y + r() * size, z + r() * size], i * 6);
  }
  return boxes;
}

const overlaps = (b: Float32Array, i: number, q: number[]): boolean =>
  b[i * 6] <= q[3] && b[i * 6 + 3] >= q[0] && b[i * 6 + 1] <= q[4] && b[i * 6 + 4] >= q[1]
  && b[i * 6 + 2] <= q[5] && b[i * 6 + 5] >= q[2];

describe('buildAabbTree / queryAabbTree', () => {
  it('returns every overlapping item, matching brute force', () => {
    const count = 5000;
    const boxes = randomBoxes(count, 7);
    const tree = buildAabbTree(boxes, count);
    const r = rng(99);
    const out = new IndexList(4);
    for (let q = 0; q < 300; q++) {
      const x = r() * 100, y = r() * 100, z = r() * 100, s = r() * 10;
      const query = [x, y, z, x + s, y + s, z + s];
      out.clear();
      queryAabbTree(tree, query[0], query[1], query[2], query[3], query[4], query[5], out);
      const got = new Set(Array.from(out.items.subarray(0, out.length)));
      for (let i = 0; i < count; i++) {
        if (overlaps(boxes, i, query)) assert.ok(got.has(i), `query ${q} missed item ${i}`);
      }
    }
  });

  it('indexes every item exactly once', () => {
    const count = 1234;
    const tree = buildAabbTree(randomBoxes(count, 3), count);
    const sorted = Array.from(tree.order).sort((a, b) => a - b);
    assert.deepEqual(sorted, Array.from({ length: count }, (_, i) => i));
  });

  it('terminates and stays correct when every box is identical', () => {
    const count = 1000;
    const boxes = new Float32Array(count * 6);
    for (let i = 0; i < count; i++) boxes.set([1, 1, 1, 2, 2, 2], i * 6);
    const tree = buildAabbTree(boxes, count);
    const out = new IndexList();
    queryAabbTree(tree, 1.5, 1.5, 1.5, 1.6, 1.6, 1.6, out);
    assert.equal(out.length, count);
    out.clear();
    queryAabbTree(tree, 3, 3, 3, 4, 4, 4, out);
    assert.equal(out.length, 0);
  });

  it('handles an empty input', () => {
    const tree = buildAabbTree(new Float32Array(0), 0);
    const out = new IndexList();
    queryAabbTree(tree, -1e9, -1e9, -1e9, 1e9, 1e9, 1e9, out);
    rayQueryAabbTree(tree, 0, 0, 0, 1, 0, 0, 10, out);
    assert.equal(out.length, 0);
  });

  it('ray query returns every box the segment passes through, axis-parallel rays included', () => {
    const count = 3000;
    const boxes = randomBoxes(count, 11);
    const tree = buildAabbTree(boxes, count);
    const out = new IndexList();
    // Straight down through the cloud, the spawn probe's ray.
    out.clear();
    rayQueryAabbTree(tree, 50, 200, 50, 0, -1, 0, 400, out);
    const got = new Set(Array.from(out.items.subarray(0, out.length)));
    for (let i = 0; i < count; i++) {
      const hit = boxes[i * 6] <= 50 && boxes[i * 6 + 3] >= 50 && boxes[i * 6 + 2] <= 50 && boxes[i * 6 + 5] >= 50;
      if (hit) assert.ok(got.has(i), `down ray missed item ${i}`);
    }
  });
});
