/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mainShaderSource } from './shaders/main.wgsl.js';
import { resolveEnvironment, type LightingEnvironment } from './environment.js';

/**
 * The default light rig gives a building a lit side and a shaded side
 * (#5382), and keeps the shaded side readable.
 *
 * It used to light with `abs(dot(N, L))`: a face turned away from the sun
 * was lit exactly as brightly as one facing it, and a slab's underside came
 * out at 0.91 of its top. The default sun also sat behind the default camera,
 * so both faces seen on open were sunlit.
 *
 * WGSL cannot run under `tsx --test`. The first test pins the one-sided form
 * in the shader source; the rest evaluate `irradiance` below, which mirrors
 * `fs_main`'s light terms, against the resolved default environment.
 */

type V3 = readonly [number, number, number];

const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const luma = (c: V3) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

/** The shader's irradiance calibration, read from its source so this file loads on any tree. */
function irradianceCalibration(): number {
  const declared = /const IRRADIANCE_CALIBRATION: f32 = ([\d.]+);/.exec(mainShaderSource);
  assert.ok(declared, 'expected the shader to declare IRRADIANCE_CALIBRATION');
  return Number(declared[1]);
}

/** Exposed linear irradiance per channel on a face with normal `n`, as fs_main computes it. */
function irradianceRgb(envIn: LightingEnvironment | undefined, n: V3, shadowed = false): V3 {
  const env = resolveEnvironment(envIn);
  const sun = norm(env.sunDirection);
  const fillDir = norm([-sun[0], 0.25, -sun[2]]);
  const rimDir = norm([0, 0.2, -1]);
  const hemi = n[1] * 0.5 + 0.5;
  const wrap = env.sunSoftness;
  const direct = shadowed ? 0 : Math.max((dot(n, sun) + wrap) / (1 + wrap), 0) * env.sunIntensity;
  const fill = Math.max(dot(n, fillDir), 0) * env.fillIntensity;
  const rim = Math.max(dot(n, rimDir), 0) ** 4 * env.rimIntensity;
  const scale = env.exposure * irradianceCalibration();
  const channel = (i: 0 | 1 | 2) => {
    const ambient = (env.groundColor[i] + (env.skyColor[i] - env.groundColor[i]) * hemi) * env.ambientIntensity;
    return (ambient + env.sunColor[i] * direct + fill + rim) * scale;
  };
  return [channel(0), channel(1), channel(2)];
}

/** Exposed linear irradiance (luma) on a face with normal `n`. */
function irradiance(envIn: LightingEnvironment | undefined, n: V3, shadowed = false): number {
  return luma(irradianceRgb(envIn, n, shadowed));
}

const UP: V3 = [0, 1, 0];
const DOWN: V3 = [0, -1, 0];
// The default opening view looks from +X+Z (camera-fit-policy.ts places the
// camera at (0.6, 0.5, 0.6) x distance from the model centre), so these are
// the two walls a user sees first.
const VISIBLE_WALLS: readonly V3[] = [[1, 0, 0], [0, 0, 1]];

describe('default light rig (#5382)', () => {
  it('lights one-sided in the shader', () => {
    assert.match(mainShaderSource, /let NdotL = dot\(N, sunLight\);/);
    assert.match(mainShaderSource, /let NdotFill = max\(dot\(N, fillLight\), 0\.0\);/);
    assert.doesNotMatch(mainShaderSource, /abs\(dot\(N, sunLight\)\)/, 'the sun is two-sided again');
    assert.doesNotMatch(mainShaderSource, /abs\(dot\(N, fillLight\)\)/, 'the fill is two-sided again');
    assert.match(mainShaderSource, /let fillLight = normalize\(vec3<f32>\(-sunLight\.x, 0\.25, -sunLight\.z\)\);/);
  });

  it('calibrates a sun-facing horizontal surface to unit irradiance', () => {
    // The value is only half the contract: fs_main must actually scale the
    // light by it, or a correct constant calibrates nothing.
    assert.match(
      mainShaderSource,
      /let irradiance = lightTerm \* \(env\.exposure \* IRRADIANCE_CALIBRATION\);/,
      'fs_main no longer applies IRRADIANCE_CALIBRATION to the light',
    );
    const key = irradiance(undefined, UP);
    assert.ok(Math.abs(key - 1) < 0.005, `default key irradiance ${key.toFixed(4)} drifted from 1.0; recalibrate IRRADIANCE_CALIBRATION`);
  });

  it('keeps the sunlit key close to neutral, so white stays white', () => {
    // The ambient carries almost half of the key, so its sky colour tints
    // every sunlit surface; a strongly blue sky turned white slabs blue.
    const rgb = irradianceRgb(undefined, UP);
    const spread = (Math.max(...rgb) - Math.min(...rgb)) / luma(rgb);
    assert.ok(spread <= 0.03, `key light channels spread ${(spread * 100).toFixed(1)}% (${rgb.map((c) => c.toFixed(3)).join(', ')})`);
  });

  it('puts one of the two walls seen on open in shade, and the other in sun', () => {
    const [a, b] = VISIBLE_WALLS.map((n) => irradiance(undefined, n));
    const lit = Math.max(a, b);
    const shade = Math.min(a, b);
    assert.ok(lit / shade >= 1.5, `visible walls ${a.toFixed(3)} / ${b.toFixed(3)} are too alike to read as form`);
  });

  it('keeps faces turned away from the sun readable', () => {
    const key = irradiance(undefined, UP);
    const env = resolveEnvironment();
    const away: V3 = norm([-env.sunDirection[0], 0, -env.sunDirection[2]]);
    assert.ok(irradiance(undefined, away) >= 0.35 * key, 'the wall facing away from the sun is too dark');
    assert.ok(irradiance(undefined, UP, true) >= 0.4 * key, 'a cast-shadowed floor is too dark');
    assert.ok(irradiance(undefined, DOWN) >= 0.15 * key, 'undersides (I-beam flanges, soffits) went black');
  });
});
