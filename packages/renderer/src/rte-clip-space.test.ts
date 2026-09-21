/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { packRteClipBox, rtePlaneDistance } from './rte-clip-space.js';

it('uses one f64 eye-relative crop and section conversion for every GPU pass (#5049)', () => {
  const camera: [number, number, number] = [5_000_000.015625, 20, -10];
  const packed = new Float32Array(8);
  assert.equal(packRteClipBox({ enabled: true, min: [5_000_000.025625, 19, -11], max: [5_000_000.035625, 21, -9] }, camera, packed, 0), true);
  assert.equal(packed[0], 0.009999999776482582);
  assert.equal(packed[4], 0.019999999552965164);
  assert.equal(rtePlaneDistance(-9.99, [0, 0, 1], camera), 0.009999999999999787);
});
