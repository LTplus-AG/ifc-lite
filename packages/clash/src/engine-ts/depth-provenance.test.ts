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

/**
 * A rectangular box (half-extents `hx,hy,hz`, centred at `center`), rotated
 * `angle` radians about Z, baked directly into world-space triangle
 * positions — `detectObb` reasons about world-space triangle normals, so
 * this must be a genuinely rotated mesh, not an axis-aligned one carrying a
 * deferred transform.
 */
function rotatedBoxAboutZ(
  key: string,
  tag: string,
  center: Vec3,
  hx: number,
  hy: number,
  hz: number,
  angle: number,
): ClashElement {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const local: Vec3[] = [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
    [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
  ];
  const positions: number[] = [];
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const [x, y, z] of local) {
    const wx = c * x - s * y + center[0];
    const wy = s * x + c * y + center[1];
    const wz = z + center[2];
    positions.push(wx, wy, wz);
    const p: Vec3 = [wx, wy, wz];
    for (let a = 0; a < 3; a += 1) { if (p[a] < min[a]) min[a] = p[a]; if (p[a] > max[a]) max[a] = p[a]; }
  }
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return { key, ref: nextRef++, model: 'm', tag, positions: new Float32Array(positions), indices, bounds: { min, max } };
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

  it('labels a BOX member piercing clean through another box as an AABB estimate, not the inflated MTD', () => {
    // Maintainer review on #2536, reproduced: a 0.4x0.4 duct, 2 m long,
    // straight through the 200 mm thickness of a 5.0 x 0.2 x 3.0 m wall, both
    // boxes, centred. The plain 15-axis box-box MTD picks the wall's thin
    // (Y) axis as the winning separating axis — but along THAT axis the
    // duct's own half-length (1.0 m) dominates the wall's half-thickness
    // (0.1 m), so the "exact" depth comes out 1.1 m: 5.5x the true 0.2 m
    // wall thickness, in the direction of overstating severity, and
    // (before this fix) certified as `'mesh'` — a measurement a coordinator
    // would trust. `main` was honest here: it fell back to the AABB
    // estimate for exactly this "thin member piercing straight through"
    // shape. A through-penetration must not carry the box-exact label even
    // though both operands ARE boxes.
    const wall = boxEl('W', 'IfcWall', [-2.5, -0.1, -1.5], [2.5, 0.1, 1.5]);
    const duct = boxEl('D', 'IfcDuct', [-0.2, -1.0, -0.2], [0.2, 1.0, 0.2]);
    const res = pair(wall, duct);
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('estimate');
    expect(res.distance).toBe(-0.2);
  });

  it('declines the mesh label for the same through-penetration with the duct rotated 15 degrees about Z', () => {
    // Same wall/duct shape and true ~0.2 m overlap as the aligned case above,
    // but the DUCT ALONE is rotated 15 degrees about Z relative to the
    // (still axis-aligned) wall, so `isThroughPenetration`'s `matchAxis`
    // (which requires the two boxes' axes to align up to sign) can no longer
    // find a shared frame between wall and duct axes. Before the per-
    // candidate-axis fix, this fell through to the raw 15-axis MTD unchecked
    // and re-certified the same order-of-magnitude-inflated number as
    // `'mesh'` (measured -1.1177 on our own harness against a true ~0.207 m —
    // the wall's 0.2 m thickness grows slightly once the duct's face is no
    // longer axis-aligned with the measurement axes).
    const angle = (15 * Math.PI) / 180;
    const wall = boxEl('W', 'IfcWall', [-2.5, -0.1, -1.5], [2.5, 0.1, 1.5]);
    const duct = rotatedBoxAboutZ('D', 'IfcDuct', [0, 0, 0], 0.2, 1.0, 0.2, angle);
    const res = pair(wall, duct);
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('estimate');
  });

  it('reports touch, not a mesh/estimate hard clash, when a through-penetration is also below the f32 precision floor', () => {
    // Precedence pin (#2536 rebase over #2594): a pair can simultaneously be
    // a through-penetration (declines the box-exact `'mesh'` label, falls
    // back to the AABB estimate) AND have that estimate at or below the f32
    // precision floor for its coordinate magnitude — the two guards in
    // `testPair` fire on the same result. The floor wins: it is checked
    // BEFORE the through-penetration guard decides `'mesh'` vs `'estimate'`,
    // so this reports `'touch'`, not a `'hard'` clash labelled either way —
    // the number is not measurable at this magnitude regardless of which
    // quantity would have produced it. Same wall/duct through-penetration
    // shape as the aligned case above (true overlap 0.2 m), translated far
    // enough from the origin (1,000,000 units) that `precisionFloor` grows
    // past 0.2 m: floor = extent * 2^-22 ~ 1e6 * 2.384e-7 ~ 0.238 m > 0.2 m.
    const off = 1_000_000;
    const wall = boxEl('W', 'IfcWall', [off - 2.5, -0.1, -1.5], [off + 2.5, 0.1, 1.5]);
    const duct = boxEl('D', 'IfcDuct', [off - 0.2, -1.0, -0.2], [off + 0.2, 1.0, 0.2]);
    const touchRule: ClashRule = { id: 'r', name: 'r', a: '*', b: '*', mode: 'hard', reportTouch: true };
    const res = testPair(
      wall,
      new TriMesh(wall.positions!, wall.indices!),
      duct,
      new TriMesh(duct.positions!, duct.indices!),
      touchRule,
      0.001,
    );
    if (!res) throw new Error('expected a clash');
    expect(res.status).toBe('touch');
    expect(res.distance).toBe(0);
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

  it('reports touch, not a mesh-labelled hard clash, for a coincident-footprint pair below the f32 precision floor', () => {
    // Reviewer's regression (PR #2536 review): the "coincident-footprint
    // stacked box layers" fixture above (true depth 0.04 m) still reports
    // `mesh`/-0.04 no matter how far it sits from the origin, because that
    // branch (surfaces coincide, no triangle crossing, AABB penetration
    // beyond tolerance) builds its `NarrowResult` directly and never checked
    // `precisionFloor` — unlike the crossing branch just above, which does.
    // Translate the SAME shape 1,000,000 units out, where the floor grows to
    // ~0.238 m (> the true 0.04 m depth): this must report `touch`, exactly
    // like the crossing-branch pin above, not `hard`/`mesh`/-0.04.
    const off = 1_000_000;
    const a = boxEl('A', 'IfcSlab', [off, 0, 0], [off + 10, 10, 0.2]);
    const b = boxEl('B', 'IfcSlab', [off, 0, 0.16], [off + 10, 10, 0.41]);
    const touchRule: ClashRule = { id: 'r', name: 'r', a: '*', b: '*', mode: 'hard', reportTouch: true };
    const res = testPair(a, new TriMesh(a.positions!, a.indices!), b, new TriMesh(b.positions!, b.indices!), touchRule, 0.001);
    if (!res) throw new Error('expected a clash');
    expect(res.status).toBe('touch');
    expect(res.distanceKind).toBe('mesh');
    expect(res.distance).toBe(0);
  });

  it('reports touch, not a mesh-labelled hard clash, for an enclosed box pair below the f32 precision floor', () => {
    // Same regression as above, for the "enclosed box layer" branch (one
    // element's AABB wholly inside the other's, no surface crossing at all):
    // it also built its `NarrowResult` directly and never checked
    // `precisionFloor`. Same true depth (0.04 m) and same 1,000,000-unit
    // translation as the fixture above; must report `touch`, not `hard`.
    const off = 1_000_000;
    const a = boxEl('A', 'IfcSlab', [off, 0, 0], [off + 10, 10, 0.04]);
    const b = boxEl('B', 'IfcSlab', [off, 0, 0], [off + 10, 10, 0.25]);
    const touchRule: ClashRule = { id: 'r', name: 'r', a: '*', b: '*', mode: 'hard', reportTouch: true };
    const res = testPair(a, new TriMesh(a.positions!, a.indices!), b, new TriMesh(b.positions!, b.indices!), touchRule, 0.001);
    if (!res) throw new Error('expected a clash');
    expect(res.status).toBe('touch');
    expect(res.distanceKind).toBe('mesh');
    expect(res.distance).toBe(0);
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
