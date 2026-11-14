/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNavigationModel, KEY_FIT } from './model.js';
import type { DriverCamera } from './types.js';
import type { V3 } from './math.js';

function makeCam(over: Partial<DriverCamera> = {}) {
  const s = { pose: { pos: [0, 2, 10] as V3, target: [0, 2, 0] as V3, up: [0, 1, 0] as V3 }, renders: 0, fov: Math.PI / 4 };
  const cam: DriverCamera = {
    canvas: {} as HTMLElement,
    getPose: () => s.pose,
    setPose: (pos, target, up) => {
      s.pose = { pos, target, up };
    },
    getFov: () => s.fov,
    setFov: (f) => {
      s.fov = f;
    },
    getAspect: () => 2,
    getBounds: () => ({ min: [-5, 0, -5], max: [5, 4, 5] }),
    requestRender: () => {
      s.renders++;
    },
    ...over,
  };
  return { cam, s };
}
const near = (a: number[], b: number[], e = 1e-9) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < e);

test('getViewMatrix reflects the camera pose', () => {
  const { cam } = makeCam();
  const m = createNavigationModel(cam, { pointer: () => [0, 0] });
  assert.ok(near(m.getViewMatrix(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 10, 1]));
});

test('setViewMatrix: a dolly moves the camera and keeps the target point; a frame is requested', () => {
  const { cam, s } = makeCam();
  const m = createNavigationModel(cam, { pointer: () => [0, 0] });
  const mat = m.getViewMatrix();
  mat[14] = 6;
  m.setViewMatrix(mat);
  assert.ok(near(s.pose.pos, [0, 2, 6]) && near(s.pose.target, [0, 2, 0]));
  assert.equal(s.renders, 1);
});

test('setViewMatrix: an orbit about the target', () => {
  const { cam, s } = makeCam();
  const m = createNavigationModel(cam, { pointer: () => [0, 0] });
  m.setViewMatrix([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 10, 2, 0, 1]);
  assert.ok(near(s.pose.pos, [10, 2, 0]) && near(s.pose.target, [0, 2, 0]));
});

test('setViewMatrix ignores malformed matrices without throwing', () => {
  const { cam, s } = makeCam();
  const m = createNavigationModel(cam, { pointer: () => [0, 0] });
  const before = s.pose;
  m.setViewMatrix([NaN, ...new Array(15).fill(0)]);
  m.setViewMatrix([1, 2, 3]);
  assert.equal(s.pose, before);
  assert.equal(s.renders, 0);
});

test('getViewFrustum: [l, r, b, t, n, f] with the canvas aspect and the camera fov', () => {
  const { cam, s } = makeCam();
  const [l, r, b, t, n, f] = createNavigationModel(cam, { pointer: () => [0, 0] }).getViewFrustum();
  assert.ok(Math.abs(r / t - 2) < 1e-9 && l === -r && b === -t);
  assert.ok(Math.abs(t / n - Math.tan(s.fov / 2)) < 1e-9);
  assert.ok(f > n && n > 0);
});

test('getModelExtents: bounds as [min, max]; a unit box when nothing is loaded', () => {
  const m = createNavigationModel(makeCam().cam, { pointer: () => [0, 0] });
  assert.deepEqual(m.getModelExtents(), [-5, 0, -5, 5, 4, 5]);
  const empty = createNavigationModel(makeCam({ getBounds: () => null }).cam, { pointer: () => [0, 0] });
  assert.deepEqual(empty.getModelExtents(), [-1, -1, -1, 1, 1, 1]);
});

test('getPointerPosition: centre is straight ahead on the near plane; right of centre is to the camera\'s right', () => {
  const { cam } = makeCam();
  const centre = createNavigationModel(cam, { pointer: () => [0, 0] }).getPointerPosition();
  assert.ok(centre[2] < 10 && Math.abs(centre[0]) < 1e-9 && Math.abs(centre[1] - 2) < 1e-9);
  const right = createNavigationModel(cam, { pointer: () => [1, 0] }).getPointerPosition();
  assert.ok(right[0] > 0);
});

test('pivot: defaults to the camera target, then follows setPivotPosition', () => {
  const m = createNavigationModel(makeCam().cam, { pointer: () => [0, 0] });
  assert.deepEqual(m.getPivotPosition(), [0, 2, 0]);
  m.setPivotPosition([1, 1, 1]);
  assert.deepEqual(m.getPivotPosition(), [1, 1, 1]);
});

test('setFov and setTarget write through to the camera', () => {
  const { cam, s } = makeCam();
  const m = createNavigationModel(cam, { pointer: () => [0, 0] });
  m.setFov(1);
  assert.equal(s.fov, 1);
  m.setTarget([1, 2, 3]);
  assert.deepEqual(s.pose.target, [1, 2, 3]);
});

test('the Fit key calls onFit; other keys do not', () => {
  let fits = 0;
  const m = createNavigationModel(makeCam().cam, { pointer: () => [0, 0], onFit: () => fits++ });
  m.setKeyPress(KEY_FIT);
  m.setKeyPress(0x20);
  assert.equal(fits, 1);
});

test('a frame is requested when a transaction ends and when motion stops', () => {
  const { cam, s } = makeCam();
  const m = createNavigationModel(cam, { pointer: () => [0, 0] });
  m.setTransaction(1);
  assert.equal(s.renders, 0);
  m.setTransaction(0);
  assert.equal(s.renders, 1);
  m.onStartMotion();
  m.onStopMotion();
  assert.equal(s.renders, 2);
});

test('no hit-testing and no selection: the library falls back to extents and pivot', () => {
  const m = createNavigationModel(makeCam().cam, { pointer: () => [0, 0] });
  assert.equal(m.getLookAt(), null);
  assert.equal(m.getSelectionEmpty(), true);
  assert.equal(m.getSelectionExtents(), null);
});
