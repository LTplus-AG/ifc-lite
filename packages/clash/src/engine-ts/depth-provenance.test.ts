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
 * Zero-volume flat sheet at `y = y0`: a rectangle spanning `x0..x1` x `z0..z1`
 * meshed as two triangles, with a zero-thickness AABB. This is the shape a
 * degenerate IfcExtrudedAreaSolid meshes to when its extrusion direction lies
 * IN the profile plane (invalid per IFC4 WR31, but nothing upstream rejects
 * it) - the exact fixture bug behind the `ifc-lite clash --matrix` "real
 * clash reported" CLI test, whose "pipe" was such a ribbon buried at its
 * beam's mid-plane.
 */
function sheetEl(key: string, tag: string, x0: number, x1: number, y0: number, z0: number, z1: number): ClashElement {
  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1,
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return {
    key,
    ref: nextRef++,
    model: 'm',
    tag,
    positions,
    indices,
    bounds: { min: [x0, y0, z0], max: [x1, y0, z1] },
  };
}

/**
 * A rectangular box (half-extents `h`, centred at `center`) under a FULL
 * three-axis rotation (`rz`,`ry`,`rx`, applied as Rz*Ry*Rx), baked into
 * world-space triangle positions. {@link rotatedBoxAboutZ} only yaws, so two
 * boxes built with it always share the world Z axis; this one lets a fixture
 * put a pair at a GENUINE MUTUAL rotation, with no axis shared between them.
 */
function rotatedBoxXyz(
  key: string,
  tag: string,
  center: Vec3,
  h: Vec3,
  rz: number,
  ry: number,
  rx: number,
): ClashElement {
  const cz = Math.cos(rz), sz = Math.sin(rz);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const m = [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
  const local: Vec3[] = [
    [-h[0], -h[1], -h[2]], [h[0], -h[1], -h[2]], [h[0], h[1], -h[2]], [-h[0], h[1], -h[2]],
    [-h[0], -h[1], h[2]], [h[0], -h[1], h[2]], [h[0], h[1], h[2]], [-h[0], h[1], h[2]],
  ];
  const positions: number[] = [];
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of local) {
    const w: Vec3 = [
      m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2] + center[0],
      m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2] + center[1],
      m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2] + center[2],
    ];
    positions.push(w[0], w[1], w[2]);
    for (let a = 0; a < 3; a += 1) { if (w[a] < min[a]) min[a] = w[a]; if (w[a] > max[a]) max[a] = w[a]; }
  }
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return { key, ref: nextRef++, model: 'm', tag, positions: new Float32Array(positions), indices, bounds: { min, max } };
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

/**
 * Non-box "tub": a 10 x 10 x 1 block with an open-top recess [1,9]x[1,9]
 * from z = 0.875 up. The recess floor (z = 0.875) is a solid surface that
 * sits INSIDE the element's own AABB, so another element can cross it while
 * staying AABB-contained — the shape class behind the eight Infra-Bridge
 * pairs (an arch segment flush inside a spandrel wall's AABB). `detectObb`
 * declines it: the z-normal family has three offset planes (0, 0.875, 1).
 */
function tubEl(key: string, tag: string): ClashElement {
  const positions = new Float32Array([
    // 0-3: outer bottom (z=0)
    0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0,
    // 4-7: outer top (z=1)
    0, 0, 1, 10, 0, 1, 10, 10, 1, 0, 10, 1,
    // 8-11: recess rim (z=1)
    1, 1, 1, 9, 1, 1, 9, 9, 1, 1, 9, 1,
    // 12-15: recess floor (z=0.875)
    1, 1, 0.875, 9, 1, 0.875, 9, 9, 0.875, 1, 9, 0.875,
  ]);
  const indices = new Uint32Array([
    // bottom
    0, 2, 1, 0, 3, 2,
    // outer walls
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
    // rim annulus (z=1, between outer 4-7 and inner 8-11)
    4, 5, 9, 4, 9, 8, 5, 6, 10, 5, 10, 9, 6, 7, 11, 6, 11, 10, 7, 4, 8, 7, 8, 11,
    // recess walls (rim 8-11 down to floor 12-15)
    8, 9, 13, 8, 13, 12, 9, 10, 14, 9, 14, 13, 10, 11, 15, 10, 15, 14, 11, 8, 12, 11, 12, 15,
    // recess floor
    12, 14, 13, 12, 15, 14,
  ]);
  return { key, ref: nextRef++, model: 'm', tag, positions, indices, bounds: { min: [0, 0, 0], max: [10, 10, 1] } };
}

/**
 * Plate [2,8]x[2,8] from z = 0.4 up through the tub's recess-floor plane
 * (z = 0.875), with its side faces split into two bands at `zMid` so the
 * CROSSING triangles' vertices sit at `zMid` / `zTop` — the fine-tessellation
 * shape that makes the crossing-vertex evidence track the actual flushness
 * of the contact instead of the plate's own extent.
 */
function bandedPlateEl(key: string, tag: string, zMid: number, zTop: number): ClashElement {
  const ring = (z: number) => [2, 2, z, 8, 2, z, 8, 8, z, 2, 8, z];
  const positions = new Float32Array([...ring(0.4), ...ring(zMid), ...ring(zTop)]);
  const quads: number[] = [];
  for (let band = 0; band < 2; band += 1) {
    const lo = band * 4;
    const hi = lo + 4;
    for (let k = 0; k < 4; k += 1) {
      const a = lo + k;
      const b = lo + ((k + 1) % 4);
      quads.push(a, b, hi + ((k + 1) % 4), a, hi + ((k + 1) % 4), hi + k);
    }
  }
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom
    8, 9, 10, 8, 10, 11, // top
    ...quads,
  ]);
  return {
    key,
    ref: nextRef++,
    model: 'm',
    tag,
    positions,
    indices,
    bounds: { min: [2, 2, 0.4], max: [8, 8, zTop] },
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

  it('labels two walls crossing at an X-junction as an estimate, not the full wall height', () => {
    // Reviewer regression on #2536: the two most ordinary elements in any
    // building model, crossing. Two 200 mm walls, both 3 m tall, meeting at
    // an X — each pierces the other clean through in thickness. The shared
    // volume is a 0.2 x 0.2 x 3 m column, so 0.2 m is the honest depth, and
    // that is what `main` reported. The box-box MTD is 3.0 (the shared
    // height axis is the cheapest separating translation), and the through-
    // penetration guard used to MISS this pair because it required the
    // piercing cross-section to be STRICTLY inside the other's: the height
    // axis TIES, so `rQ - margin` rejected it and the raw 3.0 was certified
    // `'mesh'` — reaching the user through `triage.ts` as "penetration
    // 3.000 m", no `~`, no "(AABB estimate)" qualifier.
    const res = pair(
      boxEl('A', 'IfcWall', [-5, -0.1, 0], [5, 0.1, 3]),
      boxEl('B', 'IfcWall', [-0.1, -5, 0], [0.1, 5, 3]),
    );
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('estimate');
    expect(res.distance).toBe(-0.2);
  });

  it('labels an X-junction of walls of DIFFERENT heights as an estimate too', () => {
    // The tie is not what makes the pair a through-penetration, so breaking
    // it must not bring the inflated number back: a 3 m wall crossing a
    // 2.5 m one reported -2.5 `'mesh'` (the shorter wall's full height)
    // under the strict form. The shared volume is still 0.2 x 0.2 x 2.5 m,
    // so 0.2 m is still the honest depth.
    const res = pair(
      boxEl('A', 'IfcWall', [-5, -0.1, 0], [5, 0.1, 3]),
      boxEl('B', 'IfcWall', [-0.1, -5, 0], [0.1, 5, 2.5]),
    );
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('estimate');
    expect(res.distance).toBe(-0.2);
  });

  it('labels the same X-junction as an estimate under a generic world rotation', () => {
    // The X-junction above is axis-aligned, so on its own it cannot tell a
    // genuine fix from one that happens to hold in the world frame (#2573
    // landed exactly that class of bug on the neighbouring gate). The same
    // pair rigidly rotated as a WHOLE by a generic three-axis rotation is
    // the identical geometry in a different frame and must reach the same
    // verdict. This one is a GUARD, not a reproduction: it also passed under
    // the strict form, because rotating the mesh puts the vertices off the
    // f32 grid and the resulting jitter in the recovered axes already breaks
    // the height tie. That is the measured shape of the defect — it bites
    // exactly on the exactly-representable axis-aligned geometry that real
    // wall exports are made of, which is why it survived every rotated
    // fixture in this file. The reported NUMBER here is the world-axis AABB
    // estimate, which a generic rotation inflates; the label, not the
    // magnitude, is what this pins.
    const res = pair(
      rotatedBoxXyz('A', 'IfcWall', [0, 0, 0], [5, 0.1, 1.5], 0.7, 0.4, 1.1),
      rotatedBoxXyz('B', 'IfcWall', [0, 0, 0], [0.1, 5, 1.5], 0.7, 0.4, 1.1),
    );
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('estimate');
  });

  it('labels an X-junction whose walls are at a generic MUTUAL rotation as an estimate', () => {
    // Reviewer's stated gap on the fix: every other rotated fixture here
    // turns ONE box (`rotatedBoxAboutZ`), so the pair always still shares
    // the world Z axis and the relaxation is unproven where the two boxes
    // share no axis at all. Here each wall carries its own three-axis
    // rotation, so no axis of one is parallel to any axis of the other.
    const res = pair(
      rotatedBoxXyz('A', 'IfcWall', [0, 0, 0], [5, 0.1, 1.5], 0.7, 0.4, 1.1),
      rotatedBoxXyz('B', 'IfcWall', [0, 0, 0], [0.1, 5, 1.5], 0.76, 0.48, 1.2),
    );
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('estimate');
  });

  it('keeps the mesh label for a plain corner overlap at a generic MUTUAL rotation', () => {
    // The other half of the same gap: relaxing the containment test to admit
    // touching edges must not start DEMOTING genuinely measurable pairs to
    // estimates. Two unit blocks overlapping at a corner, each under its own
    // three-axis rotation (again no shared axis), are a plain partial
    // overlap — neither cross-section is anywhere near inside the other's —
    // so the box-exact MTD stays certified.
    const res = pair(
      rotatedBoxXyz('A', 'IfcSlab', [0, 0, 0], [1, 1, 1], 0.3, 0.2, 0.9),
      rotatedBoxXyz('B', 'IfcSlab', [1.2, 1.2, 1.2], [1, 1, 1], 1.7, 0.8, 2.3),
    );
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('mesh');
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

  it('reports a fully-enclosed non-box solid as hard at the AABB estimate', () => {
    // A real solid buried wholly inside another with NO surface contact at
    // all (a pipe run inside a beam, equipment inside a slab): the enclosed-
    // solid branch, with an inner shape `detectObb` declines, so the depth
    // falls back to the smallest overlapping AABB dimension - an estimate.
    // The estimate (0.25 m) is ~5 orders of magnitude above the f32 noise
    // floor here, so the floor gate must NOT touch it: this is the CLI
    // matrix regression fixture's shape at unit level, pinning that the
    // floor only suppresses depths that measure nothing, never a genuinely
    // buried solid. All coordinates are exactly representable in f32, so the
    // distance pin is exact.
    const res = pair(
      prismEl('A', 'IfcPipeSegment', [1.875, 0.375], [2.125, 0.375], [2, 0.625], 0.25, 0.75),
      boxEl('B', 'IfcBeam', [0, 0, 0], [4, 1, 1]),
    );
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('estimate');
    expect(res.distance).toBe(-0.25);
  });

  it('reports touch, not hard, for a zero-volume sheet buried inside a solid', () => {
    // The degenerate twin of the enclosed-solid pin above: the buried element
    // is a zero-volume sheet, so its AABB overlap is exactly zero in the
    // sheet-normal axis and there is nothing to measure - 0 is at the f32
    // floor by definition. `main` reported every enclosed element as `hard`
    // (distance = the AABB signed gap, here exactly 0) no matter the depth;
    // the CLI matrix "real clash reported" test rode on that, its "pipe"
    // being exactly such a ribbon (see `sheetEl`). The floor now classifies
    // it as `touch` - a zero-volume solid displaces nothing - which a rule
    // without `reportTouch` then drops entirely.
    const sheet = sheetEl('A', 'IfcPipeSegment', 1, 3, 0.5, 0.25, 0.75);
    const box = boxEl('B', 'IfcBeam', [0, 0, 0], [4, 1, 1]);
    const touchRule: ClashRule = { id: 'r', name: 'r', a: '*', b: '*', mode: 'hard', reportTouch: true };
    const res = testPair(sheet, new TriMesh(sheet.positions!, sheet.indices!), box, new TriMesh(box.positions!, box.indices!), touchRule, 0.001);
    if (!res) throw new Error('expected a touch result');
    expect(res.status).toBe('touch');
    expect(res.distance).toBe(0);
    // Without reportTouch the pair is suppressed outright, not downgraded.
    const hardOnly: ClashRule = { id: 'r', name: 'r', a: '*', b: '*', mode: 'hard' };
    expect(testPair(sheet, new TriMesh(sheet.positions!, sheet.indices!), box, new TriMesh(box.positions!, box.indices!), hardOnly, 0.001)).toBeNull();
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

  it('reports touch, not hard, for a crossing whose MTD lands exactly ON the f32 precision floor (depth.ts:195)', () => {
    // `depthClashResult` gates on `floorDepth <= precisionFloor(...)`, but no
    // existing fixture strikes that boundary bit-exactly: the touch/hard
    // pair above sit a decade below and (via the "genuine crossing" pin in
    // the paired hard-clash tests) well above it. This one is solved
    // algebraically to land the z-axis MTD exactly ON `precisionFloor`'s
    // returned value, so `<=` and a mutated `<` disagree on this fixture and
    // only this fixture (a "close enough" gap would pass under both). Ported
    // 1:1 from the Rust pin (`rust/clash/src/kernel_tests.rs`,
    // `overlap_exactly_at_the_precision_floor_is_touch_not_hard`) so both
    // kernels carry the same boundary.
    //
    // Two boxes crossing at right angles (A long in x, B long in y — a
    // genuine transversal crossing of their side faces, unlike two boxes
    // merely STACKED with identical x/y footprints, whose side faces are
    // parallel and never register as a triangle "crossing" at all, routing
    // the pair through a branch that never calls `precisionFloor`), thin
    // (half 0.25) and separated by a tiny gap on z.
    //
    // Derivation: `precisionFloor` returns `extent * F32_ULP_SCALE` where
    // `extent` is the max abs coordinate over both elements' bounds and
    // `F32_ULP_SCALE = 2^-22`. Pin `extent` to a power of two via A's x-axis
    // (A spans x = [32, 64], the dominant coordinate over both boxes since B
    // is thin in x and short in z):
    //   floor = 64.0 * 2^-22 = 2^-16 = 0.0000152587890625
    // Both bars are 0.5 thick on z with A centred at z=60.0; B is shifted so
    // the z overlap (A.max_z - B.min_z — the SAT minimum axis, since the x/y
    // overlaps are 16.25 each, far larger) equals `floor` exactly:
    //   B.center_z = A.center_z + 2*halfZ - floor
    //              = 60.0 + 0.5 - 0.0000152587890625 = 60.4999847412109375
    // This literal is exactly representable in f32 (60.5 minus an exact
    // multiple — 4 — of f32's ULP at that magnitude, 2^-18): `boxEl` stores
    // vertex positions in a `Float32Array`, so it round-trips bit-for-bit,
    // and `bounds` is passed as the same literal directly (no arithmetic),
    // matching the Rust fixture's AABB exactly. Verified independently
    // against JS's own f32 rounding (`Math.fround`) and against the SAT
    // formula (`rA + rB - dist`) before trusting this fixture.
    const bZ = 60.499_984_741_210_938; // = Math.fround(60.5 - 2 ** -16), bit-exact
    expect(Math.fround(bZ)).toBe(bZ);
    const floor = 64.0 / 4_194_304; // extent(64) * F32_ULP_SCALE
    expect(floor).toBe(0.0000152587890625);
    expect(60.25 - (bZ - 0.25)).toBe(floor); // A.max_z - B.min_z === floor, bit-exact

    const a = boxEl('A', 'IfcBeam', [32, -0.25, 59.75], [64, 0.25, 60.25]);
    const b = boxEl('B', 'IfcBeam', [47.75, -16, bZ - 0.25], [48.25, 16, bZ + 0.25]);
    const hardOnly: ClashRule = { id: 'r', name: 'r', a: '*', b: '*', mode: 'hard' };
    const hardRes = testPair(a, new TriMesh(a.positions!, a.indices!), b, new TriMesh(b.positions!, b.indices!), hardOnly, 0.001);
    expect(hardRes).toBeNull();

    const touchRule: ClashRule = { id: 'r', name: 'r', a: '*', b: '*', mode: 'hard', reportTouch: true };
    const touchRes = testPair(a, new TriMesh(a.positions!, a.indices!), b, new TriMesh(b.positions!, b.indices!), touchRule, 0.001);
    if (!touchRes) throw new Error('expected the boundary touch to report');
    expect(touchRes.status).toBe('touch');
    expect(touchRes.distance).toBe(0);
  });

  it('reports touch for a CONTAINED non-box pair whose crossing is flush at f32 noise scale, even though its AABB estimate is above the floor', () => {
    // The eight Infra-Bridge pairs (#2536 rebase decision — THE FLOOR WINS):
    // an element authored FLUSH against a surface inside another element's
    // AABB. The crossing exists (f32 rounding pushes the surfaces through
    // each other by ~1 ULP), but every crossing vertex sits within f32 noise
    // of the other surface — while the AABB estimate, the number the depth
    // rework would report for this non-box contained pair, is the contained
    // element's own extent (~0.475 m here, 4.084 m on the bridge), far above
    // the floor. Floor-testing only the reported estimate promotes the pair
    // to `hard` at a number that measures nothing; the crossing-vertex
    // evidence (`crossingVertexPenetration`) must gate it back to `touch`.
    // Plate side-band vertices at 0.875 - 6e-8 / 0.875 + 1.2e-7 straddle the
    // tub's recess floor (z = 0.875) by ~1-2 f32 ULP; floor here is
    // 10 * 2^-22 ~ 2.4e-6, three orders above the ~6e-8 evidence.
    const tub = tubEl('T', 'IfcWall');
    const plate = bandedPlateEl('P', 'IfcMember', 0.875 - 6e-8, 0.875 + 1.2e-7);
    const touchRule: ClashRule = { id: 'r', name: 'r', a: '*', b: '*', mode: 'hard', reportTouch: true };
    const res = testPair(tub, new TriMesh(tub.positions!, tub.indices!), plate, new TriMesh(plate.positions!, plate.indices!), touchRule, 0.001);
    if (!res) throw new Error('expected a clash');
    expect(res.status).toBe('touch');
    expect(res.distance).toBe(0);
  });

  it('keeps a CONTAINED non-box pair hard when its crossing vertices measure a real, above-floor depth', () => {
    // Discriminating companion to the flush pin above: the same tub/plate
    // shape with the plate genuinely 10 mm through the recess floor. The
    // crossing-vertex evidence (~0.01 m) clears the floor, so the gate must
    // NOT suppress it — the pair stays `hard`, reported at the AABB estimate
    // with the honest `estimate` label (non-box pair, no certified depth).
    const tub = tubEl('T', 'IfcWall');
    const plate = bandedPlateEl('P', 'IfcMember', 0.865, 0.885);
    const res = pair(tub, plate);
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('estimate');
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
