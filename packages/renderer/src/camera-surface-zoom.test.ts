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
import { surfaceZoomStep, SURFACE_ZOOM_MIN_STANDOFF } from './camera-surface-zoom.js';
import type { Vec3 } from './types.js';

describe('surfaceZoomStep (#5393)', () => {
  const pose = { position: { x: 0, y: 0, z: 10 }, target: { x: 0, y: 0, z: 0 } };

  it('refuses unusable input so the caller falls back to plain zoom', () => {
    assert.equal(surfaceZoomStep(pose, { x: 0, y: 0, z: 20 }, 0.1), null, 'behind the camera');
    assert.equal(surfaceZoomStep(pose, { x: 0, y: 0, z: 10 }, 0.1), null, 'at the eye');
    assert.equal(surfaceZoomStep(pose, { x: NaN, y: 0, z: 0 }, 0.1), null, 'non-finite');
    assert.equal(surfaceZoomStep(pose, { x: 0, y: 0, z: 0 }, 0), null, 'zero fraction');
    assert.equal(surfaceZoomStep(pose, { x: 0, y: 0, z: 0 }, 1), null, 'full fraction');
    assert.equal(surfaceZoomStep({ position: pose.position, target: pose.position }, { x: 0, y: 0, z: 0 }, 0.1), null, 'degenerate view');
  });

  it('enforces the standoff on DEPTH for an off-axis point, never on straight distance', () => {
    // A point 45° off-axis: after many steps its depth (what the near plane
    // clips) must settle at the standoff, while its distance stays larger.
    const point = { x: 5, y: 0, z: 5 };
    let p = pose;
    for (let i = 0; i < 400; i++) p = surfaceZoomStep(p, point, 0.1) ?? p;
    const fwd = { x: p.target.x - p.position.x, y: p.target.y - p.position.y, z: p.target.z - p.position.z };
    const len = Math.hypot(fwd.x, fwd.y, fwd.z);
    const depth = ((point.x - p.position.x) * fwd.x + (point.y - p.position.y) * fwd.y + (point.z - p.position.z) * fwd.z) / len;
    assert.ok(Math.abs(depth - SURFACE_ZOOM_MIN_STANDOFF) < 1e-9, `depth ${depth}`);
  });
});

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
