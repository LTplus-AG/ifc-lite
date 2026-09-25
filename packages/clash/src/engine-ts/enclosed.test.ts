/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The enclosed-solid probe (#5473): an AABB-contained pair with no triangle
 * crossing is decided by ray-casting ONE point of the contained mesh, and
 * that point must not be on the other solid's surface, where ray parity is a
 * coin flip. One-for-one mirror of the `_5473` tests in
 * `rust/clash/src/tests.rs`.
 */

import { describe, expect, it } from 'vitest';
import { fromPositions } from '../math/aabb.js';
import type { ClashElement, ClashRule, Vec3 } from '../types.js';
import { containedSolidIsBuried } from './depth.js';
import { testPair } from './narrow.js';
import { TriMesh } from './tri-mesh.js';

/** Concave L prism: footprint (0,0)-(2,0)-(2,1)-(1,1)-(1,2)-(0,2), z 0..1.
 *  The square [1,2]x[1,2] is the notch: inside the AABB, outside the solid. */
const L_POSITIONS = [
  0, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0, 1, 2, 0, 0, 2, 0,
  0, 0, 1, 2, 0, 1, 2, 1, 1, 1, 1, 1, 1, 2, 1, 0, 2, 1,
];
const L_INDICES = new Uint32Array([
  0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 5, 4, 6, 7, 8, 6, 8, 9, 6, 9, 10, 6, 10, 11,
  0, 1, 7, 0, 7, 6, 1, 2, 8, 1, 8, 7, 2, 3, 9, 2, 9, 8, 3, 4, 10, 3, 10, 9, 4, 5, 11, 4, 11,
  10, 5, 0, 6, 5, 6, 11,
]);

const BOX_INDICES = new Uint32Array([
  0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 5, 1, 0, 4, 5, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4,
  1, 5, 6, 1, 6, 2,
]);

/** Box corners in the Rust `box_hxyz` order (min corner first). */
function boxPositions(c: Vec3, h: Vec3): number[] {
  const out: number[] = [];
  for (const [sx, sy, sz] of [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ]) {
    out.push(c[0] + sx! * h[0], c[1] + sy! * h[1], c[2] + sz! * h[2]);
  }
  return out;
}

/** Rotate by `Rz(yaw) * Rx(roll)`, translate by `off`, bake through f32 —
 *  the Rust `placed`. */
function placed(key: string, positions: number[], indices: Uint32Array, yaw: number, roll: number, off: Vec3): ClashElement {
  const [cz, sz, cx, sx] = [Math.cos(yaw), Math.sin(yaw), Math.cos(roll), Math.sin(roll)];
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = Math.fround(positions[i]!);
    const y0 = Math.fround(positions[i + 1]!);
    const z0 = Math.fround(positions[i + 2]!);
    const y = cx * y0 - sx * z0;
    const z = sx * y0 + cx * z0;
    out[i] = cz * x - sz * y + off[0];
    out[i + 1] = sz * x + cz * y + off[1];
    out[i + 2] = z + off[2];
  }
  return { key, ref: 0, model: 'm', tag: key, bounds: fromPositions(out), positions: out, indices };
}

const NOTCH_PLACEMENTS: Array<[number, number, Vec3]> = [
  [0, 0, [0, 0, 0]],
  [0, 0, [3.7, -12.9, 2.35]],
  [0, -0.7, [0, 0, 0]],
  [0, -0.7, [3.7, -12.9, 2.35]],
  [0, -0.7, [123.456, -45.678, 9.1]],
  [0, -0.7, [1000, 0, 0]],
];

const HARD: ClashRule = { id: 'r', name: 'r', a: '*', mode: 'hard' };

function mesh(el: ClashElement): TriMesh {
  return new TriMesh(el.positions, el.indices);
}

describe('enclosed-solid probe (#5473)', () => {
  it('reports a box exactly filling a notch as no hard clash wherever it sits', () => {
    // Every vertex of the box is on the L's surface; the old probe (its
    // vertex 0) read "inside" when rolled -0.7 rad and reported a -1.0 m hard
    // clash. The box's centroid, outside the L, now decides.
    let oldProbeReadInside = false;
    for (const [yaw, roll, off] of NOTCH_PLACEMENTS) {
      const l = placed('L', L_POSITIONS, L_INDICES, yaw, roll, off);
      const box = placed('B', boxPositions([1.5, 1.5, 0.5], [0.5, 0.5, 0.5]), BOX_INDICES, yaw, roll, off);
      const [lm, bm] = [mesh(l), mesh(box)];
      if (lm.containsPoint(bm.tri(0)[0])) oldProbeReadInside = true;
      expect(testPair(l, lm, box, bm, HARD, 0.001), `yaw ${yaw}, roll ${roll}, offset ${off}`).toBeNull();
    }
    expect(oldProbeReadInside, 'fixture premise: some placement fooled the vertex-0 probe').toBe(true);
  });

  it('still reports a box buried in the L as hard wherever it sits', () => {
    for (const [yaw, roll, off] of NOTCH_PLACEMENTS) {
      const l = placed('L', L_POSITIONS, L_INDICES, yaw, roll, off);
      const box = placed('B', boxPositions([0.5, 0.5, 0.5], [0.3, 0.3, 0.3]), BOX_INDICES, yaw, roll, off);
      const res = testPair(l, mesh(l), box, mesh(box), HARD, 0.001);
      expect(res?.status, `yaw ${yaw}, roll ${roll}, offset ${off}`).toBe('hard');
    }
  });

  it('reports a two-shell element with one shell buried as hard (review of #5564)', () => {
    // The first shell floats clear in the notch (outside the L), the second
    // is buried in the L's solid corner; nothing crosses. The clearly-outside
    // shell must not end the search. Mirrors
    // `a_two_shell_element_with_one_shell_buried_is_hard_5473`.
    const positions = [...boxPositions([1.5, 1.5, 0.5], [0.3, 0.3, 0.3]), ...boxPositions([0.5, 0.5, 0.5], [0.3, 0.3, 0.3])];
    const indices = new Uint32Array([...BOX_INDICES, ...BOX_INDICES.map((i) => i + 8)]);
    const l = placed('L', L_POSITIONS, L_INDICES, 0, 0, [0, 0, 0]);
    const two = placed('T', positions, indices, 0, 0, [0, 0, 0]);
    expect(testPair(l, mesh(l), two, mesh(two), HARD, 0.001)?.status).toBe('hard');
  });

  it('finds a duplicate of its container buried in it, from the centroid', () => {
    // Corners listed max-first, so the first one reads "outside": no vertex
    // of a duplicate can decide, its centroid does.
    const corners = boxPositions([2, -1, 0.5], [0.5, 0.3, 0.2]);
    const reversed: number[] = [];
    for (let i = 7; i >= 0; i -= 1) reversed.push(corners[3 * i]!, corners[3 * i + 1]!, corners[3 * i + 2]!);
    const dup = new TriMesh(new Float32Array(reversed), BOX_INDICES.map((i) => 7 - i));
    expect(dup.containsPoint(dup.vertex(0)), 'fixture premise').toBe(false);
    const bb = fromPositions(new Float32Array(reversed));
    expect(containedSolidIsBuried(dup, dup, bb, bb)).toBe(true);
  });

  it('does not find a box resting on a slab from outside buried in it', () => {
    const slabPos = new Float32Array(boxPositions([0, 0, 0], [5, 5, 1]));
    const restingPos = new Float32Array(boxPositions([0, 0, 1.2], [0.5, 0.5, 0.2]));
    const slab = new TriMesh(slabPos, BOX_INDICES);
    const resting = new TriMesh(restingPos, BOX_INDICES);
    expect(containedSolidIsBuried(resting, slab, fromPositions(restingPos), fromPositions(slabPos))).toBe(false);
  });
});

/** The complement of the L over [1,3]x[0,2] (notch square + arm), z 0..1,
 *  shifted `dy` along Y. Mirrors the Rust `complementary_l`. */
function complementaryL(dy: number): { positions: number[]; indices: Uint32Array } {
  const foot = [[2, 0], [3, 0], [3, 2], [1, 2], [1, 1], [2, 1]];
  const positions: number[] = [];
  for (const z of [0, 1]) for (const [x, y] of foot) positions.push(x!, y! + dy, z);
  const idx = [5, 1, 0, 5, 2, 1, 5, 3, 2, 5, 4, 3, 11, 6, 7, 11, 7, 8, 11, 8, 9, 11, 9, 10];
  for (let k = 0; k < 6; k += 1) {
    const n = (k + 1) % 6;
    idx.push(k, n, n + 6, k, n + 6, k + 6);
  }
  return { positions, indices: new Uint32Array(idx) };
}

const INTERLOCK_PLACEMENTS: Array<[number, number, Vec3]> = [
  [0, 0, [0, 0, 0]],
  [0, 0, [7.4, 0, 0]],
  [0, 0, [3.7, -12.9, 2.35]],
  [0, 0, [123.456, -45.678, 9.1]],
  [0, 0, [1000, 0, 0]],
  [0.3, 0, [0, 0, 0]],
  [0.3, 0, [123.456, -45.678, 9.1]],
  [1.1, -0.61, [1000, 0, 0]],
];

describe('AABB-penetration probe on the contact face (#5751)', () => {
  // Mirrors the `_5751` tests in `rust/clash/src/tests.rs`: two L prisms
  // interlocking flush, whose AABB-overlap centre lies ON the shared face.
  it('reports flush interlocking Ls as a touch at every placement, never the AABB estimate', () => {
    const touchRule: ClashRule = { ...HARD, reportTouch: true };
    for (const [yaw, roll, off] of INTERLOCK_PLACEMENTS) {
      const l = placed('L', L_POSITIONS, L_INDICES, yaw, roll, off);
      const c = complementaryL(0);
      const other = placed('C', c.positions, c.indices, yaw, roll, off);
      expect(testPair(l, mesh(l), other, mesh(other), HARD, 0.001), `yaw ${yaw}, roll ${roll}, offset ${off}`).toBeNull();
      expect(testPair(l, mesh(l), other, mesh(other), touchRule, 0.001)?.status, `yaw ${yaw}, roll ${roll}, offset ${off}`).toBe('touch');
    }
  });

  it('still reports the same Ls driven 20 mm into each other as hard at every placement', () => {
    for (const [yaw, roll, off] of INTERLOCK_PLACEMENTS) {
      const l = placed('L', L_POSITIONS, L_INDICES, yaw, roll, off);
      const c = complementaryL(-0.02);
      const other = placed('C', c.positions, c.indices, yaw, roll, off);
      expect(testPair(l, mesh(l), other, mesh(other), HARD, 0.001)?.status, `yaw ${yaw}, roll ${roll}, offset ${off}`).toBe('hard');
    }
  });

  it('keeps a 1 mm aligned overlap found through the probe hard 10 km out on an orthogonal axis', () => {
    // Mirrors `a_1mm_aligned_overlap_through_the_probe_is_hard_far_out_on_an_orthogonal_axis_5751`:
    // the probe's 0.5 mm clearance along X is judged against the floor
    // projected onto X, not a 10 km Y magnitude.
    const rule: ClashRule = { ...HARD };
    for (const off of [[0, 0, 0], [0, 10_000, 0]] as Vec3[]) {
      const a = placed('A', boxPositions([0, 0, 0], [5, 0.5, 0.5]), BOX_INDICES, 0, 0, off);
      const b = placed('B', boxPositions([5.499, 0, 0], [0.5, 0.5, 0.5]), BOX_INDICES, 0, 0, off);
      const res = testPair(a, mesh(a), b, mesh(b), rule, 0.0001);
      expect(res?.status, `offset ${off}`).toBe('hard');
      expect(res!.distance, `offset ${off}`).toBeCloseTo(-0.001, 5);
    }
  });
});
