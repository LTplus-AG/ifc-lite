/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fly navigation maths. The screen-direction cases project through the real
 * renderer `Camera`, so "mouse right turns right" and "D strafes right" are
 * checked against what the user actually sees, not against a sign convention
 * restated in the test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@ifc-lite/renderer';
import {
  baseFlySpeed,
  createWheelStepper,
  flyDirection,
  flyLook,
  flyTranslate,
  type FlyPose,
  type Vec3,
} from './flyNavigation.js';

const W = 800;
const H = 600;

function cameraAt(pose: FlyPose): Camera {
  const camera = new Camera();
  camera.setAspect(W / H);
  camera.setPosition(pose.position.x, pose.position.y, pose.position.z);
  camera.setTarget(pose.target.x, pose.target.y, pose.target.z);
  return camera;
}

/** Screen position of a world point, as the user would see it through `pose`. */
function screenOf(pose: FlyPose, p: Vec3): { x: number; y: number } {
  const s = cameraAt(pose).projectToScreen(p, W, H);
  assert.ok(s, 'test point must be in front of the camera');
  return s;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// Looking along -Z from (0, 1.6, 10), a slightly skewed start so no axis is degenerate.
const START: FlyPose = { position: { x: 0, y: 1.6, z: 10 }, target: { x: 0.3, y: 1.6, z: 0 } };

describe('flyLook', () => {
  it('rotates around the camera: position fixed, look distance kept', () => {
    const next = flyLook(START, 40, -25);
    assert.ok(next);
    assert.deepEqual(next.position, START.position);
    assert.ok(Math.abs(dist(next.position, next.target) - dist(START.position, START.target)) < 1e-9);
  });

  it('mouse right turns the view right, mouse up looks up', () => {
    const right = flyLook(START, 50, 0)!;
    // The new look point, seen through the OLD camera, sits right of centre.
    assert.ok(screenOf(START, right.target).x > W / 2 + 1);

    const up = flyLook(START, 0, -50)!;
    assert.ok(screenOf(START, up.target).y < H / 2 - 1, 'screen y grows downward');
  });

  it('clamps pitch short of vertical, so a huge drag cannot flip the view', () => {
    const next = flyLook(START, 0, -1e6)!;
    const look = { x: next.target.x - next.position.x, z: next.target.z - next.position.z };
    assert.ok(Math.hypot(look.x, look.z) > 1e-4, 'still has a horizontal heading');
    assert.ok(next.target.y > next.position.y);
  });

  it('rejects non-finite input instead of writing it into the pose', () => {
    assert.equal(flyLook(START, NaN, 0), null);
    assert.equal(flyLook(START, 0, Infinity), null);
    assert.equal(flyLook({ position: START.position, target: { x: NaN, y: 0, z: 0 } }, 1, 1), null);
    assert.equal(flyLook({ position: START.position, target: START.position }, 1, 1), null);
  });
});

describe('flyDirection', () => {
  const pitchedDown: FlyPose = { position: { x: 0, y: 10, z: 10 }, target: { x: 0, y: 0, z: 0 } };

  it('W flies along the look direction, pitch included', () => {
    const d = flyDirection(pitchedDown, { forward: 1, right: 0, up: 0 });
    assert.ok(d.y < -0.7 && d.z < -0.7, `expected down-and-forward, got ${JSON.stringify(d)}`);
    assert.ok(Math.abs(Math.hypot(d.x, d.y, d.z) - 1) < 1e-9);
  });

  it('D strafes to the right of the screen, horizontally', () => {
    const d = flyDirection(START, { forward: 0, right: 1, up: 0 });
    assert.equal(d.y, 0);
    const probe = { x: START.target.x + d.x, y: START.target.y, z: START.target.z + d.z };
    assert.ok(screenOf(START, probe).x > W / 2 + 1);
  });

  it('E rises along world up whatever the pitch', () => {
    assert.deepEqual(flyDirection(pitchedDown, { forward: 0, right: 0, up: 1 }), { x: 0, y: 1, z: 0 });
  });

  it('normalises diagonals so W+D is not faster than W', () => {
    const d = flyDirection(START, { forward: 1, right: 1, up: 1 });
    assert.ok(Math.abs(Math.hypot(d.x, d.y, d.z) - 1) < 1e-9);
  });
});

describe('flyTranslate', () => {
  it('moves position and target together, and refuses a non-finite offset', () => {
    const next = flyTranslate(START, { x: 1, y: 2, z: 3 })!;
    assert.deepEqual(next.position, { x: 1, y: 3.6, z: 13 });
    assert.deepEqual(next.target, { x: 1.3, y: 3.6, z: 3 });
    assert.equal(flyTranslate(START, { x: NaN, y: 0, z: 0 }), null);
  });
});

describe('baseFlySpeed', () => {
  it('scales with the scene and stays usable without bounds', () => {
    const house = baseFlySpeed({ min: { x: 0, y: 0, z: 0 }, max: { x: 12, y: 9, z: 16 } });
    const campus = baseFlySpeed({ min: { x: 0, y: 0, z: 0 }, max: { x: 1200, y: 60, z: 900 } });
    assert.ok(campus > house * 10);
    assert.ok(Number.isFinite(baseFlySpeed(null)) && baseFlySpeed(null) > 0);
  });
});

describe('createWheelStepper', () => {
  it('one mouse notch is exactly one step; wheel up is faster', () => {
    const step = createWheelStepper();
    assert.equal(step(-100, 0), 1);
    assert.equal(step(120, 0), -1);
    assert.equal(step(3, 1), -1, 'Firefox line-mode notch');
  });

  it('accumulates small trackpad deltas into steps', () => {
    const step = createWheelStepper();
    let total = 0;
    for (let i = 0; i < 25; i++) total += step(-10, 0);
    assert.equal(total, 2);
  });
});
