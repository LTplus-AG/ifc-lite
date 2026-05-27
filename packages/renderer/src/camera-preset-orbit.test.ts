/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { Camera } from './camera.ts';
import { CAMERA_CONSTANTS as CC } from './constants.ts';
import type { Vec3 } from './types.ts';

type PresetView = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

function len(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function clampUnit(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function phiFromCamera(camera: Camera): number {
  const position = camera.getPosition();
  const target = camera.getTarget();
  const dir = {
    x: position.x - target.x,
    y: position.y - target.y,
    z: position.z - target.z,
  };
  return Math.acos(clampUnit(dir.y / len(dir)));
}

function approxEqual(actual: number, expected: number, epsilon = 1e-6): void {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} ~= ${expected} (diff ${Math.abs(actual - expected)})`,
  );
}

function finishPreset(camera: Camera, view: PresetView): void {
  const originalNow = Date.now;
  const hadRequestAnimationFrame = Object.prototype.hasOwnProperty.call(globalThis, 'requestAnimationFrame');
  const originalRequestAnimationFrame = Reflect.get(globalThis, 'requestAnimationFrame');
  let now = 1_000;

  Date.now = () => now;
  Reflect.set(globalThis, 'requestAnimationFrame', () => 0);

  try {
    camera.setPresetView(view);
    now += 400;
    camera.update(0);
  } finally {
    Date.now = originalNow;
    if (hadRequestAnimationFrame) {
      Reflect.set(globalThis, 'requestAnimationFrame', originalRequestAnimationFrame);
    } else {
      Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    }
  }
}

describe('Camera preset orbit behavior', () => {
  it('top preset starts on MIN_PHI with world Y-up and no first-orbit phi snap', () => {
    const camera = new Camera();
    finishPreset(camera, 'top');

    approxEqual(phiFromCamera(camera), CC.MIN_PHI, 1e-6);
    approxEqual(camera.getUp().x, 0);
    approxEqual(camera.getUp().y, 1);
    approxEqual(camera.getUp().z, 0);

    const beforePhi = phiFromCamera(camera);
    camera.orbit(100, 0);
    approxEqual(phiFromCamera(camera), beforePhi, 1e-6);
  });

  it('top preset ignores off-axis click pivot while near pole to prevent sideways drift', () => {
    const camera = new Camera();
    finishPreset(camera, 'top');
    camera.setOrbitCenter({ x: 25, y: 0, z: -15 });

    camera.orbit(0, -50);

    approxEqual(camera.getPosition().x, 0, 1e-6);
  });

  it('bottom preset starts on MAX_PHI and does not snap on first horizontal orbit', () => {
    const camera = new Camera();
    finishPreset(camera, 'bottom');

    approxEqual(phiFromCamera(camera), CC.MAX_PHI, 1e-6);
    approxEqual(camera.getUp().x, 0);
    approxEqual(camera.getUp().y, 1);
    approxEqual(camera.getUp().z, 0);

    const beforePhi = phiFromCamera(camera);
    camera.orbit(100, 0);
    approxEqual(phiFromCamera(camera), beforePhi, 1e-6);
  });

  it('side presets start at the horizon and do not lift on first horizontal orbit', () => {
    const sideViews: Array<'front' | 'back' | 'left' | 'right'> = ['front', 'back', 'left', 'right'];

    for (const view of sideViews) {
      const camera = new Camera();
      finishPreset(camera, view);
      const beforePhi = phiFromCamera(camera);
      approxEqual(beforePhi, Math.PI / 2, 1e-6);

      camera.orbit(100, 0);
      approxEqual(phiFromCamera(camera), beforePhi, 1e-6);
    }
  });
});
