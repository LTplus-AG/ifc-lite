/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Two-valued / boundary contracts of the clash pipeline.
 *
 * Everything here is a case where a wrong answer is silent: a violation that is
 * exactly ON the limit, an overlap exactly equal to tolerance, a depth measured
 * in only one direction, and a run that stopped early. None of them throw —
 * they just report a number nobody checks.
 */

import { describe, expect, it } from 'vitest';
import { createClashEngine } from '../engine.js';
import { fromPositions } from '../math/aabb.js';
import type { ClashElement, Vec3 } from '../types.js';

const BOX_INDICES = new Uint32Array([
  0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
  1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
]);

let nextRef = 1;

/** Axis-aligned box, 12 triangles, with independent per-axis half-extents. */
function boxElement(key: string, tag: string, c: Vec3, half: Vec3): ClashElement {
  const [cx, cy, cz] = c;
  const [hx, hy, hz] = half;
  const positions = new Float32Array([
    cx - hx, cy - hy, cz - hz,
    cx + hx, cy - hy, cz - hz,
    cx + hx, cy + hy, cz - hz,
    cx - hx, cy + hy, cz - hz,
    cx - hx, cy - hy, cz + hz,
    cx + hx, cy - hy, cz + hz,
    cx + hx, cy + hy, cz + hz,
    cx - hx, cy + hy, cz + hz,
  ]);
  return {
    key, ref: nextRef++, model: 'm', tag, positions, indices: BOX_INDICES,
    bounds: fromPositions(positions),
  };
}

/**
 * Closed box whose six faces are each fanned from a face-centre vertex:
 * 14 vertices, 24 triangles. Geometrically identical to `boxElement`, but with
 * MORE triangles — which is what decides the small/large role in the narrow
 * phase, and therefore which direction the contained-pair depth is measured in.
 */
function fanBoxElement(key: string, tag: string, c: Vec3, half: Vec3): ClashElement {
  const [cx, cy, cz] = c;
  const [hx, hy, hz] = half;
  const positions = new Float32Array([
    cx - hx, cy - hy, cz - hz,
    cx + hx, cy - hy, cz - hz,
    cx + hx, cy + hy, cz - hz,
    cx - hx, cy + hy, cz - hz,
    cx - hx, cy - hy, cz + hz,
    cx + hx, cy - hy, cz + hz,
    cx + hx, cy + hy, cz + hz,
    cx - hx, cy + hy, cz + hz,
    cx, cy, cz - hz, // 8  -z face centre
    cx, cy, cz + hz, // 9  +z
    cx, cy - hy, cz, // 10 -y
    cx, cy + hy, cz, // 11 +y
    cx - hx, cy, cz, // 12 -x
    cx + hx, cy, cz, // 13 +x
  ]);
  const indices = new Uint32Array([
    0, 1, 8, 1, 2, 8, 2, 3, 8, 3, 0, 8,
    4, 5, 9, 5, 6, 9, 6, 7, 9, 7, 4, 9,
    0, 1, 10, 1, 5, 10, 5, 4, 10, 4, 0, 10,
    3, 2, 11, 2, 6, 11, 6, 7, 11, 7, 3, 11,
    0, 3, 12, 3, 7, 12, 7, 4, 12, 4, 0, 12,
    1, 2, 13, 2, 6, 13, 6, 5, 13, 5, 1, 13,
  ]);
  return { key, ref: nextRef++, model: 'm', tag, positions, indices, bounds: fromPositions(positions) };
}

const L_PRISM_INDICES = new Uint32Array([
  0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 5, 4,
  6, 7, 8, 6, 8, 9, 6, 9, 10, 6, 10, 11,
  0, 1, 7, 0, 7, 6, 1, 2, 8, 1, 8, 7, 2, 3, 9, 2, 9, 8,
  3, 4, 10, 3, 10, 9, 4, 5, 11, 4, 11, 10, 5, 0, 6, 5, 6, 11,
]);

/**
 * Closed, CONCAVE L-shaped prism, 20 triangles: footprint
 * (0,0)-(2,0)-(2,1)-(1,1)-(1,2)-(0,2) extruded z = 0..1. The square
 * [1,2]×[1,2] is a notch — inside the AABB but OUTSIDE the solid — so a box
 * placed across the notch wall is AABB-contained while genuinely crossing the
 * surface.
 */
function lPrismElement(key: string, tag: string): ClashElement {
  const positions = new Float32Array([
    0, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0, 1, 2, 0, 0, 2, 0,
    0, 0, 1, 2, 0, 1, 2, 1, 1, 1, 1, 1, 1, 2, 1, 0, 2, 1,
  ]);
  return { key, ref: nextRef++, model: 'm', tag, positions, indices: L_PRISM_INDICES, bounds: fromPositions(positions) };
}

describe('clearance rule: the limit itself is a violation', () => {
  it('reports a gap EXACTLY equal to the required clearance', async () => {
    // A spans x ∈ [-0.5, 0.5], B spans x ∈ [1.0, 2.0] → gap exactly 0.5, which
    // is also the required clearance. Every value is exact in f32, so this is a
    // true `==` boundary, not a near-miss. `<=` is the documented contract and
    // is what the Rust kernel implements (rust/clash/src/narrow.rs); a `<` here
    // silently passes a duct that sits precisely on the minimum separation.
    const elements = [
      boxElement('A', 'IfcWall', [0, 0, 0], [0.5, 0.5, 0.5]),
      boxElement('B', 'IfcDuctSegment', [1.5, 0, 0], [0.5, 0.5, 0.5]),
    ];
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(elements, [
      { id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct*', mode: 'clearance', clearance: 0.5 },
    ]);
    expect(result.summary.total).toBe(1);
    expect(result.clashes[0].status).toBe('clearance');
    expect(result.clashes[0].distance).toBeCloseTo(0.5, 6);
  });

  it('does NOT report a gap just beyond the required clearance', async () => {
    // Same fixture pushed 1/16 m further apart. Without this the test above
    // would also pass for an engine that reports every candidate pair.
    const elements = [
      boxElement('A', 'IfcWall', [0, 0, 0], [0.5, 0.5, 0.5]),
      boxElement('B', 'IfcDuctSegment', [1.5625, 0, 0], [0.5, 0.5, 0.5]),
    ];
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(elements, [
      { id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct*', mode: 'clearance', clearance: 0.5 },
    ]);
    expect(result.summary.total).toBe(0);
  });
});

describe('hard rule: an overlap exactly equal to tolerance is contact, not a clash', () => {
  it('suppresses two boxes whose AABBs penetrate by exactly the tolerance', async () => {
    // Overlap on x is exactly 1/16 = the tolerance, so the AABB signed gap is
    // exactly -tolerance. The gate is `gap < -tolerance` (strict, mirroring the
    // Rust kernel): an overlap that merely REACHES tolerance is the touching
    // band, not a hard clash. A `<=` here turns every element that sits exactly
    // on the modelling tolerance into a reported collision.
    const t = 0.0625;
    const elements = [
      boxElement('A', 'IfcWall', [0, 0, 0], [0.5, 0.5, 0.5]),
      boxElement('B', 'IfcSlab', [1 - t, 0, 0], [0.5, 0.5, 0.5]),
    ];
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(
      elements,
      [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcSlab', mode: 'hard' }],
      { tolerance: t },
    );
    expect(result.summary.total).toBe(0);
  });

  it('DOES report the pair once the overlap goes past the tolerance', async () => {
    // Recall guard: proves the suppression above is a boundary decision, not a
    // blanket "axis-aligned boxes never clash".
    const t = 0.0625;
    const elements = [
      boxElement('A', 'IfcWall', [0, 0, 0], [0.5, 0.5, 0.5]),
      boxElement('B', 'IfcSlab', [1 - 4 * t, 0, 0], [0.5, 0.5, 0.5]),
    ];
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(
      elements,
      [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcSlab', mode: 'hard' }],
      { tolerance: t },
    );
    expect(result.summary.total).toBe(1);
    expect(result.clashes[0].status).toBe('hard');
  });
});

describe('contained pair: a non-box element falls back to the labelled AABB estimate (#1866)', () => {
  it('reports the AABB estimate, honestly labelled, for a concave contained pair', async () => {
    // Concave L-prism (20 triangles) vs a fanned box (24 triangles) laid across
    // the notch wall at x = 1. The box's AABB is inside the prism's, so this is
    // the contained-pair branch.
    //
    // #1866 was originally fixed by `maxPenetrationInto` — a nearest-crossing-
    // vertex probe held (PR #2536) for being a sampling artifact that converges
    // to 0 under retessellation instead of to the true depth (see `obb.ts`).
    // Its replacement, the box-box SAT depth, cannot certify a concave L-prism
    // (it is not a box), so this KNOWN case regresses to the pre-#1866 AABB
    // signed-gap estimate (here the box's own shortest extent, 0.6 m) —
    // reported HONESTLY as `'estimate'`, not silently mislabelled `'mesh'` the
    // way the old probe was. A non-box depth metric is future work (see the PR
    // #2536 hold comment's "landing conditions").
    const prism = lPrismElement('L', 'IfcSlab');
    const bar = fanBoxElement('BAR', 'IfcBeam', [0.9, 1.5, 0.5], [0.5, 0.3, 0.3]);
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run([prism, bar], [
      { id: 'r', name: 'r', a: 'IfcSlab', b: 'IfcBeam', mode: 'hard' },
    ]);

    expect(result.summary.total).toBe(1);
    const c = result.clashes[0];
    expect(c.status).toBe('hard');
    expect(c.distanceKind).toBe('estimate');
    expect(c.distance).toBeCloseTo(-0.6, 3);
  });
});

describe('maxCandidatePairs: the cap is honoured and the truncation is reported', () => {
  /** Six candidate pairs: four mutually overlapping walls, self-clash. */
  function fourOverlappingWalls(): ClashElement[] {
    return [
      boxElement('W1', 'IfcWall', [0, 0, 0], [0.5, 0.5, 0.5]),
      boxElement('W2', 'IfcWall', [0.1, 0, 0], [0.5, 0.5, 0.5]),
      boxElement('W3', 'IfcWall', [0.2, 0, 0], [0.5, 0.5, 0.5]),
      boxElement('W4', 'IfcWall', [0.3, 0, 0], [0.5, 0.5, 0.5]),
    ];
  }
  const RULE = { id: 'self', name: 'walls', a: 'IfcWall', mode: 'hard' as const };

  it('reports no truncation and all 6 pairs when the cap is not set', async () => {
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(fourOverlappingWalls(), [RULE]);
    expect(result.summary.total).toBe(6);
    expect(result.truncated).toBeUndefined();
  });

  it('processes exactly `maxCandidatePairs` pairs and reports the dropped remainder', async () => {
    // The budget is checked BEFORE each pair (`processed >= maxPairs`), so a cap
    // of 2 must yield exactly 2 clashes and 4 dropped. An off-by-one runs a
    // third pair — the cap is then not the cap the caller asked for, and the
    // reported `droppedPairs` no longer adds up to the candidate total.
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(fourOverlappingWalls(), [RULE], { maxCandidatePairs: 2 });
    expect(result.summary.total).toBe(2);
    expect(result.truncated).toEqual({ reason: 'maxCandidatePairs', droppedPairs: 4 });
  });

  it('flags truncation even when the cap bites on the very first pair', async () => {
    // Zero budget: nothing is examined, and the caller MUST be told — otherwise
    // an empty clash list reads as "the model is clean".
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(fourOverlappingWalls(), [RULE], { maxCandidatePairs: 0 });
    expect(result.summary.total).toBe(0);
    expect(result.truncated?.droppedPairs).toBe(6);
  });

  it('spends ONE global budget across rules, not one per rule', async () => {
    // Two rules over the same six pairs with a cap of 8: the first rule spends
    // 6, leaving 2 for the second, which then drops 4.
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(
      fourOverlappingWalls(),
      [RULE, { ...RULE, id: 'self2' }],
      { maxCandidatePairs: 8 },
    );
    expect(result.truncated?.droppedPairs).toBe(4);
    expect(result.summary.byRule.self).toBe(6);
    expect(result.summary.byRule.self2).toBe(2);
  });
});
