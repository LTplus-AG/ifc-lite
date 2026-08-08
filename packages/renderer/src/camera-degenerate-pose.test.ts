/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Degenerate camera poses must still produce a finite view-projection matrix
 * (issue #2441). The failure mode is silent: nothing throws, the matrix just
 * turns into sixteen NaNs and the viewport draws nothing at all. Every
 * assertion here therefore inspects the numbers, never merely "it returned".
 *
 * Three entry points reach the same `MathUtils.lookAt`:
 *   1. the load path, via `pickFitPolicy` -> `Camera.snapToFitPolicy`
 *      (`useGeometryStreaming` calls `fitBoundsAdaptive` as geometry streams);
 *   2. the public API, `setPosition` / `setTarget` at an exact overhead pose;
 *   3. BCF viewpoint restore, which hands an externally authored
 *      (position, target, up) triple straight through
 *      (`apps/viewer/src/components/viewer/Viewport.tsx` `applyViewpoint`,
 *      `apps/viewer/src/hooks/useBCF.ts` `applyCameraState`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { Camera } from './camera.js';
import { MathUtils } from './math.js';
import { pickFitPolicy } from './camera-fit-policy.js';
import type { Mat4, Vec3 } from './types.js';

const FOV_45 = (45 * Math.PI) / 180;

function assertAllFinite(matrix: Mat4, label: string): void {
  const values = Array.from(matrix.m);
  const bad = values.findIndex((v) => !Number.isFinite(v));
  assert.strictEqual(
    bad,
    -1,
    `${label}: component ${bad} is ${values[bad]} (matrix ${JSON.stringify(values)})`,
  );
}

/**
 * The target must land at the centre of the screen. This is the assertion
 * that distinguishes "finite" from "correct": a matrix full of NaN fails it,
 * and so would a finite-but-meaningless one.
 */
function assertTargetAtScreenCentre(camera: Camera, label: string): void {
  const ndc = MathUtils.transformPoint(camera.getViewProjMatrix(), camera.getTarget());
  assert.ok(Number.isFinite(ndc.x) && Number.isFinite(ndc.y), `${label}: NDC ${JSON.stringify(ndc)}`);
  assert.ok(Math.abs(ndc.x) < 1e-5, `${label}: target NDC x ${ndc.x} should be ~0`);
  assert.ok(Math.abs(ndc.y) < 1e-5, `${label}: target NDC y ${ndc.y} should be ~0`);
}

/** Read the three basis rows out of a view matrix (column-major, row-per-axis). */
function basisOf(view: Mat4): { right: Vec3; up: Vec3; back: Vec3 } {
  const m = view.m;
  return {
    right: { x: m[0], y: m[4], z: m[8] },
    up: { x: m[1], y: m[5], z: m[9] },
    back: { x: m[2], y: m[6], z: m[10] },
  };
}

function assertVecCloseTo(actual: Vec3, expected: Vec3, label: string): void {
  for (const axis of ['x', 'y', 'z'] as const) {
    assert.ok(
      Math.abs(actual[axis] - expected[axis]) < 1e-6,
      `${label}: ${axis} was ${actual[axis]}, expected ${expected[axis]}`,
    );
  }
}

function assertOrthonormal(view: Mat4, label: string): void {
  const { right, up, back } = basisOf(view);
  for (const [name, v] of [['right', right], ['up', up], ['back', back]] as const) {
    const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    assert.ok(Math.abs(len - 1) < 1e-6, `${label}: ${name} axis length ${len} should be 1`);
  }
  assert.ok(Math.abs(MathUtils.dot(right, up)) < 1e-6, `${label}: right . up should be 0`);
  assert.ok(Math.abs(MathUtils.dot(right, back)) < 1e-6, `${label}: right . back should be 0`);
  assert.ok(Math.abs(MathUtils.dot(up, back)) < 1e-6, `${label}: up . back should be 0`);
}

/**
 * The pre-#2441 `lookAt` arithmetic, kept here as the control the guarded
 * implementation must still reproduce bit-for-bit on non-degenerate input.
 */
function unguardedLookAt(eye: Vec3, target: Vec3, up: Vec3): Float32Array {
  const zx = eye.x - target.x;
  const zy = eye.y - target.y;
  const zz = eye.z - target.z;
  const len = 1 / Math.sqrt(zx * zx + zy * zy + zz * zz);
  const z0 = zx * len, z1 = zy * len, z2 = zz * len;

  const xx = up.y * z2 - up.z * z1;
  const xy = up.z * z0 - up.x * z2;
  const xz = up.x * z1 - up.y * z0;
  const len2 = 1 / Math.sqrt(xx * xx + xy * xy + xz * xz);
  const x0 = xx * len2, x1 = xy * len2, x2 = xz * len2;

  const y0 = z1 * x2 - z2 * x1;
  const y1 = z2 * x0 - z0 * x2;
  const y2 = z0 * x1 - z1 * x0;

  const m = new Float32Array(16);
  m[0] = x0; m[1] = y0; m[2] = z0; m[3] = 0;
  m[4] = x1; m[5] = y1; m[6] = z1; m[7] = 0;
  m[8] = x2; m[9] = y2; m[10] = z2; m[11] = 0;
  m[12] = -(x0 * eye.x + x1 * eye.y + x2 * eye.z);
  m[13] = -(y0 * eye.x + y1 * eye.y + y2 * eye.z);
  m[14] = -(z0 * eye.x + z1 * eye.y + z2 * eye.z);
  m[15] = 1;
  return m;
}

describe('MathUtils.lookAt degenerate inputs (#2441)', () => {
  it('keeps a straight-down view finite and orthonormal when up is world Y', () => {
    // forward = (0,-1,0), up = (0,1,0): cross(up, forward) is exactly zero,
    // which used to normalize to NaN across all sixteen components.
    const view = MathUtils.lookAt({ x: 0, y: 10, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    assertAllFinite(view, 'straight-down lookAt');
    assertOrthonormal(view, 'straight-down lookAt');

    // The substituted basis follows the house plan convention (the one the
    // ViewCube's top preset lands on): +X to the right, -Z at the top.
    const { right, up } = basisOf(view);
    assertVecCloseTo(right, { x: 1, y: 0, z: 0 }, 'straight-down right axis');
    assertVecCloseTo(up, { x: 0, y: 0, z: -1 }, 'straight-down screen-up axis');
  });

  it('matches the ViewCube top preset it is standing in for', () => {
    // The preset parks the camera 0.01 rad off the pole precisely to dodge
    // this singularity. An exactly-overhead pose must not render rolled 90°
    // against it, so the two bases have to agree to within that tilt.
    const distance = 100;
    const exact = MathUtils.lookAt(
      { x: 0, y: distance, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
    );
    const preset = MathUtils.lookAt(
      { x: 0, y: Math.cos(0.01) * distance, z: Math.sin(0.01) * distance },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
    );
    const a = basisOf(exact);
    const b = basisOf(preset);
    assert.ok(MathUtils.dot(a.right, b.right) > 0.999, `right axes diverge: ${JSON.stringify([a.right, b.right])}`);
    assert.ok(MathUtils.dot(a.up, b.up) > 0.999, `screen-up axes diverge: ${JSON.stringify([a.up, b.up])}`);
  });

  it('keeps a straight-up view finite (the Y-dominant auto-fit pose)', () => {
    const view = MathUtils.lookAt({ x: 0, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }, { x: 0, y: 1, z: 0 });
    assertAllFinite(view, 'straight-up lookAt');
    assertOrthonormal(view, 'straight-up lookAt');
  });

  it('survives an up vector parallel to an arbitrary view direction', () => {
    const view = MathUtils.lookAt({ x: 3, y: 3, z: 3 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    assertAllFinite(view, 'parallel-up lookAt');
    assertOrthonormal(view, 'parallel-up lookAt');
  });

  it('survives a zero-length up vector (an externally authored viewpoint)', () => {
    const view = MathUtils.lookAt({ x: 10, y: 10, z: 10 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    assertAllFinite(view, 'zero-up lookAt');
    assertOrthonormal(view, 'zero-up lookAt');
  });

  it('survives eye and target coinciding', () => {
    const view = MathUtils.lookAt({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 }, { x: 0, y: 1, z: 0 });
    assertAllFinite(view, 'eye==target lookAt');
    assertOrthonormal(view, 'eye==target lookAt');
  });

  it('honours a short but valid up vector instead of treating it as degenerate', () => {
    // `up` is mutable public state that BCF restore and `animateToWithUp`
    // write verbatim without normalizing, so a small-magnitude up with a
    // perfectly well-defined direction is a reachable input. Degeneracy is
    // an angle, not a length: keying the guard on |cross| alone would send
    // this pose to the fallback and silently discard the caller's roll.
    //
    // Asserting finiteness here would prove nothing — the fallback is finite
    // too. The discriminating assertion is the basis itself.
    const eye = { x: 0, y: 0, z: 5 };
    const target = { x: 0, y: 0, z: 0 };
    const diagonal = 1 / Math.sqrt(2);
    const shortUp = { x: 1e-8 * diagonal, y: 1e-8 * diagonal, z: 0 };
    const unitUp = { x: diagonal, y: diagonal, z: 0 };

    const view = MathUtils.lookAt(eye, target, shortUp);
    assertAllFinite(view, 'short-up lookAt');
    assertOrthonormal(view, 'short-up lookAt');

    // The caller's 45-degree roll, not the fallback's world-Y basis.
    const { right, up } = basisOf(view);
    assertVecCloseTo(right, { x: diagonal, y: -diagonal, z: 0 }, 'short-up right axis');
    assertVecCloseTo(up, { x: diagonal, y: diagonal, z: 0 }, 'short-up screen-up axis');

    // And it matches the same pose with a unit-length up, which is the point:
    // scaling `up` must not change the basis.
    const unitBasis = basisOf(MathUtils.lookAt(eye, target, unitUp));
    assertVecCloseTo(right, unitBasis.right, 'short vs unit up: right axis');
    assertVecCloseTo(up, unitBasis.up, 'short vs unit up: screen-up axis');
  });

  it('survives a non-finite coordinate in any of the three inputs', () => {
    // A malformed viewpoint is a real input class, not a hypothetical: BCF
    // restore reads position/target/up out of a file and feeds them to the
    // public setters unvalidated. A single NaN or Infinity reaches both the
    // view direction and the translation row, so neither the degenerate-up
    // guard nor the eye===target guard covers it on its own.
    const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const value of bad) {
      const cases: Array<[string, Vec3, Vec3, Vec3]> = [
        ['eye.x', { x: value, y: 10, z: 10 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
        ['eye.y', { x: 10, y: value, z: 10 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
        ['eye.z', { x: 10, y: 10, z: value }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
        ['target.x', { x: 10, y: 10, z: 10 }, { x: value, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
        ['target.y', { x: 10, y: 10, z: 10 }, { x: 0, y: value, z: 0 }, { x: 0, y: 1, z: 0 }],
        ['target.z', { x: 10, y: 10, z: 10 }, { x: 0, y: 0, z: value }, { x: 0, y: 1, z: 0 }],
        ['up.x', { x: 10, y: 10, z: 10 }, { x: 0, y: 0, z: 0 }, { x: value, y: 1, z: 0 }],
        ['up.y', { x: 10, y: 10, z: 10 }, { x: 0, y: 0, z: 0 }, { x: 0, y: value, z: 0 }],
        ['up.z', { x: 10, y: 10, z: 10 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: value }],
        ['every input', { x: value, y: value, z: value }, { x: value, y: value, z: value }, { x: value, y: value, z: value }],
      ];
      for (const [label, eye, target, up] of cases) {
        const view = MathUtils.lookAt(eye, target, up);
        assertAllFinite(view, `${label} = ${value}`);
        assertOrthonormal(view, `${label} = ${value}`);
      }
    }
  });

  it('survives coordinates large enough to overflow the squared length', () => {
    // Finite but astronomically large inputs square to Infinity, which the
    // reciprocal-square-root then collapses to a zero-length basis. Falling
    // back keeps the basis orthonormal rather than merely finite.
    const view = MathUtils.lookAt(
      { x: 1e200, y: 1e200, z: 0 },
      { x: -1e200, y: 0, z: 0 },
      { x: 0, y: 1e200, z: 0 },
    );
    assertAllFinite(view, 'overflowing lookAt');
    assertOrthonormal(view, 'overflowing lookAt');
  });

  it('leaves well-conditioned poses byte-identical to the unguarded formula', () => {
    // Control: the guard must not perturb ordinary navigation, so every
    // non-degenerate pose has to reproduce the pre-#2441 arithmetic exactly.
    const poses: Array<[Vec3, Vec3, Vec3]> = [
      [{ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
      [{ x: 50, y: 50, z: 100 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
      [{ x: -12.5, y: 240, z: 7.25 }, { x: 3, y: -1, z: -4 }, { x: 0, y: 1, z: 0 }],
      // The ViewCube top preset: deliberately parked 0.01 rad off the pole,
      // which must stay on the normal path rather than hit the fallback.
      [
        { x: Math.sin(0.01) * 100, y: Math.cos(0.01) * 100, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
      ],
      [{ x: 4, y: 4, z: 4 }, { x: 0, y: 0, z: 0 }, { x: 0.2, y: 0.9, z: -0.1 }],
    ];
    for (const [eye, target, up] of poses) {
      assert.deepStrictEqual(
        MathUtils.lookAt(eye, target, up).m,
        unguardedLookAt(eye, target, up),
        `pose ${JSON.stringify({ eye, target, up })} should be unchanged`,
      );
    }
  });
});

describe('degenerate camera entry points (#2441)', () => {
  it('entry point 1: a Y-dominant auto-fit produces a finite view-projection', () => {
    // 300 m tall, 5 m footprint: aspect 60 (> 50) and longest 300 (>= 100),
    // so the linear policy fires. That is ordinary vertical infrastructure —
    // a mast, chimney, shaft, lift core or turbine tower — and it reaches
    // this pose on the load path with no user action at all.
    const policy = pickFitPolicy(
      { min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 300, z: 5 } },
      { fovY: FOV_45, viewportShortPx: 1080 },
    );
    assert.strictEqual(policy.kind, 'linear');

    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.snapToFitPolicy(policy);
    assertAllFinite(camera.getViewProjMatrix(), 'Y-dominant auto-fit');
    assertTargetAtScreenCentre(camera, 'Y-dominant auto-fit');
  });

  it('entry point 1: the same pose via fitBoundsAdaptive (the streaming call)', () => {
    const camera = new Camera();
    camera.setAspect(16 / 9);
    const policy = camera.fitBoundsAdaptive({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 5, y: 300, z: 5 },
    });
    assert.strictEqual(policy.kind, 'linear');
    assertAllFinite(camera.getViewProjMatrix(), 'fitBoundsAdaptive Y-dominant');
    assertTargetAtScreenCentre(camera, 'fitBoundsAdaptive Y-dominant');
  });

  it('entry point 2: setPosition/setTarget at an exact overhead pose', () => {
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.setPosition(0, 10, 0);
    camera.setTarget(0, 0, 0);
    assert.deepStrictEqual(camera.getUp(), { x: 0, y: 1, z: 0 });
    assertAllFinite(camera.getViewProjMatrix(), 'overhead setPosition/setTarget');
    assertTargetAtScreenCentre(camera, 'overhead setPosition/setTarget');
  });

  it('entry point 2: an exact soffit pose (looking straight up)', () => {
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.setPosition(0, -10, 0);
    camera.setTarget(0, 0, 0);
    assertAllFinite(camera.getViewProjMatrix(), 'soffit setPosition/setTarget');
    assertTargetAtScreenCentre(camera, 'soffit setPosition/setTarget');
  });

  it('entry point 3: a BCF viewpoint whose up is parallel to its view direction', () => {
    // Viewport.tsx `applyViewpoint` (non-animated branch) applies the stored
    // triple verbatim: position, target, then up. Nothing checks that the
    // authoring tool kept them orthogonal.
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.setPosition(10, 0, 0);
    camera.setTarget(0, 0, 0);
    camera.setUp(1, 0, 0);
    assertAllFinite(camera.getViewProjMatrix(), 'BCF parallel up');
    assertTargetAtScreenCentre(camera, 'BCF parallel up');
  });

  it('entry point 3: a BCF viewpoint carrying a zero-length up', () => {
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.setPosition(10, 10, 10);
    camera.setTarget(0, 0, 0);
    camera.setUp(0, 0, 0);
    assertAllFinite(camera.getViewProjMatrix(), 'BCF zero up');
    assertTargetAtScreenCentre(camera, 'BCF zero up');
  });

  it('entry point 3: a BCF viewpoint carrying a non-finite coordinate', () => {
    // The file-supplied route to the input class above: nothing between the
    // BCF markup and `setPosition` / `setTarget` / `setUp` validates the
    // numbers. Only the matrix is asserted here — the restored pose itself is
    // meaningless, but it must not take the viewport down with it.
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.setPosition(Number.NaN, 30, 12);
    camera.setTarget(0, Number.POSITIVE_INFINITY, 0);
    camera.setUp(0, Number.NaN, 0);
    assertAllFinite(camera.getViewProjMatrix(), 'BCF non-finite viewpoint');
  });

  it('entry point 3: a non-finite viewpoint restored in orthographic mode', () => {
    // BCF viewpoints carry their projection mode, and the orthographic branch
    // derives near/far from the camera position by a different route.
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.setProjectionMode('orthographic');
    camera.setOrthoSize(25);
    camera.setSceneBounds({ min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 12, z: 30 } });
    camera.setPosition(20, Number.NaN, 15);
    camera.setTarget(20, 6, Number.POSITIVE_INFINITY);
    assertAllFinite(camera.getViewProjMatrix(), 'orthographic non-finite viewpoint');
  });

  it('entry point 3: switching to orthographic on a non-finite pose', () => {
    // `setProjectionMode` derives `orthoSize` from the live pose, so the
    // malformed viewpoint above poisons the *other* value feeding the
    // orthographic projection — one function away from the near/far guard,
    // and BCF viewpoints carry the projection mode that triggers the switch.
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.setOrthoSize(25);
    camera.setPosition(Number.NaN, 30, 12);
    camera.setTarget(0, Number.POSITIVE_INFINITY, 0);
    camera.setProjectionMode('orthographic');
    // The discriminating assertion: the previous half-height survives rather
    // than being overwritten with the pose's NaN.
    assert.strictEqual(camera.getOrthoSize(), 25, 'orthoSize should keep its last usable value');
    assertAllFinite(camera.getViewProjMatrix(), 'orthographic switch on a non-finite pose');
  });

  it('entry point 3: a plan-view BCF viewpoint restored without an up (useBCF)', () => {
    // useBCF `applyCameraState` sets only position and target, leaving the
    // camera's stored up at world Y — so an authored plan view is degenerate
    // even though the viewpoint itself carried a sane up vector.
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.setPosition(12, 240, -7);
    camera.setTarget(12, 0, -7);
    assertAllFinite(camera.getViewProjMatrix(), 'useBCF plan view');
    assertTargetAtScreenCentre(camera, 'useBCF plan view');
  });
});

/**
 * The pose is only half of the projection matrix. `orthoSize`, `fov` and
 * `aspect` feed it too, and each of their clamps was written with
 * `Math.max`/`Math.min`, which are NaN-transparent: `Math.max(0.01, NaN)` is
 * `NaN`, not the floor. A malformed value therefore passed straight through
 * the clamp that looked like it was rejecting it.
 */
/**
 * Drive a camera animation on a fake clock. Same shape as the helper in
 * `camera-preset-orbit.test.ts`: the animator's completion promise is chained
 * off `requestAnimationFrame`, which does not exist under `node:test`.
 */
function withStubbedFrameClock(run: (advance: (ms: number) => void) => void): void {
  const originalNow = Date.now;
  const hadRaf = Object.prototype.hasOwnProperty.call(globalThis, 'requestAnimationFrame');
  const originalRaf = Reflect.get(globalThis, 'requestAnimationFrame');
  let now = 1_000;

  Date.now = () => now;
  Reflect.set(globalThis, 'requestAnimationFrame', () => 0);

  try {
    run((ms) => { now += ms; });
  } finally {
    Date.now = originalNow;
    if (hadRaf) {
      Reflect.set(globalThis, 'requestAnimationFrame', originalRaf);
    } else {
      Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    }
  }
}

describe('degenerate projection inputs (#2441)', () => {
  it('setOrthoSize keeps the last usable half-height instead of storing a NaN', () => {
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.setProjectionMode('orthographic');
    camera.setOrthoSize(25);

    camera.setOrthoSize(Number.NaN);
    // `getOrthoSize()` is the discriminating assertion here, not finiteness of
    // the matrix: the read-site backstop in `updateMatrices` would keep the
    // matrix finite anyway. A stored NaN leaks out of the camera — the viewer
    // writes `getOrthoSize()` into the viewpoints it saves.
    assert.strictEqual(camera.getOrthoSize(), 25, 'NaN half-height should be rejected');
    assertAllFinite(camera.getViewProjMatrix(), 'orthographic after a NaN setOrthoSize');

    camera.setOrthoSize(Number.POSITIVE_INFINITY);
    assert.strictEqual(camera.getOrthoSize(), 25, 'infinite half-height should be rejected');

    // The finite path is untouched, floor included.
    camera.setOrthoSize(-3);
    assert.strictEqual(camera.getOrthoSize(), 0.01, 'a negative size should still clamp to the floor');
    camera.setOrthoSize(12.5);
    assert.strictEqual(camera.getOrthoSize(), 12.5, 'a valid size should still be stored verbatim');
  });

  it('an orthographic zoom animation cannot put a NaN half-height in the matrix', () => {
    // The writers that never see `setOrthoSize`'s clamp: the animator
    // interpolates `orthoSize` in place and then assigns the end value
    // verbatim, and that end value comes from bounds (`frameBounds` /
    // `zoomExtent`) which can themselves be non-finite. Both writes are
    // exercised below, which is why the clock is stepped twice.
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.setProjectionMode('orthographic');
    camera.setSceneBounds({ min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 12, z: 30 } });

    withStubbedFrameClock((advance) => {
      void camera.frameBounds({ x: 0, y: 0, z: 0 }, { x: 10, y: Number.NaN, z: 10 }, 400);
      advance(100); // strictly inside the tween: the interpolating write
      camera.update(0);
      assertAllFinite(camera.getViewProjMatrix(), 'orthographic mid-animation on non-finite bounds');
      advance(400); // past the end: the verbatim write
      camera.update(0);
      assertAllFinite(camera.getViewProjMatrix(), 'orthographic animation complete on non-finite bounds');
    });
  });

  it('setFOV keeps the last usable field of view instead of storing a NaN', () => {
    // Reachable from the same place as everything else here: `applyViewpoint`
    // checks a restored viewpoint's `orthoSize` for finiteness but hands its
    // `fov` straight to this setter.
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.setPosition(30, 20, 30);
    camera.setTarget(0, 0, 0);
    const before = camera.getFOV();

    camera.setFOV(Number.NaN);
    assert.strictEqual(camera.getFOV(), before, 'NaN fov should be rejected');
    assertAllFinite(camera.getViewProjMatrix(), 'perspective after a NaN setFOV');
    assertTargetAtScreenCentre(camera, 'perspective after a NaN setFOV');

    // A stored NaN would not stay inside the projection: `fitBoundsAdaptive`
    // feeds the fov to `pickFitPolicy`, which hands back the next pose.
    camera.fitBoundsAdaptive({ min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 10, z: 15 } });
    assertAllFinite(camera.getViewProjMatrix(), 'fitBoundsAdaptive after a NaN setFOV');
    assertTargetAtScreenCentre(camera, 'fitBoundsAdaptive after a NaN setFOV');

    // The finite path, clamp included.
    camera.setFOV(FOV_45);
    assert.ok(Math.abs(camera.getFOV() - FOV_45) < 1e-12, 'a valid fov should still be stored');
  });

  it('setAspect survives a collapsed viewport in both projection modes', () => {
    // `width / height` off a zero-height canvas is `Infinity` (or `NaN` for a
    // zero-width one), and aspect is the other multiplicand of the
    // orthographic half-width as well as a direct perspective input.
    for (const [label, bad] of [
      ['zero height', 800 / 0],
      ['zero by zero', 0 / 0],
      ['negative', -2],
    ] as const) {
      const camera = new Camera();
      camera.setAspect(16 / 9);
      camera.setPosition(30, 20, 30);
      camera.setTarget(0, 0, 0);

      camera.setAspect(bad);
      assertAllFinite(camera.getViewProjMatrix(), `perspective aspect ${label}`);
      assertTargetAtScreenCentre(camera, `perspective aspect ${label}`);

      camera.setProjectionMode('orthographic');
      camera.setAspect(bad);
      assertAllFinite(camera.getViewProjMatrix(), `orthographic aspect ${label}`);
      assertTargetAtScreenCentre(camera, `orthographic aspect ${label}`);
    }
  });
});
