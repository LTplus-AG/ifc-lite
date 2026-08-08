/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Camera.getDistance()` is the pose reduced to one number, and it is NOT
 * sanitized — see its doc comment. Its consumers all opened with a `dist < eps`
 * early return, which reads like a guard but is a magnitude test: every
 * comparison with NaN is false, so `NaN < eps` is false and a malformed pose
 * walked straight past it. Downstream, each of these gestures writes its result
 * back into `camera.position` and `camera.target`, so the consequence is not
 * one bad frame — it is a pose that can never be recovered from, and two of
 * them additionally latch an accumulator that never recovers either.
 *
 * Scope: the gesture side of #2441 — `camera-controls.ts` / `camera-animation.ts`
 * reading the pose back out. The matrix side, where a degenerate pose must not
 * turn `MathUtils.lookAt` or the projection inputs into NaN, lives in
 * `camera-degenerate-pose-matrix.test.ts`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { Camera } from './camera.js';
import type { Mat4, Vec3 } from './types.js';

/**
 * Deliberately duplicated from `camera-degenerate-pose-matrix.test.ts` rather
 * than shared: it is a dependency-free predicate with no policy in it to drift,
 * and the two suites test different units. Importing it across `.test.ts` files
 * would additionally re-execute that file's suites here.
 */
function assertAllFinite(matrix: Mat4, label: string): void {
  const values = Array.from(matrix.m);
  const bad = values.findIndex((v) => !Number.isFinite(v));
  assert.strictEqual(
    bad,
    -1,
    `${label}: component ${bad} is ${values[bad]} (matrix ${JSON.stringify(values)})`,
  );
}

const BAD_POSE = { x: Number.NaN, y: 30, z: 12 };
const GOOD_TARGET = { x: 0, y: 5, z: 0 };

/** Snapshot the pose so a mutation of it can be asserted against. */
function poseOf(camera: Camera): { position: Vec3; target: Vec3 } {
  return { position: camera.getPosition(), target: camera.getTarget() };
}

function assertPoseUnchanged(camera: Camera, before: { position: Vec3; target: Vec3 }, label: string): void {
  assert.deepStrictEqual(poseOf(camera), before, `${label}: the gesture must not rewrite an unusable pose`);
}

/** Every coordinate of both pose vectors is finite. */
function assertPoseFinite(camera: Camera, label: string): void {
  for (const [name, v] of [['position', camera.getPosition()], ['target', camera.getTarget()]] as const) {
    for (const axis of ['x', 'y', 'z'] as const) {
      assert.ok(Number.isFinite(v[axis]), `${label}: ${name}.${axis} is ${v[axis]}`);
    }
  }
}

/**
 * The same, but non-finite via Infinity rather than NaN. `parseFloat("1e999")`
 * yields Infinity, and BCF coordinates are parsed with a bare `parseFloat`, so
 * this is as reachable from a malformed file as NaN is. It is worth pinning
 * separately: a guard written `!Number.isNaN(dist)` instead of
 * `Number.isFinite(dist)` passes every NaN test in this file and is still wrong.
 */
function cameraOnInfinitePose(): Camera {
  const camera = new Camera();
  camera.setAspect(16 / 9);
  camera.setPosition(Infinity, BAD_POSE.y, BAD_POSE.z);
  camera.setTarget(GOOD_TARGET.x, GOOD_TARGET.y, GOOD_TARGET.z);
  return camera;
}

/** A camera holding a pose with exactly one non-finite coordinate. */
function cameraOnBadPose(): Camera {
  const camera = new Camera();
  camera.setAspect(16 / 9);
  camera.setPosition(BAD_POSE.x, BAD_POSE.y, BAD_POSE.z);
  camera.setTarget(GOOD_TARGET.x, GOOD_TARGET.y, GOOD_TARGET.z);
  return camera;
}

describe('a malformed pose must not be spread by a navigation gesture (#2441)', () => {
  it('getRotation reports the neutral angles instead of a NaN elevation', () => {
    // `Math.max(-1, Math.min(1, NaN))` is NaN and `Math.asin(NaN)` is NaN, and
    // this value leaves the renderer entirely: the viewer pipes it into the
    // rotation readout (`updateCameraRotationRealtime`) and the measurement
    // handlers. Finiteness is the discriminating assertion here — the
    // pre-guard code returned an object either way.
    const camera = cameraOnBadPose();
    assert.deepStrictEqual(camera.getRotation(), { azimuth: 0, elevation: 0 }, 'fully malformed pose');

    // The half-malformed case: azimuth would have come back finite (the
    // up-vector fallback uses `dir.z`, which is fine) while elevation alone
    // went NaN, so a caller sanity-checking one field would have missed it.
    const vertical = new Camera();
    vertical.setPosition(0, Number.NaN, 5);
    vertical.setTarget(0, 0, 0);
    const rot = vertical.getRotation();
    assert.ok(Number.isFinite(rot.elevation), `elevation was ${rot.elevation}`);
    assert.ok(Number.isFinite(rot.azimuth), `azimuth was ${rot.azimuth}`);
    assert.deepStrictEqual(rot, { azimuth: 0, elevation: 0 }, 'vertically malformed pose');
  });

  it('getRotation keeps its zero-distance answer and its ordinary one', () => {
    // Control for the guard above: the pre-existing degenerate case must keep
    // behaving exactly as it did, and a well-formed pose must be untouched.
    const coincident = new Camera();
    coincident.setPosition(4, 4, 4);
    coincident.setTarget(4, 4, 4);
    assert.deepStrictEqual(coincident.getRotation(), { azimuth: 0, elevation: 0 }, 'eye == target');

    const ordinary = new Camera();
    ordinary.setPosition(5, 5, 0);
    ordinary.setTarget(0, 0, 0);
    const rot = ordinary.getRotation();
    assert.ok(Math.abs(rot.elevation - 45) < 1e-9, `elevation was ${rot.elevation}, expected 45`);
    assert.ok(Math.abs(rot.azimuth - 90) < 1e-9, `azimuth was ${rot.azimuth}, expected 90`);
  });

  it('pan leaves an unusable pose alone instead of spreading the NaN into it', () => {
    // The pan offset is added to position AND target alike, so before the
    // guard a single non-finite coordinate became all six on the first drag —
    // and `target` was perfectly good beforehand.
    const camera = cameraOnBadPose();
    const before = poseOf(camera);
    camera.pan(25, -15);
    assertPoseUnchanged(camera, before, 'pan on a malformed pose');
    assert.deepStrictEqual(camera.getTarget(), GOOD_TARGET, 'the finite target must survive a pan');
  });

  it('treats an INFINITE pose as unusable, not merely a NaN one', () => {
    // Every other test in this file uses NaN. `Number.isFinite` rejects both,
    // but `!Number.isNaN` — the guard someone would plausibly reach for —
    // accepts Infinity, so without this the whole suite passes on a guard that
    // lets an infinite pose through. Infinity reaches the camera from a BCF
    // file via `parseFloat("1e999")`.
    const camera = cameraOnInfinitePose();
    const before = poseOf(camera);
    camera.pan(25, -15);
    assertPoseUnchanged(camera, before, 'pan on an infinite pose');
    assert.deepStrictEqual(camera.getTarget(), GOOD_TARGET, 'the finite target must survive a pan');

    const rotation = camera.getRotation();
    assert.ok(
      Number.isFinite(rotation.azimuth) && Number.isFinite(rotation.elevation),
      'getRotation must not report a non-finite angle for an infinite pose',
    );
  });

  it('pan does not latch pan inertia on a malformed pose', () => {
    // `addPanVelocity` multiplies by `getDistance()`, so the velocity itself
    // went NaN — and the inertia loop spends velocity only while
    // `Math.abs(v) > minVelocity`, which is false for NaN. The velocity was
    // therefore never applied and never damped: pan inertia stayed dead for
    // the rest of the session, long after the pose was corrected.
    const camera = cameraOnBadPose();
    camera.pan(25, -15, true);

    // Correct the pose completely, then pan normally.
    camera.setPosition(50, 50, 100);
    camera.setTarget(0, 0, 0);
    camera.pan(25, -15, true);

    assert.strictEqual(camera.update(0), true, 'pan inertia should be live again after a good pan');
    assertPoseFinite(camera, 'pan inertia after recovery');
  });

  it('orbit leaves an unusable pose alone on both pivot paths', () => {
    // Default pivot (rotateAroundPivot): writes position only.
    const standard = cameraOnBadPose();
    const beforeStandard = poseOf(standard);
    standard.orbit(30, 20);
    assert.deepStrictEqual(standard.getPosition(), beforeStandard.position, 'default-pivot orbit');
    assert.deepStrictEqual(standard.getTarget(), beforeStandard.target, 'default-pivot orbit target');

    // External pivot (orbitAroundExternalPivot, the click-to-orbit path):
    // writes position AND target, so it spread further than the default one.
    const pivoted = cameraOnBadPose();
    pivoted.setOrbitCenter({ x: 1, y: 2, z: 3 });
    const beforePivoted = poseOf(pivoted);
    pivoted.orbit(30, 20);
    assertPoseUnchanged(pivoted, beforePivoted, 'external-pivot orbit');
    assert.deepStrictEqual(pivoted.getTarget(), GOOD_TARGET, 'the finite target must survive an orbit');
  });

  it('external-pivot orbit rejects a pose whose only malformed vector is the target', () => {
    // Every other guard measures position-to-target, the pair it then mutates.
    // This one measures position-to-*pivot*, so it stays finite for a pose
    // whose position and click pivot are both good and whose target alone is
    // malformed — reachable as "restore a malformed viewpoint, then
    // click-to-orbit". The NaN does not stay in the coordinate it arrived in:
    // the world-Y Rodrigues rotation mixes the components (`0 * NaN` is `NaN`,
    // so even the axis's zero terms carry it), so the two *good* target
    // coordinates were destroyed along with the bad one on the first drag.
    const targets = [
      ['NaN in y', { x: 0, y: Number.NaN, z: 0 }],
      ['NaN in x', { x: Number.NaN, y: 5, z: 0 }],
      ['Infinity in y', { x: 0, y: Infinity, z: 0 }],
    ] as const;
    const drags = [
      ['a tilting drag', 30, 20],
      ['a purely horizontal drag', 30, 0],
    ] as const;
    for (const [targetLabel, target] of targets) {
      for (const [dragLabel, dx, dy] of drags) {
        const camera = new Camera();
        camera.setAspect(16 / 9);
        camera.setPosition(50, 30, 12);
        camera.setTarget(target.x, target.y, target.z);
        camera.setOrbitCenter({ x: 1, y: 2, z: 3 });
        const before = poseOf(camera);
        camera.orbit(dx, dy);
        assertPoseUnchanged(camera, before, `external-pivot orbit, ${targetLabel}, ${dragLabel}`);
      }
    }

    // The floor is 0, not the 1e-6 the pivot offset uses, and that matters:
    // a target coinciding with the position is a *valid* look of length zero
    // (the target simply rides along), so the guard must still let it orbit.
    // Without this the test above would also pass against a guard that had
    // simply stopped orbiting around an external pivot altogether.
    const coincident = new Camera();
    coincident.setAspect(16 / 9);
    coincident.setPosition(50, 30, 12);
    coincident.setTarget(50, 30, 12);
    coincident.setOrbitCenter({ x: 1, y: 2, z: 3 });
    const beforeCoincident = poseOf(coincident);
    coincident.orbit(30, 20);
    assert.notDeepStrictEqual(poseOf(coincident), beforeCoincident, 'a zero-length look must still orbit');
    assertPoseFinite(coincident, 'external-pivot orbit with a zero-length look');
  });

  it('zoom leaves an unusable pose alone in both projection modes', () => {
    for (const mode of ['perspective', 'orthographic'] as const) {
      const camera = cameraOnBadPose();
      camera.setProjectionMode(mode);
      const before = poseOf(camera);
      camera.zoom(-120, false, 400, 300, 800, 600);
      assertPoseUnchanged(camera, before, `zoom in ${mode}`);
      assert.deepStrictEqual(camera.getTarget(), GOOD_TARGET, `the finite target must survive a ${mode} zoom`);
    }
  });

  it('moveFirstPerson leaves an unusable pose alone and does not latch the walk velocity', () => {
    // `walkVelocity` is accumulated in place (`+= (target - current) * 0.15`),
    // so one NaN frame poisoned it permanently — walking stayed dead even
    // after the pose was corrected, exactly like the pan-inertia latch.
    const camera = cameraOnBadPose();
    camera.setPosition(0, 10, Number.NaN);
    camera.setTarget(0, 10, 0);
    camera.enableFirstPersonMode(true);
    const before = poseOf(camera);
    camera.moveFirstPerson(1, 0, 0);
    assertPoseUnchanged(camera, before, 'moveFirstPerson on a malformed pose');

    camera.setPosition(0, 10, 20);
    camera.setTarget(0, 10, 0);
    const recovered = camera.getPosition();
    camera.moveFirstPerson(1, 0, 0);
    assertPoseFinite(camera, 'moveFirstPerson after recovery');
    assert.notStrictEqual(camera.getPosition().z, recovered.z, 'walking should work again after recovery');
  });

  it('moveFirstPerson rejects a pose whose only bad coordinate is vertical', () => {
    // The horizontal-length guard cannot see this one: `dir` there is XZ only,
    // so `horizLen` is finite and the pose reaches the speed calculation,
    // where `Math.max(0.02, NaN)` is `NaN` rather than the floor.
    const camera = new Camera();
    camera.setPosition(0, Number.NaN, 20);
    camera.setTarget(0, 0, 0);
    camera.enableFirstPersonMode(true);
    const before = poseOf(camera);
    camera.moveFirstPerson(1, 0, 0);
    assertPoseUnchanged(camera, before, 'moveFirstPerson on a vertically malformed pose');
  });

  it('control: every gesture still moves a well-formed pose', () => {
    // The guards must reject only unusable poses. Each gesture below has to
    // change the pose it is given and leave it finite, or the tests above
    // would pass against a camera that had simply stopped navigating.
    const gestures: Array<[string, (c: Camera) => void]> = [
      ['pan', (c) => c.pan(25, -15)],
      ['orbit', (c) => c.orbit(30, 20)],
      ['orbit with pivot', (c) => { c.setOrbitCenter({ x: 1, y: 2, z: 3 }); c.orbit(30, 20); }],
      ['zoom', (c) => c.zoom(-120)],
      ['zoom to cursor', (c) => c.zoom(-120, false, 400, 300, 800, 600)],
      ['moveFirstPerson', (c) => c.moveFirstPerson(1, 0, 0)],
    ];
    for (const [label, gesture] of gestures) {
      const camera = new Camera();
      camera.setAspect(16 / 9);
      camera.setPosition(50, 50, 100);
      camera.setTarget(0, 0, 0);
      const before = poseOf(camera);
      gesture(camera);
      assertPoseFinite(camera, `control ${label}`);
      assert.notDeepStrictEqual(poseOf(camera), before, `control ${label}: the pose should have moved`);
      assertAllFinite(camera.getViewProjMatrix(), `control ${label}`);
    }
  });
});
