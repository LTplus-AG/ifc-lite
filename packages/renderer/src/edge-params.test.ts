/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EDGE_CREASE_ANGLE_DEG,
  EDGE_CREASE_COS,
  EDGE_QUALITY_PRESETS,
  EDGE_UNIFORM_BYTES,
  EDGE_UNIFORM_LAYOUT,
  packEdgeUniforms,
  type EdgeFrameParams,
} from './edge-params.js';
import { MathUtils } from './math.js';
import type { Mat4 } from './types.js';

/**
 * The CPU half of the edge pass (#5385): quality presets and the uniform
 * layout `edges.wgsl.ts` reads. Real projection matrices, same idiom as
 * `ao-params.test.ts` (#5384).
 */

function perspective(): Mat4 {
  return MathUtils.perspectiveReverseZ(Math.PI / 3, 16 / 9, 0.1, 500);
}

function orthographic(): Mat4 {
  return MathUtils.orthographicReverseZ(-10, 10, -6, 6, 0.1, 1000);
}

describe('EDGE_QUALITY_PRESETS (#5385)', () => {
  it('low quality taps 4 cardinal directions, high taps 8 (+ diagonals)', () => {
    assert.equal(EDGE_QUALITY_PRESETS.low.directions, 4);
    assert.equal(EDGE_QUALITY_PRESETS.high.directions, 8);
  });
});

describe('EDGE_CREASE_COS (#5385)', () => {
  it('is the cosine of the documented crease angle', () => {
    assert.equal(EDGE_CREASE_ANGLE_DEG, 25);
    assert.ok(Math.abs(EDGE_CREASE_COS - Math.cos((25 * Math.PI) / 180)) < 1e-9);
    // A shallower angle than the threshold must NOT read as a crease: two
    // faces 10 degrees apart stay well above the cosine cutoff.
    assert.ok(Math.cos((10 * Math.PI) / 180) > EDGE_CREASE_COS);
    // A sharp corner (90 degrees, e.g. a wall/floor junction) must clear it.
    assert.ok(Math.cos((90 * Math.PI) / 180) < EDGE_CREASE_COS);
  });
});

describe('packEdgeUniforms (#5385)', () => {
  function packed(projection: Mat4, overrides: Partial<EdgeFrameParams> = {}): Float32Array {
    const out = new Float32Array(EDGE_UNIFORM_BYTES / 4);
    packEdgeUniforms(out, {
      projection,
      width: 1600,
      height: 1000,
      quality: 'low',
      radiusPx: 2,
      intensity: 0.6,
      ...overrides,
    });
    return out;
  }

  it('writes the projection depth/xy params the shader reconstructs from, for both camera modes', () => {
    for (const projection of [perspective(), orthographic()]) {
      const out = packed(projection);
      const m = projection.m;
      assert.deepEqual(
        Array.from(out.subarray(EDGE_UNIFORM_LAYOUT.depthParams, EDGE_UNIFORM_LAYOUT.depthParams + 4)),
        [m[10], m[11], m[14], m[15]],
      );
      assert.deepEqual(
        Array.from(out.subarray(EDGE_UNIFORM_LAYOUT.xyParams, EDGE_UNIFORM_LAYOUT.xyParams + 4)),
        [m[0], m[5], m[12], m[13]],
      );
    }
  });

  it('writes the viewport size and its reciprocal', () => {
    const out = packed(perspective(), { width: 800, height: 500 });
    const v = EDGE_UNIFORM_LAYOUT.viewport;
    const got = Array.from(out.subarray(v, v + 4));
    const want = [800, 500, 1 / 800, 1 / 500];
    got.forEach((g, i) => assert.ok(Math.abs(g - want[i]) < 1e-6, `[${i}] ${g} !~ ${want[i]}`));
  });

  it('floors the tap radius at 1 px and carries the intensity through', () => {
    const e = EDGE_UNIFORM_LAYOUT.edge;
    assert.equal(packed(perspective(), { radiusPx: 0.2 })[e], 1);
    assert.equal(packed(perspective(), { radiusPx: 3 })[e], 3);
    assert.ok(Math.abs(packed(perspective(), { intensity: 0.35 })[e + 1] - 0.35) < 1e-6);
  });

  it('flags high quality (diagonals on) only at high quality', () => {
    const e = EDGE_UNIFORM_LAYOUT.edge;
    assert.equal(packed(perspective(), { quality: 'low' })[e + 2], 0);
    assert.equal(packed(perspective(), { quality: 'high' })[e + 2], 1);
  });
});
