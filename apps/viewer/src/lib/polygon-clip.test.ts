/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { clipPolygonByLine, pointInPolygon, type Point2D } from './polygon-clip.js';

function approxEqual(a: number, b: number, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}

/** Absolute shoelace area — orientation-independent, like the clipper. */
function polygonArea(p: Point2D[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    s += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return Math.abs(s) / 2;
}

function polygonsApproxEqual(a: Point2D[], b: Point2D[]): boolean {
  if (a.length !== b.length) return false;
  // Polygons may start at different vertices but should be the
  // same loop in some rotation. Brute-force compare all rotations.
  for (let offset = 0; offset < a.length; offset++) {
    let ok = true;
    for (let i = 0; i < a.length; i++) {
      const ap = a[i];
      const bp = b[(i + offset) % a.length];
      if (!approxEqual(ap[0], bp[0]) || !approxEqual(ap[1], bp[1])) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

describe('polygon-clip', () => {
  describe('clipPolygonByLine', () => {
    it('halves a unit square with a vertical cut', () => {
      const square: Point2D[] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      const r = clipPolygonByLine(square, [0.5, -1], [0.5, 2]);
      assert.ok(r.ok);
      // Left half (positive cross product side, with line going +Y):
      // expect x ≤ 0.5 quadrant.
      const leftXs = r.left.map((p) => p[0]).sort();
      const rightXs = r.right.map((p) => p[0]).sort();
      assert.ok(leftXs.every((x) => x <= 0.5 + 1e-9));
      assert.ok(rightXs.every((x) => x >= 0.5 - 1e-9));
      assert.strictEqual(r.left.length, 4);
      assert.strictEqual(r.right.length, 4);
    });

    it('halves a unit square with a horizontal cut', () => {
      const square: Point2D[] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      const r = clipPolygonByLine(square, [-1, 0.3], [2, 0.3]);
      assert.ok(r.ok);
      assert.strictEqual(r.left.length + r.right.length, 8);
      // One half spans y in [0, 0.3], the other [0.3, 1].
      const ys = [...r.left, ...r.right].map((p) => p[1]).sort();
      assert.ok(approxEqual(ys[0], 0));
      assert.ok(approxEqual(ys[ys.length - 1], 1));
    });

    it('halves a triangle through a vertex without producing slivers', () => {
      // Triangle (0,0), (2,0), (1,2). Cut line passes through (1,2)
      // and (1,-1) — vertical cut through the apex.
      const tri: Point2D[] = [
        [0, 0],
        [2, 0],
        [1, 2],
      ];
      const r = clipPolygonByLine(tri, [1, 2], [1, -1]);
      assert.ok(r.ok);
      // Each half is a triangle.
      assert.strictEqual(r.left.length, 3);
      assert.strictEqual(r.right.length, 3);
    });

    // The fixture above puts the apex at signed distance EXACTLY 0, and every
    // other fixture in this file uses exact integers or 0.5 — so the smallest
    // non-zero |d| the suite ever sees is large, and EPS was pinned only from
    // below (it must be > 0). Anything up to ~0.4 passed, including values that
    // silently swallow real vertices. These two cases bracket it from both
    // sides. The cut line here is [1,2] → [1,-1], so signedDistance of a vertex
    // is 3·(x − 1): the apex offsets below are 3e-12 and 0.15 in EPS units.
    it('treats an apex a hair off the cut line as ON the line (EPS lower bound)', () => {
      const tri: Point2D[] = [
        [0, 0],
        [2, 0],
        [1 + 1e-12, 2],
      ];
      const r = clipPolygonByLine(tri, [1, 2], [1, -1]);
      assert.ok(r.ok);
      // Within EPS the apex belongs to BOTH halves, so each stays a clean
      // triangle of area 1. With EPS too small (0, or any value under 3e-12)
      // the apex is a hair to the right, and the left half picks up a fourth
      // vertex — a zero-width sliver that a mesher will choke on.
      assert.strictEqual(r.left.length, 3, `left: ${JSON.stringify(r.left)}`);
      assert.strictEqual(r.right.length, 3, `right: ${JSON.stringify(r.right)}`);
      assert.ok(approxEqual(polygonArea(r.left), 1, 1e-9));
      assert.ok(approxEqual(polygonArea(r.right), 1, 1e-9));
    });

    it('keeps an apex genuinely off the cut line off it (EPS upper bound)', () => {
      const tri: Point2D[] = [
        [0, 0],
        [2, 0],
        [1.05, 2],
      ];
      const r = clipPolygonByLine(tri, [1, 2], [1, -1]);
      assert.ok(r.ok);
      // The apex is 0.05 to the right of the cut: the right-of-cut half is a
      // QUADRILATERAL and must still contain the apex verbatim. An oversized
      // EPS (anything from ~0.05 up) snaps the apex onto the line, drops it
      // from the output, and the two halves then cover 2.005 rather than the
      // triangle's true area of 2 — geometry invented out of a tolerance.
      assert.strictEqual(r.left.length, 4, `left: ${JSON.stringify(r.left)}`);
      assert.strictEqual(r.right.length, 3, `right: ${JSON.stringify(r.right)}`);
      assert.ok(
        r.left.some((p) => approxEqual(p[0], 1.05, 1e-12) && approxEqual(p[1], 2, 1e-12)),
        `apex must survive the clip: ${JSON.stringify(r.left)}`,
      );
      const total = polygonArea(r.left) + polygonArea(r.right);
      assert.ok(approxEqual(total, 2, 1e-9), `halves must partition the triangle, got ${total}`);
    });

    it('rejects a cut that misses the polygon', () => {
      const square: Point2D[] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      const r = clipPolygonByLine(square, [2, 0], [3, 1]);
      assert.strictEqual(r.ok, false);
    });

    it('rejects a cut with coincident endpoints', () => {
      const square: Point2D[] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      const r = clipPolygonByLine(square, [0.5, 0.5], [0.5, 0.5]);
      assert.strictEqual(r.ok, false);
    });

    it('rejects a polygon with fewer than 3 vertices', () => {
      const r = clipPolygonByLine([[0, 0], [1, 0]], [0.5, -1], [0.5, 1]);
      assert.strictEqual(r.ok, false);
    });

    it('produces correct geometry for a diagonal cut', () => {
      const square: Point2D[] = [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
      ];
      // Diagonal from (0, 0) to (2, 2) — splits square into two
      // triangles each of area 2.
      const r = clipPolygonByLine(square, [0, 0], [2, 2]);
      assert.ok(r.ok);
      assert.strictEqual(r.left.length, 3);
      assert.strictEqual(r.right.length, 3);
    });

    it('handles CW-wound input the same as CCW', () => {
      const ccw: Point2D[] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      const cw: Point2D[] = [
        [0, 0],
        [0, 1],
        [1, 1],
        [1, 0],
      ];
      const rCcw = clipPolygonByLine(ccw, [0.5, -1], [0.5, 2]);
      const rCw = clipPolygonByLine(cw, [0.5, -1], [0.5, 2]);
      assert.ok(rCcw.ok);
      assert.ok(rCw.ok);
      // Total vertex count matches (rotation-invariant; can't
      // compare directly because the side semantics swap).
      assert.strictEqual(rCcw.left.length + rCcw.right.length, rCw.left.length + rCw.right.length);
    });

    it('clipping a square then reuniting recovers the original area', () => {
      const square: Point2D[] = [
        [0, 0],
        [4, 0],
        [4, 3],
        [0, 3],
      ];
      const r = clipPolygonByLine(square, [-1, 1], [5, 1]);
      assert.ok(r.ok);
      // Areas of the two halves should sum to the source area (12).
      const area = (poly: Point2D[]) => {
        let a = 0;
        for (let i = 0; i < poly.length; i++) {
          const [x1, y1] = poly[i];
          const [x2, y2] = poly[(i + 1) % poly.length];
          a += x1 * y2 - x2 * y1;
        }
        return Math.abs(a) / 2;
      };
      assert.ok(approxEqual(area(r.left) + area(r.right), 12));
    });

    // Suppress unused-var warning — `polygonsApproxEqual` is exported
    // for use by downstream test files that want strict polygon
    // equality (we use looser area-based checks above).
    void polygonsApproxEqual;
  });

  describe('pointInPolygon', () => {
    const square: Point2D[] = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ];
    it('returns true for an interior point', () => {
      assert.strictEqual(pointInPolygon(square, [1, 1]), true);
    });
    it('returns false for an exterior point', () => {
      assert.strictEqual(pointInPolygon(square, [3, 1]), false);
    });
    it('returns false for a degenerate polygon', () => {
      assert.strictEqual(pointInPolygon([[0, 0], [1, 0]], [0.5, 0.5]), false);
    });
  });
});
