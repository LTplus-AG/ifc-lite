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

  for (const surface of [false, true]) {
    it(`recovers incrementally after an orbit leaves the envelope (surface=${surface})`, () => {
      const camera = new Camera();
      camera.setPosition(792093085.965689, 602035896.3170547, 971229336.8977277);
      camera.setTarget(371780271.24388754, 251775217.38222134, 550916522.1759285);
      assertSupported(camera);
      camera.orbit(100, 0);
      const magnitude = () => Math.max(...[camera.getPosition(), camera.getTarget()].flatMap(p => [Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)]));
      assert.ok(magnitude() > LIMIT, 'real orbit must reproduce the review trigger');
      const outside = pose(camera);
      camera.zoom(120);
      assert.deepEqual(pose(camera), outside, 'zoom-out must not worsen an already unsupported pose');
      for (let i = 0; i < 60 && magnitude() > LIMIT; i++) {
        const before = magnitude();
        camera.zoom(-120, false, 400, 300, 800, 600, false, surface ? { x: 0, y: 0, z: 0 } : undefined);
        assert.ok(magnitude() < before, 'each recovery notch must reduce envelope excess');
      }
      assertSupported(camera);
      camera.fitToBounds({ x: -10, y: -10, z: -10 }, { x: 10, y: 10, z: 10 });
      assertSupported(camera);
      assert.ok(magnitude() < 100, 'Home/fit remains a direct recovery');
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

  it('preserves centred orthographic scale outside the envelope without admitting worse translation', () => {
    const camera = new Camera();
    camera.setProjectionMode('orthographic');
    camera.setPosition(2 * LIMIT, 0, 100);
    camera.setTarget(2 * LIMIT, 0, 0);
    camera.setOrthoSize(100);
    const original = pose(camera);
    camera.zoom(120);
    assert.equal(camera.getOrthoSize(), 110.00000000000001);
    assert.deepEqual(camera.getPosition(), original.position);
    assert.deepEqual(camera.getTarget(), original.target);
    assert.equal(camera.getRelativeToEyeFrame().isAvailable(), false, 'scale-only does not claim recovery');
    const scaled = pose(camera);
    camera.zoom(120, false, 0, 300, 800, 600);
    assert.deepEqual(pose(camera), scaled, 'worsening cursor translation still rolls back the scale');
    camera.zoom(-120);
    assert.ok(camera.getOrthoSize() < scaled.size, 'centred reverse scale still works');
    assert.deepEqual(camera.getPosition(), original.position);
    assert.deepEqual(camera.getTarget(), original.target);
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
