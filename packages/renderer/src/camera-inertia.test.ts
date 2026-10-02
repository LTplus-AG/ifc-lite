/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Inertia coasts by elapsed time, not by frames: the same gesture comes to
 * rest at the same pose whether `Camera.update` ticks at 120 Hz, 60 Hz or
 * 20 Hz, and a 60 Hz tick behaves as the per-frame loop always did.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { Camera } from './camera.js';
import type { Vec3 } from './types.js';
import { inertiaStep, INERTIA_REFERENCE_FRAME_MS, MAX_INERTIA_TICK_MS } from './camera-inertia.js';

const DAMPING = 0.92;

function angleDegrees(a: Vec3, b: Vec3): number {
  const cos = (a.x * b.x + a.y * b.y + a.z * b.z) / (Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z));
  return (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
}

/**
 * Degrees the camera coasts after a half-second drag that moves 1 unit every
 * 4 ms, with `update` ticking every `tickMs` during the drag and after it.
 */
function coastDegrees(tickMs: number): number {
  const camera = new Camera();
  camera.setAspect(16 / 9);
  camera.setPosition(20, 20, 20);
  camera.setTarget(0, 0, 0);
  let nextTick = tickMs;
  for (let ms = 4; ms <= 500; ms += 4) {
    camera.orbit(1, 0, true);
    for (; nextTick <= ms; nextTick += tickMs) camera.update(tickMs);
  }
  const release = camera.getPosition();
  for (let ms = 0; ms < 10_000 && camera.update(tickMs); ms += tickMs);
  return angleDegrees(release, camera.getPosition());
}

describe('camera inertia runs on elapsed time', () => {
  it('coasts within 15% of the 60 Hz angle at 120 and 30 Hz', () => {
    const at60 = coastDegrees(1000 / 60);
    assert.ok(at60 > 1, `the drag coasts (${at60} deg)`);
    for (const tickMs of [1000 / 120, 1000 / 30]) {
      const coast = coastDegrees(tickMs);
      assert.ok(Math.abs(coast - at60) / at60 < 0.15, `${tickMs.toFixed(1)} ms ticks coast ${coast} deg, 60 Hz coasts ${at60} deg`);
    }
  });

  it('spends one 60 Hz tick as one frame of the per-frame loop', () => {
    const step = inertiaStep(INERTIA_REFERENCE_FRAME_MS, DAMPING);
    assert.ok(Math.abs(step.travel - 1) < 1e-12);
    assert.ok(Math.abs(step.decay - DAMPING) < 1e-12);
  });

  it('composes: two half ticks travel and decay as one full tick', () => {
    const half = inertiaStep(INERTIA_REFERENCE_FRAME_MS / 2, DAMPING);
    const full = inertiaStep(INERTIA_REFERENCE_FRAME_MS, DAMPING);
    assert.ok(Math.abs(half.travel + half.decay * half.travel - full.travel) < 1e-12);
    assert.ok(Math.abs(half.decay * half.decay - full.decay) < 1e-12);
  });

  it('counts a missing or malformed tick as one 60 Hz frame', () => {
    for (const ms of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepStrictEqual(inertiaStep(ms, DAMPING), inertiaStep(INERTIA_REFERENCE_FRAME_MS, DAMPING), `tick ${ms}`);
    }
  });

  it('caps a tick after a stall instead of spending the whole coast at once', () => {
    assert.deepStrictEqual(inertiaStep(5_000, DAMPING), inertiaStep(MAX_INERTIA_TICK_MS, DAMPING));
  });
});
