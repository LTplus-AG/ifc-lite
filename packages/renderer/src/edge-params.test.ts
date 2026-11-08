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
import { edgeShaderSource } from './shaders/edges.wgsl.js';
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

/** Perspective with a lens shift (#8688): non-zero m8/m9. */
function lensShifted(): Mat4 {
  const p = perspective();
  p.m[8] = 0.2;
  p.m[9] = -0.45;
  return p;
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
    for (const projection of [perspective(), orthographic(), lensShifted()]) {
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
      assert.deepEqual(
        Array.from(out.subarray(EDGE_UNIFORM_LAYOUT.shearParams, EDGE_UNIFORM_LAYOUT.shearParams + 4)),
        [m[8], m[9], 0, 0],
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

  it('floors the tap radius at 1 px', () => {
    const e = EDGE_UNIFORM_LAYOUT.edge;
    assert.equal(packed(perspective(), { radiusPx: 0.2 })[e], 1);
    assert.equal(packed(perspective(), { radiusPx: 3 })[e], 3);
  });

  it('darkens a line pixel by the intensity times the share of taps an axis-aligned edge crosses', () => {
    // Beside a horizontal edge, 1 of the 4 cardinal taps crosses it, and 3 of
    // 8 once the diagonals join: the weight the averaged votes gave those
    // edges, now given to every pixel of a slanted edge too, instead of a
    // double weight at each step of its staircase (the dotted-edge bug).
    const e = EDGE_UNIFORM_LAYOUT.edge;
    const across = { low: 1 / 4, high: 3 / 8 } as const;
    for (const quality of ['low', 'high'] as const) {
      assert.equal(EDGE_QUALITY_PRESETS[quality].lineCoverage, across[quality]);
      assert.ok(Math.abs(packed(perspective(), { quality, intensity: 0.8 })[e + 1] - 0.8 * across[quality]) < 1e-6);
    }
  });

  it('flags high quality (diagonals on) only at high quality', () => {
    const e = EDGE_UNIFORM_LAYOUT.edge;
    assert.equal(packed(perspective(), { quality: 'low' })[e + 2], 0);
    assert.equal(packed(perspective(), { quality: 'high' })[e + 2], 1);
  });
});

describe('EDGE_UNIFORM_LAYOUT matches the WGSL struct', () => {
  it('lists the EdgeParams fields in offset order, one vec4 each', () => {
    const struct = /struct EdgeParams \{([\s\S]*?)\}/.exec(edgeShaderSource(false));
    assert.ok(struct, 'expected `struct EdgeParams` in the edge shader');
    const fields = [...struct[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    const byOffset = Object.entries(EDGE_UNIFORM_LAYOUT).sort((a, b) => a[1] - b[1]).map(([k]) => k);
    assert.deepEqual(fields, byOffset);
    assert.deepEqual(Object.values(EDGE_UNIFORM_LAYOUT).sort((a, b) => a - b), fields.map((_, i) => i * 4));
    assert.equal(EDGE_UNIFORM_BYTES, fields.length * 16);
  });
});
