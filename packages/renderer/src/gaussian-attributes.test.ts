/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGaussianAttributes, type GaussianAttributeSource } from './gaussian/gaussian-attributes.js';

function source(shDegree: 0 | 1 | 2 | 3 = 0): GaussianAttributeSource {
  const values: Record<string, number[]> = {
    x: [1, -2], y: [3, -4], z: [5, -6], opacity: [0, Math.log(3)],
    scale_0: [0, Math.log(2)], scale_1: [Math.log(3), 0], scale_2: [0, 0],
    rot_0: [2, 0], rot_1: [0, 3], rot_2: [0, 0], rot_3: [0, 4],
    f_dc_0: [4, -4], f_dc_1: [0, 0], f_dc_2: [-4, 4],
  };
  for (let i = 0; i < ((shDegree + 1) ** 2 - 1) * 3; i++) values[`f_rest_${i}`] = [i + 1, -(i + 1)];
  return { count: 2, shDegree, columns: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, new Float32Array(value)])) };
}

test('#8564 normalizes raw PLY encoding once without placement, radiance clipping or input ownership transfer', () => {
  const raw = source();
  const before = structuredClone(raw);
  const result = normalizeGaussianAttributes(raw);
  assert.deepEqual([...result.positions], [1, 3, 5, -2, -4, -6]);
  assert.deepEqual([...result.scales], [1, 3, 1, 2, 1, 1]);
  assert.deepEqual([...result.opacities], [0.5, 0.75]);
  assert.deepEqual([...result.rotations.slice(0, 4)], [1, 0, 0, 0]);
  assert.ok(Math.abs(result.rotations[5] - 0.6) < 1e-7);
  assert.ok(Math.abs(result.rotations[7] - 0.8) < 1e-7);
  assert.ok(result.colors[0] > 1 && result.colors[2] < 0);
  assert.equal(result.colors[3], 1);
  assert.deepEqual(raw, before);
  result.positions.fill(0);
  assert.deepEqual(raw, before, 'output mutation must not alter worker-owned raw columns');
});

for (const degree of [1, 2, 3] as const) test(`#8564 SH degree ${degree} maps channel-major PLY to upstream basis-major RGB`, () => {
  const result = normalizeGaussianAttributes(source(degree));
  const basis = (degree + 1) ** 2 - 1;
  const expected = Array.from({ length: basis }, (_, i) => [i + 1, basis + i + 1, basis * 2 + i + 1]).flat();
  assert.deepEqual([...result.sphericalHarmonics], [...expected, ...expected.map(n => -n)]);
  assert.equal(result.sphericalHarmonicsDegree, degree);
});

test('#8564 invalid/degenerate channels cannot publish normalized GPU inputs', () => {
  for (const [name, value] of [['x', NaN], ['opacity', Infinity], ['scale_0', 100], ['scale_1', -100]] as const) {
    const raw = source(); raw.columns[name][0] = value;
    assert.throws(() => normalizeGaussianAttributes(raw), /Non-finite|covariance/);
  }
  const zero = source(); zero.columns.rot_0[0] = 0;
  assert.throws(() => normalizeGaussianAttributes(zero), /quaternion/);
  const wrongLength = source();
  assert.throws(() => normalizeGaussianAttributes({ ...wrongLength, count: 3 }), /column/);
  const sh = source(1);
  assert.throws(() => normalizeGaussianAttributes({ ...sh, shDegree: 0 }), /SH degree/);
});

test('#8564 extreme finite logits and quaternions remain finite', () => {
  const raw = source(); raw.columns.opacity.set([-1000, 1000]);
  raw.columns.rot_0.set([3e38, 1e-38]);
  const result = normalizeGaussianAttributes(raw);
  assert.deepEqual([...result.opacities], [0, 1]);
  for (let row = 0; row < 2; row++) assert.ok(Math.abs(Math.hypot(...result.rotations.slice(row * 4, row * 4 + 4)) - 1) < 1e-7);
});
