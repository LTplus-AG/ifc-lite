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

  it('finds a duplicate of its container buried in it, from the centroid', () => {
    // Corners listed max-first, so the first one reads "outside": no vertex
    // of a duplicate can decide, its centroid does.
    const corners = boxPositions([2, -1, 0.5], [0.5, 0.3, 0.2]);
    const reversed: number[] = [];
    for (let i = 7; i >= 0; i -= 1) reversed.push(corners[3 * i]!, corners[3 * i + 1]!, corners[3 * i + 2]!);
    const dup = new TriMesh(new Float32Array(reversed), BOX_INDICES.map((i) => 7 - i));
    expect(dup.containsPoint(dup.vertex(0)), 'fixture premise').toBe(false);
    expect(containedSolidIsBuried(dup, dup)).toBe(true);
  });

  it('does not find a box resting on a slab from outside buried in it', () => {
    const slab = new TriMesh(new Float32Array(boxPositions([0, 0, 0], [5, 5, 1])), BOX_INDICES);
    const resting = new TriMesh(new Float32Array(boxPositions([0, 0, 1.2], [0.5, 0.5, 0.2])), BOX_INDICES);
    expect(containedSolidIsBuried(resting, slab)).toBe(false);
  });
});
