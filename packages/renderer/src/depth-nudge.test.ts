/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The anti z-fighting depth nudge stays bounded in orthographic views (#6729),
 * and annotation overlays stay above it.
 *
 * The nudge used to scale clip z by `1 + zHash * 1e-6` under both projections.
 * Orthographic depth is linear over the whole scene range, so that shifted a
 * fragment by up to `255e-6 * z * range`: tens of centimetres on a large site,
 * enough to draw a rod in front of the beam it passes through.
 *
 * WGSL does not run under `tsx --test`, so this reads the exported shader
 * sources and checks the CPU half of the contract against real `Camera`
 * matrices, the ones the renderer packs into each draw's `viewProj`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Camera } from './camera.js';
import type { Mat4 } from './types.js';
import { mainShaderSource } from './shaders/main.wgsl.js';
import { SECTION_2D_OVERLAY_LINE_WGSL } from './shaders/section-2d-overlay.wgsl.js';
import { SYMBOLIC_TEXT_WGSL } from './shaders/symbolic-overlay.wgsl.js';
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

/** Body of WGSL function `name` in `src`, braces matched. */
function wgslFnBody(src: string, name: string): string {
  const start = src.indexOf(`fn ${name}(`);
  assert.ok(start >= 0, `fn ${name} not found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let end = open; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}' && --depth === 0) return src.slice(open, end + 1);
  }
  throw new Error(`fn ${name} is unbalanced`);
}

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
  it('every mesh vertex entry applies the one shared nudge', () => {
    for (const entry of ['shadeFlatVertex', 'vs_main', 'vs_instanced']) {
      assert.match(
        wgslFnBody(mainShaderSource, entry),
        /output\.position\.z = nudgedClipZ\(output\.position, zHash, uniforms\.viewProj\);/,
        `${entry} routes through nudgedClipZ`,
      );
    }
    assert.doesNotMatch(mainShaderSource, /output\.position\.z \*=/, 'no entry scales clip z on its own');
  });

  it('nudgedClipZ: perspective keeps its relative scale, orthographic adds a fixed step', () => {
    const body = wgslFnBody(mainShaderSource, 'nudgedClipZ');
    assert.match(body, /if \(isOrthographicProjection\(viewProj\)\) \{\s*return clip\.z \+ f32\(zHash\) \* ORTHOGRAPHIC_DEPTH_NUDGE_PER_STEP \* clip\.w;/);
    assert.match(body, /return clip\.z \* \(1\.0 \+ f32\(zHash\) \* PERSPECTIVE_DEPTH_NUDGE_PER_STEP\);/);
    assert.equal(PERSPECTIVE_DEPTH_NUDGE_PER_STEP, 1e-6, 'perspective step unchanged');
  });

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
      // The old scaling reached this near the camera (z close to 1).
      const old = MAX_DEPTH_NUDGE_STEPS * PERSPECTIVE_DEPTH_NUDGE_PER_STEP * range;
      assert.ok(old > 0.35, `${pose}: old near-side shift ${old} m`);
    }
  });

  it('a step is several depth units, so coplanar faces one hash apart stay separated', () => {
    assert.ok(ORTHOGRAPHIC_DEPTH_NUDGE_PER_STEP >= 4 * DEPTH_UNIT);
  });
});

describe('overlay depth lift (#812, #6729)', () => {
  it('annotation lines and text lift through the shared helper', () => {
    assert.match(SECTION_2D_OVERLAY_LINE_WGSL, /overlayLiftedClipZ\(clip, uniforms\.viewProj\)/);
    assert.match(SYMBOLIC_TEXT_WGSL, /overlayLiftedClipZ\(clip, camera\.viewProj\)/);
    for (const src of [SECTION_2D_OVERLAY_LINE_WGSL, SYMBOLIC_TEXT_WGSL]) {
      assert.doesNotMatch(src, /clip\.z \+ 5e-5/, 'no hand-written lift left');
    }
  });

  it('overlayLiftedClipZ picks the lift from the projection', () => {
    const body = wgslFnBody(SYMBOLIC_TEXT_WGSL, 'overlayLiftedClipZ');
    assert.match(body, /select\(PERSPECTIVE_OVERLAY_DEPTH_LIFT, ORTHOGRAPHIC_OVERLAY_DEPTH_LIFT, isOrthographicProjection\(viewProj\)\)/);
    assert.match(body, /return clip\.z \+ lift \* clip\.w;/);
    assert.equal(PERSPECTIVE_OVERLAY_DEPTH_LIFT, 5e-5, 'perspective lift unchanged');
  });

  it('orthographic: text and lines stay above the most-nudged face, depth bias included', () => {
    const maxNudge = MAX_DEPTH_NUDGE_STEPS * ORTHOGRAPHIC_DEPTH_NUDGE_PER_STEP;
    assert.ok(ORTHOGRAPHIC_OVERLAY_DEPTH_LIFT - TEXT_DEPTH_BIAS_UNITS * DEPTH_UNIT > maxNudge);
    assert.ok(ORTHOGRAPHIC_OVERLAY_DEPTH_LIFT >= PERSPECTIVE_OVERLAY_DEPTH_LIFT, 'never lower than before');
  });
});
