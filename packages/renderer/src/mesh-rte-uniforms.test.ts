/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { MathUtils } from './math.js';
import {
  MESH_FLAG_RTE_DRAWABLE,
  MESH_UNIFORM_FLOATS,
  MESH_UNIFORM_OFFSET,
  packRteFragmentSpace,
} from './mesh-rte-uniforms.js';
import { RelativeToEyeFrame } from './relative-to-eye.js';
import { mainShaderSource } from './shaders/main.wgsl.js';

describe('mesh RTE fragment ingress (#5049)', () => {
  it('retains centimetre section and crop residuals at a 5,000 km source offset', () => {
    const frame = new RelativeToEyeFrame();
    frame.update({ x: 5_000_000.25, y: -3_000_000.5, z: 120 }, MathUtils.identity(), MathUtils.identity());
    const uniform = new Float32Array(MESH_UNIFORM_FLOATS);
    packRteFragmentSpace(frame, {
      normal: [1, 0, 0],
      distance: 5_000_000.26,
      enabled: true,
    }, {
      min: [5_000_000.255, -3_000_000.51, 119.99],
      max: [5_000_000.275, -3_000_000.49, 120.01],
      enabled: true,
    }, uniform);

    const section = MESH_UNIFORM_OFFSET.sectionPlane;
    const crop = MESH_UNIFORM_OFFSET.clipBoxMin;
    assert.ok(Math.abs(uniform[section + 3] - 0.01) < 1e-8);
    assert.ok(Math.abs(uniform[crop] - 0.005) < 1e-8);
    assert.ok(Math.abs(uniform[crop + 4] - 0.025) < 1e-8);
    assert.ok(Math.abs(uniform[crop + 1] + 0.01) < 1e-8);
  });

  it('uses the centralized RTE bit and eye-relative fragment values in production WGSL', () => {
    assert.equal(MESH_UNIFORM_OFFSET.rteViewProj, 60);
    assert.equal(MESH_UNIFORM_OFFSET.drawableDelta, 76);
    assert.match(mainShaderSource, new RegExp(`RTE_DRAWABLE_FLAG: u32 = ${MESH_FLAG_RTE_DRAWABLE}u`));
    assert.match(mainShaderSource, /let fragmentPos = select\(input\.worldPos, input\.eyePos/);
    assert.match(mainShaderSource, /cross\(dpdx\(fragmentPos\), dpdy\(fragmentPos\)\)/);
    assert.match(mainShaderSource, /let p = fragmentPos;/);
  });

  it('keeps individual rotation/scale linear while translating only through the RTE origin (#5049)', () => {
    assert.match(mainShaderSource, /uniforms\.model \* vec4<f32>\(local, 0\.0\)/);
    assert.match(mainShaderSource, /rteWorldPosition\(linear, RteDrawableUniform\(/);
    assert.doesNotMatch(mainShaderSource, /fn rtePosition\(local: vec3<f32>\) -> vec4<f32> \{ return/);
  });
});
