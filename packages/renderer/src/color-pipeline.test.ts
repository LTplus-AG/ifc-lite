/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IRRADIANCE_CALIBRATION, mainShaderSource } from './shaders/main.wgsl.js';
import { skyShaderSource } from './shaders/sky.wgsl.js';
import { texturedShaderSource } from './shaders/textured.wgsl.js';
import { colorTransferWgsl } from './shaders/color-transfer.wgsl.js';
import { resolveEnvironment } from './environment.js';

/**
 * The colour pipeline lights authored sRGB colours in linear and grades
 * nothing in display space.
 *
 * Before this contract the fragment stage multiplied sRGB values by light as
 * if they were linear, then darkened near-greys, stretched contrast about 0.5,
 * boosted saturation 1.4x, ran ACES and a 2.2 power. Measured on real models:
 * an authored grass green rgb(53,142,41) rendered neon rgb(0,175,39), a brown
 * brick rgb(114,51,14) rendered crimson, every grey at or below 40/255 rendered
 * pure black on every face, and pure white never exceeded 202/255.
 *
 * WGSL cannot run under `tsx --test`, so these assert the shader source at the
 * only level that can see the stages, in the idiom of
 * `sun-softness-wiring.test.ts`: each negative assertion is paired with a
 * positive one so a rename cannot make it pass vacuously.
 */
describe('linear colour pipeline', () => {
  it('decodes the authored colour to linear before it is multiplied by light', () => {
    const read = mainShaderSource.indexOf('var baseColor = input.color.rgb;');
    const decode = mainShaderSource.indexOf('baseColor = srgbToLinear(baseColor);');
    const lit = mainShaderSource.indexOf('var color = baseColor * irradiance;');
    assert.ok(read >= 0 && decode >= 0 && lit >= 0, 'expected read, decode and light stages in fs_main');
    assert.ok(read < decode && decode < lit, 'the albedo must be decoded after it is read and before it is lit');
  });

  it('decodes the selection albedo too, so the highlight is not a gamma-lifted blue', () => {
    assert.match(mainShaderSource, /color = srgbToLinear\(vec3<f32>\(0\.3, 0\.6, 1\.0\)\) \* shade;/);
  });

  it('keeps no display-space grading in the geometry or sky shaders', () => {
    for (const [name, src] of [['main', mainShaderSource], ['sky', skyShaderSource]] as const) {
      assert.ok(src.includes('neutralCompress('), `${name}: expected the shared highlight roll-off`);
      assert.ok(src.includes('linearToSrgb('), `${name}: expected the exact sRGB encode`);
      assert.doesNotMatch(src, /satBoost|isWhiteish/, `${name}: saturation boost / near-grey darkening is back`);
      assert.doesNotMatch(src, /\(color - 0\.5\) \* /, `${name}: contrast stretch about 0.5 is back`);
      assert.doesNotMatch(src, /1\.0 \/ 2\.2/, `${name}: a 2.2 power encode is back`);
      assert.doesNotMatch(src, /\b2\.51\b|acesTonemap/, `${name}: ACES is back`);
    }
  });

  it('shares one transfer implementation between geometry, textured geometry and sky', () => {
    for (const [name, src] of [
      ['main', mainShaderSource],
      ['textured', texturedShaderSource],
      ['sky', skyShaderSource],
    ] as const) {
      assert.ok(src.includes(colorTransferWgsl), `${name}: must embed colorTransferWgsl verbatim, not a copy`);
      assert.equal(src.split('fn srgbToLinear(').length - 1, 1, `${name}: exactly one srgbToLinear definition`);
    }
  });

  it('calibrates the default rig so a sun-facing horizontal surface is at unit irradiance', () => {
    // main.wgsl's light terms evaluated for N = +Y with the default environment.
    const env = resolveEnvironment();
    const norm = (v: readonly number[]) => {
      const l = Math.hypot(v[0], v[1], v[2]);
      return [v[0] / l, v[1] / l, v[2] / l];
    };
    const n = [0, 1, 0];
    const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const sun = Math.max((Math.abs(dot(n, env.sunDirection)) + env.sunSoftness) / (1 + env.sunSoftness), 0) * env.sunIntensity;
    const fill = Math.abs(dot(n, norm([-0.5, 0.3, -0.3]))) * env.fillIntensity;
    const rim = Math.max(dot(n, norm([0, 0.2, -1])), 0) ** 4 * env.rimIntensity;
    const light = env.skyColor.map((c, i) => c * env.ambientIntensity + env.sunColor[i] * sun + fill + rim);
    const luma = 0.299 * light[0] + 0.587 * light[1] + 0.114 * light[2];
    const irradiance = luma * env.exposure * IRRADIANCE_CALIBRATION;
    assert.ok(Math.abs(irradiance - 1) < 0.005, `default key irradiance ${irradiance.toFixed(4)} drifted from 1.0; recalibrate IRRADIANCE_CALIBRATION`);
  });
});
