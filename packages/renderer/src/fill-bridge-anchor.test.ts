/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { chooseBridgeAnchor } from './fill-bridge-anchor.js';
import { signedRingArea, triangulateRings, type Pt } from './fill-triangulate.js';

/**
 * A hole is spliced into its boundary along a bridge edge, and the merged ring
 * has to stay a SIMPLE polygon — ear clipping is undefined on anything else.
 * Ranking anchors by "to the right, then nearest" almost always lands on a
 * visible vertex, because a wall's own corner is nearer than anything behind
 * it. Almost: a long blocking edge whose endpoints are both far away leaves a
 * vertex behind it as the nearest candidate, and bridging to it cuts straight
 * through the wall.
 *
 * `SLOTTED` below is that shape, and it is a genuine simple polygon rather
 * than a synthetic input the triangulator could never see.
 */

const P = (pts: Array<[number, number]>): Pt[] => pts.map(([x, z]) => ({ x, z }));

/**
 * A rectangle with a thin horizontal slot open at its right edge, and a spike
 * protruding upward from the slot's FAR side. The spike's foot at (0.5, 0.55)
 * is the nearest boundary vertex to the right of a hole sitting at the origin
 * — and is separated from it by the slot's lower edge, which runs from
 * (50, 0.5) all the way to (-49, 0.5) with both endpoints far away.
 */
const SLOTTED = P([
  [-50, -10],
  [50, -10],
  [50, 0.5],
  [-49, 0.5],
  [-49, 0.55],
  [0.1, 0.55],
  [0.3, 3],
  [0.5, 0.55],
  [50, 0.55],
  [50, 10],
  [-50, 10],
]);
const ORIGIN_HOLE = P([
  [-0.2, -0.2],
  [0.2, -0.2],
  [0.2, 0.2],
  [-0.2, 0.2],
]);

function rightmostIndex(ring: readonly Pt[]): number {
  let best = 0;
  for (let i = 1; i < ring.length; i++) if (ring[i].x > ring[best].x) best = i;
  return best;
}

/** The ranking with no visibility filter — what this used to do. */
function nearestToTheRight(boundary: readonly Pt[], start: Pt): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < boundary.length; i++) {
    const p = boundary[i];
    if (p.x <= start.x) continue;
    const d = (p.x - start.x) ** 2 + (p.z - start.z) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

function triangulatedArea(rings: Pt[][]): number {
  const { points, triangles } = triangulateRings(rings);
  let sum = 0;
  for (const [i, j, k] of triangles) {
    const a = points[i];
    const b = points[j];
    const c = points[k];
    sum += Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) / 2;
  }
  return sum;
}

describe('chooseBridgeAnchor', () => {
  it('refuses an anchor whose bridge would cut through a boundary edge', () => {
    const start = rightmostIndex(ORIGIN_HOLE);
    const naive = nearestToTheRight(SLOTTED, ORIGIN_HOLE[start]);
    assert.deepStrictEqual(
      SLOTTED[naive],
      { x: 0.5, z: 0.55 },
      'the fixture must actually put a blocked vertex nearest — otherwise this test proves nothing',
    );
    const chosen = chooseBridgeAnchor(SLOTTED, ORIGIN_HOLE, start);
    assert.notStrictEqual(chosen, naive, 'the blocked anchor must be rejected');
    assert.deepStrictEqual(SLOTTED[chosen], { x: 50, z: 0.5 });
  });

  it('triangulates that shape to its exact analytic area', () => {
    const expected =
      Math.abs(signedRingArea(SLOTTED)) - Math.abs(signedRingArea(ORIGIN_HOLE));
    const area = triangulatedArea([SLOTTED, ORIGIN_HOLE]);
    assert.ok(Math.abs(area - expected) < 1e-6, `area was ${area}, expected ${expected}`);
  });

  it('still takes the nearest vertex to the right when nothing blocks it', () => {
    // The ordinary convex case must be unchanged, or every simple profile
    // re-tessellates for no reason.
    const square = P([
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ]);
    const hole = P([
      [1, 1],
      [3, 1],
      [3, 3],
      [1, 3],
    ]);
    const start = rightmostIndex(hole);
    assert.strictEqual(
      chooseBridgeAnchor(square, hole, start),
      nearestToTheRight(square, hole[start]),
    );
  });

  it('falls back to the nearest candidate rather than dropping the hole', () => {
    // No vertex lies to the right of the bridge start, and every bridge
    // touches something: the hole must still be spliced somewhere.
    const square = P([
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ]);
    const flush = P([
      [2, 1],
      [4, 1],
      [4, 3],
      [2, 3],
    ]);
    const start = rightmostIndex(flush);
    const chosen = chooseBridgeAnchor(square, flush, start);
    assert.ok(chosen >= 0 && chosen < square.length);
    assert.ok(Math.abs(triangulatedArea([square, flush]) - 12) < 1e-6);
  });

  it('returns -1 for an empty boundary instead of indexing off the end', () => {
    assert.strictEqual(chooseBridgeAnchor([], ORIGIN_HOLE, 0), -1);
  });
});
