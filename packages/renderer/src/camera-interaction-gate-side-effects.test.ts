/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `CameraControls.orbit`/`pan`/`zoom` reject a gesture at the choke point
 * (`camera-controls.ts:227/348/422`) — a disallowed `interactionMode` or a
 * non-finite delta leaves the pose untouched. But `Camera`'s wrappers did work
 * either side of that call regardless of whether it was accepted:
 * `resetPresetTracking()` ran unconditionally before `orbit`, and inertia
 * (`addOrbitVelocity`/`addPanVelocity`/`addZoomVelocity`) was queued
 * unconditionally after all three, whether or not the gesture actually moved
 * anything. A rejected gesture under `controls=none` therefore still
 * half-applied: it cleared ViewCube preset-rotation tracking and/or queued
 * inertia for a move that never happened (#2934 review).
 *
 * The fix makes the three `CameraControls` methods report back whether they
 * applied (`camera-controls.ts`), and `Camera` gates both side effects on
 * that report. This file pins the gate from the outside, through the two
 * *observable* consequences of each side effect rather than a private field:
 *
 *  - Inertia: queued velocity is spent by `Camera.update()` on the next call
 *    where a channel is non-zero. Two things are checked, because the
 *    *inertia loop itself* re-applies through the same gated
 *    `controls.orbit`/`pan`/`zoom`, so a leaked queue does not move the pose
 *    while `interactionMode` stays rejecting -- but `update()`'s `isAnimating`
 *    return is driven by the queued velocity alone, so it would still leak as
 *    a render loop kept alive under a camera that is supposed to be frozen.
 *    A wrongly queued velocity also does not decay away silently: switching
 *    the mode back to `'all'` mid-decay -- a live config/`SET_CAMERA` update
 *    -- spends it, jumping the camera from a gesture that was rejected while
 *    frozen. Both are asserted: `update()` must report not-animating while
 *    still rejecting, and the pose must still be unchanged once the mode is
 *    lifted and `update()` is called again.
 *  - Preset tracking: `setPresetView(view)` cycles 90 degrees when clicked
 *    twice in a row on the *same* view, and restarts otherwise. For the
 *    `'top'` view (`camera-preset-view.ts`) that cycle is expressed as a tiny
 *    deliberate tilt in `position` -- `up` stays world Y throughout, by
 *    design, to avoid the pole singularity -- so `position` is the
 *    observable here. Bounds are passed explicitly and held fixed across
 *    both clicks so an intervening orbit's pose drift cannot also perturb
 *    the fit and confound the read.
 *
 * Both rejection reasons the review names are covered for all three
 * gestures — refused by `interactionMode`, and refused by a non-finite
 * delta — plus the positive control: an accepted gesture must still trigger
 * both side effects, or the test could not tell a working gate from a gate
 * that never fires at all.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { Camera } from './camera.js';
import type { Vec3 } from './types.js';
import type { FramingBounds } from './camera-framing.js';

function poseOf(camera: Camera): { position: Vec3; target: Vec3; up: Vec3 } {
  return { position: camera.getPosition(), target: camera.getTarget(), up: camera.getUp() };
}

/** A camera on an ordinary pose. */
function freshCamera(): Camera {
  const camera = new Camera();
  camera.setAspect(16 / 9);
  camera.setPosition(20, 20, 20);
  camera.setTarget(0, 0, 0);
  return camera;
}

/** Fixed so an intervening orbit's pose drift cannot also change the fit. */
const PRESET_BOUNDS: FramingBounds = { min: { x: -5, y: -5, z: -5 }, max: { x: 5, y: 5, z: 5 } };

/** Runs a preset transition to completion so its end pose is directly readable. */
function finishPreset(camera: Camera, view: 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right'): void {
  const originalNow = Date.now;
  const hadRaf = Object.prototype.hasOwnProperty.call(globalThis, 'requestAnimationFrame');
  const originalRaf = Reflect.get(globalThis, 'requestAnimationFrame');
  let now = 1_000;

  Date.now = () => now;
  Reflect.set(globalThis, 'requestAnimationFrame', () => 0);

  try {
    camera.setPresetView(view, PRESET_BOUNDS);
    now += 400;
    camera.update(0);
  } finally {
    Date.now = originalNow;
    if (hadRaf) {
      Reflect.set(globalThis, 'requestAnimationFrame', originalRaf);
    } else {
      Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    }
  }
}

// ---------------------------------------------------------------------------
// Inertia: a rejected gesture must not queue velocity
// ---------------------------------------------------------------------------

describe('Camera gates inertia on whether the gesture actually applied (#2934 review)', () => {
  it('orbit: refused by interactionMode queues no inertia, even once the mode is lifted', () => {
    const camera = freshCamera();
    camera.setInteractionMode('none');
    camera.orbit(50, 0, true);
    const beforeUpdate = poseOf(camera);
    // `update()`'s `isAnimating` return is driven by the queued velocity
    // alone, independent of whether the inertia loop's own `controls.orbit`
    // call is itself gated -- so a leaked queue would keep this `true` (and
    // the render loop alive) under a camera that is supposed to be frozen,
    // even while the mode never changes.
    assert.strictEqual(camera.update(16), false, 'a rejected orbit must not keep the animator reporting isAnimating');
    // Now lift the mode and spend again: this is the sharper exploit -- a
    // live config flip back to 'all' mid-decay must not turn a leaked queue
    // into a camera jump from a gesture that was rejected while frozen.
    camera.setInteractionMode('all');
    camera.update(16);
    assert.deepStrictEqual(poseOf(camera), beforeUpdate, 'a rejected orbit must not move the camera once inertia is spendable');
  });

  it('orbit: refused by a non-finite delta queues no inertia', () => {
    const camera = freshCamera();
    // 'all' is unrestricted -- isolates the non-finite rejection from the mode gate.
    camera.setInteractionMode('all');
    camera.orbit(Number.NaN, 0, true);
    const beforeUpdate = poseOf(camera);
    camera.update(16);
    assert.deepStrictEqual(poseOf(camera), beforeUpdate, 'a non-finite orbit delta must not move the camera on update()');
  });

  it('orbit: control -- an applied orbit still queues inertia', () => {
    const camera = freshCamera();
    camera.setInteractionMode('all');
    camera.orbit(50, 0, true);
    const beforeUpdate = poseOf(camera);
    camera.update(16);
    assert.notDeepStrictEqual(poseOf(camera), beforeUpdate, 'an applied orbit must still queue inertia (positive control)');
  });

  it('pan: refused by interactionMode queues no inertia, even once the mode is lifted', () => {
    const camera = freshCamera();
    camera.setInteractionMode('none');
    camera.pan(50, 0, true);
    const beforeUpdate = poseOf(camera);
    assert.strictEqual(camera.update(16), false, 'a rejected pan must not keep the animator reporting isAnimating');
    camera.setInteractionMode('all');
    camera.update(16);
    assert.deepStrictEqual(poseOf(camera), beforeUpdate, 'a rejected pan must not move the camera once inertia is spendable');
  });

  it('pan: refused by a non-finite delta queues no inertia', () => {
    const camera = freshCamera();
    camera.setInteractionMode('all');
    camera.pan(Number.NaN, 0, true);
    const beforeUpdate = poseOf(camera);
    camera.update(16);
    assert.deepStrictEqual(poseOf(camera), beforeUpdate, 'a non-finite pan delta must not move the camera on update()');
  });

  it('pan: control -- an applied pan still queues inertia', () => {
    const camera = freshCamera();
    camera.setInteractionMode('all');
    camera.pan(50, 0, true);
    const beforeUpdate = poseOf(camera);
    camera.update(16);
    assert.notDeepStrictEqual(poseOf(camera), beforeUpdate, 'an applied pan must still queue inertia (positive control)');
  });

  it("zoom: refused by interactionMode (not 'all') queues no inertia, even once the mode is lifted", () => {
    const camera = freshCamera();
    camera.setInteractionMode('orbit');
    camera.zoom(-50, true);
    const beforeUpdate = poseOf(camera);
    assert.strictEqual(camera.update(16), false, 'a rejected zoom must not keep the animator reporting isAnimating');
    camera.setInteractionMode('all');
    camera.update(16);
    assert.deepStrictEqual(poseOf(camera), beforeUpdate, 'a rejected zoom must not move the camera once inertia is spendable');
  });

  it('zoom: refused by a non-finite delta queues no inertia', () => {
    const camera = freshCamera();
    camera.setInteractionMode('all');
    camera.zoom(Number.NaN, true);
    const beforeUpdate = poseOf(camera);
    camera.update(16);
    assert.deepStrictEqual(poseOf(camera), beforeUpdate, 'a non-finite zoom delta must not move the camera on update()');
  });

  it('zoom: control -- an applied zoom still queues inertia', () => {
    const camera = freshCamera();
    camera.setInteractionMode('all');
    camera.zoom(-50, true);
    const beforeUpdate = poseOf(camera);
    camera.update(16);
    assert.notDeepStrictEqual(poseOf(camera), beforeUpdate, 'an applied zoom must still queue inertia (positive control)');
  });
});

// ---------------------------------------------------------------------------
// Preset tracking: a rejected orbit must not reset the ViewCube rotation cycle
// ---------------------------------------------------------------------------

describe('Camera gates resetPresetTracking() on whether orbit actually applied (#2934 review)', () => {
  it('refused by interactionMode: the preset rotation cycle is unaffected', () => {
    const camera = freshCamera();
    camera.setInteractionMode('all');
    finishPreset(camera, 'top');
    const firstClick = poseOf(camera);

    // A rejected orbit gesture in between the two clicks on the same preset.
    camera.setInteractionMode('none');
    camera.orbit(30, 30);
    camera.setInteractionMode('all');

    finishPreset(camera, 'top');
    const secondClick = poseOf(camera);
    assert.notDeepStrictEqual(
      secondClick.position,
      firstClick.position,
      'clicking the same preset twice must still roll 90 degrees -- a rejected orbit must not have reset tracking',
    );
  });

  it('refused by a non-finite delta: the preset rotation cycle is unaffected', () => {
    const camera = freshCamera();
    camera.setInteractionMode('all');
    finishPreset(camera, 'top');
    const firstClick = poseOf(camera);

    camera.orbit(Number.NaN, 0);

    finishPreset(camera, 'top');
    const secondClick = poseOf(camera);
    assert.notDeepStrictEqual(
      secondClick.position,
      firstClick.position,
      'clicking the same preset twice must still roll 90 degrees -- a non-finite orbit must not have reset tracking',
    );
  });

  it('control: an applied orbit still resets tracking, restarting the cycle', () => {
    const camera = freshCamera();
    camera.setInteractionMode('all');
    finishPreset(camera, 'top');
    const firstClick = poseOf(camera);

    // An applied orbit gesture in between: this is real user interaction with
    // the model, and must still clear the "same view again" cycle. It does
    // move the camera off the preset pose, but the preset transition always
    // re-derives a preset pose from the fixed `PRESET_BOUNDS` and the
    // rotation index alone, so the orbit's own displacement does not reach
    // `up` on the next click -- only whether tracking was reset does.
    camera.orbit(30, 30);

    finishPreset(camera, 'top');
    const secondClick = poseOf(camera);
    assert.deepStrictEqual(
      secondClick.position,
      firstClick.position,
      'an applied orbit must still reset preset tracking (positive control): the next click on the same preset restarts the cycle rather than rolling',
    );
  });
});
