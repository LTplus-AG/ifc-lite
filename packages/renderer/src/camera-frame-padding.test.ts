/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Vec3, Camera as CameraType, Mat4 } from './types.js';
import type { CameraInternalState } from './camera-state.js';
import { fitDistanceFor, frameBoundsTarget } from './camera-framing.js';
import { CAMERA_CONSTANTS } from './constants.js';
import { MathUtils, viewBasis } from './math.js';

/**
 * `frameBounds` takes an optional padding multiple (#7545) so "zoom to the cut
 * area with a 10 % margin" frames exactly that margin instead of the fixed 1.2.
 * The multiple scales the fit distance (perspective) or ortho size, so framing
 * with `p` puts the box's worst corner `p` times inside the frustum edge.
 */

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };
const BOX = { min: { x: -5, y: -5, z: -5 }, max: { x: 5, y: 5, z: 5 } };

function state(mode: 'perspective' | 'orthographic'): CameraInternalState {
  const position: Vec3 = { x: 40, y: 30, z: 40 };
  const camera: CameraType = { position, target: ORIGIN, up: { x: 0, y: 1, z: 0 }, fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 1e5 };
  const identity: Mat4 = { m: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
  return {
    camera, viewMatrix: MathUtils.lookAt(position, ORIGIN, camera.up), projMatrix: identity, viewProjMatrix: identity,
    projectionMode: mode, orthoSize: 50, sceneBounds: null, orbitAnchorBounds: null,
  };
}
const distance = (p: Vec3) => Math.hypot(p.x, p.y, p.z);

/** Largest |x| or |y| of the box's corners in normalised screen space, seen from `eye` with the state's own lens. */
function worstCorner(s: CameraInternalState, eye: Vec3): number {
  const view = MathUtils.lookAt(eye, ORIGIN, s.camera.up);
  const proj = MathUtils.perspective(s.camera.fov, s.camera.aspect, s.camera.near, s.camera.far);
  const m = MathUtils.multiply(proj, view).m;
  let worst = 0;
  for (const x of [BOX.min.x, BOX.max.x]) for (const y of [BOX.min.y, BOX.max.y]) for (const z of [BOX.min.z, BOX.max.z]) {
    const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    worst = Math.max(worst, Math.abs((m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w), Math.abs((m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w));
  }
  return worst;
}

describe('frameBounds padding multiple (#7545)', () => {
  it('without one it is the default 1.2 times the fit distance, and orthographic ignores how a margin is solved', () => {
    const base = frameBoundsTarget(state('perspective'), BOX.min, BOX.max)!;
    const scaled = fitDistanceFor(state('perspective'), BOX, viewBasis(state('perspective').camera.position, ORIGIN, { x: 0, y: 1, z: 0 }), 1.2);
    assert.ok(Math.abs(distance(base.position) - scaled) < 1e-6);
    assert.deepEqual(frameBoundsTarget(state('orthographic'), BOX.min, BOX.max), frameBoundsTarget(state('orthographic'), BOX.min, BOX.max, CAMERA_CONSTANTS.FRAME_PADDING_MULTIPLIER));
  });

  it('a stated multiple is the margin of the projected corners in perspective: the worst corner sits at 1 / multiple of the half-frame', () => {
    for (const padding of [1, 1.2, 1.5, 2]) {
      const s = state('perspective');
      const fit = frameBoundsTarget(s, BOX.min, BOX.max, padding)!;
      assert.ok(Math.abs(worstCorner(s, fit.position) - 1 / padding) < 1e-5, `padding ${padding}: ${worstCorner(s, fit.position)}`);
    }
  });

  it('edge to edge is the same pose as before: only a margin above 1 moves, and by less than scaling the distance did', () => {
    const base = distance(frameBoundsTarget(state('perspective'), BOX.min, BOX.max)!.position);
    const tight = distance(frameBoundsTarget(state('perspective'), BOX.min, BOX.max, 1)!.position);
    assert.ok(Math.abs(tight / base - 1 / 1.2) < 1e-6, `${tight / base}`);
    const loose = distance(frameBoundsTarget(state('perspective'), BOX.min, BOX.max, 1.5)!.position);
    assert.ok(loose > tight && loose < tight * 1.5, `${loose / tight}`);
  });

  it('scales the orthographic size the same way', () => {
    const base = frameBoundsTarget(state('orthographic'), BOX.min, BOX.max)!.orthoSize!;
    const tight = frameBoundsTarget(state('orthographic'), BOX.min, BOX.max, 1)!.orthoSize!;
    assert.ok(Math.abs(tight / base - 1 / 1.2) < 1e-6);
  });

  it('ignores a multiple below 1 or non-finite and falls back to the default', () => {
    const base = frameBoundsTarget(state('perspective'), BOX.min, BOX.max)!;
    for (const bad of [0.5, 0, -2, NaN, Infinity]) {
      assert.deepEqual(frameBoundsTarget(state('perspective'), BOX.min, BOX.max, bad), base, `padding ${bad}`);
    }
  });
});
