/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Vec3, Camera as CameraType, Mat4 } from './types.js';
import type { CameraInternalState } from './camera-state.js';
import { frameBoundsTarget } from './camera-framing.js';
import { CAMERA_CONSTANTS } from './constants.js';
import { MathUtils } from './math.js';

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

describe('frameBounds padding multiple (#7545)', () => {
  it('without one it is the default 1.2', () => {
    const a = frameBoundsTarget(state('perspective'), BOX.min, BOX.max)!;
    const b = frameBoundsTarget(state('perspective'), BOX.min, BOX.max, CAMERA_CONSTANTS.FRAME_PADDING_MULTIPLIER)!;
    assert.deepEqual(a, b);
  });

  it('scales the perspective fit distance by the multiple: edge to edge is 1/1.2 of the default, a 25 % margin each side is 1.5/1.2', () => {
    const base = distance(frameBoundsTarget(state('perspective'), BOX.min, BOX.max)!.position);
    const tight = distance(frameBoundsTarget(state('perspective'), BOX.min, BOX.max, 1)!.position);
    const loose = distance(frameBoundsTarget(state('perspective'), BOX.min, BOX.max, 1.5)!.position);
    assert.ok(Math.abs(tight / base - 1 / 1.2) < 1e-6, `${tight / base}`);
    assert.ok(Math.abs(loose / base - 1.5 / 1.2) < 1e-6, `${loose / base}`);
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
