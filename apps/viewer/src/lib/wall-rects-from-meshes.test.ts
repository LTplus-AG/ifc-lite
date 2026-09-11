/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  footprintOBB,
  roomFramePlanOffsets,
  roomFrameToModelWorld,
  wallRectsFromMeshes,
} from './wall-rects-from-meshes.js';
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

// Render→IFC reconstruction for the model's OWN frame, independent of the code
// under test: coordinate-handler `toWorld` with no survey anchor in play.
// worldYup = renderLocal + originShift; then ifcX = worldYup.x,
// ifcY = -worldYup.z, ifcZ = worldYup.y.
function localIfc(
  rx: number, ry: number, rz: number,
  shift: { x: number; y: number; z: number },
): { ifcX: number; ifcY: number; ifcZ: number } {
  return { ifcX: rx + shift.x, ifcY: -(rz + shift.z), ifcZ: ry + shift.y };
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

  it('reconstructs the footprint + elevation under a NON-ZERO originShift', () => {
    // The room frame is the model's OWN IFC frame: render + originShift, with
    // the Y-up→Z-up swap. Regression guard for the inverted shift signs — with
    // a zero shift this test would pass even with the old (wrong) code.
    const shift = { x: 100, y: 5, z: 20 };
    const coord = {
      originShift: shift,
      hasLargeCoordinates: true,
      // shiftedBounds = originalBounds - originShift (createCoordinateInfo's
      // invariant); wallRectsFromMeshes never reads either bounds field, but
      // a fixture no producer could emit is still worth avoiding.
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
      shiftedBounds: { min: { x: -100, y: -5, z: -20 }, max: { x: -100, y: -5, z: -20 } },
    } as unknown as CoordinateInfo;

    // Wall render box: renderX[0..4], renderZ[0..0.8], renderY[0..3].
    // ifcZ = renderY + shift.y, so the wall occupies ifcZ ∈ [5, 8].
    const rects = wallRectsFromMeshes([wallBox(1, 0, 4, 0, 0.8, 0, 3)], coord, 5, 3);
    assert.strictEqual(rects.length, 1, 'wall should fall on the shifted storey band');
    assert.ok(near(rects[0].thickness, 0.8, 1e-3), `thickness ${rects[0].thickness}`);

    // The centreline runs along X at mid-thickness (renderZ = 0.4).
    const [a, b] = rects[0].centreline;
    const endA = localIfc(0, 1.5, 0.4, shift); // renderX 0
    const endB = localIfc(4, 1.5, 0.4, shift); // renderX 4
    // endpoints may be in either order — match as an unordered pair
    const matches =
      (near(a[0], endA.ifcX, 1e-3) && near(a[1], endA.ifcY, 1e-3) && near(b[0], endB.ifcX, 1e-3) && near(b[1], endB.ifcY, 1e-3)) ||
      (near(a[0], endB.ifcX, 1e-3) && near(a[1], endB.ifcY, 1e-3) && near(b[0], endA.ifcX, 1e-3) && near(b[1], endA.ifcY, 1e-3));
    assert.ok(matches, `centreline ${JSON.stringify([a, b])} vs local A=${JSON.stringify(endA)} B=${JSON.stringify(endB)}`);
    // Concretely: cx = shift.x = 100, cy = -shift.z = -20,
    // mid-thickness ifcY = -20 - 0.4 = -20.4.
    assert.ok(near(a[1], -20.4, 1e-3) && near(b[1], -20.4, 1e-3), `centreline y ${a[1]},${b[1]}`);
  });

  it('excludes a wall whose SHIFTED elevation leaves the storey band', () => {
    const coord = {
      originShift: { x: 100, y: 5, z: 20 },
      hasLargeCoordinates: true,
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
      shiftedBounds: { min: { x: -100, y: -5, z: -20 }, max: { x: -100, y: -5, z: -20 } },
    } as unknown as CoordinateInfo;
    // Wall ifcZ ∈ [5, 8]; a band at ifcZ [20, 23] does NOT overlap it.
    const rects = wallRectsFromMeshes([wallBox(1, 0, 4, 0, 0.8, 0, 3)], coord, 20, 3);
    assert.strictEqual(rects.length, 0);
  });

  it('IGNORES wasmRtcOffset — a georeferenced model reads like an unplaced one', () => {
    // The defect this file exists to prevent, from a real 6-storey LV95 model.
    // `wasmRtcOffset` is what the WASM subtracted to undo a site placement that
    // anchors the building to the survey grid; it is NOT part of the frame the
    // storey elevation, `addSpace` or the 3D ghost speak. Folding it in put the
    // band 381 m below the building — every storey reported "no walls found" —
    // and adding it to the corners wrote baked rooms 2.66 million metres out.
    const rtc = { x: 2665510.36, y: 1259339.34, z: 381.3 };
    const coord = {
      originShift: { x: 0, y: 0, z: 0 },
      wasmRtcOffset: rtc,
      hasLargeCoordinates: false,
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    } as unknown as CoordinateInfo;
    // Storey elevation as IfcBuildingStorey carries it: local, 0 for the lowest
    // floor — NOT 381.3. The wall stands on it, render-Y [0..3].
    const rects = wallRectsFromMeshes([wallBox(1, 0, 4, 0, 0.8, 0, 3)], coord, 0, 3);
    assert.strictEqual(rects.length, 1, 'the storey band must not be displaced by rtc');
    // Corners stay local: an rtc-tainted frame would put them at ~2.67e6.
    for (const [x, y] of rects[0].corners) {
      assert.ok(Math.abs(x) < 1e3 && Math.abs(y) < 1e3, `corner (${x}, ${y}) carries the survey offset`);
    }
    // Same wall, same answer, with rtc absent entirely.
    const bare = wallRectsFromMeshes([wallBox(1, 0, 4, 0, 0.8, 0, 3)], undefined, 0, 3);
    assert.deepEqual(rects[0].corners, bare[0].corners);
  });

  it('room frame + roomFrameToModelWorld IS the model\'s own world frame', () => {
    // The contract the Space Sketch bake rests on (#4500). It folds the outline
    // through the storey's placement chain, which it reads out of the STEP
    // file, so the outline has to be in the frame those placements resolve in.
    // `roomFrameToModelWorld` is what states the room frame's relation to that
    // frame, and this pins the two together: change which terms
    // `roomFramePlanOffsets` carries and this fails until the other one follows.
    const shift = { x: 100, y: 5, z: 20 };
    const rtc = { x: 2665510.36, y: 1259339.34, z: 381.3 };
    const coord = {
      originShift: shift,
      wasmRtcOffset: rtc,
      hasLargeCoordinates: true,
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
      shiftedBounds: { min: { x: -100, y: -5, z: -20 }, max: { x: -100, y: -5, z: -20 } },
    } as unknown as CoordinateInfo;
    const { cx, cy } = roomFramePlanOffsets(coord);
    const { dx, dy } = roomFrameToModelWorld(coord);
    // Take one render-frame point through the room frame and on to the world,
    // and compare against the canonical reconstruction of the same point.
    const [rx, ry, rz] = [3, 1.5, 0.4];
    const world = canonicalIfc(rx, ry, rz, shift, rtc);
    const room: Pt = [rx + cx, cy - rz];
    assert.ok(near(room[0] + dx, world.ifcX, 1e-6), `world X ${room[0] + dx} vs ${world.ifcX}`);
    assert.ok(near(room[1] + dy, world.ifcY, 1e-6), `world Y ${room[1] + dy} vs ${world.ifcY}`);
  });

  it('ignores non-wall meshes', () => {
    const slab = { expressId: 2, ifcType: 'IfcSlab', positions: new Float32Array([0, 0, 0, 5, 0, 0, 5, 0, 5, 0, 0, 5, 0, 0.2, 0, 5, 0.2, 0, 5, 0.2, 5, 0, 0.2, 5]) } as unknown as MeshData;
    assert.strictEqual(wallRectsFromMeshes([slab], undefined, 0, 3).length, 0);
  });
});
