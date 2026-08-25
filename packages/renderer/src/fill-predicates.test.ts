/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Boundary-pinning tests for `fill-predicates.ts`. This module has no
 * dedicated test file — it is only exercised indirectly through
 * `fill-triangulate.test.ts` / `fill-bridge-anchor.test.ts` /
 * `symbolic-fill-triangulate.test.ts`, whose fixtures never happen to put a
 * segment endpoint exactly ON another segment's line.
 *
 * Mutation testing found `properlyCross`'s first clause survives being
 * widened from strict `< 0` to `<= 0`: the full suite of 42 fill-pipeline
 * tests stays green. That widening makes `properlyCross(a, b, c, d)` report
 * TRUE when `a` or `b` lies exactly on the infinite line through `c, d` —
 * contradicting this file's own doc comment ("Shared endpoints and touching
 * do not count") and `fill-bridge-anchor.ts`'s reliance on that contract to
 * decide whether a candidate hole-bridge is clear.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { orient, pointOnSegment, properlyCross, samePoint } from './fill-predicates.js';

describe('orient', () => {
  it('is 0 for exactly collinear points', () => {
    assert.strictEqual(orient({ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 1, z: 0 }), 0);
  });
  it('sign flips with the two candidate points swapped', () => {
    const p = { x: 0, z: 0 };
    const q = { x: 2, z: 0 };
    assert.strictEqual(orient(p, q, { x: 1, z: 1 }), 1);
    assert.strictEqual(orient(p, q, { x: 1, z: -1 }), -1);
  });
});

describe('properlyCross', () => {
  it('is true for a genuine X crossing', () => {
    const a = { x: 0, z: 0 };
    const b = { x: 2, z: 2 };
    const c = { x: 0, z: 2 };
    const d = { x: 2, z: 0 };
    assert.strictEqual(properlyCross(a, b, c, d), true);
  });

  it('is false when the tested edge only touches the bridge endpoint (T-junction), not a genuine crossing', () => {
    // Bridge a->b runs along z=0 from x=0 to x=2. Edge c->d is the vertical
    // line x=2, straddling z=0 — but it meets a->b exactly AT b (2,0), the
    // bridge's own endpoint, not through its interior. This is the
    // "shared endpoint" case the doc says must not count as a crossing:
    // widening the first clause from `< 0` to `<= 0` (because b lies exactly
    // on line c-d, product is 0) flips this to a false positive.
    const a = { x: 0, z: 0 };
    const b = { x: 2, z: 0 };
    const c = { x: 2, z: 1 };
    const d = { x: 2, z: -1 };
    assert.strictEqual(properlyCross(a, b, c, d), false);
  });

  it('is false for two segments that merely touch at a shared endpoint', () => {
    const a = { x: 0, z: 0 };
    const b = { x: 2, z: 0 };
    const c = { x: 2, z: 0 };
    const d = { x: 2, z: 2 };
    assert.strictEqual(properlyCross(a, b, c, d), false);
  });

  it('is false for two parallel, non-intersecting segments', () => {
    const a = { x: 0, z: 0 };
    const b = { x: 2, z: 0 };
    const c = { x: 0, z: 1 };
    const d = { x: 2, z: 1 };
    assert.strictEqual(properlyCross(a, b, c, d), false);
  });
});

describe('pointOnSegment', () => {
  it('excludes endpoints when includeEnds is false', () => {
    const a = { x: 0, z: 0 };
    const b = { x: 2, z: 0 };
    assert.strictEqual(pointOnSegment(a, a, b, false), false);
    assert.strictEqual(pointOnSegment(b, a, b, false), false);
    assert.strictEqual(pointOnSegment({ x: 1, z: 0 }, a, b, false), true);
  });
  it('includes endpoints when includeEnds is true', () => {
    const a = { x: 0, z: 0 };
    const b = { x: 2, z: 0 };
    assert.strictEqual(pointOnSegment(a, a, b, true), true);
    assert.strictEqual(pointOnSegment(b, a, b, true), true);
  });
  it('is false for a point off the line entirely', () => {
    const a = { x: 0, z: 0 };
    const b = { x: 2, z: 0 };
    assert.strictEqual(pointOnSegment({ x: 1, z: 1 }, a, b, true), false);
  });
});

describe('samePoint', () => {
  it('is true only within tolerance scaled to the given extent', () => {
    const a = { x: 0, z: 0 };
    assert.strictEqual(samePoint(a, { x: 1e-13, z: 0 }, 1), true);
    assert.strictEqual(samePoint(a, { x: 0.5, z: 0 }, 1), false);
  });
});
