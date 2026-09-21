/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FrustumUtils } from '@ifc-lite/spatial';
import { isRteAabbVisible, sourceFrustumFromRte } from './rte-frustum.js';

describe('RTE frustum culling (#5049)', () => {
  // Identity is a deliberately simple RTE clip frame: x/y are [-1, 1] and
  // WebGPU z is [0, 1]. The source coordinate is ±1e9, where f32 absolute
  // planes/bounds cannot retain the centimetre-sized distinction below.
  const frustum = FrustumUtils.fromViewProjMatrix(new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ]));

  it('culls in eye-relative bounds at a +1e9 source origin', () => {
    const camera: [number, number, number] = [1_000_000_000, 0, 0];
    assert.equal(isRteAabbVisible(frustum, {
      min: [1_000_000_000.01, -0.1, 0.1], max: [1_000_000_000.02, 0.1, 0.2],
    }, camera), true);
    assert.equal(isRteAabbVisible(frustum, {
      min: [1_000_000_002, -0.1, 0.1], max: [1_000_000_003, 0.1, 0.2],
    }, camera), false);
  });

  it('converts planes for the source-space spatial index without changing visibility', () => {
    const camera: [number, number, number] = [-1_000_000_000, 0, 0];
    const sourceFrustum = sourceFrustumFromRte(frustum, camera);
    const visible = { min: [-999_999_999.99, -0.1, 0.1] as [number, number, number], max: [-999_999_999.98, 0.1, 0.2] as [number, number, number] };
    const hidden = { min: [-1_000_000_003, -0.1, 0.1] as [number, number, number], max: [-1_000_000_002, 0.1, 0.2] as [number, number, number] };
    assert.equal(isRteAabbVisible(frustum, visible, camera), true);
    assert.equal(FrustumUtils.isAABBVisible(sourceFrustum, visible), true);
    assert.equal(isRteAabbVisible(frustum, hidden, camera), false);
    assert.equal(FrustumUtils.isAABBVisible(sourceFrustum, hidden), false);
  });
});
