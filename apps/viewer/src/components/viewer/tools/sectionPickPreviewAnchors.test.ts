/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { planeBasis } from '@ifc-lite/renderer';
import {
  sectionPickPreviewAnchors,
  PREVIEW_ARROW_LENGTH_M,
  PREVIEW_HALF_EXTENT_M,
  type Vec3Tuple,
} from './sectionPickPreviewAnchors.js';

/**
 * #2495 — the face-pick hover preview's in-plane basis.
 *
 * `SectionVisualization.tsx` carried its own copy of the basis derivation,
 * annotated as a duplicate of the renderer's `planeBasis()`. Two things fall
 * out of routing the copy through the shared one instead of patching it:
 * the Z-seed collapse (a plain finite defect on the most ordinary face pick
 * there is) and the `|| 1` finiteness blind spot the whole #2489 / #2494
 * family is about.
 */

const dot = (a: Vec3Tuple, b: Vec3Tuple) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple =>
  [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3Tuple) => Math.hypot(a[0], a[1], a[2]);

const POINT: Vec3Tuple = [3, 4, 5];

describe('sectionPickPreviewAnchors — the quad the user sees', () => {
  it('lays a real square on the face for an ordinary +Z wall normal', () => {
    // The regression the deleted duplicate had: its seed axis was world Z
    // whenever |ny| <= 0.9, so `cross([0,0,1], [0,0,1])` was the zero vector,
    // `|| 1` divided by 1 instead of reporting it, and all four corners
    // landed exactly on the picked point — a quad with zero area.
    const a = sectionPickPreviewAnchors(POINT, [0, 0, 1])!;
    assert.ok(a, 'a +Z face pick must produce anchors');
    for (const c of a.corners) {
      assert.ok(
        len(sub(c, POINT)) > 0.1,
        `corner collapsed onto the picked point: ${JSON.stringify(c)}`,
      );
    }
    // A square: the two diagonals are equal and the edges all match.
    const [c0, c1, c2, c3] = a.corners;
    assert.ok(Math.abs(len(sub(c2, c0)) - len(sub(c3, c1))) < 1e-12, 'equal diagonals');
    assert.ok(Math.abs(len(sub(c1, c0)) - len(sub(c2, c1))) < 1e-12, 'equal edges');
    assert.ok(
      Math.abs(len(sub(c1, c0)) - 2 * PREVIEW_HALF_EXTENT_M) < 1e-12,
      'edge is 2 × the half-extent',
    );
  });

  it('keeps every corner in the picked plane, for every axis and a skew normal', () => {
    for (const n of [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
      [0.3, -0.5, 0.81], [0.577, 0.577, 0.577],
    ] as Vec3Tuple[]) {
      const unit: Vec3Tuple = [n[0] / len(n), n[1] / len(n), n[2] / len(n)];
      const a = sectionPickPreviewAnchors(POINT, n)!;
      assert.ok(a, `no anchors for ${JSON.stringify(n)}`);
      for (const c of a.corners) {
        assert.ok(
          Math.abs(dot(sub(c, POINT), unit)) < 1e-9,
          `corner off the plane for ${JSON.stringify(n)}: ${JSON.stringify(c)}`,
        );
        assert.ok(len(sub(c, POINT)) > 0.1, `degenerate corner for ${JSON.stringify(n)}`);
      }
    }
  });

  it('points the arrow along the unit normal, at the documented length', () => {
    const a = sectionPickPreviewAnchors(POINT, [0, 0, 7])!;
    assert.deepStrictEqual(a.foot, [3, 4, 5]);
    assert.ok(Math.abs(len(sub(a.tip, a.foot)) - PREVIEW_ARROW_LENGTH_M) < 1e-12,
      'the arrow length must not scale with the caller\'s normal magnitude');
    assert.ok(a.tip[2] > a.foot[2], 'and it must point along the normal, not against it');
  });

  it('uses the SHARED planeBasis, so the preview square and the committed cut hatch agree', () => {
    // The whole point of deleting the duplicate: `sectionSlice`'s commit path
    // stores `planeBasis(unit)` on the custom plane, and the hover preview
    // must be the same derivation, not a second one that drifts.
    const normal: Vec3Tuple = [0.3, -0.5, 0.81];
    const l = len(normal);
    const unit: Vec3Tuple = [normal[0] / l, normal[1] / l, normal[2] / l];
    const { tangent, bitangent } = planeBasis(unit);
    const a = sectionPickPreviewAnchors(POINT, normal)!;
    const expected = (s: number, t: number): Vec3Tuple => [
      POINT[0] + tangent[0] * s + bitangent[0] * t,
      POINT[1] + tangent[1] * s + bitangent[1] * t,
      POINT[2] + tangent[2] * s + bitangent[2] * t,
    ];
    const h = PREVIEW_HALF_EXTENT_M;
    assert.deepStrictEqual(a.corners[0], expected(-h, -h));
    assert.deepStrictEqual(a.corners[2], expected(h, h));
  });
});

describe('sectionPickPreviewAnchors — non-finite and directionless picks (#2495)', () => {
  for (const bad of [
    [Infinity, 0, 0], [-Infinity, 0, 0], [0, Infinity, 0], [0, 0, Infinity],
    [NaN, 0, 0], [0, NaN, 0], [Infinity, NaN, 0],
  ] as Vec3Tuple[]) {
    it(`returns null for a normal of ${JSON.stringify(bad)} instead of NaN corners`, () => {
      assert.strictEqual(sectionPickPreviewAnchors(POINT, bad), null);
    });
  }

  it('returns null for the zero normal (no direction at all)', () => {
    assert.strictEqual(sectionPickPreviewAnchors(POINT, [0, 0, 0]), null);
  });

  for (const bad of [
    [Infinity, 0, 0], [0, NaN, 0], [0, 0, -Infinity],
  ] as Vec3Tuple[]) {
    it(`returns null for a picked point of ${JSON.stringify(bad)}`, () => {
      assert.strictEqual(sectionPickPreviewAnchors(bad, [0, 0, 1]), null);
    });
  }

  it('never emits a non-finite coordinate for any input it accepts', () => {
    const inputs: Array<[Vec3Tuple, Vec3Tuple]> = [
      [POINT, [0, 0, 1]], [POINT, [0, 1, 0]], [POINT, [1e-300, 0, 0]],
      [[0, 0, 0], [0.577, 0.577, 0.577]], [[1e300, 0, 0], [0, 0, 1]],
    ];
    for (const [p, n] of inputs) {
      const a = sectionPickPreviewAnchors(p, n);
      if (!a) continue;
      for (const v of [...a.corners, a.foot, a.tip]) {
        assert.ok(v.every(Number.isFinite), `non-finite anchor for ${JSON.stringify([p, n])}`);
      }
    }
  });

  // Anti-mutation: the guard must test finiteness, not magnitude. A floor
  // (`len < 1e-6 -> null`) would pass every rejection case above while
  // silently refusing to preview a face whose raycast normal happens to come
  // back short — the exact over-broad reading this family keeps producing.
  it('still previews a legitimately tiny but perfectly valid normal', () => {
    const tiny = sectionPickPreviewAnchors(POINT, [0, 0, 1e-300]);
    assert.ok(tiny, 'a short normal is still a direction');
    const unit = sectionPickPreviewAnchors(POINT, [0, 0, 1])!;
    assert.deepStrictEqual(tiny, unit, 'and it must give the same basis as its unit form');
  });
});
