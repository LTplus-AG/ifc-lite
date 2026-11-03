/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Perspective lens shift (#8688): an off-axis frustum that moves the image
 * instead of turning the camera, which is what two-point perspective needs.
 * Every matrix consumer follows it for free; these tests pin the matrix
 * itself, the ray unprojection that picking uses, and the two consumers that
 * rebuild the frustum from the camera basis (cursor zoom, shadow focus).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { Camera } from './camera.js';
import { MAX_LENS_SHIFT } from './camera-guards.js';
import { cameraFrustumFocusCorners } from './shadow-light-matrix.js';
import { viewBasis } from './math.js';
import type { Vec3 } from './types.js';

const W = 800;
const H = 600;

function levelCamera(): Camera {
  const camera = new Camera();
  camera.setAspect(W / H);
  camera.setPosition(0, 1.6, 20);
  camera.setTarget(0, 1.6, 0);
  camera.setUp(0, 1, 0);
  return camera;
}

function ndc(camera: Camera, p: Vec3): { x: number; y: number } {
  const s = camera.projectToScreen(p, W, H);
  assert.ok(s, 'point should be in front of the camera');
  return { x: (s.x / W) * 2 - 1, y: 1 - (s.y / H) * 2 };
}

/** `actual` is finite and within `tolerance` of `expected`; reports both on failure. */
function assertClose(actual: number, expected: number, tolerance: number, label: string): void {
  assert.ok(Number.isFinite(actual), `${label}: expected a finite value, got ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} differs from ${expected} by ${Math.abs(actual - expected)} (tolerance ${tolerance})`);
}

describe('Camera lens shift (#8688)', () => {
  it('defaults to zero and leaves the matrices unchanged', () => {
    const shifted = levelCamera();
    const plain = levelCamera();
    assert.deepStrictEqual(shifted.getLensShift(), { x: 0, y: 0 });
    shifted.setLensShift(0.3, -0.2);
    shifted.setLensShift(0, 0);
    assert.deepStrictEqual([...shifted.getProjMatrix().m], [...plain.getProjMatrix().m]);
    assert.deepStrictEqual([...shifted.getViewProjMatrix().m], [...plain.getViewProjMatrix().m]);
  });

  it('rejects non-finite and out-of-range values', () => {
    const camera = levelCamera();
    camera.setLensShift(0.1, 0.2);
    camera.setLensShift(Number.NaN, 0);
    camera.setLensShift(0, Number.POSITIVE_INFINITY);
    // Finite but past Float32 range: would write -Infinity into the matrix.
    camera.setLensShift(1e39, 0);
    camera.setLensShift(0, -(MAX_LENS_SHIFT + 1));
    assert.deepStrictEqual(camera.getLensShift(), { x: 0.1, y: 0.2 });
    camera.setLensShift(MAX_LENS_SHIFT, -MAX_LENS_SHIFT);
    assert.deepStrictEqual(camera.getLensShift(), { x: MAX_LENS_SHIFT, y: -MAX_LENS_SHIFT });
    assert.ok(camera.getProjMatrix().m.every(Number.isFinite));
  });

  it('moves a point on the view axis to NDC = shift', () => {
    const camera = levelCamera();
    camera.setLensShift(0.15, 0.4);
    const p = ndc(camera, { x: 0, y: 1.6, z: -5 });
    assertClose(p.x, 0.15, 1e-5, 'ndc x');
    assertClose(p.y, 0.4, 1e-5, 'ndc y');
  });

  it('gives two-point perspective: a level shifted camera frames like a pitched one, verticals stay vertical', () => {
    // A camera at eye height looking up at a point 12 m higher, 20 m away.
    const pitch = Math.atan2(12, 20);
    const pitched = levelCamera();
    pitched.setTarget(0, 1.6 + 12, 0);
    const shifted = levelCamera();
    shifted.setLensShift(0, -Math.tan(pitch) / Math.tan(shifted.getFOV() / 2));
    // The shifted camera puts the pitched camera's target at the screen centre.
    const aim = ndc(shifted, { x: 0, y: 13.6, z: 0 });
    assertClose(aim.x, 0, 1e-5, 'aim ndc x');
    assertClose(aim.y, 0, 1e-5, 'aim ndc y');
    // An off-centre world vertical converges under pitch but not under shift.
    const vertical = (camera: Camera) => {
      const bottom = ndc(camera, { x: 4, y: 0, z: -2 });
      const top = ndc(camera, { x: 4, y: 25, z: -2 });
      return Math.abs(bottom.x - top.x);
    };
    assert.ok(vertical(pitched) > 0.01, `pitched lean ${vertical(pitched)}`);
    assertClose(vertical(shifted), 0, 1e-5, 'shifted lean');
  });

  it('does not change reverse-Z depth', () => {
    const camera = levelCamera();
    const before = camera.getProjMatrix().m;
    camera.setLensShift(0.5, 0.5);
    const after = camera.getProjMatrix().m;
    for (const i of [2, 3, 6, 7, 10, 11, 14, 15]) assert.strictEqual(after[i], before[i], `m[${i}]`);
  });

  it('is ignored in orthographic mode and restored on return to perspective', () => {
    const camera = levelCamera();
    camera.setProjectionMode('orthographic');
    const ortho = [...camera.getProjMatrix().m];
    camera.setLensShift(0, 0.5);
    assert.deepStrictEqual([...camera.getProjMatrix().m], ortho);
    assert.deepStrictEqual(camera.getActiveLensShift(), { x: 0, y: 0 });
    assert.deepStrictEqual(camera.getLensShift(), { x: 0, y: 0.5 });
    camera.setProjectionMode('perspective');
    assert.deepStrictEqual(camera.getActiveLensShift(), { x: 0, y: 0.5 });
    assertClose(ndc(camera, { x: 0, y: 1.6, z: -5 }).y, 0.5, 1e-5, 'restored ndc y');
  });

  it('unprojects a cursor ray through the shifted image of a point', () => {
    const camera = levelCamera();
    camera.setLensShift(-0.2, 0.35);
    const point = { x: 2, y: 5, z: -4 };
    const screen = camera.projectToScreen(point, W, H)!;
    const ray = camera.unprojectToRay(screen.x, screen.y, W, H);
    const v = { x: point.x - ray.origin.x, y: point.y - ray.origin.y, z: point.z - ray.origin.z };
    const t = v.x * ray.direction.x + v.y * ray.direction.y + v.z * ray.direction.z;
    const miss = Math.hypot(v.x - ray.direction.x * t, v.y - ray.direction.y * t, v.z - ray.direction.z * t);
    assertClose(miss, 0, 1e-3, 'ray miss distance');
  });

  it('zooming at the shifted image of the target is a pure dolly', () => {
    const camera = levelCamera();
    camera.setLensShift(0, 0.5);
    const screen = camera.projectToScreen(camera.getTarget(), W, H)!;
    camera.zoom(-100, false, screen.x, screen.y, W, H);
    const target = camera.getTarget();
    assertClose(target.x, 0, 1e-6, 'target x');
    assertClose(target.y, 1.6, 1e-6, 'target y');
  });
});

describe('cameraFrustumFocusCorners lens shift (#8688)', () => {
  it('slides the focus window by -shift half-extents', () => {
    const eye = { x: 0, y: 0, z: 10 };
    const basis = viewBasis(eye, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    const params = {
      eye, forward: basis.forward, right: basis.right, up: basis.up,
      fovY: Math.PI / 2, aspect: 1, ortho: false, orthoHalfHeight: 1,
      boundsMin: [-1000, -1000, -1] as const, boundsMax: [1000, 1000, 1] as const,
      margin: 0,
    };
    const plain = cameraFrustumFocusCorners(params)!;
    const shifted = cameraFrustumFocusCorners({ ...params, lensShift: { x: 0, y: 0.5 } })!;
    // Near plane at d = 9, half-height 9 (tan 45°): shift 0.5 moves it down by 4.5.
    for (let i = 0; i < plain.length; i++) {
      const d = 10 - plain[i].z;
      assertClose(shifted[i].y, plain[i].y - 0.5 * d, 1e-9, `corner ${i} y`);
      assert.strictEqual(shifted[i].x, plain[i].x);
    }
  });
});
