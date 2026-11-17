/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { skyShaderSource } from './shaders/sky.wgsl.js';

/**
 * Regression: a `smoothstep(low, high, x)` with `low >= high` is a WGSL
 * compile error ("low not less than high"). Tint (Chromium/Edge on real
 * hardware) rejects the whole shader module, so the sky pipeline becomes
 * invalid and encoding the frame fails — the model blanks the moment a
 * non-Default lighting preset enables the sky. Permissive drivers
 * (SwiftShader) accepted the reversed edges, which is why it slipped through.
 *
 * `smoothstep(0.0, -0.1, elevation)` was the offender; it is now written as
 * `1.0 - smoothstep(-0.1, 0.0, elevation)`. This pins the invariant for every
 * numeric-literal `smoothstep` in the shipped sky shader, so a future
 * reversed-edge call cannot silently invalidate the pipeline again.
 */
describe('sky shader smoothstep edges (WGSL low < high)', () => {
  it('has no numeric-literal smoothstep with low >= high', () => {
    // Match smoothstep(<number>, <number>, …) — only the literal-edge calls,
    // which are the ones a human can statically verify (and the ones that
    // trip Tint's constant-folding validation).
    const re = /smoothstep\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,/g;
    const seen: Array<{ low: number; high: number }> = [];
    for (const m of skyShaderSource.matchAll(re)) {
      const low = Number(m[1]);
      const high = Number(m[2]);
      seen.push({ low, high });
      assert.ok(
        low < high,
        `smoothstep(${m[1]}, ${m[2]}, …) has low >= high — WGSL rejects this`,
      );
    }
    // Guard the guard: if the shader stops using literal-edge smoothstep the
    // regex silently passes, so require at least the two known calls.
    assert.ok(seen.length >= 2, 'expected the sky shader to keep its literal-edge smoothstep calls');
  });
});

/**
 * Regression (#5583): the below-horizon `groundColor` fill used to reach
 * full strength by elevation -0.1 (`smoothstep(-0.1, 0.0, elevation)`), so
 * the ordinary downward-pitched BIM camera saw an abrupt flat-colour wall
 * a few degrees below the horizon instead of a gradient. The falloff was
 * widened to span -0.5..0.0 so most downward views land inside the
 * transition rather than past its end.
 */
describe('sky shader ground falloff (#5583)', () => {
  it('spans a wide elevation range, not the old near-instant -0.1', () => {
    const m = skyShaderSource.match(/let groundMix = 1\.0 - smoothstep\((-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?), elevation\);/);
    assert.ok(m, 'expected a literal-edge groundMix smoothstep to match against');
    const low = Number(m![1]);
    const high = Number(m![2]);
    assert.equal(high, 0.0, 'the transition should still end exactly at the horizon');
    assert.ok(low <= -0.4, `expected a gradual falloff (low <= -0.4), got low=${low} (the old, flatter value was -0.1)`);
  });

  it('does not regress to the old -0.1 cutoff', () => {
    assert.ok(
      !skyShaderSource.includes('smoothstep(-0.1, 0.0, elevation)'),
      'the ground falloff should no longer use the narrow -0.1..0.0 range',
    );
  });
});

/**
 * #8688: the lens shift rides in two former `_pad` slots, so the CPU writer
 * and the WGSL struct must agree on where they are, and the per-pixel ray
 * must remove the shift the projection matrix applied to the geometry.
 */
describe('sky lens shift uniforms (#8688)', () => {
  /** Float index of each `SkyUniforms` field (vec3 starts a 16-byte row; f32 packs after it). */
  function uniformFloatIndex(): Map<string, number> {
    const body = skyShaderSource.match(/struct SkyUniforms \{([^}]*)\}/)![1];
    const index = new Map<string, number>();
    let offset = 0;
    for (const [, name, type] of body.matchAll(/(\w+): (vec3<f32>|f32),/g)) {
      if (type === 'vec3<f32>') offset = Math.ceil(offset / 4) * 4;
      index.set(name, offset);
      offset += type === 'vec3<f32>' ? 3 : 1;
    }
    return index;
  }

  it('writes the shift into the slots the shader reads', async () => {
    (globalThis as Record<string, unknown>).GPUBufferUsage ??= { COPY_DST: 8, UNIFORM: 64 };
    (globalThis as Record<string, unknown>).GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
    const { SkyPass } = await import('./sky-pass.js');
    let written: Float32Array | null = null;
    const device = {
      createBuffer: () => ({ destroy() {} }),
      createBindGroupLayout: () => ({}), createBindGroup: () => ({}), createPipelineLayout: () => ({}),
      createShaderModule: () => ({}), createRenderPipeline: () => ({}),
      queue: { writeBuffer: (_b: unknown, _o: number, data: Float32Array) => { written = new Float32Array(data); } },
    } as unknown as GPUDevice;
    const sky = new SkyPass(device, { colorFormat: 'rgba8unorm', objectIdFormat: 'rgba8unorm', depthFormat: 'depth32float', sampleCount: 1 }, skyShaderSource);
    const pass = { setPipeline() {}, setBindGroup() {}, draw() {} } as unknown as GPURenderPassEncoder;
    const env = { exposure: 1, sunDirection: [0, 1, 0], sunIntensity: 1, sky: { zenith: [0, 0, 1], horizon: [1, 1, 1], ground: [0.5, 0.5, 0.5] } };
    sky.draw(pass, { forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], fovY: 1, aspect: 1, lensShift: { x: 0.25, y: -0.5 } },
      env as unknown as Parameters<typeof sky.draw>[2]);
    const index = uniformFloatIndex();
    assert.equal(written![index.get('lensShiftX')!], 0.25);
    assert.equal(written![index.get('lensShiftY')!], -0.5);
    assert.ok(skyShaderSource.includes('(input.ndc.x - sky.lensShiftX)'));
    assert.ok(skyShaderSource.includes('(input.ndc.y - sky.lensShiftY)'));
  });
});
