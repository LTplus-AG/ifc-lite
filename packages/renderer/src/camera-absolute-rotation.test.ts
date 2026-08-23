/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Camera.setRotation` — the ABSOLUTE orientation actuator.
 *
 * Every other orientation entry point on the camera is either relative
 * (`orbit`, the viewer's 90° `rotateLeft`/`rotateRight` steppers) or names a
 * direction rather than an angle (`setPresetView`). A host that says "put the
 * camera at azimuth 120°, elevation 30°" — the embed API's `SET_CAMERA`, which
 * had no actuator at all and only wrote a store field (#2934) — needs this one.
 *
 * The pinned contract is the round trip against `getRotation`, because that is
 * what makes the command observable to the caller: the angles the camera
 * reports back must be the angles that were asked for, and the pose must
 * actually have moved.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { Camera } from './camera.js';
import { CAMERA_CONSTANTS as CC } from './constants.js';
import type { Vec3 } from './types.js';

function len(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/**
 * Drive a camera animation on a fake clock. Same helper shape as
 * `camera-malformed-bounds-fit.test.ts` / `camera-preset-orbit.test.ts`: the
 * animator's completion promise chains off `requestAnimationFrame`, which does
 * not exist under `node:test`, so the animation is stepped by hand and the
 * promise is never awaited.
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

function distanceOf(camera: Camera): number {
  const p = camera.getPosition();
  const t = camera.getTarget();
  return len({ x: p.x - t.x, y: p.y - t.y, z: p.z - t.z });
}

describe('Camera.setRotation (absolute orientation)', () => {
  it('reports back exactly the angles it was given', () => {
    const camera = new Camera();
    for (const [azimuth, elevation] of [[0, 0], [90, 30], [217.5, -42], [359, 12]] as const) {
      camera.setRotation(azimuth, elevation);
      const got = camera.getRotation();
      assert.ok(Math.abs(got.azimuth - azimuth) < 1e-6, `azimuth ${got.azimuth} != ${azimuth}`);
      assert.ok(Math.abs(got.elevation - elevation) < 1e-6, `elevation ${got.elevation} != ${elevation}`);
    }
  });

  it('actually moves the camera position', () => {
    const camera = new Camera();
    const before = camera.getPosition();
    camera.setRotation(180, 45);
    const after = camera.getPosition();
    assert.ok(
      Math.abs(before.x - after.x) + Math.abs(before.y - after.y) + Math.abs(before.z - after.z) > 1e-3,
      'setRotation left the camera position untouched',
    );
  });

  it('is idempotent — repeating the same angles does not walk the camera', () => {
    // The command is ABSOLUTE, so a host that re-sends its current orientation
    // (a slider that fires on every frame) must not drift. A relative
    // implementation would accumulate; only float noise from re-deriving the
    // radius is allowed here.
    const camera = new Camera();
    camera.setRotation(120, 25);
    const first = camera.getPosition();
    for (let i = 0; i < 20; i++) camera.setRotation(120, 25);
    const last = camera.getPosition();
    const drift = Math.abs(last.x - first.x) + Math.abs(last.y - first.y) + Math.abs(last.z - first.z);
    assert.ok(drift < 1e-9, `drifted by ${drift} over 20 identical calls`);
  });

  it('preserves the orbit distance and the target', () => {
    const camera = new Camera();
    camera.setTarget(10, 20, 30);
    camera.setPosition(10, 20, 130); // distance 100 from the target
    const distanceBefore = distanceOf(camera);

    camera.setRotation(75, -15);

    assert.ok(Math.abs(distanceOf(camera) - distanceBefore) < 1e-6, 'distance changed');
    assert.deepStrictEqual(camera.getTarget(), { x: 10, y: 20, z: 30 });
  });

  it('normalizes an out-of-range azimuth into 0-360', () => {
    const camera = new Camera();
    camera.setRotation(-90, 0);
    assert.ok(Math.abs(camera.getRotation().azimuth - 270) < 1e-6);
  });

  it('clamps elevation just off the poles so the view matrix cannot degenerate', () => {
    const camera = new Camera();
    // ±90° is the spherical singularity: `cross(forward, up)` collapses and the
    // model flips. MIN_PHI is the same margin `orbit` clamps to.
    const maxElevation = 90 - (CC.MIN_PHI * 180) / Math.PI;
    camera.setRotation(0, 90);
    assert.ok(Math.abs(camera.getRotation().elevation - maxElevation) < 1e-6);
    camera.setRotation(0, -90);
    assert.ok(Math.abs(camera.getRotation().elevation + maxElevation) < 1e-6);
  });

  it('supersedes an animation already in flight instead of being erased by it', () => {
    // A host that sends SET_VIEW (which animates) and then SET_CAMERA must end
    // up where SET_CAMERA asked. Without cancelling the tween, the very next
    // `update()` writes the animation's interpolated pose over this one.
    withStubbedFrameClock((advance) => {
      const camera = new Camera();
      // setPresetView starts a tween that `update()` applies frame by frame.
      camera.setPresetView('top', { min: { x: -10, y: -10, z: -10 }, max: { x: 10, y: 10, z: 10 } });

      camera.setRotation(200, 20);
      advance(16);
      camera.update(16);

      const got = camera.getRotation();
      assert.ok(Math.abs(got.azimuth - 200) < 1e-6, `azimuth drifted to ${got.azimuth}`);
      assert.ok(Math.abs(got.elevation - 20) < 1e-6, `elevation drifted to ${got.elevation}`);
    });
  });

  it('re-seats a non-Y up vector, so the angles are observable from any prior pose', () => {
    // Every other case here starts from a camera whose `up` is already world
    // Y, which is the one state where the reset at the end of `setRotation`
    // cannot be observed -- verified by mutation: deleting
    // `this.state.camera.up = { x: 0, y: 1, z: 0 }` left the whole file green.
    //
    // `getRotation` derives azimuth from the UP vector whenever it has any
    // horizontal component (`upLen > 0.01`), and only falls back to the
    // position when up is vertical. A camera restored from a BCF viewpoint
    // takes its up straight from the file (`Viewport.tsx`'s
    // `camera.setUp(viewpoint.up...)`), so a top-down viewpoint arrives with
    // up = (0, 0, -1). Without the reset the new position is written but the
    // reported azimuth still comes from the stale up vector -- 0 instead of
    // the 120 that was asked for, i.e. exactly the "the command did nothing"
    // symptom of #2934, one layer down.
    const camera = new Camera();
    camera.setTarget(0, 0, 0);
    camera.setPosition(0, 100, 0);
    camera.setUp(0, 0, -1);
    assert.ok(
      Math.abs(camera.getRotation().azimuth - 0) < 1e-6,
      'fixture precondition: the stale up vector reports azimuth 0',
    );

    camera.setRotation(120, 30);

    const got = camera.getRotation();
    assert.ok(
      Math.abs(got.azimuth - 120) < 1e-6,
      `azimuth ${got.azimuth} != 120 -- the stale up vector still drives the readout`,
    );
    assert.ok(Math.abs(got.elevation - 30) < 1e-6, `elevation ${got.elevation} != 30`);
    assert.deepStrictEqual(camera.getUp(), { x: 0, y: 1, z: 0 });
  });

  it('rejects a non-finite TARGET instead of writing a NaN pose', () => {
    // The angle guard above is not enough: every position component is
    // `target.<axis> + ...`, and `setTarget` accepts non-finite coordinates, so
    // one NaN there makes the whole pose NaN. `isUsableDistance` rescues the
    // radius and says nothing about the target. This method's contract is that
    // it RECOVERS a pose, so writing an unrecoverable one is worse than
    // refusing outright.
    const camera = new Camera();
    camera.setRotation(30, 10);
    const pose = camera.getPosition();

    camera.setTarget(NaN, 0, 0);
    camera.setRotation(45, 20);
    assert.deepStrictEqual(camera.getPosition(), pose, 'a NaN target must not move the camera');

    camera.setTarget(0, Infinity, 0);
    camera.setRotation(60, 15);
    assert.deepStrictEqual(camera.getPosition(), pose, 'an infinite target must not move it either');
    assert.ok(Number.isFinite(camera.getPosition().x));
  });

  it('rejects non-finite angles instead of writing a NaN pose', () => {
    const camera = new Camera();
    camera.setRotation(30, 10);
    const pose = camera.getPosition();
    camera.setRotation(NaN, 10);
    camera.setRotation(30, Infinity);
    assert.deepStrictEqual(camera.getPosition(), pose);
  });

  it('recovers from a degenerate pose rather than propagating it', () => {
    const camera = new Camera();
    // position === target: distance 0, so there is no orbit radius to preserve.
    camera.setTarget(5, 5, 5);
    camera.setPosition(5, 5, 5);
    camera.setRotation(45, 20);
    const got = camera.getRotation();
    assert.ok(Number.isFinite(got.azimuth) && Number.isFinite(got.elevation));
    assert.ok(distanceOf(camera) > 0, 'still degenerate after setRotation');
    assert.ok(Math.abs(got.azimuth - 45) < 1e-6);
    assert.ok(Math.abs(got.elevation - 20) < 1e-6);
  });
});
