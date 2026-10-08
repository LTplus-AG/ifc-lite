/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lodCameraInDecodedFrame, multiply4, ZUP_TO_YUP } from './copcLodCamera.js';

function apply(m: ArrayLike<number>, p: number[]): number[] {
  return [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] * p[3]);
}

/** A rotation about Y by 30 deg, uniform scale 0.3048 (a foot CRS), translation. */
const c = Math.cos(Math.PI / 6);
const s = Math.sin(Math.PI / 6);
const k = 0.3048;
const MODEL = [k * c, 0, -k * s, 0, 0, k, 0, 0, k * s, 0, k * c, 0, 120, -4, 33, 1];
/** Arbitrary but well-formed projective world view-projection. */
const VIEW_PROJ = [1.2, 0.1, 0.3, 0.3, -0.2, 1.7, 0.1, 0.1, 0.05, -0.3, -1.0, -1.0, 3, -2, 5, 7];

describe('lodCameraInDecodedFrame (#6869)', () => {
  it('projects a decoded point exactly where the renderer draws it', () => {
    const cam = lodCameraInDecodedFrame({
      viewProj: VIEW_PROJ, proj: [0, 0, 0, 0, 0, 1.73], eye: [10, 20, 30], viewportHeight: 800, orthographic: false, model: MODEL,
    });
    assert.ok(cam);
    for (const p of [[0, 0, 0, 1], [5, -3, 2, 1], [-100, 40, 7, 1]]) {
      // Renderer path: swap Z-up -> Y-up, then the placement, then the camera.
      const world = apply(MODEL, apply(ZUP_TO_YUP, p));
      const expected = apply(VIEW_PROJ, world);
      const got = apply(cam.viewProj, p);
      got.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-9, `clip ${i}: ${v} vs ${expected[i]}`));
    }
  });

  it('puts the eye at its decoded-frame position', () => {
    const cam = lodCameraInDecodedFrame({
      viewProj: VIEW_PROJ, proj: [0, 0, 0, 0, 0, 1], eye: [10, 20, 30], viewportHeight: 800, orthographic: false, model: MODEL,
    });
    assert.ok(cam);
    const back = apply(multiply4(MODEL, ZUP_TO_YUP), [...cam.position, 1]);
    [10, 20, 30].forEach((v, i) => assert.ok(Math.abs(back[i] - v) < 1e-9));
  });

  it('folds the placement scale into an orthographic span, not a perspective one', () => {
    const base = { viewProj: VIEW_PROJ, proj: [0, 0, 0, 0, 0, 0.5], eye: [0, 0, 0] as [number, number, number], viewportHeight: 800, model: MODEL };
    assert.ok(Math.abs((lodCameraInDecodedFrame({ ...base, orthographic: true })?.projScaleY ?? 0) - 0.5 * k) < 1e-12);
    assert.equal(lodCameraInDecodedFrame({ ...base, orthographic: false })?.projScaleY, 0.5);
  });

  it('without a placement only the axis swap applies', () => {
    const cam = lodCameraInDecodedFrame({ viewProj: VIEW_PROJ, proj: [0, 0, 0, 0, 0, 1], eye: [1, 2, 3], viewportHeight: 10, orthographic: false });
    assert.deepEqual(cam?.position.map((v) => v + 0), [1, -3, 2]);
  });
});
