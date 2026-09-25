/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5393: repeated wheel zoom toward an object under the cursor passed straight
 * through it. `Camera.zoom` anchored on the plane through the orbit target and
 * dollied the target forward by half of every step, unrelated to the surface.
 * With the picked surface point passed in, zooming in must approach the
 * surface asymptotically, never reach or pass it, and keep it under the cursor.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from './camera.js';
import type { Vec3 } from './types.js';

const W = 800, H = 600;
/** A thin wall: the plane z = 2, seen from z = 10 looking down -z. */
const WALL_Z = 2;
const HIT: Vec3 = { x: 1, y: 0.5, z: WALL_Z };

function camera(): Camera {
  const c = new Camera();
  c.setAspect(W / H);
  c.setPosition(0, 0, 10);
  c.setTarget(0, 0, 0);
  return c;
}

function wheel(c: Camera, notches: number, surface?: Vec3): number[] {
  const cursor = c.projectToScreen(HIT, W, H);
  assert.ok(cursor, 'the hit point is on screen');
  const zs: number[] = [];
  for (let i = 0; i < notches; i++) {
    c.zoom(-100, false, cursor.x, cursor.y, W, H, false, surface);
    zs.push(c.getPosition().z);
  }
  return zs;
}

describe('Camera.zoom toward a picked surface (#5393)', () => {
  it('plain zoom toward the cursor passes through the wall (the defect this guards)', () => {
    const zs = wheel(camera(), 60);
    assert.ok(Math.min(...zs) < WALL_Z, `plain zoom stayed in front: min z ${Math.min(...zs)}`);
  });

  it('never passes the surface, approaches it monotonically, and keeps it under the cursor', () => {
    const c = camera();
    const before = c.projectToScreen(HIT, W, H)!;
    const zs = wheel(c, 60, HIT);
    for (let i = 0; i < zs.length; i++) {
      assert.ok(zs[i] > WALL_Z, `notch ${i}: camera at z ${zs[i]} is at or behind the wall`);
      if (i > 0) assert.ok(zs[i] <= zs[i - 1], `notch ${i}: moved away from the surface`);
    }
    const dist = Math.hypot(c.getPosition().x - HIT.x, c.getPosition().y - HIT.y, c.getPosition().z - HIT.z);
    assert.ok(dist < 0.1, `60 notches got the camera close to the surface: ${dist}`);
    const after = c.projectToScreen(HIT, W, H)!;
    assert.ok(Math.abs(after.x - before.x) < 0.5 && Math.abs(after.y - before.y) < 0.5, `hit drifted from ${JSON.stringify(before)} to ${JSON.stringify(after)}`);
    // The orbit target sits at the surface's depth, in front of the camera.
    assert.ok(c.getTarget().z < c.getPosition().z && c.getTarget().z >= WALL_Z - 1e-6, `target z ${c.getTarget().z}`);
  });

  it('falls back to plain zoom for an unusable surface point (behind, at the eye, non-finite)', () => {
    for (const [name, point] of [
      ['behind the camera', { x: 0, y: 0, z: 20 }],
      ['at the eye', { x: 0, y: 0, z: 10 }],
      ['non-finite', { x: NaN, y: 0, z: 0 }],
    ] as const) {
      const withPoint = camera();
      withPoint.zoom(-100, false, 400, 300, W, H, false, point);
      const plain = camera();
      plain.zoom(-100, false, 400, 300, W, H, false);
      assert.deepEqual(withPoint.getPosition(), plain.getPosition(), name);
    }
  });

  it('settles the DEPTH of an off-axis point at the standoff, never passing it', () => {
    // Depth along the view axis is what the near plane clips; for a 45° off-axis
    // point it is shallower than the straight distance, so the standoff must be
    // enforced on depth for the surface to stay visible.
    const c = camera();
    const point = { x: 5, y: 0, z: 5 };
    for (let i = 0; i < 400; i++) c.zoom(-100, false, 400, 300, W, H, false, point);
    const p = c.getPosition(), t = c.getTarget();
    const f = { x: t.x - p.x, y: t.y - p.y, z: t.z - p.z };
    const len = Math.hypot(f.x, f.y, f.z);
    const depth = ((point.x - p.x) * f.x + (point.y - p.y) * f.y + (point.z - p.z) * f.z) / len;
    assert.ok(depth > 0.019 && depth < 0.021, `depth settles at the 2 cm standoff: ${depth}`);
  });

  it('keeps the plain path for fast zoom, orthographic, and zooming out', () => {
    const cases = [
      { name: 'fast zoom', delta: -100, fast: true, ortho: false },
      { name: 'orthographic', delta: -100, fast: false, ortho: true },
      { name: 'zoom out', delta: 100, fast: false, ortho: false },
    ];
    for (const c of cases) {
      // The same call with and without the surface point must give the same pose.
      const run = (surface?: Vec3) => {
        const cam = camera();
        if (c.ortho) cam.setProjectionMode('orthographic');
        cam.zoom(c.delta, false, 400, 300, W, H, c.fast, surface);
        return cam.getPosition();
      };
      assert.deepEqual(run(HIT), run(), c.name);
    }
  });

  it('respects the interaction gate: an orbit-only viewer does not dolly', () => {
    const c = camera();
    c.setInteractionMode('orbit');
    wheel(c, 5, HIT);
    assert.equal(c.getPosition().z, 10);
  });
});
