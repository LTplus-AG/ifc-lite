/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matrixToPose, poseToMatrix, norm, type V3 } from './math.js';

const near = (a: ArrayLike<number>, b: ArrayLike<number>, e = 1e-9) => a.length === b.length && Array.from(a).every((x, i) => Math.abs(x - b[i]) < e);

test('poseToMatrix: looking down -Z gives the identity rotation with the position in the last column', () => {
  const m = poseToMatrix([0, 2, 10], [0, 2, 0], [0, 1, 0]);
  assert.ok(near(m, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 10, 1]));
});

test('poseToMatrix: a camera on +X looking at the origin has right = -Z and back = +X', () => {
  const m = poseToMatrix([10, 2, 0], [0, 2, 0], [0, 1, 0]);
  assert.ok(near(m, [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 10, 2, 0, 1]));
});

test('poseToMatrix: looking straight along `up` does not produce NaN', () => {
  const m = poseToMatrix([0, 10, 0], [0, 0, 0], [0, 1, 0]);
  assert.ok(m.every(Number.isFinite));
});

test('matrixToPose inverts poseToMatrix', () => {
  const m = poseToMatrix([3, 4, 5], [1, 2, 0], [0, 1, 0]);
  const back = matrixToPose(m, [1, 2, 0], 1);
  assert.ok(near(back.pos, [3, 4, 5]));
  assert.ok(near(back.target, [1, 2, 0], 1e-9));
});

test('matrixToPose: a dolly keeps the same point in front of the camera', () => {
  const m = poseToMatrix([0, 2, 10], [0, 2, 0], [0, 1, 0]);
  m[14] = 6; // the driver moved the camera 4 units forward
  const p = matrixToPose(m, [0, 2, 0], 10);
  assert.ok(near(p.pos, [0, 2, 6]) && near(p.target, [0, 2, 0]));
});

test('matrixToPose: past the old target, the fallback distance is used', () => {
  const m = poseToMatrix([0, 2, 10], [0, 2, 0], [0, 1, 0]);
  m[14] = -3;
  const p = matrixToPose(m, [0, 2, 0], 6);
  assert.ok(near(p.target, [0, 2, -9]));
});

test('norm of the zero vector is the zero vector', () => {
  assert.deepEqual(norm([0, 0, 0] as V3), [0, 0, 0]);
});
