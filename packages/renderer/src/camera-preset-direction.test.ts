/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { Camera } from './camera.js';

const BOUNDS = { min: { x: -5, y: 0, z: -5 }, max: { x: 5, y: 10, z: 5 } };

function settle(camera: Camera, direction: { x: number; y: number; z: number }, rotation?: number): { x: number; y: number; z: number } {
  const originalNow = Date.now;
  const hadRaf = Object.prototype.hasOwnProperty.call(globalThis, 'requestAnimationFrame');
  const originalRaf = Reflect.get(globalThis, 'requestAnimationFrame');
  let now = 1_000;
  Date.now = () => now;
  Reflect.set(globalThis, 'requestAnimationFrame', () => 0);
  try {
    camera.setPresetDirection(direction, BOUNDS, rotation);
    now += 400;
    camera.update(0);
  } finally {
    Date.now = originalNow;
    if (hadRaf) Reflect.set(globalThis, 'requestAnimationFrame', originalRaf);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  }
  const p = camera.getPosition();
  const t = camera.getTarget();
  const d = { x: p.x - t.x, y: p.y - t.y, z: p.z - t.z };
  const len = Math.hypot(d.x, d.y, d.z);
  return { x: d.x / len, y: d.y / len, z: d.z / len };
}

function assertDir(actual: { x: number; y: number; z: number }, expected: { x: number; y: number; z: number }): void {
  const len = Math.hypot(expected.x, expected.y, expected.z);
  for (const axis of ['x', 'y', 'z'] as const) {
    assert.ok(Math.abs(actual[axis] - expected[axis] / len) < 1e-6, `${axis}: ${actual[axis]} vs ${expected[axis] / len}`);
  }
}

describe('Camera.setPresetDirection', () => {
  it('looks at the model from an edge direction, framed on the bounds centre', () => {
    const camera = new Camera();
    assertDir(settle(camera, { x: 1, y: 1, z: 0 }), { x: 1, y: 1, z: 0 });
    assert.deepStrictEqual(camera.getTarget(), { x: 0, y: 5, z: 0 });
  });

  it('looks at the model from a corner direction', () => {
    assertDir(settle(new Camera(), { x: -1, y: 1, z: 1 }), { x: -1, y: 1, z: 1 });
  });

  it('turns the horizontal part with the building rotation, like the named presets', () => {
    // Front edge turned a quarter turn: +Z becomes +X (front preset -> x = sin).
    assertDir(settle(new Camera(), { x: 0, y: 1, z: 1 }, Math.PI / 2), { x: 1, y: 1, z: 0 });
  });

  it('ignores a direction with no horizontal heading or no length', () => {
    for (const bad of [{ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }, { x: NaN, y: 1, z: 1 }, { x: NaN, y: 0, z: 0 }, { x: 1, y: 0, z: NaN }, { x: Infinity, y: 0, z: 1 }]) {
      const camera = new Camera();
      const before = { position: camera.getPosition(), target: camera.getTarget() };
      // Time is advanced past the tween like the accepting cases, so a missing
      // guard would have moved the camera by now.
      settle(camera, bad);
      assert.deepStrictEqual(camera.getPosition(), before.position);
      assert.deepStrictEqual(camera.getTarget(), before.target);
    }
  });
});
