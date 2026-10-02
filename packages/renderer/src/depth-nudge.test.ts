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
  MAX_DEPTH_NUDGE_STEPS,
  ORTHOGRAPHIC_DEPTH_NUDGE_PER_STEP,
  ORTHOGRAPHIC_OVERLAY_DEPTH_LIFT,
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

  it('orthographic: the largest nudge stays within centimetres on a kilometre site', () => {
    const maxNudge = MAX_DEPTH_NUDGE_STEPS * ORTHOGRAPHIC_DEPTH_NUDGE_PER_STEP;
    for (const pose of POSES) {
      // orthographicReverseZ puts 1 / (far - near) in m[10]; NDC depth is
      // linear in distance, so one NDC unit is that many metres.
      const range = 1 / camera('orthographic', pose).getProjMatrix().m[10];
      assert.ok(maxNudge * range < 0.1, `${pose}: ${maxNudge * range} m over a ${range} m range`);
    }
  });

  it('a step is several depth units, so coplanar faces one hash apart stay separated', () => {
    assert.ok(ORTHOGRAPHIC_DEPTH_NUDGE_PER_STEP >= 4 * DEPTH_UNIT);
  });

  it('perspective keeps its step and lift', () => {
    assert.equal(PERSPECTIVE_DEPTH_NUDGE_PER_STEP, 1e-6);
    assert.equal(PERSPECTIVE_OVERLAY_DEPTH_LIFT, 5e-5);
  });
});

describe('overlay depth lift (#812, #6729)', () => {
  it('orthographic: text and lines stay above the most-nudged face, depth bias included', () => {
    const maxNudge = MAX_DEPTH_NUDGE_STEPS * ORTHOGRAPHIC_DEPTH_NUDGE_PER_STEP;
    assert.ok(ORTHOGRAPHIC_OVERLAY_DEPTH_LIFT - TEXT_DEPTH_BIAS_UNITS * DEPTH_UNIT > maxNudge);
    assert.ok(ORTHOGRAPHIC_OVERLAY_DEPTH_LIFT >= PERSPECTIVE_OVERLAY_DEPTH_LIFT, 'never lower than before');
  });
});
