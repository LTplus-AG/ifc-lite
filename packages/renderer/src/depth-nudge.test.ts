/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The anti z-fighting depth nudge stays bounded in orthographic views (#6729).
 *
 * The nudge used to scale clip z by `1 + zHash * 1e-6` under both projections.
 * Orthographic depth is linear over the whole scene range, so that shifted a
 * fragment by up to `255e-6 * z * range`: tens of centimetres on a large site,
 * enough to draw a rod in front of the beam it passes through.
 *
 * WGSL does not run under `tsx --test`, so the shader half reads the exported
 * source, and the numeric half mirrors `nudgedClipZ` against real `Camera`
 * matrices, the ones the renderer packs into `uniforms.viewProj`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Camera } from './camera.js';
import type { Mat4 } from './types.js';
import { mainShaderSource } from './shaders/main.wgsl.js';
import {
  ORTHOGRAPHIC_DEPTH_NUDGE_PER_STEP,
  PERSPECTIVE_DEPTH_NUDGE_PER_STEP,
} from './shaders/depth-nudge.wgsl.js';

const MAX_HASH = 255;

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

/** WGSL `nudgedClipZ`. */
function nudgedClipZ(viewProj: Mat4['m'], clipZ: number, clipW: number, zHash: number): number {
  if (isOrthographicProjection(viewProj)) return clipZ + zHash * ORTHOGRAPHIC_DEPTH_NUDGE_PER_STEP * clipW;
  return clipZ * (1 + zHash * PERSPECTIVE_DEPTH_NUDGE_PER_STEP);
}

function clip(m: Mat4['m'], [x, y, z]: readonly [number, number, number]): { z: number; w: number } {
  return {
    z: m[2] * x + m[6] * y + m[10] * z + m[14],
    w: m[3] * x + m[7] * y + m[11] * z + m[15],
  };
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
  it('every vertex entry applies the one shared nudge', () => {
    for (const entry of ['shadeFlatVertex', 'vs_main', 'vs_instanced']) {
      assert.match(
        wgslFnBody(mainShaderSource, entry),
        /output\.position\.z = nudgedClipZ\(output\.position, zHash\);/,
        `${entry} routes through nudgedClipZ`,
      );
    }
    assert.doesNotMatch(mainShaderSource, /output\.position\.z \*=/, 'no entry scales clip z on its own');
  });

  it('nudgedClipZ picks the step from the draw\'s projection', () => {
    const body = wgslFnBody(mainShaderSource, 'nudgedClipZ');
    assert.match(body, /isOrthographicProjection\(uniforms\.viewProj\)/);
    assert.match(body, /ORTHOGRAPHIC_DEPTH_NUDGE_PER_STEP \* clip\.w/);
    assert.match(body, /clip\.z \* \(1\.0 \+ f32\(zHash\) \* PERSPECTIVE_DEPTH_NUDGE_PER_STEP\)/);
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

  it('orthographic: the largest nudge is the same small distance at every depth', () => {
    for (const pose of POSES) {
      const cam = camera('orthographic', pose);
      const m = cam.getViewProjMatrix().m;
      // orthographicReverseZ puts 1 / (far - near) in m[10].
      const range = 1 / cam.getProjMatrix().m[10];
      const bound = MAX_HASH * ORTHOGRAPHIC_DEPTH_NUDGE_PER_STEP * range;
      // Scene corners: the nearest and farthest fragments the view can draw.
      for (const x of [SITE.min.x, SITE.max.x]) for (const y of [SITE.min.y, SITE.max.y]) for (const z of [SITE.min.z, SITE.max.z]) {
        const c = clip(m, [x, y, z]);
        // NDC depth is linear in distance: one NDC unit is `range` metres.
        const shift = (nudgedClipZ(m, c.z, c.w, MAX_HASH) - c.z) / c.w * range;
        assert.ok(Math.abs(shift - bound) < bound * 1e-6, `${pose} corner ${[x, y, z]}: ${shift} m, expected ${bound} m`);
      }
      // About 9 cm here; the old scaling reached 255e-6 of the range near the camera.
      assert.ok(bound < 0.1, `${pose}: ${bound} m`);
      assert.ok(bound < MAX_HASH * PERSPECTIVE_DEPTH_NUDGE_PER_STEP * range / 4, `${pose}: well under the old near-side shift`);
    }
  });

  it('perspective keeps its relative nudge', () => {
    const m = camera('perspective', POSES[1]).getViewProjMatrix().m;
    const c = clip(m, [4, 2, -3]);
    assert.equal(nudgedClipZ(m, c.z, c.w, MAX_HASH), c.z * (1 + MAX_HASH * PERSPECTIVE_DEPTH_NUDGE_PER_STEP));
  });
});
