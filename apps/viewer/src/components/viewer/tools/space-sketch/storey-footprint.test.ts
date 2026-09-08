/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { exteriorPerimeter, perimeterWalls } from './storey-footprint.js';
import type { WallRect } from '@/lib/wall-rects-from-meshes';

type Pt = [number, number];

/** A `size`×`size` square, CCW from the origin. */
const SQUARE: Pt[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

/** A rectangle described by its 4 corners, for `exteriorPerimeter`'s input. */
function rect(corners: Pt[]): WallRect {
  return { corners, centreline: [corners[0], corners[1]], thickness: 0.2 };
}

describe('exteriorPerimeter', () => {
  it('returns the convex hull of every corner across all rects', () => {
    const rects = [
      rect([
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]),
      rect([
        [9, 9],
        [10, 9],
        [10, 10],
        [9, 10],
      ]),
    ];
    const hull = exteriorPerimeter(rects);
    // The hull must reach every extreme corner across both rects.
    for (const p of [[0, 0], [10, 9], [10, 10], [0, 1]] as Pt[]) {
      assert.ok(hull.some(([x, y]) => x === p[0] && y === p[1]), `hull missing ${p}`);
    }
  });

  it('DROPS corners that fall inside the hull, and returns the loop in order', () => {
    // The test above asserts only that the result CONTAINS each extreme
    // corner, which the raw unhulled corner list also does -- deleting the
    // `convexHull` call and returning `rects.flatMap(r => r.corners)` left the
    // whole file at 9 passed, 0 failed. Containment cannot fail; exclusion
    // can, so that is what this pins.
    //
    // An inner rect wholly inside an outer one: all four of its corners are
    // interior and none may survive. Asserting the exact array also pins the
    // winding and the starting vertex, which `perimeterWalls` depends on --
    // it walks the result as a closed loop, so a correct SET in a wrong ORDER
    // would emit walls across the diagonal.
    const outer = rect([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);
    const inner = rect([
      [4, 4],
      [6, 4],
      [6, 6],
      [4, 6],
    ]);
    assert.deepStrictEqual(exteriorPerimeter([outer, inner]), [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);
  });

  it('returns fewer than 3 points when there are not enough distinct corners', () => {
    assert.deepStrictEqual(exteriorPerimeter([]), []);
  });
});

describe('perimeterWalls', () => {
  it('returns null when the hull is degenerate (fewer than 3 points)', () => {
    assert.strictEqual(perimeterWalls([]), null);
    assert.strictEqual(perimeterWalls([[0, 0]]), null);
    assert.strictEqual(perimeterWalls([[0, 0], [1, 1]]), null);
  });

  it('emits one thin wall per hull edge, defaulting to 0.2 thickness', () => {
    const walls = perimeterWalls(SQUARE);
    assert.ok(walls);
    assert.strictEqual(walls!.length, 4);
    for (const w of walls!) assert.strictEqual(w.thickness, 0.2);
  });

  it('centres each synthetic wall on its hull edge, wrapping the last edge back to the first vertex', () => {
    const walls = perimeterWalls(SQUARE)!;
    assert.deepStrictEqual(
      walls.map((w) => w.centreline),
      [
        [[0, 0], [10, 0]],
        [[10, 0], [10, 10]],
        [[10, 10], [0, 10]],
        [[0, 10], [0, 0]],
      ],
    );
  });

  it('offsets the 4 corners of each wall symmetrically across the centreline by half the thickness', () => {
    const thickness = 2;
    const walls = perimeterWalls(SQUARE, thickness)!;
    const bottom = walls[0]; // centreline (0,0) -> (10,0)
    // Perpendicular to a horizontal edge is vertical: corners should sit at
    // y = +1 and y = -1 (half of thickness 2), x unchanged from the endpoints.
    const ys = bottom.corners.map(([, y]) => y).sort((a, b) => a - b);
    assert.deepStrictEqual(ys, [-1, -1, 1, 1]);
    const xs = bottom.corners.map(([x]) => x).sort((a, b) => a - b);
    assert.deepStrictEqual(xs, [0, 0, 10, 10]);
  });

  it('respects a custom thickness parameter', () => {
    const walls = perimeterWalls(SQUARE, 1)!;
    for (const w of walls) assert.strictEqual(w.thickness, 1);
  });

  it('skips a degenerate (near-zero-length) edge and still returns the remaining walls when at least 3 survive', () => {
    // A repeated vertex creates a zero-length edge between it and its
    // duplicate. With 5 hull points but one degenerate edge, 4 real walls
    // should remain (a pentagon minus the one collapsed edge).
    const hull: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 0], // duplicate of the previous point -> zero-length edge, skipped
      [10, 10],
      [0, 10],
    ];
    const walls = perimeterWalls(hull)!;
    assert.strictEqual(walls.length, 4);
  });

  it('returns null when skipping degenerate edges leaves fewer than 3 walls', () => {
    // A "triangle" whose first two vertices coincide only has one genuine
    // edge once the degenerate one is dropped, and one > 0 length edge is
    // not a wall loop — perimeterWalls should refuse rather than emit a
    // 2-wall non-loop.
    const hull: Pt[] = [
      [0, 0],
      [0, 0],
      [10, 0],
    ];
    assert.strictEqual(perimeterWalls(hull), null);
  });
});
