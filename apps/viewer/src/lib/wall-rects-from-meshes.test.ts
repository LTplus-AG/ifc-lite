/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { footprintOBB, wallRectsFromMeshes } from './wall-rects-from-meshes.js';
import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';

type Pt = [number, number];
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// Canonical render→IFC reconstruction, independent of the code under test:
// coordinate-handler `toWorld` (mirrored in PropertiesPanel + lib/geo
// `totalYupOffset`). worldYup = renderLocal + originShift + rtcYup, with
// rtcYup = { x: rtc.x, y: rtc.z, z: -rtc.y }; then ifcX = worldYup.x,
// ifcY = -worldYup.z, ifcZ = worldYup.y.
function canonicalIfc(
  rx: number, ry: number, rz: number,
  shift: { x: number; y: number; z: number },
  rtc: { x: number; y: number; z: number },
): { ifcX: number; ifcY: number; ifcZ: number } {
  const rtcYup = { x: rtc.x, y: rtc.z, z: -rtc.y };
  const wx = rx + shift.x + rtcYup.x;
  const wy = ry + shift.y + rtcYup.y;
  const wz = rz + shift.z + rtcYup.z;
  return { ifcX: wx, ifcY: -wz, ifcZ: wy };
}

// A render-frame box for one wall: plan footprint is XZ, height is Y. A wall
// 4 m long (X) × `thick` (Z), `h0..h1` tall (Y).
function wallBox(expressId: number, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number): MeshData {
  const c = (x: number, y: number, z: number) => [x, y, z];
  return {
    expressId, ifcType: 'IfcWall',
    positions: new Float32Array([
      ...c(x0, y0, z0), ...c(x1, y0, z0), ...c(x1, y0, z1), ...c(x0, y0, z1),
      ...c(x0, y1, z0), ...c(x1, y1, z0), ...c(x1, y1, z1), ...c(x0, y1, z1),
    ]),
  } as unknown as MeshData;
}

describe('footprintOBB', () => {
  it('recovers an axis-aligned rectangle: length, thickness, corners', () => {
    // 4 long × 0.8 thick, axis-aligned in the plan.
    const pts: Pt[] = [[0, 0], [4, 0], [4, 0.8], [0, 0.8]];
    const o = footprintOBB(pts)!;
    assert.ok(near(o.length, 4, 1e-6), `length ${o.length}`);
    assert.ok(near(o.thickness, 0.8, 1e-6), `thickness ${o.thickness}`);
    assert.strictEqual(o.corners.length, 4);
    // every input point coincides with a corner (rectangle reproduced exactly)
    for (const p of pts) assert.ok(o.corners.some((c) => near(c[0], p[0], 1e-6) && near(c[1], p[1], 1e-6)), `corner for ${p}`);
  });

  it('the long axis is reported as length regardless of point order', () => {
    const o = footprintOBB([[0, 0], [0, 5], [0.3, 5], [0.3, 0]])!; // thin in X, long in Y
    assert.ok(near(o.length, 5, 1e-6));
    assert.ok(near(o.thickness, 0.3, 1e-6));
  });

  it('is distribution-invariant: a dense diagonal interior cluster does NOT tilt it (PCA would)', () => {
    // An axis-aligned 4 × 0.4 wall, plus many interior vertices packed along a
    // diagonal. PCA's principal axis would tilt toward the cluster (this is the
    // real-model bug — uneven mesh density skewed walls up to ~5°). The min-area
    // rectangle depends only on the hull, so it stays axis-aligned.
    const pts: Pt[] = [[0, 0], [4, 0], [4, 0.4], [0, 0.4]];
    for (let i = 0; i < 60; i++) { const t = i / 59; pts.push([t * 4, t * 0.4]); }
    const o = footprintOBB(pts)!;
    const ang = Math.atan2(o.corners[1][1] - o.corners[0][1], o.corners[1][0] - o.corners[0][0]) * 180 / Math.PI;
    const off = Math.min(Math.abs(((ang % 90) + 90) % 90), 90 - Math.abs(((ang % 90) + 90) % 90));
    assert.ok(off < 0.01, `off-axis ${off}° (should be ~0 — not tilted by the interior cluster)`);
    assert.ok(near(o.thickness, 0.4, 1e-4), `thickness ${o.thickness}`);
    assert.ok(near(o.length, 4, 1e-4), `length ${o.length}`);
  });
});

describe('wallRectsFromMeshes', () => {
  it('reads a wall rectangle from the rendered footprint (room frame, rtc=shift=0)', () => {
    // Wall along X: renderX[0..4], renderZ[0..0.8], height Y[0..3].
    // Room frame: ifcX = renderX, ifcY = -renderZ → ifcY in [-0.8, 0].
    const rects = wallRectsFromMeshes([wallBox(1, 0, 4, 0, 0.8, 0, 3)], undefined, 0, 3);
    assert.strictEqual(rects.length, 1);
    assert.ok(near(rects[0].thickness, 0.8, 1e-4), `thickness ${rects[0].thickness}`);
    const [a, b] = rects[0].centreline;
    // centreline runs along X at the mid thickness (ifcY = -0.4)
    assert.ok(near(a[1], -0.4, 1e-4) && near(b[1], -0.4, 1e-4), `centreline y ${a[1]},${b[1]}`);
    assert.ok(near(Math.abs(b[0] - a[0]), 4, 1e-4), `centreline length ${Math.abs(b[0] - a[0])}`);
  });

  it('aggregates fragments of one wall (same expressId) before the OBB', () => {
    // Two fragments of the SAME wall (a void-cut wall) — together a 4 m wall.
    const rects = wallRectsFromMeshes(
      [wallBox(7, 0, 1.5, 0, 0.8, 0, 3), wallBox(7, 2.5, 4, 0, 0.8, 0, 3)],
      undefined, 0, 3,
    );
    assert.strictEqual(rects.length, 1, 'one wall, not two');
    assert.ok(near(rects[0].thickness, 0.8, 1e-4));
  });

  it('excludes walls outside the storey height band', () => {
    // Wall lives at Y[10..13]; storey band is [0,3] → excluded.
    const rects = wallRectsFromMeshes([wallBox(1, 0, 4, 0, 0.8, 10, 13)], undefined, 0, 3);
    assert.strictEqual(rects.length, 0);
  });

  it('includes a full-height wall that spans the band', () => {
    // Wall Y[0..20] spans storey band [6,9] → included.
    const rects = wallRectsFromMeshes([wallBox(1, 0, 4, 0, 0.8, 0, 20)], undefined, 6, 3);
    assert.strictEqual(rects.length, 1);
  });

  it('reconstructs the footprint + elevation under a NON-ZERO originShift/rtc, matching the canonical handler', () => {
    // Georeferenced model: non-zero originShift (viewer Y-up frame) AND
    // wasmRtcOffset (IFC Z-up). Regression guard for the inverted shift signs —
    // with a zero shift this test would pass even with the old (wrong) code.
    const shift = { x: 100, y: 5, z: 20 };
    const rtc = { x: 1000, y: 2000, z: 3000 };
    const coord = {
      originShift: shift,
      wasmRtcOffset: rtc,
      hasLargeCoordinates: true,
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    } as unknown as CoordinateInfo;

    // Wall render box: renderX[0..4], renderZ[0..0.8], renderY[0..3].
    // Its render-Y band maps to ifcZ = renderY + shift.y + rtc.z = renderY + 3005,
    // so the wall occupies ifcZ ∈ [3005, 3008]. Storey band [3005, 3008].
    const floorElevation = 3005;
    const floorToFloor = 3;
    const rects = wallRectsFromMeshes([wallBox(1, 0, 4, 0, 0.8, 0, 3)], coord, floorElevation, floorToFloor);
    assert.strictEqual(rects.length, 1, 'wall should fall on the shifted storey band');
    assert.ok(near(rects[0].thickness, 0.8, 1e-3), `thickness ${rects[0].thickness}`);

    // The centreline runs along X at mid-thickness (renderZ = 0.4). Compare the
    // wall-rects output to the canonical reconstruction of that render point.
    const [a, b] = rects[0].centreline;
    const endA = canonicalIfc(0, 1.5, 0.4, shift, rtc); // renderX 0
    const endB = canonicalIfc(4, 1.5, 0.4, shift, rtc); // renderX 4
    // endpoints may be in either order — match as an unordered pair
    const matches =
      (near(a[0], endA.ifcX, 1e-3) && near(a[1], endA.ifcY, 1e-3) && near(b[0], endB.ifcX, 1e-3) && near(b[1], endB.ifcY, 1e-3)) ||
      (near(a[0], endB.ifcX, 1e-3) && near(a[1], endB.ifcY, 1e-3) && near(b[0], endA.ifcX, 1e-3) && near(b[1], endA.ifcY, 1e-3));
    assert.ok(matches, `centreline ${JSON.stringify([a, b])} vs canonical A=${JSON.stringify(endA)} B=${JSON.stringify(endB)}`);
    // Concretely: cx = rtc.x + shift.x = 1100, cy = rtc.y - shift.z = 1980,
    // mid-thickness ifcY = 1980 - 0.4 = 1979.6.
    assert.ok(near(a[1], 1979.6, 1e-3) && near(b[1], 1979.6, 1e-3), `centreline y ${a[1]},${b[1]}`);
  });

  it('excludes a wall whose SHIFTED elevation leaves the storey band', () => {
    // Same shift/rtc, but a storey band that (after the shift) the wall misses.
    const coord = {
      originShift: { x: 100, y: 5, z: 20 },
      wasmRtcOffset: { x: 1000, y: 2000, z: 3000 },
      hasLargeCoordinates: true,
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    } as unknown as CoordinateInfo;
    // Wall ifcZ ∈ [3005, 3008]; a band at ifcZ [0, 3] does NOT overlap it.
    const rects = wallRectsFromMeshes([wallBox(1, 0, 4, 0, 0.8, 0, 3)], coord, 0, 3);
    assert.strictEqual(rects.length, 0);
  });

  it('ignores non-wall meshes', () => {
    const slab = { expressId: 2, ifcType: 'IfcSlab', positions: new Float32Array([0, 0, 0, 5, 0, 0, 5, 0, 5, 0, 0, 5, 0, 0.2, 0, 5, 0.2, 0, 5, 0.2, 5, 0, 0.2, 5]) } as unknown as MeshData;
    assert.strictEqual(wallRectsFromMeshes([slab], undefined, 0, 3).length, 0);
  });
});
