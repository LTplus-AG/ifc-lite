/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DISPLAY_ROTATIONS, robustFraming } from '../showcase-framing.mjs';

const OPAQUE = 4, CLEAR = -6; // raw PLY opacity logits: sigmoid ~0.98 and ~0.0025

// A Y-down "building": ground plane at y=0, tower reaching y=-20, plus
// translucent haze and a few opaque floaters far away (typical drone capture).
function capture() {
  const x = [], y = [], z = [], o = [];
  const push = (px, py, pz, po) => { x.push(px); y.push(py); z.push(pz); o.push(po); };
  for (let i = 0; i < 4000; i++) push((i % 40) - 20, -(Math.floor(i / 40) % 10) * 0.5, Math.floor(i / 400) - 5, OPAQUE);
  for (let i = 0; i < 400; i++) push(i % 4, -(i / 20), i % 3, OPAQUE);
  for (let i = 0; i < 2000; i++) push(500 + i, -300, 400, CLEAR);
  for (let i = 0; i < 20; i++) push(900, -900, 900, OPAQUE);
  return [x, y, z, o].map(values => Float32Array.from(values));
}

test('framing ignores translucent haze and sparse opaque floaters (#8567)', () => {
  const framing = robustFraming(...capture(), { rotation: 'x180' });
  for (let a = 0; a < 3; a++) {
    assert.ok(framing.box.min[a] >= -21 && framing.box.max[a] <= 21, `axis ${a} box ${framing.box.min[a]}..${framing.box.max[a]}`);
  }
  assert.ok(framing.radius > 10 && framing.radius < 40);
  assert.equal(framing.used, 4420);
});

test('x180 shows a Y-down capture upright without scaling it (#8567)', () => {
  const [x, y, z, o] = capture();
  const upright = robustFraming(x, y, z, o, { rotation: 'x180' });
  const raw = robustFraming(x, y, z, o, { rotation: 'none' });
  assert.ok(upright.box.max[1] > 5 && upright.box.min[1] >= -1e-6, 'tower rises above the ground after rotation');
  assert.ok(raw.box.min[1] < -5, 'source tower points down before rotation');
  assert.ok(Math.abs(upright.radius - raw.radius) < 1e-9, 'a proper rotation preserves framing size');
  const rotated = DISPLAY_ROTATIONS.x180.apply(1, 2, 3);
  assert.deepEqual(rotated, [1, -2, -3]);
  assert.deepEqual(DISPLAY_ROTATIONS.x180.apply(...rotated), [1, 2, 3]);
});

test('framing is translation and scale equivariant (#8567)', () => {
  const [x, y, z, o] = capture();
  const base = robustFraming(x, y, z, o);
  const shift = [12, -7, 3], scale = 2.5;
  const moved = robustFraming(x.map(v => v * scale + shift[0]), y.map(v => v * scale + shift[1]), z.map(v => v * scale + shift[2]), o);
  for (let a = 0; a < 3; a++) assert.ok(Math.abs(moved.center[a] - (base.center[a] * scale + shift[a])) < 1e-3);
  assert.ok(Math.abs(moved.radius - base.radius * scale) < 1e-3);
});

test('framing refuses unusable input instead of inventing bounds (#8567)', () => {
  const [x, y, z, o] = capture();
  assert.throws(() => robustFraming(x, y, z, o.subarray(1)), /equal/);
  assert.throws(() => robustFraming(x, y, z, o.map(() => CLEAR)), /too few opaque/);
  assert.throws(() => robustFraming(x, y, z, o, { rotation: 'z90' }), /unknown display rotation/);
  assert.throws(() => robustFraming(x, y, z, o, { lowPercentile: 60, highPercentile: 40 }), /percentiles/);
  const nan = Float32Array.from(x, () => NaN);
  assert.throws(() => robustFraming(nan, y, z, o), /too few opaque finite/);
});
