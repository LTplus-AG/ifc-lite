/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EDGE_CREASE_ANGLE_DEG,
  EDGE_CREASE_COS,
  EDGE_LINE_WEIGHT,
  EDGE_QUALITY_PRESETS,
  EDGE_SAMPLE_COUNT,
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

/** Body of WGSL function `name` in `src`, braces matched. */
function wgslFnBody(src: string, name: string): string {
  const start = src.indexOf(`fn ${name}(`);
  assert.ok(start >= 0, `fn ${name} not found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let end = open; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}' && --depth === 0) return src.slice(open, end + 1);
  }
  throw new Error(`fn ${name} is unbalanced`);
}

/**
 * Line coverage. The pass used to darken by the mean of its directions' 0/1
 * votes from MSAA sample 0 alone: on a sloped crease the pixel at each stair
 * step had two directions across the edge where its neighbours had one, so
 * the line drew as a row of dark ticks, aliased over antialiased geometry.
 * WGSL does not run under `tsx --test`, so these read the generated source.
 */
describe('edge pass line coverage', () => {
  const ms = edgeShaderSource(true);
  const ss = edgeShaderSource(false);

  it('darkens a covered pixel by half the intensity at low and three quarters at high (the old 1.5 ratio)', () => {
    assert.equal(EDGE_LINE_WEIGHT.low, 0.5);
    assert.equal(EDGE_LINE_WEIGHT.high, 0.75);
    for (const src of [ms, ss]) {
      assert.match(src, new RegExp(`EDGE_LINE_WEIGHT_LOW: f32 = ${EDGE_LINE_WEIGHT.low.toFixed(6)}`));
      assert.match(src, new RegExp(`EDGE_LINE_WEIGHT_HIGH: f32 = ${EDGE_LINE_WEIGHT.high.toFixed(6)}`));
    }
  });

  it('puts a sample on a line when ANY tap crosses an edge, not by the mean of the directions', () => {
    for (const src of [ms, ss]) {
      const sample = wgslFnBody(src, 'sampleOnEdge');
      assert.match(sample, /for \(var i = 0; i < count; [^)]*\) \{\s*if \(tapCrosses\([^;]*\)\) \{\s*return 1\.0;/);
      assert.doesNotMatch(src, /votes \/ directions/);
      const fs = wgslFnBody(src, 'fs_edges');
      assert.match(fs, /onEdge = onEdge \+ sampleOnEdge\(p, s, dims, r, count, d, centre\)/);
      assert.match(fs, /let coverage = onEdge \/ f32\(EDGE_SAMPLES\);/);
      assert.match(fs, /coverage \* weight \* params\.edge\.y/);
    }
  });

  it('tests every MSAA sample against the same sample of its neighbours on a multisampled target', () => {
    assert.equal(EDGE_SAMPLE_COUNT, 4);
    assert.match(ms, new RegExp(`const EDGE_SAMPLES: i32 = ${EDGE_SAMPLE_COUNT};`));
    assert.match(wgslFnBody(ms, 'fs_edges'), /for \(var s = 0; s < EDGE_SAMPLES; s = s \+ 1\)/);
    // Every depth/id read of the line test takes the sample index; none uses
    // the sample-0-only `loadDepth`.
    for (const name of ['axisStep', 'tapCrosses', 'fs_edges']) {
      const body = wgslFnBody(ms, name);
      assert.doesNotMatch(body, /loadDepth\(/, `${name} reads sample 0 only`);
      assert.match(body, /loadDepthSample\([^)]*, s\)/, `${name} reads sample s`);
    }
    assert.match(wgslFnBody(ms, 'loadId'), /textureLoad\(idTex, c, s\)/);
  });

  it('outlines geometry against the background: a background tap is a crossing', () => {
    for (const src of [ms, ss]) {
      assert.match(wgslFnBody(src, 'tapCrosses'), /if \(dq <= BACKGROUND_DEPTH\) \{\s*return true;/);
      // The background itself draws nothing: its samples are skipped.
      assert.match(wgslFnBody(src, 'fs_edges'), /if \(d <= BACKGROUND_DEPTH\) \{\s*continue;/);
    }
  });

  it('places samples at the standard 4x positions, where a plane\'s depth is extrapolated', () => {
    assert.match(ms, /vec2<f32>\(0\.375, 0\.125\), vec2<f32>\(0\.875, 0\.375\), vec2<f32>\(0\.125, 0\.625\), vec2<f32>\(0\.625, 0\.875\)/);
    assert.match(ss, /const SAMPLE_POS = array<vec2<f32>, 1>\(\s*vec2<f32>\(0\.5, 0\.5\),/);
    // A tap on the centre's plane skips its normal; only one off it fits one.
    const tap = wgslFnBody(ms, 'tapCrosses');
    const onPlane = tap.indexOf('if (onPlane(centre, qc, s, dq)) {');
    const fit = tap.indexOf('planeAt(qc, s, dq)');
    assert.ok(onPlane >= 0, 'tapCrosses tests the centre plane');
    assert.ok(fit >= 0, 'tapCrosses fits a plane for an off-plane tap');
    assert.ok(onPlane < fit, 'the on-plane test comes before the fit');
    assert.match(tap.slice(onPlane, fit), /^if \(onPlane\(centre, qc, s, dq\)\) \{\s*return false;\s*\}/);
  });

  it('reads only sample 0 on a single-sampled target', () => {
    assert.match(ss, /const EDGE_SAMPLES: i32 = 1;/);
    assert.match(ss, /var idTex: texture_2d<f32>;/);
  });
});
