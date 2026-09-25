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
import { crossingVertexPenetration, depthClashResult, type BoxPenetration, type VertexPenetration } from './depth.js';
import { depthFloor, estimateFloor, signedGap } from '../math/aabb.js';
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

/** The AABB estimate `-signedGap` of two elements and its precision floor,
 *  as `depthClashResult` sees them. */
function estimateAndFloor(a: ClashElement, b: ClashElement): [number, number] {
  return [-signedGap(a.bounds, b.bounds), estimateFloor(a.bounds, b.bounds)];
}

/** An element that is only its bounds (for `depthClashResult` unit tests). */
function boundsEl(min: Vec3, max: Vec3): ClashElement {
  return { key: 'k', ref: nextRef++, model: 'm', tag: 'IfcSlab', positions: new Float32Array(), indices: new Uint32Array(), bounds: { min, max } };
}

const TOUCH_RULE: ClashRule = { id: 'r', name: 'r', a: '*', b: '*', mode: 'hard', reportTouch: true };

function nextUp(x: number): number {
  const f = new Float64Array([x]);
  const u = new BigUint64Array(f.buffer);
  u[0] = u[0]! + 1n;
  return f[0]!;
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
    // precision floor — the two guards in `testPair` fire on the same
    // result. The floor wins: it is checked BEFORE the through-penetration
    // guard decides `'mesh'` vs `'estimate'`, so this reports `'touch'`, not
    // a `'hard'` clash labelled either way. Same wall/duct shape as the
    // aligned case above: the duct pierces the wall along Y, so the estimate
    // (the wall's 0.2 m thickness) is measured along Y and its floor is the
    // Y noise (#5405). The pair sits 1,500,000 out along Y, where that floor
    // (~0.36 m) is above 0.2 m. Until #5405 this pin translated along X and
    // relied on the X magnitude inflating a floor it has nothing to do with
    // — see the companion below. Mirrors the Rust pin in `tests.rs`.
    const off = 1_500_000;
    const wall = boxEl('W', 'IfcWall', [-2.5, off - 0.1, -1.5], [2.5, off + 0.1, 1.5]);
    const duct = boxEl('D', 'IfcDuct', [-0.2, off - 1.0, -0.2], [0.2, off + 1.0, 0.2]);
    const [estimate, floor] = estimateAndFloor(wall, duct);
    expect(estimate, 'fixture premise: the estimate is within its Y floor').toBeLessThanOrEqual(floor);
    const touchRule: ClashRule = { id: 'r', name: 'r', a: '*', b: '*', mode: 'hard', reportTouch: true };
    const res = testPair(wall, new TriMesh(wall.positions!, wall.indices!), duct, new TriMesh(duct.positions!, duct.indices!), touchRule, 0.001);
    if (!res) throw new Error('expected a clash');
    expect(res.status).toBe('touch');
    expect(res.distance).toBe(0);
  });

  it('still reports a through-penetration far out on an ORTHOGONAL axis as hard (#5405)', () => {
    // The old pin's placement, 1,000,000 out along X. X is orthogonal to the
    // Y-direction depth; the old max-over-all-axes floor (~0.24 m, from X)
    // swallowed the 0.2 m through-penetration here.
    const off = 1_000_000;
    const wall = boxEl('W', 'IfcWall', [off - 2.5, -0.1, -1.5], [off + 2.5, 0.1, 1.5]);
    const duct = boxEl('D', 'IfcDuct', [off - 0.2, -1.0, -0.2], [off + 0.2, 1.0, 0.2]);
    const res = pair(wall, duct);
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('estimate');
    expect(res.distance).toBeCloseTo(-0.2, 6);
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
    // stacked box layers" branch (surfaces coincide, no triangle crossing,
    // AABB penetration beyond tolerance) built its `NarrowResult` directly
    // and never checked the precision floor — unlike the crossing branch
    // just above, which does. Same shape as the fixture above (0.04 m along
    // Z), placed 250,000 out along Z, where the Z floor (~0.06 m) is above
    // the depth: must report `touch`, not `hard`/`mesh`/-0.04. Until #5405
    // this translated along X instead (see the companion below).
    const off = 250_000;
    const a = boxEl('A', 'IfcSlab', [0, 0, off], [10, 10, off + 0.2]);
    const b = boxEl('B', 'IfcSlab', [0, 0, off + 0.16], [10, 10, off + 0.41]);
    const [estimate, floor] = estimateAndFloor(a, b);
    expect(estimate, 'fixture premise: the depth is within its Z floor').toBeLessThanOrEqual(floor);
    const touchRule: ClashRule = { id: 'r', name: 'r', a: '*', b: '*', mode: 'hard', reportTouch: true };
    const res = testPair(a, new TriMesh(a.positions!, a.indices!), b, new TriMesh(b.positions!, b.indices!), touchRule, 0.001);
    if (!res) throw new Error('expected a clash');
    expect(res.status).toBe('touch');
    expect(res.distanceKind).toBe('mesh');
    expect(res.distance).toBe(0);
  });

  it('still reports a coincident-footprint pair far out on an ORTHOGONAL axis as hard (#5405)', () => {
    // The old pin's placement, 1,000,000 out along X: a genuine 0.04 m
    // Z-overlap whose Z coordinates are small and precise.
    const off = 1_000_000;
    const a = boxEl('A', 'IfcSlab', [off, 0, 0], [off + 10, 10, 0.2]);
    const b = boxEl('B', 'IfcSlab', [off, 0, 0.16], [off + 10, 10, 0.41]);
    const res = pair(a, b);
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('mesh');
    expect(res.distance).toBeCloseTo(-0.04, 6);
  });

  it('reports touch, not a mesh-labelled hard clash, for an enclosed box pair below the f32 precision floor', () => {
    // Same regression as above, for the "enclosed box layer" branch (one
    // element's AABB wholly inside the other's, no surface crossing at all):
    // it also built its `NarrowResult` directly and never checked the floor.
    // Same 0.04 m along Z and same 250,000-along-Z placement; must report
    // `touch`, not `hard`.
    const off = 250_000;
    const a = boxEl('A', 'IfcSlab', [0, 0, off], [10, 10, off + 0.04]);
    const b = boxEl('B', 'IfcSlab', [0, 0, off], [10, 10, off + 0.25]);
    const [estimate, floor] = estimateAndFloor(a, b);
    expect(estimate, 'fixture premise: the depth is within its Z floor').toBeLessThanOrEqual(floor);
    const touchRule: ClashRule = { id: 'r', name: 'r', a: '*', b: '*', mode: 'hard', reportTouch: true };
    const res = testPair(a, new TriMesh(a.positions!, a.indices!), b, new TriMesh(b.positions!, b.indices!), touchRule, 0.001);
    if (!res) throw new Error('expected a clash');
    expect(res.status).toBe('touch');
    expect(res.distanceKind).toBe('mesh');
    expect(res.distance).toBe(0);
  });

  it('still reports an enclosed box pair far out on an ORTHOGONAL axis as hard (#5405)', () => {
    const off = 1_000_000;
    const a = boxEl('A', 'IfcSlab', [off, 0, 0], [off + 10, 10, 0.04]);
    const b = boxEl('B', 'IfcSlab', [off, 0, 0], [off + 10, 10, 0.25]);
    const res = pair(a, b);
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('mesh');
    expect(res.distance).toBeCloseTo(-0.04, 6);
  });

  it('carries the direction a crossing-vertex penetration was measured along (#5405)', () => {
    // Mirrors `crossing_vertex_evidence_carries_the_direction_it_was_measured_along_5405`:
    // a 1 m cube dipping 10 mm into the top of a slab.
    const slab = boxEl('S', 'IfcSlab', [-5, -5, -0.5], [5, 5, 0.5]);
    const cube = boxEl('C', 'IfcColumn', [-0.5, -0.5, 0.49], [0.5, 0.5, 1.49]);
    const cm = new TriMesh(cube.positions!, cube.indices!);
    const e = crossingVertexPenetration(cm, new TriMesh(slab.positions!, slab.indices!), new Uint8Array(cm.count).fill(1));
    if (!e) throw new Error('expected vertices inside');
    expect(e.depth).toBeCloseTo(0.01, 6);
    expect(Math.abs(e.axis[0])).toBeLessThan(1e-6);
    expect(Math.abs(e.axis[1])).toBeLessThan(1e-6);
    expect(Math.abs(e.axis[2])).toBeCloseTo(1, 9);
  });

  it('reports on a hard result the floor of the depth it reports (#5639)', () => {
    // Mirrors `a_hard_result_reports_the_floor_of_the_depth_it_reports_5639`.
    const a = boundsEl([9_999, -1, 63], [10_001, 1, 64]);
    const b = boundsEl([9_999.5, -0.5, 63.5], [10_000.5, 0.5, 64]);
    const x: Vec3 = [1, 0, 0];
    const xFloor = depthFloor(x, a.bounds, b.bounds);
    const estFloor = estimateFloor(a.bounds, b.bounds);
    expect(xFloor, 'fixture premise').toBeGreaterThan(100 * estFloor);
    const hard = (box: BoxPenetration | null, estimate: number) => {
      const r = depthClashResult(box, estimate, null, a, b, TOUCH_RULE, [0, 0, 0], a.bounds)!;
      expect(r.status).toBe('hard');
      return [r.distance, r.depthFloor];
    };
    expect(hard({ mtd: 0.1, axis: x, through: false }, 0.5)).toEqual([-0.1, xFloor]);
    // A through-penetration reports the estimate, capped by the MTD (#5742):
    // the capped depth is the MTD, so it carries the MTD's floor.
    expect(hard({ mtd: 0.1, axis: x, through: true }, 0.5)).toEqual([-0.1, xFloor]);
    expect(hard({ mtd: 0.9, axis: x, through: true }, 0.5)).toEqual([-0.5, estFloor]);
    expect(hard(null, 0.5)).toEqual([-0.5, estFloor]);
  });

  it('never reports a through-penetration deeper than its MTD, and keeps the estimate label (#5742)', () => {
    // Mirrors `a_through_penetration_is_capped_by_its_mtd_and_stays_an_estimate_5742`.
    // The #5742 tie: a member overlapping a 26 mm plate by 26 mm pokes out of
    // the far face by microns, so `through` is decided by f32 noise per
    // placement. The partial side reported the certified 0.026 MTD, the
    // through side the rotated boxes' 0.786 AABB estimate: a 30x swing.
    // Capping by the MTD makes both sides report 0.026.
    const a = boundsEl([-1, -1, -1], [1, 1, 1]);
    const b = boundsEl([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]);
    const x: Vec3 = [1, 0, 0];
    const at = (through: boolean) =>
      depthClashResult({ mtd: 0.026078, axis: x, through }, 0.78598, null, a, b, TOUCH_RULE, [0, 0, 0], a.bounds)!;
    expect(at(false)).toMatchObject({ status: 'hard', distance: -0.026078, distanceKind: 'mesh' });
    expect(at(true)).toMatchObject({ status: 'hard', distance: -0.026078, distanceKind: 'estimate' });
  });

  it('pins the floor boundary per candidate, each on its own direction (#5405)', () => {
    // The boundary is inclusive (`<=`) for each of the three candidates, and
    // each is judged against the floor OF ITS OWN DIRECTION. Both boxes sit
    // 10,000 out along X and reach Z = 64, and their own sizes are 2 and 1, so
    // the Z noise is exactly (64 + 2 + 1) * 2^-22 (position + size, see
    // `BoxNoise`) while the X noise is ~150x larger. The old session-level pin reached
    // this boundary through a crossing whose floor came from the X extent;
    // projected onto Z the floor coincides with the tri-tri contact band
    // (#5406, same rule), so such a crossing is contact before it gets
    // here, and the boundary is pinned where it lives. Mirrors
    // `a_depth_exactly_at_its_own_directions_floor_is_touch_and_one_ulp_above_is_hard_5405`.
    const a = boundsEl([9_999, -1, 63], [10_001, 1, 64]);
    const b = boundsEl([9_999.5, -0.5, 63.5], [10_000.5, 0.5, 64]);
    const zFloor = 67 / 4_194_304;
    const z: Vec3 = [0, 0, 1];
    const x: Vec3 = [1, 0, 0];
    const touch = (box: BoxPenetration | null, estimate: number, ev: VertexPenetration | null): boolean =>
      depthClashResult(box, estimate, ev, a, b, TOUCH_RULE, [0, 0, 0], a.bounds)!.status === 'touch';
    expect(touch({ mtd: zFloor, axis: z, through: false }, 0.5, null)).toBe(true);
    expect(touch({ mtd: nextUp(zFloor), axis: z, through: false }, 0.5, null)).toBe(false);
    expect(touch(null, 0.5, { depth: zFloor, axis: z })).toBe(true);
    expect(touch(null, 0.5, { depth: nextUp(zFloor), axis: z })).toBe(false);
    expect(touch({ mtd: 1e-3, axis: x, through: false }, 0.5, null), '1 mm along X, 10 km out in X').toBe(true);
    expect(touch({ mtd: 1e-3, axis: z, through: false }, 0.5, null), '1 mm along Z, 10 km out in X').toBe(false);

    // The AABB estimate on the axis it measures: C overlaps A by exactly
    // (65 + 2 + 2) * 2^-22 on Z, the Z noise once Z reaches 65 with both
    // elements 2 across.
    const d = 69 / 4_194_304;
    const c = boundsEl([9_999, -0.5, 64 - d], [10_001, 0.5, 65]);
    const est = -signedGap(a.bounds, c.bounds);
    expect(est).toBe(d);
    expect(estimateFloor(a.bounds, c.bounds)).toBe(d);
    expect(depthClashResult(null, est, null, a, c, TOUCH_RULE, [0, 0, 0], a.bounds)!.status).toBe('touch');
    expect(depthClashResult(null, nextUp(est), null, a, c, TOUCH_RULE, [0, 0, 0], a.bounds)!.status).toBe('hard');
  });

  it('does not flip a buried plate flush with a recess floor on which side the f32 ULP fell (#5406)', () => {
    // The tub/plate shape of the eight Infra-Bridge pairs (#2536): a plate
    // whose body sits INSIDE the tub's solid (z 0.4 up to the recess floor
    // at z = 0.875), top authored flush with that floor. Where f32 rounding
    // put the plate's top relative to the floor is noise, and it used to
    // decide the verdict: straddling the floor by 1-2 ULP it read as a
    // crossing, and the crossing-vertex evidence gated it to `touch`; one ULP
    // BELOW, or bit-identically ON the floor, there was no crossing, so the
    // enclosed-solid test found the plate buried and reported `hard` at the
    // 0.475 m estimate. Measured on main before #5406: touch / hard / hard.
    //
    // #5406 makes the three placements one case: the predicate reads a
    // crossing within f32 noise as contact, so none of them crosses, and all
    // three report what the geometry is — a plate buried in the tub (its
    // vertices are 0.475 m inside it), labelled `estimate` because the tub is
    // not a box. Mirrors `a_buried_plate_flush_with_a_recess_floor_does_not_
    // flip_on_which_side_the_ulp_fell_5406` in `rust/clash/src/tests.rs`.
    const oneUlpBelow = (() => {
      const f = new Float32Array([0.875]);
      new Uint32Array(f.buffer)[0] -= 1;
      return f[0]!;
    })();
    const placements: Array<[string, number]> = [
      ['straddling by 1-2 ULP', 0.875 + 1.2e-7],
      ['bit-identically on the floor', 0.875],
      ['one ULP below', oneUlpBelow],
    ];
    const touchRule: ClashRule = { id: 'r', name: 'r', a: '*', b: '*', mode: 'hard', reportTouch: true };
    for (const [label, zTop] of placements) {
      const tub = tubEl('T', 'IfcWall');
      const plate = bandedPlateEl('P', 'IfcMember', 0.875 - 6e-8, zTop);
      const res = testPair(tub, new TriMesh(tub.positions!, tub.indices!), plate, new TriMesh(plate.positions!, plate.indices!), touchRule, 0.001);
      if (!res) throw new Error(`${label}: expected a clash`);
      expect(res.status, label).toBe('hard');
      expect(res.distanceKind, label).toBe('estimate');
      expect(res.distance, label).toBeCloseTo(-0.475, 6);
    }
  });

  it('keeps a CONTAINED non-box pair hard when its crossing vertices measure a real, above-floor depth', () => {
    // Companion to the buried-plate test above: the same tub/plate shape
    // with the plate genuinely 10 mm through the recess floor, far above the
    // f32 noise, so it DOES cross (the flush placements above do not). The
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

/**
 * #5717. Twin of `rust/clash/src/tests.rs`
 * (`a_shared_face_does_not_veto_a_genuine_overlap_5717`). Same fixture, same
 * expectations, so the two kernels stay pinned together.
 */
describe('#5717: a shared face must not veto a certified overlap', () => {
  const PEN = 0.02;

  /** A box rotated about Z, baked through f32 exactly as ingest would. */
  function rotatedBoxEl(key: string, cx: number, cy: number, h: Vec3, rot: number): ClashElement {
    const c = Math.fround(Math.cos(rot));
    const s = Math.fround(Math.sin(rot));
    const corners: Vec3[] = [
      [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
      [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
    ].map(([sx, sy, sz]) => [sx * h[0], sy * h[1], sz * h[2]] as Vec3);
    const positions = new Float32Array(24);
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    corners.forEach(([x, y, z], i) => {
      const w: Vec3 = [
        Math.fround(c * x - s * y + cx),
        Math.fround(s * x + c * y + cy),
        Math.fround(z),
      ];
      for (let k = 0; k < 3; k += 1) {
        positions[i * 3 + k] = w[k];
        min[k] = Math.min(min[k], w[k]);
        max[k] = Math.max(max[k], w[k]);
      }
    });
    const indices = new Uint32Array([
      0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 5, 1, 0, 4, 5,
      3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
    ]);
    return { key, ref: nextRef++, model: 'm', tag: 'IfcWall', positions, indices, bounds: { min, max } };
  }

  const rule: ClashRule = { id: 'r', name: 'r', a: '*', mode: 'hard', tolerance: 0.001, reportTouch: true };

  // A panel and mullion authored to the same height are flush on their tops
  // and bottoms while overlapping laterally. Rotated off the world axes, the
  // mullion's top corners bake a noise-width inside the panel's top face;
  // `crossingVertexPenetration` reported that as a ~0 penetration, which sat
  // below its floor and took the pair to `touch` — discarding a 20 mm
  // overlap the exact box MTD had already measured.
  for (const rot of [0, 0.1, 0.3, 0.4, Math.PI / 4]) {
    it(`reports a 20 mm overlap as hard at rotation ${rot.toFixed(3)}`, async () => {
      const engine = createClashEngine({ backend: 'ts' });
      const c = Math.fround(Math.cos(rot));
      const s = Math.fround(Math.sin(rot));
      const mullion = rotatedBoxEl('mullion', 0, 0, [0.1, 0.1, 1.5], rot);
      const panel = rotatedBoxEl('panel', (0.125 - PEN) * c, (0.125 - PEN) * s, [0.025, 0.75, 1.5], rot);

      const { clashes } = await engine.run([mullion, panel], [rule], { tolerance: 0.001 });
      expect(clashes).toHaveLength(1);
      expect(clashes[0].status).toBe('hard');
      expect(clashes[0].distance).toBeCloseTo(-PEN, 3);

      // Companion: the same pair moved out to exactly flush is still a
      // touch. Without this, a kernel that never reported `touch` would pass.
      const flushPanel = rotatedBoxEl('panel', 0.125 * c, 0.125 * s, [0.025, 0.75, 1.5], rot);
      const flush = await engine.run([mullion, flushPanel], [rule], { tolerance: 0.001 });
      expect(flush.clashes).toHaveLength(1);
      expect(flush.clashes[0].status).toBe('touch');
    });
  }
});
