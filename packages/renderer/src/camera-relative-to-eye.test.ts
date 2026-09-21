/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Camera } from './camera.js';
import { MathUtils } from './math.js';
import { RelativeToEyeFrame } from './relative-to-eye.js';

describe('production camera RTE consumers (#5049)', () => {
  it('keeps a rejected RTE update atomic and matrices privately owned', () => {
    const frame = new RelativeToEyeFrame();
    frame.update({ x: 5_000_000.25, y: 2, z: 3 }, MathUtils.identity(), MathUtils.identity());
    const before = frame.snapshot();
    for (const x of [NaN, Infinity, 1_000_000_001]) {
      assert.throws(() => frame.update({ x, y: 0, z: 0 }, MathUtils.identity(), MathUtils.identity()));
      assert.equal(frame.getRenderEpoch(), before.renderEpoch);
      assert.deepEqual(frame.getCameraWorld(), before.getCameraWorld());
      assert.deepEqual(frame.getViewProjection(), before.getViewProjection());
    }
    const bad = MathUtils.identity(); bad.m[0] = NaN;
    assert.throws(() => frame.update({ x: 1, y: 2, z: 3 }, bad, MathUtils.identity()), /finite/);
    frame.getViewProjection().m.fill(99);
    assert.deepEqual(frame.getViewProjection(), before.getViewProjection());
    const camera = new Camera();
    const original = camera.getViewProjMatrix();
    camera.getViewProjMatrix().m.fill(99);
    assert.deepEqual(camera.getViewProjMatrix(), original);
  });

  it('preserves raw malformed poses while using the same scrubbed eye as lookAt', () => {
    const camera = new Camera();
    for (const x of [NaN, Infinity, -Infinity]) {
      assert.doesNotThrow(() => camera.setPosition(x, 2, 10));
      assert.ok(Object.is(camera.getPosition().x, x));
      assert.deepEqual(camera.getRelativeToEyeFrame().getCameraWorld(), [0, 2, 10]);
      const ray = camera.unprojectToRay(400, 300, 800, 600);
      assert.deepEqual(ray.origin, { x: 0, y: 2, z: 10 });
      assert.ok(Object.values(ray.direction).every(Number.isFinite));
    }
    const old = camera.getRelativeToEyeFrame().snapshot();
    assert.doesNotThrow(() => camera.setPosition(1_000_000_001, 2, 10));
    assert.equal(camera.getRelativeToEyeFrame().isAvailable(), false);
    assert.throws(() => camera.getRelativeToEyeFrame().snapshot(), /envelope/);
    assert.deepEqual(old.getCameraWorld(), [0, 2, 10], 'queued readback keeps its original frame');
    camera.setPosition(5_000_000, 2, 10);
    assert.equal(camera.getRelativeToEyeFrame().isAvailable(), true);
    assert.deepEqual(camera.getRelativeToEyeFrame().getCameraWorld(), [5_000_000, 2, 10]);
  });

  for (const mode of ['perspective', 'orthographic'] as const) {
    it(`preserves screen positions and source-space ray hits under survey translation (${mode})`, () => {
      const cameras = [0, 5_000_000].map(offset => {
        const camera = new Camera();
        camera.setAspect(4 / 3);
        camera.setPosition(offset + 3, offset + 4, offset + 10);
        camera.setTarget(offset, offset, offset);
        camera.setProjectionMode(mode);
        camera.setOrthoSize(10);
        return camera;
      });
      const localPoints = [{ x: 0.03125, y: 0.0625, z: 0 }, { x: 0.0625, y: 0.0625, z: 0 }];
      const hits = cameras.map((camera, index) => {
        const offset = index * 5_000_000;
        return localPoints.map(local => {
          const world = Object.freeze({ x: local.x + offset, y: local.y + offset, z: offset });
          const screen = camera.projectToScreen(world, 800, 600);
          assert.ok(screen);
          const nearScreen = cameras[0].projectToScreen(local, 800, 600);
          assert.ok(nearScreen);
          assert.ok(Math.hypot(screen.x - nearScreen.x, screen.y - nearScreen.y) < 1e-6);
          const ray = camera.unprojectToRay(screen.x, screen.y, 800, 600);
          const t = (world.z - ray.origin.z) / ray.direction.z;
          const hit = { x: ray.origin.x + t * ray.direction.x, y: ray.origin.y + t * ray.direction.y };
          assert.ok(Math.hypot(hit.x - world.x, hit.y - world.y) < 1e-5, 'ray reconstructs the authored f64 point');
          assert.equal(world.x, local.x + offset, 'projection never rebases source data in place');
          return hit;
        });
      });
      for (const pair of hits) assert.ok(Math.abs(Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y) - 0.03125) < 1e-5);
    });
  }
});
