/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The CPU half of the depth-nudge contract (#6729): the projection test the
 * shaders run on each draw's `viewProj`, and the bounds the nudge and overlay
 * lift constants must keep. The shader behaviour itself is exercised by
 * `tests/e2e/ortho-depth-nudge.e2e.spec.ts`, which renders rods inside beams
 * in an orthographic view and fails on the old nudge.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Camera } from './camera.js';
import type { Mat4 } from './types.js';
import {
  MAX_DEPTH_NUDGE_HASH,
  ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL,
  ORTHOGRAPHIC_MAX_DEPTH_NUDGE_METRES,
  PERSPECTIVE_DEPTH_NUDGE_PER_STEP,
  PERSPECTIVE_OVERLAY_DEPTH_LIFT,
} from './shaders/depth-nudge.wgsl.js';

/** One unit of a 24-bit depth buffer, in NDC. */
const DEPTH_UNIT = 2 ** -24;

/** The text pipeline's constant `depthBias` (symbolic-overlay-pipelines.ts), in depth units. */
const TEXT_DEPTH_BIAS_UNITS = 4;

/** WGSL `isOrthographicProjection`: the column-major bottom row is (0, 0, 0, 1). */
function isOrthographicProjection(m: Mat4['m']): boolean {
  return m[3] === 0 && m[7] === 0 && m[11] === 0 && m[15] === 1;
}

/** WGSL `orthographicNudgeLevels`, from the depth range it derives. */
function nudgeLevels(depthRange: number): number {
  const steps = ORTHOGRAPHIC_MAX_DEPTH_NUDGE_METRES / (depthRange * ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL);
  return Math.min(Math.max(Math.floor(steps), 0), MAX_DEPTH_NUDGE_HASH) + 1;
}

/** WGSL ortho overlay lift. */
function overlayLift(depthRange: number): number {
  return Math.max(PERSPECTIVE_OVERLAY_DEPTH_LIFT, (nudgeLevels(depthRange) + 1) * ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL);
}

/** A kilometre site, the scale the issue's glitches showed at. */
const SITE = { min: { x: -500, y: -2, z: -500 }, max: { x: 500, y: 30, z: 500 } };

function camera(mode: 'orthographic' | 'perspective', position: [number, number, number]): Camera {
  const cam = new Camera();
  cam.setAspect(1.5);
  cam.setSceneBounds(SITE);
  cam.setTarget(0, 0.1, 0);
  cam.setPosition(...position);
  cam.setProjectionMode(mode);
  return cam;
}

const POSES: Array<[number, number, number]> = [[0, 0.8, 6], [30, 18, 22], [0, 40, 0.01], [-7, -3, 2]];

describe('depth nudge (#6729)', () => {
  it('the camera\'s view-projection tells the two projections apart', () => {
    for (const pose of POSES) {
      assert.ok(
        isOrthographicProjection(camera('orthographic', pose).getViewProjMatrix().m),
        `orthographic at ${pose}`,
      );
      assert.ok(
        !isOrthographicProjection(camera('perspective', pose).getViewProjMatrix().m),
        `perspective at ${pose}`,
      );
    }
  });

  it('orthographic: the depth range the shader derives is the camera\'s', () => {
    for (const pose of POSES) {
      const cam = camera('orthographic', pose);
      const m = cam.getViewProjMatrix().m;
      // The shader reads 1 / |z row| of viewProj; orthographicReverseZ puts
      // 1 / (far - near) in m[10] of the projection alone.
      const derived = 1 / Math.hypot(m[2], m[6], m[10]);
      const actual = 1 / cam.getProjMatrix().m[10];
      assert.ok(Math.abs(derived - actual) < actual * 1e-5, `${pose}: ${derived} m vs ${actual} m`);
    }
  });

  it('orthographic: no surface moves more than the metre bound, at any depth range', () => {
    for (const range of [0.5, 10, 100, 205, 1_000, 1_560, 10_000, 100_000]) {
      const levels = nudgeLevels(range);
      assert.ok(levels >= 1 && levels <= MAX_DEPTH_NUDGE_HASH + 1, `${range} m: ${levels} levels`);
      const shift = (levels - 1) * ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL * range;
      assert.ok(shift <= ORTHOGRAPHIC_MAX_DEPTH_NUDGE_METRES + 1e-12, `${range} m: ${shift} m`);
    }
    // Ordinary buildings keep the full ranking; a kilometre site still ranks.
    assert.equal(nudgeLevels(200), MAX_DEPTH_NUDGE_HASH + 1);
    assert.ok(nudgeLevels(1_000) >= 32, `${nudgeLevels(1_000)} levels at 1 km`);
  });

  it('a level is several depth units, so coplanar faces one level apart stay separated', () => {
    // One to three units per level z-fought on coplanar plates (depth-nudge.wgsl.ts).
    assert.ok(ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL >= 4 * DEPTH_UNIT);
  });

  it('perspective keeps its step and lift', () => {
    assert.equal(PERSPECTIVE_DEPTH_NUDGE_PER_STEP, 1e-6);
    assert.equal(PERSPECTIVE_OVERLAY_DEPTH_LIFT, 5e-5);
  });
});

describe('overlay depth lift (#812, #6729)', () => {
  it('orthographic: text and lines stay above the most-nudged face, depth bias included', () => {
    for (const range of [0.5, 10, 100, 205, 1_000, 1_560, 10_000, 100_000]) {
      const maxNudge = (nudgeLevels(range) - 1) * ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL;
      assert.ok(overlayLift(range) - TEXT_DEPTH_BIAS_UNITS * DEPTH_UNIT > maxNudge, `${range} m`);
      assert.ok(overlayLift(range) >= PERSPECTIVE_OVERLAY_DEPTH_LIFT, `${range} m: never lower than before`);
    }
  });
});
