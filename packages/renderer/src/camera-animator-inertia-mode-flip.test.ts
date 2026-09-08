/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Camera.orbit`/`pan`/`zoom` already gate `resetPresetTracking()` and
 * inertia-queueing on whether `CameraControls.orbit`/`pan`/`zoom` applied
 * (see `camera-interaction-gate-side-effects.test.ts`, #2934 review). But
 * `CameraAnimator.update()`'s own inertia loop calls the same
 * `CameraControls` methods directly, on every tick of the decay, and
 * discards their boolean result -- so it bypasses the gate a second time,
 * one level down.
 *
 * That bypass is invisible when a gesture is refused from the start (no
 * velocity is ever queued, so the inertia loop's `Math.abs(velocity) >
 * minVelocity` guard never even opens the block). It only shows up
 * mid-decay: a gesture applies while `interactionMode` is `'all'` (queuing
 * real velocity), then `interactionMode` flips to a restricting value
 * *while inertia is still decaying* -- an embed host can do this at any
 * time via a live `?controls=`/`SET_CAMERA`-style config update. On every
 * tick after that, `CameraControls.orbit`/`pan`/`zoom` correctly refuses to
 * move the pose, but the inertia loop still (a) resets ViewCube preset
 * tracking on a refused orbit tick, and (b) reports `isAnimating: true`
 * unconditionally, keeping the render loop alive around a camera that is
 * frozen.
 *
 * The fix mirrors `Camera`'s own gate one level down: each of the three
 * inertia blocks only runs `resetPresetTracking()`/sets `isAnimating` when
 * the underlying `CameraControls` call reports it applied. On refusal, the
 * refused channel's velocity is also zeroed (not just left to decay) --
 * otherwise the queued velocity survives the frozen ticks and gets spent in
 * one jump the moment `interactionMode` is lifted back to `'all'`, even
 * though the gesture that produced it was already rejected while frozen.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { Camera } from './camera.js';
import type { Vec3 } from './types.js';

function poseOf(camera: Camera): { position: Vec3; target: Vec3; up: Vec3 } {
  return { position: camera.getPosition(), target: camera.getTarget(), up: camera.getUp() };
}

function freshCamera(): Camera {
  const camera = new Camera();
  camera.setAspect(16 / 9);
  camera.setPosition(20, 20, 20);
  camera.setTarget(0, 0, 0);
  return camera;
}

describe('CameraAnimator inertia loop gates on CameraControls applying, mid-decay (#2934)', () => {
  it('orbit: mode flips to refusing mid-decay -- update() stops reporting isAnimating', () => {
    const camera = freshCamera();
    camera.setInteractionMode('all');
    camera.orbit(50, 0, true); // queues real inertia while unrestricted
    camera.setInteractionMode('none'); // embed host restricts mid-decay

    assert.strictEqual(
      camera.update(16),
      false,
      'a decaying orbit refused by interactionMode must not keep the animator reporting isAnimating',
    );
  });

  it('orbit: mode flips to refusing mid-decay -- a refused tick does not reset preset tracking', () => {
    // Reaching this precondition (nonzero orbit velocity *and* a live preset
    // tracking value) through the public API is not possible: every path
    // that queues orbit velocity (`Camera.orbit` with `addVelocity`) also
    // resets tracking as part of its own gate, and the only path that sets
    // tracking (`setPresetView`) zeroes all velocity first (`animateToWithUp`,
    // "Clear all velocities to prevent inertia from interfering with
    // animation"). So in this codebase the inertia loop's own
    // `resetPresetTracking()` call is currently always a no-op in practice --
    // but the gate is still the correct defensive fix (mirrors `Camera`'s own
    // gate one level up) and this test pins it directly against the private
    // field, the only way to construct the state at all.
    const camera = freshCamera();
    camera.setInteractionMode('all');
    camera.orbit(50, 0, true); // queues inertia (also resets tracking, harmlessly, since it applied)

    const animator = (camera as unknown as { animator: { lastPresetView: string | null; presetViewRotation: number } }).animator;
    animator.lastPresetView = 'top';
    animator.presetViewRotation = 2;

    camera.setInteractionMode('none'); // now every inertia tick is refused
    camera.update(16); // a refused inertia tick must not reset tracking

    assert.strictEqual(animator.lastPresetView, 'top', 'a refused inertia tick must not clear the tracked preset view');
    assert.strictEqual(animator.presetViewRotation, 2, 'a refused inertia tick must not restart the preset rotation cycle');
  });

  it('orbit: mode flips to refusing mid-decay -- lifting the mode back does not jump the camera', () => {
    const camera = freshCamera();
    camera.setInteractionMode('all');
    camera.orbit(50, 0, true);
    camera.setInteractionMode('none');
    camera.update(16); // one or more frozen ticks while refused
    camera.update(16);
    const frozenPose = poseOf(camera);

    camera.setInteractionMode('all'); // host re-enables mid-decay
    camera.update(16);
    assert.deepStrictEqual(
      poseOf(camera),
      frozenPose,
      'a rejected orbit\'s leftover velocity must not survive to jump the camera once the mode is lifted',
    );
  });

  it('pan: mode flips to refusing mid-decay -- update() stops reporting isAnimating and does not jump on re-enable', () => {
    const camera = freshCamera();
    camera.setInteractionMode('all');
    camera.pan(50, 0, true);
    camera.setInteractionMode('none');

    assert.strictEqual(
      camera.update(16),
      false,
      'a decaying pan refused by interactionMode must not keep the animator reporting isAnimating',
    );
    const frozenPose = poseOf(camera);

    camera.setInteractionMode('all');
    camera.update(16);
    assert.deepStrictEqual(
      poseOf(camera),
      frozenPose,
      'a rejected pan\'s leftover velocity must not survive to jump the camera once the mode is lifted',
    );
  });

  it("zoom: mode flips to refusing (not 'all') mid-decay -- update() stops reporting isAnimating and does not jump on re-enable", () => {
    const camera = freshCamera();
    camera.setInteractionMode('all');
    camera.zoom(-50, true);
    camera.setInteractionMode('orbit'); // zoom requires exactly 'all'

    assert.strictEqual(
      camera.update(16),
      false,
      'a decaying zoom refused by interactionMode must not keep the animator reporting isAnimating',
    );
    const frozenPose = poseOf(camera);

    camera.setInteractionMode('all');
    camera.update(16);
    assert.deepStrictEqual(
      poseOf(camera),
      frozenPose,
      'a rejected zoom\'s leftover velocity must not survive to jump the camera once the mode is lifted',
    );
  });

  it('all three gestures decaying at once: mode flips to none -- a single tick reports not-animating', () => {
    const camera = freshCamera();
    camera.setInteractionMode('all');
    camera.orbit(50, 0, true);
    camera.pan(50, 0, true);
    camera.zoom(-50, true);
    camera.setInteractionMode('none');

    assert.strictEqual(
      camera.update(16),
      false,
      'with every channel refused, a single tick must report isAnimating: false',
    );
  });
});
