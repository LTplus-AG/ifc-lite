/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { Camera } from './camera.js';

const BOUNDS = { min: { x: -5, y: 0, z: -5 }, max: { x: 5, y: 10, z: 5 } };

/** Drive the wall clock the tween reads and keep its completion poll inert. */
function withClock(run: (advance: (ms: number) => void) => void): void {
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
    if (hadRaf) Reflect.set(globalThis, 'requestAnimationFrame', originalRaf);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  }
}

describe('Camera.isTweening (#5841)', () => {
  it('is false for a camera that has not been told to tween', () => {
    assert.equal(new Camera().isTweening(), false);
  });

  it('stays true until an update() applies the final pose, however much wall time passes', () => {
    withClock((advance) => {
      const camera = new Camera();
      camera.setPresetView('top', BOUNDS);
      assert.equal(camera.isTweening(), true, 'a preset starts a tween at once');

      // A stalled render loop: the tween's time is long over, but no frame ran.
      advance(5_000);
      assert.equal(camera.isTweening(), true, 'elapsed time alone does not finish a tween');

      camera.update(16);
      assert.equal(camera.isTweening(), false, 'the update that applies the final pose finishes it');
    });
  });

  it('is true across the intermediate frames, so an intermediate pose is never taken for the final one', () => {
    withClock((advance) => {
      const camera = new Camera();
      camera.setPresetView('top', BOUNDS);
      advance(100);
      camera.update(16);
      assert.equal(camera.isTweening(), true, 'mid-tween');
      advance(100);
      camera.update(16);
      assert.equal(camera.isTweening(), true, 'still mid-tween');
      advance(200);
      camera.update(16);
      assert.equal(camera.isTweening(), false);
    });
  });

  it('is false again once another pose change supersedes the tween', () => {
    withClock(() => {
      const camera = new Camera();
      camera.setPresetView('top', BOUNDS);
      camera.setRotation(200, 20);
      assert.equal(camera.isTweening(), false);
    });
  });
});
