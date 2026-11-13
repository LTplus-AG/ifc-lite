/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's DriverCamera adapter for the 3Dconnexion driver path (#9131).
 * Invariants: a pose the driver writes keeps the horizon level (world up)
 * except when looking straight up or down, inertia is stopped before every
 * write, and the scene bounds reach the driver in [x, y, z] form.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDriverCamera, type DriverRendererHost } from './spaceMouseDriverCamera.js';
import { createNavigationModel } from '@/lib/spacemouse-driver/model';

type XYZ = { x: number; y: number; z: number };

function fakeRenderer(bounds: { min: XYZ; max: XYZ } | null = null) {
  const s = {
    pos: { x: 0, y: 2, z: 10 } as XYZ,
    target: { x: 0, y: 2, z: 0 } as XYZ,
    up: { x: 0, y: 1, z: 0 } as XYZ,
    fov: Math.PI / 4,
    inertiaStops: 0,
    renders: 0,
  };
  const canvas = {} as HTMLElement;
  const renderer: DriverRendererHost = {
    getCamera: () => ({
      getPosition: () => ({ ...s.pos }),
      getTarget: () => ({ ...s.target }),
      getUp: () => ({ ...s.up }),
      setPosition: (x, y, z) => { s.pos = { x, y, z }; },
      setTarget: (x, y, z) => { s.target = { x, y, z }; },
      setUp: (x, y, z) => { s.up = { x, y, z }; },
      getFOV: () => s.fov,
      setFOV: (rad) => { s.fov = rad; },
      getAspect: () => 1.5,
      stopInertia: () => { s.inertiaStops++; },
    }),
    getCanvas: () => canvas,
    getScene: () => ({ getBounds: () => bounds }),
    requestRender: () => { s.renders++; },
  };
  return { renderer, s, canvas };
}

test('a tilted driver up vector is replaced by world up, so the horizon stays level', () => {
  const { renderer, s } = fakeRenderer();
  createDriverCamera(renderer).setPose([5, 3, 5], [0, 0, 0], [0.3, 0.9, 0.1]);
  assert.deepEqual(s.pos, { x: 5, y: 3, z: 5 });
  assert.deepEqual(s.target, { x: 0, y: 0, z: 0 });
  assert.deepEqual(s.up, { x: 0, y: 1, z: 0 });
  assert.equal(s.inertiaStops, 1, 'inertia is stopped before the driver writes a pose');
});

test('looking straight down keeps the driver up vector (world up would be degenerate)', () => {
  const { renderer, s } = fakeRenderer();
  createDriverCamera(renderer).setPose([0, 10, 0], [0, 0, 0], [0, 0, -1]);
  assert.deepEqual(s.up, { x: 0, y: 0, z: -1 });
});

test('pose, fov, aspect and bounds are read from the renderer in driver form', () => {
  const { renderer, canvas } = fakeRenderer({ min: { x: -1, y: 0, z: -2 }, max: { x: 3, y: 4, z: 5 } });
  const cam = createDriverCamera(renderer);
  assert.equal(cam.canvas, canvas);
  assert.deepEqual(cam.getPose(), { pos: [0, 2, 10], target: [0, 2, 0], up: [0, 1, 0] });
  assert.equal(cam.getFov(), Math.PI / 4);
  assert.equal(cam.getAspect(), 1.5);
  assert.deepEqual(cam.getBounds(), { min: [-1, 0, -2], max: [3, 4, 5] });
  assert.equal(createDriverCamera(fakeRenderer(null).renderer).getBounds(), null);
});

test('a driver dolly through the navigation model moves the viewer camera and requests a frame', () => {
  const { renderer, s } = fakeRenderer({ min: { x: -5, y: 0, z: -5 }, max: { x: 5, y: 4, z: 5 } });
  const model = createNavigationModel(createDriverCamera(renderer), { pointer: () => [0, 0] });
  const m = model.getViewMatrix();
  m[14] = 6; // the driver moved the camera 4 units forward
  model.setViewMatrix(m);
  assert.deepEqual(s.pos, { x: 0, y: 2, z: 6 });
  assert.deepEqual(s.target, { x: 0, y: 2, z: 0 });
  assert.equal(s.renders, 1);
});
