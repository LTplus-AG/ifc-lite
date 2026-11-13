/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rotate left/right turns a plan view too (#9501). A top preset looks exactly
 * along the vertical, so its position has no horizontal offset to turn and
 * the screen orientation lives in `up`; turning only the position did nothing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@ifc-lite/renderer';
import { rotateAboutVertical } from './viewpoint-rotate-vertical.js';

type Vec3 = { x: number; y: number; z: number };

/** Where the world direction `d` from the target lands on a 800x600 screen, relative to the target. */
function onScreen(pose: { position: Vec3; target: Vec3; up: Vec3 }, d: Vec3): { x: number; y: number } {
  const camera = new Camera();
  camera.setAspect(800 / 600);
  camera.setPosition(pose.position.x, pose.position.y, pose.position.z);
  camera.setTarget(pose.target.x, pose.target.y, pose.target.z);
  camera.setUp(pose.up.x, pose.up.y, pose.up.z);
  const t = pose.target;
  const o = camera.projectToScreen(t, 800, 600)!;
  const p = camera.projectToScreen({ x: t.x + d.x, y: t.y + d.y, z: t.z + d.z }, 800, 600)!;
  return { x: p.x - o.x, y: p.y - o.y };
}

const angleOf = (v: { x: number; y: number }) => Math.atan2(v.y, v.x);

describe('rotateAboutVertical', () => {
  it('turns a top-down plan by the step, about the screen centre (#9501)', () => {
    const plan = { position: { x: 2, y: 20, z: 3 }, target: { x: 2, y: 0, z: 3 }, up: { x: 0, y: 0, z: -1 } };
    const turned = rotateAboutVertical(plan, Math.PI / 2);
    assert.deepEqual(turned.target, plan.target);
    assert.deepEqual([turned.position.x, turned.position.z], [2, 3], 'still straight above the target');
    const east = { x: 1, y: 0, z: 0 };
    const spin = angleOf(onScreen(turned, east)) - angleOf(onScreen(plan, east));
    const wrapped = Math.abs(((spin * 180 / Math.PI) + 540) % 360 - 180);
    assert.ok(Math.abs(wrapped - 90) < 1e-6, `the plan turned ${wrapped} degrees`);
    // The same way the step turns an oblique view: there the camera's offset
    // goes +X -> -Z; a plan's offset-equivalent is opposite screen-up, so
    // screen-up -Z (offset +Z) turns to -X (offset +X).
    assert.ok(Math.abs(turned.up.x + 1) < 1e-9 && Math.abs(turned.up.z) < 1e-9, `screen-up ${JSON.stringify(turned.up)}`);
  });

  it('matches the orbit convention for an oblique view, whose up stays world Y', () => {
    const view = { position: { x: 10, y: 5, z: 0 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } };
    const turned = rotateAboutVertical(view, Math.PI / 2);
    assert.ok(Math.abs(turned.position.x) < 1e-9 && Math.abs(turned.position.z + 10) < 1e-9, JSON.stringify(turned.position));
    assert.equal(turned.position.y, 5);
    assert.deepEqual(turned.up, { x: 0, y: 1, z: 0 });
  });
});
