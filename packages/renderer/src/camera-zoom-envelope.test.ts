/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Camera } from './camera.js';
import { MAX_RTE_SOURCE_ABS_METRES as LIMIT } from './relative-to-eye.js';

const pose = (camera: Camera) => ({ position: { ...camera.getPosition() }, target: { ...camera.getTarget() }, size: camera.getOrthoSize() });

function assertSupported(camera: Camera): void {
  assert.equal(camera.getRelativeToEyeFrame().isAvailable(), true);
  assert.ok(camera.getViewProjMatrix().m.every(Number.isFinite));
  for (const point of [camera.getPosition(), camera.getTarget()]) {
    for (const coordinate of [point.x, point.y, point.z]) assert.ok(Math.abs(coordinate) <= LIMIT);
  }
}

describe('#7493 repeated zoom stays inside the renderer camera envelope', () => {
  for (const anchored of [false, true]) {
    it(`bounds repeated positive wheel deltas and permits reverse zoom (anchor=${anchored})`, () => {
      const camera = new Camera();
      const originalDistance = camera.getDistance();
      for (let i = 0; i < 600; i++) {
        camera.zoom(120, false, ...(anchored ? [700, 100, 800, 600] as const : [] as const));
        assertSupported(camera);
      }
      assert.ok(camera.getDistance() > originalDistance * 100, 'zoom-out must actually travel');
      const boundary = pose(camera);
      camera.zoom(120, false, ...(anchored ? [700, 100, 800, 600] as const : [] as const));
      assert.deepEqual(pose(camera), boundary, 'unsafe notch preserves the whole pose');
      camera.zoom(-120, false, ...(anchored ? [700, 100, 800, 600] as const : [] as const));
      assert.notDeepEqual(pose(camera), boundary, 'opposite input remains usable');
      assertSupported(camera);
    });
  }

  it('rolls back a rejected fast dolly, including the external orbit pivot', () => {
    const camera = new Camera();
    const control = new Camera();
    for (const c of [camera, control]) {
      c.setPosition(LIMIT - 1, 20, 30);
      c.setTarget(LIMIT - 101, 20, 30);
      c.setOrbitCenter({ x: LIMIT - 101, y: 20, z: 30 });
    }
    const before = pose(camera);
    camera.zoom(120, true, 600, 300, 800, 600, true);
    assert.deepEqual(pose(camera), before);
    assert.equal(camera.update(16), false, 'rejected input must not seed inertia');
    // A later orbit is observable evidence that the hidden pivot was restored too.
    camera.orbit(0.1, 0.1);
    control.orbit(0.1, 0.1);
    assert.deepEqual(pose(camera), pose(control));
  });

  it('refuses an unsafe inertia tick without leaving an unavailable frame', () => {
    const camera = new Camera();
    camera.setPosition(LIMIT - 11, 0, 0);
    camera.setTarget(LIMIT - 111, 0, 0);
    camera.zoom(120, true);
    assertSupported(camera);
    for (let i = 0; i < 500; i++) {
      camera.update(16);
      assertSupported(camera);
    }
    const before = pose(camera);
    camera.zoom(-120);
    assert.notDeepEqual(pose(camera), before);
  });

  it('bounds orthographic cursor translation atomically without changing centred zoom', () => {
    const camera = new Camera();
    camera.setProjectionMode('orthographic');
    camera.setPosition(LIMIT - 1, 0, 100);
    camera.setTarget(LIMIT - 1, 0, 0);
    camera.setOrthoSize(100);
    const before = pose(camera);
    camera.zoom(120, false, 0, 300, 800, 600);
    assert.deepEqual(pose(camera), before, 'restore ortho size together with rejected anchor');
    camera.zoom(120);
    assert.equal(camera.getOrthoSize(), 110.00000000000001);
    assert.deepEqual(camera.getPosition(), before.position);
    camera.zoom(-120, false, 0, 300, 800, 600);
    assertSupported(camera);
    assert.ok(camera.getTarget().x < before.target.x);
  });

  it('keeps high-offset georeferenced zoom equivalent to the local pose', () => {
    const local = new Camera();
    const translated = new Camera();
    const offset = 900_000_000;
    translated.setPosition(50 + offset, 50 + offset, 100 + offset);
    translated.setTarget(offset, offset, offset);
    for (const delta of [120, -120, 20, -40]) {
      local.zoom(delta, false, 700, 100, 800, 600);
      translated.zoom(delta, false, 700, 100, 800, 600);
      assertSupported(translated);
    }
    for (const axis of ['x', 'y', 'z'] as const) {
      assert.ok(Math.abs(translated.getPosition()[axis] - offset - local.getPosition()[axis]) < 1e-5);
      assert.ok(Math.abs(translated.getTarget()[axis] - offset - local.getTarget()[axis]) < 1e-5);
    }
  });

  it('does not publish an out-of-envelope surface zoom or apply non-finite deltas', () => {
    const camera = new Camera();
    camera.setPosition(LIMIT - 10, 0, 0);
    camera.setTarget(LIMIT - 1, 0, 0);
    const before = pose(camera);
    const surface = { x: LIMIT + 1000, y: 0, z: 0 };
    for (const delta of [Number.NaN, Infinity, -Infinity, -120]) {
      camera.zoom(delta, true, 400, 300, 800, 600, false, surface);
      assert.deepEqual(pose(camera), before);
      assertSupported(camera);
    }
    camera.zoom(-120, false, 400, 300, 800, 600, false, { x: LIMIT - 2, y: 0, z: 0 });
    assert.ok(camera.getPosition().x > before.position.x, 'valid surface zoom still moves');
    assertSupported(camera);
  });
});
