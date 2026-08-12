/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Clash.distance` for a hard clash is either a depth MEASURED on the triangle
 * meshes or an ESTIMATE read off the element AABBs, and until `distanceKind`
 * existed the two were indistinguishable in the output. These fixtures pin one
 * pair per code path, and pin the distances themselves so the labelling can
 * never be mistaken for a change of the numbers.
 *
 * The `'mesh'` label now comes from an exact box-box penetration depth (see
 * `obb.ts`), not from `maxPenetrationInto` — a nearest-crossing-vertex probe
 * that was held (PR #2536) for being a sampling artifact: it converges to 0
 * under retessellation instead of to the true depth, and was labelled
 * trustworthy while the AABB estimate — genuinely correct for boxes — was
 * labelled an estimate. Every pair of RECTANGULAR-BOX elements is now exactly
 * measurable, so every box fixture below is `'mesh'`; only a genuinely
 * non-box shape (the triangular-prism column) still falls back to the AABB
 * `'estimate'`. See `obb.test.ts` for the analytic-oracle coverage of the
 * metric itself (tessellation invariance, a rotated box, a barely-overlapping
 * control).
 */

import { describe, expect, it } from 'vitest';
import { testPair } from './narrow.js';
import { TriMesh } from './tri-mesh.js';
import { createClashEngine } from '../engine.js';
import type { ClashElement, ClashRule, Vec3 } from '../types.js';

let nextRef = 1;

/** Axis-aligned box element spanning `min`..`max` (12 triangles, closed). */
function boxEl(key: string, tag: string, min: Vec3, max: Vec3): ClashElement {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return { key, ref: nextRef++, model: 'm', tag, positions, indices, bounds: { min, max } };
}

/**
 * Triangular-prism element: a right prism over triangle base `(p0,p1,p2)`
 * (in XY) extruded from `z0` to `z1`. NOT a box — the two triangular caps and
 * the three rectangular sides give 5 distinct face-normal families, so
 * `detectObb` correctly declines to certify it, keeping the AABB-estimate
 * path genuinely exercised (rather than by a box the detector happens to miss).
 */
function prismEl(key: string, tag: string, p0: [number, number], p1: [number, number], p2: [number, number], z0: number, z1: number): ClashElement {
  const pts = [p0, p1, p2];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const positions = new Float32Array([
    p0[0], p0[1], z0, p1[0], p1[1], z0, p2[0], p2[1], z0, // 0,1,2: bottom cap
    p0[0], p0[1], z1, p1[0], p1[1], z1, p2[0], p2[1], z1, // 3,4,5: top cap
  ]);
  const indices = new Uint32Array([
    // Bottom cap (facing -z) and top cap (facing +z).
    0, 2, 1, 3, 4, 5,
    // Three rectangular sides.
    0, 1, 4, 0, 4, 3,
    1, 2, 5, 1, 5, 4,
    2, 0, 3, 2, 3, 5,
  ]);
  return {
    key,
    ref: nextRef++,
    model: 'm',
    tag,
    positions,
    indices,
    bounds: { min: [minX, minY, z0], max: [maxX, maxY, z1] },
  };
}

const RULE: ClashRule = { id: 'r', name: 'r', a: '*', b: '*', mode: 'hard' };

function pair(a: ClashElement, b: ClashElement) {
  const res = testPair(a, new TriMesh(a.positions!, a.indices!), b, new TriMesh(b.positions!, b.indices!), RULE, 0.001);
  if (!res) throw new Error('expected a clash');
  return res;
}

describe('hard-clash distance provenance', () => {
  it('labels a genuine box-box crossing as mesh-measured', () => {
    // A block driven 75 mm into a 200 mm slab: both elements are boxes, so the
    // exact box-box penetration depth (the Z-axis overlap) is certifiable.
    const res = pair(
      boxEl('A', 'IfcSlab', [0, 0, 0], [10, 10, 0.2]),
      boxEl('B', 'IfcFooting', [4, 4, 0.125], [5, 5, 1]),
    );
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('mesh');
    expect(res.distance).toBe(-0.07500000298023224);
  });

  it('labels a stack whose footprints do NOT coincide as mesh-measured', () => {
    // The upper slab is inset but both elements are still boxes: the exact
    // depth is the Z overlap, 0.04.
    const res = pair(
      boxEl('A', 'IfcSlab', [0, 0, 0], [10, 10, 0.2]),
      boxEl('B', 'IfcSlab', [1, 1, 0.16], [9, 9, 0.41]),
    );
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('mesh');
    expect(res.distance).toBe(-0.040000006556510925);
  });

  it('labels a non-box member piercing clean through as an AABB estimate', () => {
    // A triangular-prism column passing right through a box slab: the column
    // is NOT a box (detectObb declines it), so there is no certified box-box
    // depth and the reported number is the smallest overlapping AABB
    // dimension — an estimate, not a measured depth.
    const res = pair(
      boxEl('A', 'IfcSlab', [0, 0, 0], [10, 10, 0.2]),
      prismEl('B', 'IfcColumn', [4, 4], [4.3, 4], [4.15, 4.3], -5, 5),
    );
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('estimate');
    expect(res.distance).toBe(-0.2);
  });

  it('labels coincident-footprint stacked box layers as mesh-measured', () => {
    // Two pavement layers with the same footprint, overlapping 40 mm. Their
    // surfaces only COINCIDE — no triangle pair crosses — so this lands in
    // the coplanar-overlap branch. Both are boxes, so the exact depth (the Z
    // overlap) is certifiable there too.
    const res = pair(
      boxEl('A', 'IfcSlab', [0, 0, 0], [10, 10, 0.2]),
      boxEl('B', 'IfcSlab', [0, 0, 0.16], [10, 10, 0.41]),
    );
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('mesh');
    expect(res.distance).toBe(-0.040000006556510925);
  });

  it('labels an enclosed box layer as mesh-measured', () => {
    // A 40 mm layer modelled wholly inside a 250 mm one: no surface crossing
    // at all, so this lands in the enclosed-solid branch. Both are boxes, so
    // the exact depth is certified there too — it happens to equal the thin
    // layer's own thickness, the value most easily mistaken for a guess.
    const res = pair(
      boxEl('A', 'IfcSlab', [0, 0, 0], [10, 10, 0.04]),
      boxEl('B', 'IfcSlab', [0, 0, 0], [10, 10, 0.25]),
    );
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('mesh');
    expect(res.distance).toBe(-0.03999999910593033);
  });

  it('carries the label onto the public Clash', async () => {
    const engine = createClashEngine();
    const res = await engine.run(
      [
        boxEl('L1', 'IfcSlab', [0, 0, 0], [10, 10, 0.2]),
        boxEl('L2', 'IfcSlab', [0, 0, 0.16], [10, 10, 0.41]),
      ],
      [{ id: 'r', name: 'r', a: 'IfcSlab', b: 'IfcSlab', mode: 'hard' }],
    );
    expect(res.clashes).toHaveLength(1);
    expect(res.clashes[0].distanceKind).toBe('mesh');
  });
});

// The clearance rule needs a clearance value; declared here so the fixture above
// stays a plain hard rule.
const CLEARANCE_RULE: ClashRule = { id: 'c', name: 'c', a: '*', b: '*', mode: 'clearance', clearance: 1 };

describe('clearance distance provenance', () => {
  it('is mesh-measured', () => {
    const a = boxEl('A', 'IfcSlab', [0, 0, 0], [1, 1, 1]);
    const b = boxEl('B', 'IfcSlab', [0, 0, 1.5], [1, 1, 2.5]);
    const res = testPair(a, new TriMesh(a.positions!, a.indices!), b, new TriMesh(b.positions!, b.indices!), CLEARANCE_RULE, 0.001);
    expect(res?.status).toBe('clearance');
    expect(res?.distanceKind).toBe('mesh');
  });
});
