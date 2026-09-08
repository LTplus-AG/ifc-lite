/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Walk mode is a mode, and `enableFirstPersonMode` is what turns it on.
 *
 * It was not. The flag was written and never read — `moveFirstPerson` walked
 * the camera whether or not walk mode had ever been entered — and the only
 * thing hiding that in the app was the viewer's *second*, independent check on
 * `activeTool === 'walk'` in `useKeyboardControls`. Two unrelated gates for one
 * decision means neither is load-bearing on its own, and `@ifc-lite/renderer`
 * is published: an embedder wiring its own key handler to `moveFirstPerson`
 * has only this one. Pre-existing on `origin/main` (the flag lived on
 * `CameraAnimator` there, equally unread); the module split is what made it
 * visible (PR #2500, issue #2460).
 *
 * The velocity half is the same defect's tail: `walkVelocity` is smoothed in
 * place, so whatever the user was walking when they left walk mode — or loaded
 * a different model — was still there to be spent on the first frame after
 * they came back.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { Camera } from './camera.js';
import type { Vec3 } from './types.js';

function poseOf(camera: Camera): { position: Vec3; target: Vec3 } {
  return { position: camera.getPosition(), target: camera.getTarget() };
}

/** A camera on a perfectly ordinary pose, facing along -Z. */
function walkerCamera(): Camera {
  const camera = new Camera();
  camera.setAspect(16 / 9);
  camera.setPosition(0, 2, 50);
  camera.setTarget(0, 2, 0);
  return camera;
}

describe('first-person mode gates first-person movement (#2500)', () => {
  it('a fresh camera does not walk', () => {
    // `isFirstPersonMode` starts false and nothing has enabled it, so this is
    // the state an embedder is in before it ever opts into walk mode.
    const camera = walkerCamera();
    const before = poseOf(camera);
    for (let i = 0; i < 10; i++) camera.moveFirstPerson(1, 0, 0);
    assert.deepStrictEqual(poseOf(camera), before, 'a camera that never entered walk mode must not move');
  });

  it('stops walking again once the mode is turned off', () => {
    const camera = walkerCamera();
    camera.enableFirstPersonMode(true);
    camera.moveFirstPerson(1, 0, 0);
    const walked = poseOf(camera);
    assert.notDeepStrictEqual(walked, poseOf(walkerCamera()), 'control: walking must work while enabled');

    camera.enableFirstPersonMode(false);
    for (let i = 0; i < 10; i++) camera.moveFirstPerson(1, 0, 0);
    assert.deepStrictEqual(poseOf(camera), walked, 'the camera must not move after walk mode is left');
  });

  it('does not lurch on the first frame after walk mode is re-entered', () => {
    // `walkVelocity` is accumulated with `+= (target - current) * 0.15`, so a
    // velocity built up before leaving walk mode was still 85% intact on
    // return and got spent in whatever direction the user had been walking.
    const primed = walkerCamera();
    primed.enableFirstPersonMode(true);
    for (let i = 0; i < 20; i++) primed.moveFirstPerson(1, 0, 0);
    primed.enableFirstPersonMode(false);
    primed.setPosition(0, 2, 50);
    primed.setTarget(0, 2, 0);
    primed.enableFirstPersonMode(true);
    primed.moveFirstPerson(1, 0, 0);
    const primedStep = 50 - primed.getPosition().z;

    const fresh = walkerCamera();
    fresh.enableFirstPersonMode(true);
    fresh.moveFirstPerson(1, 0, 0);
    const freshStep = 50 - fresh.getPosition().z;

    assert.ok(
      Math.abs(primedStep - freshStep) < 1e-9,
      `first step after re-entry was ${primedStep}, a fresh first step is ${freshStep}`,
    );
  });

  it('drops the accumulated walk velocity on model reset', () => {
    // `reset()` is the model-swap hook. The walk velocity survived it — it
    // used to live on `CameraAnimator`, whose `reset()` did not clear it
    // either — so the first walk frame on a newly loaded model carried the
    // previous model's momentum.
    const carried = walkerCamera();
    carried.enableFirstPersonMode(true);
    for (let i = 0; i < 20; i++) carried.moveFirstPerson(1, 0, 0);
    carried.reset();
    carried.setPosition(0, 2, 50);
    carried.setTarget(0, 2, 0);
    carried.moveFirstPerson(1, 0, 0);
    const carriedStep = 50 - carried.getPosition().z;

    const fresh = walkerCamera();
    fresh.enableFirstPersonMode(true);
    fresh.moveFirstPerson(1, 0, 0);
    const freshStep = 50 - fresh.getPosition().z;

    assert.ok(
      Math.abs(carriedStep - freshStep) < 1e-9,
      `first step after reset was ${carriedStep}, a fresh first step is ${freshStep}`,
    );
  });

  it('anti-mutation: reset does not silently leave walk mode', () => {
    // The mode mirrors the viewer's active tool, which a model load does not
    // change, and no effect re-runs to restore it. Clearing it in `reset()`
    // would leave walk mode dead until the user toggled the tool twice — a
    // regression the tests above could not see, because they all re-enable.
    const camera = walkerCamera();
    camera.enableFirstPersonMode(true);
    camera.reset();
    const before = poseOf(camera);
    camera.moveFirstPerson(1, 0, 0);
    assert.notDeepStrictEqual(poseOf(camera), before, 'walk mode must survive a model reset');
  });
});
