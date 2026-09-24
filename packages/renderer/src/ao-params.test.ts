/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AO_MAX_SAMPLES,
  AO_QUALITY_PRESETS,
  AO_UNIFORM_BYTES,
  AO_UNIFORM_LAYOUT,
  aoTargetSize,
  packAoUniforms,
  spiralKernel,
} from './ao-params.js';
import {
  clipWFromViewZ,
  depthReconstructParams,
  pixelsPerWorldUnit,
  viewPositionFromDepth,
  viewZFromDepth,
} from './depth-reconstruct.js';
import { MathUtils } from './math.js';
import { aoShaderSource } from './shaders/ao.wgsl.js';
import type { Mat4 } from './types.js';

/**
 * The CPU half of the screen-space ambient occlusion pass (#5384).
 *
 * The old "contact shading" compared raw reverse-Z depth values 1-3 px apart
 * and scaled the difference by 120, so at BIM viewing distances it measured
 * nothing. The pass that replaced it works in view space: it reconstructs
 * positions from depth with the camera projection and projects a WORLD
 * radius to pixels. Those two conversions are pure functions here, mirrored
 * by `shaders/depth-reconstruct.wgsl.ts`, and are checked against the real
 * projection matrices the camera builds.
 */

/** Project a view-space point: device depth and NDC, as the rasteriser does. */
function project(proj: Mat4, v: [number, number, number]): { ndcX: number; ndcY: number; depth: number } {
  const m = proj.m;
  const cx = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
  const cy = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
  const cz = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
  const cw = m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15];
  return { ndcX: cx / cw, ndcY: cy / cw, depth: cz / cw };
}

const PERSPECTIVE = MathUtils.perspectiveReverseZ(Math.PI / 4, 1.6, 0.03, 300);
const ORTHO = MathUtils.orthographicReverseZ(-16, 16, -10, 10, 2, 90);

const POINTS: [number, number, number][] = [
  [0, 0, -5],
  [1.5, -0.8, -12.25],
  [-3, 2, -40],
  [0.2, 0.1, -80],
];

describe('depth reconstruction (#5384)', () => {
  for (const [name, proj] of [['perspective', PERSPECTIVE], ['orthographic', ORTHO]] as const) {
    it(`recovers the view-space position from reverse-Z depth (${name})`, () => {
      const params = depthReconstructParams(proj);
      for (const v of POINTS) {
        const { ndcX, ndcY, depth } = project(proj, v);
        assert.ok(depth > 0 && depth <= 1, `reverse-Z depth in (0, 1], got ${depth}`);
        const back = viewPositionFromDepth(ndcX, ndcY, depth, params);
        for (let i = 0; i < 3; i++) {
          assert.ok(Math.abs(back[i] - v[i]) < 1e-3 * Math.max(1, Math.abs(v[i])), `${name} ${v} axis ${i}: ${back[i]}`);
        }
      }
    });
  }

  it('reads nearer geometry from larger depth, as reverse-Z stores it', () => {
    const params = depthReconstructParams(PERSPECTIVE);
    const near = project(PERSPECTIVE, [0, 0, -5]).depth;
    const far = project(PERSPECTIVE, [0, 0, -50]).depth;
    assert.ok(near > far);
    assert.ok(-viewZFromDepth(near, params) < -viewZFromDepth(far, params));
  });

  it('projects a world radius to the pixels it actually spans', () => {
    const heightPx = 800;
    for (const proj of [PERSPECTIVE, ORTHO]) {
      const params = depthReconstructParams(proj);
      const scale = pixelsPerWorldUnit(proj, heightPx);
      for (const z of [-4, -25]) {
        const a = project(proj, [0, 0, z]);
        const b = project(proj, [0, 1, z]); // 1 world unit up
        const spannedPx = (b.ndcY - a.ndcY) * 0.5 * heightPx;
        const predicted = scale / clipWFromViewZ(z, params);
        assert.ok(Math.abs(spannedPx - predicted) < 1e-3, `z ${z}: spans ${spannedPx}, predicted ${predicted}`);
      }
    }
    // A perspective radius shrinks with distance; an orthographic one does not.
    const p = depthReconstructParams(PERSPECTIVE);
    assert.ok(clipWFromViewZ(-40, p) > clipWFromViewZ(-4, p));
    const o = depthReconstructParams(ORTHO);
    assert.equal(clipWFromViewZ(-40, o), clipWFromViewZ(-4, o));
  });
});

describe('ambient occlusion sampling kernel (#5384)', () => {
  it('fits every preset in the uniform', () => {
    for (const preset of Object.values(AO_QUALITY_PRESETS)) {
      assert.ok(preset.samples >= 8 && preset.samples <= AO_MAX_SAMPLES);
    }
  });

  it('spirals outwards inside the unit disk and pads unused slots with zero', () => {
    const { samples, spiralTurns } = AO_QUALITY_PRESETS.low;
    const k = spiralKernel(samples, spiralTurns);
    assert.equal(k.length, AO_MAX_SAMPLES * 2);
    let prev = 0;
    for (let i = 0; i < samples; i++) {
      const r = Math.hypot(k[i * 2], k[i * 2 + 1]);
      assert.ok(r > prev && r < 1, `tap ${i} radius ${r} after ${prev}`);
      prev = r;
    }
    for (let i = samples * 2; i < k.length; i++) assert.equal(k[i], 0);
  });

  it('surrounds the pixel: no direction is left unsampled', () => {
    for (const { samples, spiralTurns } of Object.values(AO_QUALITY_PRESETS)) {
      const k = spiralKernel(samples, spiralTurns);
      const angles = [];
      for (let i = 0; i < samples; i++) angles.push(Math.atan2(k[i * 2 + 1], k[i * 2]));
      angles.sort((a, b) => a - b);
      let maxGap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
      for (let i = 1; i < angles.length; i++) maxGap = Math.max(maxGap, angles[i] - angles[i - 1]);
      // A one-sided kernel would read a flat floor next to a wall as open.
      assert.ok(maxGap < Math.PI / 2, `largest angular gap ${maxGap} rad for ${samples} taps`);
    }
  });

  it('rejects a sample count the uniform cannot hold', () => {
    assert.throws(() => spiralKernel(AO_MAX_SAMPLES + 1, 7), RangeError);
    assert.throws(() => spiralKernel(0, 7), RangeError);
  });
});

describe('ambient occlusion targets and uniforms (#5384)', () => {
  it('runs at half resolution on low and full resolution on high', () => {
    assert.deepEqual(aoTargetSize(1280, 721, 'low'), { width: 640, height: 361 });
    assert.deepEqual(aoTargetSize(1280, 721, 'high'), { width: 1280, height: 721 });
    assert.deepEqual(aoTargetSize(1, 1, 'low'), { width: 1, height: 1 });
  });

  it('declares the WGSL struct fields in the order the TS layout packs them', () => {
    const struct = /struct AoParams \{([\s\S]*?)\}/.exec(aoShaderSource(false));
    assert.ok(struct, 'expected `struct AoParams` in the AO shader');
    const fields = [...struct[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    const byOffset = Object.entries(AO_UNIFORM_LAYOUT).sort((a, b) => a[1] - b[1]).map(([k]) => k);
    assert.deepEqual(fields, byOffset);
    // Five vec4s of parameters, then the kernel as vec4 pairs.
    assert.equal(AO_UNIFORM_LAYOUT.kernel, 20);
    assert.match(struct[1], new RegExp(`kernel: array<vec4<f32>, ${AO_MAX_SAMPLES / 2}>`));
    assert.equal(AO_UNIFORM_BYTES, (20 + AO_MAX_SAMPLES * 2) * 4);
  });

  it('packs the world radius, its pixel scale and the preset for the frame', () => {
    const out = new Float32Array(AO_UNIFORM_BYTES / 4);
    packAoUniforms(out, { projection: PERSPECTIVE, width: 1000, height: 800, quality: 'low', radius: 0.75, intensity: 0.6 });
    const L = AO_UNIFORM_LAYOUT;
    assert.deepEqual([...out.subarray(L.depthParams, L.depthParams + 4)], [...depthReconstructParams(PERSPECTIVE).depth].map(Math.fround));
    assert.equal(out[L.viewport], 1000);
    assert.equal(out[L.viewport + 1], 800);
    assert.equal(out[L.ao], Math.fround(0.75));
    assert.equal(out[L.ao + 1], Math.fround(pixelsPerWorldUnit(PERSPECTIVE, 800)));
    assert.ok(out[L.ao + 2] > 0 && out[L.ao + 2] < 800, 'the projected radius is capped below the screen height');
    assert.equal(out[L.ao + 3], Math.fround(0.6));
    assert.equal(out[L.misc], AO_QUALITY_PRESETS.low.resolutionDivisor);
    assert.equal(out[L.misc + 1], AO_QUALITY_PRESETS.low.samples);
    const kernel = spiralKernel(AO_QUALITY_PRESETS.low.samples, AO_QUALITY_PRESETS.low.spiralTurns);
    assert.deepEqual([...out.subarray(L.kernel)], [...kernel]);
  });
});
